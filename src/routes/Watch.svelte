<script lang="ts">
  import type { VideoDetails } from '../lib/api/types'
  import { session } from '../lib/stores/session.svelte'
  import { library } from '../lib/stores/library.svelte'
  import { settings } from '../lib/stores/settings.svelte'
  import { router } from '../lib/router.svelte'
  import { queue } from '../lib/stores/queue.svelte'
  import { shell } from '../lib/shell'
  import VideoPlayer from '../lib/components/VideoPlayer.svelte'
  import VideoCard from '../lib/components/VideoCard.svelte'
  import Comments from '../lib/components/Comments.svelte'
  import StaggerText from '../lib/components/StaggerText.svelte'
  import Icon from '../lib/components/Icon.svelte'
  import AnimatedNumber from '../lib/components/AnimatedNumber.svelte'
  import { storage } from '../lib/stores/storage'
  import { formatViews, formatRelativeTime, pickThumbnail } from '../lib/format'

  interface Props {
    videoId: string
  }

  let { videoId }: Props = $props()

  let video = $state<VideoDetails | null>(null)
  let loading = $state(true)
  let error = $state<string | null>(null)
  let descriptionOpen = $state(false)
  // Up next can fold away to give the video more width; the choice outlives the page.
  let upNextCollapsed = $state(false)
  void storage.get<boolean>('ui.upNextCollapsed').then(v => (upNextCollapsed = v ?? false))

  // The room lights up from the screen: the video's average color, sampled once a
  // second from an 8x8 copy, glows on the graphite around the player.
  let glow = $state('transparent')
  $effect(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 8
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const timer = setInterval(() => {
      const v = document.querySelector<HTMLVideoElement>('.player-slot video')
      if (!ctx || !v || v.readyState < 2 || v.paused) return
      try {
        ctx.drawImage(v, 0, 0, 8, 8)
        const d = ctx.getImageData(0, 0, 8, 8).data
        let r = 0
        let g = 0
        let b = 0
        for (let i = 0; i < d.length; i += 4) {
          r += d[i]
          g += d[i + 1]
          b += d[i + 2]
        }
        const n = d.length / 4
        glow = `rgb(${Math.round(r / n)} ${Math.round(g / n)} ${Math.round(b / n)})`
      } catch {
        // The 360p fallback is a cross-origin stream, which taints the canvas: no glow.
      }
    }, 1000)
    return () => clearInterval(timer)
  })

  function toggleUpNext() {
    upNextCollapsed = !upNextCollapsed
    void storage.set('ui.upNextCollapsed', upNextCollapsed)
  }

  const subscribed = $derived(video ? library.isSubscribed(video.authorId) : false)
  // No manifest on the direct backend means the ladder fell through to the ANDROID
  // client, whose only usable stream is muxed 360p. Say so rather than look broken.
  const reducedQuality = $derived(
    Boolean(video && session.isDirect && !video.dashManifestXml && !video.liveNow && !video.hlsUrl)
  )
  const startAt = $derived(video ? library.getResumePosition(video.videoId) : 0)
  const recommendations = $derived(
    video ? (settings.disableShorts ? video.recommendedVideos.filter(v => v.type !== 'shortVideo') : video.recommendedVideos) : []
  )

  async function load(id: string) {
    loading = true
    error = null
    video = null
    descriptionOpen = false
    try {
      video = await session.api.video(id)
    } catch (err) {
      error =
        (err as { kind?: string }).kind === 'not_found'
          ? 'This video is not available on the current instance.'
          : 'Could not load this video.'
    } finally {
      loading = false
    }
  }

  function recordProgress(seconds: number) {
    if (!video) return
    void library.recordProgress(
      {
        videoId: video.videoId,
        title: video.title,
        author: video.author,
        authorId: video.authorId,
        thumbnail: pickThumbnail(video.videoThumbnails, 480),
        lengthSeconds: video.lengthSeconds
      },
      seconds
    )
  }

  /** Explicit "next" (media key, flyout); autoplay at the end goes through playNext. */
  function skipNext() {
    const next = queue.next(videoId, recommendations[0])
    if (next) router.go('watch', { v: next.videoId })
  }

  function skipPrevious() {
    const previous = queue.previous()
    if (previous) router.go('watch', { v: previous })
  }

  /** At the end of a video. Queued videos play even with autoplay off: queueing asked for them. */
  function playNext() {
    if (settings.autoplay || queue.items.length) skipNext()
  }

  function toggleSubscribe() {
    if (!video) return
    void library.toggleSubscription({
      authorId: video.authorId,
      author: video.author,
      thumbnail: video.authorThumbnails?.[0]?.url
    })
  }

  $effect(() => {
    if (!session.isReady || !videoId) return
    void load(videoId)
  })
</script>

<!-- The video is the hero: the page never scrolls, so the player never moves. Only the
     details under it and the Up next panel scroll, each on its own. -->
<div class="page" class:collapsed={upNextCollapsed} style="--glow: {glow}">
  <div class="primary">
    {#if loading}
      <div class="player-slot"><div class="stage-skeleton"></div></div>
    {:else if error}
      <div class="failure">
        <h1>{error}</h1>
        <div class="failure-actions">
          <button class="btn accent" onclick={() => load(videoId)}>Try again</button>
          <button class="btn" onclick={() => router.go('settings')}>Change instance</button>
        </div>
      </div>
    {:else if video}
      <div class="player-slot">
        {#key video.videoId}
          <VideoPlayer
            {video}
            {startAt}
            onProgress={recordProgress}
            onEnded={playNext}
            onNext={queue.items.length || recommendations.length ? skipNext : undefined}
            onPrevious={queue.hasPrevious ? skipPrevious : undefined}
          />
        {/key}
      </div>

      <div class="bottom-bar panel zone-graphite">
        <div class="info">
          {#if reducedQuality}
            <p class="fallback-note" role="status">
              YouTube's full-quality stream isn't available right now, so this is playing at 360p.
            </p>
          {/if}

          <h1 class="title clamp-2"><StaggerText text={video.title} /></h1>

          <div class="meta-row">
            <button class="channel" onclick={() => router.go('channel', { ucid: video!.authorId })}>
              {#if video.authorThumbnails?.length}
                <img src={video.authorThumbnails[0].url} alt="" width="36" height="36" />
              {/if}
              <span class="channel-text">
                <span class="channel-name">{video.author}</span>
                {#if video.subCountText}
                  <span class="sub-count">{video.subCountText}</span>
                {/if}
              </span>
            </button>

            <button class="btn subscribe" class:on={subscribed} onclick={toggleSubscribe}>
              {subscribed ? 'Subscribed' : 'Subscribe'}
            </button>

            <div class="spacer"></div>

            <span class="stat tnum"><AnimatedNumber value={video.viewCount} format={formatViews} /></span>
            {#if video.likeCount}
              <span class="stat tnum"><AnimatedNumber value={video.likeCount} /> likes</span>
            {/if}
            <span class="stat tnum">{video.publishedText || formatRelativeTime(video.published)}</span>

            <button class="btn" onclick={() => shell.openExternal('https://www.youtube.com/watch?v=' + video!.videoId)}>
              Open on YouTube
            </button>
          </div>
        </div>

        <div class="details">
          {#if video.description}
            <section class="fold">
              <button class="fold-head" aria-expanded={descriptionOpen} onclick={() => (descriptionOpen = !descriptionOpen)}>
                Description
                <Icon name={descriptionOpen ? 'up' : 'down'} />
              </button>
              {#if descriptionOpen}
                <p class="description">{video.description}</p>
              {/if}
            </section>
          {/if}

          {#key video.videoId}
            <Comments videoId={video.videoId} />
          {/key}
        </div>
      </div>
    {/if}
  </div>

  <aside class="side panel zone-graphite" aria-label="Up next">
    <div class="side-head">
      <button
        class="fold-btn"
        onclick={toggleUpNext}
        aria-expanded={!upNextCollapsed}
        aria-label={upNextCollapsed ? 'Show Up next' : 'Hide Up next'}
        title={upNextCollapsed ? 'Show Up next' : 'Hide Up next'}
      >
        <Icon name={upNextCollapsed ? 'left' : 'right'} />
      </button>
      {#if !upNextCollapsed}
        <h2>Up next</h2>
      {/if}
    </div>

    {#if !upNextCollapsed}
      <div class="side-scroll">
        {#if queue.items.length > 0}
          <div class="queue-head">
            <h2>Queue</h2>
            <button class="more" onclick={() => queue.clear()}>Clear</button>
          </div>
          <ol class="queue">
            {#each queue.items as item, i}
              <li>
                <button class="queue-title" onclick={() => (queue.remove(i), router.go('watch', { v: item.videoId }))}>{item.title}</button>
                <button class="queue-remove" onclick={() => queue.remove(i)} aria-label={'Remove ' + item.title + ' from queue'}><Icon name="close" /></button>
              </li>
            {/each}
          </ol>
        {/if}
        <div class="rail">
          {#each recommendations as recommended, i (recommended.videoId)}
            <div class="arrive" style="--i: {Math.min(i, 8)}">
              <VideoCard video={recommended} variant="grid" />
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </aside>
</div>

<style>
  /* Fills the window exactly; nothing on this page scrolls the page itself. */
  .page {
    height: 100%;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    gap: var(--space-5);
    padding: var(--space-5);
    overflow: hidden;
    isolation: isolate;
    transition: grid-template-columns 300ms var(--spring);
  }

  /* The whole page is graphite, like a dimmed room: butterscotch lives only in the
     glass bars and their controls, so no bright color touches the picture. */
  .page {
    background: var(--graphite);
  }

  .player-slot::before {
    content: '';
    position: absolute;
    inset: -10%;
    z-index: -1;
    border-radius: 50%;
    background: var(--glow);
    filter: blur(90px);
    opacity: 0.55;
    transition: background-color 1.2s linear;
  }

  /* Black & gold: the panels are smoked glass with a gold hairline, and butterscotch
     is the ink (zone-graphite turns text and controls gold). Cobalt glows under the
     bottom edge. */
  .panel {
    border: 1px solid rgba(217, 162, 58, 0.65);
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0) 30%),
      rgba(30, 31, 36, 0.72);
    -webkit-backdrop-filter: blur(20px) saturate(160%);
    backdrop-filter: blur(20px) saturate(160%);
    box-shadow:
      0 10px 22px -10px rgba(36, 72, 255, 0.5),
      0 18px 40px rgba(0, 0, 0, 0.45);
  }

  /* Entrances: the details bar rises in with each new video; Up next cards follow
     one after another. */
  .bottom-bar {
    animation: rise-in 520ms var(--spring) backwards;
  }

  .arrive {
    animation: rise-in 480ms var(--spring) backwards;
    animation-delay: calc(80ms + var(--i) * 60ms);
  }

  @keyframes rise-in {
    from {
      opacity: 0;
      transform: translateY(18px);
    }
  }

  /* Up next and the bottom bar: the two smoked-glass panels. */
  .side,
  .bottom-bar {
    position: relative;
    padding: var(--space-3) var(--space-4);
    border-radius: 22px;
  }

  .bottom-bar {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .page.collapsed {
    grid-template-columns: minmax(0, 1fr) 44px;
  }

  .primary {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
    min-height: 0;
  }

  /* As wide as the column allows, but never so tall that the title row and the
     Description/Comments headers fall off the bottom of the window. */
  .player-slot {
    position: relative;
    flex: none;
    width: min(100%, calc((100vh - var(--titlebar-height) - 320px) * 16 / 9));
    margin-inline: auto;
  }

  .stage-skeleton {
    aspect-ratio: 16 / 9;
    border-radius: var(--r-chip);
    background: var(--chip);
    box-shadow: var(--press);
  }

  .failure {
    padding: var(--space-7) var(--space-5);
    text-align: center;
    background: var(--chip);
    border-radius: var(--r-chip);
    box-shadow: var(--raise);
  }

  .failure h1 {
    font-size: 20px;
    margin-bottom: var(--space-4);
  }

  .failure-actions {
    display: flex;
    gap: var(--space-3);
    justify-content: center;
  }

  .info {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .fallback-note {
    margin: 0;
    color: var(--ink-dim);
    font-size: 13px;
  }

  .title {
    font-size: 26px;
    line-height: 1.2;
    font-weight: 800;
    letter-spacing: -0.015em;
  }

  .meta-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .channel {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 4px 12px 4px 4px;
    border-radius: var(--r-pill);
    box-shadow: var(--raise-sm);
  }

  .channel:hover {
    background: var(--chip);
  }

  .channel img {
    border-radius: 50%;
  }

  .channel-text {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    line-height: 1.25;
  }

  .channel-name {
    font-weight: 600;
  }

  .sub-count {
    font-size: 12px;
    color: var(--ink-faint);
  }

  .btn {
    padding: 7px 14px;
    border-radius: var(--r-pill);
    background: var(--chip);
    font-size: 13px;
    font-weight: 600;
  }

  .btn:hover {
    background: var(--chip-hover);
  }

  .btn.accent {
    background: var(--accent);
    color: var(--accent-ink);
  }

  /* Subscribe is the screen's one primary action; once subscribed it sits pressed in. */
  .subscribe {
    background: var(--accent);
    color: var(--accent-ink);
  }

  .subscribe:not(.on) {
    box-shadow: 0 4px 18px rgba(36, 72, 255, 0.55);
  }

  .subscribe:hover {
    background: var(--accent-dim);
  }

  .subscribe.on,
  .subscribe.on:hover {
    background: var(--chip);
    color: var(--ink);
    box-shadow: var(--press);
  }

  .spacer {
    flex: 1;
  }

  .stat {
    font-size: 12px;
    color: var(--ink-dim);
  }

  /* The only scrolling area in the main column. */
  .details {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    /* Room for raised shadows, which a scroller would clip. */
    padding: 8px 10px 16px 8px;
    margin: 0 -10px 0 -8px;
  }

  .fold {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .fold-head {
    align-self: flex-start;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 8px 16px;
    border-radius: var(--r-pill);
    background: var(--ground);
    box-shadow: var(--raise-sm);
    font-size: 14px;
    font-weight: 700;
    transition: box-shadow 160ms var(--ease);
  }

  .fold-head[aria-expanded='true'] {
    box-shadow: var(--press);
  }

  .description {
    margin: 0;
    padding: var(--space-3) var(--space-4);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 13px;
    line-height: 1.6;
    color: var(--ink-dim);
    max-width: 78ch;
  }

  .more {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-dim);
    padding: 4px 0;
  }

  .more:hover {
    color: var(--ink);
  }

  /* Up next: its own scroller, folds down to a strip with one button. */
  .side {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
    min-height: 0;
  }

  .side-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .fold-btn {
    width: 40px;
    height: 40px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--ground);
    box-shadow: var(--raise-sm);
    font-size: 18px;
  }

  .fold-btn:active {
    box-shadow: var(--press);
  }

  .side-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: 10px 12px 16px 10px;
    margin: 0 -12px 0 -10px;
  }

  .queue-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  .queue {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .queue li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 6px 10px;
    border-radius: var(--r-control);
    box-shadow: var(--raise-sm);
  }

  .queue-title {
    flex: 1;
    min-width: 0;
    text-align: left;
    font-size: 13px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .queue-remove {
    color: var(--ink-dim);
    font-size: 16px;
    line-height: 1;
    padding: 0 4px;
  }

  .queue-remove:hover,
  .queue-title:hover {
    color: var(--ink);
  }

  .rail {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
</style>
