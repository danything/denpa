<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * 何も映っていない間の幕。**見た目の決まりを画面ごとに書かない**。
   * 敷きの濃さ・スピナーの大きさ・文字色が 3 画面で 3 種類に育っていた。
   *
   * - **前のフレームを貼っている間 (`holding`) は塗り潰さない。** 覆ってしまうと
   *   貼っている意味が無くなる (実機で撮ると、前のフレームが白くかすんだだけの
   *   画面になっていた)。回っているものだけを小箱に入れて、どんな映像の上でも
   *   見えるようにする
   * - **貼っている間の回るものは 1.5 秒待ってから出す。** 局替えはたいてい 1 秒前後で
   *   終わるので、すぐ出すとちらつくだけになる。テレビと同じく前のフレームのまま止めておく
   * - **回るものは、繋いでいる・読み込んでいる最中だけ出し、いつも文言を添える** (「読み込み中」。切れて繋ぎ直しているときは
   *   「繋ぎ直しています」)。3 画面で条件と文言を変えない
   * - **幕そのものは押させない** (`pointer-events: none`)。箱いっぱいに広がるので、
   *   そのままだと下の操作バーを覆って押せなくなる。エラーの下のボタン (`actions`) だけ押せるように戻す
   */
  interface Props {
    /** 前のフレームを貼っているか (`live-player` の holding) */
    holding: boolean;
    /** 繋いでいる・読み込んでいる最中か。回っているものと「読み込み中」を出す */
    busy: boolean;
    /** 切れて繋ぎ直している最中か。文言を「繋ぎ直しています」にする */
    resuming?: boolean;
    /** 失敗の文言。あれば busy より先にこちらを出す */
    error?: string;
    /** エラーの下のボタン (ライブ・追っかけの「再試行」、観る画面の「… で観る」)。押せるようにするのは幕の側 */
    actions?: Snippet | undefined;
    /** busy でも error でもないときの文言 (ライブの「局を選んでください」)。空なら何も出さない */
    idle?: string;
    testid: string;
  }
  let {
    holding,
    busy,
    resuming = false,
    error = "",
    actions,
    idle = "",
    testid,
  }: Props = $props();
</script>

<div
  class="veil"
  class:dim={!holding}
  data-testid={testid}
  data-veiled={!holding}
>
  {#if error !== ""}
    <div class="error">
      <div class="message">{error}</div>
      {#if actions}<div class="actions">{@render actions()}</div>{/if}
    </div>
  {:else if busy}
    <!-- 前のフレームを貼っている間は、回っているものだけを小箱に入れる -->
    <span class="busy" class:boxed={holding}>
      <span class="spinner" aria-busy="true"></span>
      <span class="note" data-testid="{testid}-note"
        >{resuming ? "繋ぎ直しています" : "読み込み中"}</span
      >
    </span>
  {:else if idle !== ""}
    <span class="idle">{idle}</span>
  {/if}
</div>

<style>
  /* 段は字幕と同じ (実況のコメントを上に流さない。操作バーのボタンは上。`app.css` の `--dp-z-stage-*`) */
  .veil {
    pointer-events: none;
    position: absolute;
    inset: 0;
    z-index: var(--dp-z-stage-captions);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--dp-on-video);
  }
  .dim {
    background: var(--dp-video-veil);
  }
  .error {
    pointer-events: auto;
    padding: var(--dp-space-4);
    text-align: center;
  }
  .message {
    font-weight: var(--dp-weight);
  }
  .actions {
    margin-top: var(--dp-space-3);
  }
  .busy {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--dp-space-2);
  }
  .boxed {
    padding: var(--dp-space-3);
    border-radius: var(--dp-radius-lg);
    background: var(--dp-video-veil);
    opacity: 0;
    animation: appear 0s 1.5s forwards;
  }
  @keyframes appear {
    to {
      opacity: 1;
    }
  }
  /* Pico の aria-busy は文字の前に回るものを出す。大きく、白く */
  .spinner {
    font-size: 2.5rem;
    line-height: 1;
    --pico-color: var(--dp-on-video);
  }
  .note {
    font-size: var(--dp-text-sm);
  }
  .idle {
    color: var(--dp-on-video-muted);
  }
</style>
