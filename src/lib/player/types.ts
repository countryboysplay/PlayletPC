/**
 * types.ts — Invidious API shapes + player-facing types.
 *
 * Only the fields we actually consume are declared; Invidious returns more.
 * Everything optional is genuinely optional in the wild: instances run
 * different Invidious versions and some fields disappear when YouTube changes.
 */

/* ------------------------------------------------------------------ */
/* Invidious REST shapes                                               */
/* ------------------------------------------------------------------ */

/** Muxed (video+audio in one file) progressive stream. itag 18 = 360p, 22 = 720p. */
export interface InvidiousFormatStream {
  url: string;
  itag: string;
  /** e.g. `video/mp4; codecs="avc1.42001E, mp4a.40.2"` */
  type: string;
  /** 'small' | 'medium' | 'hd720' ... (legacy field) */
  quality?: string;
  container?: string;
  /** 'h264' */
  encoding?: string;
  /** '360p' | '720p' */
  qualityLabel?: string;
  /** '1280x720' */
  resolution?: string;
  size?: string;
  bitrate?: string;
  fps?: number;
}

/** DASH representation: video-only OR audio-only. */
export interface InvidiousAdaptiveFormat {
  url: string;
  itag: string;
  /** e.g. `video/webm; codecs="vp9"` or `audio/mp4; codecs="mp4a.40.2"` */
  type: string;
  /** byte range "start-end" for the sidx/index box */
  index?: string;
  /** byte range "start-end" for the init segment */
  init?: string;
  bitrate?: string;
  /** content length in bytes, as a string */
  clen?: string;
  lmt?: string;
  projectionType?: string | number;
  container?: string;
  /** 'vp9' | 'av01' | 'h264' | 'opus' | 'aac' */
  encoding?: string;
  qualityLabel?: string;
  resolution?: string;
  fps?: number;
  audioQuality?: string;
  audioSampleRate?: number;
  audioChannels?: number;
  /** present on some instances for the default audio track */
  audioTrack?: { id?: string; displayName?: string; audioIsDefault?: boolean };
}

export interface InvidiousCaption {
  label: string;
  /** BCP-47-ish, e.g. 'en', 'pt-BR' */
  languageCode: string;
  /** usually a path relative to the instance root: /api/v1/captions/ID?label=... */
  url: string;
}

export interface InvidiousStoryboard {
  url: string;
  templateUrl?: string;
  width: number;
  height: number;
  count: number;
  interval: number;
  storyboardWidth: number;
  storyboardHeight: number;
  storyboardCount: number;
}

/** Response of GET /api/v1/videos/:id */
export interface InvidiousVideo {
  videoId: string;
  title: string;
  lengthSeconds: number;

  liveNow?: boolean;
  isUpcoming?: boolean;
  /** live that just ended but is still served as a DVR HLS window */
  isPostLiveDvr?: boolean;
  isListed?: boolean;
  isFamilyFriendly?: boolean;

  hlsUrl?: string | null;
  dashUrl?: string | null;

  formatStreams?: InvidiousFormatStream[];
  adaptiveFormats?: InvidiousAdaptiveFormat[];
  captions?: InvidiousCaption[];
  storyboards?: InvidiousStoryboard[];

  /** present on error responses from some instances */
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Player-facing types                                                 */
/* ------------------------------------------------------------------ */

export type SourceKind = 'dash' | 'hls' | 'progressive';

export interface SourceCandidate {
  kind: SourceKind;
  /** absolute URL handed to the engine (or to <video src>) */
  uri: string;
  /** explicit MIME so shaka does not have to sniff by extension */
  mimeType?: string;
  /** whether segments route through the Invidious instance (local=true) */
  proxied: boolean;
  /** human-readable, used in errors + telemetry */
  description: string;
  /** hard ceiling this source can deliver, for the UI to be honest about */
  maxHeight: number | null;
  /** only set for progressive: the format we picked */
  format?: InvidiousFormatStream;
}

export type QualityId = string;

export interface QualityOption {
  /** stable id: 'auto' or engine track id or itag */
  id: QualityId;
  label: string;
  height: number | null;
  width?: number | null;
  bitrate?: number | null;
  fps?: number | null;
  codec?: string | null;
  /** true only for the synthetic ABR entry */
  auto: boolean;
  active: boolean;
}

export type QualitySelection = 'auto' | number | QualityId;

export type ProxyMode = 'auto' | 'always' | 'never';

export type CodecPreference = 'auto' | 'h264' | 'vp9' | 'av1';

export interface LoadOptions {
  /** Base URL of the Invidious instance, e.g. 'https://inv.example.com' (no trailing slash required). */
  instance: string;
  /** Route media segments through the instance. 'auto' = try direct, fall back to proxied. */
  proxyMode?: ProxyMode;
  /** Start position in seconds (also used for resume). */
  startTime?: number;
  autoplay?: boolean;
  /** Initial quality; 'auto' engages ABR. */
  quality?: QualitySelection;
  /** Cap ABR so mobile hotspots / metered links do not fetch 2160p. */
  maxHeight?: number | null;
  /** Prefer a codec family when several are offered. */
  preferredCodec?: CodecPreference;
  /** Load captions for this language automatically ('en', 'pt-BR'); null = none. */
  captionLanguage?: string | null;
  /** Force a specific source kind (debug / user override). */
  forceSource?: SourceKind | null;
  /**
   * A manifest built by the caller, tried before anything derived from `instance`.
   * The direct YouTube backend has no instance to ask for a manifest, so it generates
   * an MPD from adaptiveFormats and passes a blob URL here.
   */
  manifestUri?: string | null;
  /** Per-candidate retry attempts before falling through to the next candidate. */
  retries?: number;
  /** Base backoff in ms; grows exponentially with jitter. */
  retryBackoffMs?: number;
  /** Abort a load that has not produced a manifest in this long. */
  loadTimeoutMs?: number;
}

export interface ResolvedLoadOptions
  extends Required<Omit<LoadOptions, 'maxHeight' | 'captionLanguage' | 'forceSource' | 'manifestUri'>> {
  maxHeight: number | null;
  captionLanguage: string | null;
  forceSource: SourceKind | null;
  manifestUri: string | null;
}

export interface TextTrackOption {
  id: string;
  label: string;
  language: string;
  active: boolean;
}

export interface PlayerState {
  loaded: boolean;
  live: boolean;
  playing: boolean;
  buffering: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  source: SourceCandidate | null;
}
