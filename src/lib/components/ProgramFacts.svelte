<script lang="ts">
  import type { Snippet } from "svelte";

  import {
    audioLabel,
    genreLabel,
    seriesLabels,
    videoLabel,
  } from "#lib/arib.js";
  import {
    COPY_NEVER_REASON,
    dateTime,
    duration,
    linkify,
    time,
  } from "#lib/format.js";
  import type { ProgramDetail } from "#lib/types.js";

  /**
   * 番組の中身そのもの。**枠は持たない。**
   *
   * モーダル (`ProgramDetail.svelte`) と、観る画面・ライブ・追っかけの右側
   * (`FactsAside`) の両方から使う。**同じものを2つ書くと、片方だけ
   * 直したときに見え方がずれる** — 実際、番組表・予約・録画で
   * 見え方を揃えるためにモーダルへ寄せたのが元の理由で、観る画面もその続き。
   */
  let {
    program,
    notes = [],
    cmNote = null,
    fps = null,
    status,
  }: {
    program: ProgramDetail;
    /**
     * 失敗や削除の理由。一覧には状態だけを出して、中身はここで見せる。
     *
     * 見出しを一緒に渡す。録画そのものの失敗とエンコードの失敗は別物で、
     * どちらも「エンコードに失敗しました」と書いていた頃は、録画が失敗した
     * 行を開くと嘘の見出しが出ていた
     */
    notes?: { title: string; text: string }[];
    /** 何を使って検出したか (ロゴ / 無音)。判定の当てにできるか分かる */
    cmNote?: string | null;
    /**
     * エンコードしたもののコマ数 (30/60、`recordings.fps`)。**番組ではなく録画の事実**なので
     * `program` とは別に渡す — 番組詳細は EPG から引けると差し替わる (`detail.open`)
     */
    fps?: number | null;
    /**
     * 時刻の行の末尾に添える状態のバッジ (予約済み・放送終了)。時刻と状態を 1 か所で読める
     * (モーダルから渡すときだけ)
     */
    status?: Snippet | undefined;
  } = $props();

  /** 詳細情報。EIT から読み取った「出演者」などの見出し付きテキスト */
  const extended = $derived(Object.entries(program.extended ?? {}));

  /**
   * ジャンルのラベル。**同じものは1つにまとめる。** 放送は同じ分類を何度も入れてくる (実機の高校野球中継が
   * `[スポーツ, 拡張, 拡張]`)。字を目印にしていた頃は、同じラベルが2つで `each_key_duplicate` になり、
   * その番組だけ詳細が開かなかった (目印はいま番号)
   */
  const genres = $derived([
    ...new Set(
      (program.genre_detail ?? [])
        .map(genreLabel)
        .filter((label) => label !== ""),
    ),
  ]);
  const audios = $derived((program.audios ?? []).map(audioLabel));
  const video = $derived(
    videoLabel(program.video_resolution, program.video_type),
  );
  /** シリーズ記述子の話数 (「第3話 (全12話)」「最終回」「再放送」)。載せない局では何も出ない */
  const series = $derived(seriesLabels(program));
</script>

<!--
    説明文。中に書かれたURLはリンクにする。
    `{@html}` は使わない。EPG の文面は放送局が書いたものをそのまま持ってきているので、
    そのまま流し込めるものとして扱わない
-->
{#snippet body(
  text: string,
)}{#each linkify(text) as part, i (i)}{#if part.href}<a
        class="link"
        href={part.href}
        target="_blank"
        rel="noopener noreferrer">{part.text}</a
      >{:else}{part.text}{/if}{/each}{/snippet}

<h3 class="title broadcast">{program.name}</h3>
<p class="meta small muted num">
  <span class="broadcast">{program.service_name}</span> ・ {dateTime(
    program.start_at,
  )} 〜 {time(program.end_at)}
  ({duration(program.start_at, program.end_at)})
  {#if status}
    <span class="meta-status">{@render status()}</span>
  {/if}
</p>

<!--
  EPG が持っている符号は、そのままでは読めないので言葉に直して出す。
  **話数・ジャンル・映像・音声は囲まず、控えた字を「・」でつなぐ** (一覧の行の補足と同じ)。
  囲むのは状態 (有料・コピー禁止) だけ (`app.css` の `.tag`)
-->
<div class="badges small" data-testid="detail-badges">
  {#each series as label (label)}
    <span class="fact" data-testid="detail-series">{label}</span>
  {/each}
  <!-- 目印は番号で (`genres` の注) -->
  {#each genres as label, i (i)}
    <span class="fact" data-testid="detail-genre">{label}</span>
  {/each}
  {#if video}
    <span class="fact" data-testid="detail-video">{video}</span>
  {/if}
  {#if fps !== null}
    <!-- 実測 (fpsDetect) がどちらに転んだか。ログにしか出ていなかった -->
    <span class="fact" data-testid="detail-fps">{fps}コマ/秒</span>
  {/if}
  {#each audios as label, i (i)}
    <span class="fact" data-testid="detail-audio">{label}</span>
  {/each}
  {#if !program.is_free}
    <span class="tag warning">有料</span>
  {/if}
  {#if program.copy_never}
    <!-- 録らない番組 (`COPY_NEVER_REASON`)。理由は title で添える。観るのはそのままできる -->
    <span class="tag" title={COPY_NEVER_REASON} data-testid="detail-copy-never"
      >コピー禁止</span
    >
  {/if}
</div>

{#if program.description}
  <p class="block small pre broadcast">{@render body(program.description)}</p>
{/if}

{#each extended as [heading, text] (heading)}
  <div class="block">
    <div class="small head broadcast">{heading}</div>
    <div class="small pre muted broadcast">{@render body(text)}</div>
  </div>
{/each}

{#if cmNote}
  <!--
        **いつもの精度が出なかったときだけ出す** (うまくいった回は `cmNote` ごと渡ってこない。`format.cmNoteWorthShowing`)。
        どこを切ったかは書かない (チャプターとして動画に入っている)。覚えたロゴは設定の「チャンネル」の「CMロゴ」で確かめられる
    -->
  <div class="block" data-testid="detail-cm">
    <div class="small head">CM</div>
    <div class="tiny muted" data-testid="detail-cm-note">{cmNote}</div>
  </div>
{/if}

{#each notes as note (note.title)}
  <div class="block" data-testid="detail-error">
    <div class="text-error small head">{note.title}</div>
    <pre class="note">{note.text}</pre>
  </div>
{/each}

<style>
  .title {
    margin: 0;
    font-size: var(--dp-text-lg);
    font-weight: var(--dp-weight-bold);
    overflow-wrap: break-word;
  }
  .meta {
    margin-top: 0.25rem;
  }
  /* バッジは時刻の続きに置き、入りきらなければ次の行へ回る (字の途中では折らない) */
  .meta-status {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-inline-start: 0.5rem;
    vertical-align: middle;
  }
  .badges {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0;
    margin-top: 0.5rem;
  }
  /* 区切りの「・」は前の事実の後ろに付け、折り返しても行の頭に来ないように */
  .fact {
    color: var(--dp-muted);
  }
  .fact:has(+ .fact)::after {
    content: "・";
  }
  .badges .tag {
    margin-left: 0.5rem;
  }
  .badges > .tag:first-child {
    margin-left: 0;
  }
  .block {
    margin-top: 0.75rem;
  }
  .head {
    font-weight: var(--dp-weight);
  }
  .pre {
    white-space: pre-wrap;
  }
  .link {
    color: var(--pico-primary);
    word-break: break-all;
  }
  .note {
    margin: 0.25rem 0 0;
    max-height: 12rem;
    overflow: auto;
    padding: 0.5rem;
    border-radius: var(--dp-radius-sm);
    background: var(--dp-subtle);
    font-family: var(--dp-font-mono);
    font-size: var(--dp-text-xs);
    white-space: pre-wrap;
  }
</style>
