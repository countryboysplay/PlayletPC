/**
 * live-account.test.ts - the SIGNED-IN paths, against live YouTube.
 *
 *   npm run test:live:account
 *
 * Why this exists: every other test in this repo runs signed out, and the signed-in
 * code path is a different one. Three shipped bugs hid in exactly that gap. This test
 * reads the real account out of the installed app's settings.json, refreshes the token
 * if needed, and exercises the two things a signed-in user actually asked for:
 *
 *   1. the account's subscribed channels and saved playlists actually map to non-empty
 *      lists (the feeds used to be stubbed to return []), and
 *   2. the player response offers a video ladder ABOVE 1080p, and the codec preference
 *      list keeps it - the 1080p ceiling was shaka filtering every VP9/AV1 variant out
 *      because the preference string was 'vp9' and YouTube writes 'vp09.xx'.
 *
 * It SKIPS (exit 0) rather than fails when the app is not installed or not signed in,
 * so it is safe to run on a machine that has neither.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  mapSavedPlaylists,
  mapSubscribedChannels,
  mapTvPlaylist,
  mapTvVideoFeed
} from '../src/lib/api/innertube-tv-map'
import { codecPreferenceList } from '../src/lib/player/player'
import { buildDashManifestDetailed, type AdaptiveFormatInput } from '../src/lib/api/innertube-dash'

let pass = 0
let fail = 0
const failures: string[] = []

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log('  ok   ' + label + (detail ? '  (' + detail + ')' : ''))
  } else {
    fail++
    failures.push(label)
    console.log('  FAIL ' + label + (detail ? '  (' + detail + ')' : ''))
  }
}

function skip(why: string): never {
  console.log('SKIP: ' + why)
  process.exit(0)
}
void skip

/* ---- account ------------------------------------------------------------ */

const SETTINGS =
  process.env.PLAYLET_SETTINGS ??
  path.join(os.homedir(), 'AppData', 'Roaming', 'app.playlet.desktop', 'settings.json')

/**
 * The account comes from the installed app's settings.json, or from the environment
 * when there is no install to read (a clean machine, CI, or - as happened once - the
 * app having been uninstalled mid-session). `PLAYLET_ACCESS_TOKEN` alone is enough
 * for a single run; the refresh triple is only needed once it expires.
 */
const acct: any = fs.existsSync(SETTINGS)
  ? (JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))?.youtube_account ?? {})
  : {
      accessToken: process.env.PLAYLET_ACCESS_TOKEN,
      refreshToken: process.env.PLAYLET_REFRESH_TOKEN,
      clientId: process.env.PLAYLET_CLIENT_ID,
      clientSecret: process.env.PLAYLET_CLIENT_SECRET,
      // An access token supplied by hand is assumed live; refresh only on failure.
      expiresAt: Math.floor(Date.now() / 1000) + 300
    }

const HAVE_ACCOUNT = Boolean(acct.accessToken || acct.refreshToken)

async function accessToken(): Promise<string> {
  if (acct.accessToken && Math.floor(Date.now() / 1000) < (acct.expiresAt ?? 0) - 60) {
    return acct.accessToken
  }
  if (!acct.refreshToken) throw new Error('access token expired and no refresh token available')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: acct.clientId,
      client_secret: acct.clientSecret,
      refresh_token: acct.refreshToken,
      grant_type: 'refresh_token'
    }),
    signal: AbortSignal.timeout(20000)
  })
  const json: any = await res.json()
  if (!json.access_token) throw new Error('token refresh failed: HTTP ' + res.status)
  return json.access_token
}

/* ---- TV browse, exactly as innertube.rs shapes it ------------------------ */

const TV_UA =
  'Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15'

async function tvBrowse(browseId: string, token: string): Promise<any> {
  const res = await fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': TV_UA,
      'X-YouTube-Client-Name': '7',
      'X-YouTube-Client-Version': '7.20250101.10.00',
      'Accept-Language': 'en-US,en',
      Authorization: 'Bearer ' + token
    },
    body: JSON.stringify({
      context: { client: { clientName: 'TVHTML5', clientVersion: '7.20250101.10.00', hl: 'en', gl: 'US' } },
      browseId
    }),
    signal: AbortSignal.timeout(30000)
  })
  if (!res.ok) throw new Error(browseId + ' -> HTTP ' + res.status)
  return res.json()
}

/* ---- VISIONOS player, the client the app plays with --------------------- */

const VISIONOS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'

async function visionOsPlayer(videoId: string): Promise<any> {
  const home = await fetch('https://www.youtube.com/watch?v=' + videoId, {
    headers: {
      'User-Agent': VISIONOS_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: 'SOCS=CAI; PREF=hl=en&tz=UTC'
    },
    signal: AbortSignal.timeout(20000)
  })
  const visitorData = (await home.text()).match(/"visitorData":\s*"([^"]+)"/)?.[1] ?? ''

  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': VISIONOS_UA,
      'X-YouTube-Client-Name': '101',
      'X-YouTube-Client-Version': '1.02',
      'X-Goog-Visitor-Id': visitorData,
      Origin: 'https://www.youtube.com'
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'VISIONOS',
          clientVersion: '1.02',
          deviceMake: 'Apple',
          deviceModel: 'RealityDevice17,1',
          osName: 'visionOS',
          osVersion: '26.5.23O471',
          hl: 'en',
          gl: 'US'
        }
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true
    }),
    signal: AbortSignal.timeout(30000)
  })
  if (!res.ok) throw new Error('player -> HTTP ' + res.status)
  return res.json()
}

/**
 * shaka's StreamUtils.choosePreferredCodecs, reproduced exactly: the FIRST preference
 * with any prefix match wins outright, and every other codec's variants are dropped.
 * That is the whole mechanism behind the 1080p ceiling, so the test asserts against
 * the real algorithm rather than a paraphrase of it.
 */
function choosePreferredCodecs<T extends { codecs: string }>(variants: T[], prefs: string[]): T[] {
  for (const p of prefs) {
    const filtered = variants.filter(v => v.codecs.startsWith(p))
    if (filtered.length) return filtered
  }
  return variants
}

/* ======================================================================== */

if (!HAVE_ACCOUNT) {
  console.log('(no signed-in account found - skipping the account feeds. Install Playlet')
  console.log(' and sign in, or set PLAYLET_ACCESS_TOKEN, to cover those too.)')
} else {
  await accountChecks()
}

/** The signed-in feeds. Gated behind a real account token. */
async function accountChecks(): Promise<void> {
const token = await accessToken()

console.log('\n--- subscribed channels (FEsubscriptions, TV client, signed in) ---')
const subsJson = await tvBrowse('FEsubscriptions', token)
const channels = mapSubscribedChannels(subsJson)
check('the account returns at least one subscribed channel', channels.length > 0, channels.length + ' channels')
check(
  'every channel has a well-formed UCID',
  channels.length > 0 && channels.every(c => /^UC[A-Za-z0-9_-]{22}$/.test(c.authorId)),
)
check('every channel has a name', channels.every(c => c.author.trim().length > 0))
check(
  'navigation tabs are not mistaken for channels',
  !channels.some(c => ['All', 'A-Z', 'Shorts'].includes(c.author)),
)
console.log('       ' + channels.map(c => c.author).join(', '))

console.log('\n--- subscription video feed ---')
const feed = mapTvVideoFeed(subsJson)
check('the subscription feed returns videos', feed.length > 0, feed.length + ' videos')
check('every feed video has an id and a title', feed.every(v => v.videoId && v.title))
check('every feed video has a thumbnail', feed.every(v => v.videoThumbnails.length > 0))
check(
  'durations parse (non-live entries are non-zero)',
  feed.filter(v => !v.liveNow).every(v => v.lengthSeconds > 0),
)

console.log('\n--- saved playlists (FEplaylist_aggregation) ---')
const playlists = mapSavedPlaylists(await tvBrowse('FEplaylist_aggregation', token))
check('the account returns at least one saved playlist', playlists.length > 0, playlists.length + ' playlists')
check('every playlist has an id and a title', playlists.every(p => p.playlistId && p.title))
check('playlist counts are numbers, never NaN', playlists.every(p => Number.isFinite(p.videoCount)))
console.log('       ' + playlists.map(p => p.title + ' (' + p.videoCount + ')').join(', '))

console.log('--- opening a private playlist (needs the TV client) ---')
// Watch Later, Liked Videos and most user playlists are PRIVATE, so the WEB client
// - which carries no account token - cannot see them at all. This exercises the
// fallback path in `InnertubeClient.playlist()`.
const target = playlists.find(p => p.videoCount > 0)
if (!target) {
  console.log('       (no non-empty playlist on this account - nothing to open)')
} else {
  const detail = mapTvPlaylist(
    await tvBrowse('VL' + target.playlistId, token),
    target.playlistId,
    target.title,
  )
  check(
    'a private playlist returns its videos on the TV client',
    detail.videos.length > 0,
    target.title + ' -> ' + detail.videos.length + ' videos',
  )
  check('every playlist video has an id and a title', detail.videos.every(v => v.videoId && v.title))
  check('the playlist keeps a title', detail.title.length > 0, detail.title)
}

}

console.log('--- quality ladder above 1080p (needs no account) ---')

// A video published in 4K.
const player = await visionOsPlayer('aqz-KE-bpKQ')
const rawFormats = player?.streamingData?.adaptiveFormats ?? []
const rawVideo = rawFormats.filter((f: any) => String(f.mimeType ?? '').startsWith('video'))
const maxOffered = Math.max(0, ...rawVideo.map((f: any) => Number(f.height) || 0))
check('YouTube offers a ladder above 1080p', maxOffered > 1080, 'max ' + maxOffered + 'p')

// The trap: VISIONOS sends a BARE `vp9`, which MediaSource.isTypeSupported accepts
// and mediaCapabilities.decodingInfo rejects. shaka filters on the latter, so every
// VP9 variant was being dropped and the ladder fell back to H.264's 1080p ceiling.
const bare = rawVideo.filter((f: any) => /codecs="(vp9|vp09|vp8|vp08)"/.test(String(f.mimeType)))
console.log('       raw formats with an under-specified codec string: ' + bare.length)

const mpd = buildDashManifestDetailed(rawFormats as AdaptiveFormatInput[], {
  durationSeconds: Number(player?.videoDetails?.lengthSeconds) || 0,
  rewriteUrl: (u: string) => u
})

const reps = [...mpd.mpd.matchAll(/<Representation[^>]*>/g)].map(m => m[0])
const videoReps = reps
  .filter(r => /mimeType="video\//.test(r))
  .map(r => ({
    codecs: /codecs="([^"]+)"/.exec(r)?.[1] ?? '',
    height: Number(/height="(\d+)"/.exec(r)?.[1] ?? 0)
  }))

check('the manifest carries video representations', videoReps.length > 0, videoReps.length + ' reps')
check(
  'EVERY emitted video codec string is fully qualified (no bare vp9)',
  videoReps.every(r => /^(vp09|vp08|av01|avc1|avc3|hvc1|hev1)\./.test(r.codecs)),
  videoReps.filter(r => !/\./.test(r.codecs)).map(r => r.codecs).join(',') || 'all qualified',
)
check(
  'the manifest reaches the full ladder',
  Math.max(0, ...videoReps.map(r => r.height)) === maxOffered,
)

// VP9 levels must match what YouTube itself assigns, rung for rung.
const vp9 = videoReps.filter(r => r.codecs.startsWith('vp09'))
const EXPECTED_LEVELS: Record<number, string> = {
  144: '11', 240: '20', 360: '21', 480: '30', 720: '40', 1080: '41', 1440: '50', 2160: '51'
}
check(
  'VP9 levels match the assignment YouTube itself uses for each rung',
  vp9.length > 0 &&
    vp9.every(r => {
      const want = EXPECTED_LEVELS[r.height]
      return !want || r.codecs === 'vp09.00.' + want + '.08'
    }),
  vp9.map(r => r.height + 'p=' + r.codecs).join(' '),
)

// Finally: the shipped codec preference must keep VP9, not fall through to H.264.
const kept = choosePreferredCodecs(videoReps, codecPreferenceList('auto'))
const newMax = Math.max(0, ...kept.map(r => r.height))
check('the shipped preference list selects VP9', kept.every(r => r.codecs.startsWith('vp09')))
check('...and reaches the full ladder', newMax === maxOffered, 'max ' + newMax + 'p')

// And the old list, for the record: it matched nothing once VP9 was dropped.
const oldKept = choosePreferredCodecs(videoReps, ['vp9', 'avc1', 'av01'])
check(
  'the OLD preference list could not match the qualified vp09 strings',
  oldKept.every(r => r.codecs.startsWith('avc1')),
  'fell through to ' + [...new Set(oldKept.map(r => r.codecs.split('.')[0]))].join(','),
)
console.log(
  '       heights kept: ' +
    [...new Set(kept.map(r => r.height))].sort((a, b) => b - a).join(', ')
)

/* ======================================================================== */
console.log('\n================================')
console.log('passed: ' + pass + '   failed: ' + fail + '   total: ' + (pass + fail))
if (fail) {
  console.log('failed assertions:')
  for (const f of failures) console.log('  - ' + f)
}
console.log('================================')
process.exit(fail ? 1 : 0)
