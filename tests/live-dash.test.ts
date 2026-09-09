/** Run the real production path against live YouTube: player -> mapper -> MPD. */

import { mapPlayerResponse } from '../src/lib/api/innertube-map'
import { buildDashManifestDetailed, type AdaptiveFormatInput } from '../src/lib/api/innertube-dash'
import { proxyMediaUrl } from '../src/lib/api/media-proxy'

const IOS_UA = 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log('  ok   ' + label + (detail ? '  (' + detail + ')' : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  (' + detail + ')' : '')) }
}

async function player(videoId: string): Promise<unknown> {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'User-Agent': IOS_UA,
      'X-YouTube-Client-Name': '5', 'X-YouTube-Client-Version': '20.10.4',
      Origin: 'https://www.youtube.com'
    },
    body: JSON.stringify({
      context: { client: {
        clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2',
        osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en', gl: 'US'
      } },
      videoId, contentCheckOk: true, racyCheckOk: true
    }),
    signal: AbortSignal.timeout(30000)
  })
  return res.json()
}

async function main() {
  for (const [id, label] of [['aqz-KE-bpKQ', 'Big Buck Bunny 4K60'], ['dQw4w9WgXcQ', 'music video']] as const) {
    console.log('\n' + label + ' (' + id + ')')
    const json = await player(id)
    const video = mapPlayerResponse(json)
    const formats = (json as { streamingData?: { adaptiveFormats?: AdaptiveFormatInput[] } }).streamingData?.adaptiveFormats ?? []

    const result = buildDashManifestDetailed(formats, {
      durationSeconds: video.lengthSeconds,
      rewriteUrl: proxyMediaUrl
    })

    check('manifest generated', result.mpd.length > 500, result.mpd.length + ' bytes')
    check('multiple representations', result.representationCount > 5, String(result.representationCount))
    check('video and audio sets', result.adaptationSetCount >= 2, String(result.adaptationSetCount) + ' adaptation sets')

    const heights = [...result.mpd.matchAll(/height="(\d+)"/g)].map(m => Number(m[1]))
    const maxHeight = Math.max(...heights, 0)
    check('high resolution present', maxHeight >= 1080, maxHeight + 'p')

    const baseUrls = [...result.mpd.matchAll(/<BaseURL>([^<]+)<\/BaseURL>/g)].map(m => m[1])
    check('every representation has a BaseURL', baseUrls.length === result.representationCount,
      baseUrls.length + ' of ' + result.representationCount)
    check('all segment URLs go through the media proxy',
      baseUrls.every(u => u.startsWith('http://playletmedia.localhost/')))
    check('no raw googlevideo URL leaks into the manifest', !/googlevideo\.com\/videoplayback/.test(result.mpd))
    check('SegmentBase ranges present',
      (result.mpd.match(/<SegmentBase indexRange="/g) ?? []).length === result.representationCount)

    if (result.skipped.length > 0) {
      console.log('       skipped: ' + result.skipped.map(s => s.itag + ' (' + s.reason + ')').join(', '))
    }

    // The proxy must be able to actually fetch what the manifest points at.
    const first = baseUrls[0]
    const target = decodeURIComponent(new URL(first).searchParams.get('u') ?? '')
    const probe = await fetch(target, { headers: { Range: 'bytes=0-2000' }, signal: AbortSignal.timeout(20000) })
    check('proxied target serves a range request', probe.status === 206, 'HTTP ' + probe.status)
  }

  await checkVisionOsPlaysPastSixtySeconds()

  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail === 0 ? 0 : 1)
}

const VISIONOS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'

/**
 * The regression that matters most.
 *
 * Every other client stops serving at exactly 60.000s of media, so this asserts
 * media across the WHOLE file rather than that a request succeeded - a 200 at
 * position 0 looked healthy for weeks while playback was completely broken.
 */
async function checkVisionOsPlaysPastSixtySeconds() {
  console.log('\nVISIONOS playback (60-second regression guard)')

  const home = await fetch('https://www.youtube.com/', {
    headers: {
      'User-Agent': VISIONOS_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: 'SOCS=CAI; PREF=hl=en&tz=UTC'
    },
    signal: AbortSignal.timeout(20000)
  })
  const visitorData = (await home.text()).match(/"visitorData":\s*"([^"]+)"/)?.[1] ?? ''
  check('scraped a visitor id', visitorData.length > 50, visitorData.length + ' chars')
  if (!visitorData) return

  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': VISIONOS_UA,
      'X-YouTube-Client-Name': '101',
      'X-YouTube-Client-Version': '1.02',
      // Required. Without it the player answers LOGIN_REQUIRED.
      'X-Goog-Visitor-Id': visitorData,
      Origin: 'https://www.youtube.com'
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'VISIONOS', clientVersion: '1.02',
          deviceMake: 'Apple', deviceModel: 'RealityDevice17,1',
          userAgent: VISIONOS_UA, osName: 'visionOS', osVersion: '26.5.23O471',
          hl: 'en', gl: 'US'
        }
      },
      videoId: 'aqz-KE-bpKQ', contentCheckOk: true, racyCheckOk: true
    }),
    signal: AbortSignal.timeout(30000)
  })

  const json = (await res.json()) as {
    playabilityStatus?: { status?: string }
    streamingData?: { adaptiveFormats?: Array<Record<string, unknown>> }
  }
  const formats = json.streamingData?.adaptiveFormats ?? []
  check('player answers OK', json.playabilityStatus?.status === 'OK', String(json.playabilityStatus?.status))
  check('formats returned', formats.length > 10, formats.length + ' formats')

  const ciphered = formats.filter(f => !f.url).length
  check('no format needs deciphering', ciphered === 0, ciphered + ' ciphered')

  const video = formats
    .filter(f => typeof f.url === 'string' && String(f.mimeType).startsWith('video/') && Number(f.height) <= 480)
    .sort((a, b) => Number(b.height) - Number(a.height))[0]
  if (!video) { check('a usable video format', false); return }

  const contentLength = Number(video.contentLength)
  check('contentLength present', contentLength > 0, contentLength + ' bytes')

  // Near the start, well past the old wall, and near the very end.
  for (const [label, fraction] of [['1%', 0.01], ['50%', 0.5], ['99%', 0.99]] as const) {
    const at = Math.max(0, Math.min(Math.floor(contentLength * fraction), contentLength - 65536))
    const probe = await fetch(String(video.url), {
      headers: { Range: 'bytes=' + at + '-' + (at + 65535), 'User-Agent': VISIONOS_UA },
      signal: AbortSignal.timeout(20000)
    })
    const bytes = (await probe.arrayBuffer()).byteLength
    check('serves media at ' + label + ' of the file', probe.status === 206 && bytes > 0,
      'HTTP ' + probe.status + ', ' + bytes + ' bytes')
  }
}

main().catch(err => { console.error('threw:', err); process.exit(1) })
