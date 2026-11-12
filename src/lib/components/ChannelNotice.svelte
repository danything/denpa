<script lang="ts">
  import { resolve } from "$app/paths";

  import {
    CHANNEL_NOTICE_ACTION,
    CHANNEL_NOTICE_SECTION,
    CHANNEL_NOTICE_TEXT,
    type ChannelNotice,
  } from "#lib/channel-notice.js";

  /**
   * 局が無いときの案内 (エージェントが無い・局が 1 つも無い・どれも復号できない) と、設定の「受信」へのリンク (`#lib/channel-notice.ts`)。
   *
   * - `bar` … 画面の上に貼る 1 行 (録画・番組表・ライブ。`+layout.svelte`)。閉じるボタンは無い
   * - `center` … 空の番組表の真ん中に置く。文とボタンを縦に積む
   */
  let {
    kind,
    variant = "bar",
    text = CHANNEL_NOTICE_TEXT[kind],
  }: {
    kind: ChannelNotice;
    variant?: "bar" | "center";
    /** 文を言い替えるとき (番組表で、選んでいる種別の名前を入れる) */
    text?: string;
  } = $props();
</script>

<div
  class="channel-notice {variant}"
  class:notice={variant === "bar"}
  class:info={variant === "bar"}
  role="status"
  data-testid="channel-notice"
>
  <p>{text}</p>
  <a
    href={`${resolve("settings/reception")}#${CHANNEL_NOTICE_SECTION[kind]}`}
    class="button small {variant === 'bar' ? 'secondary outline' : ''}"
    >{CHANNEL_NOTICE_ACTION[kind]}</a
  >
</div>

<style>
  .channel-notice {
    display: flex;
    align-items: center;
    gap: var(--dp-space-2) var(--dp-space-3);
  }
  .channel-notice p {
    margin: 0;
  }
  /*
     * **枠で囲まない、画面の幅いっぱいの 1 行。** ヘッダーの下に貼る。見た目はページの中の通知 (`app.css` の `.notice.info`。
     * 淡い面と先頭の ⓘ。地を案内の色で塗らない) を、角を落として 1 行の高さに詰めたもの。
     * 狭い画面で文が長ければ折り返し、ボタンは右に残す。左右の余白は本文と同じ (`+layout.svelte` の `--dp-gutter`)
     */
  .bar {
    --bar-pad: var(--dp-gutter);
    justify-content: space-between;
    padding: 0.375rem var(--bar-pad) 0.375rem
      calc(var(--bar-pad) + var(--dp-space-2) + 1.125em);
    border-radius: 0;
    font-size: var(--dp-text-sm);
  }
  .bar::before {
    top: 50%;
    translate: 0 -50%;
    left: var(--bar-pad);
  }
  .bar .button {
    flex-shrink: 0;
    margin: 0;
    padding-block: var(--dp-space-1);
  }
  .center {
    flex-direction: column;
    justify-content: center;
    gap: var(--dp-space-3);
    text-align: center;
  }
  .center p {
    color: var(--dp-muted);
  }
</style>
