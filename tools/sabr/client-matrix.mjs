/**
 * Which client identity gets media past 60 seconds over SABR?
 *
 * The PoToken our minter produces is a WEB-class token (REQUEST_KEY is the web
 * BotGuard key). Pairing it with an IOS context is a mismatch, which would
 * explain why adding it changed nothing. This probes each client with and
 * without a matching token.
 */

import { pathToFileURL } from 'node:url'

const VIDEO_ID = process.argv[2] || 'aqz-KE-bpKQ'
const POSITIONS = (process.argv[3] || '30,120').split(',').map(Number)

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'

const CLIENTS = {
  WEB: {
    nameInt: 1, ua: CHROME_UA,
    ctx: { clientName: 'WEB', clientVersion: '2.20240304.00.00', hl: 'en', gl: 'US' }
  },
  IOS: {
    nameInt: 5, ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    ctx: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en', gl: 'US' }
  },
  ANDROID: {
    nameInt: 3, ua: 'com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip',
    ctx: { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 34, osName: 'Android', osVersion: '14', hl: 'en', gl: 'US' }
  },
  MWEB: {
    nameInt: 2, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    ctx: { clientName: 'MWEB', clientVersion: '2.20240304.08.00', hl: 'en', gl: 'US' }
  }
}

// ---------------- protobuf ----------------
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
function readVarint(buf, o) {
  let v = 0n, s = 0n
  while (o < buf.length) { const b = buf[o++]; v |= BigInt(b & 0x7f) << s; if ((b & 0x80) === 0) return [v, o]; s += 7n; if (s > 70n) return [null, o] }
  return [null, o]
}
function decode(buf) {
  const out = {}; let o = 0
  while (o < buf.length) {
    const [t, n] = readVarint(buf, o); if (t === null) break; o = n
    const f = Number(t >> 3n), w = Number(t & 7n)
    const push = v => (out[f] ??= []).push(v)
    if (w === 0) { const [v, n2] = readVarint(buf, o); if (v === null) break; o = n2; push(v) }
    else if (w === 2) { const [l, n2] = readVarint(buf, o); if (l === null) break; o = n2; push(buf.subarray(o, o + Number(l))); o += Number(l) }
    else if (w === 5) { push(buf.subarray(o, o + 4)); o += 4 }
    else if (w === 1) { push(buf.subarray(o, o + 8)); o += 8 }
    else break
  }
  return out
}
const num = (m, f) => m[f]?.[0] !== undefined ? Number(m[f][0]) : undefined
const str = (m, f) => m[f]?.[0] ? new TextDecoder().decode(m[f][0]) : undefined
function umpVarint(buf, o) {
  if (o >= buf.length) return null
  const f = buf[o], len = f < 128 ? 1 : f < 192 ? 2 : f < 224 ? 3 : f < 240 ? 4 : 5
  if (o + len > buf.length) return null
  let v
  switch (len) {
    case 1: v = f; break
    case 2: v = (f & 0x3f) + 64 * buf[o + 1]; break
    case 3: v = (f & 0x1f) + 32 * (buf[o + 1] + 256 * buf[o + 2]); break
    case 4: v = (f & 0x0f) + 16 * (buf[o + 1] + 256 * (buf[o + 2] + 256 * buf[o + 3])); break
    default: v = buf[o + 1] + 256 * (buf[o + 2] + 256 * (buf[o + 3] + 256 * buf[o + 4])); break
  }
  return [v, o + len]
}
function parts(buf) {
  const out = []; let o = 0
  while (o < buf.length) {
    const t = umpVarint(buf, o); if (!t) break
    const s = umpVarint(buf, t[1]); if (!s) break
    if (s[1] + s[0] > buf.length) break
    out.push({ type: t[0], size: s[0], data: buf.subarray(s[1], s[1] + s[0]) })
    o = s[1] + s[0]
  }
  return out
}
const b64 = s => new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))

// ---------------- live ----------------

/** Live WEB identity. A stale clientVersion or a missing STS gets 'Video unavailable'. */
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
  return { clientVersion, visitorData, sts: sts ? Number(sts) : null }
}

async function visitorId() {
  const res = await fetch('https://www.youtube.com/youtubei/v1/visitor_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': '2.20240304.00.00', Origin: 'https://www.youtube.com' },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20240304.00.00', hl: 'en', gl: 'US' } } }),
    signal: AbortSignal.timeout(20000)
  })
  return (await res.json())?.responseContext?.visitorData ?? null
}

async function player(client, videoId, visitorData, poToken) {
  const ctx = { ...client.ctx }
  if (visitorData) ctx.visitorData = visitorData
  const body = { context: { client: ctx }, videoId, contentCheckOk: true, racyCheckOk: true }
  if (STS) body.playbackContext = { contentPlaybackContext: { signatureTimestamp: STS, html5Preference: 'HTML5_PREF_WANTS' } }
  if (poToken) body.serviceIntegrityDimensions = { poToken }
  const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'User-Agent': client.ua,
      'X-YouTube-Client-Name': String(client.nameInt),
      'X-YouTube-Client-Version': client.ctx.clientVersion,
      Origin: 'https://www.youtube.com'
    },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
  })
  return res.json()
}

async function probe(label, client, visitorData, poToken) {
  let p
  try { p = await player(client, VIDEO_ID, visitorData, poToken) }
  catch (e) { console.log(`${label.padEnd(22)} player threw: ${e.message}`); return }

  const status = p?.playabilityStatus?.status
  const sd = p?.streamingData
  const cfg = p?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig
  if (!sd?.serverAbrStreamingUrl || !cfg) {
    console.log(`${label.padEnd(22)} ${status}  abrUrl:${sd?.serverAbrStreamingUrl ? 'y' : 'n'} cfg:${cfg ? 'y' : 'n'}  formats:${sd?.adaptiveFormats?.length ?? 0}  ${p?.playabilityStatus?.reason ?? ''}`)
    return
  }

  const all = sd.adaptiveFormats ?? []
  const a = all.filter(f => f.mimeType.startsWith('audio/') && !f.xtags).sort((x, y) => x.bitrate - y.bitrate)[0]
  const v = all.filter(f => f.mimeType.startsWith('video/') && !f.xtags && f.height <= 480).sort((x, y) => y.height - x.height)[0]
  if (!a || !v) { console.log(`${label.padEnd(22)} ${status}  no usable a/v formats`); return }

  const results = []
  let rn = 1
  for (const pos of POSITIONS) {
    const w = new Writer()
    w.message(1, s => { s.int(21, v.height); s.bool(22, false); s.int(28, pos * 1000); s.int(34, 1); s.float(35, 1); s.int(40, 0) })
    w.bytes_(5, b64(cfg))
    fid(w, 16, a); fid(w, 17, v)
    w.message(19, s => {
      s.message(1, c => {
        if (client.ctx.deviceMake) c.string(12, client.ctx.deviceMake)
        if (client.ctx.deviceModel) c.string(13, client.ctx.deviceModel)
        c.int(16, client.nameInt); c.string(17, client.ctx.clientVersion)
        if (client.ctx.osName) c.string(18, client.ctx.osName)
        if (client.ctx.osVersion) c.string(19, client.ctx.osVersion)
        c.string(21, 'en'); c.string(22, 'US')
      })
      if (poToken) s.bytes_(2, b64(poToken))
    })

    const u = new URL(sd.serverAbrStreamingUrl)
    u.searchParams.set('rn', String(rn++))
    let raw, http
    try {
      const res = await fetch(u, {
        method: 'POST',
        headers: { 'content-type': 'application/x-protobuf', 'accept-encoding': 'identity', accept: 'application/vnd.yt-ump', 'User-Agent': client.ua },
        body: w.finish(), signal: AbortSignal.timeout(60000)
      })
      http = res.status
      raw = new Uint8Array(await res.arrayBuffer())
    } catch (e) { results.push(`${pos}s:THREW`); continue }

    let media = 0, err = null, prot = null
    for (const part of parts(raw)) {
      if (part.type === 21) media += part.size
      else if (part.type === 44) { const m = decode(part.data); err = `${str(m, 1)}` }
      else if (part.type === 58) prot = num(decode(part.data), 1)
    }
    results.push(`${pos}s:${http === 200 ? (media > 0 ? (media / 1024).toFixed(0) + 'K' : 'EMPTY') : 'HTTP' + http}${err ? '(' + err + ')' : ''}${prot !== null ? '[p' + prot + ']' : ''}`)
  }
  console.log(`${label.padEnd(22)} ${String(status).padEnd(3)}  itag ${String(v.itag).padEnd(4)} ${results.join('  ')}`)
}

const ident = await scrapeIdentity()
if (ident.clientVersion) CLIENTS.WEB.ctx.clientVersion = ident.clientVersion
const STS = ident.sts
const visitorData = ident.visitorData ?? await visitorId()
console.log()
let poToken = null
if (process.env.SABR_MINTER) {
  const { mintNode } = await import(pathToFileURL(process.env.SABR_MINTER).href)
  poToken = (await mintNode(visitorData)).token
}
console.log(`\nvideo ${VIDEO_ID}   visitorData ${visitorData?.length} chars   poToken ${poToken ? poToken.length + ' chars (WEB-class)' : 'none'}`)
console.log(`positions ${POSITIONS.join(', ')}s   EMPTY = 200 OK but zero media\n`)

for (const [name, client] of Object.entries(CLIENTS)) {
  await probe(`${name} bare`, client, null, null)
  await probe(`${name} +visitorData`, client, visitorData, null)
  if (poToken) await probe(`${name} +vd +poToken`, client, visitorData, poToken)
}
