/**
 * Is ANY client identity uncapped past 60 seconds over SABR?
 *
 * The cap is an attestation boundary, and attestation requirements differ per
 * client. Embedded and VR clients are historically the least restricted. This
 * probes each at 30s (control, known to work on IOS) and 120s (past the wall).
 */

const VIDEO_ID = process.argv[2] || 'aqz-KE-bpKQ'
const POSITIONS = (process.argv[3] || '30,120').split(',').map(Number)
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'

const CLIENTS = {
  IOS: {
    n: 5, ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    ctx: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' }
  },
  ANDROID_VR: {
    n: 28, ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; GB) gzip',
    ctx: { clientName: 'ANDROID_VR', clientVersion: '1.60.19', deviceMake: 'Oculus', deviceModel: 'Quest 3', osName: 'Android', osVersion: '12', androidSdkVersion: 32 }
  },
  WEB_EMBEDDED_PLAYER: {
    n: 56, ua: CHROME_UA,
    ctx: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20260907.00.00' },
    embed: true
  },
  TVHTML5_SIMPLY_EMBEDDED_PLAYER: {
    n: 85, ua: 'Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
    ctx: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0' },
    embed: true
  },
  WEB_CREATOR: {
    n: 62, ua: CHROME_UA,
    ctx: { clientName: 'WEB_CREATOR', clientVersion: '1.20260907.00.00' }
  },
  MWEB: {
    n: 2, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    ctx: { clientName: 'MWEB', clientVersion: '2.20260907.06.00' }
  }
}

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

async function scrapeIdentity() {
  const r = await fetch('https://www.youtube.com/', { headers: { 'User-Agent': CHROME_UA, 'Accept-Language': 'en-US,en;q=0.9' } })
  const html = await r.text()
  const jsPath = html.match(/"(\/s\/player\/[^"]+\/base\.js)"/)?.[1]
  let sts = null
  if (jsPath) sts = (await (await fetch('https://www.youtube.com' + jsPath, { headers: { 'User-Agent': CHROME_UA } })).text()).match(/signatureTimestamp[:=](\d+)/)?.[1]
  return {
    clientVersion: html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1],
    visitorData: html.match(/"visitorData":"([^"]+)"/)?.[1],
    sts: sts ? Number(sts) : null
  }
}

async function player(c, ident, poToken) {
  const ctx = { ...c.ctx, hl: 'en', gl: 'US' }
  if (ident.visitorData) ctx.visitorData = ident.visitorData
  const body = { context: { client: ctx }, videoId: VIDEO_ID, contentCheckOk: true, racyCheckOk: true }
  if (ident.sts) body.playbackContext = { contentPlaybackContext: { signatureTimestamp: ident.sts, html5Preference: 'HTML5_PREF_WANTS' } }
  if (c.embed) body.context.thirdParty = { embedUrl: 'https://www.youtube.com/' }
  if (poToken) body.serviceIntegrityDimensions = { poToken }
  const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'User-Agent': c.ua,
      'X-YouTube-Client-Name': String(c.n), 'X-YouTube-Client-Version': c.ctx.clientVersion,
      Origin: 'https://www.youtube.com'
    },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
  })
  return res.json()
}

async function run(label, c, ident, poToken) {
  let p
  try { p = await player(c, ident, poToken) } catch (e) { console.log(`${label.padEnd(34)} threw ${e.message}`); return }
  const st = p?.playabilityStatus?.status
  const sd = p?.streamingData
  const cfg = p?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig
  if (!sd?.serverAbrStreamingUrl || !cfg) {
    console.log(`${label.padEnd(34)} ${String(st).padEnd(11)} no SABR (formats ${sd?.adaptiveFormats?.length ?? 0}) ${(p?.playabilityStatus?.reason ?? '').slice(0, 40)}`)
    return
  }
  const all = sd.adaptiveFormats ?? []
  const a = all.filter(f => f.mimeType.startsWith('audio/') && !f.xtags).sort((x, y) => x.bitrate - y.bitrate)[0]
  const v = all.filter(f => f.mimeType.startsWith('video/') && !f.xtags && f.height <= 480).sort((x, y) => y.height - x.height)[0]
  if (!a || !v) { console.log(`${label.padEnd(34)} ${st} no a/v`); return }

  const out = []
  let rn = 1
  for (const pos of POSITIONS) {
    const w = new Writer()
    w.message(1, s => { s.int(21, v.height); s.bool(22, false); s.int(28, pos * 1000); s.int(34, 1); s.float(35, 1); s.int(40, 0) })
    w.bytes_(5, b64(cfg))
    fid(w, 16, a); fid(w, 17, v)
    w.message(19, s => {
      s.message(1, cc => {
        if (c.ctx.deviceMake) cc.string(12, c.ctx.deviceMake)
        if (c.ctx.deviceModel) cc.string(13, c.ctx.deviceModel)
        cc.int(16, c.n); cc.string(17, c.ctx.clientVersion)
        if (c.ctx.osName) cc.string(18, c.ctx.osName)
        if (c.ctx.osVersion) cc.string(19, c.ctx.osVersion)
        cc.string(21, 'en'); cc.string(22, 'US')
      })
      if (poToken) s.bytes_(2, b64(poToken))
    })
    const u = new URL(sd.serverAbrStreamingUrl)
    u.searchParams.set('rn', String(rn++))
    try {
      const res = await fetch(u, {
        method: 'POST',
        headers: { 'content-type': 'application/x-protobuf', 'accept-encoding': 'identity', accept: 'application/vnd.yt-ump', 'User-Agent': c.ua },
        body: w.finish(), signal: AbortSignal.timeout(60000)
      })
      const raw = new Uint8Array(await res.arrayBuffer())
      if (res.status !== 200) { out.push(`${pos}s:HTTP${res.status}`); continue }
      let media = 0, prot = null, err = null
      for (const part of parts(raw)) {
        if (part.type === 21) media += part.size
        else if (part.type === 58) prot = num(decode(part.data), 1)
        else if (part.type === 44) err = str(decode(part.data), 1)
      }
      out.push(`${pos}s:${media > 0 ? (media / 1024).toFixed(0) + 'K' : 'EMPTY'}${prot !== null ? '[p' + prot + ']' : ''}${err ? '(' + err + ')' : ''}`)
    } catch (e) { out.push(`${pos}s:THREW`) }
  }
  const win = out.length > 1 && /^\d+s:\d+K/.test(out[out.length - 1])
  console.log(`${label.padEnd(34)} ${String(st).padEnd(11)} itag ${String(v.itag).padEnd(4)} ${out.join('  ')}${win ? '   <<< PAST 60s' : ''}`)
}

const ident = await scrapeIdentity()
let poToken = null
if (process.env.SABR_MINTER) {
  const { mintNode } = await import((await import('node:url')).pathToFileURL(process.env.SABR_MINTER).href)
  poToken = (await mintNode(ident.visitorData)).token
}
console.log(`\n${VIDEO_ID}   clientVersion ${ident.clientVersion}   sts ${ident.sts}   poToken ${poToken ? poToken.length + ' chars' : 'none'}`)
console.log(`positions ${POSITIONS.join(', ')}s    [pN] = STREAM_PROTECTION_STATUS\n`)

for (const [name, c] of Object.entries(CLIENTS)) {
  await run(name, c, ident, null)
  if (poToken) await run(`${name} +poToken`, c, ident, poToken)
}
