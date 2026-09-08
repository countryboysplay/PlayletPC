/**
 * errors.ts - one typed error the app can switch on.
 *
 * The critical bit for a multi-instance client: `instanceFailure` tells the
 * shell "this Invidious instance is the problem, try the next one in the list"
 * versus "this video/codec/device is the problem, rotating instances is futile".
 */

export type PlaybackErrorCode =
  /* instance-level: rotate instance */
  | 'INSTANCE_UNREACHABLE' // DNS / connection refused / TLS / offline
  | 'INSTANCE_HTTP_ERROR' // 5xx, 502 from the reverse proxy, HTML error page
  | 'INSTANCE_RATE_LIMITED' // 429, or Invidious "Could not fetch" / bot-check body
  | 'MANIFEST_UNAVAILABLE' // /api/manifest/dash returned nothing usable
  /* upstream googlevideo-level: rotate instance OR switch to proxied */
  | 'STREAM_FORBIDDEN' // 403 on a googlevideo segment (IP mismatch / expired)
  | 'STREAM_EXPIRED' // url expire param already in the past
  | 'STREAM_THROTTLED' // segment throughput collapsed (n-sig throttling)
  /* content/device-level: rotating instances will not help */
  | 'CODEC_UNSUPPORTED'
  | 'DRM_OR_PROTECTED'
  | 'MEDIA_DECODE_ERROR'
  | 'VIDEO_UNAVAILABLE' // private / removed / geo-blocked / age-gated
  | 'LIVE_NOT_STARTED'
  /* local */
  | 'CORS_BLOCKED'
  | 'NO_PLAYABLE_SOURCE'
  | 'LOAD_TIMEOUT'
  | 'ABORTED'
  | 'CAPTIONS_FAILED'
  | 'UNKNOWN';

export interface PlaybackErrorInit {
  code: PlaybackErrorCode;
  message: string;
  /** true => the shell should try the next Invidious instance */
  instanceFailure?: boolean;
  /** true => retrying the same request may succeed */
  retryable?: boolean;
  /** the source we were attempting when this blew up */
  sourceKind?: string;
  uri?: string;
  httpStatus?: number;
  cause?: unknown;
  /** raw engine error for logging (shaka.util.Error, MediaError, ...) */
  detail?: unknown;
}

const DEFAULT_INSTANCE_FAILURE: ReadonlySet<PlaybackErrorCode> = new Set<PlaybackErrorCode>([
  'INSTANCE_UNREACHABLE',
  'INSTANCE_HTTP_ERROR',
  'INSTANCE_RATE_LIMITED',
  'MANIFEST_UNAVAILABLE',
  'STREAM_FORBIDDEN',
  'STREAM_EXPIRED',
  'STREAM_THROTTLED',
  'CORS_BLOCKED',
]);

const DEFAULT_RETRYABLE: ReadonlySet<PlaybackErrorCode> = new Set<PlaybackErrorCode>([
  'INSTANCE_UNREACHABLE',
  'INSTANCE_HTTP_ERROR',
  'INSTANCE_RATE_LIMITED',
  'STREAM_FORBIDDEN',
  'STREAM_EXPIRED',
  'STREAM_THROTTLED',
  'LOAD_TIMEOUT',
  'MANIFEST_UNAVAILABLE',
]);

export class PlaybackError extends Error {
  readonly code: PlaybackErrorCode;
  readonly instanceFailure: boolean;
  readonly retryable: boolean;
  readonly sourceKind?: string;
  readonly uri?: string;
  readonly httpStatus?: number;
  readonly detail?: unknown;

  constructor(init: PlaybackErrorInit) {
    super(init.message);
    this.name = 'PlaybackError';
    this.code = init.code;
    this.instanceFailure = init.instanceFailure ?? DEFAULT_INSTANCE_FAILURE.has(init.code);
    this.retryable = init.retryable ?? DEFAULT_RETRYABLE.has(init.code);
    this.sourceKind = init.sourceKind;
    this.uri = init.uri;
    this.httpStatus = init.httpStatus;
    this.detail = init.detail;
    if (init.cause !== undefined) {
      // "cause" is ES2022; assign defensively so we compile under older libs too.
      (this as unknown as { cause?: unknown }).cause = init.cause;
    }
    Object.setPrototypeOf(this, PlaybackError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      instanceFailure: this.instanceFailure,
      retryable: this.retryable,
      sourceKind: this.sourceKind,
      uri: this.uri,
      httpStatus: this.httpStatus,
    };
  }
}

export function isPlaybackError(e: unknown): e is PlaybackError {
  return (
    e instanceof PlaybackError ||
    (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'PlaybackError')
  );
}

/** Map an HTTP status seen on an *instance* request to a code. */
export function codeForInstanceStatus(status: number): PlaybackErrorCode {
  if (status === 429) return 'INSTANCE_RATE_LIMITED';
  if (status === 403) return 'STREAM_FORBIDDEN';
  if (status === 404 || status === 410) return 'VIDEO_UNAVAILABLE';
  return 'INSTANCE_HTTP_ERROR';
}

/* ------------------------------------------------------------------ */
/* shaka error translation                                             */
/* ------------------------------------------------------------------ */

/** Shape of shaka.util.Error we care about (kept structural on purpose). */
export interface ShakaErrorLike {
  severity?: number;
  category?: number;
  code?: number;
  data?: unknown[];
  message?: string;
}

/** shaka.util.Error.Category */
const CAT_NETWORK = 1;
const CAT_TEXT = 2;
const CAT_MEDIA = 3;
const CAT_MANIFEST = 4;
const CAT_DRM = 6;

/** shaka.util.Error.Code (the ones worth branching on) */
const BAD_HTTP_STATUS = 1001;
const HTTP_ERROR = 1002;
const NET_TIMEOUT = 1003;
const REQUEST_FILTER_ERROR = 1006;
const MEDIA_SOURCE_OPERATION_FAILED = 3014;
const VIDEO_ERROR = 3016;
const DASH_INVALID_XML = 4001;
const UNPLAYABLE_PERIOD = 4011;
const HLS_COULD_NOT_PARSE = 4020;
const CONTENT_UNSUPPORTED_BY_BROWSER = 4032;

export function fromShakaError(
  err: ShakaErrorLike,
  ctx: { sourceKind?: string; uri?: string } = {},
): PlaybackError {
  const data = Array.isArray(err.data) ? err.data : [];
  const uri = typeof data[0] === 'string' ? (data[0] as string) : ctx.uri;
  const status = typeof data[1] === 'number' ? (data[1] as number) : undefined;
  const base = { sourceKind: ctx.sourceKind, uri, detail: err };

  if (err.category === CAT_NETWORK) {
    if (err.code === BAD_HTTP_STATUS) {
      if (status === 403) {
        return new PlaybackError({
          ...base,
          httpStatus: 403,
          code: 'STREAM_FORBIDDEN',
          message:
            '403 from the media host - the stream URL is bound to another IP or has expired. Retry through the instance proxy (local=true) or another instance.',
        });
      }
      if (status === 429) {
        return new PlaybackError({
          ...base,
          httpStatus: 429,
          code: 'INSTANCE_RATE_LIMITED',
          message: 'Rate limited (429) while fetching media.',
        });
      }
      if (status === 404 || status === 410) {
        return new PlaybackError({
          ...base,
          httpStatus: status,
          code: 'STREAM_EXPIRED',
          message: 'Media segment gone (' + String(status) + '); the stream URLs have most likely expired.',
        });
      }
      return new PlaybackError({
        ...base,
        httpStatus: status,
        code: 'INSTANCE_HTTP_ERROR',
        message: 'HTTP ' + String(status ?? '?') + ' while fetching media.',
      });
    }
    if (err.code === HTTP_ERROR) {
      // shaka reports CORS rejections and connection failures identically here.
      return new PlaybackError({
        ...base,
        code: 'CORS_BLOCKED',
        message: 'Network request failed with no status - CORS rejection, TLS failure, or host unreachable.',
      });
    }
    if (err.code === NET_TIMEOUT) {
      return new PlaybackError({ ...base, code: 'LOAD_TIMEOUT', message: 'Network timeout while fetching media.' });
    }
    if (err.code === REQUEST_FILTER_ERROR) {
      return new PlaybackError({ ...base, code: 'UNKNOWN', message: 'A request filter threw while preparing a media request.' });
    }
    return new PlaybackError({
      ...base,
      code: 'INSTANCE_UNREACHABLE',
      message: err.message ?? 'Network error while streaming.',
    });
  }

  if (err.category === CAT_MANIFEST) {
    if (err.code === CONTENT_UNSUPPORTED_BY_BROWSER || err.code === UNPLAYABLE_PERIOD) {
      return new PlaybackError({
        ...base,
        code: 'CODEC_UNSUPPORTED',
        instanceFailure: false,
        retryable: false,
        message: 'No representation in the manifest is playable by this engine (codec or container unsupported).',
      });
    }
    if (err.code === DASH_INVALID_XML || err.code === HLS_COULD_NOT_PARSE) {
      return new PlaybackError({
        ...base,
        code: 'MANIFEST_UNAVAILABLE',
        message: 'The instance returned a manifest that could not be parsed (often an HTML error page).',
      });
    }
    return new PlaybackError({ ...base, code: 'MANIFEST_UNAVAILABLE', message: err.message ?? 'Manifest error.' });
  }

  if (err.category === CAT_MEDIA) {
    if (err.code === VIDEO_ERROR || err.code === MEDIA_SOURCE_OPERATION_FAILED) {
      return new PlaybackError({
        ...base,
        code: 'MEDIA_DECODE_ERROR',
        instanceFailure: false,
        retryable: true,
        message: 'The decoder rejected the media (corrupt segment or unsupported profile).',
      });
    }
    return new PlaybackError({
      ...base,
      code: 'MEDIA_DECODE_ERROR',
      instanceFailure: false,
      message: err.message ?? 'Media error.',
    });
  }

  if (err.category === CAT_DRM) {
    return new PlaybackError({
      ...base,
      code: 'DRM_OR_PROTECTED',
      instanceFailure: false,
      retryable: false,
      message: 'Content is DRM protected; this client cannot play it.',
    });
  }

  if (err.category === CAT_TEXT) {
    return new PlaybackError({
      ...base,
      code: 'CAPTIONS_FAILED',
      instanceFailure: false,
      retryable: false,
      message: 'Caption track failed to load or parse.',
    });
  }

  return new PlaybackError({
    ...base,
    code: 'UNKNOWN',
    message:
      err.message ?? 'Playback engine error (category ' + String(err.category) + ', code ' + String(err.code) + ').',
  });
}

/** Map a raw HTMLMediaElement MediaError (progressive fallback path). */
export function fromMediaError(
  el: HTMLMediaElement,
  ctx: { sourceKind?: string; uri?: string } = {},
): PlaybackError {
  const me = el.error;
  const base = { sourceKind: ctx.sourceKind, uri: ctx.uri ?? el.currentSrc, detail: me };
  switch (me ? me.code : 0) {
    case 1: // MEDIA_ERR_ABORTED
      return new PlaybackError({ ...base, code: 'ABORTED', instanceFailure: false, retryable: false, message: 'Playback aborted.' });
    case 2: // MEDIA_ERR_NETWORK
      return new PlaybackError({ ...base, code: 'INSTANCE_UNREACHABLE', message: 'Network dropped while streaming the progressive file.' });
    case 3: // MEDIA_ERR_DECODE
      return new PlaybackError({ ...base, code: 'MEDIA_DECODE_ERROR', instanceFailure: false, message: 'Decode error on the progressive stream.' });
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
      return new PlaybackError({
        ...base,
        code: 'STREAM_FORBIDDEN',
        message:
          'The source was rejected - on googlevideo URLs this is usually a 403/expired URL rather than a real codec problem.',
      });
    default:
      return new PlaybackError({ ...base, code: 'UNKNOWN', message: (me && me.message) || 'Unknown media element error.' });
  }
}

/** Normalise anything thrown into a PlaybackError. */
export function toPlaybackError(e: unknown, ctx: { sourceKind?: string; uri?: string } = {}): PlaybackError {
  if (isPlaybackError(e)) return e as PlaybackError;
  if (typeof e === 'object' && e !== null && 'category' in (e as object) && 'code' in (e as object)) {
    return fromShakaError(e as ShakaErrorLike, ctx);
  }
  if (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError') {
    return new PlaybackError({ code: 'ABORTED', message: 'Load aborted.', instanceFailure: false, retryable: false, ...ctx });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return new PlaybackError({ code: 'UNKNOWN', message: msg, cause: e, ...ctx });
}
