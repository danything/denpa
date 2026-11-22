<script lang="ts">
  import "../app.css";
  import { page } from "$app/state";

  import Shell from "./Shell.svelte";

  let { children, data } = $props();

  /**
   * **埋め込みのページ (`/embed/…`) には土台 (`Shell.svelte`) を置かない。** ヘッダー・下のタブ・お知らせ・季節の演出も、テーマ・オフライン視聴・戻ったときの読み直しも動かさない。
   * テレビのアプリが映像の上に透明な WebView で重ねるページで、ページの外の操作はアプリが持つ ([api.md](../../docs/api.md#データ放送のページ-embeddata))
   */
  const embed = $derived(page.route.id?.startsWith("/embed/") ?? false);
</script>

{#if embed}
  {@render children()}
{:else}
  <Shell {data}>{@render children()}</Shell>
{/if}
