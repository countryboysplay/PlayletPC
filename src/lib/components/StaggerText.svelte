<script lang="ts">
  // Words rise from blurred to sharp, one after another (Vengeance UI's Stagger Text).
  // Screen readers get the whole phrase once; the split words are hidden from them.
  let { text }: { text: string } = $props()
  const words = $derived(text.split(/\s+/).filter(Boolean))
</script>

{#key text}
  <span class="sr">{text}</span>
  <span aria-hidden="true">
    {#each words as word, i}<span class="word" style="--i: {Math.min(i, 12)}">{word}</span>{' '}{/each}
  </span>
{/key}

<style>
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .word {
    display: inline-block;
    animation: rise 620ms cubic-bezier(0.2, 0.7, 0.2, 1) backwards;
    animation-delay: calc(var(--i) * 60ms);
  }

  @keyframes rise {
    from {
      opacity: 0;
      filter: blur(10px);
      transform: translateY(10px);
    }
  }
</style>
