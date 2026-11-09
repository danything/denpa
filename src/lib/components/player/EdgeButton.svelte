<script lang="ts">
  import { OVERLAY, OVERLAY_BTN, OVERLAY_DANGER } from "./icons";

  /**
   * 「今」へ張り付くボタン。ライブの「ライブ」と追っかけの「最新」。
   * 張り付いている間は赤い字と赤い短い線 (`OVERLAY_DANGER`)、離れていれば白い字に赤い点。
   * 張り付いているかは読み上げにも `aria-pressed` で渡す (色だけにしない)。線は「入っている切り替え」の 1 本 (`app.css`)。
   * 文字は小さくする (左右の余白は文字のボタンの決まりのまま。`ControlButton`)
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
  aria-pressed={active}
  data-testid={testid}
>
  <span class="dot" class:active></span>
  <span class="label">{label}</span>
</button>

<style>
  .edge {
    gap: var(--dp-space-1);
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
  .label {
    font-size: var(--dp-text-xs);
    font-weight: var(--dp-weight-bold);
  }
</style>
