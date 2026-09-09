<script lang="ts">
  import { PREFERENCE_GROUPS, settings, type PreferenceNode } from '../lib/stores/settings.svelte'
  import { CATEGORY_LIST, CATEGORY_META, categoryColor } from '../lib/api/sponsorblock'
  import { fetchPublicInstances, rankInstances, type InstanceInfo, type HealthResult } from '../lib/api/instances'
  import { session } from '../lib/stores/session.svelte'
  import { account, isSignInAvailable } from '../lib/stores/account.svelte'
  import { library } from '../lib/stores/library.svelte'
  import { allowHosts } from '../lib/desktop'
  import { shell } from '../lib/shell'

  let instances = $state<InstanceInfo[]>([])
  let probes = $state<HealthResult[]>([])
  let loadingInstances = $state(false)
  let customInstance = $state('')
  let instanceMessage = $state<string | null>(null)

  const sponsorCategories = $derived(settings.sponsorBlockCategories)

  async function loadInstances() {
    loadingInstances = true
    instanceMessage = null
    try {
      const published = await fetchPublicInstances()
      instances = published.slice(0, 12)
      await allowHosts(instances.map(i => i.uri))
      probes = await rankInstances(instances.slice(0, 8).map(i => i.uri))
    } catch {
      instanceMessage = 'Could not reach the public instance directory.'
    } finally {
      loadingInstances = false
    }
  }

  function latencyFor(uri: string): HealthResult | undefined {
    return probes.find(p => p.instance === uri)
  }

  async function useInstance(uri: string) {
    instanceMessage = null
    await allowHosts([uri])
    await session.useInstance(uri)
    instanceMessage = 'Now browsing through ' + uri
  }

  async function addCustomInstance() {
    const value = customInstance.trim().replace(/\/+$/, '')
    if (!value) return
    const normalised = value.startsWith('http') ? value : 'https://' + value
    await useInstance(normalised)
    customInstance = ''
  }

  async function setSponsorOption(category: string, option: string) {
    const next = { ...settings.sponsorBlockCategories, [category]: { option } }
    await settings.set('sponsorblock.categories', next)
  }

  /** Preferences rendered by a bespoke control below, not by the generic renderer. */
  const CUSTOM_KEYS = new Set([
    'invidious.instance',
    'sponsorblock.categories',
    'search_history.clear_search_history',
    // Changing the backend has to tear down and rebuild the client, not just store a value.
    'backend.selected'
  ])

  let switchingBackend = $state(false)

  async function useBackend(kind: 'playlet' | 'invidious') {
    if (session.kind === kind || switchingBackend) return
    switchingBackend = true
    instanceMessage = null
    try {
      await session.useBackend(kind)
    } finally {
      switchingBackend = false
    }
  }

  function renderable(item: PreferenceNode): boolean {
    return !CUSTOM_KEYS.has(item.key) && item.type !== undefined
  }

  /**
   * Sign-in only mints a token; it is `syncAccount` that actually pulls the account's
   * subscriptions and playlists in, so the two are tied together here rather than
   * leaving the user signed in to an app that looks unchanged.
   */
  async function signIn(): Promise<void> {
    await account.signIn()
    if (account.isSignedIn) await session.syncAccount({ force: true })
  }

  async function signOut(): Promise<void> {
    await account.signOut()
    // The local subscription list is deliberately left alone: it is the user's own
    // data on this PC, and signing out of YouTube is not a request to delete it.
    session.clearAccountData()
  }
</script>

<div class="page">
  <h1>Settings</h1>

  <section class="group">
    <header>
      <h2>YouTube account</h2>
      <p>
        Signing in is what makes full-length playback work. Signed out, YouTube serves
        only about the first minute of any video to this kind of client. Signing in also
        brings in your real subscriptions and recommendations.
      </p>
    </header>

    {#if !isSignInAvailable()}
      <p class="note">Sign-in needs the desktop app.</p>
    {:else if account.isSignedIn}
      <div class="pref">
        <div class="pref-text">
          <span class="pref-label">Signed in to YouTube</span>
          <span class="pref-desc">
            Your subscriptions and saved playlists are pulled in from your account. Your
            account stays on this PC; nothing is shared with anyone but YouTube.
          </span>
        </div>
        <button class="btn" onclick={signOut}>Sign out</button>
      </div>
      <div class="pref">
        <div class="pref-text">
          <span class="pref-label">Account library</span>
          <span class="pref-desc">
            {#if session.accountSyncing}
              Fetching your subscriptions and playlists…
            {:else if session.accountSyncError}
              Couldn't reach your account library. {session.accountSyncError}
            {:else}
              {library.subscriptions.length} subscription{library.subscriptions.length === 1 ? '' : 's'}
              and {session.accountPlaylists.length} playlist{session.accountPlaylists.length === 1 ? '' : 's'}.
              Subscriptions you added on this PC are kept as well as the ones from YouTube.
            {/if}
          </span>
        </div>
        <button class="btn" disabled={session.accountSyncing}
          onclick={() => session.syncAccount({ force: true })}>Refresh</button>
      </div>
    {:else if account.state === 'awaiting-code' && account.userCode}
      <div class="signin">
        <p class="signin-step">
          1. Go to <strong>{account.verificationUrl}</strong> on any device
        </p>
        <p class="signin-step">2. Enter this code:</p>
        <div class="code tnum">{account.userCode}</div>
        <p class="signin-waiting">Waiting for you to approve…</p>
        <div class="signin-actions">
          <button class="btn" onclick={() => shell.openExternal(account.verificationUrl)}>
            Open the page
          </button>
          <button class="link" onclick={() => account.cancel()}>Cancel</button>
        </div>
      </div>
    {:else}
      <div class="pref">
        <div class="pref-text">
          <span class="pref-label">Not signed in</span>
          <span class="pref-desc">
            You'll get a short code to enter on another device — the same flow a TV or
            games console uses. No password is typed into this app.
          </span>
        </div>
        <button class="btn accent" onclick={signIn}>Sign in</button>
      </div>
    {/if}

    {#if account.message}
      <p class="note">{account.message}</p>
    {/if}
  </section>

  <section class="group">
    <header>
      <h2>Where videos come from</h2>
      <p>
        Playlet can talk to YouTube directly, or go through an Invidious instance. Direct
        is the default and needs no third-party server.
      </p>
    </header>

    <div class="backends">
      <button class="backend" class:on={session.kind === 'playlet'} onclick={() => useBackend('playlet')} disabled={switchingBackend}>
        <span class="backend-name">YouTube, directly</span>
        <span class="backend-note">No server in the middle. Recommended.</span>
      </button>
      <button class="backend" class:on={session.kind === 'invidious'} onclick={() => useBackend('invidious')} disabled={switchingBackend}>
        <span class="backend-name">Through Invidious</span>
        <span class="backend-note">Use a public or self-hosted instance.</span>
      </button>
    </div>

    {#if session.backendNotice}
      <p class="note">{session.backendNotice}</p>
    {/if}
  </section>

  <section class="group" class:dimmed={session.kind === 'playlet'}>
    <header>
      <h2>Invidious instance</h2>
      <p>
        Playlet browses YouTube through an Invidious instance. If videos stop loading, switching
        instance usually fixes it.
      </p>
    </header>

    <div class="current">
      <span class="label">Currently using</span>
      <span class="value">{session.instance || 'none'}</span>
    </div>

    <div class="custom">
      <input
        bind:value={customInstance}
        placeholder="https://your-instance.example"
        aria-label="Custom instance URL"
        spellcheck="false"
        onkeydown={e => e.key === 'Enter' && addCustomInstance()}
      />
      <button class="btn" onclick={addCustomInstance}>Use this instance</button>
    </div>

    <div class="instance-actions">
      <button class="btn" onclick={loadInstances} disabled={loadingInstances}>
        {loadingInstances ? 'Testing instances…' : 'Find working instances'}
      </button>
      <button class="link" onclick={() => shell.openExternal('https://api.invidious.io/')}>
        See the public instance list
      </button>
    </div>

    {#if instanceMessage}
      <p class="note">{instanceMessage}</p>
    {/if}

    {#if instances.length > 0}
      <ul class="instances">
        {#each instances as instance (instance.uri)}
          {@const probe = latencyFor(instance.uri)}
          <li>
            <span class="uri">{instance.uri}</span>
            <span class="badges">
              {#if instance.region}<span class="badge">{instance.region}</span>{/if}
              {#if instance.health !== undefined}
                <span class="badge tnum">{instance.health.toFixed(0)}% up</span>
              {/if}
              {#if probe}
                <span class="badge tnum" class:good={probe.ok} class:bad={!probe.ok}>
                  {probe.ok ? probe.latencyMs + ' ms' : 'unreachable'}
                </span>
              {/if}
            </span>
            <button
              class="btn small"
              onclick={() => useInstance(instance.uri)}
              disabled={session.instance === instance.uri}
            >
              {session.instance === instance.uri ? 'In use' : 'Use'}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#each PREFERENCE_GROUPS as group (group.key)}
    <section class="group">
      <header>
        <h2>{group.displayText}</h2>
      </header>

      {#each group.items.filter(renderable) as item (item.key)}
        <div class="pref">
          <div class="pref-text">
            <span class="pref-label">{item.displayText}</span>
            {#if item.description}
              <span class="pref-desc">{item.description}</span>
            {/if}
          </div>

          <div class="pref-control">
            {#if item.type === 'boolean'}
              <button
                class="toggle"
                role="switch"
                aria-checked={settings.get<boolean>(item.key)}
                aria-label={item.displayText}
                onclick={() => settings.set(item.key, !settings.get<boolean>(item.key))}
              >
                <span class="knob"></span>
              </button>
            {:else if item.type === 'radio' && item.options}
              <div class="radio-row">
                {#each item.options as option (option.value)}
                  <button
                    class="chip"
                    class:on={settings.get<string>(item.key) === option.value}
                    onclick={() => settings.set(item.key, option.value)}
                  >
                    {option.displayText}
                  </button>
                {/each}
              </div>
            {:else if item.type === 'string'}
              <input
                class="text"
                value={settings.get<string>(item.key) ?? ''}
                oninput={e => settings.set(item.key, (e.currentTarget as HTMLInputElement).value)}
                aria-label={item.displayText}
              />
            {/if}
          </div>
        </div>
      {/each}

      {#if group.key === 'sponsorblock'}
        <div class="categories">
          <span class="pref-label">Categories</span>
          <span class="pref-desc">What to do when each kind of segment comes up.</span>
          <ul>
            {#each CATEGORY_LIST as category (category)}
              {@const meta = CATEGORY_META[category]}
              {@const current = sponsorCategories[category]?.option ?? 'disable'}
              <li>
                <span class="swatch" style="background: {categoryColor(category)}" aria-hidden="true"></span>
                <span class="category-name">{meta.title}</span>
                <div class="radio-row">
                  {#each meta.options as option (option)}
                    <button
                      class="chip"
                      class:on={current === option}
                      onclick={() => setSponsorOption(category, option)}
                    >
                      {option === 'auto_skip'
                        ? 'Skip'
                        : option === 'manual_skip'
                          ? 'Ask'
                          : option === 'show_in_seekbar'
                            ? 'Mark only'
                            : 'Off'}
                    </button>
                  {/each}
                </div>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if group.key === 'search_history'}
        <div class="pref">
          <div class="pref-text">
            <span class="pref-label">Clear search history</span>
            <span class="pref-desc">Removes the {library.searchHistory.length} saved searches from this PC.</span>
          </div>
          <button class="btn" onclick={() => library.clearSearchHistory()} disabled={library.searchHistory.length === 0}>
            Clear
          </button>
        </div>
      {/if}
    </section>
  {/each}

  <section class="group">
    <header>
      <h2>About</h2>
      <p>
        Playlet for Windows is a desktop port of
        <button class="link" onclick={() => shell.openExternal('https://github.com/iBicha/playlet')}>
          Playlet for Roku by iBicha
        </button>. Watch history, subscriptions and settings are stored only on this PC.
      </p>
    </header>
    <div class="pref">
      <div class="pref-text">
        <span class="pref-label">Reset all settings</span>
        <span class="pref-desc">Puts every preference back to its default. Subscriptions and history are kept.</span>
      </div>
      <button class="btn" onclick={() => settings.resetAll()}>Reset</button>
    </div>
  </section>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    padding: var(--space-5);
    max-width: 860px;
  }

  h1 {
    font-size: 24px;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--chip);
    border-radius: var(--r-card);
  }

  .signin {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    border-radius: var(--r-card);
    background: var(--chip-hi);
  }

  .signin-step {
    margin: 0;
    font-size: 13px;
    color: var(--ink-dim);
  }

  /* The code is the one thing on this screen the user has to read across the room. */
  .code {
    font-family: var(--font-display);
    font-size: 34px;
    font-weight: 700;
    letter-spacing: 0.12em;
    color: var(--accent);
    padding: var(--space-2) 0;
  }

  .signin-waiting {
    margin: 0;
    font-size: 12px;
    color: var(--ink-faint);
  }

  .signin-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-2);
  }

  .btn.accent {
    background: var(--accent);
    color: #fff;
  }

  .btn.accent:hover {
    background: var(--accent-dim);
  }

  .backends {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  .backend {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--r-card);
    background: var(--chip-hi);
    border: 1px solid transparent;
    text-align: left;
  }

  .backend:hover:not(:disabled) {
    background: var(--chip-hover);
  }

  .backend.on {
    border-color: var(--accent);
    background: var(--accent-wash);
  }

  .backend:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .backend-name {
    font-weight: 600;
    font-size: 13px;
  }

  .backend-note {
    font-size: 12px;
    color: var(--ink-faint);
  }

  /* The instance controls stay reachable on the direct backend, just de-emphasised. */
  .dimmed {
    opacity: 0.55;
  }

  .dimmed:focus-within,
  .dimmed:hover {
    opacity: 1;
  }

  .group header p {
    margin: var(--space-1) 0 0;
    color: var(--ink-dim);
    font-size: 13px;
    max-width: 70ch;
    line-height: 1.6;
  }

  .current {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    padding: var(--space-3);
    border-radius: var(--r-control);
    background: var(--chip-hi);
  }

  .label {
    font-size: 12px;
    color: var(--ink-faint);
  }

  .value {
    font-weight: 600;
  }

  .custom {
    display: flex;
    gap: var(--space-2);
  }

  input.text,
  .custom input {
    flex: 1;
    padding: 8px 12px;
    border-radius: var(--r-control);
    background: var(--chip-hi);
    border: 1px solid var(--edge-soft);
    outline: none;
    font-size: 13px;
  }

  input.text {
    max-width: 280px;
  }

  .custom input:focus,
  input.text:focus {
    border-color: var(--edge);
  }

  .instance-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .instances {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .instances li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--r-control);
    background: var(--chip-hi);
  }

  .uri {
    flex: 1;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badges {
    display: flex;
    gap: var(--space-1);
  }

  .badge {
    padding: 2px 7px;
    border-radius: var(--r-pill);
    background: var(--ground);
    font-size: 11px;
    color: var(--ink-faint);
  }

  .badge.good {
    color: #6bd67b;
  }

  .badge.bad {
    color: var(--accent);
  }

  .pref {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-5);
    padding: var(--space-3) 0;
    border-top: 1px solid var(--edge-soft);
  }

  .pref-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .pref-label {
    font-weight: 600;
    font-size: 13px;
  }

  .pref-desc {
    font-size: 12px;
    color: var(--ink-faint);
    max-width: 62ch;
    line-height: 1.5;
  }

  .pref-control {
    flex: 0 0 auto;
  }

  .toggle {
    width: 40px;
    height: 22px;
    border-radius: var(--r-pill);
    background: var(--edge);
    position: relative;
    transition: background 140ms var(--ease);
  }

  .toggle[aria-checked='true'] {
    background: var(--accent);
  }

  .toggle .knob {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    transition: transform 140ms var(--ease);
  }

  .toggle[aria-checked='true'] .knob {
    transform: translateX(18px);
  }

  .radio-row {
    display: flex;
    gap: var(--space-1);
  }

  .chip {
    padding: 4px 11px;
    border-radius: var(--r-pill);
    background: var(--chip-hi);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-dim);
  }

  .chip:hover {
    background: var(--chip-hover);
    color: var(--ink);
  }

  .chip.on {
    background: var(--ink);
    color: var(--ground);
  }

  .categories {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: var(--space-3);
    border-top: 1px solid var(--edge-soft);
  }

  .categories ul {
    list-style: none;
    margin: var(--space-3) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .categories li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .swatch {
    width: 4px;
    height: 20px;
    border-radius: 2px;
    flex: 0 0 auto;
  }

  .category-name {
    flex: 1;
    font-size: 13px;
    color: var(--ink-dim);
  }

  .btn {
    padding: 7px 15px;
    border-radius: var(--r-pill);
    background: var(--chip-hi);
    font-size: 13px;
    font-weight: 600;
    flex: 0 0 auto;
  }

  .btn.small {
    padding: 4px 12px;
    font-size: 12px;
  }

  .btn:hover:not(:disabled) {
    background: var(--chip-hover);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .link {
    color: var(--ink-dim);
    font-size: 13px;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .link:hover {
    color: var(--ink);
  }

  .note {
    margin: 0;
    font-size: 12px;
    color: var(--ink-dim);
  }
</style>
