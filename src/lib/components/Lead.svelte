<script lang="ts">
  import type { Snippet } from "svelte";
  import Info from "~icons/lucide/info";

  import Icon from "./player/Icon.svelte";

  /**
   * 説明の 1 行と、その終わりに続く「詳しく」(設定の画面)。
   *
   * **「詳しく」は文の終わりの小さな ⓘ にする。** 欄ごとに「詳しく ›」の下線付きの字が
   * 並んでいた頃は、要点の文よりそちらが目に付いた。押すと続きを下に出す (読み上げでは「詳しく」)
   */
  let {
    children,
    more,
    class: extra = "",
  }: {
    children: Snippet;
    /** 畳んでおく続き。無ければ ⓘ も出さない */
    more?: Snippet;
    class?: string;
  } = $props();

  let open = $state(false);
  const id = $props.id();
</script>

<p class="lead {extra}">
  {@render children()}
  {#if more}
    <button
      type="button"
      class="info"
      class:open
      aria-label="詳しく"
      title="詳しく"
      aria-expanded={open}
      aria-controls={id}
      onclick={() => (open = !open)}
    >
      <Icon icon={Info} size="size-4" />
    </button>
  {/if}
</p>
{#if more}
  <!-- 閉じている間も置いておく (ページ内の検索で見つかる。読み上げとテストからも引ける) -->
  <div class="more-body" {id} hidden={!open}>
    {@render more()}
  </div>
{/if}

<style>
  /* 左右の余白は触らない (チェックの下では字下げする。app.css の `.lead.indent`) */
  .lead {
    margin-block: 0;
    color: var(--dp-muted);
    font-size: var(--dp-text-sm);
  }
  /* 字の並びに置く小さな丸い的 (24px)。行の高さを押し広げないよう、上下は負の余白で字の高さに収める */
  .info {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    margin: -0.25rem 0 -0.25rem 0.125rem;
    padding: 0;
    border: 0;
    border-radius: var(--dp-radius-full);
    background: transparent;
    box-shadow: none;
    color: var(--dp-muted);
    vertical-align: middle;
    cursor: pointer;
    transition:
      background-color var(--dp-duration),
      color var(--dp-duration);
  }
  /* 指で押す端末では、見た目は変えずに押せる範囲だけ 40px に広げる */
  @media (pointer: coarse) {
    .info {
      position: relative;
    }
    .info::after {
      content: "";
      position: absolute;
      inset: -0.5rem;
    }
  }
  .info:hover {
    background: var(--dp-hover-soft);
    /* `--pico-color` はボタンの中ではボタンの字の色 (app.css の「ボタン」)。本文の色は `--dp-fg` */
    color: var(--dp-fg);
  }
  .info.open {
    color: var(--dp-primary-text);
  }
  .more-body {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-top: 0.35rem;
    color: var(--dp-muted);
    font-size: var(--dp-text-sm);
  }
  .more-body[hidden] {
    display: none;
  }
  .more-body :global(p) {
    margin: 0;
  }
</style>
