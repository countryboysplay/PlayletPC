<script lang="ts">
  import type { VideoSummary } from '../lib/api/types'
  import { session } from '../lib/stores/session.svelte'
  import { library } from '../lib/stores/library.svelte'
  import { settings } from '../lib/stores/settings.svelte'
  import { router } from '../lib/router.svelte'
  import { account } from '../lib/stores/account.svelte'
  import VideoCard from '../lib/components/VideoCard.svelte'

  let videos = $state<VideoSummary[]>([])
  let loading = $state(false)
  let failedChannels = $state(0)

  async function load() {
    const subs = library.subscriptions
    if (subs.length === 0) {
      videos = []
      return
    }

    loading = true
    failedChannels = 0
    try {
      const results = await Promise.allSettled(
        subs.map(sub => session.api.channelVideos(sub.authorId, { sortBy: 'newest' }))
      )
      const collected: VideoSummary[] = []
      for (const result of results) {
        if (result.status !== 'fulfilled') {
          failedChannels += 1
          continue
        }
        collected.push(...(result.value.videos ?? []).slice(0, 6))
      }
      collected.sort((a, b) => (b.published ?? 0) - (a.published ?? 0))
      videos = settings.disableShorts ? collected.filter(v => v.type !== 'shortVideo') : collected
    } finally {
      loading = false
    }
  }

  $effect(() => {
    if (!session.isReady) return
    void load()
  })
</script>

<div class="page">
  <header class="head">
    <h1>Subscriptions</h1>
    {#if library.subscriptions.length > 0}
      <button class="btn" onclick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
    {/if}
  </header>

  {#if session.accountPlaylists.length > 0}
    <section class="playlists">
      <h2 class="section-title">Your playlists</h2>
      <div class="playlist-row">
        {#each session.accountPlaylists as pl (pl.playlistId)}
          <button class="playlist" onclick={() => router.go('playlist', { plid: pl.playlistId })}>
            {#if pl.playlistThumbnail}
              <img src={pl.playlistThumbnail} alt="" loading="lazy" />
            {:else}
              <div class="playlist-blank" aria-hidden="true"></div>
            {/if}
            <span class="playlist-title">{pl.title}</span>
            <span class="playlist-count">
              {pl.videoCount === 0 ? 'Empty' : pl.videoCount + (pl.videoCount === 1 ? ' video' : ' videos')}
            </span>
          </button>
        {/each}
      </div>
    </section>
  {/if}

  {#if library.subscriptions.length === 0}
    <div class="empty">
      {#if session.accountSyncing}
        <h2>Getting your subscriptions from YouTube…</h2>
      {:else}
        <h2>You haven't subscribed to anything yet</h2>
        <p>
          Subscribe from any channel page and its newest uploads collect here. Subscriptions are
          stored on this PC — they aren't sent anywhere.
        </p>
        {#if !account.isSignedIn}
          <p>Signing in to YouTube brings your existing subscriptions and playlists across.</p>
        {/if}
        <button class="btn accent" onclick={() => router.go('home')}>Browse videos</button>
      {/if}
    </div>
  {:else}
    <section class="channels">
      {#each library.subscriptions as sub (sub.authorId)}
        <button class="channel-chip" onclick={() => router.go('channel', { ucid: sub.authorId })}>
          {#if sub.thumbnail}
            <img src={sub.thumbnail} alt="" width="24" height="24" />
          {/if}
          <span>{sub.author}</span>
        </button>
      {/each}
    </section>

    {#if failedChannels > 0}
      <p class="warning">
        {failedChannels} of {library.subscriptions.length} channels didn't load from this instance.
      </p>
    {/if}

    {#if loading && videos.length === 0}
      <div class="grid">
        {#each Array(8) as _, i (i)}
          <div class="skeleton"></div>
        {/each}
      </div>
    {:else if videos.length === 0}
      <div class="empty"><p>No recent uploads from these channels.</p></div>
    {:else}
      <div class="grid">
        {#each videos as video (video.videoId)}
          <VideoCard {video} variant="grid" />
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    padding: var(--space-5);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h1 {
    font-size: 24px;
  }

  .channels {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .section-title {
    font-size: 15px;
    font-weight: 600;
    margin-bottom: var(--space-3);
  }

  .playlist-row {
    display: flex;
    gap: var(--space-3);
    overflow-x: auto;
    padding-bottom: var(--space-2);
  }

  .playlist {
    flex: 0 0 180px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0;
    background: none;
    border: 0;
    text-align: left;
    cursor: pointer;
    color: inherit;
  }

  .playlist img,
  .playlist-blank {
    width: 100%;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: var(--r-md);
    background: var(--chip);
  }

  .playlist-title {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .playlist-count {
    font-size: 12px;
    opacity: 0.7;
  }

  .channel-chip {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 4px 12px 4px 4px;
    border-radius: var(--r-pill);
    background: var(--chip);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-dim);
  }

  .channel-chip:hover {
    background: var(--chip-hover);
    color: var(--ink);
  }

  .channel-chip img {
    border-radius: 50%;
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

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-7) var(--space-5);
    text-align: center;
    border: 1px dashed var(--edge-soft);
    border-radius: var(--r-card);
  }

  .empty p {
    margin: 0;
    color: var(--ink-dim);
    max-width: 52ch;
  }

  .warning {
    margin: 0;
    font-size: 12px;
    color: var(--ink-faint);
  }

  .btn {
    padding: 7px 16px;
    border-radius: var(--r-pill);
    background: var(--chip);
    font-size: 13px;
    font-weight: 600;
  }

  .btn:hover:not(:disabled) {
    background: var(--chip-hover);
  }

  .btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .btn.accent {
    background: var(--accent);
    color: #fff;
    margin-top: var(--space-2);
  }
</style>
