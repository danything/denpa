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
   * 画面の上に貼る 1 行 (録画・番組表・ライブ。`+layout.svelte`)。閉じるボタンは無い。
   * 番組表で選んでいる種別に局が無いときは、この 1 行の代わりに表の場所の空の状態で言う (`guide/+page.svelte`)
   */
  let { kind }: { kind: ChannelNotice } = $props();
</script>

<div
  class="channel-notice notice info"
  role="status"
  data-testid="channel-notice"
>
  <p>{CHANNEL_NOTICE_TEXT[kind]}</p>
  <a
    href={`${resolve("settings/reception")}#${CHANNEL_NOTICE_SECTION[kind]}`}
    class="button small secondary outline">{CHANNEL_NOTICE_ACTION[kind]}</a
  >
</div>

<style>
  /*
     * **枠で囲まない、画面の幅いっぱいの 1 行。** ヘッダーの下に貼る。見た目はページの中の通知 (`app.css` の `.notice.info`。
     * 淡い面と先頭の ⓘ。地を案内の色で塗らない) を、角を落として 1 行の高さに詰めたもの。
     * 狭い画面で文が長ければ折り返し、ボタンは右に残す。左右の余白は本文と同じ (`+layout.svelte` の `--dp-gutter`)
     */
  .channel-notice {
    --bar-pad: var(--dp-gutter);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--dp-space-2) var(--dp-space-3);
    padding: 0.375rem var(--bar-pad) 0.375rem
      calc(var(--bar-pad) + var(--dp-space-2) + 1.125em);
    border-radius: 0;
    font-size: var(--dp-text-sm);
  }
  .channel-notice p {
    margin: 0;
  }
  .channel-notice::before {
    top: 50%;
    translate: 0 -50%;
    left: var(--bar-pad);
  }
  .channel-notice .button {
    flex-shrink: 0;
    margin: 0;
    padding-block: var(--dp-space-1);
  }
</style>
