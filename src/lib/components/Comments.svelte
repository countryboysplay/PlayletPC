<script lang="ts">
  import type { Comment } from '../api/types'
  import { session } from '../stores/session.svelte'
  import { formatCount } from '../format'

  let { videoId }: { videoId: string } = $props()

  let open = $state(false)
  let comments = $state<Comment[]>([])
  let count = $state<number | undefined>()
  let continuation = $state<string | undefined>()
  let loading = $state(false)
  let failed = $state(false)
  let loaded = $state(false)

  async function load() {
    loading = true
    failed = false
    try {
      const page = await session.api.comments(videoId, { continuation })
      comments = [...comments, ...page.comments]
      count ??= page.commentCount
      continuation = page.continuation
      loaded = true
    } catch {
      failed = true
    } finally {
      loading = false
    }
  }

  function toggle() {
    open = !open
    if (open && !loaded && !loading) void load()
  }
</script>

<section class="comments">
  <button class="head" aria-expanded={open} onclick={toggle}>
    Comments{count ? ' · ' + formatCount(count) : ''}
    <span aria-hidden="true">{open ? '▴' : '▾'}</span>
  </button>

  {#if open}
    <!-- Unkeyed: comment ids can repeat across pages, and duplicate keys break Svelte. -->
    {#each comments as c}
      <article class="comment">
        {#if c.authorThumbnails[0]}
          <img src={c.authorThumbnails[0].url} alt="" width="32" height="32" loading="lazy" />
        {/if}
        <div class="body">
          <div class="byline">
            <span class="author" class:owner={c.authorIsChannelOwner}>{c.author}</span>
            <span class="when">{c.publishedText}</span>
          </div>
          <p>{c.content}</p>
          {#if c.likeCount}
            <span class="likes tnum">{formatCount(c.likeCount)} {c.likeCount === 1 ? 'like' : 'likes'}</span>
          {/if}
        </div>
      </article>
    {/each}

    {#if loading}
      <p class="status" role="status">Loading comments…</p>
    {:else if failed}
      <p class="status" role="status">
        Could not load comments. <button class="more" onclick={load}>Try again</button>
      </p>
    {:else if loaded && comments.length === 0}
      <p class="status">No comments to show.</p>
    {:else if continuation}
      <button class="more" onclick={load}>Load more</button>
    {/if}
  {/if}
</section>

<style>
  .comments {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-2);
  }

  .head {
    align-self: flex-start;
    display: flex;
    gap: var(--space-2);
    font-size: 15px;
    font-weight: 600;
  }

  .comment {
    display: flex;
    gap: var(--space-3);
    max-width: 78ch;
  }

  .comment img {
    flex: none;
    border-radius: 50%;
  }

  .body {
    min-width: 0;
  }

  .byline {
    display: flex;
    gap: var(--space-2);
    font-size: 12px;
  }

  .author {
    font-weight: 600;
  }

  .author.owner {
    padding: 0 6px;
    border-radius: var(--r-pill);
    background: var(--chip);
  }

  .when,
  .likes,
  .status {
    color: var(--ink-dim);
    font-size: 12px;
  }

  .comment p {
    margin: 2px 0 4px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 13px;
    line-height: 1.5;
  }

  .status {
    margin: 0;
  }

  .more {
    align-self: flex-start;
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-dim);
    padding: 4px 0;
  }

  .more:hover,
  .head:hover {
    color: var(--ink);
  }
</style>
