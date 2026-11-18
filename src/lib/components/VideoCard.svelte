<script lang="ts">
  import type { VideoSummary } from '../api/types'
  import { formatDuration, formatViews, formatRelativeTime, pickThumbnail } from '../format'
  import { router } from '../router.svelte'
  import { library } from '../stores/library.svelte'
  import { queue } from '../stores/queue.svelte'
  import { settings } from '../stores/settings.svelte'

  interface Props {
    video: VideoSummary
    /** Shelf cards are fixed-width; grid cards fill their column. */
    variant?: 'shelf' | 'grid'
  }

  let { video, variant = 'shelf' }: Props = $props()

  const thumbnail = $derived(pickThumbnail(video.videoThumbnails, variant === 'shelf' ? 360 : 480))
  const isLive = $derived(video.liveNow === true)
  const resumePosition = $derived(library.getResumePosition(video.videoId))
  const progressPercent = $derived(
    video.lengthSeconds > 0 && resumePosition > 0
      ? Math.min(100, (resumePosition / video.lengthSeconds) * 100)
      : 0
  )
  const meta = $derived(
    [formatViews(video.viewCount), video.publishedText || formatRelativeTime(video.published)]
      .filter(Boolean)
      .join(' · ')
  )

  function open() {
    router.go('watch', { v: video.videoId })
  }

  /** Confirms the click when "Queue notifications" is on (Settings, Misc). */
  let queued = $state<string | null>(null)
  let queuedTimer: ReturnType<typeof setTimeout> | undefined

  function enqueue(next: boolean) {
    if (next) queue.addNext(video)
    else queue.add(video)
    if (!settings.get<boolean>('misc.queue_notifications')) return
    queued = next ? 'Plays next' : 'Added to queue'
    clearTimeout(queuedTimer)
    queuedTimer = setTimeout(() => (queued = null), 1500)
  }

  function openChannel(event: MouseEvent) {
    event.stopPropagation()
    if (video.authorId) router.go('channel', { ucid: video.authorId })
  }
</script>

<article class="card" class:grid={variant === 'grid'}>
  <button class="hit" onclick={open} aria-label={'Play ' + video.title}>
    <div class="thumb">
      {#if thumbnail}
        <img src={thumbnail} alt="" loading="lazy" decoding="async" />
      {:else}
        <div class="thumb-empty"></div>
      {/if}

      {#if isLive}
        <span class="badge live">Live</span>
      {:else if video.lengthSeconds > 0}
        <span class="badge tnum">{formatDuration(video.lengthSeconds)}</span>
      {/if}

      {#if progressPercent > 0}
        <div class="resume" style="--pct: {progressPercent}%" aria-hidden="true"></div>
      {/if}
    </div>
  </button>

  <div class="queue-actions" class:shown={queued}>
    {#if queued}
      <span role="status">{queued}</span>
    {:else}
      <button onclick={() => enqueue(true)}>Play next</button>
      <button onclick={() => enqueue(false)}>Add to queue</button>
    {/if}
  </div>

  <div class="body">
    <h3 class="title clamp-2" title={video.title}>
      <button class="hit-text" onclick={open}>{video.title}</button>
    </h3>
    {#if video.author}
      <button class="author" onclick={openChannel}>{video.author}</button>
    {/if}
    {#if meta}
      <p class="meta tnum">{meta}</p>
    {/if}
  </div>
</article>

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 260px;
    flex: 0 0 auto;
  }

  .card.grid {
    width: auto;
    flex: 1 1 auto;
  }

  .hit {
    display: block;
    width: 100%;
    border-radius: var(--r-card);
  }

  .thumb {
    position: relative;
    aspect-ratio: 16 / 9;
    border-radius: var(--r-card);
    overflow: hidden;
    background: var(--chip);
  }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 220ms var(--ease);
  }

  .card:hover .thumb img {
    transform: scale(1.03);
  }

  .thumb-empty {
    width: 100%;
    height: 100%;
    background: linear-gradient(135deg, var(--chip), var(--chip-hi));
  }

  .badge {
    position: absolute;
    right: var(--space-2);
    bottom: var(--space-2);
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.82);
    font-size: 12px;
    font-weight: 600;
    line-height: 1.4;
  }

  /* Red means state, and "broadcasting right now" is the strongest state a card has. */
  .badge.live {
    background: var(--accent);
    color: #fff;
  }

  .resume {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgba(0, 0, 0, 0.6);
  }

  .resume::after {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--pct);
    background: var(--accent);
  }

  /* Over the thumbnail's top corner, shown on hover or keyboard focus. */
  .queue-actions {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 120ms var(--ease);
  }

  .card:hover .queue-actions,
  .queue-actions:focus-within,
  .queue-actions.shown {
    opacity: 1;
  }

  .queue-actions button,
  .queue-actions span {
    padding: 3px 8px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.82);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
  }

  .queue-actions button:hover {
    background: rgba(0, 0, 0, 0.95);
    color: var(--accent);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .title {
    font-size: 14px;
    font-weight: 600;
    line-height: 1.35;
    margin: 0;
  }

  .hit-text {
    text-align: left;
    display: block;
    width: 100%;
  }

  .author {
    text-align: left;
    color: var(--ink-dim);
    font-size: 13px;
    width: fit-content;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .author:hover {
    color: var(--ink);
  }

  .meta {
    margin: 0;
    color: var(--ink-faint);
    font-size: 12px;
  }
</style>
