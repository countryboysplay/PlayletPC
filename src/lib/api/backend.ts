/**
 * The contract every backend satisfies.
 *
 * The UI is written against Invidious' response shapes, so both backends return those
 * shapes: the Invidious client because it genuinely speaks that API, and the InnerTube
 * client because it maps YouTube's own responses onto them. This mirrors how the
 * upstream Roku app works - it runs a local server that fakes the Invidious REST API
 * on top of InnerTube - and means switching backends changes no component.
 */

import type {
  ChannelDetails,
  CommentsResponse,
  PlaylistDetails,
  SearchResult,
  VideoDetails,
  VideoSummary
} from './types'

export type BackendKind = 'playlet' | 'invidious'

export interface ContinuationList<T> {
  videos?: T[]
  playlists?: T[]
  continuation?: string
}

export interface PageOptions {
  page?: number
  continuation?: string
  signal?: AbortSignal
}

export interface Backend {
  readonly kind: BackendKind
  /**
   * The Invidious instance backing this client, or '' for the direct backend.
   * The player uses it to rewrite media URLs through a proxy; an empty value means
   * the URLs are already directly playable and must not be rewritten.
   */
  readonly instance: string

  trending(opts?: { type?: 'Livestreams' | 'Gaming'; region?: string; signal?: AbortSignal }): Promise<VideoSummary[]>
  popular(opts?: { signal?: AbortSignal }): Promise<VideoSummary[]>

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
  }): Promise<SearchResult[]>

  video(videoId: string, opts?: { noCache?: boolean; signal?: AbortSignal }): Promise<VideoDetails>
  comments(videoId: string, opts?: { continuation?: string; sortBy?: 'top' | 'new'; signal?: AbortSignal }): Promise<CommentsResponse>

  channel(ucid: string, opts?: { signal?: AbortSignal }): Promise<ChannelDetails>
  channelVideos(ucid: string, opts?: { sortBy?: 'newest' | 'oldest' | 'popular' } & PageOptions): Promise<ContinuationList<VideoSummary>>
  channelShorts(ucid: string, opts?: PageOptions): Promise<ContinuationList<VideoSummary>>
  channelStreams(ucid: string, opts?: PageOptions): Promise<ContinuationList<VideoSummary>>
  channelPlaylists(ucid: string, opts?: { sortBy?: 'newest' | 'last' } & PageOptions): Promise<ContinuationList<PlaylistDetails>>

  playlist(plid: string, opts?: PageOptions): Promise<PlaylistDetails>

  clearCache(): void
}
