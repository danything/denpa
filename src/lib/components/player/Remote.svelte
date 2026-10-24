<script lang="ts">
  import "@anyblades/blades/layered/components/accordion";
  import ArrowDown from "~icons/lucide/arrow-down";
  import ArrowLeft from "~icons/lucide/arrow-left";
  import ArrowRight from "~icons/lucide/arrow-right";
  import ArrowUp from "~icons/lucide/arrow-up";
  import Icon from "./Icon.svelte";

  /**
   * 指で押すリモコン。データ放送を出している間だけ右の列に出す (キーボードは `DataBroadcast` の `key` が受ける)。
   * 映像の上には重ねない — 放送の画面は枠を下まで塗り潰すので埋もれる。「消す」は置かない (右の縦列の d で畳める)
   */

  interface Props {
    /** 押されたキーを BML へ渡す。`AribKeyCode` の番号 */
    press: (code: number) => void;
  }

  const { press }: Props = $props();

  /*
   * `AribKeyCode` (`src/lib/bml/engine.ts` の `KEY`) と同じ値。番号で書くのは、値として import すると
   * データ放送を出す前からエンジン全体が落ちてくるため
   */
  /** d (DataButton)。`DataBroadcast` の DATA_BUTTON と同じ */
  const DATA = 20;
  const UP = 1;
  const DOWN = 2;
  const LEFT = 3;
  const RIGHT = 4;
  const ENTER = 18;
  const BACK = 19;
  const BLUE = 21;
  const RED = 22;
  const GREEN = 23;
  const YELLOW = 24;

  /** 色ボタン (実機のリモコンと同じ並び)。放送が名指しする色なので、テーマの色に寄せずじかに塗る */
  const COLORS = [
    { code: BLUE, name: "青", paint: "#2563eb", ink: "#fff" },
    { code: RED, name: "赤", paint: "#dc2626", ink: "#fff" },
    { code: GREEN, name: "緑", paint: "#16a34a", ink: "#fff" },
    { code: YELLOW, name: "黄", paint: "#facc15", ink: "#000" },
  ];

  /**
   * 数字。**並びは実機のリモコンと同じ** (1〜9・0・10・11)。
   * `AribKeyCode` は `Digit0` が 5 で、そこから数の順に並んでいる。
   *
   * **畳んである** — 使う放送のほうが少ない (投票や郵便番号の入力)
   */
  const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "10", "11"];
  const digit = (name: string): number => 5 + Number(name);
</script>

<!-- 指で押せる大きさに (十字と決定は正方形で大きめ) -->
<div class="remote" data-testid="live-remote">
  <div class="colors">
    {#each COLORS as color (color.code)}
      <button
        type="button"
        class="color"
        style="--paint: {color.paint}; --ink: {color.ink}"
        onclick={() => press(color.code)}
        data-testid="live-remote-{color.code}"
      >
        {color.name}
      </button>
    {/each}
  </div>

  <!-- 十字と決定。**真ん中が決定**で、実機と同じ形 -->
  <div class="pad">
    <div></div>
    <button
      type="button"
      class="secondary key"
      onclick={() => press(UP)}
      aria-label="上"><Icon icon={ArrowUp} size="size-5" /></button
    >
    <div></div>
    <button
      type="button"
      class="secondary key"
      onclick={() => press(LEFT)}
      aria-label="左"><Icon icon={ArrowLeft} size="size-5" /></button
    >
    <button type="button" class="key enter" onclick={() => press(ENTER)}
      >決定</button
    >
    <button
      type="button"
      class="secondary key"
      onclick={() => press(RIGHT)}
      aria-label="右"><Icon icon={ArrowRight} size="size-5" /></button
    >
    <div></div>
    <button
      type="button"
      class="secondary key"
      onclick={() => press(DOWN)}
      aria-label="下"><Icon icon={ArrowDown} size="size-5" /></button
    >
    <div></div>
  </div>

  <div class="row">
    <button
      type="button"
      class="secondary small grow"
      onclick={() => press(BACK)}
    >
      戻る
    </button>
    <!-- d は放送に渡す (DataButtonPressed)。待機ページからメニューを開くのはこれ -->
    <button type="button" class="secondary small" onclick={() => press(DATA)}>
      d
    </button>
  </div>

  <!-- **畳んでおく。** 使う放送のほうが少ないので、いつも場所を取らせない -->
  <details class="digits small">
    <summary>数字</summary>
    <div class="digit-grid">
      {#each DIGITS as name (name)}
        <button
          type="button"
          class="secondary small"
          onclick={() => press(digit(name))}
          data-testid="live-remote-digit-{name}"
        >
          {name}
        </button>
      {/each}
    </div>
  </details>
</div>

<style>
  .remote {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    flex-shrink: 0;
    /* カードにしない。ほかのサイドバーと同じく地も枠も影も付けず、局の一覧とは余白で分ける (`app.css` の `.side-panel`) */
    margin-bottom: 1.75rem;
  }
  .colors {
    display: flex;
    gap: 0.25rem;
  }
  /* 放送の言う色をじかに塗る (テーマの色に寄せない) */
  .color {
    --pico-background-color: var(--paint);
    --pico-border-color: var(--paint);
    --pico-color: var(--ink);
    flex: 1;
    height: 2rem;
    padding: 0;
    font-size: var(--dp-text-sm);
  }
  /* 押したときの色は Pico (層の中) に勝つ上の変数のまま。明るさだけ上げる */
  .color:is(:hover, :focus, :active) {
    filter: brightness(1.1);
  }
  .pad {
    display: grid;
    grid-template-columns: repeat(3, 3rem);
    gap: 0.25rem;
    margin: 0 auto;
  }
  .key {
    width: 3rem;
    height: 3rem;
    padding: 0;
    font-size: var(--dp-text-lg);
  }
  .enter {
    font-size: var(--dp-text-xs);
  }
  .row {
    display: flex;
    gap: 0.5rem;
  }
  .digits summary {
    cursor: pointer;
    user-select: none;
  }
  .digit-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.25rem;
    margin-top: 0.5rem;
  }
</style>
