/**
 * sponsorblock.ts - segment skip controller.
 *
 * Design rules, learned the hard way from every buggy SponsorBlock port:
 *
 *  1. Never fight the user. If they manually seek back INTO a region we
 *     skipped, that segment is disabled for the rest of the session. If they
 *     seek to BEFORE it and play forward, it re-arms and skips again.
 *  2. Merge before you skip. Overlapping and near-duplicate segments (the
 *     crowd-sourced database is full of them) must become one skip, or the
 *     player stutters through three consecutive 40ms seeks.
 *  3. Only actionType 'skip' skips. 'mute' mutes, 'poi' is an offer to jump,
 *     'full' is a label for the whole video and must never move the playhead.
 *  4. Don't seek for nothing. A skip whose remaining distance is under a
 *     threshold costs more (rebuffer, decoder flush) than it saves.
 *  5. All decisions are driven by the player's timeupdate stream, so a 10Hz
 *     tick is a hard requirement - 4Hz means up to 250ms of audible sponsor.
 */

import type { TimeUpdatePayload } from './player';
import { TypedEmitter, type Unsubscribe } from './emitter';

/* ------------------------------------------------------------------ */
/* API types (mirror the SponsorBlock /api/skipSegments response)      */
/* ------------------------------------------------------------------ */

export type SponsorCategory =
  | 'sponsor'
  | 'selfpromo'
  | 'interaction'
  | 'intro'
  | 'outro'
  | 'preview'
  | 'music_offtopic'
  | 'filler'
  | 'exclusive_access'
  | 'poi_highlight'
  | (string & {});

export type SponsorActionType = 'skip' | 'mute' | 'full' | 'poi' | (string & {});

export interface SponsorSegment {
  category: SponsorCategory;
  /** [start, end] in seconds. For poi/full both values are usually equal-ish. */
  segment: [number, number];
  actionType: SponsorActionType;
  UUID?: string;
  locked?: number;
  votes?: number;
  videoDuration?: number;
}

/** What the user wants done with a category. */
export type CategoryBehavior = 'skip' | 'notify' | 'mute' | 'ignore';

export interface SponsorBlockConfig {
  /** Per-category behaviour. Anything unlisted uses `defaultBehavior`. */
  categories: Partial<Record<SponsorCategory, CategoryBehavior>>;
  defaultBehavior: CategoryBehavior;
  /** Segments shorter than this are ignored entirely (DB noise). */
  minSegmentDurationSec: number;
  /** Segments closer together than this are merged into one skip. */
  mergeGapSec: number;
  /** Don't bother seeking if less than this remains in the segment. */
  minSkipSavingSec: number;
  /** Land this far past the segment end so we cannot re-trigger on rounding. */
  skipEpsilonSec: number;
  /** Fire the skip this early to hide seek latency (0 = exactly on the boundary). */
  leadTimeSec: number;
  /** If a segment ends within this of the video end, treat the skip as "to the end". */
  endOfVideoToleranceSec: number;
  /** A manual seek landing inside a skipped segment disables it for the session. */
  respectManualSeekBack: boolean;
  /** Auto-jump to a poi_highlight on load instead of only offering it. */
  autoJumpToHighlight: boolean;
}

export const DEFAULT_SPONSORBLOCK_CONFIG: SponsorBlockConfig = {
  categories: {
    sponsor: 'skip',
    selfpromo: 'skip',
    interaction: 'skip',
    intro: 'notify',
    outro: 'notify',
    preview: 'notify',
    music_offtopic: 'skip',
    filler: 'ignore',
    exclusive_access: 'ignore',
    poi_highlight: 'notify',
  },
  defaultBehavior: 'ignore',
  minSegmentDurationSec: 0.35,
  mergeGapSec: 0.6,
  minSkipSavingSec: 0.35,
  skipEpsilonSec: 0.05,
  leadTimeSec: 0.05,
  endOfVideoToleranceSec: 1.0,
  respectManualSeekBack: true,
  autoJumpToHighlight: false,
};

/* ------------------------------------------------------------------ */
/* Internal normalised segment                                         */
/* ------------------------------------------------------------------ */

export interface NormalizedSegment {
  id: string;
  start: number;
  end: number;
  /** every source category that contributed after merging */
  categories: SponsorCategory[];
  /** the category we report to the UI (highest priority contributor) */
  primaryCategory: SponsorCategory;
  actionType: SponsorActionType;
  behavior: CategoryBehavior;
  /** true once we have acted on it in the forward direction */
  skipped: boolean;
  /** true once the user has told us (by seeking back in) to leave it alone */
  disabled: boolean;
  /** notify-mode: we already showed the prompt for this pass */
  notified: boolean;
  sourceUUIDs: string[];
}

export interface SkipEvent {
  segment: NormalizedSegment;
  from: number;
  to: number;
  /** Put this behind an "Unskip" button. It seeks back AND disables the segment. */
  undo: () => void;
}

export interface NoticeEvent {
  segment: NormalizedSegment;
  /** manual skip for notify-mode segments */
  skip: () => void;
  dismiss: () => void;
}

export interface SponsorBlockEventMap {
  skip: SkipEvent;
  /** notify-mode segment entered */
  notice: NoticeEvent;
  /** user seeked back into a skipped region - we stood down */
  segmentDisabled: { segment: NormalizedSegment; reason: 'manual-seek' | 'user' };
  segmentRearmed: { segment: NormalizedSegment };
  muteChanged: { muted: boolean; segment: NormalizedSegment | null };
  /** a poi_highlight exists; offer a "jump to highlight" affordance */
  highlight: { time: number; segment: NormalizedSegment };
  /** actionType 'full': the whole video is this category. Label it, never skip. */
  fullVideoLabel: { category: SponsorCategory; segment: NormalizedSegment };
  segmentsChanged: { segments: NormalizedSegment[] };
}

/**
 * Minimal player surface the controller needs. PlayletPlayer satisfies it;
 * so does a bare <video> wrapper, which keeps this unit-testable.
 */
export interface SponsorBlockHost {
  getCurrentTime(): number;
  getDuration(): number;
  seek(seconds: number): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
}

const CATEGORY_PRIORITY: SponsorCategory[] = [
  'sponsor',
  'selfpromo',
  'exclusive_access',
  'interaction',
  'intro',
  'outro',
  'preview',
  'music_offtopic',
  'filler',
];

function priorityOf(cat: SponsorCategory): number {
  const i = CATEGORY_PRIORITY.indexOf(cat);
  return i === -1 ? CATEGORY_PRIORITY.length : i;
}

/* ------------------------------------------------------------------ */
/* Controller                                                          */
/* ------------------------------------------------------------------ */

export class SponsorBlockController {
  private readonly emitter = new TypedEmitter<SponsorBlockEventMap>();
  private config: SponsorBlockConfig;
  private host: SponsorBlockHost | null = null;

  private segments: NormalizedSegment[] = [];
  private highlightSegment: NormalizedSegment | null = null;
  private fullLabels: NormalizedSegment[] = [];

  private duration = 0;
  private lastTime = 0;

  /** Set when WE move the playhead, so the resulting seek is not read as user intent. */
  private pendingSeekTarget: number | null = null;
  private pendingSeekAt = 0;

  /** Currently muted by us (actionType 'mute'). */
  private muteSegment: NormalizedSegment | null = null;
  private mutedStateBeforeSegment = false;

  constructor(config: Partial<SponsorBlockConfig> = {}) {
    this.config = { ...DEFAULT_SPONSORBLOCK_CONFIG, ...config };
    this.emitter.setErrorHandler((e) => console.error('[sponsorblock] listener threw', e));
  }

  on<K extends keyof SponsorBlockEventMap>(
    event: K,
    fn: (payload: SponsorBlockEventMap[K]) => void,
  ): Unsubscribe {
    return this.emitter.on(event, fn);
  }

  setHost(host: SponsorBlockHost | null): void {
    this.host = host;
  }

  updateConfig(patch: Partial<SponsorBlockConfig>): void {
    this.config = { ...this.config, ...patch };
    // Behaviour may have changed; recompute without losing user disables.
    const disabled = new Set(this.segments.filter((s) => s.disabled).map((s) => s.id));
    this.segments = this.segments.map((s) => ({
      ...s,
      behavior: this.behaviorFor(s.primaryCategory, s.actionType),
      disabled: disabled.has(s.id),
    }));
    this.emitter.emit('segmentsChanged', { segments: this.segments });
  }

  getConfig(): SponsorBlockConfig {
    return { ...this.config };
  }

  getSegments(): NormalizedSegment[] {
    return this.segments.slice();
  }

  getHighlight(): NormalizedSegment | null {
    return this.highlightSegment;
  }

  getFullVideoLabels(): NormalizedSegment[] {
    return this.fullLabels.slice();
  }

  /** Call on every new video (and on an empty array when the video changes). */
  setSegments(raw: SponsorSegment[], videoDuration: number): void {
    this.duration = videoDuration > 0 ? videoDuration : 0;
    this.muteSegment = null;
    this.highlightSegment = null;
    this.fullLabels = [];
    this.pendingSeekTarget = null;
    this.lastTime = 0;

    const skippable: NormalizedSegment[] = [];

    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      if (!Array.isArray(s.segment) || s.segment.length < 2) continue;
      let start = Number(s.segment[0]);
      let end = Number(s.segment[1]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (this.duration > 0) {
        start = Math.max(0, Math.min(start, this.duration));
        end = Math.max(0, Math.min(end, this.duration));
      } else {
        start = Math.max(0, start);
        end = Math.max(0, end);
      }
      if (end < start) {
        const t = start;
        start = end;
        end = t;
      }

      const action = s.actionType || 'skip';
      const base: NormalizedSegment = {
        id: s.UUID ?? s.category + ':' + String(start) + '-' + String(end) + ':' + String(i),
        start,
        end,
        categories: [s.category],
        primaryCategory: s.category,
        actionType: action,
        behavior: this.behaviorFor(s.category, action),
        skipped: false,
        disabled: false,
        notified: false,
        sourceUUIDs: s.UUID ? [s.UUID] : [],
      };

      // 'full' labels the entire video. It never moves the playhead - skipping
      // it would mean skipping the video the user just chose to watch.
      if (action === 'full') {
        this.fullLabels.push(base);
        continue;
      }

      // poi / poi_highlight is a single point offered to the user.
      if (action === 'poi' || s.category === 'poi_highlight') {
        if (!this.highlightSegment || base.start < this.highlightSegment.start) {
          this.highlightSegment = base;
        }
        continue;
      }

      if (base.behavior === 'ignore') continue;
      if (end - start < this.config.minSegmentDurationSec) continue;
      skippable.push(base);
    }

    this.segments = mergeSegments(skippable, this.config.mergeGapSec);
    this.emitter.emit('segmentsChanged', { segments: this.segments });

    for (const f of this.fullLabels) {
      this.emitter.emit('fullVideoLabel', { category: f.primaryCategory, segment: f });
    }
    if (this.highlightSegment) {
      this.emitter.emit('highlight', { time: this.highlightSegment.start, segment: this.highlightSegment });
      if (this.config.autoJumpToHighlight) this.jumpToHighlight();
    }
  }

  /** Jump to the poi_highlight, if the video has one. */
  jumpToHighlight(): boolean {
    if (!this.highlightSegment || !this.host) return false;
    this.performSeek(this.highlightSegment.start);
    return true;
  }

  /** Re-enable a segment the user disabled (or that we auto-disabled). */
  rearm(segmentId: string): void {
    const seg = this.segments.find((s) => s.id === segmentId);
    if (!seg) return;
    seg.disabled = false;
    seg.skipped = false;
    seg.notified = false;
    this.emitter.emit('segmentRearmed', { segment: seg });
  }

  disable(segmentId: string): void {
    const seg = this.segments.find((s) => s.id === segmentId);
    if (!seg || seg.disabled) return;
    seg.disabled = true;
    this.emitter.emit('segmentDisabled', { segment: seg, reason: 'user' });
  }

  /** Reset per-playback state without re-fetching (e.g. after a source reload). */
  resetPlaybackState(): void {
    for (const s of this.segments) {
      s.skipped = false;
      s.notified = false;
    }
    this.pendingSeekTarget = null;
    this.endMuteIfActive();
  }

  /**
   * Drive this from the player's timeupdate. Everything - skipping, muting,
   * detecting a manual seek back - happens here so there is exactly one
   * decision point and no racing timers.
   */
  onTimeUpdate(payload: TimeUpdatePayload): void {
    const host = this.host;
    if (!host) return;
    const t = payload.currentTime;
    if (this.duration <= 0 && payload.duration > 0) this.duration = payload.duration;

    const jumped = payload.seeked || Math.abs(t - this.lastTime) > 1.0;
    const movedBackwards = t < this.lastTime - 0.25;

    if (jumped) this.handleSeek(t, movedBackwards);
    this.lastTime = t;

    // --- mute handling (actionType 'mute') ---------------------------
    if (this.muteSegment) {
      const inside = t >= this.muteSegment.start - 0.05 && t < this.muteSegment.end;
      // The user unmuting mid-segment is an explicit override: stand down.
      if (inside && !host.isMuted()) {
        this.muteSegment.disabled = true;
        this.emitter.emit('segmentDisabled', { segment: this.muteSegment, reason: 'user' });
        this.muteSegment = null;
      } else if (!inside) {
        this.endMuteIfActive();
      }
    }

    const seg = this.findActionable(t);
    if (!seg) return;

    if (seg.behavior === 'mute') {
      if (!this.muteSegment && !host.isMuted()) {
        this.mutedStateBeforeSegment = host.isMuted();
        this.muteSegment = seg;
        seg.skipped = true;
        host.setMuted(true);
        this.emitter.emit('muteChanged', { muted: true, segment: seg });
      }
      return;
    }

    if (seg.behavior === 'notify') {
      if (!seg.notified) {
        seg.notified = true;
        this.emitter.emit('notice', {
          segment: seg,
          skip: () => this.executeSkip(seg, t),
          dismiss: () => {
            seg.disabled = true;
            this.emitter.emit('segmentDisabled', { segment: seg, reason: 'user' });
          },
        });
      }
      return;
    }

    if (seg.behavior === 'skip') {
      this.executeSkip(seg, t);
    }
  }

  /* ---------------------------------------------------------------- */
  /* internals                                                         */
  /* ---------------------------------------------------------------- */

  private behaviorFor(category: SponsorCategory, actionType: SponsorActionType): CategoryBehavior {
    const configured = this.config.categories[category] ?? this.config.defaultBehavior;
    if (configured === 'ignore') return 'ignore';
    // An explicit 'mute' actionType from the API overrides a 'skip' preference:
    // the submitter marked it as safe to hear-but-not-see.
    if (actionType === 'mute') return configured === 'notify' ? 'notify' : 'mute';
    return configured;
  }

  /** The segment we should act on at time t, if any. */
  private findActionable(t: number): NormalizedSegment | null {
    const lead = this.config.leadTimeSec;
    for (const s of this.segments) {
      if (s.disabled || s.behavior === 'ignore') continue;
      if (t + lead < s.start) continue;
      if (t >= s.end) continue;
      if (s.behavior === 'skip' && s.skipped) continue;
      // Too close to the end to be worth a seek.
      if (s.behavior === 'skip' && s.end - t < this.config.minSkipSavingSec) continue;
      return s;
    }
    return null;
  }

  private executeSkip(seg: NormalizedSegment, from: number): void {
    const host = this.host;
    if (!host || seg.disabled) return;

    const nearEnd =
      this.duration > 0 && seg.end >= this.duration - this.config.endOfVideoToleranceSec;
    const to = nearEnd ? this.duration : seg.end + this.config.skipEpsilonSec;

    seg.skipped = true;
    seg.notified = true;
    this.performSeek(to);
    this.emitter.emit('skip', {
      segment: seg,
      from,
      to,
      undo: () => {
        seg.disabled = true;
        this.emitter.emit('segmentDisabled', { segment: seg, reason: 'user' });
        this.performSeek(Math.max(0, from - 0.25));
      },
    });
  }

  private performSeek(to: number): void {
    if (!this.host) return;
    this.pendingSeekTarget = to;
    this.pendingSeekAt = Date.now();
    this.lastTime = to;
    this.host.seek(to);
  }

  /**
   * Decide whether a jump in the timeline was ours or the user's, and react.
   *
   * A user seek that lands inside a segment we already skipped is the clearest
   * signal there is: they want to watch it. Disable it for the session.
   * A user seek to before a segment re-arms it, because playing forward into a
   * sponsor they have not seen this pass should still skip.
   */
  private handleSeek(t: number, backwards: boolean): void {
    const ours =
      this.pendingSeekTarget != null &&
      Math.abs(t - this.pendingSeekTarget) < 0.75 &&
      Date.now() - this.pendingSeekAt < 4000;

    if (ours) {
      this.pendingSeekTarget = null;
      return;
    }
    this.pendingSeekTarget = null;

    for (const s of this.segments) {
      const inside = t >= s.start - 0.05 && t < s.end;
      if (inside) {
        if (this.config.respectManualSeekBack && (s.skipped || s.notified) && !s.disabled) {
          s.disabled = true;
          this.emitter.emit('segmentDisabled', { segment: s, reason: 'manual-seek' });
        } else if (!s.disabled) {
          // Landed inside a segment we had not reached yet: let it act
          // normally on the next tick (skip from here).
          s.skipped = false;
          s.notified = false;
        }
        continue;
      }
      // Seeked to before a segment: re-arm it so a forward pass skips again,
      // unless the user explicitly disabled it.
      if (t < s.start && !s.disabled && (s.skipped || s.notified)) {
        s.skipped = false;
        s.notified = false;
        this.emitter.emit('segmentRearmed', { segment: s });
      }
    }

    if (backwards) this.endMuteIfActive();
  }

  private endMuteIfActive(): void {
    if (!this.muteSegment || !this.host) return;
    const seg = this.muteSegment;
    this.muteSegment = null;
    this.host.setMuted(this.mutedStateBeforeSegment);
    this.emitter.emit('muteChanged', { muted: this.mutedStateBeforeSegment, segment: seg });
  }
}

/* ------------------------------------------------------------------ */
/* merging                                                             */
/* ------------------------------------------------------------------ */

/**
 * Merge overlapping and near-duplicate segments that share a behaviour.
 * The crowd-sourced DB routinely contains 30.0-45.0 and 30.2-45.1 for the same
 * sponsor; without this you get two seeks 200ms apart and a visible hitch.
 */
export function mergeSegments(segments: NormalizedSegment[], gap: number): NormalizedSegment[] {
  if (segments.length <= 1) return segments.slice();
  const sorted = segments.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const out: NormalizedSegment[] = [];

  for (const seg of sorted) {
    const prev = out[out.length - 1];
    const mergeable =
      prev != null &&
      prev.behavior === seg.behavior &&
      prev.actionType === seg.actionType &&
      seg.start <= prev.end + gap;

    if (!mergeable) {
      out.push({ ...seg, categories: seg.categories.slice(), sourceUUIDs: seg.sourceUUIDs.slice() });
      continue;
    }
    prev.end = Math.max(prev.end, seg.end);
    for (const c of seg.categories) {
      if (!prev.categories.includes(c)) prev.categories.push(c);
    }
    for (const u of seg.sourceUUIDs) {
      if (!prev.sourceUUIDs.includes(u)) prev.sourceUUIDs.push(u);
    }
    prev.categories.sort((a, b) => priorityOf(a) - priorityOf(b));
    prev.primaryCategory = prev.categories[0];
    prev.id = prev.sourceUUIDs.length > 0 ? prev.sourceUUIDs.join('+') : prev.id;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Player adapter                                                      */
/* ------------------------------------------------------------------ */

export interface SponsorBlockAttachment {
  controller: SponsorBlockController;
  detach: () => void;
}

/**
 * Wire a controller to a PlayletPlayer-shaped object. Kept structural so this
 * module has no import cycle with player.ts at runtime.
 */
export function attachSponsorBlock(
  player: {
    on: (event: 'timeupdate', fn: (p: TimeUpdatePayload) => void) => Unsubscribe;
    getState: () => { currentTime: number; duration: number; muted: boolean };
    seek: (t: number) => void;
    setMuted: (m: boolean) => void;
  },
  controller: SponsorBlockController,
): SponsorBlockAttachment {
  controller.setHost({
    getCurrentTime: () => player.getState().currentTime,
    getDuration: () => player.getState().duration,
    seek: (t) => player.seek(t),
    setMuted: (m) => player.setMuted(m),
    isMuted: () => player.getState().muted,
  });
  const off = player.on('timeupdate', (p) => controller.onTimeUpdate(p));
  return {
    controller,
    detach: () => {
      off();
      controller.setHost(null);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Fetching (thin, so the app can swap in its own privacy policy)      */
/* ------------------------------------------------------------------ */

/**
 * SponsorBlock privacy note: send the SHA-256 prefix, never the raw videoId.
 * GET /api/skipSegments/:hashPrefix returns every video whose id hash starts
 * with that prefix; filter client-side. 4 hex chars is the usual prefix length.
 */
export async function sha256HashPrefix(videoId: string, chars = 4): Promise<string> {
  const data = new TextEncoder().encode(videoId);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, chars);
}

export interface SkipSegmentsResponseItem {
  videoID: string;
  segments: SponsorSegment[];
}

export async function fetchSponsorSegments(
  videoId: string,
  opts: {
    apiBase?: string;
    categories?: SponsorCategory[];
    actionTypes?: SponsorActionType[];
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
    signal?: AbortSignal;
  } = {},
): Promise<SponsorSegment[]> {
  const base = (opts.apiBase ?? 'https://sponsor.ajay.app').replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const prefix = await sha256HashPrefix(videoId, 4);
  const params = new URLSearchParams();
  const categories = opts.categories ?? [
    'sponsor',
    'selfpromo',
    'interaction',
    'intro',
    'outro',
    'preview',
    'music_offtopic',
    'filler',
    'exclusive_access',
    'poi_highlight',
  ];
  params.set('categories', JSON.stringify(categories));
  params.set('actionTypes', JSON.stringify(opts.actionTypes ?? ['skip', 'mute', 'full', 'poi']));

  const url = base + '/api/skipSegments/' + prefix + '?' + params.toString();
  const res = await doFetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: opts.signal });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error('SponsorBlock API returned HTTP ' + String(res.status));
  const body = (await res.json()) as SkipSegmentsResponseItem[];
  const hit = Array.isArray(body) ? body.find((x) => x.videoID === videoId) : undefined;
  return hit ? hit.segments : [];
}
