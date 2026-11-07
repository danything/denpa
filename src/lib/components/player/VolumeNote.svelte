<script lang="ts">
  import StageNote from "./StageNote.svelte";
  import type { Volume } from "./volume.svelte.js";

  /** ↑↓ で音量を変えた直後に、映像の上に「音量 N%」を出す (3 画面で同じ。`volume.svelte.ts` の `noted`) */
  let { volume, testid }: { volume: Volume; testid: string } = $props();
</script>

{#if volume.noted}
  <StageNote {testid}>音量 {volume.level}%</StageNote>
{/if}
