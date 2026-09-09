/**
 * End-to-end through the REAL production modules, using the VISIONOS client.
 *
 * `live-dash.test.ts` builds its manifest from an IOS player response, which is
 * the client we demoted. This walks the path the app now actually takes:
 *
 *   VISIONOS /player -> mapPlayerResponse -> buildDashManifestDetailed -> segment fetch
 *
 * and reads segments near the END of the file, because the failure this project
 * spent weeks on looked perfectly healthy at position 0.
 */

import { mapPlayerResponse } from '../src/lib/api/innertube-map'
import { buildDashManifestDetailed, type AdaptiveFormatInput } from '../src/lib/api/innertube-dash'
import { proxyMediaUrl } from '../src/lib/api/media-proxy'

const VISIONOS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log('  ok   ' + label + (detail ? '  (' + detail + ')' : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  (' + detail + ')' : '')) }
}

async function visionOsPlayer(videoId: string): Promise<unknown> {
  const home = await fetch('https://www.youtube.com/', {
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
          clientName: 'VISIONOS', clientVersion: '1.02',
          deviceMake: 'Apple', deviceModel: 'RealityDevice17,1',
          userAgent: VISIONOS_UA, osName: 'visionOS', osVersion: '26.5.23O471',
          hl: 'en', gl: 'US'
        }
      },
      videoId, contentCheckOk: true, racyCheckOk: true
    }),
    signal: AbortSignal.timeout(30000)
  })
  return res.json()
}

async function main() {
  for (const [id, label] of [
    ['aqz-KE-bpKQ', 'Big Buck Bunny (10.6 min)'],
    ['dQw4w9WgXcQ', 'music video (3.5 min)']
  ] as const) {
    console.log('\n' + label + ' (' + id + ')')

    const json = await visionOsPlayer(id)
    const video = mapPlayerResponse(json)
    const formats = (json as { streamingData?: { adaptiveFormats?: AdaptiveFormatInput[] } })
      .streamingData?.adaptiveFormats ?? []

    check('mapper produced a title', Boolean(video.title), video.title?.slice(0, 40))
    check('duration parsed', video.lengthSeconds > 60, video.lengthSeconds + 's')
    check('every adaptive format has a URL', formats.every(f => Boolean(f.url)),
      formats.filter(f => !f.url).length + ' missing')

    const result = buildDashManifestDetailed(formats, {
      durationSeconds: video.lengthSeconds,
      rewriteUrl: proxyMediaUrl
    })
    check('manifest generated', result.mpd.length > 500, result.mpd.length + ' bytes')
    check('multiple representations', result.representationCount > 5, String(result.representationCount))

    // The real test: pull bytes from deep in the file, through the same URL the
    // manifest points at. Position 0 has never been the problem.
    const baseUrls = [...result.mpd.matchAll(/<BaseURL>([^<]+)<\/BaseURL>/g)].map(m => m[1])
    const target = decodeURIComponent(new URL(baseUrls[0]).searchParams.get('u') ?? '')
    check('a proxied target resolves', target.startsWith('https://'), new URL(target).hostname)

    const head = await fetch(target, {
      headers: { Range: 'bytes=0-1', 'User-Agent': VISIONOS_UA },
      signal: AbortSignal.timeout(20000)
    })
    const total = Number(head.headers.get('content-range')?.split('/')[1] ?? 0)
    check('content-range reports a total size', total > 0, (total / 1048576).toFixed(1) + ' MiB')

    for (const [where, fraction] of [['25%', 0.25], ['75%', 0.75], ['99%', 0.99]] as const) {
      const at = Math.max(0, Math.min(Math.floor(total * fraction), total - 65536))
      const seg = await fetch(target, {
        headers: { Range: 'bytes=' + at + '-' + (at + 65535), 'User-Agent': VISIONOS_UA },
        signal: AbortSignal.timeout(20000)
      })
      const bytes = (await seg.arrayBuffer()).byteLength
      check('segment at ' + where + ' of the stream', seg.status === 206 && bytes > 0,
        'HTTP ' + seg.status + ', ' + bytes + ' bytes')
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(err => { console.error('threw:', err); process.exit(1) })
