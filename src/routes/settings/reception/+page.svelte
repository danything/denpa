<script lang="ts">
  import Toasts, {
    errorNotice,
    type Notice,
  } from "#lib/components/Toasts.svelte";
  import { liveUpdates } from "#lib/live-updates.svelte.js";
  import Broadcast from "./Broadcast.svelte";
  import Channels from "./Channels.svelte";
  import Tuners from "./Tuners.svelte";

  let { data, form } = $props();

  /*
   * 通知を聞くのは画面で1本 (節ごとに繋ぐと、同じ画面から EventSource が何本も出る)。
   * 使い始めた・離した・番組表やロゴの取得の様子は 'tuners'、スキャンの進み具合は 'scan'、
   * 局の取り込みは 'services'、番組表の集まり具合は 'programs'、ロゴの取得は 'logos'
   */
  liveUpdates(["tuners", "scan", "services", "programs", "logos"]);

  /**
   * 押した結果は画面で1か所に出す (節ごとに出すと、同じ失敗が節の数だけ並ぶ)。
   * スキャンやロゴの取得の経過そのものは、その節の中に出したまま
   */
  const notices = $derived.by(() => {
    const list: Notice[] = [];
    list.push(...errorNotice(form, "settings-error"));
    if (form?.scan)
      list.push({ key: "tuner-notice", kind: "info", text: form.scan });
    /*
     * 済んだこと (覚えたロゴを消した)。**`message` に載せない** — あれは fail の言葉として
     * 赤で出す欄 (`errorNotice`) なので、載せていた頃は済んだことまで失敗の赤で出ていた
     */
    if (form?.done)
      list.push({ key: "tuner-done", kind: "success", text: form.done });
    return list;
  });
</script>

<Toasts {notices} source={form} />

<!-- 節の並びと名前は `#lib/settings-sections.ts`。`id` は左の一覧から飛ぶ先 -->
<div class="part" id="tuners" data-part><Tuners {data} /></div>
<div class="part" id="channels" data-part><Channels {data} /></div>
<div class="part" id="broadcast" data-part><Broadcast {data} /></div>
