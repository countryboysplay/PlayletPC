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

  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(err => { console.error('threw:', err); process.exit(1) })
