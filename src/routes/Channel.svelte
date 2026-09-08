<script lang="ts">
  import type { ChannelDetails, VideoSummary } from '../lib/api/types'
  import { session } from '../lib/stores/session.svelte'
  import { library } from '../lib/stores/library.svelte'
  import VideoCard from '../lib/components/VideoCard.svelte'
  import { formatCount, pickThumbnail } from '../lib/format'

  interface Props {
    ucid: string
  }

  let { ucid }: Props = $props()

  type Tab = 'videos' | 'shorts' | 'streams'

  let channel = $state<ChannelDetails | null>(null)
  let videos = $state<VideoSummary[]>([])
  let continuation = $state<string | undefined>(undefined)
  let tab = $state<Tab>('videos')
  let loading = $state(true)
  let loadingMore = $state(false)
  let error = $state<string | null>(null)

  const subscribed = $derived(channel ? library.isSubscribed(channel.authorId) : false)
  const banner = $derived(channel?.authorBanners?.length ? pickThumbnail(channel.authorBanners, 1280) : undefined)

  const tabs: Array<{ value: Tab; label: string }> = [
    { value: 'videos', label: 'Videos' },
    { value: 'shorts', label: 'Shorts' },
    { value: 'streams', label: 'Live' }
  ]

  async function loadChannel() {
    loading = true
    error = null
    try {
      channel = await session.api.channel(ucid)
      await loadTab(true)
    } catch {
      error = 'Could not load this channel.'
    } finally {
      loading = false
    }
  }

  async function loadTab(reset: boolean) {
    if (reset) {
      videos = []
      continuation = undefined
    } else if (!continuation || loadingMore) {
      return
    }

    if (!reset) loadingMore = true
    try {
      const opts = { continuation: reset ? undefined : continuation }
      const response =
        tab === 'shorts'
          ? await session.api.channelShorts(ucid, opts)
          : tab === 'streams'
            ? await session.api.channelStreams(ucid, opts)
            : await session.api.channelVideos(ucid, { ...opts, sortBy: 'newest' })

      videos = reset ? (response.videos ?? []) : [...videos, ...(response.videos ?? [])]
      continuation = response.continuation
    } catch {
      if (reset) error = 'Could not load videos for this channel.'
    } finally {
      loadingMore = false
    }
  }

  function toggleSubscribe() {
    if (!channel) return
    void library.toggleSubscription({
      authorId: channel.authorId,
      author: channel.author,
      thumbnail: channel.authorThumbnails?.[0]?.url
    })
  }

  function switchTab(next: Tab) {
    if (tab === next) return
    tab = next
    void loadTab(true)
  }

  $effect(() => {
    if (!session.isReady || !ucid) return
    void loadChannel()
  })
</script>

<div class="page">
  {#if loading}
    <div class="head-skeleton"></div>
  {:else if error}
    <div class="state">
      <p>{error}</p>
      <button class="chip" onclick={loadChannel}>Try again</button>
    </div>
  {:else if channel}
    <header class="head">
      {#if banner}
        <img class="banner" src={banner} alt="" />
      {/if}

      <div class="identity">
        {#if channel.authorThumbnails?.length}
          <img class="avatar" src={pickThumbnail(channel.authorThumbnails, 160)} alt="" width="80" height="80" />
        {/if}
        <div class="identity-text">
          <h1>{channel.author}</h1>
          <p class="stats tnum">
            {formatCount(channel.subCount)} subscribers · {formatCount(channel.videoCount)} videos
          </p>
        </div>
        <button class="btn subscribe" class:on={subscribed} onclick={toggleSubscribe}>
          {subscribed ? 'Subscribed' : 'Subscribe'}
        </button>
      </div>

      {#if channel.description}
        <p class="description">{channel.description}</p>
      {/if}

      <nav class="tabs">
        {#each tabs as option (option.value)}
          <button class="tab" class:on={tab === option.value} onclick={() => switchTab(option.value)}>
            {option.label}
          </button>
        {/each}
      </nav>
    </header>

    {#if videos.length === 0}
      <div class="state">
        <p>Nothing published in this section.</p>
      </div>
    {:else}
      <div class="grid">
        {#each videos as video (video.videoId)}
          <VideoCard {video} variant="grid" />
        {/each}
      </div>

      {#if continuation}
        <button class="load-more" onclick={() => loadTab(false)} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    padding: 0 var(--space-5) var(--space-7);
  }

  .head-skeleton {
    height: 220px;
    border-radius: var(--r-card);
    background: var(--chip);
    margin-top: var(--space-5);
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .banner {
    width: 100%;
    max-height: 180px;
    object-fit: cover;
    border-radius: 0 0 var(--r-card) var(--r-card);
    margin: 0 calc(-1 * var(--space-5));
    width: calc(100% + var(--space-5) * 2);
  }

  .identity {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }

  .avatar {
    border-radius: 50%;
  }

  .identity-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  h1 {
    font-size: 24px;
  }

  .stats {
    margin: 0;
    color: var(--ink-dim);
    font-size: 13px;
  }

  .btn {
    margin-left: auto;
    padding: 8px 18px;
    border-radius: var(--r-pill);
    background: var(--chip);
    font-weight: 600;
    font-size: 13px;
  }

  .btn:hover {
    background: var(--chip-hover);
  }

  .subscribe.on {
    background: var(--accent-wash);
    color: var(--accent);
  }

  .description {
    margin: 0;
    color: var(--ink-dim);
    font-size: 13px;
    line-height: 1.6;
    max-width: 80ch;
    white-space: pre-wrap;
  }

  .tabs {
    display: flex;
    gap: var(--space-4);
    border-bottom: 1px solid var(--edge-soft);
  }

  .tab {
    padding: var(--space-2) 2px;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink-faint);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }

  .tab:hover {
    color: var(--ink-dim);
  }

  .tab.on {
    color: var(--ink);
    border-bottom-color: var(--accent);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
    gap: var(--space-5) var(--space-4);
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

  .chip,
  .load-more {
    padding: 6px 14px;
    border-radius: var(--r-pill);
    background: var(--chip);
    font-size: 13px;
    font-weight: 600;
  }

  .load-more {
    align-self: center;
    padding: 9px 22px;
  }

  .load-more:hover:not(:disabled) {
    background: var(--chip-hover);
  }

  .load-more:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
