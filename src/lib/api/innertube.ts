/**
 * Direct YouTube backend.
 *
 * Talks to YouTube's own InnerTube API through the Rust `yt_innertube` command and
 * maps the responses onto Invidious shapes, so the UI is unaware of which backend is
 * in use. This is the app's default: it needs no third-party server, and unlike the
 * public Invidious network it actually serves video.
 *
 * Client split (measured against the live API, not assumed):
 *   * IOS answers /player with direct, unciphered URLs - no signature deciphering,
 *     no `n` parameter, no PoToken. That is why this app ships no JS engine.
 *   * WEB answers /search, /browse and /next with parseable renderers, where IOS
 *     returns opaque element blobs.
 */

import type { Backend, BackendKind, ContinuationList, PageOptions } from './backend'
import { HttpError } from './http'
import { buildSearchParams, CHANNEL_TABS, type SearchFilters } from './innertube-params'
import { buildDashManifestDetailed, type AdaptiveFormatInput } from './innertube-dash'
import { proxyMediaUrl } from './media-proxy'
import {
  PLAYER_CLIENT_LADDER,
  SIGNED_IN_LADDER,
  type PlayerClientName
} from './player-clients'
import { account } from '../stores/account.svelte'
import {
  mapChannel,
  mapChannelVideos,
  mapHomeFeed,
  mapPlaylist,
  mapRecommendations,
  mapSearchResults,
  mapPlayerResponse,
  PlayabilityError
} from './innertube-map'
import {
  mapSavedPlaylists,
  mapSubscribedChannels,
  mapTvPlaylist,
  mapTvVideoFeed
} from './innertube-tv-map'
import type {
  ChannelDetails,
  ChannelSummary,
  CommentsResponse,
  PlaylistDetails,
  PlaylistSummary,
  SearchResult,
  VideoDetails,
  VideoSummary
} from './types'

type InnertubeClientName = PlayerClientName | 'web'

interface InnertubeResponse {
  status: number
  ok: boolean
  body: string
  elapsedMs: number
  client: string
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

let invokeFn: Invoke | null = null

/** Installed by the desktop shell; without it this backend cannot be used. */
export function setInnertubeInvoke(fn: Invoke): void {
  invokeFn = fn
}

export function isInnertubeAvailable(): boolean {
  return invokeFn !== null
}

class TtlCache {
  private entries = new Map<string, { value: unknown; expiresAt: number }>()
  private max = 200

  get<T>(key: string): T | undefined {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (Date.now() > hit.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    return hit.value as T
  }

  set(key: string, value: unknown, ttlSeconds: number): void {
    if (ttlSeconds <= 0) return
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
  }

  clear(): void {
    this.entries.clear()
  }
}

/**
 * Player responses are cached briefly and no longer.
 *
 * googlevideo URLs are bound to the requesting IP and expire in hours, so a stale
 * cached player response is worse than no cache: it produces a video that fails to
 * play with no obvious cause.
 */
const PLAYER_TTL_SECONDS = 20 * 60
const BROWSE_TTL_SECONDS = 5 * 60

export class InnertubeClient implements Backend {
  readonly kind: BackendKind = 'playlet'
  /** Empty: there is no instance, so nothing derived from one may be attempted. */
  readonly instance = ''

  /** Mirrors the playback.disable_auto_dubbed preference; set by the session. */
  disableAutoDubbed = false

  /** Which client last served playback, for the settings screen and diagnostics. */
  lastPlaybackClient: string | null = null

  private cache = new TtlCache()

  clearCache(): void {
    this.cache.clear()
  }

  private async call(
    endpoint: string,
    payload: Record<string, unknown>,
    client: InnertubeClientName = 'web'
  ): Promise<unknown> {
    if (!invokeFn) {
      throw new HttpError('network', endpoint, 'The direct YouTube backend needs the desktop app')
    }

    // The token goes ONLY to the TV client.
    //
    // It is issued for YouTube's living-room client, so any other client rejects it
    // outright: an Authorization header on a WEB /search or an IOS /player answers
    // HTTP 401 "Request had invalid authentication credentials". Upstream encodes the
    // same rule as `useAccessToken = isTv and ...` in PlayerEndpoint.bs.
    const accessToken = client === 'tv' ? ((await account.accessToken()) ?? undefined) : undefined

    let response: InnertubeResponse
    try {
      response = await invokeFn<InnertubeResponse>('yt_innertube', {
        req: { endpoint, client, payload, accessToken }
      })
    } catch (err) {
      throw new HttpError('network', endpoint, 'YouTube request failed: ' + String(err))
    }

    if (!response.ok) {
      // A stale scraped client version shows up as 400 on browse calls; refreshing
      // the identity and retrying once fixes it without bothering the user.
      if (response.status === 400) {
        await invokeFn('yt_refresh_identity').catch(() => undefined)
        const retry = await invokeFn<InnertubeResponse>('yt_innertube', {
          req: { endpoint, client, payload, accessToken }
        })
        if (retry.ok) return JSON.parse(retry.body)
      }
      throw new HttpError(
        response.status >= 500 ? 'server' : 'client',
        endpoint,
        'YouTube returned HTTP ' + response.status,
        response.status
      )
    }

    try {
      return JSON.parse(response.body)
    } catch {
      throw new HttpError('parse', endpoint, 'YouTube returned a response that was not JSON')
    }
  }

  // ---- Feeds -------------------------------------------------------------

  /**
   * There is no editorial feed to return.
   *
   * YouTube retired Trending - every `FEtrending` browse id now answers HTTP 400 - and
   * `FEwhat_to_watch` is genuinely empty for a signed-out client, with or without a
   * consent cookie (`FEexplore` and `FEtopics_music` also 400). Rather than invent a
   * feed out of a search query, this returns nothing and the home screen builds itself
   * from the user's own subscriptions and watch history.
   */
  async trending(opts: { signal?: AbortSignal } = {}): Promise<VideoSummary[]> {
    void opts
    // Always the signed-out feed for now: browse runs on the WEB client, which cannot
    // carry the TV token. Empty here means the home screen uses local data instead.
    const key = 'home'
    const cached = this.cache.get<VideoSummary[]>(key)
    if (cached) return cached
    const json = await this.call('browse', { browseId: 'FEwhat_to_watch' })
    const videos = mapHomeFeed(json)
    this.cache.set(key, videos, BROWSE_TTL_SECONDS)
    return videos
  }

  // ---- Authenticated feeds ----------------------------------------------
  //
  // These need an account token. Signed out they return nothing useful, so callers
  // should check `account.isSignedIn` rather than relying on an empty result.

  /**
   * The account's subscriptions feed.
   *
   * Runs on the TV client because that is the only client the account token is valid
   * for, and TV browse answers in living-room renderers (`tileRenderer`), which is why
   * this goes through `innertube-tv-map` rather than the WEB mapper.
   *
   * Signed out this returns [] rather than the signed-out feed, which would be an
   * empty list indistinguishable from "you have no subscriptions".
   */
  async subscriptionsFeed(): Promise<VideoSummary[]> {
    if (!account.isSignedIn) return []
    return mapTvVideoFeed(await this.subscriptionsBrowse())
  }

  /**
   * The raw FEsubscriptions response, cached.
   *
   * Both the video feed and the subscribed-channel list are read out of this ONE
   * response (the channels are its tab strip), so it is cached raw rather than per
   * caller - otherwise opening the app made the same request twice.
   */
  private async subscriptionsBrowse(): Promise<unknown> {
    const key = 'tv:browse:FEsubscriptions'
    const cached = this.cache.get<unknown>(key)
    if (cached !== undefined) return cached
    const json = await this.call('browse', { browseId: 'FEsubscriptions' }, 'tv')
    this.cache.set(key, json, BROWSE_TTL_SECONDS)
    return json
  }

  popular(opts: { signal?: AbortSignal } = {}): Promise<VideoSummary[]> {
    return this.trending(opts)
  }

  /**
   * The channels this account subscribes to.
   *
   * They are not a list in the feed body - the TV surface renders one `tabRenderer`
   * per subscribed channel across the top, with the channel id buried in the tab's
   * protobuf `params`. See `mapSubscribedChannels`.
   */
  async subscribedChannels(): Promise<ChannelSummary[]> {
    if (!account.isSignedIn) return []
    return mapSubscribedChannels(await this.subscriptionsBrowse())
  }

  /**
   * The account's saved playlists, including Watch Later and Liked Videos.
   *
   * `FEplaylist_aggregation` is the dedicated playlists surface. `FElibrary` also
   * carries them, but mixed in with history, recommendations and navigation tiles.
   */
  async savedPlaylists(): Promise<PlaylistSummary[]> {
    if (!account.isSignedIn) return []
    const key = 'tv:saved-playlists'
    const cached = this.cache.get<PlaylistSummary[]>(key)
    if (cached) return cached
    const json = await this.call('browse', { browseId: 'FEplaylist_aggregation' }, 'tv')
    const playlists = mapSavedPlaylists(json)
    this.cache.set(key, playlists, BROWSE_TTL_SECONDS)
    return playlists
  }

  // ---- Search ------------------------------------------------------------

  async search(opts: {
    q: string
    sort?: 'relevance' | 'rating' | 'date' | 'views'
    date?: 'hour' | 'today' | 'week' | 'month' | 'year'
    duration?: 'short' | 'long'
    type?: Array<'video' | 'playlist' | 'channel' | 'all'>
    page?: number
    signal?: AbortSignal
  }): Promise<SearchResult[]> {
    const filters: SearchFilters = {
      sort: opts.sort,
      date: opts.date,
      duration: opts.duration,
      type: opts.type && opts.type.length === 1 ? opts.type[0] : undefined
    }
    const params = buildSearchParams(filters)

    // InnerTube paginates by continuation token, not page number. Page 1 is a fresh
    // query; later pages follow the token from the previous response.
    const key = 'search:' + opts.q + ':' + (params ?? '') + ':' + (opts.page ?? 1)
    const cached = this.cache.get<SearchResult[]>(key)
    if (cached) return cached

    const page = opts.page ?? 1
    if (page > 1) {
      const token = this.searchContinuations.get(opts.q + ':' + (params ?? ''))
      if (!token) return []
      const json = await this.call('search', { continuation: token })
      const results = mapSearchResults(json)
      this.rememberSearchContinuation(opts.q, params, json)
      return results
    }

    const json = await this.call('search', params ? { query: opts.q, params } : { query: opts.q })
    const results = mapSearchResults(json)
    this.rememberSearchContinuation(opts.q, params, json)
    this.cache.set(key, results, 120)
    return results
  }

  private searchContinuations = new Map<string, string>()

  private rememberSearchContinuation(query: string, params: string | undefined, json: unknown): void {
    const token = findContinuation(json)
    if (token) this.searchContinuations.set(query + ':' + (params ?? ''), token)
  }

  // ---- Video -------------------------------------------------------------

  async video(videoId: string, opts: { noCache?: boolean; signal?: AbortSignal } = {}): Promise<VideoDetails> {
    const key = 'video:' + videoId
    if (!opts.noCache) {
      const cached = this.cache.get<VideoDetails>(key)
      if (cached) return cached
    }

    // Playback data comes from a client ladder; recommendations come from WEB, because
    // the IOS /next response is enormous and carries no parseable renderers.
    //
    // IOS is first because it is the only client measured to return direct, unciphered
    // URLs from a desktop connection. The rest are retried in turn so that a future
    // lockdown of one client degrades rather than breaks the app - notably `tv`, which
    // is what the upstream Roku app uses and which works from a real Roku.
    const video = await this.fetchPlayable(videoId)

    // Recommendations are a nice-to-have; never fail the video for them.
    try {
      const nextJson = await this.call('next', { videoId })
      video.recommendedVideos = mapRecommendations(nextJson)
    } catch {
      video.recommendedVideos = []
    }

    this.cache.set(key, video, PLAYER_TTL_SECONDS)
    return video
  }

  /**
   * Walk the client ladder until one returns a playable response with usable URLs.
   *
   * A client can fail in two ways: refuse the video (LOGIN_REQUIRED / UNPLAYABLE), or
   * return formats whose URLs are all ciphered, which this app cannot decipher. Both
   * mean "try the next client", and only the last failure is reported.
   */
  private async fetchPlayable(videoId: string): Promise<VideoDetails> {
    const payload = { videoId, contentCheckOk: true, racyCheckOk: true }
    let lastError: unknown = null

    const ladder = account.isSignedIn ? SIGNED_IN_LADDER : PLAYER_CLIENT_LADDER
    // What each client actually said, so a failure names the reason per client instead
    // of collapsing to one generic message.
    const attempts: string[] = []

    for (const client of ladder) {
      let json: unknown
      try {
        json = await this.call('player', payload, client)
      } catch (err) {
        attempts.push(client + ': ' + (err instanceof Error ? err.message : String(err)))
        lastError = err
        continue
      }

      try {
        const video = mapPlayerResponse(json)
        const playable =
          video.formatStreams.some(f => f.url) || video.adaptiveFormats.some(f => f.url) || Boolean(video.hlsUrl)
        if (!playable) {
          const ciphered = video.adaptiveFormats.some(f => !f.url)
          const why = ciphered
            ? 'returned only ciphered URLs (needs signature deciphering)'
            : 'returned no stream URLs'
          attempts.push(client + ': ' + why)
          lastError = new HttpError('client', 'player', why, 451)
          continue
        }

        this.lastPlaybackClient = client

        // Build the manifest from the raw response, which still has YouTube's own field
        // names and byte-range objects, before the mapper normalises them away.
        this.attachManifest(video, json)
        return video
      } catch (err) {
        // A refusal from one client says nothing about the next one.
        attempts.push(client + ': ' + (err instanceof Error ? err.message : String(err)))
        lastError = err instanceof PlayabilityError ? new HttpError('client', 'player', err.message, 451) : err
      }
    }

    // Every client refused. Report what each one said - that is the difference between
    // a diagnosable failure and "could not load this video".
    throw new HttpError('client', 'player', 'No client would play this video. ' + attempts.join('; '), 451)

  }

  /**
   * Generate a DASH manifest for the video and attach it.
   *
   * Segment URLs are rewritten through the app's media proxy: googlevideo sends
   * `Access-Control-Allow-Origin` only for youtube.com, so shaka could not fetch
   * segments directly and adaptive playback would fail.
   */
  private attachManifest(video: VideoDetails, raw: unknown): void {
    const streaming = (raw as { streamingData?: { adaptiveFormats?: AdaptiveFormatInput[] } })?.streamingData
    const formats = streaming?.adaptiveFormats
    if (!Array.isArray(formats) || formats.length === 0) return

    try {
      const result = buildDashManifestDetailed(formats, {
        durationSeconds: video.lengthSeconds,
        rewriteUrl: (url: string) => proxyMediaUrl(url, video.videoId),
        disableAutoDubbed: this.disableAutoDubbed
      })
      if (result.representationCount > 0) {
        video.dashManifestXml = result.mpd
      }
      if (result.skipped.length > 0) {
        // Worth seeing: a sudden jump here means YouTube changed shape, which would
        // otherwise show up only as a black screen.
        console.debug('[innertube] skipped %d formats', result.skipped.length, result.skipped)
      }
    } catch (err) {
      // Playback can still fall back to HLS or a muxed stream if one exists.
      console.warn('[innertube] could not build a DASH manifest', err)
    }
  }

  async comments(
    videoId: string,
    opts: { continuation?: string; sortBy?: 'top' | 'new'; signal?: AbortSignal } = {}
  ): Promise<CommentsResponse> {
    void opts
    // Comments need a continuation token dug out of /next, then a second browse call.
    // Not wired up yet; the UI has no comments view, so return an empty set rather
    // than pretending to fail.
    return { videoId, comments: [] }
  }

  // ---- Channels ----------------------------------------------------------

  async channel(ucid: string, opts: { signal?: AbortSignal } = {}): Promise<ChannelDetails> {
    void opts
    const key = 'channel:' + ucid
    const cached = this.cache.get<ChannelDetails>(key)
    if (cached) return cached
    const json = await this.call('browse', { browseId: ucid })
    const channel = mapChannel(json)
    this.cache.set(key, channel, BROWSE_TTL_SECONDS)
    return channel
  }

  private async channelTab(
    ucid: string,
    tab: keyof typeof CHANNEL_TABS,
    opts: PageOptions
  ): Promise<ContinuationList<VideoSummary>> {
    const json = opts.continuation
      ? await this.call('browse', { continuation: opts.continuation })
      : await this.call('browse', { browseId: ucid, params: CHANNEL_TABS[tab] })
    return mapChannelVideos(json)
  }

  channelVideos(
    ucid: string,
    opts: { sortBy?: 'newest' | 'oldest' | 'popular' } & PageOptions = {}
  ): Promise<ContinuationList<VideoSummary>> {
    return this.channelTab(ucid, 'videos', opts)
  }

  channelShorts(ucid: string, opts: PageOptions = {}): Promise<ContinuationList<VideoSummary>> {
    return this.channelTab(ucid, 'shorts', opts)
  }

  channelStreams(ucid: string, opts: PageOptions = {}): Promise<ContinuationList<VideoSummary>> {
    return this.channelTab(ucid, 'streams', opts)
  }

  async channelPlaylists(
    ucid: string,
    opts: { sortBy?: 'newest' | 'last' } & PageOptions = {}
  ): Promise<ContinuationList<PlaylistDetails>> {
    const json = opts.continuation
      ? await this.call('browse', { continuation: opts.continuation })
      : await this.call('browse', { browseId: ucid, params: CHANNEL_TABS.playlists })
    const mapped = mapChannelVideos(json)
    return { playlists: [], continuation: mapped.continuation }
  }

  // ---- Playlists ---------------------------------------------------------

  async playlist(plid: string, opts: PageOptions = {}): Promise<PlaylistDetails> {
    void opts
    const key = 'playlist:' + plid
    const cached = this.cache.get<PlaylistDetails>(key)
    if (cached) return cached
    // Playlist browse ids are the playlist id prefixed with VL.
    const browseId = plid.startsWith('VL') ? plid : 'VL' + plid

    // The WEB client is preferred: it is the verified path and returns the richer
    // shape (author, description, view count). But it carries no account token, so
    // it cannot see a PRIVATE playlist - which is what Watch Later, Liked Videos and
    // most user-created playlists are. Signed in, fall back to the TV client, the
    // only one the token is valid for.
    let playlist: PlaylistDetails | null = null
    try {
      playlist = mapPlaylist(await this.call('browse', { browseId }))
    } catch (err) {
      if (!account.isSignedIn) throw err
    }

    if ((!playlist || playlist.videos.length === 0) && account.isSignedIn) {
      const tv = mapTvPlaylist(
        await this.call('browse', { browseId }, 'tv'),
        plid,
        playlist?.title ?? ''
      )
      if (tv.videos.length > 0) playlist = tv
    }

    if (!playlist) throw new HttpError('server', 'browse', 'The playlist returned nothing')
    this.cache.set(key, playlist, BROWSE_TTL_SECONDS)
    return playlist
  }
}

/** Depth-first search for the first continuation token in a response. */
function findContinuation(json: unknown): string | undefined {
  let found: string | undefined
  const seen = new Set<unknown>()

  const walk = (node: unknown): void => {
    if (found || node === null || typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)

    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }

    const record = node as Record<string, unknown>
    const token = record.token ?? record.continuation
    if (typeof token === 'string' && token.length > 20) {
      found = token
      return
    }
    for (const value of Object.values(record)) walk(value)
  }

  walk(json)
  return found
}
