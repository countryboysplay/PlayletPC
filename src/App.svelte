<script lang="ts">
  import { router } from './lib/router.svelte'
  import { session } from './lib/stores/session.svelte'
  import { settings } from './lib/stores/settings.svelte'
  import { library } from './lib/stores/library.svelte'
  import { account } from './lib/stores/account.svelte'
  import TitleBar from './lib/components/TitleBar.svelte'
  import NavRail from './lib/components/NavRail.svelte'
  import Home from './routes/Home.svelte'
  import Search from './routes/Search.svelte'
  import Watch from './routes/Watch.svelte'
  import Channel from './routes/Channel.svelte'
  import Playlist from './routes/Playlist.svelte'
  import Subscriptions from './routes/Subscriptions.svelte'
  import History from './routes/History.svelte'
  import Settings from './routes/Settings.svelte'

  let booted = $state(false)

  $effect(() => {
    // Load persisted state before the first request, so the user's chosen instance wins.
    void (async () => {
      await Promise.all([settings.load(), library.load(), account.load()])
      booted = true
      await session.connect()
      // Pull the account's subscriptions and playlists in after the backend is up.
      // Not awaited into the boot path: it must never delay first paint, and it is
      // fine for it to land a moment after the first screen renders.
      void session.syncAccount()
    })()
  })

  const route = $derived(router.current)
</script>

<div class="shell">
  <TitleBar />

  <div class="body">
    <NavRail />

    <main data-scroll-root>
      {#if !booted || session.status === 'starting' || session.status === 'connecting'}
        <div class="boot">
          <div class="mark" aria-hidden="true">
            <span class="chip">Play</span><span class="spill">let</span>
          </div>
          <p>{booted ? 'Finding a working Invidious instance' : 'Starting'}</p>
        </div>
      {:else if session.status === 'offline'}
        <div class="boot">
          <h1>Can't reach any Invidious instance</h1>
          <p class="muted">
            Playlet browses YouTube through Invidious. Every instance it tried was unreachable,
            which usually means this PC is offline.
          </p>
          <div class="boot-actions">
            <button class="primary" onclick={() => session.connect()}>Try again</button>
            <button class="ghost" onclick={() => router.go('settings')}>Choose an instance</button>
          </div>
        </div>
      {:else if route.name === 'home'}
        <Home />
      {:else if route.name === 'search'}
        <Search query={route.params.q ?? ''} />
      {:else if route.name === 'watch'}
        <Watch videoId={route.params.v ?? ''} />
      {:else if route.name === 'channel'}
        <Channel ucid={route.params.ucid ?? ''} />
      {:else if route.name === 'playlist'}
        <Playlist plid={route.params.plid ?? ''} />
      {:else if route.name === 'subscriptions'}
        <Subscriptions />
      {:else if route.name === 'history'}
        <History />
      {:else if route.name === 'settings'}
        <Settings />
      {/if}
    </main>
  </div>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  main {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .boot {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    text-align: center;
    padding: var(--space-6);
  }

  .boot p {
    margin: 0;
    color: var(--ink-dim);
    max-width: 46ch;
  }

  .boot .muted {
    color: var(--ink-dim);
  }

  /* The wordmark: "Play" contained by the chip, "let" breaking out of it. */
  .mark {
    font-family: var(--font-display);
    font-size: 34px;
    font-weight: 700;
    letter-spacing: -0.02em;
    display: inline-flex;
    align-items: center;
    color: var(--accent);
  }

  .mark .chip {
    background: var(--chip);
    border-radius: 14px;
    padding: 6px 4px 6px 14px;
  }

  .mark .spill {
    padding-right: 14px;
  }

  .boot-actions {
    display: flex;
    gap: var(--space-3);
  }

  .primary,
  .ghost {
    padding: 8px 18px;
    border-radius: var(--r-control);
    font-weight: 600;
  }

  .primary {
    background: var(--accent);
    color: #fff;
  }

  .primary:hover {
    background: var(--accent-dim);
  }

  .ghost {
    background: var(--chip);
    color: var(--ink);
  }

  .ghost:hover {
    background: var(--chip-hover);
  }
</style>
