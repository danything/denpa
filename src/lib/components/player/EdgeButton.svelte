<script lang="ts">
  import { OVERLAY, OVERLAY_BTN, OVERLAY_DANGER } from "./icons";

  /**
   * 「今」へ張り付くボタン — ライブの「ライブ」と追っかけの「最新」。
   * 張り付いている間は赤い字と赤い短い線 (`OVERLAY_DANGER`)、離れていれば白い字に赤い点。
   * 文字は小さくして、幅は詰める (大きい余白のままだと
   * 操作バーの中でこれだけ太って見えた)
   */
  let {
    active,
    label,
    onclick,
    testid,
  }: {
    /** 張り付いているか (放送の今・録れている際) */
    active: boolean;
    label: string;
    onclick: () => void;
    testid: string;
  } = $props();
</script>

<button
  type="button"
  class="{OVERLAY_BTN} edge {active ? OVERLAY_DANGER : OVERLAY}"
  {onclick}
  data-testid={testid}
>
  <span class="dot" class:active></span>
  <span class="label">{label}</span>
</button>

<style>
  .edge {
    gap: 0.25rem;
    padding: 0 0.75rem;
  }
  .dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: var(--dp-radius-full);
    background: var(--dp-rec);
  }
  .dot.active {
    background: currentColor;
  }
  /* 狭い枠では余白を詰める (押す的の高さは 40px のまま) */
  :global(.stage[data-compact]) .edge {
    padding: 0 0.5rem;
  }
  .label {
    font-size: var(--dp-text-xs);
    font-weight: var(--dp-weight-bold);
  }
</style>
