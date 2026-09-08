/**
 * SponsorBlock segment fetching.
 *
 * Uses the privacy-preserving hash-prefix API: instead of asking the server about a
 * specific video id (which tells it exactly what you are watching), the client sends
 * only the first 4 hex characters of SHA-256(videoId). The server returns every video
 * whose hash shares that prefix and the client filters locally.
 *
 * Server address and category metadata come from `data/sponsorblock_config.json`,
 * shipped inside playlet-lib.
 */

import sponsorBlockConfig from '../data/sponsorblock_config.json'
import { buildUrl, requestJson } from './http'
import type { SponsorBlockCategory, SponsorBlockOption, SponsorBlockSegment } from './types'

interface CategoryMeta {
  title: string
  short_title: string
  options: SponsorBlockOption[]
  color: string
}

interface SponsorBlockConfig {
  serverAddress: string
  categoryList: SponsorBlockCategory[]
  categories: Record<string, CategoryMeta>
}

const config = sponsorBlockConfig as unknown as SponsorBlockConfig

export const SERVER_ADDRESS = config.serverAddress
export const CATEGORY_LIST = config.categoryList
export const CATEGORY_META = config.categories

/** Default per-category behaviour, matching the Roku app's shipped defaults. */
export const DEFAULT_CATEGORY_OPTIONS: Record<SponsorBlockCategory, SponsorBlockOption> = {
  sponsor: 'auto_skip',
  selfpromo: 'manual_skip',
  interaction: 'manual_skip',
  poi_highlight: 'show_in_seekbar',
  intro: 'manual_skip',
  outro: 'manual_skip',
  preview: 'manual_skip',
  hook: 'manual_skip',
  filler: 'manual_skip',
  music_offtopic: 'manual_skip'
}

interface HashPrefixEntry {
  videoID: string
  hash: string
  segments: SponsorBlockSegment[]
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface FetchSegmentsOptions {
  /** Only request these categories; defaults to everything the app understands. */
  categories?: SponsorBlockCategory[]
  signal?: AbortSignal
  /** Override for self-hosted SponsorBlock servers. */
  serverAddress?: string
}

/**
 * Fetch segments for a video without revealing which video is being watched.
 * Returns an empty array when the video has no submitted segments - a 404 from this
 * API means "nothing submitted", not an error worth surfacing.
 */
export async function fetchSegments(
  videoId: string,
  opts: FetchSegmentsOptions = {}
): Promise<SponsorBlockSegment[]> {
  const categories = opts.categories ?? CATEGORY_LIST
  const server = (opts.serverAddress ?? SERVER_ADDRESS).replace(/\/+$/, '')

  const hash = await sha256Hex(videoId)
  const prefix = hash.slice(0, 4)

  const url = buildUrl(server, '/api/skipSegments/' + prefix, {
    categories: JSON.stringify(categories),
    actionTypes: JSON.stringify(['skip', 'mute', 'poi', 'full'])
  })

  let entries: HashPrefixEntry[]
  try {
    entries = await requestJson<HashPrefixEntry[]>({
      url,
      headers: { Accept: 'application/json' },
      signal: opts.signal,
      timeoutMs: 10_000
    })
  } catch (err) {
    const kind = (err as { kind?: string }).kind
    // No submissions for this hash prefix, or the service is unavailable. Neither
    // should block playback, so degrade to "no segments".
    if (kind === 'not_found') return []
    throw err
  }

  const match = entries.find(entry => entry.videoID === videoId)
  if (!match || !Array.isArray(match.segments)) return []

  return normaliseSegments(match.segments)
}

/**
 * Clean up the raw segment list: drop zero/negative-length segments, sort by start
 * time, and merge segments of the same category that overlap or sit within a
 * half-second of each other. Without this the player can stutter between two
 * near-identical crowd-sourced submissions.
 */
export function normaliseSegments(segments: SponsorBlockSegment[]): SponsorBlockSegment[] {
  const MERGE_GAP_SECONDS = 0.5

  const usable = segments
    .filter(s => Array.isArray(s.segment) && s.segment.length === 2)
    .filter(s => s.actionType === 'full' || s.actionType === 'poi' || s.segment[1] > s.segment[0])
    .sort((a, b) => a.segment[0] - b.segment[0])

  const merged: SponsorBlockSegment[] = []
  for (const segment of usable) {
    // Full-video and point-of-interest markers are not ranges and must not be merged.
    if (segment.actionType === 'full' || segment.actionType === 'poi') {
      merged.push(segment)
      continue
    }
    const previous = merged[merged.length - 1]
    if (
      previous &&
      previous.actionType === segment.actionType &&
      previous.category === segment.category &&
      segment.segment[0] - previous.segment[1] <= MERGE_GAP_SECONDS
    ) {
      previous.segment[1] = Math.max(previous.segment[1], segment.segment[1])
      continue
    }
    merged.push({ ...segment, segment: [segment.segment[0], segment.segment[1]] })
  }
  return merged
}

/** Human-readable label for a category, from the shipped config. */
export function categoryTitle(category: SponsorBlockCategory, short = false): string {
  const meta = CATEGORY_META[category]
  if (!meta) return category
  return short ? meta.short_title : meta.title
}

/** Seek-bar colour for a category. Values ship as #RRGGBBAA. */
export function categoryColor(category: SponsorBlockCategory): string {
  return CATEGORY_META[category]?.color ?? '#888888B3'
}
