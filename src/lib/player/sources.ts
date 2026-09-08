/**
 * sources.ts - decide what to actually play, in what order.
 *
 * The output is an ordered candidate list. The player walks it top to bottom,
 * so the ordering IS the degradation policy:
 *
 *   live  : HLS (instance) -> HLS (proxied) -> DASH -> best muxed
 *   VOD   : DASH direct -> DASH proxied (local=true) -> muxed direct -> muxed proxied
 *
 * Direct-before-proxied is deliberate: proxied segments burn a volunteer
 * instance's bandwidth and are the first thing rate limiters kill. But
 * googlevideo URLs are signed against the IP that requested them (the
 * instance's IP), so direct playback 403s often enough that the proxied rung
 * must always exist. Ship proxyMode:'always' as a user-visible setting - for
 * some instance/ISP pairs it is the only thing that plays.
 */

import { normalizeInstance, proxifyMediaUrl } from './invidious';
import type {
  InvidiousFormatStream,
  InvidiousVideo,
  ProxyMode,
  SourceCandidate,
  SourceKind,
} from './types';

const MPD_MIME = 'application/dash+xml';
const HLS_MIME = 'application/x-mpegurl';

export function isLive(video: InvidiousVideo): boolean {
  return video.liveNow === true;
}

export function parseHeight(f: { resolution?: string; qualityLabel?: string; size?: string }): number | null {
  const res = f.resolution || f.size;
  if (res) {
    const m = /(\d+)\s*[xX]\s*(\d+)/.exec(res);
    if (m) return Number(m[2]);
    const only = /^(\d+)p/.exec(res);
    if (only) return Number(only[1]);
  }
  if (f.qualityLabel) {
    const m = /(\d+)p/.exec(f.qualityLabel);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Best muxed progressive stream (itag 22 = 720p h264/aac, itag 18 = 360p). */
export function pickBestMuxed(video: InvidiousVideo, maxHeight?: number | null): InvidiousFormatStream | null {
  const list = (video.formatStreams ?? []).filter((f) => typeof f.url === 'string' && f.url.length > 0);
  if (list.length === 0) return null;
  const scored = list
    .map((f) => ({ f, h: parseHeight(f) ?? 0 }))
    .filter((x) => (maxHeight == null ? true : x.h <= maxHeight))
    .sort((a, b) => b.h - a.h);
  return scored.length > 0 ? scored[0].f : (list[0] ?? null);
}

/** Highest height available in adaptiveFormats - what the DASH path can reach. */
export function maxAdaptiveHeight(video: InvidiousVideo): number | null {
  let best: number | null = null;
  for (const f of video.adaptiveFormats ?? []) {
    if (!f.type || !f.type.startsWith('video')) continue;
    const h = parseHeight(f);
    if (h != null && (best == null || h > best)) best = h;
  }
  return best;
}

/** True for a URL that already carries its own origin. */
function isAbsolute(url: string | null | undefined): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function absolutize(instance: string, url: string): string {
  const base = normalizeInstance(instance);
  try {
    return new URL(url, base + '/').toString();
  } catch {
    return url;
  }
}

function withLocalParam(url: string): string {
  return url.includes('local=true') ? url : url + (url.includes('?') ? '&' : '?') + 'local=true';
}

function dashCandidate(instance: string, video: InvidiousVideo, proxied: boolean): SourceCandidate {
  const base = normalizeInstance(instance);
  // Prefer the URL the instance told us about; fall back to the documented path.
  const raw = video.dashUrl && video.dashUrl.length > 0
    ? absolutize(base, video.dashUrl)
    : base + '/api/manifest/dash/id/' + encodeURIComponent(video.videoId);
  const uri = proxied ? withLocalParam(raw) : raw;
  return {
    kind: 'dash',
    uri,
    mimeType: MPD_MIME,
    proxied,
    description: proxied ? 'Invidious DASH manifest (segments proxied, local=true)' : 'Invidious DASH manifest (direct googlevideo segments)',
    maxHeight: maxAdaptiveHeight(video),
  };
}

function hlsCandidate(instance: string, video: InvidiousVideo, proxied: boolean): SourceCandidate | null {
  if (!video.hlsUrl) return null;
  const abs = absolutize(instance, video.hlsUrl);
  let uri = abs;
  try {
    const sameOrigin = new URL(abs).origin === new URL(normalizeInstance(instance)).origin;
    if (proxied && sameOrigin) uri = withLocalParam(abs);
    if (proxied && !sameOrigin) uri = proxifyMediaUrl(instance, abs);
  } catch {
    /* keep abs */
  }
  return {
    kind: 'hls',
    uri,
    mimeType: HLS_MIME,
    proxied,
    description: proxied ? 'Livestream HLS (proxied)' : 'Livestream HLS',
    maxHeight: null, // the variant playlist decides
  };
}

function muxedCandidate(
  instance: string,
  video: InvidiousVideo,
  proxied: boolean,
  maxHeight: number | null,
): SourceCandidate | null {
  const f = pickBestMuxed(video, maxHeight);
  if (!f) return null;
  const uri = proxied ? proxifyMediaUrl(instance, f.url) : f.url;
  const h = parseHeight(f);
  return {
    kind: 'progressive',
    uri,
    mimeType: f.type ? f.type.split(';')[0].trim() : 'video/mp4',
    proxied,
    description:
      'Muxed progressive ' + (f.qualityLabel ?? String(h ?? '?') + 'p') + (proxied ? ' (proxied)' : '') + ' - no ABR, no quality switching',
    maxHeight: h,
    format: f,
  };
}

export interface BuildSourcesOptions {
  instance: string;
  proxyMode: ProxyMode;
  forceSource?: SourceKind | null;
  maxHeight?: number | null;
  /** Set false if the engine (shaka) is unavailable - only progressive can play. */
  mseAvailable?: boolean;
  /** A caller-built manifest, preferred over anything derived from `instance`. */
  manifestUri?: string | null;
}

export function buildSourceCandidates(video: InvidiousVideo, opts: BuildSourcesOptions): SourceCandidate[] {
  const { instance, proxyMode } = opts;
  const mse = opts.mseAvailable !== false;
  // The direct backend has no instance. Anything derived from one would be a relative
  // path that resolves against the app origin and 404s, so those rungs are skipped.
  const hasInstance = typeof instance === 'string' && instance.length > 0;
  const allowDirect = proxyMode !== 'always';
  const allowProxy = proxyMode !== 'never' && hasInstance;
  const out: SourceCandidate[] = [];

  const live = isLive(video);

  // A caller-supplied manifest wins: it is the only option when there is no instance
  // to request one from, and it already points at URLs the app is allowed to fetch.
  if (mse && opts.manifestUri) {
    out.push({
      kind: 'dash',
      uri: opts.manifestUri,
      mimeType: MPD_MIME,
      proxied: false,
      description: 'Locally generated DASH manifest',
      maxHeight: maxAdaptiveHeight(video),
    });
  }

  if (mse && live) {
    if (allowDirect && (hasInstance || isAbsolute(video.hlsUrl))) {
      const c = hlsCandidate(instance, video, false);
      if (c) out.push(c);
    }
    if (allowProxy) {
      const c = hlsCandidate(instance, video, true);
      if (c) out.push(c);
    }
    // Some instances expose a DASH manifest for live too; keep it as a backstop.
    if (allowDirect && hasInstance) out.push(dashCandidate(instance, video, false));
    if (allowProxy) out.push(dashCandidate(instance, video, true));
  } else if (mse) {
    if (allowDirect && hasInstance) out.push(dashCandidate(instance, video, false));
    if (allowProxy) out.push(dashCandidate(instance, video, true));
    // A post-live DVR window is served as HLS even though liveNow is false.
    if (video.isPostLiveDvr && video.hlsUrl) {
      if (allowDirect) {
        const c = hlsCandidate(instance, video, false);
        if (c) out.push(c);
      }
      if (allowProxy) {
        const c = hlsCandidate(instance, video, true);
        if (c) out.push(c);
      }
    }
  }

  // Muxed fallback. Live streams have no formatStreams, so this is VOD-only in practice.
  if (allowDirect) {
    const c = muxedCandidate(instance, video, false, opts.maxHeight ?? null);
    if (c) out.push(c);
  }
  if (allowProxy) {
    const c = muxedCandidate(instance, video, true, opts.maxHeight ?? null);
    if (c) out.push(c);
  }

  const forced = opts.forceSource;
  const filtered = forced ? out.filter((c) => c.kind === forced) : out;

  // De-dupe identical URIs (dashUrl may already carry local=true).
  const seen = new Set<string>();
  return filtered.filter((c) => {
    if (seen.has(c.uri)) return false;
    seen.add(c.uri);
    return true;
  });
}
