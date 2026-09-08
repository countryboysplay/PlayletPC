/**
 * Search filter parameters for InnerTube.
 *
 * YouTube encodes search filters as a base64url'd protobuf in the `params` field.
 * Most clients hardcode a handful of copied magic strings, which only covers the
 * filter combinations someone happened to write down. Encoding the message properly
 * is about thirty lines and supports every combination.
 *
 *   message SearchRequest {
 *     optional uint32 sort   = 1;   // 0 relevance, 1 rating, 2 upload date, 3 view count
 *     optional Filters filter = 2;
 *   }
 *   message Filters {
 *     optional uint32 uploadDate = 1;   // 1 hour, 2 today, 3 week, 4 month, 5 year
 *     optional uint32 type       = 2;   // 1 video, 2 channel, 3 playlist, 4 movie
 *     optional uint32 duration   = 3;   // 1 short (<4m), 2 long (>20m), 3 medium
 *   }
 */

export type SearchSort = 'relevance' | 'rating' | 'date' | 'views'
export type SearchType = 'all' | 'video' | 'channel' | 'playlist' | 'movie'
export type SearchDate = 'hour' | 'today' | 'week' | 'month' | 'year'
export type SearchDuration = 'short' | 'medium' | 'long'

const SORT: Record<SearchSort, number> = { relevance: 0, rating: 1, date: 2, views: 3 }
const TYPE: Record<Exclude<SearchType, 'all'>, number> = { video: 1, channel: 2, playlist: 3, movie: 4 }
const DATE: Record<SearchDate, number> = { hour: 1, today: 2, week: 3, month: 4, year: 5 }
const DURATION: Record<SearchDuration, number> = { short: 1, long: 2, medium: 3 }

/** Protobuf varint. Values here are small, but encode properly regardless. */
function varint(value: number): number[] {
  const out: number[] = []
  let v = value >>> 0
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v > 0) byte |= 0x80
    out.push(byte)
  } while (v > 0)
  return out
}

/** field number + wire type 0 (varint) */
function field(fieldNumber: number, value: number): number[] {
  return [...varint((fieldNumber << 3) | 0), ...varint(value)]
}

/** field number + wire type 2 (length-delimited) */
function nested(fieldNumber: number, bytes: number[]): number[] {
  return [...varint((fieldNumber << 3) | 2), ...varint(bytes.length), ...bytes]
}

function toBase64(bytes: number[]): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export interface SearchFilters {
  sort?: SearchSort
  type?: SearchType
  date?: SearchDate
  duration?: SearchDuration
}

/**
 * Build the `params` value for a search request. Returns undefined when no filter
 * is set, since YouTube prefers the field absent over an empty message.
 */
export function buildSearchParams(filters: SearchFilters): string | undefined {
  const inner: number[] = []
  if (filters.date) inner.push(...field(1, DATE[filters.date]))
  if (filters.type && filters.type !== 'all') inner.push(...field(2, TYPE[filters.type]))
  if (filters.duration) inner.push(...field(3, DURATION[filters.duration]))

  const message: number[] = []
  // Relevance is the default; emitting it is harmless but unnecessary.
  if (filters.sort && filters.sort !== 'relevance') message.push(...field(1, SORT[filters.sort]))
  if (inner.length > 0) message.push(...nested(2, inner))

  if (message.length === 0) return undefined
  return toBase64(message)
}

/** Channel tab params, as YouTube's own web client sends them. */
export const CHANNEL_TABS = {
  videos: 'EgZ2aWRlb3PyBgQKAjoA',
  shorts: 'EgZzaG9ydHPyBgUKA5oBAA%3D%3D'.replace(/%3D/g, '='),
  streams: 'EgdzdHJlYW1z8gYECgJ6AA%3D%3D'.replace(/%3D/g, '='),
  playlists: 'EglwbGF5bGlzdHPyBgQKAkIA'
} as const
