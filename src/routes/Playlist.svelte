<script lang="ts">
  import type { PlaylistDetails } from '../lib/api/types'
  import { session } from '../lib/stores/session.svelte'
  import { router } from '../lib/router.svelte'
  import VideoCard from '../lib/components/VideoCard.svelte'
  import { formatCount } from '../lib/format'

  interface Props {
    plid: string
  }

  let { plid }: Props = $props()

  let playlist = $state<PlaylistDetails | null>(null)
  let loading = $state(true)
  let error = $state<string | null>(null)

  async function load() {
    loading = true
    error = null
    try {
      playlist = await session.api.playlist(plid)
    } catch {
      error = 'Could not load this playlist.'
    } finally {
      loading = false
    }
  }

  function playAll() {
    const first = playlist?.videos?.[0]
    if (first) router.go('watch', { v: first.videoId })
  }

  $effect(() => {
    if (!session.isReady || !plid) return
    void load()
  })
</script>

<div class="page">
  {#if loading}
    <div class="state"><p>Loading playlist…</p></div>
  {:else if error}
    <div class="state">
      <p>{error}</p>
      <button class="btn" onclick={load}>Try again</button>
    </div>
  {:else if playlist}
    <header class="head">
      <div>
        <h1>{playlist.title}</h1>
        <p class="meta tnum">
          {playlist.author} · {formatCount(playlist.videoCount)} videos
        </p>
        {#if playlist.description}
          <p class="description">{playlist.description}</p>
        {/if}
      </div>
      {#if playlist.videos?.length}
        <button class="btn accent" onclick={playAll}>Play all</button>
      {/if}
    </header>

    {#if playlist.videos?.length}
      <div class="grid">
        {#each playlist.videos as video (video.videoId)}
          <VideoCard {video} variant="grid" />
        {/each}
      </div>
    {:else}
      <div class="state"><p>This playlist has no videos.</p></div>
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
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-5);
  }

  h1 {
    font-size: 24px;
  }

  .meta {
    margin: var(--space-1) 0 0;
    color: var(--ink-dim);
    font-size: 13px;
  }

  .description {
    margin: var(--space-3) 0 0;
    color: var(--ink-dim);
    font-size: 13px;
    line-height: 1.6;
    max-width: 78ch;
    white-space: pre-wrap;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
    gap: var(--space-5) var(--space-4);
  }

  .btn {
    padding: 9px 20px;
    border-radius: var(--r-pill);
    background: var(--chip);
    font-weight: 600;
    font-size: 13px;
    flex: 0 0 auto;
  }

  .btn:hover {
    background: var(--chip-hover);
  }

  .btn.accent {
    background: var(--accent);
    color: #fff;
  }

  .btn.accent:hover {
    background: var(--accent-dim);
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
</style>
