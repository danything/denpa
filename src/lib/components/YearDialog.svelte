<script lang="ts">
  import "@anyblades/blades/components/modal";

  import {
    GREETING,
    hasNumbers,
    spanOf,
    type YearSummary,
  } from "#lib/season.js";

  /**
   * **「denpa の 1 年」のダイアログ** (チップ `YearChip` を押したとき。docs/screens.md「季節の演出」)。
   * 見出しは新年のあいさつ、その下に去年の数を 1 枚ずつの面に大きな数字と小さなラベルで並べる。0 のもの・無いものは並べない。
   *
   * - 開くと、面が順に下から現れ、数字は 0 から数え上がる (CSS だけ。`app.css` の `@property --dp-count`)。動きを減らす設定では、はじめから全部出す
   * - 見た目と閉じ方はほかのダイアログと同じ (`app.css` の `.modal-box`。左下の「閉じる」・Esc・幕を押すと閉じる)。閉じても中身は残す (閉じる動きの間に空にしない)
   */
  let {
    summary,
    onclose,
  }: {
    /** 見せる数。`null` で閉じる。読み込み中は `"loading"`、読めなかったら `"failed"` */
    summary: YearSummary | "loading" | "failed" | null;
    onclose: () => void;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  /** 閉じる間も出しておく中身 */
  let shown = $state.raw<YearSummary | null>(null);
  /** 開くたびに数え上げ直す (面ごと作り直す) */
  let opened = $state(0);
  /** 数を読めなかった (0 本と見分ける) */
  let failed = $state(false);

  $effect(() => {
    const element = dialog;
    if (element === null) return;
    if (summary === null) {
      if (element.open) element.close();
      return;
    }
    failed = summary === "failed";
    if (summary !== "failed" && summary !== "loading") {
      shown = summary;
      opened++;
    }
    if (!element.open) element.showModal();
  });

  interface Item {
    label: string;
    /** 数え上がる数。局の名前のように数でないものは null */
    count: number | null;
    text: string;
    unit: string;
  }
  const items = $derived.by((): Item[] => {
    const s = shown;
    if (s === null) return [];
    const list: Item[] = [];
    const number = (label: string, count: number, unit: string) =>
      list.push({ label, count, text: count.toLocaleString("ja-JP"), unit });
    if (s.recorded > 0) number("録画した本数", s.recorded, "本");
    if (s.recordedMs > 0) {
      const span = spanOf(s.recordedMs);
      number("録画した長さ", span.count, span.unit);
    }
    if (s.topRecorded !== null)
      list.push({
        label: "いちばん録った局",
        count: null,
        text: s.topRecorded,
        unit: "",
      });
    if (s.watched > 0) number("観終えた録画", s.watched, "本");
    if (s.topWatched !== null)
      list.push({
        label: "いちばん観た局",
        count: null,
        text: s.topWatched,
        unit: "",
      });
    return list;
  });
</script>

<dialog
  bind:this={dialog}
  {onclose}
  aria-labelledby="year-dialog-title"
  data-testid="year-dialog"
>
  <button
    type="button"
    class="modal-backdrop"
    tabindex="-1"
    aria-label="閉じる"
    onclick={() => dialog?.close()}
  ></button>
  <article class="modal-box" tabindex="-1">
    <h2 id="year-dialog-title">{GREETING}</h2>
    {#if failed}
      <p class="muted" data-testid="year-dialog-failed">
        去年の数を読み込めませんでした。閉じて、もう一度チップを押してください
      </p>
    {:else if shown === null}
      <p class="muted">読み込んでいます…</p>
    {:else}
      <p class="small muted">denpa の {shown.year} 年</p>
      {#key opened}
        {#if hasNumbers(shown)}
          <dl class="numbers" data-testid="year-dialog-numbers">
            {#each items as item, i (item.label)}
              <div class="card" style:--i={i}>
                <dt class="small muted">{item.label}</dt>
                <dd>
                  {#if item.count !== null}
                    <!-- 数え上がる数は見た目だけ。読み上げには数そのものを渡す -->
                    <span
                      class="value count"
                      style:--to={item.count}
                      aria-hidden="true"
                    ></span><span class="visually-hidden">{item.text}</span>
                  {:else}
                    <span class="value name">{item.text}</span>
                  {/if}
                  {#if item.unit !== ""}<span class="unit">{item.unit}</span
                    >{/if}
                </dd>
              </div>
            {/each}
          </dl>
        {:else}
          <p class="muted">{shown.year} 年の録画はありませんでした</p>
        {/if}
      {/key}
      <p class="small muted">
        この denpa の録画の記録から数えました。外には何も送っていません
      </p>
    {/if}
    <footer class="modal-foot">
      <button
        type="button"
        class="secondary modal-close"
        onclick={() => dialog?.close()}
        data-testid="year-dialog-close">閉じる</button
      >
    </footer>
  </article>
</dialog>

<style>
  /* 数を 2 列に並べる (狭い画面は 1 列)。1 つずつ淡い面に置く (ダイアログの中なので浮かせない) */
  .numbers {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: var(--dp-space-2);
    margin: var(--dp-space-4) 0;
  }
  .card {
    padding: var(--dp-space-3) var(--dp-space-4);
    border-radius: var(--dp-radius);
    background: var(--dp-subtle);
    /* 順に下から現れる (1 枚ずつ `--dp-duration` ずらす)。場所が動くので `--dp-duration-move` とばね */
    animation: rise var(--dp-duration-move) var(--dp-ease-spring)
      calc(var(--dp-duration) * var(--i)) backwards;
  }
  .card dt {
    margin: 0;
  }
  /* 数字の欄と局の名前の欄の高さをそろえ、下の線にそろえて置く (大きな数字の 1 行の高さ) */
  .card dd {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    min-height: calc(var(--dp-text-xl) * 1.5 * 1.2);
    margin: 0;
    overflow-wrap: anywhere;
  }
  /* 数字は見出し (`--dp-text-lg`) の 2 倍 (`--dp-text-xl` の 1.5 倍) の太字。ラベルと単位は小さく */
  .value {
    font-size: calc(var(--dp-text-xl) * 1.5);
    font-weight: 700;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
  }
  /* 局の名前は全角で長いので小見出しの大きさにし (3 列でも 1 行に収める)、欄の高さは数字の欄にそろえる */
  .name {
    align-self: flex-end;
    font-size: var(--dp-text-lg);
    line-height: 2;
  }
  .unit {
    margin-inline-start: var(--dp-space-1);
    font-size: var(--dp-text-sm);
  }
  /*
   * 0 から数え上がる。素の姿は目当ての数 (`--to`) なので、動きを止めた端末と `@property` の無いブラウザでは
   * はじめから目当ての数が出る。面が現れ始めてから、`--dp-duration-move` の 3 倍で数え終わる
   */
  .count {
    --dp-count: var(--to);
    counter-reset: dp-count var(--dp-count);
    animation: count-up calc(var(--dp-duration-move) * 3) var(--dp-ease)
      calc(var(--dp-duration) * var(--i)) backwards;
  }
  .count::after {
    content: counter(dp-count);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(0.75rem);
    }
  }
  @keyframes count-up {
    from {
      --dp-count: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .card,
    .count {
      animation: none;
    }
  }
</style>
