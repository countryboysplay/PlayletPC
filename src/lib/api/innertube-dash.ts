/**
 * innertube-dash.ts
 *
 * Builds a static (VOD) DASH MPD from YouTube InnerTube `streamingData.adaptiveFormats`.
 *
 * Context / constraints this module is written against:
 *  - The IOS InnerTube client returns direct, unciphered `url` values (no `n` param,
 *    no signature deciphering). We do not touch the URL other than handing it to the
 *    caller-supplied `rewriteUrl`.
 *  - googlevideo only sends `Access-Control-Allow-Origin` for `https://www.youtube.com`,
 *    so the browser/WebView cannot fetch segments directly from an app origin. Every
 *    emitted `<BaseURL>` therefore goes through `opts.rewriteUrl`, which is expected to
 *    map the googlevideo URL onto a Tauri custom-scheme URL served by the Rust side
 *    with `Access-Control-Allow-Origin: *`.
 *  - Formats are indexed with byte ranges (`initRange` / `indexRange`), so we emit
 *    `SegmentBase` + `Initialization` and rely on the range server supporting HTTP
 *    Range requests. A format missing either range cannot be segment-indexed and is
 *    dropped rather than shipped as a guaranteed playback failure.
 *
 * All numeric fields arrive as strings in some responses; every read goes through
 * `num()` / `str()`.
 */

/* ------------------------------------------------------------------ *
 * Input types
 * ------------------------------------------------------------------ */

export interface ByteRangeInput {
  start?: string | number | null;
  end?: string | number | null;
}

export interface AudioTrackInput {
  /** e.g. "en.4", "es-419.3" — language tag before the dot. */
  id?: string | null;
  displayName?: string | null;
  audioIsDefault?: boolean | null;
}

export interface AdaptiveFormatInput {
  itag: number | string;
  url?: string | null;
  /** e.g. `video/webm; codecs="vp09.00.51.08"` */
  mimeType: string;
  bitrate?: number | string | null;
  averageBitrate?: number | string | null;
  width?: number | string | null;
  height?: number | string | null;
  fps?: number | string | null;
  quality?: string | null;
  qualityLabel?: string | null;
  contentLength?: string | number | null;
  initRange?: ByteRangeInput | null;
  indexRange?: ByteRangeInput | null;
  audioQuality?: string | null;
  audioSampleRate?: string | number | null;
  audioChannels?: number | string | null;
  audioTrack?: AudioTrackInput | null;
  /** Dynamic-range-compressed ("stable volume") duplicate of another itag. */
  isDrc?: boolean | null;
  [k: string]: unknown;
}

export interface BuildDashOptions {
  durationSeconds: number;
  /** Maps a googlevideo URL to a same-origin / CORS-permitting URL. */
  rewriteUrl: (url: string) => string;
  /** Drop YouTube auto-dubbed alternate audio tracks (keep only the default track). */
  disableAutoDubbed?: boolean;
  /** Drop video representations taller than this. */
  maxHeight?: number;
  /** Default "PT1.5S". */
  minBufferTimeSeconds?: number;
  /**
   * Keep DRC ("stable volume") audio duplicates. By default a DRC format is dropped
   * when a non-DRC format with the same itag + audio track exists, because the two are
   * bit-for-bit the same ladder rung with different loudness normalisation and having
   * both in one AdaptationSet makes ABR audibly flip loudness mid-playback.
   */
  keepDrcDuplicates?: boolean;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Escape a value for use in XML text or a double-quoted attribute. */
export function xmlEscape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

/** ISO-8601 duration, always emitted as PT#H#M#S (fractional seconds trimmed). */
export function toIsoDuration(seconds: number): string {
  let s = num(seconds) ?? 0;
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s - h * 3600) / 60);
  const rem = s - h * 3600 - m * 60;
  let secStr = rem.toFixed(3);
  if (secStr.indexOf('.') !== -1) {
    secStr = secStr.replace(/0+$/, '').replace(/\.$/, '');
  }
  return `PT${h}H${m}M${secStr}S`;
}

export interface ParsedMime {
  /** e.g. "video/webm" */
  base: string;
  /** e.g. "video" */
  type: string;
  /** e.g. `vp09.00.51.08` (may be a comma list for muxed progressive formats) */
  codecs?: string;
}

export function parseMimeType(mimeType: unknown): ParsedMime | undefined {
  const s = str(mimeType);
  if (!s) return undefined;
  const semi = s.indexOf(';');
  const base = (semi === -1 ? s : s.slice(0, semi)).trim().toLowerCase();
  if (!base || base.indexOf('/') === -1) return undefined;
  let codecs: string | undefined;
  if (semi !== -1) {
    const m = /codecs\s*=\s*("([^"]*)"|'([^']*)'|([^;]*))/i.exec(s.slice(semi + 1));
    if (m) codecs = (m[2] ?? m[3] ?? m[4] ?? '').trim() || undefined;
  }
  return { base, type: base.split('/')[0], codecs };
}

function normRange(r: ByteRangeInput | null | undefined): string | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const start = num(r.start);
  const end = num(r.end);
  if (start === undefined || end === undefined) return undefined;
  if (start < 0 || end < start) return undefined;
  return `${start}-${end}`;
}

/**
 * Grouping key for the codec dimension of an AdaptationSet.
 *
 * Video: the codec family (avc1 / av01 / vp09) is enough — profile and level differ
 * per rung in every real ladder and MSE switches those cleanly.
 *
 * AAC: the object type is included (mp4a.40.2 AAC-LC vs mp4a.40.5 HE-AAC), because
 * those are different decoder configurations at different sample rates (44100 vs 22050
 * in the YouTube ladder) and mixing them in one AdaptationSet is a real switching hazard.
 */
function codecFamily(codecs: string | undefined, mimeBase: string): string {
  if (!codecs) return 'unknown';
  const first = codecs.split(',')[0].trim().toLowerCase();
  const parts = first.split('.');
  const family = parts[0];
  if (family === 'mp4a' && parts.length >= 3) return `${parts[0]}.${parts[1]}.${parts[2]}`;
  if (family) return family;
  return mimeBase;
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

interface NormalizedRepresentation {
  id: string;
  itag: string;
  contentType: 'video' | 'audio';
  mimeBase: string;
  codecs: string;
  codecKey: string;
  bandwidth: number;
  url: string;
  indexRange: string;
  initRange: string;
  width?: number;
  height?: number;
  frameRate?: number;
  audioSamplingRate?: number;
  audioChannels?: number;
  trackId?: string;
  trackLang?: string;
  trackLabel?: string;
  trackIsDefault: boolean;
  isDrc: boolean;
}

export interface SkippedFormat {
  itag: string;
  reason: string;
}

function normalizeFormats(
  formats: AdaptiveFormatInput[],
  opts: BuildDashOptions,
  skipped: SkippedFormat[],
): NormalizedRepresentation[] {
  const out: NormalizedRepresentation[] = [];
  const maxHeight = num(opts.maxHeight);

  for (const f of formats || []) {
    const itag = str(f?.itag) ?? '';
    const skip = (reason: string) => skipped.push({ itag: itag || '(no itag)', reason });

    if (!f || typeof f !== 'object') {
      skip('not an object');
      continue;
    }
    if (!itag) {
      skip('missing itag');
      continue;
    }
    const url = str(f.url);
    if (!url) {
      skip('missing url');
      continue;
    }
    const mime = parseMimeType(f.mimeType);
    if (!mime) {
      skip('unparseable mimeType');
      continue;
    }
    if (mime.type !== 'video' && mime.type !== 'audio') {
      skip(`unsupported mime type "${mime.base}"`);
      continue;
    }
    if (!mime.codecs) {
      skip('mimeType has no codecs parameter');
      continue;
    }
    const indexRange = normRange(f.indexRange);
    const initRange = normRange(f.initRange);
    if (!indexRange || !initRange) {
      skip(
        !indexRange && !initRange
          ? 'no initRange and no indexRange (not segment-indexable)'
          : !indexRange
            ? 'no indexRange (not segment-indexable)'
            : 'no initRange (not segment-indexable)',
      );
      continue;
    }

    // An audio-only mp4/webm can arrive tagged video/* only if YouTube changes shape;
    // decide contentType from the mime type, which is what shaka keys off.
    const contentType: 'video' | 'audio' = mime.type === 'video' ? 'video' : 'audio';

    const width = num(f.width);
    const height = num(f.height);
    if (contentType === 'video' && maxHeight !== undefined && height !== undefined && height > maxHeight) {
      skip(`height ${height} exceeds maxHeight ${maxHeight}`);
      continue;
    }

    const track = f.audioTrack && typeof f.audioTrack === 'object' ? f.audioTrack : undefined;
    const trackId = track ? str(track.id) : undefined;
    const trackIsDefault = track ? track.audioIsDefault === true : true;
    if (opts.disableAutoDubbed && track && !trackIsDefault) {
      skip(`non-default audio track "${trackId ?? ''}" (disableAutoDubbed)`);
      continue;
    }

    const bandwidth = num(f.bitrate) ?? num(f.averageBitrate);
    if (bandwidth === undefined || bandwidth <= 0) {
      skip('missing/invalid bitrate');
      continue;
    }

    out.push({
      id: itag,
      itag,
      contentType,
      mimeBase: mime.base,
      codecs: mime.codecs,
      codecKey: codecFamily(mime.codecs, mime.base),
      bandwidth: Math.round(bandwidth),
      url,
      indexRange,
      initRange,
      width,
      height,
      frameRate: contentType === 'video' ? num(f.fps) : undefined,
      audioSamplingRate: contentType === 'audio' ? num(f.audioSampleRate) : undefined,
      audioChannels: contentType === 'audio' ? (num(f.audioChannels) ?? 2) : undefined,
      trackId,
      trackLang: trackId ? trackId.split('.')[0] : undefined,
      trackLabel: track ? str(track.displayName) : undefined,
      trackIsDefault,
      isDrc: f.isDrc === true,
    });
  }

  return out;
}

/**
 * YouTube ships each audio itag twice: normal and DRC ("stable volume"). They are the
 * same rung, so keeping both gives an AdaptationSet with two identical-bandwidth
 * representations and audible loudness flapping during ABR. Prefer the non-DRC one.
 */
function dedupe(
  reps: NormalizedRepresentation[],
  keepDrc: boolean,
  skipped: SkippedFormat[],
): NormalizedRepresentation[] {
  const byKey = new Map<string, NormalizedRepresentation>();
  const order: string[] = [];

  for (const r of reps) {
    const key = keepDrc
      ? `${r.itag}|${r.trackId ?? ''}|${r.isDrc ? 'drc' : ''}`
      : `${r.itag}|${r.trackId ?? ''}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
      order.push(key);
      continue;
    }
    // Prefer non-DRC; then prefer the higher bandwidth rung.
    const preferNew =
      (existing.isDrc && !r.isDrc) ||
      (existing.isDrc === r.isDrc && r.bandwidth > existing.bandwidth);
    const loser = preferNew ? existing : r;
    skipped.push({
      itag: loser.itag,
      reason: loser.isDrc
        ? 'DRC (stable-volume) duplicate of the same itag'
        : 'duplicate itag/audio-track entry',
    });
    if (preferNew) byKey.set(key, r);
  }

  // Guarantee globally unique Representation@id (an MPD with duplicate ids breaks shaka).
  const used = new Set<string>();
  const result: NormalizedRepresentation[] = [];
  for (const key of order) {
    const r = byKey.get(key)!;
    let id = r.isDrc ? `${r.itag}-drc` : r.itag;
    if (r.trackId) id = `${id}-${r.trackId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    let candidate = id;
    let n = 2;
    while (used.has(candidate)) candidate = `${id}-${n++}`;
    used.add(candidate);
    result.push({ ...r, id: candidate });
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Adaptation set grouping
 * ------------------------------------------------------------------ */

interface AdaptationGroup {
  key: string;
  contentType: 'video' | 'audio';
  mimeBase: string;
  codecKey: string;
  lang?: string;
  label?: string;
  isDefaultTrack: boolean;
  reps: NormalizedRepresentation[];
}

function groupIntoAdaptationSets(reps: NormalizedRepresentation[]): AdaptationGroup[] {
  const groups = new Map<string, AdaptationGroup>();
  const order: string[] = [];

  for (const r of reps) {
    // Video and audio can never share an AdaptationSet; the contentType is part of
    // the key, and so is the (container, codec family, audio track) triple so that
    // everything inside one set is genuinely switchable.
    const key = [r.contentType, r.mimeBase, r.codecKey, r.contentType === 'audio' ? (r.trackId ?? '') : '']
      .join('|');
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        contentType: r.contentType,
        mimeBase: r.mimeBase,
        codecKey: r.codecKey,
        lang: r.contentType === 'audio' ? r.trackLang : undefined,
        label: r.contentType === 'audio' ? r.trackLabel : undefined,
        isDefaultTrack: r.trackIsDefault,
        reps: [],
      };
      groups.set(key, g);
      order.push(key);
    }
    if (r.trackIsDefault) g.isDefaultTrack = true;
    g.reps.push(r);
  }

  const list = order.map((k) => groups.get(k)!);
  for (const g of list) g.reps.sort((a, b) => a.bandwidth - b.bandwidth || a.id.localeCompare(b.id));

  // Deterministic set ordering: video first (tallest ladder first), then audio
  // (default track first).
  const maxH = (g: AdaptationGroup) => Math.max(0, ...g.reps.map((r) => r.height ?? 0));
  const maxBw = (g: AdaptationGroup) => Math.max(0, ...g.reps.map((r) => r.bandwidth));
  list.sort((a, b) => {
    if (a.contentType !== b.contentType) return a.contentType === 'video' ? -1 : 1;
    if (a.contentType === 'video') {
      return maxH(b) - maxH(a) || maxBw(b) - maxBw(a) || a.key.localeCompare(b.key);
    }
    if (a.isDefaultTrack !== b.isDefaultTrack) return a.isDefaultTrack ? -1 : 1;
    return (a.lang ?? '').localeCompare(b.lang ?? '') || maxBw(b) - maxBw(a) || a.key.localeCompare(b.key);
  });

  return list;
}

/* ------------------------------------------------------------------ *
 * XML emission
 * ------------------------------------------------------------------ */

function attrs(pairs: Array<[string, string | number | undefined]>): string {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${xmlEscape(v)}"`)
    .join('');
}

function renderRepresentation(r: NormalizedRepresentation, rewritten: string, indent: string): string {
  const lines: string[] = [];
  const head =
    `${indent}<Representation` +
    attrs([
      ['id', r.id],
      ['mimeType', r.mimeBase],
      ['codecs', r.codecs],
      ['bandwidth', r.bandwidth],
      ['width', r.width],
      ['height', r.height],
      ['frameRate', r.frameRate],
      ['audioSamplingRate', r.audioSamplingRate],
      ['startWithSAP', 1],
    ]) +
    '>';
  lines.push(head);
  // RepresentationBase descriptors must precede BaseURL / SegmentBase.
  if (r.contentType === 'audio') {
    lines.push(
      `${indent}  <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011"` +
        attrs([['value', r.audioChannels ?? 2]]) +
        '/>',
    );
  }
  lines.push(`${indent}  <BaseURL>${xmlEscape(rewritten)}</BaseURL>`);
  lines.push(`${indent}  <SegmentBase${attrs([['indexRange', r.indexRange]])}>`);
  lines.push(`${indent}    <Initialization${attrs([['range', r.initRange]])}/>`);
  lines.push(`${indent}  </SegmentBase>`);
  lines.push(`${indent}</Representation>`);
  return lines.join('\n');
}

function renderAdaptationSet(g: AdaptationGroup, id: number, rewrite: (u: string) => string): string {
  const indent = '    ';
  const lines: string[] = [];
  const heights = g.reps.map((r) => r.height).filter((h): h is number => h !== undefined);
  const widths = g.reps.map((r) => r.width).filter((w): w is number => w !== undefined);
  const rates = g.reps.map((r) => r.frameRate).filter((f): f is number => f !== undefined);

  lines.push(
    `${indent}<AdaptationSet` +
      attrs([
        ['id', id],
        ['contentType', g.contentType],
        ['mimeType', g.mimeBase],
        ['lang', g.lang],
        ['label', g.label],
        ['subsegmentAlignment', 'true'],
        ['segmentAlignment', 'true'],
        ['subsegmentStartsWithSAP', 1],
        ['startWithSAP', 1],
        ['maxWidth', widths.length ? Math.max(...widths) : undefined],
        ['maxHeight', heights.length ? Math.max(...heights) : undefined],
        ['maxFrameRate', rates.length ? Math.max(...rates) : undefined],
      ]) +
      '>',
  );
  lines.push(
    `${indent}  <Role schemeIdUri="urn:mpeg:dash:role:2011" value="${g.isDefaultTrack ? 'main' : 'alternate'}"/>`,
  );
  for (const r of g.reps) lines.push(renderRepresentation(r, rewrite(r.url), `${indent}  `));
  lines.push(`${indent}</AdaptationSet>`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export interface BuildDashResult {
  mpd: string;
  representationCount: number;
  adaptationSetCount: number;
  skipped: SkippedFormat[];
}

/** Build the MPD and also report what was dropped and why (useful for logging). */
export function buildDashManifestDetailed(
  formats: AdaptiveFormatInput[],
  opts: BuildDashOptions,
): BuildDashResult {
  if (!opts || typeof opts.rewriteUrl !== 'function') {
    throw new TypeError('buildDashManifest: opts.rewriteUrl must be a function');
  }
  const skipped: SkippedFormat[] = [];
  const normalized = normalizeFormats(Array.isArray(formats) ? formats : [], opts, skipped);
  const deduped = dedupe(normalized, opts.keepDrcDuplicates === true, skipped);
  const groups = groupIntoAdaptationSets(deduped);

  const rewrite = (u: string) => {
    const out = opts.rewriteUrl(u);
    return typeof out === 'string' && out.length ? out : u;
  };

  const duration = toIsoDuration(num(opts.durationSeconds) ?? 0);
  const minBuffer = toIsoDuration(num(opts.minBufferTimeSeconds) ?? 1.5);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push(
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ' xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd"' +
      ' profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"' +
      attrs([
        ['type', 'static'],
        ['mediaPresentationDuration', duration],
        ['minBufferTime', minBuffer],
      ]) +
      '>',
  );
  lines.push(`  <Period${attrs([['id', '0'], ['start', 'PT0S'], ['duration', duration]])}>`);
  groups.forEach((g, i) => lines.push(renderAdaptationSet(g, i, rewrite)));
  lines.push('  </Period>');
  lines.push('</MPD>');

  return {
    mpd: lines.join('\n') + '\n',
    representationCount: deduped.length,
    adaptationSetCount: groups.length,
    skipped,
  };
}

/** Build a static DASH MPD (XML string) from InnerTube adaptiveFormats. */
export function buildDashManifest(formats: AdaptiveFormatInput[], opts: BuildDashOptions): string {
  return buildDashManifestDetailed(formats, opts).mpd;
}

/* ------------------------------------------------------------------ *
 * Progressive (muxed) fallback for when MSE / DASH is unavailable
 * ------------------------------------------------------------------ */

export interface ProgressiveFallbackOptions {
  maxHeight?: number;
  /** Optional; applied to the returned url so the same proxy path can be reused. */
  rewriteUrl?: (url: string) => string;
}

export interface ProgressiveFallback {
  itag: string;
  url: string;
  mimeType: string;
  codecs?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  qualityLabel?: string;
  fps?: number;
}

/**
 * Pick the best muxed (video+audio in one file) stream for `<video src>` playback.
 * Prefers the tallest rendition within `maxHeight`, then the highest bitrate.
 * Returns null when nothing usable is present — InnerTube IOS responses frequently
 * omit `streamingData.formats` entirely, which is the case in both current fixtures.
 */
export function pickProgressiveFallback(
  formatStreams: AdaptiveFormatInput[] | null | undefined,
  opts?: ProgressiveFallbackOptions,
): ProgressiveFallback | null {
  const maxHeight = num(opts?.maxHeight);
  let best: ProgressiveFallback | null = null;

  for (const f of Array.isArray(formatStreams) ? formatStreams : []) {
    if (!f || typeof f !== 'object') continue;
    const url = str(f.url);
    if (!url) continue;
    const mime = parseMimeType(f.mimeType);
    if (!mime || mime.type !== 'video') continue;
    // Muxed streams carry two codecs; an adaptive video-only stream carries one.
    if (!mime.codecs || mime.codecs.split(',').length < 2) continue;

    const height = num(f.height);
    if (maxHeight !== undefined && height !== undefined && height > maxHeight) continue;

    const candidate: ProgressiveFallback = {
      itag: str(f.itag) ?? '',
      url,
      mimeType: mime.base,
      codecs: mime.codecs,
      width: num(f.width),
      height,
      bitrate: num(f.bitrate) ?? num(f.averageBitrate),
      qualityLabel: str(f.qualityLabel),
      fps: num(f.fps),
    };
    if (
      !best ||
      (candidate.height ?? 0) > (best.height ?? 0) ||
      ((candidate.height ?? 0) === (best.height ?? 0) && (candidate.bitrate ?? 0) > (best.bitrate ?? 0))
    ) {
      best = candidate;
    }
  }

  if (best && typeof opts?.rewriteUrl === 'function') {
    const rewritten = opts.rewriteUrl(best.url);
    if (typeof rewritten === 'string' && rewritten.length) best = { ...best, url: rewritten };
  }
  return best;
}
