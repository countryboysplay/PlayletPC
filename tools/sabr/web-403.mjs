/**
 * Why does the WEB serverAbrStreamingUrl 403?
 *
 * Note `n` is NOT listed in `sparams`, so it is not signature-protected -- which
 * makes "the n parameter" a weaker explanation than it first looked. Read the
 * actual response instead of assuming.
 */

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
const VIDEO_ID = process.argv[2] || 'aqz-KE-bpKQ'

class Writer {
  constructor() { this.bytes = [] }
  varint(v) {
    let n = typeof v === 'bigint' ? v : BigInt(Math.trunc(v))
    if (n < 0n) n += 1n << 64n
    do { let b = Number(n & 0x7fn); n >>= 7n; if (n > 0n) b |= 0x80; this.bytes.push(b) } while (n > 0n)
    return this
  }
  tag(f, w) { return this.varint((f << 3) | w) }
  int(f, v) { return (v === undefined || v === null) ? this : this.tag(f, 0).varint(v) }
  bool(f, v) { return (v === undefined || v === null) ? this : this.tag(f, 0).varint(v ? 1 : 0) }
  float(f, v) {
    if (v === undefined || v === null) return this
    this.tag(f, 5); const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true)
    for (let i = 0; i < 4; i++) this.bytes.push(d.getUint8(i)); return this
  }
  bytes_(f, u8) { if (!u8) return this; this.tag(f, 2).varint(u8.length); for (const b of u8) this.bytes.push(b); return this }
  string(f, s) { return (s === undefined || s === null) ? this : this.bytes_(f, new TextEncoder().encode(s)) }
  message(f, fn) { const i = new Writer(); fn(i); return this.bytes_(f, i.finish()) }
  finish() { return new Uint8Array(this.bytes) }
}
const fid = (w, field, f) => w.message(field, m => {
  m.int(1, f.itag); if (f.lastModified) m.int(2, BigInt(f.lastModified)); if (f.xtags) m.string(3, f.xtags)
})
const b64 = s => new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))

async function scrapeIdentity() {
  const r = await fetch('https://www.youtube.com/', { headers: { 'User-Agent': CHROME_UA, 'Accept-Language': 'en-US,en;q=0.9' } })
  const html = await r.text()
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1]
  const visitorData = html.match(/"visitorData":"([^"]+)"/)?.[1]
  const jsPath = html.match(/"(\/s\/player\/[^"]+\/base\.js)"/)?.[1]
  let sts = null
  if (jsPath) {
    const b = await fetch('https://www.youtube.com' + jsPath, { headers: { 'User-Agent': CHROME_UA } })
    sts = (await b.text()).match(/signatureTimestamp[:=](\d+)/)?.[1]
  }
  return { clientVersion, visitorData, sts: sts ? Number(sts) : null, jsPath }
}

async function player(ident, poToken) {
  const body = {
    context: { client: { clientName: 'WEB', clientVersion: ident.clientVersion, visitorData: ident.visitorData, hl: 'en', gl: 'US' } },
    playbackContext: { contentPlaybackContext: { signatureTimestamp: ident.sts, html5Preference: 'HTML5_PREF_WANTS' } },
    videoId: VIDEO_ID, contentCheckOk: true, racyCheckOk: true
  }
  if (poToken) body.serviceIntegrityDimensions = { poToken }
  const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'User-Agent': CHROME_UA,
      'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': ident.clientVersion,
      Origin: 'https://www.youtube.com'
    },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
  })
  return res.json()
}

const ident = await scrapeIdentity()
let poToken = null
if (process.env.SABR_MINTER) {
  const { mintNode } = await import((await import('node:url')).pathToFileURL(process.env.SABR_MINTER).href)
  poToken = (await mintNode(ident.visitorData)).token
}
console.log(`clientVersion ${ident.clientVersion}  sts ${ident.sts}  poToken ${poToken ? poToken.length + ' chars' : 'none'}\n`)

const p = await player(ident, poToken)
const sd = p.streamingData
const cfg = p.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig
console.log(`playability ${p.playabilityStatus?.status}  formats ${sd?.adaptiveFormats?.length}  abrUrl ${sd?.serverAbrStreamingUrl ? 'y' : 'n'}  cfg ${cfg ? 'y' : 'n'}`)

const all = sd.adaptiveFormats
const a = all.filter(f => f.mimeType.startsWith('audio/') && !f.xtags).sort((x, y) => x.bitrate - y.bitrate)[0]
const v = all.filter(f => f.mimeType.startsWith('video/') && !f.xtags && f.height <= 480).sort((x, y) => y.height - x.height)[0]

function buildBody(pos) {
  const w = new Writer()
  w.message(1, s => { s.int(21, v.height); s.bool(22, false); s.int(28, pos * 1000); s.int(34, 1); s.float(35, 1); s.int(40, 0) })
  w.bytes_(5, b64(cfg))
  fid(w, 16, a); fid(w, 17, v)
  w.message(19, s => {
    s.message(1, c => { c.int(16, 1); c.string(17, ident.clientVersion); c.string(21, 'en'); c.string(22, 'US') })
    if (poToken) s.bytes_(2, b64(poToken))
  })
  return w.finish()
}

async function attempt(label, mutate) {
  const u = new URL(sd.serverAbrStreamingUrl)
  u.searchParams.set('rn', '1')
  mutate?.(u)
  let res, raw
  try {
    res = await fetch(u, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf', 'accept-encoding': 'identity',
        accept: 'application/vnd.yt-ump', 'User-Agent': CHROME_UA,
        Origin: 'https://www.youtube.com', Referer: 'https://www.youtube.com/'
      },
      body: buildBody(30), signal: AbortSignal.timeout(60000)
    })
    raw = Buffer.from(await res.arrayBuffer())
  } catch (e) { console.log(`${label.padEnd(28)} threw ${e.message}`); return }

  const text = raw.toString('utf8').replace(/\s+/g, ' ').slice(0, 200)
  console.log(`${label.padEnd(28)} HTTP ${res.status}  ${raw.length}B  ct=${res.headers.get('content-type')}`)
  if (res.status !== 200) {
    console.log(`   body: ${text || '(empty)'}`)
    for (const h of ['x-guploader-uploadid', 'x-bandwidth-app-limited', 'www-authenticate', 'x-content-type-options']) {
      const val = res.headers.get(h); if (val) console.log(`   ${h}: ${val}`)
    }
  }
}

console.log(`\nn param present: ${new URL(sd.serverAbrStreamingUrl).searchParams.get('n') ?? '(none)'}`)
console.log(`sparams: ${new URL(sd.serverAbrStreamingUrl).searchParams.get('sparams')}\n`)

await attempt('as-issued')
await attempt('n removed', u => u.searchParams.delete('n'))
await attempt('n mangled', u => u.searchParams.set('n', 'AAAAAAAAAAAAAAAA'))
await attempt('+pot query', u => { if (poToken) u.searchParams.set('pot', poToken) })
await attempt('no Origin/Referer diff', u => u.searchParams.set('rn', '2'))
