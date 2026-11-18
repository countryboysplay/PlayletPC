<script lang="ts">
  /** Small control icons, drawn at the nav rail's stroke weight; one chevron rotated for each direction. */
  let { name }: { name: 'up' | 'down' | 'left' | 'right' | 'close' } = $props()

  const turn = { right: 0, down: 90, left: 180, up: 270, close: 0 }
</script>

<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" style="transform: rotate({turn[name]}deg)">
  {#if name === 'close'}
    <path d="M6 6l12 12M18 6 6 18" />
  {:else}
    <path d="M9 5l7 7-7 7" />
  {/if}
</svg>

<style>
  svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    display: block;
    margin: auto;
    flex: 0 0 auto;
  }
</style>
