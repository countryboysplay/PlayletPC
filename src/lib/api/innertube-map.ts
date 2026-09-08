/**
 * innertube-map.ts
 *
 * Maps YouTube InnerTube (/youtubei/v1/*) JSON onto the Invidious-shaped types
 * in ./types.ts, so a direct-YouTube backend can feed an Invidious-built UI.
 *
 * Pure functions only: no network, no imports beyond the type module.
 *
 * Written against real captured responses (2026-09). Shapes actually observed:
 *   player   (IOS)  : streamingData.adaptiveFormats only - NO progressive `formats`.
 *   search   (WEB)  : videoRenderer / channelRenderer; ads as searchPyvRenderer + adSlotRenderer.
 *   next     (WEB)  : secondaryResults.results = reelShelfRenderer + lockupViewModel[] + continuationItemRenderer.
 *   browse   (WEB)  : channel home = sectionListRenderer -> shelfRenderer -> lockupViewModel / gridChannelRenderer / postRenderer;
 *                     channel videos + home feed = richGridRenderer -> richItemRenderer -> lockupViewModel.
 * Classic compactVideoRenderer / gridVideoRenderer / playlistRenderer are still
 * handled because other surfaces and older clients emit them.
 */

import type {
  AdaptiveFormat,
  Caption,
  ChannelDetails,
  ChannelSummary,
  FormatStream,
  ImageRef,
  PlaylistDetails,
  PlaylistSummary,
  SearchResult,
  Storyboard,
  VideoDetails,
  VideoSummary,
} from './types'

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

/** Thrown by mapPlayerResponse when playabilityStatus.status !== 'OK'. */
export class PlayabilityError extends Error {
  readonly name = 'PlayabilityError'
  /** e.g. 'LOGIN_REQUIRED', 'UNPLAYABLE', 'ERROR', 'AGE_VERIFICATION_REQUIRED' */
  readonly status: string
  /** Human-readable reason from the response, when present. */
  readonly reason: string
  readonly subreason: string
  readonly videoId: string

  constructor(status: string, reason: string, subreason = '', videoId = '') {
    super(reason ? `${status}: ${reason}` : status)
    this.status = status
    this.reason = reason
    this.subreason = subreason
    this.videoId = videoId
  }
}

/* ------------------------------------------------------------------ */
/* tiny safe accessors                                                 */
/* ------------------------------------------------------------------ */

type Any = any

const isObj = (v: Any): v is Record<string, Any> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const arr = (v: Any): Any[] => (Array.isArray(v) ? v : [])

/** Follow a dotted path, returning undefined at the first missing hop. */
function get(root: Any, path: string): Any {
  let cur = root
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[seg]
  }
  return cur
}

/**
 * Flatten any InnerTube text node to a plain string.
 * Handles: "str", {simpleText}, {runs:[{text}]}, {content} (view-model text),
 * {text:{content}}, and accessibility wrappers.
 */
export function readText(node: Any): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(readText).join('')
  if (!isObj(node)) return ''
  if (typeof node.simpleText === 'string') return node.simpleText
  if (Array.isArray(node.runs)) return node.runs.map((r: Any) => (r && r.text) || '').join('')
  if (typeof node.content === 'string') return node.content
  if (isObj(node.text)) return readText(node.text)
  if (typeof node.text === 'string') return node.text
  if (isObj(node.dynamicTextViewModel)) return readText(node.dynamicTextViewModel.text)
  if (isObj(node.accessibility)) return readText(node.accessibility.accessibilityData?.label)
  if (typeof node.label === 'string') return node.label
  return ''
}

/** Naive but safe text -> HTML (escape, then linkify newlines). */
function toHtml(text: string): string {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
}

/* ------------------------------------------------------------------ */
/* exported parsing helpers                                            */
/* ------------------------------------------------------------------ */

const MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  million: 1e6,
  b: 1e9,
  billion: 1e9,
  t: 1e12,
  trillion: 1e12,
}

/**
 * "1.2M" -> 1200000, "23,387,323 views" -> 23387323,
 * "9.8 million views" -> 9800000, "1.25M subscribers" -> 1250000,
 * "144" -> 144, "No views" -> 0.
 */
export function parseCompactNumber(input: Any): number {
  const raw = typeof input === 'number' ? String(input) : readText(input)
  if (!raw) return 0
  const s = raw.toLowerCase().replace(/,/g, '').replace(/ /g, ' ')
  const m = s.match(/(\d+(?:\.\d+)?)\s*(thousand|million|billion|trillion|k|m|b|t)?/)
  if (!m) return 0
  const n = parseFloat(m[1])
  if (!isFinite(n)) return 0
  const suffix = m[2]
  if (!suffix) return Math.round(n)
  return Math.round(n * (MULTIPLIERS[suffix] ?? 1))
}

const UNIT_SECONDS: Array<[RegExp, number]> = [
  [/^(?:years?|yrs?|y)$/, 31_556_952], // 365.2425 d
  [/^(?:months?|mos?)$/, 2_629_746],
  [/^(?:weeks?|wks?|w)$/, 604_800],
  [/^(?:days?|d)$/, 86_400],
  [/^(?:hours?|hrs?|h)$/, 3_600],
  [/^(?:minutes?|mins?|m)$/, 60],
  [/^(?:seconds?|secs?|s)$/, 1],
]

/**
 * "3 days ago" / "11 years ago" / "9mo ago" / "5y ago" /
 * "Streamed 2 months ago" / "Premiered 4 hours ago"  ->  unix seconds.
 * Returns 0 when nothing parseable is present.
 * `now` (unix seconds) is injectable so callers/tests stay deterministic.
 */
export function parseRelativeTime(input: Any, now: number = Math.floor(Date.now() / 1000)): number {
  const raw = readText(input)
  if (!raw) return 0
  const s = raw.toLowerCase()
  const m = s.match(
    /(\d+)\s*(years?|yrs?|y|months?|mos?|weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/,
  )
  if (!m) return 0
  const n = parseInt(m[1], 10)
  const unit = m[2]
  for (const [re, secs] of UNIT_SECONDS) {
    if (re.test(unit)) return Math.max(0, Math.floor(now - n * secs))
  }
  return 0
}

/** "10:35" -> 635, "1:02:03" -> 3723, "635" -> 635, "LIVE"/"" -> 0. */
export function parseDuration(input: Any): number {
  if (typeof input === 'number' && isFinite(input)) return Math.max(0, Math.floor(input))
  const raw = readText(input).trim()
  if (!raw) return 0
  if (/^\d+$/.test(raw)) return parseInt(raw, 10)
  const m = raw.match(/(\d{1,3}:)?(\d{1,2}):(\d{2})/)
  if (!m) return 0
  const h = m[1] ? parseInt(m[1], 10) : 0
  const mm = parseInt(m[2], 10)
  const ss = parseInt(m[3], 10)
  return h * 3600 + mm * 60 + ss
}

function absoluteUrl(u: Any): string {
  if (typeof u !== 'string' || !u) return ''
  if (u.startsWith('//')) return 'https:' + u
  if (u.startsWith('/')) return 'https://www.youtube.com' + u
  return u
}

function qualityForWidth(w: number): string {
  if (w >= 1280) return 'maxresdefault'
  if (w >= 640) return 'sddefault'
  if (w >= 480) return 'high'
  if (w >= 320) return 'medium'
  return 'default'
}

/**
 * Thumbnail extractor. Accepts every container shape observed:
 *   {thumbnails:[{url,width,height}]}          classic renderers
 *   {sources:[{url,width,height}]}             *ViewModel images
 *   {image:{sources:[...]}}                    thumbnailViewModel / avatarViewModel
 *   {thumbnail:{thumbnails:[...]}}             nested classic
 *   {avatar:{...}} / {decoratedAvatarViewModel:{...}} / {imageBannerViewModel:{...}}
 *   a bare array of {url,width,height}
 * Entries without a usable url (e.g. clientResource icons) are dropped.
 */
export function extractThumbnails(node: Any): ImageRef[] {
  const list = collectImageEntries(node)
  const out: ImageRef[] = []
  const seen = new Set<string>()
  for (const e of list) {
    const url = absoluteUrl(e?.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    const width = Number(e.width) || 0
    const height = Number(e.height) || 0
    const ref: ImageRef = { url, width, height }
    if (width) ref.quality = qualityForWidth(width)
    out.push(ref)
  }
  return out.sort((a, b) => a.width - b.width)
}

function collectImageEntries(node: Any, depth = 0): Any[] {
  if (!node || depth > 6) return []
  if (Array.isArray(node)) {
    // a bare list of {url,...}
    if (node.some((x) => isObj(x) && typeof x.url === 'string')) return node.filter(isObj)
    return node.flatMap((x) => collectImageEntries(x, depth + 1))
  }
  if (!isObj(node)) return []
  if (Array.isArray(node.thumbnails)) return node.thumbnails.filter(isObj)
  if (Array.isArray(node.sources)) return node.sources.filter(isObj)
  if (typeof node.url === 'string') return [node]
  for (const key of [
    'image',
    'thumbnail',
    'avatar',
    'banner',
    'thumbnailViewModel',
    'avatarViewModel',
    'decoratedAvatarViewModel',
    'imageBannerViewModel',
    'contentImage',
    'movingThumbnailDetails',
    'movingThumbnailRenderer',
    'richThumbnail',
    'channelThumbnailWithLinkRenderer',
    'channelThumbnailSupportedRenderers',
    'thumbnails',
  ]) {
    if (node[key] !== undefined) {
      const r = collectImageEntries(node[key], depth + 1)
      if (r.length) return r
    }
  }
  return []
}

/** Canonical i.ytimg thumbnail ladder, used when a renderer carries none. */
export function fallbackVideoThumbnails(videoId: string): ImageRef[] {
  if (!videoId) return []
  const base = `https://i.ytimg.com/vi/${videoId}/`
  return [
    { url: base + 'default.jpg', width: 120, height: 90, quality: 'default' },
    { url: base + 'mqdefault.jpg', width: 320, height: 180, quality: 'medium' },
    { url: base + 'hqdefault.jpg', width: 480, height: 360, quality: 'high' },
    { url: base + 'sddefault.jpg', width: 640, height: 480, quality: 'sddefault' },
    { url: base + 'maxresdefault.jpg', width: 1280, height: 720, quality: 'maxresdefault' },
  ]
}

/* ------------------------------------------------------------------ */
/* generic tree walking                                                */
/* ------------------------------------------------------------------ */

/** Depth-limited search for the first value at any of `keys`. */
function findFirst(node: Any, keys: string[], depth = 0, maxDepth = 14): Any {
  if (!node || depth > maxDepth) return undefined
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = findFirst(x, keys, depth + 1, maxDepth)
      if (r !== undefined) return r
    }
    return undefined
  }
  if (!isObj(node)) return undefined
  for (const k of keys) if (node[k] !== undefined) return node[k]
  for (const k of Object.keys(node)) {
    const r = findFirst(node[k], keys, depth + 1, maxDepth)
    if (r !== undefined) return r
  }
  return undefined
}

/**
 * First `browseEndpoint.browseId` that looks like a channel id (UC...).
 * Depth 24 is required: on collaboration lockups the only channel id sits
 * ~18 levels down, inside the avatar stack's showDialogCommand -> dialogViewModel
 * -> listViewModel -> listItemViewModel -> browseEndpoint chain.
 */
function findChannelId(node: Any, depth = 0): string {
  if (!node || depth > 24) return ''
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = findChannelId(x, depth + 1)
      if (r) return r
    }
    return ''
  }
  if (!isObj(node)) return ''
  const direct = node.browseEndpoint?.browseId ?? node.channelId ?? node.browseId
  if (typeof direct === 'string' && /^UC[\w-]{20,24}$/.test(direct)) return direct
  for (const k of Object.keys(node)) {
    const r = findChannelId(node[k], depth + 1)
    if (r) return r
  }
  return ''
}

function findCanonicalBaseUrl(node: Any, depth = 0): string {
  if (!node || depth > 10) return ''
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = findCanonicalBaseUrl(x, depth + 1)
      if (r) return r
    }
    return ''
  }
  if (!isObj(node)) return ''
  if (typeof node.canonicalBaseUrl === 'string' && node.canonicalBaseUrl) return node.canonicalBaseUrl
  for (const k of Object.keys(node)) {
    const r = findCanonicalBaseUrl(node[k], depth + 1)
    if (r) return r
  }
  return ''
}

function channelUrl(authorId: string, canonical?: string): string {
  if (canonical) return absoluteUrl(canonical)
  return authorId ? `https://www.youtube.com/channel/${authorId}` : ''
}

/** Pull the continuation token out of any container that holds one. */
export function extractContinuation(node: Any): string | undefined {
  const token = findFirst(node, ['token'], 0, 8)
  if (typeof token === 'string' && token) return token
  const ci = findFirst(node, ['continuationItemRenderer'], 0, 8)
  if (ci) {
    const t =
      get(ci, 'continuationEndpoint.continuationCommand.token') ??
      get(ci, 'button.buttonRenderer.command.continuationCommand.token')
    if (typeof t === 'string' && t) return t
  }
  return undefined
}

/* Renderer keys we deliberately never map (ads, promos, chrome). */
const SKIP_KEYS = new Set([
  'adSlotRenderer',
  'searchPyvRenderer',
  'promotedVideoRenderer',
  'promotedSparklesWebRenderer',
  'promotedSparklesTextSearchRenderer',
  'displayAdRenderer',
  'inFeedAdLayoutRenderer',
  'adsControlFlowOpportunityReceivedCommand',
  'compactPromotedVideoRenderer',
  'carouselAdRenderer',
  'statementBannerRenderer',
  'messageRenderer',
  'backgroundPromoRenderer',
  'feedNudgeRenderer',
  'emergencyOneboxRenderer',
  'didYouMeanRenderer',
  'showingResultsForRenderer',
  'horizontalCardListRenderer',
  'universalWatchCardRenderer',
  'infoPanelContentRenderer',
  'clarificationRenderer',
  'postRenderer',
  'backstagePostThreadRenderer',
  'channelVideoPlayerRenderer',
  'continuationItemRenderer',
  'itemSectionHeaderRenderer',
])

/* ------------------------------------------------------------------ */
/* item mappers                                                        */
/* ------------------------------------------------------------------ */

interface ItemCtx {
  /** Fallback author for surfaces where the item omits it (channel tabs). */
  author?: string
  authorId?: string
  authorUrl?: string
  now?: number
}

const LIVE_RE = /\b(live now|watching now|watching)\b/i

function badgeLabels(node: Any): string[] {
  const out: string[] = []
  for (const b of arr(node)) {
    const label = get(b, 'metadataBadgeRenderer.label') ?? get(b, 'metadataBadgeRenderer.style')
    if (typeof label === 'string') out.push(label)
  }
  return out
}

/** videoRenderer / compactVideoRenderer / gridVideoRenderer / playlistVideoRenderer */
export function mapVideoRenderer(vr: Any, ctx: ItemCtx = {}): VideoSummary | null {
  if (!isObj(vr)) return null
  const videoId: string = typeof vr.videoId === 'string' ? vr.videoId : ''
  if (!videoId) return null

  const bylineNode = vr.ownerText ?? vr.longBylineText ?? vr.shortBylineText
  const author = readText(bylineNode) || ctx.author || ''
  const authorId =
    findChannelId(vr.ownerText) ||
    findChannelId(vr.longBylineText) ||
    findChannelId(vr.shortBylineText) ||
    findChannelId(vr.channelThumbnailSupportedRenderers) ||
    ctx.authorId ||
    ''
  const canonical =
    findCanonicalBaseUrl(vr.ownerText) ||
    findCanonicalBaseUrl(vr.longBylineText) ||
    findCanonicalBaseUrl(vr.shortBylineText)

  let thumbs = extractThumbnails(vr.thumbnail)
  if (!thumbs.length) thumbs = fallbackVideoThumbnails(videoId)

  const viewCountText = readText(vr.viewCountText) || readText(vr.shortViewCountText)
  const publishedText = readText(vr.publishedTimeText)
  const overlayTime = findFirst(vr.thumbnailOverlays, ['thumbnailOverlayTimeStatusRenderer'], 0, 4)
  const lengthText = readText(vr.lengthText) || readText(overlayTime?.text)

  const badges = [...badgeLabels(vr.badges), ...badgeLabels(vr.ownerBadges)].join(' ')
  const liveNow =
    /LIVE/i.test(String(overlayTime?.style ?? '')) ||
    /BADGE_STYLE_TYPE_LIVE/i.test(badges) ||
    LIVE_RE.test(viewCountText)

  const description =
    readText(get(vr, 'detailedMetadataSnippets.0.snippetText')) ||
    readText(vr.descriptionSnippet) ||
    ''

  const isUpcoming = Boolean(vr.upcomingEventData) || /upcoming/i.test(badges)
  const premiereTimestamp = Number(get(vr, 'upcomingEventData.startTime')) || undefined

  const out: VideoSummary = {
    type: 'video',
    title: readText(vr.title),
    videoId,
    author,
    authorId,
    authorUrl: channelUrl(authorId, canonical) || ctx.authorUrl,
    videoThumbnails: thumbs,
    viewCount: parseCompactNumber(viewCountText),
    lengthSeconds: liveNow ? 0 : parseDuration(lengthText),
    liveNow,
    isUpcoming,
  }
  if (viewCountText) out.viewCountText = viewCountText
  if (publishedText) {
    out.publishedText = publishedText
    out.published = parseRelativeTime(publishedText, ctx.now)
  }
  if (description) {
    out.description = description
    out.descriptionHtml = toHtml(description)
  }
  if (/premium|members only/i.test(badges)) out.premium = true
  if (premiereTimestamp) out.premiereTimestamp = premiereTimestamp
  return out
}

interface MetaPart {
  content: string
  a11y: string
}

function lockupMetadataParts(lock: Any): MetaPart[] {
  const rows = arr(
    get(lock, 'metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows'),
  )
  const parts: MetaPart[] = []
  for (const row of rows) {
    for (const p of arr(row?.metadataParts)) {
      const content = readText(p?.text)
      const a11y = typeof p?.accessibilityLabel === 'string' ? p.accessibilityLabel : ''
      if (content || a11y) parts.push({ content, a11y })
    }
  }
  return parts
}

/**
 * lockupViewModel -> VideoSummary.
 * Row layouts observed:
 *   /next  : [[author]] , [[ "9.8M" (a11y "9.8 million views"), "9mo ago" ]]
 *   /browse: [[ "522K views", "1 month ago" ]]           (author is the page channel)
 */
export function mapLockupViewModel(lock: Any, ctx: ItemCtx = {}): VideoSummary | PlaylistSummary | null {
  if (!isObj(lock)) return null
  const contentId: string = typeof lock.contentId === 'string' ? lock.contentId : ''
  if (!contentId) return null
  const contentType = String(lock.contentType ?? '')

  if (/PLAYLIST|ALBUM|PODCAST/.test(contentType)) {
    return mapLockupPlaylist(lock, contentId, ctx)
  }
  if (contentType && !/VIDEO|SHORT|MOVIE|EPISODE/.test(contentType)) return null

  const meta = get(lock, 'metadata.lockupMetadataViewModel')
  const title = readText(meta?.title)
  const parts = lockupMetadataParts(lock)

  let viewCountText = ''
  let publishedText = ''
  let author = ''
  for (const p of parts) {
    const both = `${p.a11y} ${p.content}`
    if (!viewCountText && /\bviews?\b|\bwatching\b/i.test(both)) {
      viewCountText = /\bviews?\b|\bwatching\b/i.test(p.a11y) ? p.a11y : p.content
      continue
    }
    if (!publishedText && /\bago\b|\bstreamed\b|\bpremiered\b/i.test(both)) {
      publishedText = p.content || p.a11y
      continue
    }
    if (!author && p.content && !/\bviews?\b|\bago\b|^\d+(\.\d+)?[KMB]?$/i.test(p.content)) {
      author = p.content
    }
  }

  // duration badge lives on the thumbnail overlay
  let lengthText = ''
  const overlays = arr(get(lock, 'contentImage.thumbnailViewModel.overlays'))
  for (const o of overlays) {
    for (const b of arr(get(o, 'thumbnailBottomOverlayViewModel.badges'))) {
      const t = readText(get(b, 'thumbnailBadgeViewModel.text'))
      if (/^\d{1,3}:\d{2}(:\d{2})?$/.test(t)) lengthText = t
    }
  }
  const liveNow = LIVE_RE.test(viewCountText) || overlays.some((o) => /LIVE/i.test(JSON.stringify(o?.thumbnailBottomOverlayViewModel?.badges ?? '')))

  let thumbs = extractThumbnails(get(lock, 'contentImage.thumbnailViewModel.image'))
  if (!thumbs.length) thumbs = fallbackVideoThumbnails(contentId)

  const authorId = findChannelId(meta?.image) || ctx.authorId || ''

  const out: VideoSummary = {
    type: 'video',
    title,
    videoId: contentId,
    author: author || ctx.author || '',
    authorId,
    authorUrl: channelUrl(authorId) || ctx.authorUrl,
    videoThumbnails: thumbs,
    viewCount: parseCompactNumber(viewCountText),
    lengthSeconds: parseDuration(lengthText),
    liveNow,
  }
  if (viewCountText) out.viewCountText = viewCountText
  if (publishedText) {
    out.publishedText = publishedText
    out.published = parseRelativeTime(publishedText, ctx.now)
  }
  return out
}

function mapLockupPlaylist(lock: Any, playlistId: string, ctx: ItemCtx): PlaylistSummary {
  const meta = get(lock, 'metadata.lockupMetadataViewModel')
  const parts = lockupMetadataParts(lock)
  let videoCount = 0
  let author = ''
  for (const p of parts) {
    if (!videoCount && /\bvideos?\b|\bepisodes?\b/i.test(`${p.a11y} ${p.content}`)) {
      videoCount = parseCompactNumber(p.content || p.a11y)
      continue
    }
    if (!author && p.content && !/\bviews?\b|\bago\b/i.test(p.content)) author = p.content
  }
  const overlayCount = findFirst(get(lock, 'contentImage'), ['thumbnailOverlayBadgeViewModel'], 0, 6)
  if (!videoCount && overlayCount) videoCount = parseCompactNumber(readText(findFirst(overlayCount, ['text'], 0, 4)))
  const thumbs = extractThumbnails(get(lock, 'contentImage'))
  const authorId = findChannelId(meta?.image) || ctx.authorId || ''
  return {
    type: 'playlist',
    title: readText(meta?.title),
    playlistId,
    author: author || ctx.author || '',
    authorId,
    authorUrl: channelUrl(authorId) || ctx.authorUrl,
    playlistThumbnail: thumbs[thumbs.length - 1]?.url,
    videoCount,
    videos: [],
  }
}

/** shortsLockupViewModel / reelItemRenderer -> VideoSummary (type 'shortVideo'). */
export function mapShortsLockup(s: Any, ctx: ItemCtx = {}): VideoSummary | null {
  if (!isObj(s)) return null
  let videoId: string =
    get(s, 'onTap.innertubeCommand.reelWatchEndpoint.videoId') ??
    get(s, 'navigationEndpoint.reelWatchEndpoint.videoId') ??
    s.videoId ??
    ''
  if (!videoId && typeof s.entityId === 'string') {
    const m = s.entityId.match(/([\w-]{11})$/)
    if (m) videoId = m[1]
  }
  if (!videoId) return null

  const title =
    readText(get(s, 'overlayMetadata.primaryText')) ||
    readText(s.headline) ||
    readText(s.title) ||
    ''
  const viewCountText =
    readText(get(s, 'overlayMetadata.secondaryText')) || readText(s.viewCountText) || ''

  let thumbs = extractThumbnails(get(s, 'thumbnailViewModel.image'))
  if (!thumbs.length) thumbs = extractThumbnails(get(s, 'onTap.innertubeCommand.reelWatchEndpoint.thumbnail'))
  if (!thumbs.length) thumbs = extractThumbnails(s.thumbnail)
  if (!thumbs.length) thumbs = fallbackVideoThumbnails(videoId)

  const out: VideoSummary = {
    type: 'shortVideo',
    title,
    videoId,
    author: ctx.author || '',
    authorId: ctx.authorId || '',
    videoThumbnails: thumbs,
    viewCount: parseCompactNumber(viewCountText),
    lengthSeconds: 0,
  }
  if (ctx.authorUrl) out.authorUrl = ctx.authorUrl
  if (viewCountText) out.viewCountText = viewCountText
  return out
}

/**
 * channelRenderer / gridChannelRenderer -> ChannelSummary.
 *
 * NOTE (real 2026 WEB search): channelRenderer swaps the two count fields -
 * `videoCountText` carries "1.25M subscribers" and `subscriberCountText`
 * carries the "@handle". We therefore classify by TEXT, never by field name.
 */
export function mapChannelRenderer(cr: Any): ChannelSummary | null {
  if (!isObj(cr)) return null
  const authorId: string =
    (typeof cr.channelId === 'string' && cr.channelId) || findChannelId(cr.navigationEndpoint) || ''
  if (!authorId) return null

  const candidates: string[] = []
  for (const key of ['videoCountText', 'subscriberCountText', 'subscriberCountTextV2']) {
    const n = cr[key]
    if (!n) continue
    candidates.push(readText(n))
    const a11y = get(n, 'accessibility.accessibilityData.label')
    if (typeof a11y === 'string') candidates.push(a11y)
  }
  let subCount = 0
  let videoCount = 0
  for (const c of candidates) {
    if (!subCount && /subscriber/i.test(c)) subCount = parseCompactNumber(c)
    if (!videoCount && /\bvideos?\b/i.test(c)) videoCount = parseCompactNumber(c)
  }

  const description = readText(cr.descriptionSnippet)
  const canonical = findCanonicalBaseUrl(cr.navigationEndpoint)
  const out: ChannelSummary = {
    type: 'channel',
    author: readText(cr.title),
    authorId,
    authorUrl: channelUrl(authorId, canonical),
    authorThumbnails: extractThumbnails(cr.thumbnail),
    subCount,
    videoCount,
  }
  if (description) {
    out.description = description
    out.descriptionHtml = toHtml(description)
  }
  return out
}

/** playlistRenderer / gridPlaylistRenderer -> PlaylistSummary. */
export function mapPlaylistRenderer(pr: Any, ctx: ItemCtx = {}): PlaylistSummary | null {
  if (!isObj(pr)) return null
  const playlistId: string = pr.playlistId ?? ''
  if (!playlistId) return null
  const authorId = findChannelId(pr.longBylineText ?? pr.shortBylineText) || ctx.authorId || ''
  const thumbs = extractThumbnails(pr.thumbnails ?? pr.thumbnail ?? pr.thumbnailRenderer)
  return {
    type: 'playlist',
    title: readText(pr.title),
    playlistId,
    author: readText(pr.longBylineText ?? pr.shortBylineText) || ctx.author || '',
    authorId,
    authorUrl: channelUrl(authorId) || ctx.authorUrl,
    playlistThumbnail: thumbs[thumbs.length - 1]?.url,
    videoCount: parseCompactNumber(pr.videoCount ?? pr.videoCountText ?? pr.videoCountShortText),
    videos: arr(pr.videos)
      .map((v) => mapVideoRenderer(v?.childVideoRenderer ?? v, ctx))
      .filter((v): v is VideoSummary => v !== null),
  }
}

/**
 * Dispatch one feed item (the `{someRenderer: {...}}` wrapper) to a mapper.
 * Unknown / ad / chrome renderers yield [] rather than throwing.
 * Shelves expand into their children.
 */
function mapFeedItem(item: Any, ctx: ItemCtx = {}, depth = 0): SearchResult[] {
  if (!isObj(item) || depth > 4) return []
  const out: SearchResult[] = []
  for (const key of Object.keys(item)) {
    const node = item[key]
    if (SKIP_KEYS.has(key)) continue
    try {
      switch (key) {
        case 'videoRenderer':
        case 'compactVideoRenderer':
        case 'gridVideoRenderer':
        case 'playlistVideoRenderer':
        case 'videoWithContextRenderer':
        case 'movieRenderer': {
          const v = mapVideoRenderer(node, ctx)
          if (v) out.push(v)
          break
        }
        case 'lockupViewModel': {
          const v = mapLockupViewModel(node, ctx)
          if (v) out.push(v)
          break
        }
        case 'shortsLockupViewModel':
        case 'reelItemRenderer': {
          const v = mapShortsLockup(node, ctx)
          if (v) out.push(v)
          break
        }
        case 'channelRenderer':
        case 'gridChannelRenderer': {
          const c = mapChannelRenderer(node)
          if (c) out.push(c)
          break
        }
        case 'playlistRenderer':
        case 'gridPlaylistRenderer':
        case 'compactPlaylistRenderer': {
          const p = mapPlaylistRenderer(node, ctx)
          if (p) out.push(p)
          break
        }
        case 'richItemRenderer':
          out.push(...mapFeedItem(node?.content, ctx, depth + 1))
          break
        case 'richSectionRenderer':
          out.push(...mapFeedItem(node?.content, ctx, depth + 1))
          break
        case 'richShelfRenderer':
        case 'reelShelfRenderer':
        case 'shelfRenderer':
        case 'gridRenderer':
        case 'horizontalListRenderer':
        case 'expandedShelfContentsRenderer':
        case 'itemSectionRenderer':
        case 'horizontalCardListRenderer': {
          const kids =
            arr(node?.contents).length ? arr(node?.contents) : arr(node?.items)
          const inner =
            kids.length
              ? kids
              : [
                  ...arr(get(node, 'content.horizontalListRenderer.items')),
                  ...arr(get(node, 'content.expandedShelfContentsRenderer.items')),
                  ...arr(get(node, 'content.gridRenderer.items')),
                  ...arr(get(node, 'content.verticalListRenderer.items')),
                ]
          for (const kid of inner) out.push(...mapFeedItem(kid, ctx, depth + 1))
          break
        }
        default:
          break
      }
    } catch {
      // one malformed item must never break the list
    }
  }
  return out
}

/** Exported for reuse: map an arbitrary array of feed items defensively. */
export function mapFeedItems(items: Any, ctx: ItemCtx = {}): SearchResult[] {
  return arr(items).flatMap((i) => mapFeedItem(i, ctx))
}

const onlyVideos = (rs: SearchResult[]): VideoSummary[] =>
  rs.filter((r): r is VideoSummary => r.type === 'video' || r.type === 'shortVideo')

/* ------------------------------------------------------------------ */
/* player                                                              */
/* ------------------------------------------------------------------ */

function splitRange(r: Any): string | undefined {
  if (!isObj(r)) return undefined
  const { start, end } = r
  if (start === undefined || end === undefined) return undefined
  return `${start}-${end}`
}

function containerOf(mimeType: string): string {
  const m = mimeType.match(/^[a-z]+\/([\w.+-]+)/i)
  if (!m) return ''
  return m[1] === 'mp4' ? 'mp4' : m[1]
}

function encodingOf(mimeType: string): string {
  const m = mimeType.match(/codecs="([^"]+)"/i)
  if (!m) return ''
  const first = m[1].split(',')[0].trim().toLowerCase()
  if (first.startsWith('vp09') || first.startsWith('vp9')) return 'vp9'
  if (first.startsWith('vp8')) return 'vp8'
  if (first.startsWith('av01')) return 'av01'
  if (first.startsWith('avc1') || first.startsWith('avc3')) return 'h264'
  if (first.startsWith('hvc1') || first.startsWith('hev1')) return 'h265'
  if (first.startsWith('mp4a')) return 'aac'
  if (first.startsWith('opus')) return 'opus'
  if (first.startsWith('vorbis')) return 'vorbis'
  if (first.startsWith('ec-3') || first.startsWith('ac-3')) return 'ac3'
  return first
}

function resolutionOf(qualityLabel: string): string {
  const m = qualityLabel.match(/^(\d+p)/)
  return m ? m[1] : ''
}

function mapAdaptive(f: Any): AdaptiveFormat | null {
  if (!isObj(f) || typeof f.url !== 'string' || !f.url) return null
  const mimeType = String(f.mimeType ?? '')
  const qualityLabel = String(f.qualityLabel ?? '')
  const out: AdaptiveFormat = {
    url: f.url,
    itag: String(f.itag ?? ''),
    type: mimeType,
    bitrate: String(f.bitrate ?? f.averageBitrate ?? ''),
  }
  const init = splitRange(f.initRange)
  const index = splitRange(f.indexRange)
  if (init) out.init = init
  if (index) out.index = index
  if (f.contentLength !== undefined) out.clen = String(f.contentLength)
  if (f.lastModified !== undefined) out.lmt = String(f.lastModified)
  if (f.projectionType) out.projectionType = String(f.projectionType)
  const container = containerOf(mimeType)
  const encoding = encodingOf(mimeType)
  if (container) out.container = container
  if (encoding) out.encoding = encoding
  if (qualityLabel) {
    out.qualityLabel = qualityLabel
    const res = resolutionOf(qualityLabel)
    if (res) out.resolution = res
  }
  if (f.fps !== undefined) out.fps = Number(f.fps) || undefined
  if (f.audioQuality) out.audioQuality = String(f.audioQuality)
  if (f.audioSampleRate !== undefined) out.audioSampleRate = Number(f.audioSampleRate) || undefined
  if (f.audioChannels !== undefined) out.audioChannels = Number(f.audioChannels) || undefined
  if (isObj(f.audioTrack)) {
    out.audioTrack = {
      id: f.audioTrack.id,
      displayName: f.audioTrack.displayName,
      audioIsDefault: f.audioTrack.audioIsDefault,
    }
  }
  return out
}

function mapProgressive(f: Any): FormatStream | null {
  if (!isObj(f) || typeof f.url !== 'string' || !f.url) return null
  const mimeType = String(f.mimeType ?? '')
  const qualityLabel = String(f.qualityLabel ?? '')
  const out: FormatStream = {
    url: f.url,
    itag: String(f.itag ?? ''),
    type: mimeType,
    quality: String(f.quality ?? ''),
  }
  const container = containerOf(mimeType)
  const encoding = encodingOf(mimeType)
  if (container) out.container = container
  if (encoding) out.encoding = encoding
  if (qualityLabel) {
    out.qualityLabel = qualityLabel
    const res = resolutionOf(qualityLabel)
    if (res) out.resolution = res
  }
  if (f.width && f.height) out.size = `${f.width}x${f.height}`
  if (f.fps !== undefined) out.fps = Number(f.fps) || undefined
  if (f.bitrate !== undefined) out.bitrate = String(f.bitrate)
  return out
}

/** captions.playerCaptionsTracklistRenderer.captionTracks -> Caption[] */
export function mapCaptions(json: Any): Caption[] {
  const tracks = arr(get(json, 'captions.playerCaptionsTracklistRenderer.captionTracks'))
  const out: Caption[] = []
  for (const t of tracks) {
    const url = typeof t?.baseUrl === 'string' ? t.baseUrl : ''
    if (!url) continue
    out.push({
      label: readText(t.name) || String(t.languageCode ?? ''),
      language_code: String(t.languageCode ?? ''),
      url: absoluteUrl(url),
    })
  }
  return out
}

function mapStoryboards(json: Any): Storyboard[] {
  const spec = get(json, 'storyboards.playerStoryboardSpecRenderer.spec')
  if (typeof spec !== 'string' || !spec) return []
  const parts = spec.split('|')
  const base = parts.shift() ?? ''
  const out: Storyboard[] = []
  parts.forEach((p, level) => {
    const f = p.split('#')
    if (f.length < 8) return
    const [w, h, count, sw, sh, interval] = f.slice(0, 6).map((x) => parseInt(x, 10) || 0)
    const sigh = f[7]
    const url = base
      .replace('$L', String(level))
      .replace('$N', f[6] || 'M$M')
      .concat(`&sigh=${sigh}`)
    const perSheet = sw * sh || 1
    out.push({
      url,
      templateUrl: base,
      width: w,
      height: h,
      count,
      interval,
      storyboardWidth: sw,
      storyboardHeight: sh,
      storyboardCount: Math.ceil(count / perSheet),
    })
  })
  return out
}

/**
 * /youtubei/v1/player -> VideoDetails.
 * Throws PlayabilityError when playabilityStatus.status is not OK/LIVE_STREAM_OFFLINE.
 */
export function mapPlayerResponse(json: Any, ctx: ItemCtx = {}): VideoDetails {
  const status = String(get(json, 'playabilityStatus.status') ?? 'ERROR')
  const vd = get(json, 'videoDetails') ?? {}
  const videoId = String(vd.videoId ?? get(json, 'currentVideoEndpoint.watchEndpoint.videoId') ?? '')

  if (status !== 'OK' && status !== 'LIVE_STREAM_OFFLINE') {
    const reason =
      readText(get(json, 'playabilityStatus.reason')) ||
      readText(get(json, 'playabilityStatus.errorScreen.playerErrorMessageRenderer.reason')) ||
      readText(get(json, 'playabilityStatus.messages')) ||
      ''
    const subreason =
      readText(get(json, 'playabilityStatus.errorScreen.playerErrorMessageRenderer.subreason')) ||
      readText(get(json, 'playabilityStatus.errorScreen.playerLegacyDesktopYpcTrailerRenderer.subreason')) ||
      ''
    throw new PlayabilityError(status, reason, subreason, videoId)
  }

  const sd = get(json, 'streamingData') ?? {}
  const adaptiveFormats = arr(sd.adaptiveFormats)
    .map(mapAdaptive)
    .filter((f): f is AdaptiveFormat => f !== null)
  const formatStreams = arr(sd.formats)
    .map(mapProgressive)
    .filter((f): f is FormatStream => f !== null)

  const mf = get(json, 'microformat.playerMicroformatRenderer') ?? {}
  const publishDate = typeof mf.publishDate === 'string' ? mf.publishDate : ''
  const published = publishDate ? Math.floor(new Date(publishDate).getTime() / 1000) || 0 : 0

  const description = String(vd.shortDescription ?? readText(mf.description) ?? '')
  const authorId = String(vd.channelId ?? mf.externalChannelId ?? '')
  const lengthSeconds = parseDuration(vd.lengthSeconds ?? mf.lengthSeconds)

  let thumbs = extractThumbnails(vd.thumbnail)
  if (!thumbs.length) thumbs = extractThumbnails(mf.thumbnail)
  if (!thumbs.length) thumbs = fallbackVideoThumbnails(videoId)

  const liveNow = vd.isLive === true || get(mf, 'liveBroadcastDetails.isLiveNow') === true
  const isUpcoming = vd.isUpcoming === true || Boolean(mf.liveBroadcastDetails?.startTimestamp && !liveNow && vd.isUpcoming)

  const out: VideoDetails = {
    type: 'video',
    title: String(vd.title ?? readText(mf.title) ?? ''),
    videoId,
    videoThumbnails: thumbs,
    description,
    descriptionHtml: toHtml(description),
    published,
    publishedText: publishDate,
    keywords: arr(vd.keywords).filter((k) => typeof k === 'string'),
    viewCount: parseCompactNumber(vd.viewCount ?? mf.viewCount),
    likeCount: 0,
    dislikeCount: 0,
    paid: false,
    premium: false,
    isFamilyFriendly: mf.isFamilySafe !== false,
    author: String(vd.author ?? readText(mf.ownerChannelName) ?? ''),
    authorId,
    authorUrl: channelUrl(authorId, mf.ownerProfileUrl),
    lengthSeconds,
    allowRatings: vd.allowRatings !== false,
    rating: Number(vd.averageRating) || 0,
    isListed: mf.isUnlisted !== true,
    liveNow: Boolean(liveNow),
    isUpcoming: Boolean(isUpcoming),
    adaptiveFormats,
    formatStreams,
    captions: mapCaptions(json),
    recommendedVideos: [],
  }

  const storyboards = mapStoryboards(json)
  if (storyboards.length) out.storyboards = storyboards
  if (typeof sd.hlsManifestUrl === 'string' && sd.hlsManifestUrl) out.hlsUrl = sd.hlsManifestUrl
  if (typeof sd.dashManifestUrl === 'string' && sd.dashManifestUrl) out.dashUrl = sd.dashManifestUrl
  if (Array.isArray(mf.availableCountries)) out.allowedRegions = mf.availableCountries
  if (mf.category) out.genre = String(mf.category)
  if (ctx.author && !out.author) out.author = ctx.author
  return out
}

/* ------------------------------------------------------------------ */
/* search                                                              */
/* ------------------------------------------------------------------ */

/** /youtubei/v1/search -> SearchResult[]. Ads and unmappable shelves are dropped. */
export function mapSearchResults(json: Any, ctx: ItemCtx = {}): SearchResult[] {
  const sections =
    arr(get(json, 'contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents')) ||
    []
  let items: Any[] = []
  for (const sec of sections) {
    if (sec?.itemSectionRenderer) items.push(...arr(sec.itemSectionRenderer.contents))
    else if (sec?.richItemRenderer || sec?.richSectionRenderer) items.push(sec)
  }
  if (!items.length) {
    // continuation-shaped search response
    items = continuationItems(json)
  }
  return mapFeedItems(items, ctx)
}

/** Convenience: the continuation token for the next page of search results. */
export function searchContinuation(json: Any): string | undefined {
  const sections = arr(
    get(json, 'contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents'),
  )
  for (const sec of sections) {
    if (sec?.continuationItemRenderer) return extractContinuation(sec.continuationItemRenderer)
  }
  return extractContinuation(json)
}

/* ------------------------------------------------------------------ */
/* recommendations (/next)                                             */
/* ------------------------------------------------------------------ */

/** /youtubei/v1/next -> VideoSummary[] (the "up next" rail). */
export function mapRecommendations(json: Any, ctx: ItemCtx = {}): VideoSummary[] {
  let results = arr(
    get(json, 'contents.twoColumnWatchNextResults.secondaryResults.secondaryResults.results'),
  )
  if (!results.length) {
    // mobile / continuation shapes
    results = arr(get(json, 'contents.singleColumnWatchNextResults.results.results.contents'))
  }
  if (!results.length) results = continuationItems(json)
  return onlyVideos(mapFeedItems(results, ctx))
}

/* ------------------------------------------------------------------ */
/* channel                                                             */
/* ------------------------------------------------------------------ */

function browseTabs(json: Any): Any[] {
  return arr(get(json, 'contents.twoColumnBrowseResultsRenderer.tabs'))
}

function selectedTab(json: Any): Any {
  const tabs = browseTabs(json)
  const sel = tabs.find((t) => t?.tabRenderer?.selected || t?.expandableTabRenderer?.selected)
  return sel?.tabRenderer ?? sel?.expandableTabRenderer ?? tabs[0]?.tabRenderer
}

function tabItems(tab: Any): Any[] {
  if (!tab) return []
  const grid = get(tab, 'content.richGridRenderer')
  if (grid) return arr(grid.contents)
  const sections = arr(get(tab, 'content.sectionListRenderer.contents'))
  const out: Any[] = []
  for (const sec of sections) {
    if (sec?.itemSectionRenderer) out.push(...arr(sec.itemSectionRenderer.contents))
    else out.push(sec)
  }
  return out
}

function headerMetaParts(node: Any): MetaPart[] {
  const rows = arr(get(node, 'metadata.contentMetadataViewModel.metadataRows'))
  const out: MetaPart[] = []
  for (const row of rows) {
    for (const p of arr(row?.metadataParts)) {
      out.push({
        content: readText(p?.text),
        a11y: typeof p?.accessibilityLabel === 'string' ? p.accessibilityLabel : '',
      })
    }
  }
  return out
}

/** /youtubei/v1/browse (channel) -> ChannelDetails. */
export function mapChannel(json: Any, ctx: ItemCtx = {}): ChannelDetails {
  const cm = get(json, 'metadata.channelMetadataRenderer') ?? {}
  const micro = get(json, 'microformat.microformatDataRenderer') ?? {}
  const pv =
    get(json, 'header.pageHeaderRenderer.content.pageHeaderViewModel') ??
    get(json, 'header.c4TabbedHeaderRenderer') ??
    {}

  const authorId =
    String(cm.externalId ?? '') ||
    String(pv.channelId ?? '') ||
    (String(micro.urlCanonical ?? '').match(/channel\/(UC[\w-]+)/)?.[1] ?? '') ||
    findChannelId(get(json, 'header')) ||
    ctx.authorId ||
    ''

  const author =
    readText(pv.title) ||
    String(cm.title ?? '') ||
    String(get(json, 'header.pageHeaderRenderer.pageTitle') ?? '') ||
    ''

  // subscriber / video counts: classify by text, not by field name
  const parts = headerMetaParts(pv)
  let subCount = 0
  let videoCount = 0
  for (const p of parts) {
    const both = `${p.a11y} ${p.content}`
    if (!subCount && /subscriber/i.test(both)) subCount = parseCompactNumber(/subscriber/i.test(p.a11y) ? p.a11y : p.content)
    if (!videoCount && /\bvideos?\b/i.test(both)) videoCount = parseCompactNumber(p.content || p.a11y)
  }
  if (!subCount) subCount = parseCompactNumber(readText(pv.subscriberCountText))
  if (!videoCount) videoCount = parseCompactNumber(readText(pv.videosCountText))

  let authorThumbnails = extractThumbnails(pv.image)
  if (!authorThumbnails.length) authorThumbnails = extractThumbnails(cm.avatar)
  if (!authorThumbnails.length) authorThumbnails = extractThumbnails(micro.thumbnail)
  if (!authorThumbnails.length) authorThumbnails = extractThumbnails(pv.avatar)

  let authorBanners = extractThumbnails(pv.banner)
  if (!authorBanners.length) authorBanners = extractThumbnails(get(json, 'header.c4TabbedHeaderRenderer.banner'))

  const description =
    readText(get(pv, 'description.descriptionPreviewViewModel.description')) ||
    String(cm.description ?? '') ||
    String(micro.description ?? '')

  const ownerUrl = arr(cm.ownerUrls)[0]
  const authorUrl =
    (typeof ownerUrl === 'string' && ownerUrl) ||
    (typeof cm.channelUrl === 'string' && cm.channelUrl) ||
    channelUrl(authorId)

  const tabs = browseTabs(json)
    .map((t) => readText(get(t, 'tabRenderer.title') ?? get(t, 'expandableTabRenderer.title')))
    .filter(Boolean)

  const itemCtx: ItemCtx = { author, authorId, authorUrl, now: ctx.now }
  const mapped = mapFeedItems(tabItems(selectedTab(json)), itemCtx)

  const out: ChannelDetails = {
    type: 'channel',
    author,
    authorId,
    authorUrl,
    authorThumbnails,
    authorBanners,
    subCount,
    videoCount,
    description,
    descriptionHtml: toHtml(description),
    tabs,
    latestVideos: onlyVideos(mapped),
    relatedChannels: mapped.filter((r): r is ChannelSummary => r.type === 'channel'),
  }
  if (cm.isFamilySafe !== undefined) out.isFamilyFriendly = Boolean(cm.isFamilySafe)
  if (Array.isArray(cm.availableCountryCodes)) out.allowedRegions = cm.availableCountryCodes
  return out
}

/** /youtubei/v1/browse (channel Videos tab) -> videos + continuation. */
export function mapChannelVideos(
  json: Any,
  ctx: ItemCtx = {},
): { videos: VideoSummary[]; continuation?: string } {
  const cm = get(json, 'metadata.channelMetadataRenderer') ?? {}
  const authorId = String(cm.externalId ?? '') || ctx.authorId || ''
  const itemCtx: ItemCtx = {
    author: ctx.author || String(cm.title ?? ''),
    authorId,
    authorUrl: ctx.authorUrl || (typeof cm.channelUrl === 'string' ? cm.channelUrl : channelUrl(authorId)),
    now: ctx.now,
  }

  const tab = selectedTab(json)
  let items = tabItems(tab)
  if (!items.length) items = continuationItems(json)

  const videos = onlyVideos(mapFeedItems(items, itemCtx))

  let continuation: string | undefined
  for (const it of items) {
    if (it?.continuationItemRenderer) {
      continuation = extractContinuation(it.continuationItemRenderer)
      break
    }
  }
  if (!continuation) continuation = extractContinuation(get(tab, 'content.richGridRenderer'))
  return continuation ? { videos, continuation } : { videos }
}

/* ------------------------------------------------------------------ */
/* home feed                                                           */
/* ------------------------------------------------------------------ */

/**
 * /youtubei/v1/browse browseId=FEwhat_to_watch -> VideoSummary[].
 * A signed-out client can legitimately get an EMPTY feed (feedNudgeRenderer:
 * "Try searching to get started") - that maps to [], not an error.
 */
export function mapHomeFeed(json: Any, ctx: ItemCtx = {}): VideoSummary[] {
  const tab = selectedTab(json)
  let items = tabItems(tab)
  if (!items.length) items = continuationItems(json)
  return onlyVideos(mapFeedItems(items, ctx))
}

/* ------------------------------------------------------------------ */
/* playlist                                                            */
/* ------------------------------------------------------------------ */

/**
 * /youtubei/v1/browse browseId=VL<playlistId> -> PlaylistDetails.
 * A deleted/private playlist comes back with only `alerts` and no `contents`;
 * that yields an empty PlaylistDetails rather than an exception.
 */
export function mapPlaylist(json: Any, ctx: ItemCtx = {}): PlaylistDetails {
  const header =
    get(json, 'header.playlistHeaderRenderer') ??
    get(json, 'header.pageHeaderRenderer.content.pageHeaderViewModel') ??
    {}
  const micro = get(json, 'microformat.microformatDataRenderer') ?? {}

  const prefetchBrowseId = String(
    get(json, 'responseContext.webResponseContextExtensionData.webPrefetchData.navigationEndpoints.0.browseEndpoint.browseId') ?? '',
  ).replace(/^VL/, '')
  const playlistId =
    String(header.playlistId ?? '') ||
    (String(micro.urlCanonical ?? '').match(/[?&]list=([\w-]+)/)?.[1] ?? '') ||
    prefetchBrowseId ||
    ''

  // videos: classic playlistVideoListRenderer, or a richGrid of lockups
  const listItems: Any[] = []
  const tab = selectedTab(json)
  for (const it of tabItems(tab)) {
    if (it?.playlistVideoListRenderer) listItems.push(...arr(it.playlistVideoListRenderer.contents))
    else listItems.push(it)
  }
  if (!listItems.length) {
    const plv = findFirst(get(json, 'contents'), ['playlistVideoListRenderer'], 0, 8)
    if (plv) listItems.push(...arr(plv.contents))
  }
  if (!listItems.length) listItems.push(...continuationItems(json))

  const bylineAuthorId =
    findChannelId(header.ownerText ?? header.ownerEndpoint) || ctx.authorId || ''
  const author =
    readText(header.ownerText) ||
    readText(get(header, 'metadata.contentMetadataViewModel.metadataRows.0.metadataParts.0.text')) ||
    ctx.author ||
    ''

  const itemCtx: ItemCtx = { author, authorId: bylineAuthorId, now: ctx.now }
  const videos = onlyVideos(mapFeedItems(listItems, itemCtx))

  const title = readText(header.title) || String(micro.title ?? '')
  const description = readText(header.descriptionText) || String(micro.description ?? '')
  const stats = arr(header.stats).map(readText)
  const videoCount =
    parseCompactNumber(stats.find((s) => /\bvideos?\b/i.test(s))) ||
    parseCompactNumber(readText(header.numVideosText)) ||
    videos.length
  const viewCount = parseCompactNumber(stats.find((s) => /\bviews?\b/i.test(s)))

  const out: PlaylistDetails = {
    type: 'playlist',
    title,
    playlistId,
    author,
    authorId: bylineAuthorId,
    authorUrl: channelUrl(bylineAuthorId),
    playlistThumbnail:
      extractThumbnails(header.playlistHeaderBanner ?? header.thumbnail ?? micro.thumbnail).slice(-1)[0]?.url,
    videoCount,
    videos,
    description,
    descriptionHtml: toHtml(description),
    viewCount,
    isListed: micro.noindex !== true,
  }
  return out
}

/** Error text from an `alerts` block, if the response is an error page. */
export function responseAlert(json: Any): { type: string; text: string } | undefined {
  for (const a of arr(get(json, 'alerts'))) {
    const r = a?.alertRenderer ?? a?.alertWithButtonRenderer
    if (!r) continue
    return { type: String(r.type ?? 'ERROR'), text: readText(r.text) }
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* continuations                                                       */
/* ------------------------------------------------------------------ */

function continuationItems(json: Any): Any[] {
  const buckets = [
    ...arr(get(json, 'onResponseReceivedActions')),
    ...arr(get(json, 'onResponseReceivedEndpoints')),
    ...arr(get(json, 'onResponseReceivedCommands')),
    ...arr(get(json, 'continuationContents')),
  ]
  const out: Any[] = []
  for (const b of buckets) {
    out.push(
      ...arr(get(b, 'appendContinuationItemsAction.continuationItems')),
      ...arr(get(b, 'reloadContinuationItemsCommand.continuationItems')),
    )
  }
  if (!out.length) {
    const cc = get(json, 'continuationContents')
    if (isObj(cc)) {
      for (const k of Object.keys(cc)) {
        out.push(...arr(cc[k]?.contents), ...arr(cc[k]?.items), ...arr(cc[k]?.continuationItems))
      }
    }
  }
  return out
}

/**
 * Any continuation response -> raw items + next token.
 * `items` stays `unknown[]` per the target signature; feed it to
 * mapFeedItems() (or mapRecommendations/mapChannelVideos) to type it.
 */
export function mapContinuation(json: Any): { items: unknown[]; continuation?: string } {
  const items = continuationItems(json)
  let continuation: string | undefined
  for (const it of items) {
    if (it?.continuationItemRenderer) {
      continuation = extractContinuation(it.continuationItemRenderer)
      break
    }
  }
  const kept = items.filter((i) => !i?.continuationItemRenderer)
  return continuation ? { items: kept, continuation } : { items: kept }
}

/** Map continuation items straight to SearchResult[] (videos/channels/playlists). */
export function mapContinuationItems(json: Any, ctx: ItemCtx = {}): SearchResult[] {
  return mapFeedItems(mapContinuation(json).items, ctx)
}
