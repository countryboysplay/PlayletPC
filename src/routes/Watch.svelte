<script lang="ts">
  import type { VideoDetails } from '../lib/api/types'
  import { session } from '../lib/stores/session.svelte'
  import { library } from '../lib/stores/library.svelte'
  import { settings } from '../lib/stores/settings.svelte'
  import { router } from '../lib/router.svelte'
  import { shell } from '../lib/shell'
  import VideoPlayer from '../lib/components/VideoPlayer.svelte'
  import VideoCard from '../lib/components/VideoCard.svelte'
  import { formatCount, formatViews, formatRelativeTime, pickThumbnail } from '../lib/format'

  interface Props {
    videoId: string
  }

  let { videoId }: Props = $props()

  let video = $state<VideoDetails | null>(null)
  let loading = $state(true)
  let error = $state<string | null>(null)
  let descriptionExpanded = $state(false)

  const subscribed = $derived(video ? library.isSubscribed(video.authorId) : false)
  const startAt = $derived(video ? library.getResumePosition(video.videoId) : 0)
  const recommendations = $derived(
    video ? (settings.disableShorts ? video.recommendedVideos.filter(v => v.type !== 'shortVideo') : video.recommendedVideos) : []
  )

  async function load(id: string) {
    loading = true
    error = null
    video = null
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

  function playNext() {
    if (!settings.autoplay) return
    const next = recommendations[0]
    if (next) router.go('watch', { v: next.videoId })
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

<div class="page">
  <div class="primary">
    {#if loading}
      <div class="stage-skeleton"></div>
    {:else if error}
      <div class="failure">
        <h1>{error}</h1>
        <div class="failure-actions">
          <button class="btn accent" onclick={() => load(videoId)}>Try again</button>
          <button class="btn" onclick={() => router.go('settings')}>Change instance</button>
        </div>
      </div>
    {:else if video}
      {#key video.videoId}
        <VideoPlayer {video} {startAt} onProgress={recordProgress} onEnded={playNext} />
      {/key}

      <h1 class="title">{video.title}</h1>

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

        <span class="stat tnum">{formatViews(video.viewCount)}</span>
        {#if video.likeCount}
          <span class="stat tnum">{formatCount(video.likeCount)} likes</span>
        {/if}
        <span class="stat tnum">{video.publishedText || formatRelativeTime(video.published)}</span>

        <button class="btn" onclick={() => shell.openExternal('https://www.youtube.com/watch?v=' + video!.videoId)}>
          Open on YouTube
        </button>
      </div>

      {#if video.description}
        <div class="description" class:expanded={descriptionExpanded}>
          <p>{video.description}</p>
        </div>
        {#if video.description.length > 280}
          <button class="more" onclick={() => (descriptionExpanded = !descriptionExpanded)}>
            {descriptionExpanded ? 'Show less' : 'Show more'}
          </button>
        {/if}
      {/if}
    {/if}
  </div>

  <aside class="side">
    {#if recommendations.length > 0}
      <h2>Up next</h2>
      <div class="rail">
        {#each recommendations as recommended (recommended.videoId)}
          <VideoCard video={recommended} variant="grid" />
        {/each}
      </div>
    {/if}
  </aside>
</div>

<style>
  .page {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 330px;
    gap: var(--space-6);
    padding: var(--space-5);
    align-items: start;
  }

  /* Below this width the recommendation rail costs more than it gives. */
  @media (max-width: 1180px) {
    .page {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .primary {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  .stage-skeleton {
    aspect-ratio: 16 / 9;
    border-radius: var(--r-chip);
    background: var(--chip);
  }

  .failure {
    padding: var(--space-7) var(--space-5);
    text-align: center;
    background: var(--chip);
    border-radius: var(--r-chip);
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

  .title {
    font-size: 20px;
    line-height: 1.3;
    margin-top: var(--space-2);
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
    padding: 4px 8px 4px 4px;
    border-radius: var(--r-pill);
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
    color: #fff;
  }

  /* Subscribed is a state, so it earns the accent; unsubscribed stays neutral. */
  .subscribe.on {
    background: var(--accent-wash);
    color: var(--accent);
  }

  .spacer {
    flex: 1;
  }

  .stat {
    font-size: 12px;
    color: var(--ink-dim);
  }

  .description {
    position: relative;
    max-height: 88px;
    overflow: hidden;
    padding: var(--space-3) var(--space-4);
    background: var(--chip);
    border-radius: var(--r-card);
  }

  .description.expanded {
    max-height: none;
  }

  .description p {
    margin: 0;
    white-space: pre-wrap;
    font-size: 13px;
    line-height: 1.6;
    color: var(--ink-dim);
    max-width: 78ch;
  }

  .more {
    align-self: flex-start;
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-dim);
    padding: 4px 0;
  }

  .more:hover {
    color: var(--ink);
  }

  .side {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }

  .rail {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
</style>
