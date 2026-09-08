<script lang="ts">
  import type { VideoSummary } from '../api/types'
  import VideoCard from './VideoCard.svelte'

  interface Props {
    title: string
    videos: VideoSummary[]
    loading?: boolean
    error?: string | null
    /** Shown instead of cards when the feed is genuinely empty. */
    emptyMessage?: string
    onRetry?: () => void
  }

  let { title, videos, loading = false, error = null, emptyMessage, onRetry }: Props = $props()

  let track: HTMLDivElement | undefined = $state()

  function scrollBy(direction: 1 | -1) {
    if (!track) return
    track.scrollBy({ left: direction * Math.round(track.clientWidth * 0.8), behavior: 'smooth' })
  }
</script>

<section class="shelf">
  <header>
    <h2>{title}</h2>
    {#if videos.length > 0}
      <div class="pager">
        <button onclick={() => scrollBy(-1)} aria-label={'Scroll ' + title + ' left'}>‹</button>
        <button onclick={() => scrollBy(1)} aria-label={'Scroll ' + title + ' right'}>›</button>
      </div>
    {/if}
  </header>

  {#if loading}
    <div class="track" aria-busy="true">
      {#each Array(6) as _, i (i)}
        <div class="skeleton" style="animation-delay: {i * 60}ms"></div>
      {/each}
    </div>
  {:else if error}
    <div class="state">
      <p>{error}</p>
      {#if onRetry}
        <button class="retry" onclick={onRetry}>Try again</button>
      {/if}
    </div>
  {:else if videos.length === 0}
    <div class="state">
      <p>{emptyMessage ?? 'Nothing here yet.'}</p>
    </div>
  {:else}
    <div class="track" bind:this={track}>
      {#each videos as video (video.videoId)}
        <VideoCard {video} />
      {/each}
    </div>
  {/if}
</section>

<style>
  .shelf {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-4);
    padding-right: var(--space-6);
  }

  .pager {
    display: flex;
    gap: var(--space-1);
    opacity: 0;
    transition: opacity 150ms var(--ease);
  }

  .shelf:hover .pager,
  .pager:focus-within {
    opacity: 1;
  }

  .pager button {
    width: 28px;
    height: 28px;
    border-radius: var(--r-control);
    background: var(--chip);
    color: var(--ink-dim);
    font-size: 18px;
    line-height: 1;
  }

  .pager button:hover {
    background: var(--chip-hover);
    color: var(--ink);
  }

  .track {
    display: flex;
    gap: var(--space-4);
    overflow-x: auto;
    scroll-snap-type: x proximity;
    padding-bottom: var(--space-2);
    scrollbar-width: none;
  }

  .track::-webkit-scrollbar {
    display: none;
  }

  .track > :global(.card) {
    scroll-snap-align: start;
  }

  .skeleton {
    flex: 0 0 auto;
    width: 260px;
    aspect-ratio: 16 / 9;
    border-radius: var(--r-card);
    background: linear-gradient(90deg, var(--chip) 0%, var(--chip-hi) 50%, var(--chip) 100%);
    background-size: 200% 100%;
    animation: shimmer 1.4s var(--ease) infinite;
  }

  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }

  .state {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-5);
    border: 1px dashed var(--edge-soft);
    border-radius: var(--r-card);
    color: var(--ink-dim);
  }

  .state p {
    margin: 0;
  }

  .retry {
    padding: 5px 12px;
    border-radius: var(--r-control);
    background: var(--chip-hi);
    color: var(--ink);
    font-weight: 600;
  }

  .retry:hover {
    background: var(--chip-hover);
  }
</style>
