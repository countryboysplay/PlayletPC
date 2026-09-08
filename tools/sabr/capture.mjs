/**
 * SABR ground-truth capture.
 *
 * Fetches a live iOS player response, builds a VideoPlaybackAbrRequest by hand,
 * POSTs it to serverAbrStreamingUrl, and dumps the raw UMP response plus a
 * parsed part listing. Nothing here ships -- this exists to produce fixtures.
 *
 * Message shapes taken from LuanRT/googlevideo protos (fetched, not remembered):
 *   VideoPlaybackAbrRequest, ClientAbrState, StreamerContext, misc.FormatId
 * UMP framing taken from src/core/UmpReader.ts.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.env.SABR_OUT || '.'
const VIDEO_ID = process.argv[2] || 'aqz-KE-bpKQ'

const IOS_VERSION = '20.10.4'
const IOS_UA = `com.google.ios.youtube/${IOS_VERSION} (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)`

// ---------------------------------------------------------------- protobuf writer

class Writer {
  constructor() { this.bytes = [] }

  varint(v) {
    let n = typeof v === 'bigint' ? v : BigInt(Math.trunc(v))
    if (n < 0n) n += 1n << 64n            // two's complement, as proto2 int64 does
    do {
      let byte = Number(n & 0x7fn)
      n >>= 7n
      if (n > 0n) byte |= 0x80
      this.bytes.push(byte)
    } while (n > 0n)
    return this
  }

  tag(field, wire) { return this.varint((field << 3) | wire) }

  int(field, v) {
    if (v === undefined || v === null) return this
    return this.tag(field, 0).varint(v)
  }

  bool(field, v) {
    if (v === undefined || v === null) return this
    return this.tag(field, 0).varint(v ? 1 : 0)
  }

  float(field, v) {
    if (v === undefined || v === null) return this
    this.tag(field, 5)
    const buf = new DataView(new ArrayBuffer(4))
    buf.setFloat32(0, v, true)
    for (let i = 0; i < 4; i++) this.bytes.push(buf.getUint8(i))
    return this
  }

  bytes_(field, u8) {
    if (!u8) return this
    this.tag(field, 2).varint(u8.length)
    for (const b of u8) this.bytes.push(b)
    return this
  }

  string(field, s) {
    if (s === undefined || s === null) return this
    return this.bytes_(field, new TextEncoder().encode(s))
  }

  message(field, fn) {
    const inner = new Writer()
    fn(inner)
    return this.bytes_(field, inner.finish())
  }

  finish() { return new Uint8Array(this.bytes) }
}

/** misc.FormatId { itag = 1, last_modified = 2, xtags = 3 } */
function formatId(w, field, f) {
  return w.message(field, m => {
    m.int(1, f.itag)
    if (f.lastModified) m.int(2, BigInt(f.lastModified))
    if (f.xtags) m.string(3, f.xtags)
  })
}

// ---------------------------------------------------------------- UMP reader

const PART_NAMES = {
  10: 'ONESIE_HEADER', 11: 'ONESIE_DATA', 12: 'ONESIE_ENCRYPTED_MEDIA',
  20: 'MEDIA_HEADER', 21: 'MEDIA', 22: 'MEDIA_END', 30: 'CONFIG',
  31: 'LIVE_METADATA', 35: 'NEXT_REQUEST_POLICY',
  36: 'USTREAMER_VIDEO_AND_FORMAT_METADATA', 37: 'FORMAT_SELECTION_CONFIG',
  38: 'USTREAMER_SELECTED_MEDIA_STREAM', 42: 'FORMAT_INITIALIZATION_METADATA',
  43: 'SABR_REDIRECT', 44: 'SABR_ERROR', 45: 'SABR_SEEK',
  46: 'RELOAD_PLAYER_RESPONSE', 47: 'PLAYBACK_START_POLICY',
  48: 'ALLOWED_CACHED_FORMATS', 49: 'START_BW_SAMPLING_HINT',
  50: 'PAUSE_BW_SAMPLING_HINT', 51: 'SELECTABLE_FORMATS',
  52: 'REQUEST_IDENTIFIER', 53: 'REQUEST_CANCELLATION_POLICY',
  54: 'ONESIE_PREFETCH_REJECTION', 55: 'TIMELINE_CONTEXT', 56: 'REQUEST_PIPELINING',
  57: 'SABR_CONTEXT_UPDATE', 58: 'STREAM_PROTECTION_STATUS',
  59: 'SABR_CONTEXT_SENDING_POLICY', 60: 'LAWNMOWER_POLICY', 61: 'SABR_ACK',
  62: 'END_OF_TRACK', 63: 'CACHE_LOAD_POLICY', 64: 'LAWNMOWER_MESSAGING_POLICY',
  65: 'PREWARM_CONNECTION', 66: 'PLAYBACK_DEBUG_INFO', 67: 'SNACKBAR_MESSAGE'
}

/** UMP's own variable-length int -- NOT a protobuf varint. Length is in the first byte. */
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
    const t = readUmpVarint(buf, offset)
    if (!t) break
    const s = readUmpVarint(buf, t[1])
    if (!s) break
    const [type] = t
    const [size, dataStart] = s
    if (dataStart + size > buf.length) {
      parts.push({ type, size, data: buf.subarray(dataStart), truncated: true })
      break
    }
    parts.push({ type, size, data: buf.subarray(dataStart, dataStart + size) })
    offset = dataStart + size
  }
  return parts
}

/** Generic protobuf dump -- enough to read a part without generated code. */
function dumpProto(buf, depth = 0) {
  const pad = '  '.repeat(depth + 1)
  const out = []
  let o = 0
  while (o < buf.length) {
    let [tag, n] = readProtoVarint(buf, o)
    if (tag === null) break
    o = n
    const field = Number(tag >> 3n), wire = Number(tag & 7n)
    if (wire === 0) {
      const [v, n2] = readProtoVarint(buf, o); if (v === null) break
      o = n2; out.push(`${pad}${field}: ${v}`)
    } else if (wire === 2) {
      const [len, n2] = readProtoVarint(buf, o); if (len === null) break
      o = n2
      const slice = buf.subarray(o, o + Number(len)); o += Number(len)
      const text = tryText(slice)
      if (text !== null) out.push(`${pad}${field}: "${text}"`)
      else {
        const nestedDump = depth < 3 ? dumpProto(slice, depth + 1) : ''
        if (nestedDump.trim()) out.push(`${pad}${field}: {\n${nestedDump}${pad}}`)
        else out.push(`${pad}${field}: <${slice.length} bytes>`)
      }
    } else if (wire === 5) {
      const dv = new DataView(buf.buffer, buf.byteOffset + o, 4)
      out.push(`${pad}${field}: ${dv.getFloat32(0, true)}f`); o += 4
    } else if (wire === 1) {
      out.push(`${pad}${field}: <fixed64>`); o += 8
    } else break
  }
  return out.join('\n') + (out.length ? '\n' : '')
}

function readProtoVarint(buf, offset) {
  let v = 0n, shift = 0n
  while (offset < buf.length) {
    const b = buf[offset++]
    v |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) return [v, offset]
    shift += 7n
    if (shift > 70n) return [null, offset]
  }
  return [null, offset]
}

function tryText(u8) {
  if (u8.length === 0 || u8.length > 400) return null
  for (const b of u8) if (b < 0x20 && b !== 9 && b !== 10 && b !== 13) return null
  const s = new TextDecoder('utf-8', { fatal: false }).decode(u8)
  return /�/.test(s) ? null : s
}

// ---------------------------------------------------------------- live calls

async function fetchPlayer(videoId, reloadToken = null) {
  const body = {
    context: {
      client: {
        clientName: 'IOS', clientVersion: IOS_VERSION,
        deviceMake: 'Apple', deviceModel: 'iPhone16,2',
        osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en', gl: 'US'
      }
    },
    videoId, contentCheckOk: true, racyCheckOk: true
  }
  if (reloadToken) {
    body.playbackContext = { reloadPlaybackContext: { reloadPlaybackParams: { token: reloadToken } } }
  }
  const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': IOS_UA,
      'X-YouTube-Client-Name': '5',
      'X-YouTube-Client-Version': IOS_VERSION,
      Origin: 'https://www.youtube.com'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  })
  return res.json()
}

/** Pull field 1.1 (reload_playback_params.token) out of a RELOAD_PLAYER_RESPONSE part. */
function reloadTokenOf(part) {
  let o = 0
  const [tag, n] = readProtoVarint(part, o); if (tag === null) return null
  if (Number(tag >> 3n) !== 1) return null
  const [len, n2] = readProtoVarint(part, n); if (len === null) return null
  const inner = part.subarray(n2, n2 + Number(len))
  const [tag2, m] = readProtoVarint(inner, 0); if (tag2 === null) return null
  if (Number(tag2 >> 3n) !== 1) return null
  const [len2, m2] = readProtoVarint(inner, m); if (len2 === null) return null
  return new TextDecoder().decode(inner.subarray(m2, m2 + Number(len2)))
}

function buildAbrRequest({ ustreamerConfig, audio, video, playerTimeMs = 0, poToken = null }) {
  const w = new Writer()

  // 1: ClientAbrState
  w.message(1, s => {
    s.int(21, video.height || 360)          // sticky_resolution
    s.int(28, playerTimeMs)                 // player_time_ms
    s.int(34, 1)                            // visibility
    s.float(35, 1)                          // playback_rate
    s.int(40, 0)                            // enabled_track_types_bitfield: 0 = video+audio
    s.bool(22, false)                       // client_viewport_is_flexible
  })

  // 5: video_playback_ustreamer_config
  w.bytes_(5, base64ToU8(ustreamerConfig))

  // 16/17: preferred audio / video format ids
  formatId(w, 16, audio)
  formatId(w, 17, video)

  // 19: StreamerContext
  w.message(19, s => {
    s.message(1, c => {                     // ClientInfo
      c.string(12, 'Apple')                 // device_make
      c.string(13, 'iPhone16,2')            // device_model
      c.int(16, 5)                          // client_name: IOS
      c.string(17, IOS_VERSION)             // client_version
      c.string(18, 'iPhone')                // os_name
      c.string(19, '18.3.2.22D82')          // os_version
      c.string(21, 'en')                    // accept_language
      c.string(22, 'US')                    // accept_region
    })
    if (poToken) s.bytes_(2, base64ToU8(poToken))
  })

  return w.finish()
}

function base64ToU8(b64) {
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/')
  return new Uint8Array(Buffer.from(norm, 'base64'))
}

async function sabrRequest(url, body, rn) {
  const u = new URL(url)
  u.searchParams.set('rn', String(rn))
  const res = await fetch(u, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-protobuf',
      'accept-encoding': 'identity',
      accept: 'application/vnd.yt-ump',
      'User-Agent': IOS_UA
    },
    body,
    signal: AbortSignal.timeout(60000)
  })
  const raw = new Uint8Array(await res.arrayBuffer())
  return { res, raw }
}

function report(raw, label) {
  const parts = readUmpParts(raw)
  let mediaBytes = 0
  for (const p of parts) {
    const name = PART_NAMES[p.type] ?? `UNKNOWN(${p.type})`
    if (p.type === 21) { mediaBytes += p.size; continue }
    console.log(`[${p.type}] ${name}  ${p.size} bytes${p.truncated ? ' TRUNCATED' : ''}`)
    if (p.size > 0 && p.size < 1200 && p.type !== 51) {
      const d = dumpProto(p.data)
      if (d.trim()) console.log(d)
    }
  }
  const mediaParts = parts.filter(p => p.type === 21).length
  console.log(`[21] MEDIA x${mediaParts}  ${mediaBytes} bytes total`)
  const counts = {}
  for (const p of parts) counts[PART_NAMES[p.type] ?? p.type] = (counts[PART_NAMES[p.type] ?? p.type] ?? 0) + 1
  console.log(`summary ${label}:`, JSON.stringify(counts))
  return { parts, mediaBytes }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  console.log(`video: ${VIDEO_ID}`)

  const poToken = process.env.SABR_POTOKEN || null
  if (poToken) console.log(`poToken: supplied (${poToken.length} chars)`)

  let reloadToken = null

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`\n================ attempt ${attempt}${reloadToken ? ' (after reload)' : ''}`)

    const player = await fetchPlayer(VIDEO_ID, reloadToken)
    const sd = player.streamingData ?? {}
    const cfg = player.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig
    const ustreamerConfig = cfg?.videoPlaybackUstreamerConfig

    console.log(`playability: ${player.playabilityStatus?.status}`)
    console.log(`abrUrl: ${sd.serverAbrStreamingUrl ? 'present' : 'ABSENT'}  ustreamerConfig: ${ustreamerConfig ? ustreamerConfig.length + ' chars' : 'ABSENT'}`)

    if (!sd.serverAbrStreamingUrl || !ustreamerConfig) {
      console.log('cannot proceed without both fields'); process.exit(1)
    }

    // Every audio itag appears twice: once plain, once as a DRC variant carrying
    // xtags. The lmt differs between them, so a FormatId that takes one variant's
    // lmt without its xtags names no real format -- the server answers
    // `sabr.no_audio_selected`. Prefer the plain variant and always carry xtags.
    const formats = sd.adaptiveFormats ?? []
    const audio = formats.filter(f => f.mimeType.startsWith('audio/') && !f.xtags)
      .sort((a, b) => a.bitrate - b.bitrate)[0]
      ?? formats.find(f => f.mimeType.startsWith('audio/'))
    const video = formats.filter(f => f.mimeType.startsWith('video/') && !f.xtags && f.height <= 480)
      .sort((a, b) => b.height - a.height)[0]
      ?? formats.find(f => f.mimeType.startsWith('video/'))
    console.log(`audio itag ${audio.itag} xtags ${audio.xtags ?? '-'}  video itag ${video.itag} ${video.qualityLabel} xtags ${video.xtags ?? '-'}`)

    const body = buildAbrRequest({
      ustreamerConfig,
      audio: { itag: audio.itag, lastModified: audio.lastModified, xtags: audio.xtags },
      video: { itag: video.itag, lastModified: video.lastModified, xtags: video.xtags },
      poToken
    })
    console.log(`request body: ${body.length} bytes`)
    writeFileSync(join(OUT, `sabr-request-${attempt}.bin`), body)

    const { res, raw } = await sabrRequest(sd.serverAbrStreamingUrl, body, attempt)
    console.log(`HTTP ${res.status}  content-type: ${res.headers.get('content-type')}  ${raw.length} bytes\n`)
    writeFileSync(join(OUT, `sabr-response-${attempt}.bin`), raw)

    if (res.status !== 200) {
      console.log('body head:', new TextDecoder().decode(raw.subarray(0, 500)))
      process.exit(1)
    }

    const { parts, mediaBytes } = report(raw, String(attempt))

    if (mediaBytes > 0) {
      console.log(`\nMEDIA RECEIVED on attempt ${attempt}`)
      return
    }

    const reload = parts.find(p => p.type === 46)
    if (!reload) { console.log('\nno media and no reload directive -- stopping'); return }
    reloadToken = reloadTokenOf(reload.data)
    if (!reloadToken) { console.log('\nreload part had no token -- stopping'); return }
    console.log(`\nreload token: ${reloadToken.slice(0, 60)}... (${reloadToken.length} chars)`)
  }
  console.log('\nexhausted reload attempts without media')
}

main().catch(e => { console.error('threw:', e); process.exit(1) })
