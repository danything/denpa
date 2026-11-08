<script lang="ts">
  import Toasts, { errorNotice } from "#lib/components/Toasts.svelte";
  import { liveUpdates } from "#lib/live-updates.svelte.js";

  import Jikkyo from "./Jikkyo.svelte";
  import Migrate from "./Migrate.svelte";
  import MigrateEdcb from "./MigrateEdcb.svelte";
  import Notifications from "./Notifications.svelte";
  import Transfer from "./Transfer.svelte";
  import Tv from "./Tv.svelte";

  let { data, form } = $props();

  // 引き継ぎの進み具合はサーバから流れてくる
  liveUpdates(["migrate"]);

  /** 押した結果は画面で 1 か所に出す。引き継ぎの進み具合そのものは、その節の中に出したまま */
  const notices = $derived.by(() => {
    const list = errorNotice(form, "settings-error");
    if (form?.webhookAdded)
      list.push({
        key: "webhook-added",
        kind: "success",
        text: "通知先を追加しました",
      });
    if (form?.tested) {
      list.push({
        key: "webhook-tested",
        kind: form.tested === "ok" ? "success" : "error",
        // 届いたら `ok` が返る (`server/webhook.ts`)。英語のまま出さない
        text:
          form.tested === "ok"
            ? "テスト送信が届きました"
            : `テスト送信に失敗しました: ${form.tested}`,
      });
    }
    if (form?.niconicoUnlinked)
      list.push({
        key: "niconico-unlinked",
        kind: "success",
        text: "連携を解除しました。ニコニコの側の許可は、ニコニコのアカウント設定から取り消せます",
      });
    if (form?.migrate)
      list.push({ key: "migrate-started", kind: "info", text: form.migrate });
    return list;
  });
</script>

<Toasts {notices} source={form} />

<!-- 節の並びと名前は `#lib/settings-sections.ts`。`id` は左の一覧から飛ぶ先 -->
<div id="notifications" data-part><Notifications {data} /></div>
<div id="tv" data-part><Tv {data} /></div>
<div id="jikkyo" data-part><Jikkyo {data} /></div>
<div id="migrate" data-part><Migrate {data} /></div>
<div id="migrate-edcb" data-part><MigrateEdcb {data} /></div>
<div id="transfer" data-part><Transfer {data} /></div>
