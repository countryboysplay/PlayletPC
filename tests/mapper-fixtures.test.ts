/**
 * innertube-map.test.ts - Node-runnable, plain assertions, no test framework.
 *
 *   esbuild innertube-map.test.ts --bundle --platform=node --format=esm --outfile=map.test.mjs
 *   node map.test.mjs
 *
 * Every assertion is against a value actually observed in the captured
 * fixtures (2026-09-08).
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  PlayabilityError,
  extractThumbnails,
  mapCaptions,
  mapChannel,
  mapChannelVideos,
  mapContinuation,
  mapHomeFeed,
  mapPlayerResponse,
  mapPlaylist,
  mapRecommendations,
  mapSearchResults,
  parseCompactNumber,
  parseDuration,
  parseRelativeTime,
  responseAlert,
  searchContinuation,
} from '../src/lib/api/innertube-map'

const FIXTURES =
  path.join(process.cwd(), 'tests', 'fixtures')

const load = (name: string): any =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))

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

const isHttps = (u: unknown) => typeof u === 'string' && u.startsWith('https://')

/* =================================================================== */
section('helpers')
/* =================================================================== */

eq(parseCompactNumber('1.2M'), 1_200_000, 'parseCompactNumber("1.2M")')
eq(parseCompactNumber('23,387,323 views'), 23_387_323, 'parseCompactNumber("23,387,323 views")')
eq(parseCompactNumber('9.8 million views'), 9_800_000, 'parseCompactNumber("9.8 million views")')
eq(parseCompactNumber('1.25M subscribers'), 1_250_000, 'parseCompactNumber("1.25M subscribers")')
eq(parseCompactNumber('87.4K subscribers'), 87_400, 'parseCompactNumber("87.4K subscribers")')
eq(parseCompactNumber('1.4K videos'), 1_400, 'parseCompactNumber("1.4K videos")')
eq(parseCompactNumber('144 videos'), 144, 'parseCompactNumber("144 videos")')
eq(parseCompactNumber('59K views'), 59_000, 'parseCompactNumber("59K views")')
eq(parseCompactNumber('No views'), 0, 'parseCompactNumber("No views")')
eq(parseCompactNumber(undefined), 0, 'parseCompactNumber(undefined)')

eq(parseDuration('10:35'), 635, 'parseDuration("10:35")')
eq(parseDuration('1:02:03'), 3723, 'parseDuration("1:02:03")')
eq(parseDuration('1:50'), 110, 'parseDuration("1:50")')
eq(parseDuration('635'), 635, 'parseDuration("635") [player lengthSeconds string]')
eq(parseDuration(''), 0, 'parseDuration("")')
eq(parseDuration(null), 0, 'parseDuration(null)')

const NOW = 1_757_000_000
eq(parseRelativeTime('3 days ago', NOW), NOW - 3 * 86400, 'parseRelativeTime("3 days ago")')
eq(parseRelativeTime('1 month ago', NOW), NOW - 2_629_746, 'parseRelativeTime("1 month ago")')
eq(parseRelativeTime('9mo ago', NOW), NOW - 9 * 2_629_746, 'parseRelativeTime("9mo ago")')
eq(parseRelativeTime('5y ago', NOW), NOW - 5 * 31_556_952, 'parseRelativeTime("5y ago")')
eq(parseRelativeTime('11 years ago', NOW), NOW - 11 * 31_556_952, 'parseRelativeTime("11 years ago")')
eq(parseRelativeTime('Streamed 2 hours ago', NOW), NOW - 7200, 'parseRelativeTime("Streamed 2 hours ago")')
eq(parseRelativeTime('gibberish', NOW), 0, 'parseRelativeTime("gibberish")')

const thumbs = extractThumbnails({
  thumbnails: [
    { url: '//yt3.googleusercontent.com/x=s176', width: 176, height: 176 },
    { url: 'https://i.ytimg.com/vi/a/hq720.jpg', width: 720, height: 404 },
  ],
})
eq(thumbs.length, 2, 'extractThumbnails count')
eq(thumbs[0].url, 'https://yt3.googleusercontent.com/x=s176', 'extractThumbnails upgrades //-relative to https')
ok(thumbs[0].width === 176 && thumbs[1].width === 720, 'extractThumbnails sorted ascending by width')
eq(extractThumbnails({ sources: [{ url: 'https://a/b.jpg', width: 68, height: 68 }] })[0].width, 68, 'extractThumbnails reads viewModel `sources`')
eq(extractThumbnails(undefined).length, 0, 'extractThumbnails(undefined) -> []')

/* =================================================================== */
section('player.ios.json  (aqz-KE-bpKQ, Big Buck Bunny, no captions)')
/* =================================================================== */

const playerJson = load('player.ios.json')
const player = mapPlayerResponse(playerJson)

eq(player.type, 'video', 'player.type')
eq(player.videoId, 'aqz-KE-bpKQ', 'player.videoId')
eq(player.title, 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film', 'player.title')
eq(player.author, 'Blender', 'player.author')
eq(player.authorId, 'UCSMOQeBJ2RAnuFungnQOxLg', 'player.authorId')
eq(player.authorUrl, 'https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg', 'player.authorUrl')
eq(player.lengthSeconds, 635, 'player.lengthSeconds parsed from "635" string to NUMBER')
ok(typeof player.lengthSeconds === 'number', 'player.lengthSeconds is a number', typeof player.lengthSeconds)
eq(player.viewCount, 23_387_323, 'player.viewCount parsed to NUMBER')
ok(typeof player.viewCount === 'number', 'player.viewCount is a number', typeof player.viewCount)
ok(player.description.includes('Big Buck Bunny'), 'player.description carries shortDescription')
ok(player.descriptionHtml.includes('<br>'), 'player.descriptionHtml converts newlines')
ok((player.keywords ?? []).includes('blender'), 'player.keywords includes "blender"', player.keywords)
eq(player.liveNow, false, 'player.liveNow')
eq(player.isUpcoming, false, 'player.isUpcoming')
eq(player.allowRatings, true, 'player.allowRatings')
eq(player.captions.length, 0, 'player has 0 captions (fixture has none)')
ok(player.videoThumbnails.length >= 2, 'player.videoThumbnails >= 2', player.videoThumbnails.length)
ok(player.videoThumbnails.every((t) => isHttps(t.url)), 'every videoThumbnail url is https')

// streams: the IOS client returned adaptiveFormats ONLY (no progressive `formats`)
ok(player.adaptiveFormats.length > 20, `player maps >20 adaptiveFormats (got ${player.adaptiveFormats.length})`)
eq(player.adaptiveFormats.length, 32, 'player.adaptiveFormats count == 32')
eq(player.formatStreams.length, 0, 'player.formatStreams == 0 (IOS response has no progressive formats)')
ok(
  player.adaptiveFormats.every((f) => f.url.startsWith('https://') && f.url.includes('googlevideo.com/videoplayback')),
  'every adaptiveFormat has a real googlevideo URL',
)
ok(player.adaptiveFormats.every((f) => f.itag !== '' && typeof f.itag === 'string'), 'every adaptiveFormat itag is a non-empty string')
ok(player.adaptiveFormats.every((f) => f.type.includes('/')), 'every adaptiveFormat type is a mimeType')

const f315 = player.adaptiveFormats.find((f) => f.itag === '315')!
ok(!!f315, 'adaptiveFormat itag 315 present')
eq(f315.qualityLabel, '2160p60', 'itag 315 qualityLabel')
eq(f315.resolution, '2160p', 'itag 315 resolution')
eq(f315.fps, 60, 'itag 315 fps')
eq(f315.container, 'webm', 'itag 315 container')
eq(f315.encoding, 'vp9', 'itag 315 encoding')
eq(f315.bitrate, '26523399', 'itag 315 bitrate')
eq(f315.clen, '1362269481', 'itag 315 clen')
eq(f315.init, '0-219', 'itag 315 init range')
eq(f315.index, '220-2421', 'itag 315 index range')
eq(f315.lmt, '1719206982841760', 'itag 315 lmt')

const f139 = player.adaptiveFormats.find((f) => f.itag === '139')!
eq(f139.audioQuality, 'AUDIO_QUALITY_LOW', 'itag 139 audioQuality')
eq(f139.audioSampleRate, 22050, 'itag 139 audioSampleRate is a NUMBER')
eq(f139.audioChannels, 2, 'itag 139 audioChannels')
eq(f139.container, 'mp4', 'itag 139 container')
eq(f139.encoding, 'aac', 'itag 139 encoding')

const audioCount = player.adaptiveFormats.filter((f) => f.audioQuality).length
ok(audioCount >= 8, `player has >=8 audio-only formats (got ${audioCount})`)
const videoCount = player.adaptiveFormats.filter((f) => f.qualityLabel).length
ok(videoCount >= 20, `player has >=20 video-only formats (got ${videoCount})`)

eq(player.hlsUrl, undefined, 'player.hlsUrl absent (no hlsManifestUrl in this fixture)')
ok((player.storyboards ?? []).length > 0, 'player.storyboards parsed from playerStoryboardSpecRenderer', (player.storyboards ?? []).length)
ok(isHttps(player.storyboards?.[0].url ?? ''), 'storyboard url is https')

/* =================================================================== */
section('player.ios.captions.json  (dQw4w9WgXcQ, 6 caption tracks, HLS)')
/* =================================================================== */

const capJson = load('player.ios.captions.json')
const cap = mapPlayerResponse(capJson)

eq(cap.videoId, 'dQw4w9WgXcQ', 'captions player videoId')
eq(cap.lengthSeconds, 213, 'captions player lengthSeconds')
eq(cap.viewCount, 1_813_392_310, 'captions player viewCount (1.81B)')
eq(cap.adaptiveFormats.length, 27, 'captions player adaptiveFormats == 27')
ok(cap.adaptiveFormats.length > 20, 'captions player maps >20 formats')
ok(
  cap.adaptiveFormats.every((f) => f.url.includes('googlevideo.com/videoplayback')),
  'every captions-player format has a real URL',
)
ok(
  isHttps(cap.hlsUrl ?? '') && (cap.hlsUrl ?? '').includes('manifest.googlevideo.com/api/manifest/hls_variant'),
  'hlsManifestUrl -> hlsUrl',
  cap.hlsUrl?.slice(0, 60),
)

eq(cap.captions.length, 6, 'exactly 6 caption tracks')
eq(
  cap.captions.map((c) => c.language_code),
  ['en', 'en', 'de-DE', 'ja', 'pt-BR', 'es-419'],
  'caption language_code list (snake_case field)',
)
eq(cap.captions[0].label, 'English', 'caption[0].label')
eq(cap.captions[1].label, 'English (auto-generated)', 'caption[1].label')
eq(cap.captions[2].label, 'German (Germany)', 'caption[2].label')
ok(
  cap.captions.every((c) => c.url.startsWith('https://www.youtube.com/api/timedtext')),
  'every caption url is a timedtext endpoint',
)
ok(
  cap.captions.every((c) => Object.prototype.hasOwnProperty.call(c, 'language_code')),
  'Caption uses snake_case `language_code`',
)
eq(mapCaptions({}).length, 0, 'mapCaptions({}) -> [] (no throw)')

/* --- playabilityStatus != OK throws a typed error ------------------- */
const blocked = JSON.parse(JSON.stringify(playerJson))
blocked.playabilityStatus = {
  status: 'LOGIN_REQUIRED',
  reason: 'Sign in to confirm your age',
  errorScreen: { playerErrorMessageRenderer: { subreason: { runs: [{ text: 'This video may be inappropriate for some users.' }] } } },
}
let caught: unknown = null
try {
  mapPlayerResponse(blocked)
} catch (e) {
  caught = e
}
ok(caught instanceof PlayabilityError, 'non-OK playabilityStatus throws PlayabilityError')
eq((caught as PlayabilityError).status, 'LOGIN_REQUIRED', 'PlayabilityError.status')
eq((caught as PlayabilityError).reason, 'Sign in to confirm your age', 'PlayabilityError.reason')
eq((caught as PlayabilityError).subreason, 'This video may be inappropriate for some users.', 'PlayabilityError.subreason')
eq((caught as PlayabilityError).videoId, 'aqz-KE-bpKQ', 'PlayabilityError.videoId')

// missing streamingData entirely must NOT throw
const stripped = JSON.parse(JSON.stringify(playerJson))
delete stripped.streamingData
delete stripped.videoDetails
let survived = true
let strippedOut: any = null
try {
  strippedOut = mapPlayerResponse(stripped)
} catch {
  survived = false
}
ok(survived, 'mapPlayerResponse survives missing streamingData + videoDetails')
eq(strippedOut?.adaptiveFormats.length, 0, 'stripped player -> 0 adaptiveFormats')
eq(strippedOut?.formatStreams.length, 0, 'stripped player -> 0 formatStreams')
eq(strippedOut?.viewCount, 0, 'stripped player -> viewCount 0 default')

/* =================================================================== */
section('search.web.json  ("big buck bunny", WEB)')
/* =================================================================== */

const searchJson = load('search.web.json')
const search = mapSearchResults(searchJson, { now: NOW })

eq(search.length, 20, 'search yields 20 results (20 videoRenderer in fixture)')
const searchVideos = search.filter((r) => r.type === 'video') as any[]
ok(searchVideos.length === 20, 'all 20 search results are videos', searchVideos.length)
ok(searchVideos.every((v) => typeof v.videoId === 'string' && v.videoId.length === 11), 'every search video has an 11-char videoId')
ok(searchVideos.every((v) => v.title.length > 0), 'every search video has a title')
ok(searchVideos.every((v) => v.author.length > 0), 'every search video has an author')
ok(searchVideos.every((v) => /^UC[\w-]{20,24}$/.test(v.authorId)), 'every search video has a UC... authorId')
ok(searchVideos.every((v) => v.videoThumbnails.length > 0 && isHttps(v.videoThumbnails[0].url)), 'every search video has https thumbnails')
ok(searchVideos.every((v) => typeof v.viewCount === 'number'), 'every search viewCount is a number')
ok(searchVideos.every((v) => typeof v.lengthSeconds === 'number'), 'every search lengthSeconds is a number')

const bbb = searchVideos.find((v) => v.videoId === 'aqz-KE-bpKQ')!
ok(!!bbb, 'search contains aqz-KE-bpKQ')
eq(bbb.title, 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film', 'search bbb.title')
eq(bbb.author, 'Blender', 'search bbb.author')
eq(bbb.authorId, 'UCSMOQeBJ2RAnuFungnQOxLg', 'search bbb.authorId')
eq(bbb.authorUrl, 'https://www.youtube.com/@BlenderOfficial', 'search bbb.authorUrl from canonicalBaseUrl')
eq(bbb.lengthSeconds, 635, 'search bbb.lengthSeconds from "10:35"')
eq(bbb.viewCount, 23_387_323, 'search bbb.viewCount from "23,387,323 views"')
eq(bbb.viewCountText, '23,387,323 views', 'search bbb.viewCountText')
eq(bbb.publishedText, '11 years ago', 'search bbb.publishedText')
eq(bbb.published, NOW - 11 * 31_556_952, 'search bbb.published -> unix seconds')
ok((bbb.description ?? '').includes('Big Buck Bunny'), 'search bbb.description from detailedMetadataSnippets')

const plausibleDur = searchVideos.filter((v) => v.lengthSeconds > 0 && v.lengthSeconds < 86400)
ok(plausibleDur.length >= 18, `>=18 search videos have plausible durations (got ${plausibleDur.length})`)
const plausibleViews = searchVideos.filter((v) => v.viewCount > 100)
ok(plausibleViews.length >= 18, `>=18 search videos have viewCount > 100 (got ${plausibleViews.length})`)
ok(searchVideos.every((v) => (v.published ?? 0) > 1_000_000_000 && (v.published ?? 0) <= NOW), 'every published timestamp is plausible unix seconds')

ok(typeof searchContinuation(searchJson) === 'string' && searchContinuation(searchJson)!.length > 20, 'search continuation token extracted')

/* --- a malformed item must not break the list ---------------------- */
const corrupted = JSON.parse(JSON.stringify(searchJson))
const secContents =
  corrupted.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0]
    .itemSectionRenderer.contents
secContents[3] = { videoRenderer: { videoId: null, title: 42, thumbnail: 'not-an-object' } }
secContents[7] = { videoRenderer: null }
secContents[9] = { someUnknownFutureRenderer2027: { foo: 'bar' } }
secContents.splice(11, 0, { adSlotRenderer: { fills: [] } })
const corruptedOut = mapSearchResults(corrupted, { now: NOW })
eq(corruptedOut.length, 17, 'corrupted search: 3 bad/unknown items skipped, ad skipped, 17 remain')
ok(corruptedOut.every((r) => (r as any).videoId), 'corrupted search: all survivors still have a videoId')

/* =================================================================== */
section('search.web.channels.json  (params EgIQAg==, channel filter)')
/* =================================================================== */

const chSearchJson = load('search.web.channels.json')
const chSearch = mapSearchResults(chSearchJson)
const channels = chSearch.filter((r) => r.type === 'channel') as any[]

eq(chSearch.length, 20, 'channel search yields 20 results (5 ad slots skipped)')
eq(channels.length, 20, 'all 20 are channels')
ok(channels.every((c) => /^UC[\w-]{20,24}$/.test(c.authorId)), 'every channel has a UC... authorId')
ok(channels.every((c) => c.author.length > 0), 'every channel has an author name')
ok(channels.every((c) => c.authorThumbnails.length > 0 && isHttps(c.authorThumbnails[0].url)), 'every channel thumbnail is https (//-relative fixed)')
ok(channels.every((c) => typeof c.subCount === 'number'), 'every channel subCount is a number')

const blenderCh = channels.find((c) => c.authorId === 'UCSMOQeBJ2RAnuFungnQOxLg')!
ok(!!blenderCh, 'channel search contains Blender')
eq(blenderCh.author, 'Blender', 'blender channel author')
eq(blenderCh.subCount, 1_250_000, 'blender subCount 1.25M parsed from the SWAPPED videoCountText field')
eq(blenderCh.authorUrl, 'https://www.youtube.com/@BlenderOfficial', 'blender channel authorUrl')
ok((blenderCh.description ?? '').includes('Free and Open Source'), 'blender channel description from descriptionSnippet')

const withSubs = channels.filter((c) => c.subCount > 0)
ok(withSubs.length >= 18, `>=18 channels have subCount > 0 (got ${withSubs.length})`)
ok(
  chSearch.every((r) => !JSON.stringify(r).includes('adBadge')),
  'no ad artifacts leaked into channel search results',
)

/* =================================================================== */
section('next.web.json  (recommendations)')
/* =================================================================== */

const nextJson = load('next.web.json')
const recs = mapRecommendations(nextJson, { now: NOW })

eq(recs.length, 35, 'recommendations: 26 lockupViewModel + 9 shortsLockupViewModel from reelShelfRenderer')
const recLockups = recs.filter((r) => r.type === 'video')
const recShorts = recs.filter((r) => r.type === 'shortVideo')
eq(recLockups.length, 26, '26 regular videos (lockupViewModel)')
eq(recShorts.length, 9, '9 shorts (shortsLockupViewModel inside reelShelfRenderer)')

ok(recs.every((v) => typeof v.videoId === 'string' && v.videoId.length === 11), 'every recommendation has an 11-char videoId')
ok(recs.every((v) => v.title.length > 0), 'every recommendation has a title')
ok(recLockups.every((v) => v.author.length > 0), 'every lockup recommendation has an author')
ok(recLockups.every((v) => /^UC[\w-]{20,24}$/.test(v.authorId)), 'every lockup recommendation has a UC... authorId')
ok(recs.every((v) => v.videoThumbnails.length > 0 && isHttps(v.videoThumbnails[0].url)), 'every recommendation has https thumbnails')

const first = recLockups[0]
eq(first.videoId, 'B4EPW7JUMTM', 'first recommendation videoId')
eq(
  first.title,
  'FOREVERGREEN — Academy Award®–Nominated Animated Short Film | Now Streaming for a Limited Time',
  'first recommendation title',
)
eq(first.author, 'Forevergreen Film and Josh Garrels', 'first recommendation author (metadataRow 0)')
eq(first.viewCount, 9_800_000, 'first recommendation viewCount from a11y "9.8 million views"')
eq(first.lengthSeconds, 786, 'first recommendation lengthSeconds from badge "13:06"')
eq(first.publishedText, '9mo ago', 'first recommendation publishedText')
eq(first.published, NOW - 9 * 2_629_746, 'first recommendation published unix')

const wb = recLockups.find((v) => v.author === 'Warner Bros. Classics')!
ok(!!wb, 'recommendations contain "Warner Bros. Classics"')
eq(wb.viewCount, 1_200_000, 'Warner Bros. lockup viewCount 1.2M')

const durOk = recLockups.filter((v) => v.lengthSeconds > 0 && v.lengthSeconds < 86400)
eq(durOk.length, 26, 'all 26 lockups have a plausible duration')
const viewsOk = recLockups.filter((v) => v.viewCount > 1000)
ok(viewsOk.length >= 24, `>=24 lockups have viewCount > 1000 (got ${viewsOk.length})`)
ok(
  recShorts.every((s) => s.lengthSeconds === 0 && s.type === 'shortVideo'),
  'shorts map to type "shortVideo" with lengthSeconds 0',
)
const firstShort = recShorts[0]
eq(firstShort.videoId, 'D2kjeaX1T_w', 'first short videoId from reelWatchEndpoint')
eq(firstShort.viewCount, 59_000, 'first short viewCount from overlayMetadata "59K views"')
ok(firstShort.title.includes('Superworm'), 'first short title from overlayMetadata.primaryText', firstShort.title)

/* =================================================================== */
section('channel.web.json  (browseId UCSMOQeBJ2RAnuFungnQOxLg, Home tab)')
/* =================================================================== */

const channelJson = load('channel.web.json')
const channel = mapChannel(channelJson, { now: NOW })

eq(channel.type, 'channel', 'channel.type')
eq(channel.author, 'Blender', 'channel.author (pageHeaderViewModel dynamicTextViewModel)')
ok(channel.author.length > 0, 'channel has a name')
eq(channel.authorId, 'UCSMOQeBJ2RAnuFungnQOxLg', 'channel.authorId')
eq(channel.authorUrl, 'http://www.youtube.com/@BlenderOfficial', 'channel.authorUrl from ownerUrls')
eq(channel.subCount, 1_250_000, 'channel.subCount parsed from "1.25M subscribers"')
ok(channel.subCount > 0, 'channel subCount > 0')
eq(channel.videoCount, 1_400, 'channel.videoCount parsed from "1.4K videos"')
ok(channel.authorThumbnails.length >= 3, 'channel.authorThumbnails >= 3', channel.authorThumbnails.length)
ok(channel.authorThumbnails.every((t) => isHttps(t.url)), 'all authorThumbnails https')
ok(channel.authorBanners.length >= 4, 'channel.authorBanners >= 4 (imageBannerViewModel)', channel.authorBanners.length)
ok(channel.authorBanners.every((t) => isHttps(t.url)), 'all authorBanners https')
ok(channel.authorBanners.some((t) => t.width >= 1060), 'a banner is at least 1060px wide')
ok((channel.description ?? '').includes('Free and Open Source'), 'channel.description present')
eq(channel.isFamilyFriendly, true, 'channel.isFamilyFriendly')
ok((channel.allowedRegions ?? []).length > 100, 'channel.allowedRegions from availableCountryCodes', (channel.allowedRegions ?? []).length)
eq(
  channel.tabs,
  ['Home', 'Videos', 'Shorts', 'Live', 'Podcasts', 'Playlists', 'Posts', 'Search'],
  'channel.tabs',
)

const latest = channel.latestVideos ?? []
ok(latest.length >= 100, `channel Home shelves yield >=100 videos (got ${latest.length})`)
ok(latest.every((v) => v.videoId.length === 11), 'every channel home video has an 11-char videoId')
ok(latest.every((v) => v.title.length > 0), 'every channel home video has a title')
ok(latest.every((v) => v.author.length > 0), 'every channel home video has a non-empty author')
ok(
  latest.filter((v) => v.author === 'Blender').length >= 110,
  `>=110 channel home videos inherit the page author (got ${latest.filter((v) => v.author === 'Blender').length})`,
)
// the "Collaborations" shelf carries its own byline row, which must win over the fallback
ok(
  latest.some((v) => v.author !== 'Blender'),
  'Collaborations shelf lockups keep their own byline instead of the page author',
)
ok(latest.filter((v) => v.lengthSeconds > 0).length >= 100, 'channel home videos have durations')
const related = channel.relatedChannels ?? []
eq(related.length, 2, 'channel.relatedChannels: 2 gridChannelRenderer')
const devs = related.find((c) => c.authorId === 'UCAsj9iReHzLEYv9QawGzIOg')!
ok(!!devs, 'relatedChannels contains Blender Developers')
eq(devs.author, 'Blender Developers', 'related channel author')
eq(devs.subCount, 87_400, 'related channel subCount "87.4K subscribers"')
eq(devs.videoCount, 144, 'related channel videoCount "144 videos"')

/* =================================================================== */
section('channel.videos.web.json  (Videos tab)')
/* =================================================================== */

const chVidJson = load('channel.videos.web.json')
const chVid = mapChannelVideos(chVidJson, { now: NOW })

eq(chVid.videos.length, 30, 'channel Videos tab yields 30 videos (richItemRenderer -> lockupViewModel)')
ok(typeof chVid.continuation === 'string' && chVid.continuation.length > 20, 'channel videos continuation token present')
ok(chVid.continuation!.startsWith('4qmFsg'), 'continuation token looks like a real InnerTube token', chVid.continuation?.slice(0, 10))
ok(chVid.videos.every((v) => v.videoId.length === 11), 'every channel video has an 11-char videoId')
ok(chVid.videos.every((v) => v.title.length > 0), 'every channel video has a title')
ok(chVid.videos.every((v) => v.author === 'Blender'), 'every channel video author filled from channelMetadataRenderer')
ok(chVid.videos.every((v) => v.authorId === 'UCSMOQeBJ2RAnuFungnQOxLg'), 'every channel video authorId filled')
ok(chVid.videos.every((v) => v.videoThumbnails.length > 0), 'every channel video has thumbnails')

const cv0 = chVid.videos[0]
eq(cv0.videoId, 'gqfLYIJMv7I', 'channel videos[0].videoId')
eq(cv0.lengthSeconds, 110, 'channel videos[0].lengthSeconds from badge "1:50"')
eq(cv0.viewCount, 522_000, 'channel videos[0].viewCount from "522K views"')
eq(cv0.publishedText, '1 month ago', 'channel videos[0].publishedText')
eq(cv0.published, NOW - 2_629_746, 'channel videos[0].published unix')
ok(chVid.videos.every((v) => v.lengthSeconds > 0), 'all 30 channel videos have a duration > 0')
ok(chVid.videos.every((v) => v.viewCount > 0), 'all 30 channel videos have viewCount > 0')
ok(chVid.videos.every((v) => (v.published ?? 0) > 1_000_000_000), 'all 30 channel videos have a plausible published unix')

/* =================================================================== */
section('home.web.json  (FEwhat_to_watch, signed out)')
/* =================================================================== */

const homeJson = load('home.web.json')
const home = mapHomeFeed(homeJson, { now: NOW })

// The captured feed is a signed-out EMPTY feed: richGridRenderer holds a single
// richSectionRenderer -> feedNudgeRenderer ("Try searching to get started").
eq(home.length, 0, 'signed-out home feed maps to [] (feedNudgeRenderer only) without throwing')
ok(Array.isArray(home), 'mapHomeFeed always returns an array')

// The same richGrid code path IS exercised by a populated grid: reuse the real
// channel Videos tab response, which is the identical richGridRenderer shape.
const homePath = mapHomeFeed(chVidJson, { now: NOW })
eq(homePath.length, 30, 'mapHomeFeed on a populated richGridRenderer yields 30 items')
ok(homePath.every((v) => v.videoId.length === 11 && v.title.length > 0), 'richGrid items carry videoId + title')

/* =================================================================== */
section('playlist.web.json  (VLPLZlSuqcYFtDNfxUW3aRVEEqfLzMEbrhOJ)')
/* =================================================================== */

const plJson = load('playlist.web.json')
const alert = responseAlert(plJson)
eq(alert?.type, 'ERROR', 'playlist fixture is an ERROR alert response')
eq(alert?.text, 'The playlist does not exist.', 'playlist alert text')

let plSurvived = true
let pl: any = null
try {
  pl = mapPlaylist(plJson)
} catch {
  plSurvived = false
}
ok(plSurvived, 'mapPlaylist does not throw on a "playlist does not exist" response')
eq(pl?.type, 'playlist', 'mapPlaylist returns type "playlist"')
eq(pl?.videos, [], 'mapPlaylist -> empty videos array')
eq(pl?.videoCount, 0, 'mapPlaylist -> videoCount 0')
eq(pl?.title, '', 'mapPlaylist -> empty title default')
ok(Array.isArray(pl?.videos), 'PlaylistDetails.videos is always an array')

/* --- playlist mapping over a real classic shape -------------------- */
/* Built from REAL videoRenderer objects captured in search.web.json,
   re-wrapped as playlistVideoRenderer inside a playlistVideoListRenderer
   (no live playlist fixture exists - the captured one 404'd). */
const realVideoRenderers = searchJson.contents.twoColumnSearchResultsRenderer.primaryContents
  .sectionListRenderer.contents[0].itemSectionRenderer.contents.slice(0, 5)
  .map((c: any) => ({ playlistVideoRenderer: c.videoRenderer }))
const syntheticPlaylist = {
  header: {
    playlistHeaderRenderer: {
      playlistId: 'PLZlSuqcYFtDNfxUW3aRVEEqfLzMEbrhOJ',
      title: { simpleText: 'Blender Open Movies' },
      descriptionText: { simpleText: 'All the open movies.' },
      ownerText: {
        runs: [
          {
            text: 'Blender',
            navigationEndpoint: { browseEndpoint: { browseId: 'UCSMOQeBJ2RAnuFungnQOxLg' } },
          },
        ],
      },
      stats: [{ simpleText: '5 videos' }, { simpleText: '1,234,567 views' }],
    },
  },
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            selected: true,
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    itemSectionRenderer: {
                      contents: [{ playlistVideoListRenderer: { contents: realVideoRenderers } }],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
}
const pl2 = mapPlaylist(syntheticPlaylist, { now: NOW })
eq(pl2.playlistId, 'PLZlSuqcYFtDNfxUW3aRVEEqfLzMEbrhOJ', 'playlist.playlistId')
eq(pl2.title, 'Blender Open Movies', 'playlist.title')
eq(pl2.author, 'Blender', 'playlist.author')
eq(pl2.authorId, 'UCSMOQeBJ2RAnuFungnQOxLg', 'playlist.authorId')
eq(pl2.videoCount, 5, 'playlist.videoCount from stats "5 videos"')
eq(pl2.viewCount, 1_234_567, 'playlist.viewCount from stats "1,234,567 views"')
eq(pl2.videos.length, 5, 'playlist maps 5 playlistVideoRenderer entries')
ok(pl2.videos.every((v) => v.videoId.length === 11 && v.title.length > 0), 'playlist videos have videoId + title')
eq(pl2.videos[0].lengthSeconds, 635, 'playlist video[0] duration parsed')

/* =================================================================== */
section('mapContinuation')
/* =================================================================== */

// Real continuation shape, built from the real channel Videos grid contents.
const realGridContents =
  chVidJson.contents.twoColumnBrowseResultsRenderer.tabs.find((t: any) => t.tabRenderer?.selected)
    .tabRenderer.content.richGridRenderer.contents
const contJson = {
  onResponseReceivedActions: [
    { appendContinuationItemsAction: { continuationItems: realGridContents } },
  ],
}
const cont = mapContinuation(contJson)
eq(cont.items.length, 30, 'mapContinuation returns 30 items (continuationItemRenderer excluded)')
ok(typeof cont.continuation === 'string' && cont.continuation.length > 20, 'mapContinuation extracts the next token')
eq(cont.continuation, chVid.continuation, 'mapContinuation token matches the one from mapChannelVideos')
eq(mapContinuation({}).items.length, 0, 'mapContinuation({}) -> 0 items (no throw)')
eq(mapContinuation({}).continuation, undefined, 'mapContinuation({}) -> no token')
eq(mapContinuation({ onResponseReceivedActions: null }).items.length, 0, 'mapContinuation tolerates null actions')

// reloadContinuationItemsCommand variant
const cont2 = mapContinuation({
  onResponseReceivedEndpoints: [
    { reloadContinuationItemsCommand: { continuationItems: realGridContents } },
  ],
})
eq(cont2.items.length, 30, 'mapContinuation handles reloadContinuationItemsCommand')

/* =================================================================== */
section('defensive: garbage in, sensible defaults out')
/* =================================================================== */

const junk: any[] = [null, undefined, {}, [], 0, 'string', { contents: null }, { contents: { foo: 1 } }]
let allSafe = true
for (const j of junk) {
  try {
    mapSearchResults(j)
    mapRecommendations(j)
    mapHomeFeed(j)
    mapChannel(j)
    mapChannelVideos(j)
    mapPlaylist(j)
    mapContinuation(j)
    responseAlert(j)
  } catch (e) {
    allSafe = false
    console.log(`     threw on ${JSON.stringify(j)}: ${(e as Error).message}`)
  }
}
ok(allSafe, 'no mapper throws on null/undefined/empty/garbage input')
eq(mapSearchResults(null).length, 0, 'mapSearchResults(null) -> []')
eq(mapRecommendations(undefined).length, 0, 'mapRecommendations(undefined) -> []')
eq(mapHomeFeed({}).length, 0, 'mapHomeFeed({}) -> []')
eq(mapChannel({}).author, '', 'mapChannel({}) -> empty author default')
eq(mapChannel({}).subCount, 0, 'mapChannel({}) -> subCount 0 default')
eq(mapChannel({}).authorThumbnails, [], 'mapChannel({}) -> empty thumbnails array')
eq(mapChannel({}).authorBanners, [], 'mapChannel({}) -> empty banners array')
eq(mapChannelVideos({}).videos.length, 0, 'mapChannelVideos({}) -> 0 videos')

/* =================================================================== */
console.log(`\n================================`)
console.log(`passed: ${passed}   failed: ${failed}   total: ${passed + failed}`)
if (failed) {
  console.log('failed assertions:')
  for (const f of failures) console.log('  - ' + f)
}
console.log(`================================`)
process.exit(failed ? 1 : 0)
