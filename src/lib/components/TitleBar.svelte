<script lang="ts">
  import { router } from '../router.svelte'
  import { library } from '../stores/library.svelte'
  import { settings } from '../stores/settings.svelte'
  import { shell } from '../shell'

  let query = $state('')
  let focused = $state(false)
  let input: HTMLInputElement | undefined = $state()

  const suggestions = $derived(
    focused && settings.searchHistoryEnabled ? library.searchSuggestions(query) : []
  )

  function submit(event: SubmitEvent) {
    event.preventDefault()
    run(query)
  }

  function run(value: string) {
    const trimmed = value.trim()
    if (!trimmed) return
    query = trimmed
    focused = false
    input?.blur()
    if (settings.searchHistoryEnabled) void library.recordSearch(trimmed)
    router.go('search', { q: trimmed })
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      focused = false
      input?.blur()
    }
  }

  // Ctrl+F / Ctrl+L focus the search box, matching desktop convention.
  $effect(() => {
    function handler(event: KeyboardEvent) {
      if (event.ctrlKey && (event.key === 'f' || event.key === 'l')) {
        event.preventDefault()
        input?.focus()
        input?.select()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })
</script>

<header class="titlebar" data-tauri-drag-region>
  <div class="left">
    <button class="back" onclick={() => router.back()} disabled={!router.canGoBack} aria-label="Back">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </div>

  <form class="search" onsubmit={submit} role="search">
    <svg class="glass" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M16 16l4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
    <input
      bind:this={input}
      bind:value={query}
      onfocus={() => (focused = true)}
      onblur={() => setTimeout(() => (focused = false), 120)}
      onkeydown={onKeydown}
      type="search"
      placeholder="Search videos, channels, playlists"
      aria-label="Search"
      spellcheck="false"
    />

    {#if suggestions.length > 0}
      <ul class="suggestions">
        {#each suggestions as suggestion (suggestion)}
          <li>
            <button type="button" onclick={() => run(suggestion)}>{suggestion}</button>
          </li>
        {/each}
      </ul>
    {/if}
  </form>

  <div class="window-controls">
    <button onclick={() => shell.minimize()} aria-label="Minimize" class="wc">
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 6h8" stroke="currentColor" stroke-width="1" /></svg>
    </button>
    <button onclick={() => shell.toggleMaximize()} aria-label="Maximize" class="wc">
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1" /></svg>
    </button>
    <button onclick={() => shell.close()} aria-label="Close" class="wc close">
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1" /></svg>
    </button>
  </div>
</header>

<style>
  .titlebar {
    height: var(--titlebar-height);
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding-left: var(--space-2);
    background: var(--ground);
    border-bottom: 1px solid var(--edge-soft);
    flex: 0 0 auto;
  }

  .left {
    display: flex;
    align-items: center;
  }

  .back {
    width: 30px;
    height: 30px;
    border-radius: var(--r-control);
    display: grid;
    place-items: center;
    color: var(--ink-dim);
  }

  .back:hover:not(:disabled) {
    background: var(--chip);
    color: var(--ink);
  }

  .back:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .search {
    position: relative;
    flex: 1;
    max-width: 520px;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: 28px;
    padding: 0 var(--space-3);
    background: var(--chip);
    border: 1px solid transparent;
    border-radius: var(--r-pill);
    /* The search field is interactive, so it must opt out of the window drag region. */
    -webkit-app-region: no-drag;
  }

  .search:focus-within {
    border-color: var(--edge);
    background: var(--chip-hi);
  }

  .glass {
    color: var(--ink-faint);
    flex: 0 0 auto;
  }

  .search input {
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    outline: none;
    font-size: 13px;
  }

  .search input::placeholder {
    color: var(--ink-faint);
  }

  .search input::-webkit-search-cancel-button {
    appearance: none;
  }

  .suggestions {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    right: 0;
    margin: 0;
    padding: var(--space-1);
    list-style: none;
    background: var(--chip-hi);
    border: 1px solid var(--edge);
    border-radius: var(--r-card);
    z-index: 40;
  }

  .suggestions button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 10px;
    border-radius: var(--r-control);
    font-size: 13px;
    color: var(--ink-dim);
  }

  .suggestions button:hover {
    background: var(--chip-hover);
    color: var(--ink);
  }

  .window-controls {
    margin-left: auto;
    display: flex;
    -webkit-app-region: no-drag;
  }

  .wc {
    width: 46px;
    height: var(--titlebar-height);
    display: grid;
    place-items: center;
    color: var(--ink-dim);
  }

  .wc:hover {
    background: var(--chip);
    color: var(--ink);
  }

  .wc.close:hover {
    background: #c42b1c;
    color: #fff;
  }
</style>
