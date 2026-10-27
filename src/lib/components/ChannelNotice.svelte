<script lang="ts">
  import { resolve } from "$app/paths";

  import {
    CHANNEL_NOTICE_TEXT,
    type ChannelNotice,
  } from "#lib/channel-notice.js";

  /**
   * 局が無いときの案内と、スキャンへのリンク (`#lib/channel-notice.ts`)。
   *
   * - `bar` … 画面の上に貼る1行 (録画・番組表・ライブ。`+layout.svelte`)。閉じるボタンは無い
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
    href={`${resolve("settings/reception")}#channels`}
    class="button small {variant === 'bar' ? 'secondary outline' : ''}"
    >スキャンへ</a
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
     * **枠で囲まない、画面の幅いっぱいの1行。** ヘッダーの下に貼る。見た目はページの中の通知 (`app.css` の `.notice.info`。
     * 淡い面と頭の ⓘ。地を案内の色で塗らない) を、角を落として 1 行の高さに詰めたもの。
     * 狭い画面で文が長ければ折り返し、ボタンは右に残す
     */
  .bar {
    --bar-pad: 1rem;
    justify-content: space-between;
    padding: 0.375rem var(--bar-pad) 0.375rem
      calc(var(--bar-pad) + 0.5rem + 1.125em);
    border-radius: 0;
    font-size: var(--dp-text-sm);
  }
  .bar::before {
    top: 50%;
    translate: 0 -50%;
    left: var(--bar-pad);
  }
  @media (min-width: 768px) {
    .bar {
      --bar-pad: 1.5rem;
    }
  }
  .bar .button {
    flex-shrink: 0;
    margin: 0;
    padding-block: 0.15rem;
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
