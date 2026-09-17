/**
 * The visitor-id cascade, against live YouTube.
 *
 * This mirrors `src-tauri/src/innertube.rs::fetch_identity`. It is duplicated rather
 * than imported because that logic lives in Rust, and the thing worth guarding is not
 * the Rust code - it is the assumption the Rust code rests on: that these four
 * sources still exist and still produce a token VISIONOS accepts.
 *
 * The bar is not "a request succeeded". Each source must produce a token that
 * actually unlocks the player, and the no-token control must still fail - otherwise
 * the test proves nothing.
 */

const YOUTUBE_ORIGIN = 'https://www.youtube.com'
const INNERTUBE_BASE = 'https://www.youtube.com/youtubei/v1/'
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const VISIONOS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const CONSENT_COOKIES = 'SOCS=CAI; PREF=hl=en&tz=UTC'
const VISITOR_MARKERS = ['"visitorData":"', '"VISITOR_DATA":"']
const VIDEO_ID = 'aqz-KE-bpKQ'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    console.log('  ok   ' + label + (detail ? '  (' + detail + ')' : ''))
  } else {
    fail++
    console.log('  FAIL ' + label + (detail ? '  (' + detail + ')' : ''))
  }
}

/** Mirrors `is_plausible_visitor_id`. Wide on purpose - see the Rust doc comment. */
function isPlausibleVisitorId(value: string): boolean {
  return value.length >= 32 && value.length <= 4096 && /^[A-Za-z0-9\-_%=.]+$/.test(value)
}

function extractBetween(haystack: string, marker: string, terminator: string): string | null {
  const i = haystack.indexOf(marker)
  if (i < 0) return null
  const rest = haystack.slice(i + marker.length)
  const end = rest.indexOf(terminator)
  if (end < 0) return null
  return rest.slice(0, end) || null
}

/** Mirrors `scan_for_visitor_id`. */
function scanForVisitorId(body: string): string | null {
  let rest = body
  for (;;) {
    const at = rest.indexOf('"Cg')
    if (at < 0) return null
    const tail = rest.slice(at + 1)
    const end = tail.indexOf('"')
    if (end < 0) return null
    const candidate = tail.slice(0, end)
    if (isPlausibleVisitorId(candidate)) return candidate
    rest = tail.slice(end)
  }
}

async function homePage(): Promise<string> {
  const res = await fetch(YOUTUBE_ORIGIN, {
    headers: { 'User-Agent': WEB_UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: CONSENT_COOKIES },
    signal: AbortSignal.timeout(20000)
  })
  return res.text()
}

async function visitorFromSwJs(): Promise<string | null> {
  const res = await fetch(YOUTUBE_ORIGIN + '/sw.js_data', {
    headers: { 'User-Agent': WEB_UA, Cookie: CONSENT_COOKIES },
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) return null
  return scanForVisitorId(await res.text())
}

async function visitorFromInnertube(webVersion: string): Promise<string | null> {
  const res = await fetch(INNERTUBE_BASE + 'browse', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': WEB_UA,
      Origin: YOUTUBE_ORIGIN,
      Cookie: CONSENT_COOKIES,
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': webVersion
    },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: webVersion, hl: 'en', gl: 'US' } },
      browseId: 'FEwhat_to_watch'
    }),
    signal: AbortSignal.timeout(30000)
  })
  if (!res.ok) return null
  const json = (await res.json()) as { responseContext?: { visitorData?: string } }
  const visitor = json.responseContext?.visitorData
  return visitor && isPlausibleVisitorId(visitor) ? visitor : null
}

/** Does this token actually unlock playback? That is the only question that matters. */
async function visionosPlayer(visitor: string | null) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': VISIONOS_UA,
    Origin: YOUTUBE_ORIGIN,
    Cookie: CONSENT_COOKIES,
    'X-YouTube-Client-Name': '101',
    'X-YouTube-Client-Version': '1.02'
  }
  if (visitor) headers['X-Goog-Visitor-Id'] = visitor

  const res = await fetch(INNERTUBE_BASE + 'player', {
    method: 'POST',
    headers,
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
      videoId: VIDEO_ID,
      contentCheckOk: true,
      racyCheckOk: true
    }),
    signal: AbortSignal.timeout(30000)
  })
  const json = (await res.json()) as {
    playabilityStatus?: { status?: string }
    streamingData?: { adaptiveFormats?: unknown[] }
  }
  return {
    status: json.playabilityStatus?.status ?? 'NO_STATUS',
    formats: json.streamingData?.adaptiveFormats?.length ?? 0
  }
}

async function main() {
  console.log('\nthe validator accepts what YouTube actually serves')
  // 520 chars from the home page, 48 from the bootstrap: both must pass, and both
  // of those bounds have already been got wrong once.
  check('a 520-character token is accepted', isPlausibleVisitorId('Cg' + 'a'.repeat(515) + '%3D'))
  check('a 48-character bootstrap token is accepted', isPlausibleVisitorId('Cg' + 'b'.repeat(46)))
  check('markup is rejected', !isPlausibleVisitorId('</script><div class="x">'))
  check('an empty value is rejected', !isPlausibleVisitorId(''))

  console.log('\nsource 1 + 2: the home page')
  const body = await homePage()
  const webVersion = extractBetween(body, '"INNERTUBE_CLIENT_VERSION":"', '"') ?? '2.20260907.06.00'
  check('client version scraped', webVersion.length > 0, webVersion)

  let homeToken: string | null = null
  for (const marker of VISITOR_MARKERS) {
    const candidate = extractBetween(body, marker, '"')
    const ok = Boolean(candidate && isPlausibleVisitorId(candidate))
    check('marker ' + marker + ' yields a token', ok, ok ? candidate!.length + ' chars' : 'missing')
    if (ok && !homeToken) homeToken = candidate
  }

  console.log('\nsource 3: /sw.js_data')
  const swToken = await visitorFromSwJs()
  check('sw.js_data yields a token', Boolean(swToken), swToken ? swToken.length + ' chars' : 'missing')

  console.log('\nsource 4: responseContext bootstrap (depends on no page markup)')
  const bootToken = await visitorFromInnertube(webVersion)
  check('browse echoes a visitor id back', Boolean(bootToken), bootToken ? bootToken.length + ' chars' : 'missing')

  console.log('\nevery source must unlock the player, or it is not a fallback')
  const sources = [
    ['home page', homeToken],
    ['sw.js_data', swToken],
    ['responseContext', bootToken]
  ] as const
  for (const [label, token] of sources) {
    if (!token) {
      check(label + ' unlocks VISIONOS', false, 'no token to try')
      continue
    }
    const result = await visionosPlayer(token)
    check(
      label + ' unlocks VISIONOS',
      result.status === 'OK' && result.formats > 0,
      result.status + ', ' + result.formats + ' formats'
    )
  }

  console.log('\ncontrol: without a visitor id the player must still refuse')
  const control = await visionosPlayer(null)
  check('no visitor id -> LOGIN_REQUIRED', control.status === 'LOGIN_REQUIRED', control.status)

  console.log('\n================================')
  console.log('passed: ' + pass + '   failed: ' + fail + '   total: ' + (pass + fail))
  console.log('================================')
  if (fail > 0) process.exit(1)
}

main().catch(err => {
  console.error('threw:', err)
  process.exit(1)
})
