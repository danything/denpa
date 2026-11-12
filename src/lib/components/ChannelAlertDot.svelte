<script lang="ts">
  import Info from "~icons/lucide/info";
  import TriangleAlert from "~icons/lucide/triangle-alert";

  import {
    CHANNEL_ALERT_LABEL,
    type ChannelAlertKind,
  } from "#lib/channel-notice.js";
  import Icon from "#lib/components/player/Icon.svelte";

  /**
   * スマホの形の設定の入口に付ける、チャンネルのお知らせの小さな印 (`app.css` の `.alert-dot`)。
   * ヘッダーの印 (`ChannelAlert.svelte`) と同じアイコンを小さくしたもの。置き場は使う側で決める
   */
  let { kind }: { kind: ChannelAlertKind } = $props();
</script>

<span
  class="alert-dot {kind}"
  role="img"
  aria-label={CHANNEL_ALERT_LABEL[kind]}
  data-testid="alert-dot"
>
  <Icon icon={kind === "ground" ? TriangleAlert : Info} size="size-3.5" />
</span>
