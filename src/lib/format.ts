/** Presentation helpers for durations, counts and timestamps. */

/** Seconds to h:mm:ss (or m:ss under an hour), as used on thumbnails and the player. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00'
  const seconds = Math.floor(totalSeconds % 60)
  const minutes = Math.floor((totalSeconds / 60) % 60)
  const hours = Math.floor(totalSeconds / 3600)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return hours > 0 ? hours + ':' + pad(minutes) + ':' + pad(seconds) : minutes + ':' + pad(seconds)
}

const countFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1
})

/** 1234567 -> "1.2M". Falls back to a plain number when the value is small. */
export function formatCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return ''
  if (value < 1000) return String(value)
  return countFormatter.format(value)
}

export function formatViews(value: number | undefined): string {
  const count = formatCount(value)
  if (!count) return ''
  return count + (value === 1 ? ' view' : ' views')
}

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

const DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' }
]

/**
 * Unix seconds to "3 days ago".
 *
 * Invidious also returns a pre-rendered `publishedText`; prefer that when present,
 * since it is already localised by the instance. This is the fallback.
 */
export function formatRelativeTime(publishedUnixSeconds: number | undefined): string {
  if (!publishedUnixSeconds) return ''
  let duration = (publishedUnixSeconds * 1000 - Date.now()) / 1000
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return relativeFormatter.format(Math.round(duration), division.unit)
    }
    duration /= division.amount
  }
  return ''
}

/** Pick the thumbnail closest to a target width without going needlessly large. */
export function pickThumbnail(
  thumbnails: Array<{ url: string; width: number; height: number; quality?: string }> | undefined,
  targetWidth: number
): string | undefined {
  if (!thumbnails || thumbnails.length === 0) return undefined
  const usable = thumbnails.filter(t => t.url)
  if (usable.length === 0) return undefined

  const larger = usable.filter(t => t.width >= targetWidth).sort((a, b) => a.width - b.width)
  if (larger.length > 0) return larger[0].url

  return usable.sort((a, b) => b.width - a.width)[0].url
}

/**
 * Invidious returns thumbnail URLs pointing at YouTube's CDN unless the instance
 * proxies them. When the user has asked for proxying, rewrite the host so images
 * are fetched through the instance too.
 */
export function proxyThumbnail(url: string | undefined, instance: string, proxy: boolean): string | undefined {
  if (!url) return undefined
  if (!proxy) return url
  try {
    const parsed = new URL(url)
    if (!/(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com)$/.test(parsed.hostname)) return url
    const base = new URL(instance)
    parsed.protocol = base.protocol
    parsed.host = base.host
    return parsed.toString()
  } catch {
    return url
  }
}

/** Strip HTML from Invidious description fields when rendering as plain text. */
export function stripHtml(html: string | undefined): string {
  if (!html) return ''
  const el = document.createElement('div')
  el.innerHTML = html
  return el.textContent ?? ''
}
