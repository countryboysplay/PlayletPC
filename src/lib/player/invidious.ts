/**
 * invidious.ts - instance URL building, HTTP with retry, captions.
 *
 * IMPORTANT (Tauri): pass Tauri's HTTP plugin fetch in as `fetchImpl`. It runs
 * in Rust, so it is not subject to the WebView2 CORS/preflight rules and it can
 * set a Referer/Origin/User-Agent that googlevideo will not reject. The default
 * is the WebView's own fetch, which is fine only if the instance sends
 * permissive CORS headers.
 *
 *   import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
 *   configureHttp({ fetchImpl: tauriFetch as unknown as FetchLike });
 */

import { PlaybackError, codeForInstanceStatus, toPlaybackError } from './errors';
import type { InvidiousCaption, InvidiousVideo } from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface HttpConfig {
  fetchImpl: FetchLike;
  /** Sent on every instance request. Some instances gate on UA. */
  userAgent: string | null;
  defaultTimeoutMs: number;
}

const config: HttpConfig = {
  fetchImpl: (input, init) => fetch(input, init),
  userAgent: null,
  defaultTimeoutMs: 15000,
};

export function configureHttp(patch: Partial<HttpConfig>): void {
  if (patch.fetchImpl) config.fetchImpl = patch.fetchImpl;
  if (patch.userAgent !== undefined) config.userAgent = patch.userAgent;
  if (patch.defaultTimeoutMs !== undefined) config.defaultTimeoutMs = patch.defaultTimeoutMs;
}

export function getFetchImpl(): FetchLike {
  return config.fetchImpl;
}

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

export function normalizeInstance(instance: string): string {
  let base = instance.trim();
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  return base.replace(/\/+$/, '');
}

/**
 * Invidious-generated DASH manifest.
 * local=true makes the instance proxy every media segment (/videoplayback...),
 * which is what makes playback work from a desktop IP that is not the IP the
 * stream URLs were signed for.
 */
export function buildDashManifestUrl(instance: string, videoId: string, local: boolean): string {
  const base = normalizeInstance(instance);
  const url = base + '/api/manifest/dash/id/' + encodeURIComponent(videoId);
  return local ? url + '?local=true' : url;
}

/** Rewrite an absolute googlevideo URL into an instance-proxied one. */
export function proxifyMediaUrl(instance: string, rawUrl: string): string {
  const base = normalizeInstance(instance);
  try {
    const u = new URL(rawUrl, base);
    if (u.origin === new URL(base).origin) return u.toString();
    // Invidious exposes upstream media under /videoplayback (+ /latest_version).
    if (u.pathname.startsWith('/videoplayback')) {
      const params = u.searchParams;
      params.set('host', u.host);
      params.set('local', 'true');
      return base + '/videoplayback?' + params.toString();
    }
    // Anything else: hand it back untouched rather than produce a broken URL.
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

/** Absolute URL for a caption entry (Invidious returns a relative path). */
export function absoluteCaptionUrl(instance: string, caption: InvidiousCaption): string {
  const base = normalizeInstance(instance);
  try {
    return new URL(caption.url, base + '/').toString();
  } catch {
    return base + (caption.url.startsWith('/') ? '' : '/') + caption.url;
  }
}

/* ------------------------------------------------------------------ */
/* Fetch with typed failures + retry                                   */
/* ------------------------------------------------------------------ */

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  retries?: number;
  backoffMs?: number;
  accept?: string;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PlaybackError({ code: 'ABORTED', message: 'Aborted.', instanceFailure: false, retryable: false }));
      return;
    }
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new PlaybackError({ code: 'ABORTED', message: 'Aborted.', instanceFailure: false, retryable: false }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff with full jitter, capped. */
export function backoffDelay(attempt: number, baseMs: number): number {
  const capped = Math.min(baseMs * Math.pow(2, attempt), 8000);
  return Math.round(capped * (0.5 + Math.random() * 0.5));
}

function linkSignals(outer: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onAbort);
    },
  };
}

export async function requestText(url: string, opts: RequestOptions = {}): Promise<string> {
  const retries = opts.retries ?? 2;
  const backoff = opts.backoffMs ?? 400;
  let last: PlaybackError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const { signal, cancel } = linkSignals(opts.signal, opts.timeoutMs ?? config.defaultTimeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (opts.accept) headers['Accept'] = opts.accept;
      if (config.userAgent) headers['User-Agent'] = config.userAgent;

      const res = await config.fetchImpl(url, { method: 'GET', headers, signal, redirect: 'follow' });
      if (!res.ok) {
        throw new PlaybackError({
          code: codeForInstanceStatus(res.status),
          httpStatus: res.status,
          uri: url,
          message: 'Instance returned HTTP ' + String(res.status) + ' for ' + url,
        });
      }
      return await res.text();
    } catch (e) {
      last = toPlaybackError(e, { uri: url });
      if (last.code === 'ABORTED' || !last.retryable || attempt === retries) throw last;
      await sleep(backoffDelay(attempt, backoff), opts.signal);
    } finally {
      cancel();
    }
  }
  throw last ?? new PlaybackError({ code: 'UNKNOWN', message: 'Request failed.', uri: url });
}

export async function requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const text = await requestText(url, { accept: 'application/json', ...opts });
  try {
    return JSON.parse(text) as T;
  } catch {
    // Cloudflare / nginx error pages are the usual cause here.
    throw new PlaybackError({
      code: 'INSTANCE_HTTP_ERROR',
      uri: url,
      message: 'Instance returned non-JSON (probably an HTML error or bot-check page).',
    });
  }
}

/* ------------------------------------------------------------------ */
/* API calls                                                           */
/* ------------------------------------------------------------------ */

export async function fetchVideo(
  instance: string,
  videoId: string,
  opts: RequestOptions = {},
): Promise<InvidiousVideo> {
  const url = normalizeInstance(instance) + '/api/v1/videos/' + encodeURIComponent(videoId);
  const video = await requestJson<InvidiousVideo>(url, opts);
  if (video.error) {
    throw new PlaybackError({
      code: 'VIDEO_UNAVAILABLE',
      instanceFailure: false,
      retryable: false,
      uri: url,
      message: video.error,
    });
  }
  if (!video.videoId) {
    throw new PlaybackError({ code: 'INSTANCE_HTTP_ERROR', uri: url, message: 'Malformed video payload from instance.' });
  }
  return video;
}

export interface CaptionsResponse {
  captions: InvidiousCaption[];
}

/**
 * GET /api/v1/captions/:id
 * Note: the video payload usually already carries `captions`; this is the
 * explicit endpoint for when it does not, or when you refresh the list.
 */
export async function fetchCaptionList(
  instance: string,
  videoId: string,
  opts: RequestOptions = {},
): Promise<InvidiousCaption[]> {
  const url = normalizeInstance(instance) + '/api/v1/captions/' + encodeURIComponent(videoId);
  const body = await requestJson<CaptionsResponse | InvidiousCaption[]>(url, opts);
  if (Array.isArray(body)) return body;
  return Array.isArray(body.captions) ? body.captions : [];
}

/**
 * Fetch the WebVTT text for one caption track and hand back a blob: URL.
 *
 * Why a blob and not the remote URL: the engine (or a <track> element) fetching
 * cross-origin subtitles is a second CORS surface that fails independently of
 * the manifest. Fetching it ourselves means it goes through the same (possibly
 * Rust-side, CORS-free) fetch as everything else, and the engine only ever sees
 * a same-origin blob.
 */
export async function fetchCaptionAsBlobUrl(
  instance: string,
  caption: InvidiousCaption,
  opts: RequestOptions = {},
): Promise<string> {
  const url = absoluteCaptionUrl(instance, caption);
  let vtt: string;
  try {
    vtt = await requestText(url, { accept: 'text/vtt', ...opts });
  } catch (e) {
    const pe = toPlaybackError(e, { uri: url });
    throw new PlaybackError({
      code: 'CAPTIONS_FAILED',
      instanceFailure: false,
      retryable: false,
      uri: url,
      message: 'Could not load captions for ' + caption.label + ': ' + pe.message,
      cause: pe,
    });
  }
  const normalized = vtt.startsWith('WEBVTT') ? vtt : 'WEBVTT\n\n' + vtt;
  return URL.createObjectURL(new Blob([normalized], { type: 'text/vtt' }));
}
