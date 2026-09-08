/**
 * Does the server serve media at an arbitrary playback position?
 *
 * One fresh request per position, empty buffered_ranges. If media comes back at
 * 300s then there is no 60-second cap and the earlier stall is our own
 * buffered-range reporting. If it refuses, the cap is real.
 */

const IOS_VERSION = '20.10.4'
const IOS_UA = `com.google.ios.youtube/${IOS_VERSION} (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)`
const VIDEO_ID = process.argv[2] || 'aqz-KE-bpKQ'
const POSITIONS = (process.argv[3] || '0,30,60,90,120,300,600').split(',').map(Number)

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
const sub = (m, f) => m[f]?.[0] ? decode(m[f][0]) : undefined

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

async function visitorId() {
  const res = await fetch('https://www.youtube.com/youtubei/v1/visitor_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': '2.20240304.00.00', Origin: 'https://www.youtube.com' },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20240304.00.00', hl: 'en', gl: 'US' } } }),
    signal: AbortSignal.timeout(20000)
  })
  return (await res.json())?.responseContext?.visitorData ?? null
}

async function player(videoId, visitorData, poToken) {
  const client = { clientName: 'IOS', clientVersion: IOS_VERSION, deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en', gl: 'US' }
  if (visitorData) client.visitorData = visitorData
  const body = { context: { client }, videoId, contentCheckOk: true, racyCheckOk: true }
  // The session-bound slot. Distinct from StreamerContext.po_token in the SABR body.
  if (poToken) body.serviceIntegrityDimensions = { poToken }
  const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': IOS_UA, 'X-YouTube-Client-Name': '5', 'X-YouTube-Client-Version': IOS_VERSION, Origin: 'https://www.youtube.com' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  })
  return res.json()
}

let visitorData = null, poToken = null
if (process.env.SABR_ATTEST) {
  visitorData = await visitorId()
  const { mintNode } = await import((await import('node:url')).pathToFileURL(process.env.SABR_MINTER).href)
  poToken = (await mintNode(visitorData)).token
  console.log("attested: visitorData " + visitorData.length + " chars, poToken " + poToken.length + " chars")
}

const p = await player(VIDEO_ID, visitorData, poToken)
const sd = p.streamingData
const cfg = p.playerConfig.mediaCommonConfig.mediaUstreamerRequestConfig.videoPlaybackUstreamerConfig
const all = sd.adaptiveFormats
const a = all.filter(f => f.mimeType.startsWith('audio/') && !f.xtags).sort((x, y) => x.bitrate - y.bitrate)[0]
const v = all.filter(f => f.mimeType.startsWith('video/') && !f.xtags && f.height <= 480).sort((x, y) => y.height - x.height)[0]
console.log(`${VIDEO_ID}  duration ${p.videoDetails.lengthSeconds}s  audio ${a.itag}  video ${v.itag} ${v.qualityLabel}\n`)
console.log('pos(s)  http  bytes   media   video segs (start..end)      audio segs')

let rn = 1
for (const pos of POSITIONS) {
  const w = new Writer()
  w.message(1, s => {
    s.int(21, v.height); s.bool(22, false); s.int(28, pos * 1000)
    s.int(34, 1); s.float(35, 1); s.int(40, 0)
  })
  w.bytes_(5, b64(cfg))
  fid(w, 16, a); fid(w, 17, v)
  w.message(19, s => {
    s.message(1, c => {
      c.string(12, 'Apple'); c.string(13, 'iPhone16,2'); c.int(16, 5); c.string(17, IOS_VERSION)
      c.string(18, 'iPhone'); c.string(19, '18.3.2.22D82'); c.string(21, 'en'); c.string(22, 'US')
    })
    if (poToken) s.bytes_(2, b64(poToken))
  })

  const u = new URL(sd.serverAbrStreamingUrl)
  u.searchParams.set('rn', String(rn++))
  const res = await fetch(u, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf', 'accept-encoding': 'identity', accept: 'application/vnd.yt-ump', 'User-Agent': IOS_UA },
    body: w.finish(), signal: AbortSignal.timeout(60000)
  })
  const raw = new Uint8Array(await res.arrayBuffer())

  let media = 0
  const seg = { }
  let err = null
  for (const part of parts(raw)) {
    if (part.type === 21) media += part.size
    else if (part.type === 20) {
      const m = decode(part.data)
      const itag = num(m, 3) ?? num(sub(m, 13) ?? {}, 1)
      const tr = sub(m, 15); const ts = tr ? num(tr, 3) : 0
      const startS = tr && ts ? (num(tr, 1) ?? 0) / ts : null
      const s = num(m, 9)
      if (s !== undefined) {
        seg[itag] ??= { lo: s, hi: s, t0: startS, t1: startS }
        seg[itag].lo = Math.min(seg[itag].lo, s); seg[itag].hi = Math.max(seg[itag].hi, s)
        if (startS !== null) { seg[itag].t0 = Math.min(seg[itag].t0 ?? startS, startS); seg[itag].t1 = Math.max(seg[itag].t1 ?? startS, startS) }
      }
    } else if (part.type === 44) { const m = decode(part.data); err = `${str(m, 1)}/${num(m, 2)}` }
  }
  const fmt = itag => seg[itag] ? `${seg[itag].lo}..${seg[itag].hi} @${(seg[itag].t0 ?? 0).toFixed(0)}-${(seg[itag].t1 ?? 0).toFixed(0)}s` : '-'
  console.log(`${String(pos).padStart(6)}  ${res.status}  ${String(raw.length).padStart(7)}  ${String((media / 1024).toFixed(0)).padStart(6)}K  ${fmt(v.itag).padEnd(26)} ${fmt(a.itag)}${err ? '  ERR ' + err : ''}`)
}
