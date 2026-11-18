<script lang="ts">
  // A count rolls up to its value when it arrives (Vengeance UI's Animated Number).
  // The CSS reduced-motion rule can't reach a JS tween, so it is checked here.
  import { Tween, prefersReducedMotion } from 'svelte/motion'
  import { cubicOut } from 'svelte/easing'
  import { formatCount } from '../format'

  let { value, format = formatCount }: { value: number | undefined; format?: (n: number) => string } = $props()

  const shown = new Tween(0, { easing: cubicOut })
  $effect(() => {
    void shown.set(value ?? 0, { duration: prefersReducedMotion.current ? 0 : 900 })
  })
</script>

{value === undefined ? '' : format(Math.round(shown.current))}
