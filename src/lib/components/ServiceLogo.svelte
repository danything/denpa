<script lang="ts">
  import { resolve } from "$app/paths";

  /**
   * 局ロゴ。放送波から取得したもの (`/api/services/<id>/logo`)。録画の一覧・番組表・ライブで同じエンドポイント。
   *
   * **まだ取得できていない局** (`has` が偽) は、エンドポイントが KonomiTV のロゴ集から
   * 取れたものを返すことがある (`server/logo-remote.ts`)。それも無ければ `fallback` を出す。
   * 文字を入れればラベル (ライブの局名の先頭の 1 字)、空文字なら場所だけ (番組表。局名の先頭が
   * 列ごとにずれないように)、省けば何も出さない (一覧。行が細く、代わりの箱を置くと局名より目立つ)。
   *
   * 取得済みのものは**出せなかったときに引っ込めない** (`onerror` で消すと、Svelte が持つ要素を
   * 横から触ることになる)。`alt=""` なので、出せなければ場所だけが残る = 持っていない局と
   * 同じ見た目になる。未取得のほうは有るかどうかが分からないので、そちらだけ状態で
   * 出し分け、読めなければ `fallback` に落とす
   */
  let {
    id,
    has,
    style = "",
    fallback,
  }: {
    id: number;
    has: boolean | null;
    /** 大きさと置き方。画面ごとに違う */
    style?: string;
    fallback?: string;
  } = $props();

  /** エンドポイントにもロゴが無かった局 (内部 ID)。局が替わったら試し直す */
  let missedFor = $state<number | null>(null);

  /** 描く前に読み込みが終わって失敗していたら `onerror` は来ないので、置いた時点で見る */
  function checkMissed(node: HTMLImageElement) {
    if (node.complete && node.naturalWidth === 0) missedFor = id;
  }
</script>

{#if has}
  <img
    src={resolve(`api/services/${id}/logo`)}
    alt=""
    loading="lazy"
    class="logo"
    {style}
  />
{:else if missedFor !== id}
  <img
    src={resolve(`api/services/${id}/logo`)}
    alt=""
    loading="lazy"
    class="logo"
    {style}
    use:checkMissed
    onerror={() => (missedFor = id)}
  />
{:else if fallback !== undefined}
  <span class="logo empty" {style}>{fallback}</span>
{/if}

<style>
  .logo {
    flex-shrink: 0;
    border-radius: var(--dp-radius-sm);
    object-fit: contain;
  }
  .empty {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: var(--dp-text-xs);
  }
  .empty:not(:empty) {
    background: var(--dp-line);
  }
</style>
