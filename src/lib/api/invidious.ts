/**
 * Invidious REST client.
 *
 * Endpoint paths, query-parameter whitelists, retry counts, pagination style and
 * cache TTLs are all taken from `data/invidious_video_api.json`, which ships inside
 * playlet-lib. Keeping that file as the source of truth means this client stays in
 * step with the Roku app instead of drifting from a hand-copied list of URLs.
 */

import type { Backend, BackendKind } from './backend'
import apiConfig from '../data/invidious_video_api.json'
import { HttpError, buildUrl, requestJson } from './http'
import type {
  ChannelDetails, CommentsResponse, PlaylistDetails, SearchResult,
  VideoDetails, VideoSummary
} from './types'

type PaginationType = 'Pages' | 'Continuation'

interface EndpointConfig {
  title: string
  url: string
  cacheSeconds?: number
  tryCount?: number
  authenticated?: boolean
  paginationType?: PaginationType
  responseHandler?: string
  queryParams?: Record<string, { type: unknown; default?: unknown; arrayType?: string }>
}

const endpoints = apiConfig as unknown as Record<string, EndpointConfig>

export type EndpointName = keyof typeof apiConfig

/** TTL cache keyed by resolved URL, honouring each endpoint's cacheSeconds. */
class ResponseCache {
  private entries = new Map<string, { value: unknown; expiresAt: number }>()
  private maxEntries = 300

  get<T>(key: string): T | undefined {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (Date.now() > hit.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    // Refresh insertion order so eviction is least-recently-used.
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit.value as T
  }

  set(key: string, value: unknown, ttlSeconds: number): void {
    if (ttlSeconds <= 0) return
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
  }

  clear(): void {
    this.entries.clear()
  }
}

export interface InvidiousClientOptions {
  /** Base URL of the instance, e.g. https://inv.nadeko.net */
  instance: string
  /** Invidious auth token, when the user has linked an account. */
  token?: string
  /** Proxy media through the instance; mirrors the invidious.proxy_videos preference. */
  proxyVideos?: 'always' | 'if_needed' | 'never'
  region?: string
}

export interface PageOptions {
  /** For endpoints with paginationType "Pages". */
  page?: number
  /** For endpoints with paginationType "Continuation". */
  continuation?: string
  signal?: AbortSignal
}

export interface ContinuationList<T> {
  videos?: T[]
  playlists?: T[]
  continuation?: string
}

export class InvidiousClient implements Backend {
  readonly kind: BackendKind = 'invidious'
  private cache = new ResponseCache()
  instance: string
  token?: string
  proxyVideos: 'always' | 'if_needed' | 'never'
  region?: string

  constructor(opts: InvidiousClientOptions) {
    this.instance = opts.instance.replace(/\/+$/, '')
    this.token = opts.token
    this.proxyVideos = opts.proxyVideos ?? 'if_needed'
    this.region = opts.region
  }

  /** Swap instance at runtime (failover or user change) and drop cached responses. */
  setInstance(instance: string): void {
    this.instance = instance.replace(/\/+$/, '')
    this.cache.clear()
  }

  setToken(token: string | undefined): void {
    this.token = token
    this.cache.clear()
  }

  clearCache(): void {
    this.cache.clear()
  }

  /** Resolve a templated path such as /api/v1/channels/{ucid}. */
  private resolvePath(cfg: EndpointConfig, params: Record<string, string>): string {
    return cfg.url.replace(/\{(\w+)\}/g, (_match, key: string) => {
      const value = params[key]
      if (value === undefined) throw new Error('Missing path parameter "' + key + '" for ' + cfg.url)
      return encodeURIComponent(value)
    })
  }

  async call<T>(
    name: EndpointName,
    opts: {
      pathParams?: Record<string, string>
      query?: Record<string, unknown>
      page?: PageOptions
      signal?: AbortSignal
      /** Skip the cache for an explicit user-triggered refresh. */
      noCache?: boolean
    } = {}
  ): Promise<T> {
    const cfg = endpoints[name as string]
    if (!cfg) throw new Error('Unknown Invidious endpoint "' + String(name) + '"')

    const path = this.resolvePath(cfg, opts.pathParams ?? {})
    const query: Record<string, unknown> = { ...(opts.query ?? {}) }

    // The shipped config declares a runtime-resolved default for region.
    if (cfg.queryParams && cfg.queryParams.region && query.region === undefined && this.region) {
      query.region = this.region
    }
    if (cfg.paginationType === 'Pages' && opts.page && opts.page.page !== undefined) {
      query.page = opts.page.page
    }
    if (cfg.paginationType === 'Continuation' && opts.page && opts.page.continuation) {
      query.continuation = opts.page.continuation
    }

    const url = buildUrl(this.instance, path, query)
    const cacheKey = (this.token ? 'auth:' : '') + url

    if (!opts.noCache && cfg.cacheSeconds) {
      const hit = this.cache.get<T>(cacheKey)
      if (hit !== undefined) return hit
    }

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (cfg.authenticated) {
      if (!this.token) {
        throw new HttpError('client', url, 'Endpoint "' + String(name) + '" requires a linked Invidious account', 401)
      }
      headers.Authorization = 'Bearer ' + this.token
    }

    const attempts = Math.max(1, cfg.tryCount ?? 1)
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const signal = opts.signal ?? (opts.page ? opts.page.signal : undefined)
        const data = await requestJson<T>({ url, headers, signal })
        if (cfg.cacheSeconds) this.cache.set(cacheKey, data, cfg.cacheSeconds)
        return data
      } catch (err) {
        lastError = err
        // Retrying a missing resource, a rejected request or an abort is pointless.
        if (err instanceof HttpError && (err.kind === 'not_found' || err.kind === 'aborted' || err.kind === 'client')) {
          throw err
        }
        if (attempt < attempts - 1) {
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
        }
      }
    }
    throw lastError
  }

  // ---- Feeds -------------------------------------------------------------

  trending(opts: { type?: 'Livestreams' | 'Gaming'; region?: string; signal?: AbortSignal } = {}): Promise<VideoSummary[]> {
    return this.call<VideoSummary[]>('trending', {
      query: { type: opts.type, region: opts.region },
      signal: opts.signal
    })
  }

  popular(opts: { signal?: AbortSignal } = {}): Promise<VideoSummary[]> {
    return this.call<VideoSummary[]>('popular', { signal: opts.signal })
  }

  // ---- Search ------------------------------------------------------------

  search(opts: {
    q: string
    sort?: 'relevance' | 'rating' | 'date' | 'views'
    date?: 'hour' | 'today' | 'week' | 'month' | 'year'
    duration?: 'short' | 'long'
    type?: Array<'video' | 'playlist' | 'channel' | 'all'>
    features?: string[]
    region?: string
    page?: number
    signal?: AbortSignal
  }): Promise<SearchResult[]> {
    return this.call<SearchResult[]>('search', {
      query: {
        q: opts.q,
        sort: opts.sort,
        date: opts.date,
        duration: opts.duration,
        type: opts.type,
        features: opts.features,
        region: opts.region
      },
      page: { page: opts.page },
      signal: opts.signal
    })
  }

  // ---- Video -------------------------------------------------------------

  video(videoId: string, opts: { noCache?: boolean; signal?: AbortSignal } = {}): Promise<VideoDetails> {
    return this.call<VideoDetails>('video_info', {
      pathParams: { id: videoId },
      noCache: opts.noCache,
      signal: opts.signal
    })
  }

  /** Comments are not in the shipped endpoint config; this is the documented Invidious route. */
  comments(
    videoId: string,
    opts: { continuation?: string; sortBy?: 'top' | 'new'; signal?: AbortSignal } = {}
  ): Promise<CommentsResponse> {
    const url = buildUrl(this.instance, '/api/v1/comments/' + encodeURIComponent(videoId), {
      continuation: opts.continuation,
      sort_by: opts.sortBy
    })
    return requestJson<CommentsResponse>({
      url,
      headers: { Accept: 'application/json' },
      signal: opts.signal
    })
  }

  // ---- Channels ----------------------------------------------------------

  channel(ucid: string, opts: { signal?: AbortSignal } = {}): Promise<ChannelDetails> {
    return this.call<ChannelDetails>('channel_info', { pathParams: { ucid }, signal: opts.signal })
  }

  channelVideos(
    ucid: string,
    opts: { sortBy?: 'newest' | 'oldest' | 'popular' } & PageOptions = {}
  ): Promise<ContinuationList<VideoSummary>> {
    return this.call<ContinuationList<VideoSummary>>('channel_videos', {
      pathParams: { ucid },
      query: { sort_by: opts.sortBy },
      page: opts
    })
  }

  channelShorts(ucid: string, opts: PageOptions = {}): Promise<ContinuationList<VideoSummary>> {
    return this.call<ContinuationList<VideoSummary>>('channel_shorts', { pathParams: { ucid }, page: opts })
  }

  channelStreams(ucid: string, opts: PageOptions = {}): Promise<ContinuationList<VideoSummary>> {
    return this.call<ContinuationList<VideoSummary>>('channel_streams', { pathParams: { ucid }, page: opts })
  }

  channelPlaylists(
    ucid: string,
    opts: { sortBy?: 'newest' | 'last' } & PageOptions = {}
  ): Promise<ContinuationList<PlaylistDetails>> {
    return this.call<ContinuationList<PlaylistDetails>>('channel_playlists', {
      pathParams: { ucid },
      query: { sort_by: opts.sortBy },
      page: opts
    })
  }

  // ---- Playlists ---------------------------------------------------------

  playlist(plid: string, opts: PageOptions = {}): Promise<PlaylistDetails> {
    return this.call<PlaylistDetails>('playlist', { pathParams: { plid }, page: opts })
  }

  // ---- Authenticated -----------------------------------------------------

  authFeed(opts: { maxResults?: number } & PageOptions = {}): Promise<{ notifications: VideoSummary[]; videos: VideoSummary[] }> {
    return this.call('auth_feed', { query: { max_results: opts.maxResults ?? 20 }, page: opts })
  }

  authPlaylists(opts: PageOptions = {}): Promise<PlaylistDetails[]> {
    return this.call<PlaylistDetails[]>('auth_playlists', { page: opts })
  }

  watchHistory(opts: PageOptions = {}): Promise<string[]> {
    return this.call<string[]>('watch_history', { page: opts })
  }

  /** The token-granting URL an Invidious instance exposes for linking an account. */
  authTokenUrl(callbackUrl: string, scopes = ':feed,:subscriptions*,:playlists*,:history*'): string {
    return buildUrl(this.instance, '/authorize_token', {
      scopes,
      callback_url: callbackUrl
    })
  }
}
