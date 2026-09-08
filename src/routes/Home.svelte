<script lang="ts">
  import { untrack } from 'svelte'
  import homeLayout from '../lib/data/default_home_layout.json'
  import type { VideoSummary } from '../lib/api/types'
  import { session } from '../lib/stores/session.svelte'
  import { settings } from '../lib/stores/settings.svelte'
  import { library } from '../lib/stores/library.svelte'
  import Shelf from '../lib/components/Shelf.svelte'
  import VideoCard from '../lib/components/VideoCard.svelte'

  interface FeedSource {
    id: string
    title: string
    apiType: string
    endpoint: string
    queryParams?: Record<string, string>
  }

  interface LayoutRow {
    title: string
    id: string
    feedSources: FeedSource[]
  }

  interface ShelfState {
    id: string
    title: string
    videos: VideoSummary[]
    loading: boolean
    error: string | null
  }

  const layout = homeLayout as unknown as LayoutRow[]

  /**
   * Rows backed by an Invidious account are dropped until account linking exists;
   * showing a permanently empty "Subscriptions" row would read as a broken app.
   * Local subscriptions are surfaced separately below.
   */
  const ACCOUNT_ENDPOINTS = new Set(['auth_feed', 'auth_recommended', 'auth_playlists', 'watch_history'])

  /**
   * The shipped layout is written for Invidious, which serves distinct Trending and
   * Popular feeds. YouTube has retired Trending, so the direct backend resolves all of
   * those to one Recommended feed - showing it three times under three names would be
   * worse than showing it once.
   */
  const rows = $derived(
    session.kind === 'playlet'
      ? []
      : layout.filter(row => row.feedSources.every(source => !ACCOUNT_ENDPOINTS.has(source.endpoint)))
  )


  let shelves = $state<ShelfState[]>([])
  let subscriptionVideos = $state<VideoSummary[]>([])
  let subscriptionsLoading = $state(false)

  const continueWatching = $derived(library.continueWatching.slice(0, 12))
  /**
   * On the direct backend there is no editorial feed to show: YouTube retired Trending
   * and the signed-out Recommended feed comes back empty. So Home is built from what
   * the user actually has, and says so plainly when they have nothing yet.
   */
  const hasAnything = $derived(
    continueWatching.length > 0 || library.subscriptions.length > 0 || rows.length > 0
  )

  async function loadRow(row: LayoutRow): Promise<void> {
    const source = row.feedSources[0]
    const index = shelves.findIndex(s => s.id === row.id)
    if (index === -1) return

    const update = (patch: Partial<ShelfState>) => {
      shelves = shelves.map(s => (s.id === row.id ? { ...s, ...patch } : s))
    }

    update({ loading: true, error: null })
    try {
      let videos: VideoSummary[] = []
      if (source.endpoint === 'trending') {
        const type = source.queryParams?.type as 'Livestreams' | 'Gaming' | undefined
        videos = await session.api.trending({ type })
      } else if (source.endpoint === 'popular') {
        videos = await session.api.popular()
      }
      update({ videos: filterFeed(videos), loading: false })
    } catch (err) {
      update({ loading: false, error: describeError(err) })
    }
  }

  function filterFeed(videos: VideoSummary[]): VideoSummary[] {
    if (!Array.isArray(videos)) return []
    return settings.disableShorts ? videos.filter(v => v.type !== 'shortVideo') : videos
  }

  function describeError(err: unknown): string {
    const error = err as { kind?: string; status?: number }
    // Instance admins routinely switch individual endpoints off; that is a property of
    // the instance, not a failure the user can retry away.
    const direct = session.kind === 'playlet'
    if (error.status === 403 || error.status === 401) {
      return direct ? 'YouTube refused this request.' : 'Turned off on this instance.'
    }
    if (error.kind === 'rate_limited') {
      return direct ? 'YouTube is rate limiting requests. Try again shortly.' : 'This instance is rate limiting requests. Try again shortly.'
    }
    if (error.kind === 'server' || error.kind === 'network') {
      return direct ? 'YouTube did not respond.' : 'This Invidious instance did not respond.'
    }
    return 'Could not load this feed.'
  }

  /**
   * The subscriptions shelf has two sources: the account's own feed when signed in,
   * and otherwise a shelf assembled from channels subscribed to locally on this PC.
   */
  async function loadSubscriptions(): Promise<void> {
    const subs = library.subscriptions.slice(0, 8)
    if (subs.length === 0) {
      subscriptionVideos = []
      return
    }
    subscriptionsLoading = true
    try {
      const results = await Promise.allSettled(
        subs.map(sub => session.api.channelVideos(sub.authorId, { sortBy: 'newest' }))
      )
      const collected: VideoSummary[] = []
      for (const result of results) {
        if (result.status !== 'fulfilled') continue
        const videos = result.value.videos ?? []
        collected.push(...videos.slice(0, 4))
      }
      collected.sort((a, b) => (b.published ?? 0) - (a.published ?? 0))
      subscriptionVideos = filterFeed(collected).slice(0, 20)
    } finally {
      subscriptionsLoading = false
    }
  }

  let started = false

  $effect(() => {
    if (!session.isReady || started) return
    started = true
    // untrack so that writing to `shelves` while loading does not invalidate this
    // effect and schedule redundant re-runs.
    untrack(() => {
      // Seed placeholders first so each row can load, and fail, independently.
      shelves = rows.map(row => ({ id: row.id, title: row.title, videos: [], loading: true, error: null }))
      for (const row of rows) void loadRow(row)
      void loadSubscriptions()
    })
  })
</script>

<div class="page">
  {#if session.failedOverFrom}
    <div class="notice">
      <p>
        <strong>{session.failedOverFrom}</strong> wasn't responding, so Playlet switched to
        <strong>{session.instance}</strong>.
      </p>
    </div>
  {/if}

  {#if continueWatching.length > 0}
    <section class="shelf-block">
      <header class="block-head"><h2>Continue watching</h2></header>
      <div class="resume-track">
        {#each continueWatching as record (record.videoId)}
          <VideoCard
            video={{
              type: 'video',
              title: record.title,
              videoId: record.videoId,
              author: record.author,
              authorId: record.authorId,
              videoThumbnails: record.thumbnail
                ? [{ url: record.thumbnail, width: 480, height: 270 }]
                : [],
              viewCount: 0,
              lengthSeconds: record.lengthSeconds
            }}
          />
        {/each}
      </div>
    </section>
  {/if}

  {#if library.subscriptions.length > 0}
    <Shelf
      title="From channels you follow"
      videos={subscriptionVideos}
      loading={subscriptionsLoading}
      emptyMessage="No recent uploads from the channels you follow."
      onRetry={loadSubscriptions}
    />
  {/if}

  {#if !hasAnything}
    <section class="first-run">
      <h1>Find something to watch</h1>
      <p>
        Playlet talks to YouTube directly, and a signed-out YouTube has no front page to
        show. Search for something, then subscribe to the channels you like — their new
        uploads collect here, and everything stays on this PC.
      </p>
      <div class="first-run-actions">
        <button class="cta" onclick={() => document.querySelector<HTMLInputElement>('header input[type=search]')?.focus()}>
          Search
        </button>
        <span class="hint">or press <kbd>Ctrl</kbd>+<kbd>F</kbd></span>
      </div>
    </section>
  {/if}

  {#each shelves as shelf (shelf.id)}
    <Shelf
      title={shelf.title}
      videos={shelf.videos}
      loading={shelf.loading}
      error={shelf.error}
      onRetry={() => {
        const row = rows.find(r => r.id === shelf.id)
        if (row) void loadRow(row)
      }}
    />
  {/each}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    padding: var(--space-5) 0 var(--space-7) var(--space-5);
  }

  .notice {
    margin-right: var(--space-5);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--r-card);
    background: var(--accent-wash);
    border: 1px solid rgba(255, 28, 48, 0.3);
  }

  .notice p {
    margin: 0;
    font-size: 13px;
  }

  .shelf-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .block-head {
    padding-right: var(--space-6);
  }

  .resume-track {
    display: flex;
    gap: var(--space-4);
    overflow-x: auto;
    padding-bottom: var(--space-2);
    scrollbar-width: none;
  }

  .resume-track::-webkit-scrollbar {
    display: none;
  }

  .first-run {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
    max-width: 56ch;
    padding: var(--space-7) 0 var(--space-5);
  }

  .first-run p {
    margin: 0;
    color: var(--ink-dim);
    line-height: 1.65;
  }

  .first-run-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-2);
  }

  .cta {
    padding: 9px 22px;
    border-radius: var(--r-pill);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }

  .cta:hover {
    background: var(--accent-dim);
  }

  .hint {
    font-size: 12px;
    color: var(--ink-faint);
  }

  kbd {
    font-family: var(--font-ui);
    font-size: 11px;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--chip-hi);
    border: 1px solid var(--edge);
  }
</style>
