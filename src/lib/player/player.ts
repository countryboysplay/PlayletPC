/**
 * player.ts - framework-agnostic playback controller for an Invidious client.
 *
 * Engine: shaka-player over MSE for DASH + HLS, with a plain <video src="...">
 * progressive path as the last-resort fallback (muxed formatStreams, 720p max,
 * frequently 360p only, no ABR).
 *
 * No DOM framework imports. The only DOM dependency is the HTMLVideoElement you
 * hand in. Everything else is events.
 */

import { TypedEmitter, type Unsubscribe } from './emitter';
import {
  PlaybackError,
  fromMediaError,
  isPlaybackError,
  toPlaybackError,
  type PlaybackErrorCode,
} from './errors';
import {
  backoffDelay,
  fetchCaptionAsBlobUrl,
  fetchCaptionList,
  normalizeInstance,
  proxifyMediaUrl,
  sleep,
} from './invidious';
import { buildSourceCandidates, isLive as videoIsLive, parseHeight } from './sources';
import {
  RequestType,
  loadShaka,
  type ShakaEventLike,
  type ShakaNamespace,
  type ShakaPlayerInstance,
  type ShakaRequest,
  type ShakaTrack,
} from './shaka';
import type {
  InvidiousCaption,
  InvidiousVideo,
  LoadOptions,
  PlayerState,
  QualityOption,
  QualitySelection,
  ResolvedLoadOptions,
  SourceCandidate,
  TextTrackOption,
} from './types';

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export interface TimeUpdatePayload {
  currentTime: number;
  duration: number;
  /** end of the contiguous buffered range ahead of the playhead, in seconds */
  bufferedAhead: number;
  /** true when this tick follows a seek rather than natural progression */
  seeked: boolean;
}

export interface PlayerEventMap {
  loadstart: { source: SourceCandidate; attempt: number };
  loaded: { source: SourceCandidate; live: boolean; duration: number; qualities: QualityOption[] };
  /** a candidate failed and we are falling through to the next one */
  sourcefallback: { failed: SourceCandidate; error: PlaybackError; next: SourceCandidate | null };
  timeupdate: TimeUpdatePayload;
  seeking: { currentTime: number };
  seeked: { currentTime: number };
  play: void;
  pause: void;
  ended: void;
  buffering: { buffering: boolean };
  qualitychange: { quality: QualityOption | null; auto: boolean };
  qualitiesupdated: { qualities: QualityOption[] };
  volumechange: { volume: number; muted: boolean };
  texttrackschanged: { tracks: TextTrackOption[] };
  ratechange: { rate: number };
  /** non-fatal: playback continues (a retry succeeded, captions failed, ...) */
  warning: { error: PlaybackError };
  /** fatal for the current load; the app should surface it / rotate instance */
  error: { error: PlaybackError };
  destroyed: void;
}

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

const DEFAULTS: Omit<ResolvedLoadOptions, 'instance'> = {
  proxyMode: 'auto',
  startTime: 0,
  autoplay: true,
  quality: 'auto',
  // No ceiling: let ABR use whatever the video offers, including 1440p/2160p.
  //
  // A 1080p cap was tried while chasing a stall that turned out to be a Svelte
  // reactivity bug destroying the player (see VideoPlayer.svelte). Decode was
  // never the problem - measured 2317 frames with 0 dropped at 1080p - so
  // capping quality would have been hiding a bug we had already fixed.
  maxHeight: null,
  preferredCodec: 'auto',
  captionLanguage: null,
  forceSource: null,
  manifestUri: null,
  retries: 2,
  retryBackoffMs: 500,
  loadTimeoutMs: 30000,
};

const STALL_TIMEOUT_MS = 12000;
const TICK_MS = 100;

function codecPreferenceList(pref: string): string[] {
  switch (pref) {
    case 'av1':
      return ['av01', 'vp9', 'avc1'];
    case 'vp9':
      return ['vp9', 'avc1', 'av01'];
    case 'h264':
      return ['avc1', 'vp9', 'av01'];
    default:
      // WebView2/Chromium hardware-decodes VP9 on nearly all Win11 GPUs; AV1
      // hardware decode is Intel Xe / RTX 30 / RDNA2 and newer only, and the
      // dav1d software path will melt a laptop at 1440p+. VP9 first is the
      // QoE-correct default, not the bitrate-correct one.
      return ['vp9', 'avc1', 'av01'];
  }
}

/* ------------------------------------------------------------------ */
/* Player                                                              */
/* ------------------------------------------------------------------ */

export class PlayletPlayer {
  private readonly el: HTMLVideoElement;
  private readonly emitter = new TypedEmitter<PlayerEventMap>();
  private readonly defaults: Partial<LoadOptions>;

  private shaka: ShakaNamespace | null = null;
  private shakaPlayer: ShakaPlayerInstance | null = null;
  private shakaAttached = false;

  private loadToken = 0;
  private abort: AbortController | null = null;

  private currentVideo: InvidiousVideo | null = null;
  private currentOpts: ResolvedLoadOptions | null = null;
  private currentSource: SourceCandidate | null = null;
  private qualities: QualityOption[] = [];
  private abrEnabled = true;
  private pinnedHeight: number | null = null;

  private textTracks: TextTrackOption[] = [];
  private blobUrls: string[] = [];
  private nativeTrackEls: HTMLTrackElement[] = [];

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickTime = -1;
  private lastProgressAt = 0;
  private stallReported = false;
  private buffering = false;
  private sawSeek = false;
  private destroyed = false;
  private recovering = false;
  private detachFns: Unsubscribe[] = [];

  constructor(videoElement: HTMLVideoElement, defaults: Partial<LoadOptions> = {}) {
    this.el = videoElement;
    this.defaults = defaults;
    this.emitter.setErrorHandler((e, event) => {
      // A throwing subscriber must never break playback.
      console.error('[player] listener threw for event', String(event), e);
    });
    this.bindMediaElement();
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  on<K extends keyof PlayerEventMap>(event: K, fn: (payload: PlayerEventMap[K]) => void): Unsubscribe {
    return this.emitter.on(event, fn);
  }

  once<K extends keyof PlayerEventMap>(event: K, fn: (payload: PlayerEventMap[K]) => void): Unsubscribe {
    return this.emitter.once(event, fn);
  }

  off<K extends keyof PlayerEventMap>(event: K, fn: (payload: PlayerEventMap[K]) => void): void {
    this.emitter.off(event, fn);
  }

  get element(): HTMLVideoElement {
    return this.el;
  }

  getState(): PlayerState {
    return {
      loaded: this.currentSource != null,
      live: this.isLive(),
      playing: !this.el.paused && !this.el.ended,
      buffering: this.buffering,
      currentTime: this.el.currentTime || 0,
      duration: Number.isFinite(this.el.duration) ? this.el.duration : (this.currentVideo?.lengthSeconds ?? 0),
      volume: this.el.volume,
      muted: this.el.muted,
      source: this.currentSource,
    };
  }

  isLive(): boolean {
    if (this.shakaPlayer && this.currentSource && this.currentSource.kind !== 'progressive') {
      try {
        return this.shakaPlayer.isLive();
      } catch {
        /* fall through */
      }
    }
    return this.currentVideo ? videoIsLive(this.currentVideo) : false;
  }

  /**
   * Load a video. Walks the candidate list until one plays.
   * Throws a PlaybackError if every candidate fails; check `.instanceFailure`
   * to decide whether to retry the whole load against another instance.
   */
  async load(video: InvidiousVideo, opts: LoadOptions): Promise<void> {
    this.assertAlive();
    const resolved: ResolvedLoadOptions = {
      ...DEFAULTS,
      ...this.defaults,
      ...opts,
      instance: normalizeInstance(opts.instance ?? this.defaults.instance ?? ''),
    } as ResolvedLoadOptions;

    if (!resolved.instance) {
      throw new PlaybackError({ code: 'NO_PLAYABLE_SOURCE', message: 'No Invidious instance configured.', instanceFailure: false, retryable: false });
    }

    const token = ++this.loadToken;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;

    this.currentVideo = video;
    this.currentOpts = resolved;
    this.currentSource = null;
    this.qualities = [];
    this.pinnedHeight = typeof resolved.quality === 'number' ? resolved.quality : null;
    this.abrEnabled = resolved.quality === 'auto';
    this.clearTextTracks();

    // Ensure the engine is available before we decide what is even loadable.
    if (!this.shaka) this.shaka = await loadShaka();
    if (token !== this.loadToken) return;

    const candidates = buildSourceCandidates(video, {
      instance: resolved.instance,
      proxyMode: resolved.proxyMode,
      forceSource: resolved.forceSource,
      maxHeight: resolved.maxHeight,
      mseAvailable: this.shaka != null,
      manifestUri: resolved.manifestUri,
    });

    if (candidates.length === 0) {
      throw new PlaybackError({
        code: 'NO_PLAYABLE_SOURCE',
        instanceFailure: true,
        retryable: false,
        message: 'The instance returned no usable streams for this video (no adaptiveFormats, no formatStreams, no HLS).',
      });
    }

    let lastError: PlaybackError | null = null;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const attempts = candidate.kind === 'progressive' ? 1 : resolved.retries + 1;

      for (let attempt = 0; attempt < attempts; attempt++) {
        if (token !== this.loadToken || abort.signal.aborted) return;
        try {
          this.emitter.emit('loadstart', { source: candidate, attempt });
          await this.loadCandidate(candidate, resolved, token, abort.signal);
          if (token !== this.loadToken) return;

          this.currentSource = candidate;
          this.refreshQualities();
          this.startTicker();
          this.emitter.emit('loaded', {
            source: candidate,
            live: this.isLive(),
            duration: this.getState().duration,
            qualities: this.qualities,
          });

          // Captions are best-effort: never fail a load because of them.
          void this.loadCaptions(video, resolved, token).catch((e: unknown) => {
            this.emitter.emit('warning', { error: toPlaybackError(e) });
          });

          if (resolved.autoplay) {
            try {
              await this.el.play();
            } catch (e) {
              // Autoplay policy or a user gesture requirement - not fatal.
              this.emitter.emit('warning', {
                error: new PlaybackError({ code: 'ABORTED', instanceFailure: false, retryable: false, message: 'Autoplay was blocked; waiting for a user gesture.', cause: e }),
              });
            }
          }
          return;
        } catch (e) {
          if (token !== this.loadToken) return;
          const err = toPlaybackError(e, { sourceKind: candidate.kind, uri: candidate.uri });
          lastError = err;
          if (err.code === 'ABORTED') return;

          const canRetrySame = err.retryable && attempt < attempts - 1 && !isHardSourceFailure(err.code);
          if (canRetrySame) {
            this.emitter.emit('warning', { error: err });
            await sleep(backoffDelay(attempt, resolved.retryBackoffMs), abort.signal).catch(() => undefined);
            continue;
          }
          const next = i + 1 < candidates.length ? candidates[i + 1] : null;
          this.emitter.emit('sourcefallback', { failed: candidate, error: err, next });
          break;
        }
      }
    }

    const finalError =
      lastError ??
      new PlaybackError({ code: 'NO_PLAYABLE_SOURCE', message: 'No source could be played.', instanceFailure: true });
    this.emitter.emit('error', { error: finalError });
    throw finalError;
  }

  async play(): Promise<void> {
    this.assertAlive();
    try {
      await this.el.play();
    } catch (e) {
      throw toPlaybackError(e);
    }
  }

  pause(): void {
    if (this.destroyed) return;
    this.el.pause();
  }

  /** Seek to an absolute position in seconds (clamped to the seekable range). */
  seek(seconds: number): void {
    this.assertAlive();
    const range = this.getSeekableRange();
    const target = Math.min(Math.max(seconds, range.start), Math.max(range.start, range.end - 0.25));
    this.sawSeek = true;
    this.el.currentTime = target;
  }

  getSeekableRange(): { start: number; end: number } {
    if (this.shakaPlayer && this.currentSource && this.currentSource.kind !== 'progressive') {
      try {
        const r = this.shakaPlayer.seekRange();
        if (Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start) return r;
      } catch {
        /* fall through */
      }
    }
    const seekable = this.el.seekable;
    if (seekable && seekable.length > 0) {
      return { start: seekable.start(0), end: seekable.end(seekable.length - 1) };
    }
    const duration = Number.isFinite(this.el.duration) ? this.el.duration : (this.currentVideo?.lengthSeconds ?? 0);
    return { start: 0, end: duration };
  }

  setVolume(volume: number): void {
    this.assertAlive();
    this.el.volume = Math.min(1, Math.max(0, volume));
  }

  getVolume(): number {
    return this.el.volume;
  }

  setMuted(muted: boolean): void {
    this.assertAlive();
    this.el.muted = muted;
  }

  isMuted(): boolean {
    return this.el.muted;
  }

  setPlaybackRate(rate: number): void {
    this.assertAlive();
    this.el.playbackRate = Math.min(4, Math.max(0.25, rate));
  }

  getPlaybackRate(): number {
    return this.el.playbackRate;
  }

  getQualities(): QualityOption[] {
    return this.qualities.slice();
  }

  getActiveQuality(): QualityOption | null {
    return this.qualities.find((q) => q.active && !q.auto) ?? null;
  }

  isAbrEnabled(): boolean {
    return this.abrEnabled;
  }

  /**
   * 'auto' engages ABR. A number pins the nearest available height <= the
   * requested one (so asking for 2160 on a 1080p video pins 1080, and asking
   * for 1080 on a link that can only do 480 pins 480 rather than failing).
   * A quality id selects that exact rendition.
   */
  async setQuality(selection: QualitySelection): Promise<void> {
    this.assertAlive();
    if (!this.currentSource) return;

    if (this.currentSource.kind === 'progressive') {
      await this.setProgressiveQuality(selection);
      return;
    }

    const sp = this.shakaPlayer;
    if (!sp) return;

    if (selection === 'auto') {
      this.abrEnabled = true;
      this.pinnedHeight = null;
      sp.configure({ abr: { enabled: true } });
      this.refreshQualities();
      this.emitter.emit('qualitychange', { quality: this.getActiveQuality(), auto: true });
      return;
    }

    const variants = sp.getVariantTracks();
    if (variants.length === 0) return;

    let target: ShakaTrack | null = null;
    if (typeof selection === 'number') {
      target = pickVariantForHeight(variants, selection, this.currentOpts?.preferredCodec ?? 'auto');
      this.pinnedHeight = target?.height ?? selection;
    } else {
      target = variants.find((v) => String(v.id) === selection) ?? null;
      this.pinnedHeight = target?.height ?? null;
    }
    if (!target) return;

    this.abrEnabled = false;
    sp.configure({ abr: { enabled: false } });
    // clearBuffer=true so the switch is visible now rather than in ~20s;
    // safeMargin keeps ~2s of already-decoded video to avoid a visible stall.
    sp.selectVariantTrack(target, true, 2);
    this.refreshQualities();
    this.emitter.emit('qualitychange', { quality: this.getActiveQuality(), auto: false });
  }

  /** Cap ABR (e.g. metered connection). null removes the cap. */
  setMaxHeight(maxHeight: number | null): void {
    if (this.currentOpts) this.currentOpts.maxHeight = maxHeight;
    this.shakaPlayer?.configure({
      abr: { restrictions: { maxHeight: maxHeight ?? Infinity } },
    });
  }

  getTextTracks(): TextTrackOption[] {
    return this.textTracks.slice();
  }

  /** Pass null to turn captions off. */
  async setTextTrack(id: string | null): Promise<void> {
    this.assertAlive();
    if (this.currentSource && this.currentSource.kind !== 'progressive' && this.shakaPlayer) {
      const sp = this.shakaPlayer;
      if (id == null) {
        await sp.setTextTrackVisibility(false);
      } else {
        const track = sp.getTextTracks().find((t) => String(t.id) === id || t.language === id);
        if (track) {
          sp.selectTextTrack(track);
          await sp.setTextTrackVisibility(true);
        }
      }
    } else {
      const list = this.el.textTracks;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        t.mode = id != null && (t.language === id || t.label === id || String(i) === id) ? 'showing' : 'disabled';
      }
    }
    this.textTracks = this.textTracks.map((t) => ({ ...t, active: id != null && t.id === id }));
    this.emitter.emit('texttrackschanged', { tracks: this.textTracks });
  }

  /**
   * Reload the current video at the current position, optionally forcing the
   * instance proxy. This is the mid-playback 403 recovery path: googlevideo
   * URLs expire (~6h) and are IP-bound, so a stream that started fine can die
   * an hour in.
   */
  async recover(opts: { forceProxy?: boolean } = {}): Promise<void> {
    if (!this.currentVideo || !this.currentOpts || this.recovering) return;
    this.recovering = true;
    const at = this.el.currentTime;
    const wasPlaying = !this.el.paused;
    try {
      await this.load(this.currentVideo, {
        ...this.currentOpts,
        proxyMode: opts.forceProxy ? 'always' : this.currentOpts.proxyMode,
        startTime: at,
        autoplay: wasPlaying,
        quality: this.abrEnabled ? 'auto' : (this.pinnedHeight ?? 'auto'),
      });
    } finally {
      this.recovering = false;
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadToken++;
    this.abort?.abort();
    this.stopTicker();
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
    this.clearTextTracks();
    try {
      if (this.shakaPlayer) await this.shakaPlayer.destroy();
    } catch {
      /* ignore */
    }
    this.shakaPlayer = null;
    this.shakaAttached = false;
    try {
      this.el.removeAttribute('src');
      this.el.load();
    } catch {
      /* ignore */
    }
    this.emitter.emit('destroyed', undefined);
    this.emitter.removeAll();
  }

  /* ---------------------------------------------------------------- */
  /* Loading internals                                                 */
  /* ---------------------------------------------------------------- */

  private async loadCandidate(
    candidate: SourceCandidate,
    opts: ResolvedLoadOptions,
    token: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (candidate.kind === 'progressive') {
      await this.loadProgressive(candidate, opts, token, signal);
      return;
    }
    await this.loadWithShaka(candidate, opts, token, signal);
  }

  private async ensureShakaPlayer(): Promise<ShakaPlayerInstance> {
    if (!this.shaka) {
      this.shaka = await loadShaka();
    }
    if (!this.shaka) {
      throw new PlaybackError({
        code: 'CODEC_UNSUPPORTED',
        instanceFailure: false,
        retryable: false,
        message: 'MSE playback engine unavailable in this WebView; only muxed progressive playback is possible.',
      });
    }
    if (!this.shakaPlayer) {
      const sp = new this.shaka.Player();
      this.shakaPlayer = sp;
      sp.addEventListener('error', this.onShakaError);
      sp.addEventListener('buffering', this.onShakaBuffering);
      sp.addEventListener('adaptation', this.onShakaTracksChanged);
      sp.addEventListener('variantchanged', this.onShakaTracksChanged);
      sp.addEventListener('trackschanged', this.onShakaTracksChanged);
      this.installNetworkFilters(sp);
    }
    if (!this.shakaAttached) {
      // Clear any progressive src first, or attach() fights the element.
      this.el.removeAttribute('src');
      this.el.load();
      await this.shakaPlayer.attach(this.el, true);
      this.shakaAttached = true;
    }
    return this.shakaPlayer;
  }

  private async loadWithShaka(
    candidate: SourceCandidate,
    opts: ResolvedLoadOptions,
    token: number,
    signal: AbortSignal,
  ): Promise<void> {
    const sp = await this.ensureShakaPlayer();
    if (token !== this.loadToken) throw abortError();

    sp.configure(this.buildShakaConfig(opts, candidate));

    const start = opts.startTime > 0 ? opts.startTime : null;
    await withTimeout(sp.load(candidate.uri, start, candidate.mimeType), opts.loadTimeoutMs, signal, () =>
      sp.unload(false).catch(() => undefined),
    );
    if (token !== this.loadToken) throw abortError();

    if (typeof opts.quality === 'number') {
      await this.setQuality(opts.quality);
    } else {
      this.abrEnabled = true;
    }
  }

  private buildShakaConfig(opts: ResolvedLoadOptions, candidate: SourceCandidate): Record<string, unknown> {
    const live = this.currentVideo ? videoIsLive(this.currentVideo) : false;
    return {
      preferredVideoCodecs: codecPreferenceList(opts.preferredCodec),
      // Opus is the better codec but AAC is the safer decode on old Windows
      // builds; shaka falls back automatically if the first is absent.
      preferredAudioCodecs: ['opus', 'mp4a'],
      manifest: {
        retryParameters: {
          maxAttempts: 3,
          baseDelay: 400,
          backoffFactor: 2,
          fuzzFactor: 0.5,
          timeout: opts.loadTimeoutMs,
        },
        dash: { ignoreSuggestedPresentationDelay: false },
      },
      streaming: {
        retryParameters: {
          // Segment retries matter more than manifest retries here: a single
          // 403 on a googlevideo segment must not end the session.
          maxAttempts: 4,
          baseDelay: 300,
          backoffFactor: 2,
          fuzzFactor: 0.5,
          timeout: 20000,
        },
        // Bigger forward buffer than the shaka default: Invidious segment
        // throughput is spiky, and buffer depth is the cheapest rebuffer
        // insurance we have.
        //
        // This was briefly dropped to 20 to squeeze more playback out of the
        // 60-second serve limit. That limit is gone (VISIONOS, §3), so the
        // mitigation is gone with it.
        bufferingGoal: live ? 20 : 40,
        rebufferingGoal: live ? 4 : 2,
        bufferBehind: 60,
        stallEnabled: true,
        stallThreshold: 1,
        stallSkip: 0.1,
        // Do not let a single bad segment be fatal on live.
        failureCallback: undefined,
      },
      abr: {
        enabled: opts.quality === 'auto',
        // Start conservative so the first segment arrives fast, then climb.
        // This is the single biggest lever on time-to-first-frame.
        defaultBandwidthEstimate: 1200000,
        switchInterval: 6,
        bandwidthUpgradeTarget: 0.85,
        bandwidthDowngradeTarget: 0.95,
        restrictions: {
          maxHeight: opts.maxHeight ?? Infinity,
        },
      },
      // Invidious captions are fetched by us and injected as blobs; no need
      // for shaka to guess encodings.
      textDisplayFactory: undefined,
      preferredTextLanguage: opts.captionLanguage ?? '',
      // NOTE: do not add non-shaka keys here. `sp.configure()` walks this object
      // against its own schema and logs "Invalid config, unrecognized key" for
      // anything it does not know, which buried the console in noise on every
      // single video load. (Valid keys are still applied - shaka skips only the
      // unknown one - but the error made every console read harder.)
    };
  }

  private async loadProgressive(
    candidate: SourceCandidate,
    opts: ResolvedLoadOptions,
    token: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.shakaPlayer && this.shakaAttached) {
      try {
        await this.shakaPlayer.unload(false);
        await this.shakaPlayer.detach();
      } catch {
        /* ignore */
      }
      this.shakaAttached = false;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.el.removeEventListener('loadedmetadata', onReady);
        this.el.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
        clearTimeout(timer);
      };
      const onReady = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (opts.startTime > 0) {
          try {
            this.el.currentTime = opts.startTime;
          } catch {
            /* ignore */
          }
        }
        resolve();
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(fromMediaError(this.el, { sourceKind: 'progressive', uri: candidate.uri }));
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new PlaybackError({ code: 'LOAD_TIMEOUT', uri: candidate.uri, sourceKind: 'progressive', message: 'Progressive stream did not produce metadata in time.' }));
      }, opts.loadTimeoutMs);

      this.el.addEventListener('loadedmetadata', onReady, { once: true });
      this.el.addEventListener('error', onError, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });

      this.el.src = candidate.uri;
      this.el.load();
      if (token !== this.loadToken) onAbort();
    });
  }

  private async setProgressiveQuality(selection: QualitySelection): Promise<void> {
    const video = this.currentVideo;
    const opts = this.currentOpts;
    if (!video || !opts || selection === 'auto') return;
    const formats = video.formatStreams ?? [];
    if (formats.length === 0) return;

    const wanted = typeof selection === 'number' ? selection : Number(selection);
    let best = formats[0];
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const f of formats) {
      const h = parseHeight(f) ?? 0;
      const delta = h <= wanted ? wanted - h : (wanted - h) * 4; // prefer <= requested
      if (Math.abs(delta) < bestDelta) {
        bestDelta = Math.abs(delta);
        best = f;
      }
    }
    const at = this.el.currentTime;
    const wasPlaying = !this.el.paused;
    const uri = this.currentSource?.proxied ? proxifyMediaUrl(opts.instance, best.url) : best.url;
    this.el.src = uri;
    this.el.load();
    this.el.currentTime = at;
    if (wasPlaying) await this.el.play().catch(() => undefined);
    this.refreshQualities();
    this.emitter.emit('qualitychange', { quality: this.getActiveQuality(), auto: false });
  }

  /* ---------------------------------------------------------------- */
  /* Captions                                                          */
  /* ---------------------------------------------------------------- */

  private async loadCaptions(video: InvidiousVideo, opts: ResolvedLoadOptions, token: number): Promise<void> {
    let list: InvidiousCaption[] = Array.isArray(video.captions) ? video.captions : [];
    if (list.length === 0) {
      try {
        list = await fetchCaptionList(opts.instance, video.videoId, { retries: 1, signal: this.abort?.signal });
      } catch (e) {
        this.emitter.emit('warning', { error: toPlaybackError(e) });
        return;
      }
    }
    if (token !== this.loadToken || list.length === 0) return;

    const wanted = opts.captionLanguage;
    // Fetch eagerly only the language we intend to show; the rest are fetched
    // on demand by loadCaptionTrack(). Caption fetches are extra instance load.
    const tracks: TextTrackOption[] = list.map((c, i) => ({
      id: c.languageCode || String(i),
      label: c.label,
      language: c.languageCode,
      active: false,
    }));
    this.textTracks = tracks;
    this.emitter.emit('texttrackschanged', { tracks });

    if (!wanted) return;
    const match = list.find((c) => c.languageCode === wanted) ?? list.find((c) => c.languageCode.split('-')[0] === wanted.split('-')[0]);
    if (!match) return;
    await this.loadCaptionTrack(match, true);
  }

  /** Fetch one caption track and attach it (blob URL: no second CORS surface). */
  async loadCaptionTrack(caption: InvidiousCaption, show = true): Promise<void> {
    const opts = this.currentOpts;
    if (!opts) return;
    const token = this.loadToken;
    let blobUrl: string;
    try {
      blobUrl = await fetchCaptionAsBlobUrl(opts.instance, caption, { retries: 1, signal: this.abort?.signal });
    } catch (e) {
      this.emitter.emit('warning', { error: toPlaybackError(e) });
      return;
    }
    if (token !== this.loadToken) {
      URL.revokeObjectURL(blobUrl);
      return;
    }
    this.blobUrls.push(blobUrl);

    if (this.currentSource && this.currentSource.kind !== 'progressive' && this.shakaPlayer) {
      try {
        await this.shakaPlayer.addTextTrackAsync(blobUrl, caption.languageCode, 'subtitle', 'text/vtt', undefined, caption.label);
        if (show) await this.setTextTrack(caption.languageCode);
      } catch (e) {
        this.emitter.emit('warning', { error: toPlaybackError(e) });
      }
      return;
    }

    const trackEl = document.createElement('track');
    trackEl.kind = 'subtitles';
    trackEl.label = caption.label;
    trackEl.srclang = caption.languageCode;
    trackEl.src = blobUrl;
    trackEl.default = show;
    this.el.appendChild(trackEl);
    this.nativeTrackEls.push(trackEl);
    if (show) await this.setTextTrack(caption.languageCode);
  }

  private clearTextTracks(): void {
    for (const t of this.nativeTrackEls) {
      if (t.parentNode) t.parentNode.removeChild(t);
    }
    this.nativeTrackEls = [];
    for (const url of this.blobUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }
    this.blobUrls = [];
    this.textTracks = [];
  }

  /* ---------------------------------------------------------------- */
  /* Qualities                                                         */
  /* ---------------------------------------------------------------- */

  private refreshQualities(): void {
    const source = this.currentSource;
    if (!source) {
      this.qualities = [];
      return;
    }

    const out: QualityOption[] = [];

    if (source.kind === 'progressive') {
      const formats = this.currentVideo?.formatStreams ?? [];
      const currentSrc = this.el.currentSrc || this.el.src;
      for (const f of formats) {
        const h = parseHeight(f);
        out.push({
          id: f.itag,
          label: f.qualityLabel ?? (h != null ? String(h) + 'p' : 'unknown'),
          height: h,
          bitrate: f.bitrate != null ? Number(f.bitrate) : null,
          fps: f.fps ?? null,
          codec: f.encoding ?? null,
          auto: false,
          active: currentSrc.includes('itag=' + f.itag) || currentSrc === f.url,
        });
      }
      out.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
      this.qualities = out;
      this.emitter.emit('qualitiesupdated', { qualities: this.qualities });
      return;
    }

    const sp = this.shakaPlayer;
    if (!sp) {
      this.qualities = [];
      return;
    }

    const variants = sp.getVariantTracks();
    const byHeight = new Map<number, ShakaTrack>();
    let activeHeight: number | null = null;
    for (const v of variants) {
      if (v.height == null) continue;
      if (v.active) activeHeight = v.height;
      const existing = byHeight.get(v.height);
      if (!existing || v.bandwidth > existing.bandwidth) byHeight.set(v.height, v);
    }

    out.push({
      id: 'auto',
      label: this.abrEnabled && activeHeight != null ? 'Auto (' + String(activeHeight) + 'p)' : 'Auto',
      height: null,
      auto: true,
      active: this.abrEnabled,
    });

    const heights = Array.from(byHeight.keys()).sort((a, b) => b - a);
    for (const h of heights) {
      const v = byHeight.get(h) as ShakaTrack;
      out.push({
        id: String(v.id),
        label: String(h) + 'p' + (v.frameRate != null && v.frameRate >= 50 ? String(Math.round(v.frameRate)) : ''),
        height: h,
        width: v.width,
        bitrate: v.bandwidth,
        fps: v.frameRate,
        codec: v.videoCodec,
        auto: false,
        active: !this.abrEnabled && v.active,
      });
    }

    this.qualities = out;
    this.emitter.emit('qualitiesupdated', { qualities: this.qualities });
  }

  /* ---------------------------------------------------------------- */
  /* Engine + element event plumbing                                   */
  /* ---------------------------------------------------------------- */

  private installNetworkFilters(sp: ShakaPlayerInstance): void {
    const engine = sp.getNetworkingEngine();
    if (!engine) return;
    engine.registerRequestFilter((type: number, request: ShakaRequest) => {
      if (type !== RequestType.SEGMENT && type !== RequestType.MANIFEST) return;
      // Range requests against googlevideo are the norm; some instances choke
      // on extra headers, so we deliberately do NOT add any here.
      // Hook point: rewrite to the proxy after a 403 without a full reload.
      if (this.forceProxyForSegments && this.currentOpts) {
        request.uris = request.uris.map((u) => proxifyMediaUrl(this.currentOpts!.instance, u));
      }
    });
  }

  private forceProxyForSegments = false;

  private onShakaError = (event: ShakaEventLike): void => {
    const detail = (event.detail ?? event) as { category?: number; code?: number; data?: unknown[] };
    const err = toPlaybackError(detail, {
      sourceKind: this.currentSource?.kind,
      uri: this.currentSource?.uri,
    });

    // Mid-playback 403/expiry: try the proxied path once before giving up.
    const canProxyRetry =
      (err.code === 'STREAM_FORBIDDEN' || err.code === 'STREAM_EXPIRED') &&
      this.currentSource != null &&
      !this.currentSource.proxied &&
      this.currentOpts?.proxyMode !== 'never' &&
      !this.recovering;

    if (canProxyRetry) {
      this.emitter.emit('warning', { error: err });
      this.forceProxyForSegments = true;
      void this.recover({ forceProxy: true }).catch((e: unknown) => {
        this.emitter.emit('error', { error: toPlaybackError(e) });
      });
      return;
    }
    this.emitter.emit('error', { error: err });
  };

  private onShakaBuffering = (event: ShakaEventLike): void => {
    this.setBuffering(event.buffering === true);
  };

  private onShakaTracksChanged = (): void => {
    this.refreshQualities();
    if (this.abrEnabled) {
      this.emitter.emit('qualitychange', { quality: this.getActiveQuality(), auto: true });
    }
  };

  private bindMediaElement(): void {
    const add = <K extends keyof HTMLMediaElementEventMap>(
      type: K,
      fn: (e: HTMLMediaElementEventMap[K]) => void,
    ): void => {
      this.el.addEventListener(type, fn);
      this.detachFns.push(() => this.el.removeEventListener(type, fn));
    };

    add('play', () => {
      this.lastProgressAt = Date.now();
      this.emitter.emit('play', undefined);
    });
    add('pause', () => this.emitter.emit('pause', undefined));
    add('ended', () => {
      this.stopTicker();
      this.emitter.emit('ended', undefined);
    });
    add('seeking', () => {
      this.sawSeek = true;
      this.emitter.emit('seeking', { currentTime: this.el.currentTime });
    });
    add('seeked', () => {
      this.lastProgressAt = Date.now();
      this.emitter.emit('seeked', { currentTime: this.el.currentTime });
    });
    add('volumechange', () => this.emitter.emit('volumechange', { volume: this.el.volume, muted: this.el.muted }));
    add('ratechange', () => this.emitter.emit('ratechange', { rate: this.el.playbackRate }));
    add('waiting', () => this.setBuffering(true));
    add('playing', () => {
      this.lastProgressAt = Date.now();
      this.setBuffering(false);
    });
    add('canplay', () => this.setBuffering(false));
    add('error', () => {
      // Only meaningful on the progressive path; shaka surfaces its own errors.
      if (this.currentSource && this.currentSource.kind === 'progressive') {
        this.emitter.emit('error', {
          error: fromMediaError(this.el, { sourceKind: 'progressive', uri: this.currentSource.uri }),
        });
      }
    });
  }

  private setBuffering(value: boolean): void {
    if (this.buffering === value) return;
    this.buffering = value;
    this.emitter.emit('buffering', { buffering: value });
  }

  private startTicker(): void {
    this.stopTicker();
    this.lastTickTime = -1;
    this.lastProgressAt = Date.now();
    this.stallReported = false;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTicker(): void {
    if (this.tickTimer != null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * ~10Hz tick. The element's own 'timeupdate' fires at 4Hz or worse, which is
   * too coarse for SponsorBlock: at 250ms granularity you routinely play a
   * quarter second of the sponsor before the skip lands.
   */
  private tick(): void {
    if (this.destroyed) return;
    const t = this.el.currentTime;
    const duration = this.getState().duration;
    const seeked = this.sawSeek || (this.lastTickTime >= 0 && Math.abs(t - this.lastTickTime) > 1.0);
    this.sawSeek = false;

    if (t !== this.lastTickTime) {
      this.lastTickTime = t;
      this.lastProgressAt = Date.now();
      if (this.stallReported) {
        this.stallReported = false;
        this.setBuffering(false);
      }
      this.emitter.emit('timeupdate', {
        currentTime: t,
        duration,
        bufferedAhead: this.bufferedAhead(t),
        seeked,
      });
      return;
    }

    // No progress: stall watchdog.
    if (this.el.paused || this.el.ended) return;
    const stalledFor = Date.now() - this.lastProgressAt;
    if (stalledFor > 1500) this.setBuffering(true);
    if (stalledFor > STALL_TIMEOUT_MS && !this.stallReported && !this.recovering) {
      this.stallReported = true;
      const err = new PlaybackError({
        code: 'STREAM_THROTTLED',
        sourceKind: this.currentSource?.kind,
        uri: this.currentSource?.uri,
        message:
          'Playback stalled for ' + String(Math.round(stalledFor / 1000)) + 's with no progress - segments are being throttled, expired, or the instance stopped serving.',
      });
      this.emitter.emit('warning', { error: err });
      void this.recover({ forceProxy: this.currentSource?.proxied !== true }).catch((e: unknown) => {
        this.emitter.emit('error', { error: toPlaybackError(e) });
      });
    }
  }

  private bufferedAhead(t: number): number {
    const b = this.el.buffered;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) - 0.1 && t <= b.end(i)) return b.end(i) - t;
    }
    return 0;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new PlaybackError({ code: 'ABORTED', instanceFailure: false, retryable: false, message: 'Player has been destroyed.' });
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function abortError(): PlaybackError {
  return new PlaybackError({ code: 'ABORTED', message: 'Load superseded or aborted.', instanceFailure: false, retryable: false });
}

function isHardSourceFailure(code: PlaybackErrorCode): boolean {
  return code === 'CODEC_UNSUPPORTED' || code === 'DRM_OR_PROTECTED' || code === 'VIDEO_UNAVAILABLE';
}

function pickVariantForHeight(variants: ShakaTrack[], height: number, codecPref: string): ShakaTrack | null {
  const withHeight = variants.filter((v) => v.height != null);
  if (withHeight.length === 0) return null;
  const atOrBelow = withHeight.filter((v) => (v.height as number) <= height);
  const pool = atOrBelow.length > 0 ? atOrBelow : withHeight;
  let bestHeight = -1;
  for (const v of pool) bestHeight = Math.max(bestHeight, v.height as number);
  const sameHeight = pool.filter((v) => v.height === bestHeight);
  const prefs = codecPreferenceList(codecPref);
  for (const p of prefs) {
    const hit = sameHeight.find((v) => (v.videoCodec ?? '').startsWith(p));
    if (hit) return hit;
  }
  return sameHeight.sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? null;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal: AbortSignal,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      reject(new PlaybackError({ code: 'LOAD_TIMEOUT', message: 'Manifest load exceeded ' + String(ms) + 'ms.' }));
    }, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onTimeout();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export { isPlaybackError };
