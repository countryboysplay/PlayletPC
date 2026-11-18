<script lang="ts">
  import { router, type RouteName } from '../router.svelte'

  const items: { name: RouteName; label: string }[] = [
    { name: 'home', label: 'Home' },
    { name: 'subscriptions', label: 'Subscriptions' },
    { name: 'history', label: 'History' },
    { name: 'settings', label: 'Settings' }
  ]

  const active = $derived(router.current.name)
</script>

<!-- Hand-drawn icons in parts, so each part can move on hover; no icon library ships. -->
{#snippet icon(name: RouteName)}
  <svg class="icon {name}" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
    {#if name === 'home'}
      <path class="roof" d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10v10h13V10" />
      <path class="door" d="M10 20v-5.5h4V20" />
    {:else if name === 'subscriptions'}
      <path class="back" d="M7.5 4h9" />
      <path class="mid" d="M5.5 7.5h13" />
      <rect x="3.5" y="11" width="17" height="10" rx="2.5" />
      <path class="play" d="M10.8 13.6v4.8l4-2.4z" />
    {:else if name === 'history'}
      <g class="rewind"><path d="M3.8 12a8.2 8.2 0 1 0 2.5-5.9" /><path d="M3.2 3.8v4h4" /></g>
      <path class="hands" d="M12 7.5V12l3.2 2" />
    {:else}
      <g class="gear">
        <circle cx="12" cy="12" r="3.2" />
        <circle cx="12" cy="12" r="6.6" />
        <path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8" />
      </g>
    {/if}
  </svg>
{/snippet}

<nav class="rail zone-graphite" aria-label="Main">
  {#each items as item (item.name)}
    <div class="slot">
      <button
        class="item"
        onclick={() => router.go(item.name)}
        aria-current={active === item.name ? 'page' : undefined}
      >
        {@render icon(item.name)}
        <span class="label">{item.label}</span>
      </button>
    </div>
  {/each}
</nav>

<style>
  /* Above the page: a label pill slides out over the content without moving it. */
  .rail {
    width: var(--rail-width);
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: var(--space-4) 10px;
    position: relative;
    z-index: 20;
  }

  .slot {
    position: relative;
    height: 48px;
  }

  .item {
    position: absolute;
    left: 0;
    top: 0;
    height: 48px;
    min-width: 48px;
    display: flex;
    align-items: center;
    gap: 0;
    padding: 0 12px;
    border-radius: 16px;
    background: var(--ground);
    color: var(--ink);
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
    transition: gap 260ms var(--spring), padding 260ms var(--spring), box-shadow 200ms var(--ease);
  }

  .label {
    max-width: 0;
    opacity: 0;
    overflow: hidden;
    transform: translateX(-6px);
    transition: max-width 300ms var(--spring), opacity 180ms var(--ease) 60ms, transform 300ms var(--spring);
  }

  .item:hover,
  .item:focus-visible {
    gap: 10px;
    padding-right: 18px;
    box-shadow: 6px 6px 16px rgba(17, 18, 22, 0.35);
  }

  .item:hover .label,
  .item:focus-visible .label {
    max-width: 160px;
    opacity: 1;
    transform: none;
  }

  .item[aria-current='page'] {
    box-shadow: var(--press);
  }

  .item[aria-current='page']:hover,
  .item[aria-current='page']:focus-visible {
    box-shadow: var(--press), 6px 6px 16px rgba(17, 18, 22, 0.35);
  }

  /* Where you are: a cobalt bar, as a fill (cobalt is never used for text). */
  .item[aria-current='page']::before {
    content: '';
    position: absolute;
    left: -10px;
    top: 14px;
    width: 4px;
    height: 20px;
    border-radius: 4px;
    background: var(--accent);
  }

  .icon {
    flex: none;
    overflow: visible;
  }

  .icon :global(*) {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    transform-box: view-box;
  }

  /* Home: the roof hops and the door swings open. */
  .home .roof {
    transition: transform 300ms cubic-bezier(0.3, 1.8, 0.5, 1);
  }
  .home .door {
    transform-origin: 10px 20px;
    transition: transform 320ms cubic-bezier(0.3, 1.5, 0.5, 1);
  }
  .item:hover .home .roof,
  .item:focus-visible .home .roof {
    transform: translateY(-2px);
  }
  .item:hover .home .door,
  .item:focus-visible .home .door {
    transform: scaleX(0.35);
  }

  /* Subscriptions: the stack fans up and the play button pops. */
  .subscriptions .back,
  .subscriptions .mid {
    transition: transform 280ms cubic-bezier(0.3, 1.6, 0.5, 1);
  }
  .subscriptions .mid {
    transition-delay: 40ms;
  }
  .subscriptions .play {
    transform-origin: 12.5px 16px;
    transition: transform 300ms cubic-bezier(0.3, 1.8, 0.5, 1) 60ms;
  }
  .item:hover .subscriptions .back,
  .item:focus-visible .subscriptions .back {
    transform: translateY(-2.5px);
  }
  .item:hover .subscriptions .mid,
  .item:focus-visible .subscriptions .mid {
    transform: translateY(-1.5px);
  }
  .item:hover .subscriptions .play,
  .item:focus-visible .subscriptions .play {
    transform: scale(1.25) translateX(0.5px);
  }

  /* History: the hands rewind a full turn. */
  .history .hands,
  .history .rewind {
    transform-origin: 12px 12px;
  }
  .history .rewind {
    transition: transform 420ms var(--spring);
  }
  .item:hover .history .hands,
  .item:focus-visible .history .hands {
    animation: rewind 700ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  .item:hover .history .rewind,
  .item:focus-visible .history .rewind {
    transform: rotate(-25deg);
  }
  @keyframes rewind {
    to {
      transform: rotate(-360deg);
    }
  }

  /* Settings: the gear turns a notch. */
  .settings .gear {
    transform-origin: 12px 12px;
    transition: transform 520ms cubic-bezier(0.3, 1.6, 0.4, 1);
  }
  .item:hover .settings .gear,
  .item:focus-visible .settings .gear {
    transform: rotate(90deg);
  }
</style>
