/**
 * innertube-tv-map.ts
 *
 * Maps TVHTML5 ("living room") browse responses onto the app's Invidious-ish shapes.
 *
 * Why a separate mapper: the TV surface does NOT use `videoRenderer` /
 * `gridVideoRenderer` / `playlistRenderer` like the WEB surface does. It uses its own
 * tile vocabulary, and `innertube-map.ts` does not understand a byte of it:
 *
 *   tileRenderer         one card. `contentType` says what it is
 *                        (TILE_CONTENT_TYPE_VIDEO / _PLAYLIST / _CHANNEL) and
 *                        `contentId` is the videoId / playlistId / browseId.
 *     header.tileHeaderRenderer     thumbnails + overlays (duration, "4 videos")
 *     metadata.tileMetadataRenderer title + `lines[]`
 *       lineRenderer.items[].lineItemRenderer.text
 *                        line 0 is the author; line 1 is "N views" + "x ago".
 *   tabRenderer          on FEsubscriptions, ONE TAB PER SUBSCRIBED CHANNEL. This is
 *                        where the account's subscription list actually lives - there
 *                        is no channel-list renderer in the feed body.
 *
 * Every shape here was read off a real signed-in response captured from a live
 * account (2026-09-09), not guessed. Sanitised copies are the fixtures
 * `tests/fixtures/subscriptions.tv.json` and `library.playlists.tv.json`; they keep
 * the renderer structure byte-for-byte and replace only ids, titles and channel names.
 *
 * These feeds REQUIRE the account token, and the token is only valid on the TV client
 * (see the note on `call()` in innertube.ts). Signed out they return nothing useful.
 */

import {
  extractThumbnails,
  fallbackVideoThumbnails,
  parseCompactNumber,
  parseDuration,
  parseRelativeTime,
  readText
} from './innertube-map'
import type {
  ChannelSummary,
  PlaylistDetails,
  PlaylistSummary,
  VideoSummary
} from './types'

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

const isObj = (v: Any): v is Record<string, Any> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Depth-first collect of every value stored under `key`. */
function findAll(node: Any, key: string, out: Any[] = [], depth = 0): Any[] {
  if (!node || typeof node !== 'object' || depth > 40) return out
  if (Array.isArray(node)) {
    for (const v of node) findAll(v, key, out, depth + 1)
    return out
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push(v)
    findAll(v, key, out, depth + 1)
  }
  return out
}

function findFirst(node: Any, key: string): Any {
  const all = findAll(node, key)
  return all.length > 0 ? all[0] : undefined
}

/**
 * A channel id hidden inside a base64 protobuf `params` blob.
 *
 * The per-channel subscription tabs carry no plain `browseId` - the channel is encoded
 * in `endpoint.browseEndpoint.params`, which decodes to a tiny protobuf whose only
 * useful field is the UCID. Pulling it out with a regex avoids a protobuf reader for
 * one field, and a miss is handled by the caller (the tab is skipped).
 */
export function channelIdFromParams(params: Any): string {
  if (typeof params !== 'string' || params.length === 0) return ''
  let decoded = ''
  try {
    const raw = decodeURIComponent(params)
    if (typeof atob === 'function') {
      decoded = atob(raw)
    } else {
      // Node (the fixture tests). Reached via globalThis so this module needs no
      // node typings and stays importable in the WebView build.
      const b = (globalThis as Any).Buffer
      if (!b) return ''
      decoded = b.from(raw, 'base64').toString('latin1')
    }
  } catch {
    return ''
  }
  const m = /UC[A-Za-z0-9_-]{22}/.exec(decoded)
  return m ? m[0] : ''
}

/** The `lineItemRenderer` texts of a tile's metadata, in document order. */
function metadataLines(tile: Any): string[][] {
  const meta = tile?.metadata?.tileMetadataRenderer
  if (!isObj(meta)) return []
  return (Array.isArray(meta.lines) ? meta.lines : []).map((line: Any) =>
    (findAll(line, 'lineItemRenderer') as Any[])
      .map((item) => readText(item?.text))
      .filter((t: string) => t.length > 0 && t !== '•')
  )
}

const LIVE_RE = /\b(live|watching)\b/i

/**
 * One TILE_CONTENT_TYPE_VIDEO tile -> VideoSummary.
 *
 * Returns null for anything that is not a playable video tile, so callers can map a
 * whole mixed feed and filter nulls.
 */
export function mapTileVideo(tile: Any): VideoSummary | null {
  if (!isObj(tile)) return null
  if (tile.contentType !== 'TILE_CONTENT_TYPE_VIDEO') return null
  const videoId = typeof tile.contentId === 'string' ? tile.contentId : ''
  if (!videoId) return null

  const title = readText(tile?.metadata?.tileMetadataRenderer?.title)
  const lines = metadataLines(tile)
  const author = lines[0]?.[0] ?? ''

  // Line 1 is "N views" and "x ago" as separate items, but a live tile reads
  // "N watching" and an upcoming one carries a date instead.
  const detail = lines[1] ?? []
  let viewCountText = ''
  let publishedText = ''
  for (const part of detail) {
    if (/view|watching/i.test(part)) viewCountText = part
    else if (/ago$/i.test(part)) publishedText = part
    else if (!publishedText) publishedText = part
  }

  const overlay = findFirst(tile?.header, 'thumbnailOverlayTimeStatusRenderer')
  const durationText = readText(overlay?.text)
  const live = LIVE_RE.test(durationText) || /watching/i.test(viewCountText)

  const thumbs = extractThumbnails(tile?.header)
  const out: VideoSummary = {
    type: 'video',
    title,
    videoId,
    author,
    // The tile does not carry the author's channel id. Callers that need it resolve
    // it from the subscription list; leaving it empty is honest, and the UI already
    // treats an empty authorId as "not linkable".
    authorId: '',
    videoThumbnails: thumbs.length > 0 ? thumbs : fallbackVideoThumbnails(videoId),
    viewCount: parseCompactNumber(viewCountText),
    lengthSeconds: live ? 0 : parseDuration(durationText)
  }
  if (viewCountText) out.viewCountText = viewCountText
  if (publishedText) {
    out.publishedText = publishedText
    const ts = parseRelativeTime(publishedText)
    if (ts) out.published = ts
  }
  if (live) out.liveNow = true
  return out
}

/** Every video tile in a TV browse response, in feed order. */
export function mapTvVideoFeed(json: Any): VideoSummary[] {
  const out: VideoSummary[] = []
  const seen = new Set<string>()
  for (const tile of findAll(json, 'tileRenderer')) {
    const v = mapTileVideo(tile)
    if (!v || seen.has(v.videoId)) continue
    seen.add(v.videoId)
    out.push(v)
  }
  return out
}

/**
 * The account's subscribed channels, read off the FEsubscriptions tab strip.
 *
 * The strip also contains navigation tabs ("All", "A-Z", "Shorts") and repeats the
 * channels in a second, alphabetised group; both are filtered out. A tab is only
 * treated as a channel if a UCID can actually be decoded from it.
 */
export function mapSubscribedChannels(json: Any): ChannelSummary[] {
  const out: ChannelSummary[] = []
  const seen = new Set<string>()

  for (const tab of findAll(json, 'tabRenderer')) {
    if (!isObj(tab)) continue
    const title = typeof tab.title === 'string' ? tab.title : readText(tab.title)
    if (!title) continue

    const browse = tab?.endpoint?.browseEndpoint
    if (!isObj(browse)) continue
    // A real channel tab points back at FEsubscriptions with the channel in `params`.
    const authorId =
      typeof browse.browseId === 'string' && browse.browseId.startsWith('UC')
        ? browse.browseId
        : channelIdFromParams(browse.params)
    if (!authorId || seen.has(authorId)) continue
    seen.add(authorId)

    const thumbs = extractThumbnails(tab.thumbnail)
    out.push({
      type: 'channel',
      author: title,
      authorId,
      authorUrl: '/channel/' + authorId,
      authorThumbnails: thumbs,
      subCount: 0,
      videoCount: 0
    })
  }
  return out
}

/** Playlist ids that are containers, not user-created playlists. */
const SYSTEM_PLAYLISTS = new Set(['WL', 'LL'])

/**
 * The account's saved playlists, from `FEplaylist_aggregation`.
 *
 * Watch Later (`WL`) and Liked Videos (`LL`) come back in the same list and are kept -
 * they are the two the user is most likely to want - but flagged via `playlistId` so
 * callers can order or label them.
 */
export function mapSavedPlaylists(json: Any): PlaylistSummary[] {
  const out: PlaylistSummary[] = []
  const seen = new Set<string>()

  for (const tile of findAll(json, 'tileRenderer')) {
    if (!isObj(tile)) continue
    if (tile.contentType !== 'TILE_CONTENT_TYPE_PLAYLIST') continue
    let playlistId = typeof tile.contentId === 'string' ? tile.contentId : ''
    if (!playlistId) {
      const browseId = findFirst(tile.onSelectCommand, 'browseId')
      // Playlist browse ids arrive prefixed with VL.
      if (typeof browseId === 'string' && browseId.startsWith('VL')) playlistId = browseId.slice(2)
    }
    if (!playlistId || seen.has(playlistId)) continue
    seen.add(playlistId)

    const title = readText(tile?.metadata?.tileMetadataRenderer?.title)
    // The count sits in the thumbnail overlay as "4 videos" / "No videos".
    const overlay = findFirst(tile?.header, 'thumbnailOverlayTimeStatusRenderer')
    const countText = readText(overlay?.text)
    const videoCount = /^no\b/i.test(countText) ? 0 : parseCompactNumber(countText)

    const thumbs = extractThumbnails(tile?.header)
    const entry: PlaylistSummary = {
      type: 'playlist',
      title,
      playlistId,
      author: '',
      authorId: '',
      videoCount
    }
    if (thumbs.length > 0) entry.playlistThumbnail = thumbs[thumbs.length - 1].url
    out.push(entry)
  }

  // User-created playlists first, then Watch later / Liked videos.
  return out.sort((a, b) => {
    const as = SYSTEM_PLAYLISTS.has(a.playlistId) ? 1 : 0
    const bs = SYSTEM_PLAYLISTS.has(b.playlistId) ? 1 : 0
    return as - bs
  })
}

/**
 * One playlist's contents, from a TV `browse` on `VL<playlistId>`.
 *
 * This exists because the account's own playlists - Watch Later, Liked Videos, and
 * anything the user made - are PRIVATE. The WEB client carries no account token (the
 * token is only valid on TV), so it cannot see them at all: it is not that the WEB
 * mapper reads them badly, it never gets a list to read. Signed in, the TV client
 * returns them in the same `tileRenderer` vocabulary as every other living-room
 * surface, so the video list reuses `mapTvVideoFeed` rather than a second parser.
 *
 * The title lookup is deliberately defensive - the header renderer around a TV
 * playlist has not been captured against a real account the way the tiles have, so a
 * miss falls back to the caller-supplied title instead of inventing one.
 */
export function mapTvPlaylist(
  json: Any,
  playlistId: string,
  fallbackTitle = ''
): PlaylistDetails {
  const videos = mapTvVideoFeed(json)

  let title = fallbackTitle
  for (const key of ['playlistHeaderRenderer', 'tvPlaylistHeaderRenderer', 'headerRenderer']) {
    const header = findFirst(json, key)
    const text = readText(header?.title)
    if (text) {
      title = text
      break
    }
  }

  return {
    type: 'playlist',
    title,
    playlistId,
    author: '',
    authorId: '',
    videoCount: videos.length,
    videos
  }
}
