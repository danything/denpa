<script lang="ts">
  import { SAVED_FOR, type SaveState } from "#lib/autosave.svelte.js";

  /**
   * その場で保存した結果を、節の見出しの横に小さく出す (`autosave`)。
   * 枠はいつも置いておき (読み上げに知らせる `role="status"`)、中身だけ替える。
   *
   * 「保存しました」は**ふわっと出て、出しておく長さ (`SAVED_FOR`) の終わりにふわっと消える**
   * (`app.css` の `.flash`)。外すのは `autosave` で、ここは見え方だけ。動かさない設定ではそのまま出て消える
   */
  let { status }: { status: SaveState } = $props();
</script>

<span class="save-note tiny" role="status">
  {#if status.state === "saving"}
    <span class="muted">保存中…</span>
  {:else if status.state === "saved"}
    <span
      class="saved flash"
      style:--flash-for="{SAVED_FOR}ms"
      data-testid="saved-result">保存しました</span
    >
  {:else if status.state === "error"}
    <span class="text-error" data-testid="settings-error">
      保存できませんでした{status.message === "" ? "" : `: ${status.message}`}
    </span>
  {/if}
</span>

<style>
  .save-note {
    font-weight: var(--dp-weight);
  }
  .saved {
    display: inline-block;
    color: var(--dp-ok-text);
  }
</style>
