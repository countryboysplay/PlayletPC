<script lang="ts">
  import { library } from '../lib/stores/library.svelte'
  import { router } from '../lib/router.svelte'
  import { formatDuration } from '../lib/format'

  let confirmingClear = $state(false)

  function resumeLabel(position: number, length: number): string {
    if (position <= 0) return 'Watched'
    return formatDuration(position) + ' of ' + formatDuration(length)
  }

  function clearAll() {
    void library.clearHistory()
    confirmingClear = false
  }
</script>

<div class="page">
  <header class="head">
    <h1>History</h1>
    {#if library.history.length > 0}
      {#if confirmingClear}
        <div class="confirm">
          <span>Clear {library.history.length} items?</span>
          <button class="btn danger" onclick={clearAll}>Clear history</button>
          <button class="btn" onclick={() => (confirmingClear = false)}>Keep</button>
        </div>
      {:else}
        <button class="btn" onclick={() => (confirmingClear = true)}>Clear history</button>
      {/if}
    {/if}
  </header>

  {#if library.history.length === 0}
    <div class="empty">
      <h2>Nothing watched yet</h2>
      <p>Videos you play show up here with your position, so you can pick up where you left off. History stays on this PC.</p>
      <button class="btn accent" onclick={() => router.go('home')}>Browse videos</button>
    </div>
  {:else}
    <ul class="list">
      {#each library.history as record (record.videoId)}
        <li>
          <button class="row" onclick={() => router.go('watch', { v: record.videoId })}>
            <span class="thumb">
              {#if record.thumbnail}
                <img src={record.thumbnail} alt="" loading="lazy" />
              {/if}
              {#if !record.completed && record.position > 0 && record.lengthSeconds > 0}
                <span class="bar" style="--pct: {(record.position / record.lengthSeconds) * 100}%"></span>
              {/if}
            </span>
            <span class="body">
              <span class="title clamp-2">{record.title}</span>
              <span class="author">{record.author}</span>
              <span class="position tnum">{resumeLabel(record.position, record.lengthSeconds)}</span>
            </span>
          </button>
          <button
            class="remove"
            onclick={() => library.removeFromHistory(record.videoId)}
            aria-label={'Remove ' + record.title + ' from history'}
          >
            ✕
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    padding: var(--space-5);
    max-width: 1000px;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  h1 {
    font-size: 24px;
  }

  .confirm {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 13px;
    color: var(--ink-dim);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .list li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    border-radius: var(--r-card);
  }

  .list li:hover {
    background: var(--chip);
  }

  .row {
    flex: 1;
    display: flex;
    gap: var(--space-4);
    padding: var(--space-2);
    text-align: left;
    min-width: 0;
  }

  .thumb {
    position: relative;
    flex: 0 0 auto;
    width: 150px;
    aspect-ratio: 16 / 9;
    border-radius: var(--r-control);
    overflow: hidden;
    background: var(--chip-hi);
  }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgba(0, 0, 0, 0.6);
  }

  .bar::after {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--pct);
    background: var(--accent);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding-top: 2px;
  }

  .title {
    font-weight: 600;
    font-size: 14px;
  }

  .author {
    font-size: 12px;
    color: var(--ink-dim);
  }

  .position {
    font-size: 12px;
    color: var(--ink-faint);
  }

  .remove {
    width: 30px;
    height: 30px;
    border-radius: var(--r-control);
    color: var(--ink-faint);
    flex: 0 0 auto;
    margin-right: var(--space-2);
    opacity: 0;
  }

  .list li:hover .remove,
  .remove:focus-visible {
    opacity: 1;
  }

  .remove:hover {
    background: var(--chip-hover);
    color: var(--ink);
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
    max-width: 54ch;
  }

  .btn {
    padding: 7px 16px;
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
    margin-top: var(--space-2);
  }

  .btn.danger {
    background: var(--accent);
    color: #fff;
  }
</style>
