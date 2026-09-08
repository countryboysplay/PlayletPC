/**
 * The decisive test: pull continuous media over SABR well past the 60-second
 * wall that legacy `videoplayback` hits.
 *
 * Loops VideoPlaybackAbrRequest -> UMP response, advancing player_time_ms and
 * reporting buffered_ranges each round, exactly as the client is meant to.
 * Prints seconds of media accumulated per format.
 *
 * Usage: node stream.mjs [videoId] [targetSeconds]
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const OUT = process.env.SABR_OUT || '.'
const VIDEO_ID = process.argv[2] || 'aqz-KE-bpKQ'
const TARGET_S = Number(process.argv[3] || 300)

const IOS_VERSION = '20.10.4'
const IOS_UA = `com.google.ios.youtube/${IOS_VERSION} (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)`

// ---------------------------------------------------------------- protobuf write

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
    this.tag(f, 5)
    const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true)
    for (let i = 0; i < 4; i++) this.bytes.push(d.getUint8(i))
    return this
  }
  bytes_(f, u8) {
    if (!u8) return this
    this.tag(f, 2).varint(u8.length)
    for (const b of u8) this.bytes.push(b)
    return this
  }
  string(f, s) { return (s === undefined || s === null) ? this : this.bytes_(f, new TextEncoder().encode(s)) }
  message(f, fn) { const i = new Writer(); fn(i); return this.bytes_(f, i.finish()) }
  finish() { return new Uint8Array(this.bytes) }
}

function writeFormatId(w, field, f) {
  return w.message(field, m => {
    m.int(1, f.itag)
    if (f.lastModified) m.int(2, BigInt(f.lastModified))
    if (f.xtags) m.string(3, f.xtags)
  })
}

// ---------------------------------------------------------------- protobuf read

function readVarint(buf, o) {
  let v = 0n, shift = 0n
  while (o < buf.length) {
    const b = buf[o++]
    v |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) return [v, o]
    shift += 7n
    if (shift > 70n) return [null, o]
  }
  return [null, o]
}

/** Decode into { field: [values] }. Length-delimited values stay as raw Uint8Array. */
function decode(buf) {
  const out = {}
  let o = 0
  const push = (f, v) => { (out[f] ??= []).push(v) }
  while (o < buf.length) {
    const [tag, n] = readVarint(buf, o); if (tag === null) break
    o = n
    const field = Number(tag >> 3n), wire = Number(tag & 7n)
    if (wire === 0) { const [v, n2] = readVarint(buf, o); if (v === null) break; o = n2; push(field, v) }
    else if (wire === 2) {
      const [len, n2] = readVarint(buf, o); if (len === null) break
      o = n2; push(field, buf.subarray(o, o + Number(len))); o += Number(len)
    } else if (wire === 5) { push(field, buf.subarray(o, o + 4)); o += 4 }
    else if (wire === 1) { push(field, buf.subarray(o, o + 8)); o += 8 }
    else break
  }
  return out
}

const num = (m, f) => m[f]?.[0] !== undefined ? Number(m[f][0]) : undefined
const big = (m, f) => m[f]?.[0] !== undefined ? m[f][0] : undefined
const str = (m, f) => m[f]?.[0] ? new TextDecoder().decode(m[f][0]) : undefined
const sub = (m, f) => m[f]?.[0] ? decode(m[f][0]) : undefined

function readFormatId(m) {
  if (!m) return undefined
  return { itag: num(m, 1), lastModified: big(m, 2)?.toString(), xtags: str(m, 3) }
}
const formatKey = f => `${f.itag}:${f.lastModified}:${f.xtags ?? ''}`

// ---------------------------------------------------------------- UMP framing

function readUmpVarint(buf, offset) {
  if (offset >= buf.length) return null
  const first = buf[offset]
  const len = first < 128 ? 1 : first < 192 ? 2 : first < 224 ? 3 : first < 240 ? 4 : 5
  if (offset + len > buf.length) return null
  let value
  switch (len) {
    case 1: value = first; break
    case 2: value = (first & 0x3f) + 64 * buf[offset + 1]; break
    case 3: value = (first & 0x1f) + 32 * (buf[offset + 1] + 256 * buf[offset + 2]); break
    case 4: value = (first & 0x0f) + 16 * (buf[offset + 1] + 256 * (buf[offset + 2] + 256 * buf[offset + 3])); break
    default: value = buf[offset + 1] + 256 * (buf[offset + 2] + 256 * (buf[offset + 3] + 256 * buf[offset + 4])); break
  }
  return [value, offset + len]
}

function readUmpParts(buf) {
  const parts = []
  let offset = 0
  while (offset < buf.length) {
    const t = readUmpVarint(buf, offset); if (!t) break
    const s = readUmpVarint(buf, t[1]); if (!s) break
    const [type] = t, [size, dataStart] = s
    if (dataStart + size > buf.length) break
    parts.push({ type, size, data: buf.subarray(dataStart, dataStart + size) })
    offset = dataStart + size
  }
  return parts
}

const PART = {
  MEDIA_HEADER: 20, MEDIA: 21, MEDIA_END: 22, NEXT_REQUEST_POLICY: 35,
  FORMAT_INITIALIZATION_METADATA: 42, SABR_REDIRECT: 43, SABR_ERROR: 44,
  RELOAD_PLAYER_RESPONSE: 46, SELECTABLE_FORMATS: 51,
  STREAM_PROTECTION_STATUS: 58
}

// ---------------------------------------------------------------- live

/** Anonymous session identity. A PoToken is content-bound to this exact string. */
async function fetchVisitorData() {
  const res = await fetch('https://www.youtube.com/youtubei/v1/visitor_id', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': '2.20240304.00.00',
      Origin: 'https://www.youtube.com'
    },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20240304.00.00', hl: 'en', gl: 'US' } } }),
    signal: AbortSignal.timeout(20000)
  })
  const j = await res.json()
  return j?.responseContext?.visitorData ?? null
}

async function fetchPlayer(videoId, reloadToken = null, visitorData = null) {
  const client = {
    clientName: 'IOS', clientVersion: IOS_VERSION, deviceMake: 'Apple',
    deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en', gl: 'US'
  }
  if (visitorData) client.visitorData = visitorData
  const body = {
    context: { client },
    videoId, contentCheckOk: true, racyCheckOk: true
  }
  if (reloadToken) body.playbackContext = { reloadPlaybackContext: { reloadPlaybackParams: { token: reloadToken } } }
  const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'User-Agent': IOS_UA,
      'X-YouTube-Client-Name': '5', 'X-YouTube-Client-Version': IOS_VERSION,
      Origin: 'https://www.youtube.com'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  })
  return res.json()
}

function base64ToU8(b64) {
  return new Uint8Array(Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
}

function buildRequest({ ustreamerConfig, audio, video, playerTimeMs, bufferedRanges, selected, playbackCookie, poToken }) {
  const w = new Writer()

  w.message(1, s => {                        // ClientAbrState
    s.int(21, video.height || 360)           // sticky_resolution
    s.bool(22, false)                        // client_viewport_is_flexible
    s.int(28, playerTimeMs)                  // player_time_ms
    s.int(34, 1)                             // visibility
    s.float(35, 1)                           // playback_rate
    s.int(40, 0)                             // enabled_track_types_bitfield: video+audio
  })

  for (const f of selected) writeFormatId(w, 2, f)   // selected_format_ids

  for (const r of bufferedRanges) {                  // buffered_ranges
    w.message(3, b => {
      writeFormatId(b, 1, r.formatId)
      b.int(2, r.startTimeMs)
      b.int(3, r.durationMs)
      b.int(4, r.startSegmentIndex)
      b.int(5, r.endSegmentIndex)
      b.message(6, t => { t.int(1, 0); t.int(2, r.durationMs); t.int(3, 1000) })
    })
  }

  w.bytes_(5, base64ToU8(ustreamerConfig))           // video_playback_ustreamer_config
  writeFormatId(w, 16, audio)                        // preferred_audio_format_ids
  writeFormatId(w, 17, video)                        // preferred_video_format_ids

  w.message(19, s => {                               // StreamerContext
    s.message(1, c => {
      c.string(12, 'Apple'); c.string(13, 'iPhone16,2')
      c.int(16, 5); c.string(17, IOS_VERSION)
      c.string(18, 'iPhone'); c.string(19, '18.3.2.22D82')
      c.string(21, 'en'); c.string(22, 'US')
    })
    if (poToken) s.bytes_(2, base64ToU8(poToken))
    if (playbackCookie) s.bytes_(3, playbackCookie)
  })

  return w.finish()
}

async function main() {
  mkdirSync(OUT, { recursive: true })

  // A PoToken is bound to a visitorData string, so the same one must be used for
  // the /player call and the mint, or the server treats the token as unrelated.
  let poToken = process.env.SABR_POTOKEN || null
  let visitorData = process.env.SABR_VISITOR_DATA || null

  if (process.env.SABR_ATTEST && !poToken) {
    visitorData ??= await fetchVisitorData()
    if (!visitorData) { console.log('could not obtain visitorData'); process.exit(1) }
    console.log(`visitorData: ${visitorData.slice(0, 28)}... (${visitorData.length} chars)`)
    const minterPath = process.env.SABR_MINTER
    const { mintNode } = await import(pathToFileURL(minterPath).href)
    const t0 = Date.now()
    const r = await mintNode(visitorData)
    poToken = r.token
    console.log(`minted poToken in ${Date.now() - t0}ms: ${poToken.slice(0, 20)}... (${poToken.length} chars, ttl ${r.ttlSeconds}s)`)
  }

  console.log(`\nvideo ${VIDEO_ID}   target ${TARGET_S}s   poToken: ${poToken ? 'yes' : 'none'}   signed in: no\n`)

  const player = await fetchPlayer(VIDEO_ID, null, visitorData)
  const sd = player.streamingData ?? {}
  const ustreamerConfig = player.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig
  const durationS = Number(player.videoDetails?.lengthSeconds || 0)
  if (!sd.serverAbrStreamingUrl || !ustreamerConfig) { console.log('missing SABR fields'); process.exit(1) }

  const all = sd.adaptiveFormats ?? []
  const pick = (kind, cmp) => all.filter(f => f.mimeType.startsWith(kind) && !f.xtags).sort(cmp)[0]
  const audioF = pick('audio/', (a, b) => a.bitrate - b.bitrate)
  const videoF = all.filter(f => f.mimeType.startsWith('video/') && !f.xtags && f.height <= 480)
    .sort((a, b) => b.height - a.height)[0]

  const audio = { itag: audioF.itag, lastModified: audioF.lastModified, xtags: audioF.xtags }
  const video = { itag: videoF.itag, lastModified: videoF.lastModified, xtags: videoF.xtags, height: videoF.height }
  console.log(`duration ${durationS}s   audio itag ${audio.itag}   video itag ${video.itag} ${videoF.qualityLabel}\n`)

  let abrUrl = sd.serverAbrStreamingUrl
  let playbackCookie = null
  let rn = 1
  let playerTimeMs = 0

  /** per-format accumulated state, keyed by FormatId */
  const tracks = new Map()
  const trackOf = fid => {
    const k = formatKey(fid)
    if (!tracks.has(k)) tracks.set(k, { formatId: fid, durationMs: 0, bytes: 0, firstSeq: null, lastSeq: 0, initialized: false, mime: '' })
    return tracks.get(k)
  }

  let stalls = 0
  const started = Date.now()

  for (let round = 1; round <= 200; round++) {
    const bufferedRanges = [...tracks.values()]
      .filter(t => t.initialized && t.lastSeq > 0)
      .map(t => ({
        formatId: t.formatId, startTimeMs: 0, durationMs: t.durationMs,
        startSegmentIndex: t.firstSeq ?? 1, endSegmentIndex: t.lastSeq
      }))
    const selected = [...tracks.values()].filter(t => t.initialized).map(t => t.formatId)

    const body = buildRequest({
      ustreamerConfig, audio, video, playerTimeMs,
      bufferedRanges, selected, playbackCookie, poToken
    })

    const u = new URL(abrUrl)
    u.searchParams.set('rn', String(rn++))
    const res = await fetch(u, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf', 'accept-encoding': 'identity',
        accept: 'application/vnd.yt-ump', 'User-Agent': IOS_UA
      },
      body, signal: AbortSignal.timeout(60000)
    })
    const raw = new Uint8Array(await res.arrayBuffer())

    if (res.status !== 200) {
      console.log(`\nround ${round}: HTTP ${res.status} -- ${new TextDecoder().decode(raw.subarray(0, 300))}`)
      break
    }
    if (round === 1) writeFileSync(join(OUT, 'stream-response-1.bin'), raw)

    const parts = readUmpParts(raw)
    let current = null
    let roundMedia = 0
    let error = null, redirect = null

    for (const p of parts) {
      switch (p.type) {
        case PART.FORMAT_INITIALIZATION_METADATA: {
          const m = decode(p.data)
          const t = trackOf(readFormatId(sub(m, 2)))
          t.initialized = true
          t.mime = str(m, 5) ?? ''
          t.endSegmentNumber = num(m, 4)
          break
        }
        case PART.MEDIA_HEADER: {
          const m = decode(p.data)
          const fid = readFormatId(sub(m, 13)) ?? { itag: num(m, 3), lastModified: big(m, 4)?.toString(), xtags: str(m, 5) }
          const t = trackOf(fid)
          const seq = num(m, 9)
          const isInit = num(m, 8) === 1

          // These headers carry no start_ms/duration_ms (11/12). Timing lives in
          // time_range (15) as ticks against its own timescale.
          const tr = sub(m, 15)
          const ts = tr ? num(tr, 3) : undefined
          const durMs = num(m, 12)
            ?? (tr && ts ? Math.round((num(tr, 2) ?? 0) / ts * 1000) : 0)
          const startMs = num(m, 11)
            ?? (tr && ts ? Math.round((num(tr, 1) ?? 0) / ts * 1000) : 0)

          current = { track: t, headerId: num(m, 1) }
          if (!isInit && seq !== undefined && seq > t.lastSeq) {
            t.endMs = Math.max(t.endMs ?? 0, startMs + durMs)
            t.durationMs = t.endMs
            if (t.firstSeq === null) t.firstSeq = seq
            t.lastSeq = seq
          }
          break
        }
        case PART.MEDIA: {
          roundMedia += p.size
          if (current) current.track.bytes += p.size
          break
        }
        case PART.MEDIA_END: current = null; break
        case PART.NEXT_REQUEST_POLICY: {
          const m = decode(p.data)
          if (m[7]?.[0]) playbackCookie = m[7][0]   // pass the cookie back verbatim
          break
        }
        case PART.SABR_REDIRECT: redirect = str(decode(p.data), 1); break
        case PART.SABR_ERROR: {
          const m = decode(p.data)
          error = `${str(m, 1)} (code ${num(m, 2)})`
          break
        }
        case PART.RELOAD_PLAYER_RESPONSE: error = 'RELOAD_PLAYER_RESPONSE'; break
        case PART.STREAM_PROTECTION_STATUS: {
          const s = num(decode(p.data), 1)
          if (round === 1) console.log(`stream protection status: ${s}`)
          break
        }
      }
    }

    if (redirect) { abrUrl = redirect; console.log(`round ${round}: SABR_REDIRECT -> new host`); continue }
    if (error) { console.log(`\nround ${round}: ${error}`); break }

    const vTrack = [...tracks.values()].find(t => t.mime.startsWith('video/'))
    const aTrack = [...tracks.values()].find(t => t.mime.startsWith('audio/'))
    const prev = playerTimeMs
    playerTimeMs = Math.min(vTrack?.durationMs ?? 0, aTrack?.durationMs ?? 0)

    if (process.env.SABR_DEBUG) {
      const names = { 20: 'MEDIA_HEADER', 21: 'MEDIA', 22: 'MEDIA_END', 35: 'NEXT_REQ', 42: 'FMT_INIT', 43: 'REDIRECT', 44: 'ERROR', 46: 'RELOAD', 47: 'PLAYBACK_START', 48: 'ALLOWED_CACHED', 49: 'BW_START', 50: 'BW_PAUSE', 51: 'SELECTABLE', 52: 'REQ_ID', 53: 'CANCEL_POLICY', 58: 'PROTECTION', 61: 'SABR_ACK', 62: 'END_OF_TRACK', 63: 'CACHE_LOAD', 67: 'SNACKBAR' }
      const c = {}
      for (const p of parts) { const n = names[p.type] ?? p.type; c[n] = (c[n] ?? 0) + 1 }
      console.log(`   sent buffered: ${bufferedRanges.map(r => `itag${r.formatId.itag} 0-${r.durationMs}ms seg${r.startSegmentIndex}-${r.endSegmentIndex}`).join(' | ')}`)
      console.log(`   got parts: ${JSON.stringify(c)}  (${raw.length} bytes)`)
    }

    const v = ((vTrack?.durationMs ?? 0) / 1000).toFixed(1)
    const a = ((aTrack?.durationMs ?? 0) / 1000).toFixed(1)
    const mb = (([...tracks.values()].reduce((s, t) => s + t.bytes, 0)) / 1048576).toFixed(1)
    console.log(`round ${String(round).padStart(3)}  +${(roundMedia / 1024).toFixed(0).padStart(5)} KiB  video ${v.padStart(7)}s  audio ${a.padStart(7)}s  total ${mb} MiB`)

    if (playerTimeMs <= prev) {
      // Is the server gating on wall-clock time rather than refusing outright?
      // Sleep and ask again before concluding the stream is dead.
      const waitMs = Number(process.env.SABR_STALL_WAIT_MS ?? 0)
      if (waitMs && ++stalls <= 6) {
        console.log(`   stalled -- waiting ${waitMs}ms (${stalls}/6)`)
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }
      if (!waitMs && ++stalls >= 3) { console.log('\nno forward progress in 3 rounds -- stopping'); break }
      if (stalls > 6) { console.log('\nstill no progress after waiting -- stopping'); break }
    } else stalls = 0

    if (playerTimeMs >= TARGET_S * 1000) { console.log(`\nreached ${TARGET_S}s target`); break }
    if (durationS && playerTimeMs >= durationS * 1000) { console.log('\nreached end of video'); break }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`\n---- result ----`)
  for (const t of tracks.values()) {
    console.log(`${t.mime || 'itag ' + t.formatId.itag}  itag ${t.formatId.itag}  ${(t.durationMs / 1000).toFixed(1)}s  ${(t.bytes / 1048576).toFixed(2)} MiB  segments ${t.firstSeq ?? 0}..${t.lastSeq}`)
  }
  const secs = Math.min(...[...tracks.values()].filter(t => t.initialized).map(t => t.durationMs / 1000))
  console.log(`\ncontinuous media: ${secs.toFixed(1)}s   (${rn - 1} requests, ${elapsed}s wall clock)`)
  console.log(secs > 60 ? 'PASSED the 60-second wall' : 'DID NOT pass 60 seconds')
}

main().catch(e => { console.error('threw:', e); process.exit(1) })
