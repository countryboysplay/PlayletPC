<script lang="ts">
  import { router, type RouteName } from '../router.svelte'

  interface NavItem {
    name: RouteName
    label: string
    path: string
  }

  // Single-path icons keep the rail crisp at 20px and avoid shipping an icon library.
  const items: NavItem[] = [
    { name: 'home', label: 'Home', path: 'M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' },
    { name: 'subscriptions', label: 'Subscriptions', path: 'M4 6h16M6 10h12M4 14h16v6H4z' },
    { name: 'history', label: 'History', path: 'M12 7v5l3.5 2M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3 4v4h4' },
    { name: 'settings', label: 'Settings', path: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9 2 2 0 1 1 0 4 1.7 1.7 0 0 0-1.5 1z' }
  ]

  const active = $derived(router.current.name)
</script>

<nav class="rail" aria-label="Main">
  {#each items as item (item.name)}
    <button
      class="item"
      class:active={active === item.name}
      onclick={() => router.go(item.name)}
      aria-current={active === item.name ? 'page' : undefined}
      title={item.label}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          d={item.path}
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span>{item.label}</span>
    </button>
  {/each}
</nav>

<style>
  .rail {
    width: var(--rail-width);
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-2);
    border-right: 1px solid var(--edge-soft);
    overflow-y: auto;
    scrollbar-width: none;
  }

  .item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: var(--space-2) 2px;
    border-radius: var(--r-card);
    color: var(--ink-faint);
    position: relative;
  }

  .item span {
    font-size: 10px;
    line-height: 1.2;
    letter-spacing: 0.01em;
  }

  .item:hover {
    background: var(--chip);
    color: var(--ink-dim);
  }

  .item.active {
    color: var(--ink);
    background: var(--chip);
  }

  /* The active marker is the only red in the rail: it encodes where you are. */
  .item.active::before {
    content: '';
    position: absolute;
    left: -8px;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 22px;
    border-radius: 0 3px 3px 0;
    background: var(--accent);
  }
</style>
