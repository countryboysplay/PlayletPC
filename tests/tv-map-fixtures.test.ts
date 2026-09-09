/**
 * tv-map-fixtures.test.ts - Node-runnable, plain assertions, no test framework.
 *
 *   esbuild tests/tv-map-fixtures.test.ts --bundle --platform=node --format=esm \
 *     --outfile=node_modules/.cache/tv.mjs && node node_modules/.cache/tv.mjs
 *
 * Fixtures are SIGNED-IN TVHTML5 browse responses captured from a live account
 * (2026-09-09) and then sanitised: renderer structure is preserved byte-for-byte,
 * while ids, titles and channel names are replaced with synthetic values and the
 * tracking/playback blobs (which carried a public IP) are stripped.
 *
 * Every assertion below is against a value actually present in those fixtures.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  channelIdFromParams,
  mapSavedPlaylists,
  mapSubscribedChannels,
  mapTileVideo,
  mapTvPlaylist,
  mapTvVideoFeed,
} from '../src/lib/api/innertube-tv-map'

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures')
const load = (name: string): any => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))

let passed = 0
let failed = 0
const failures: string[] = []

function ok(cond: unknown, label: string, detail?: unknown): void {
  if (cond) {
    passed++
    console.log(`ok   ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`FAIL ${label}${detail !== undefined ? `  -> got ${JSON.stringify(detail)}` : ''}`)
  }
}

function eq(actual: unknown, expected: unknown, label: string): void {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} (expected ${JSON.stringify(expected)})`,
    actual,
  )
}

function section(name: string): void {
  console.log(`\n--- ${name} ---`)
}

const subs = load('subscriptions.tv.json')
const playlists = load('library.playlists.tv.json')

/* =================================================================== */
section('channelIdFromParams')
/* =================================================================== */

// The real blob shape, byte for byte (0x8a 0x03 <len> 0x0a 0x18 <24-char UCID>),
// carrying a synthetic channel id - the layout is what the parser has to handle, and
// a real one would publish whose subscriptions these fixtures came from.
eq(
  channelIdFromParams('igMaChhVQ3N5bnRoZXRpY0NoYW5uZWxJZDAwMDE%3D'),
  'UCsyntheticChannelId0001',
  'decodes the UCID out of a subscription tab params blob',
)
eq(channelIdFromParams(''), '', 'empty params -> empty string')
eq(channelIdFromParams(null), '', 'null params -> empty string')
eq(channelIdFromParams('not-base64!!!'), '', 'garbage params -> empty string')
eq(channelIdFromParams('aGVsbG8gd29ybGQ='), '', 'valid base64 with no UCID -> empty string')

/* =================================================================== */
section('subscription feed -> videos')
/* =================================================================== */

const feed = mapTvVideoFeed(subs)
eq(feed.length, 20, 'subscription feed maps 20 video tiles')
ok(
  feed.every((v) => typeof v.videoId === 'string' && v.videoId.length > 0),
  'every mapped video has a videoId',
)
ok(
  feed.every((v) => typeof v.title === 'string' && v.title.length > 0),
  'every mapped video has a title',
)
ok(
  feed.every((v) => v.videoThumbnails.length > 0),
  'every mapped video has at least one thumbnail',
)
ok(new Set(feed.map((v) => v.videoId)).size === feed.length, 'video ids are de-duplicated')

const first = feed[0]
eq(first?.videoId, 'VID00000000', 'first tile videoId')
eq(first?.title, 'Sample Video 1', 'first tile title')
eq(first?.author, 'Sample Channel 1', 'first tile author (metadata line 0)')
eq(first?.lengthSeconds, 297, 'first tile duration "4:57" -> 297s')
eq(first?.viewCount, 7, 'first tile viewCount from "7 views"')
eq(first?.viewCountText, '7 views', 'first tile viewCountText')
eq(first?.publishedText, '16 hours ago', 'first tile publishedText')
ok(typeof first?.published === 'number' && first.published > 0, 'first tile published resolves to a timestamp')
eq(first?.type, 'video', 'first tile type')

/* =================================================================== */
section('subscribed channels (the tab strip)')
/* =================================================================== */

const channels = mapSubscribedChannels(subs)
eq(channels.length, 6, 'six subscribed channels, de-duplicated across the A-Z repeat')
ok(
  channels.every((c) => /^UC[A-Za-z0-9_-]{22}$/.test(c.authorId)),
  'every channel has a well-formed UCID',
)
ok(
  channels.every((c) => c.author.length > 0),
  'every channel has a name',
)
ok(
  !channels.some((c) => ['All', 'A-Z', 'Shorts'].includes(c.author)),
  'navigation tabs (All / A-Z / Shorts) are not treated as channels',
)
ok(
  channels.every((c) => c.authorUrl === '/channel/' + c.authorId),
  'authorUrl is derived from the channel id',
)
ok(
  channels.some((c) => c.authorThumbnails.length > 0),
  'channel avatars are carried through',
)
eq(channels[0].type, 'channel', 'channel summaries are typed')

/* =================================================================== */
section('saved playlists')
/* =================================================================== */

const saved = mapSavedPlaylists(playlists)
eq(saved.length, 3, 'three saved playlists')
eq(saved.map((p) => p.playlistId), ['PL0000000000000000', 'WL', 'LL'], 'user playlists sort before WL/LL')
eq(saved[0].title, 'Sample Playlist 1', 'user playlist title')
eq(saved[0].videoCount, 4, 'user playlist count from "4 videos"')
eq(
  saved.find((p) => p.playlistId === 'WL')?.videoCount,
  0,
  '"No videos" maps to a count of 0, not NaN',
)
eq(saved.find((p) => p.playlistId === 'LL')?.title, 'Liked videos', 'Liked videos is kept')
eq(saved.find((p) => p.playlistId === 'LL')?.videoCount, 3, 'Liked videos count')
ok(
  saved.every((p) => p.type === 'playlist'),
  'playlist summaries are typed',
)

/* =================================================================== */
section('a video feed contains no playlist/channel tiles')
/* =================================================================== */

// FEplaylist_aggregation is all playlist tiles, so the video mapper must return none.
eq(mapTvVideoFeed(playlists).length, 0, 'playlist-only response yields no videos')
// ...and the subscription feed has no playlist tiles.
eq(mapSavedPlaylists(subs).length, 0, 'subscription feed yields no playlists')

/* =================================================================== */
section('playlist contents (private playlists need the TV client)')
/* =================================================================== */

// A TV playlist browse returns the same tileRenderer vocabulary, so the subscription
// fixture stands in for one here: what matters is that the tiles become videos and
// the count follows the list rather than being invented.
const asPlaylist = mapTvPlaylist(subs, 'PL0000000000000000', 'Fallback Title')
eq(asPlaylist.playlistId, 'PL0000000000000000', 'playlist id is carried through')
eq(asPlaylist.videos.length, 20, 'tiles become playlist videos')
eq(asPlaylist.videoCount, 20, 'videoCount follows the mapped list')
eq(asPlaylist.type, 'playlist', 'playlist details are typed')
ok(asPlaylist.videos.every(v => v.videoId && v.title), 'every playlist video has an id and title')
eq(
  mapTvPlaylist({}, 'PLX', 'Fallback Title').title,
  'Fallback Title',
  'a missing header falls back to the supplied title rather than inventing one',
)
eq(mapTvPlaylist({}, 'PLX').videos.length, 0, 'an empty response yields no videos')

/* =================================================================== */
section('malformed input is survivable')
/* =================================================================== */

const badInputs: unknown[] = [null, undefined, {}, [], '', 0, { contents: null }, { a: { b: { c: 1 } } }]
let allSafe = true
for (const bad of badInputs) {
  try {
    mapTvVideoFeed(bad)
    mapSubscribedChannels(bad)
    mapSavedPlaylists(bad)
    mapTileVideo(bad)
    mapTvPlaylist(bad, 'PLX')
  } catch (e) {
    allSafe = false
    console.log('  threw on', JSON.stringify(bad), String(e))
  }
}
ok(allSafe, 'no TV mapper throws on null/undefined/empty/garbage input')
eq(mapTvVideoFeed(null).length, 0, 'mapTvVideoFeed(null) -> []')
eq(mapSubscribedChannels(null).length, 0, 'mapSubscribedChannels(null) -> []')
eq(mapSavedPlaylists(null).length, 0, 'mapSavedPlaylists(null) -> []')
eq(mapTileVideo(null), null, 'mapTileVideo(null) -> null')
eq(
  mapTileVideo({ contentType: 'TILE_CONTENT_TYPE_PLAYLIST', contentId: 'PL1' }),
  null,
  'mapTileVideo ignores a playlist tile',
)
eq(
  mapTileVideo({ contentType: 'TILE_CONTENT_TYPE_VIDEO' }),
  null,
  'mapTileVideo ignores a video tile with no contentId',
)

/* =================================================================== */
console.log(`\n================================`)
console.log(`passed: ${passed}   failed: ${failed}   total: ${passed + failed}`)
if (failed) {
  console.log('failed assertions:')
  for (const f of failures) console.log('  - ' + f)
}
console.log(`================================`)
process.exit(failed ? 1 : 0)
