/**
 * Invidious instance discovery, health checking and failover.
 *
 * Public instances go down constantly, rate-limit aggressively, and are frequently
 * blocked by YouTube. Treating "the instance is broken" as a first-class, recoverable
 * state - rather than an error the user has to interpret - is what separates a usable
 * client from one that looks broken every other day.
 */

import { HttpError, buildUrl, requestJson } from './http'

/** The community-maintained instance directory. */
export const PUBLIC_INSTANCE_LIST_URL = 'https://api.invidious.io/instances.json?sort_by=type,health'

/**
 * Fallback list, used when the directory is unreachable or lists nothing usable.
 *
 * This is not a nicety: as of this build the public directory returns almost nothing
 * routable, and most surviving instances answer the API with 401/403 or an anti-bot
 * challenge page. These were verified by probing /api/v1/trending directly, best first.
 * Any of them can stop working at any time, which is the whole reason the app
 * health-checks and fails over rather than trusting a hardcoded default.
 */
export const FALLBACK_INSTANCES = [
  'https://invidious.materialio.us',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.f5.si',
  'https://yewtu.be',
  'https://iteroni.com',
  'https://invidious.privacyredirect.com'
]

export interface InstanceInfo {
  uri: string
  name: string
  type: string
  region?: string
  /** Ratio 0-100 of successful checks over the last 30 days, when the directory reports it. */
  health?: number
  apiEnabled: boolean
  cors: boolean
}

/** Hostnames that only resolve inside an overlay network this app cannot reach. */
const OVERLAY_SUFFIXES = ['.ygg', '.onion', '.i2p', '.loki']

export function isOverlayNetworkHost(uri: string): boolean {
  try {
    const host = new URL(uri).hostname.toLowerCase()
    return OVERLAY_SUFFIXES.some(suffix => host.endsWith(suffix))
  } catch {
    return false
  }
}

interface RawInstanceStats {
  type?: string
  uri?: string
  region?: string
  cors?: boolean | null
  api?: boolean | null
  monitor?: { '30dRatio'?: { ratio?: string } } | null
}

/** Fetch and normalise the public instance directory. */
export async function fetchPublicInstances(signal?: AbortSignal): Promise<InstanceInfo[]> {
  const raw = await requestJson<Array<[string, RawInstanceStats]>>({
    url: PUBLIC_INSTANCE_LIST_URL,
    headers: { Accept: 'application/json' },
    signal,
    timeoutMs: 10_000
  })

  const instances: InstanceInfo[] = []
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const [name, stats] = entry
    if (!stats || !stats.uri) continue
    // Onion and i2p instances are unreachable without a proxy the app does not ship.
    if (stats.type !== 'https') continue
    // An instance with the API disabled cannot serve this client at all.
    if (stats.api === false) continue
    // Some overlay-network instances are published as type "https" but resolve only
    // inside Yggdrasil/I2P/Tor. They often rank highest on health, so they have to be
    // dropped explicitly or they crowd out every reachable instance.
    if (isOverlayNetworkHost(stats.uri)) continue

    const ratio = stats.monitor?.['30dRatio']?.ratio
    instances.push({
      uri: stats.uri.replace(/\/+$/, ''),
      name,
      type: stats.type,
      region: stats.region,
      health: ratio === undefined ? undefined : Number.parseFloat(ratio),
      // Instances with the API explicitly disabled were filtered out above.
      apiEnabled: true,
      cors: stats.cors === true
    })
  }

  // Best health first, unknown health last.
  instances.sort((a, b) => (b.health ?? -1) - (a.health ?? -1))
  return instances
}

export interface HealthResult {
  instance: string
  ok: boolean
  /** Round-trip time in ms for the probe request. */
  latencyMs?: number
  error?: string
  kind?: string
}

/**
 * Probe an instance with a real API call.
 *
 * `/api/v1/trending` is used rather than a stats endpoint because it exercises the
 * path this app actually depends on: an instance can be up, and its stats endpoint
 * healthy, while YouTube has blocked its ability to return video data.
 */
export async function checkInstance(instance: string, signal?: AbortSignal): Promise<HealthResult> {
  const started = performance.now()
  const url = buildUrl(instance, '/api/v1/trending', { region: 'US' })
  try {
    const data = await requestJson<unknown>({
      url,
      headers: { Accept: 'application/json' },
      signal,
      timeoutMs: 8_000
    })
    if (!Array.isArray(data)) {
      return { instance, ok: false, error: 'Instance returned an unexpected response shape', kind: 'parse' }
    }
    return { instance, ok: true, latencyMs: Math.round(performance.now() - started) }
  } catch (err) {
    const e = err as HttpError
    return {
      instance,
      ok: false,
      error: e.message,
      kind: e.kind ?? 'unknown',
      latencyMs: Math.round(performance.now() - started)
    }
  }
}

/** Probe several instances at once and return them fastest-first. */
export async function rankInstances(candidates: string[], signal?: AbortSignal): Promise<HealthResult[]> {
  const results = await Promise.all(candidates.map(uri => checkInstance(uri, signal)))
  return results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1
    return (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity)
  })
}

/**
 * Pick a working instance: try the preferred one first, then fall back to the
 * healthiest reachable alternative. Returns null when nothing is reachable, which
 * usually means the user is offline rather than that every instance is down.
 */
export async function resolveWorkingInstance(
  preferred: string | undefined,
  signal?: AbortSignal,
  /**
   * Registers hosts with the shell's network allowlist. Instances discovered from the
   * public directory are unknown to the shell until this is called, so probing them
   * without it would be refused before a request ever left the machine.
   */
  allowHosts?: (hosts: string[]) => Promise<void>
): Promise<{ instance: string | null; checked: HealthResult[] }> {
  const checked: HealthResult[] = []

  if (preferred) {
    const result = await checkInstance(preferred, signal)
    checked.push(result)
    if (result.ok) return { instance: preferred, checked }
  }

  let candidates: string[] = []
  try {
    const published = await fetchPublicInstances(signal)
    candidates = published.slice(0, 8).map(i => i.uri)
  } catch {
    candidates = []
  }
  if (candidates.length === 0) candidates = [...FALLBACK_INSTANCES]

  if (allowHosts) {
    await allowHosts([...(preferred ? [preferred] : []), ...FALLBACK_INSTANCES, ...candidates])
  }

  // Do not re-probe the instance that just failed.
  candidates = candidates.filter(uri => uri !== preferred)

  const ranked = await rankInstances(candidates.slice(0, 6), signal)
  checked.push(...ranked)
  const healthy = ranked.find(r => r.ok)
  if (healthy) return { instance: healthy.instance, checked }

  // The directory can go stale, or list only instances this network cannot reach.
  // Falling back to the built-in list means a bad directory is not a dead end.
  const alreadyTried = new Set(checked.map(r => r.instance))
  const remaining = FALLBACK_INSTANCES.filter(uri => !alreadyTried.has(uri))
  if (remaining.length === 0) return { instance: null, checked }

  if (allowHosts) await allowHosts(remaining)
  const fallbackRanked = await rankInstances(remaining, signal)
  checked.push(...fallbackRanked)
  const fallbackHealthy = fallbackRanked.find(r => r.ok)
  return { instance: fallbackHealthy ? fallbackHealthy.instance : null, checked }
}
