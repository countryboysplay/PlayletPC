<script lang="ts">
  // The text sharpens in from a wide, blurred smear each time it changes (Vengeance UI's
  // Morph Text). Inline, so it keeps the parent's wrapping and ellipsis.
  let { text }: { text: string } = $props()
</script>

{#key text}<span class="morph">{text}</span>{/key}

<style>
  .morph {
    animation: morph 460ms ease backwards;
  }

  @keyframes morph {
    from {
      opacity: 0;
      filter: blur(12px);
      letter-spacing: 0.06em;
    }
  }
</style>
