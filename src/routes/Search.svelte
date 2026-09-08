<script lang="ts">
  import { untrack } from 'svelte'
  import type { SearchResult, VideoSummary, ChannelSummary, PlaylistSummary } from '../lib/api/types'
  import { session } from '../lib/stores/session.svelte'
  import { settings } from '../lib/stores/settings.svelte'
  import { router } from '../lib/router.svelte'
  import VideoCard from '../lib/components/VideoCard.svelte'
  import { formatCount, pickThumbnail } from '../lib/format'

  interface Props {
    query: string
  }

  let { query }: Props = $props()

  type SortOption = 'relevance' | 'date' | 'views' | 'rating'
  type TypeOption = 'all' | 'video' | 'channel' | 'playlist'

  let results = $state<SearchResult[]>([])
  let loading = $state(false)
  let loadingMore = $state(false)
  let error = $state<string | null>(null)
  // Deliberately NOT reactive: nothing renders these, and making them $state makes
  // them dependencies of the search effect below - which then re-runs every time a
  // response advances the page, resetting the results and searching again forever.
  let page = 1
  let exhausted = false
  let sort = $state<SortOption>('relevance')
  let type = $state<TypeOption>('all')

  const sorts: Array<{ value: SortOption; label: string }> = [
    { value: 'relevance', label: 'Relevance' },
    { value: 'date', label: 'Newest' },
    { value: 'views', label: 'Most viewed' },
    { value: 'rating', label: 'Top rated' }
  ]

  const types: Array<{ value: TypeOption; label: string }> = [
    { value: 'all', label: 'Everything' },
    { value: 'video', label: 'Videos' },
    { value: 'channel', label: 'Channels' },
    { value: 'playlist', label: 'Playlists' }
  ]

  const videos = $derived(results.filter((r): r is VideoSummary => r.type === 'video' || r.type === 'shortVideo'))
  const channels = $derived(results.filter((r): r is ChannelSummary => r.type === 'channel'))
  const playlists = $derived(results.filter((r): r is PlaylistSummary => r.type === 'playlist'))

  async function run(reset: boolean) {
    if (!query.trim()) return
    if (reset) {
      loading = true
      page = 1
      exhausted = false
      results = []
    } else {
      if (exhausted || loadingMore) return
      loadingMore = true
    }
    error = null

    try {
      const batch = await session.api.search({
        q: query,
        sort,
        type: type === 'all' ? undefined : [type],
        page
      })
      const filtered = settings.disableShorts ? batch.filter(r => r.type !== 'shortVideo') : batch
      results = reset ? filtered : [...results, ...filtered]
      // An empty page means there is nothing further to ask for.
      if (batch.length === 0) exhausted = true
      else page += 1
    } catch (err) {
      // "this instance" is meaningless on the direct backend, where there is none.
      const status = (err as { status?: number }).status
      error =
        session.kind === 'playlet'
          ? status === 401 || status === 403
            ? 'YouTube refused the search request.'
            : 'Search failed. YouTube may be rate limiting, or the connection dropped.'
          : 'Search failed on this instance.'
    } finally {
      loading = false
      loadingMore = false
    }
  }

  // The scroll container is the app's <main>, not the window or this element, so
  // infinite scroll watches a sentinel instead of guessing which node scrolls.
  let sentinel: HTMLDivElement | undefined = $state()

  $effect(() => {
    if (!sentinel) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) void run(false)
      },
      { rootMargin: '600px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  })

  $effect(() => {
    if (!session.isReady) return
    // Depend on exactly these three, and nothing `run` happens to touch.
    const currentQuery = query
    const currentSort = sort
    const currentType = type
    untrack(() => {
      void currentQuery
      void currentSort
      void currentType
      void run(true)
    })
  })
</script>

<div class="page">
  <header class="head">
    <h1>{query}</h1>
    <div class="filters">
      {#each types as option (option.value)}
        <button class="chip" class:on={type === option.value} onclick={() => (type = option.value)}>
          {option.label}
        </button>
      {/each}
      <span class="divider" aria-hidden="true"></span>
      {#each sorts as option (option.value)}
        <button class="chip" class:on={sort === option.value} onclick={() => (sort = option.value)}>
          {option.label}
        </button>
      {/each}
    </div>
  </header>

  {#if loading}
    <div class="grid">
      {#each Array(12) as _, i (i)}
        <div class="skeleton"></div>
      {/each}
    </div>
  {:else if error}
    <div class="state">
      <p>{error}</p>
      <button class="chip" onclick={() => run(true)}>Try again</button>
    </div>
  {:else if results.length === 0}
    <div class="state">
      <p>Nothing matched "{query}". Try fewer or different words.</p>
    </div>
  {:else}
    {#if channels.length > 0}
      <section>
        <h2>Channels</h2>
        <div class="channels">
          {#each channels as channel (channel.authorId)}
            <button class="channel" onclick={() => router.go('channel', { ucid: channel.authorId })}>
              {#if channel.authorThumbnails?.length}
                <img src={pickThumbnail(channel.authorThumbnails, 96)} alt="" width="56" height="56" />
              {/if}
              <span class="channel-body">
                <span class="channel-name">{channel.author}</span>
                <span class="channel-meta tnum">
                  {formatCount(channel.subCount)} subscribers · {formatCount(channel.videoCount)} videos
                </span>
              </span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    {#if playlists.length > 0}
      <section>
        <h2>Playlists</h2>
        <div class="grid">
          {#each playlists as playlist (playlist.playlistId)}
            <button class="playlist" onclick={() => router.go('playlist', { plid: playlist.playlistId })}>
              {#if playlist.playlistThumbnail}
                <img src={playlist.playlistThumbnail} alt="" />
              {/if}
              <span class="playlist-title clamp-2">{playlist.title}</span>
              <span class="playlist-meta tnum">{playlist.author} · {playlist.videoCount} videos</span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    {#if videos.length > 0}
      <section>
        {#if channels.length > 0 || playlists.length > 0}
          <h2>Videos</h2>
        {/if}
        <div class="grid">
          {#each videos as video (video.videoId)}
            <VideoCard {video} variant="grid" />
          {/each}
        </div>
      </section>
    {/if}

    <div bind:this={sentinel} class="sentinel" aria-hidden="true"></div>
    {#if loadingMore}
      <p class="more-note">Loading more…</p>
    {/if}
  {/if}
</div>

<style>
  .page {
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  h1 {
    font-size: 22px;
  }

  .filters {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .chip {
    padding: 5px 12px;
    border-radius: var(--r-pill);
    background: var(--chip);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-dim);
  }

  .chip:hover {
    background: var(--chip-hover);
    color: var(--ink);
  }

  .chip.on {
    background: var(--ink);
    color: var(--ground);
  }

  .divider {
    width: 1px;
    height: 18px;
    background: var(--edge);
    margin: 0 var(--space-1);
  }

  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
    gap: var(--space-5) var(--space-4);
  }

  .skeleton {
    aspect-ratio: 16 / 9;
    border-radius: var(--r-card);
    background: var(--chip);
  }

  .channels {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .channel {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3);
    border-radius: var(--r-card);
    text-align: left;
  }

  .channel:hover {
    background: var(--chip);
  }

  .channel img {
    border-radius: 50%;
  }

  .channel-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .channel-name {
    font-weight: 600;
  }

  .channel-meta {
    font-size: 12px;
    color: var(--ink-faint);
  }

  .playlist {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    text-align: left;
  }

  .playlist img {
    width: 100%;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: var(--r-card);
  }

  .playlist-title {
    font-size: 14px;
    font-weight: 600;
  }

  .playlist-meta {
    font-size: 12px;
    color: var(--ink-faint);
  }

  .state {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-6);
    border: 1px dashed var(--edge-soft);
    border-radius: var(--r-card);
    color: var(--ink-dim);
  }

  .state p {
    margin: 0;
  }

  .sentinel {
    height: 1px;
  }

  .more-note {
    text-align: center;
    color: var(--ink-faint);
    font-size: 13px;
  }
</style>
