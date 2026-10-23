<script lang="ts">
  import Icon from "./Icon.svelte";
  import {
    type IconShape,
    OVERLAY,
    OVERLAY_BTN,
    OVERLAY_DANGER,
    OVERLAY_ON,
    OVERLAY_ROUND,
  } from "./icons";

  /**
   * 映像の上に置くボタン。**3画面 (ライブ・追っかけ・観る画面) で同じもの。**
   *
   * 押されている間だけ色を変えるのも、`aria-pressed` を立てるのもここ1箇所
   * (裏の影は並び全体に `ControlBar` が敷く)。別々に書いていた頃は、画面ごとに敷き方も
   * 押されている表現も違っていた。
   *
   * **`aria-pressed` は切り替えのボタンにだけ付ける** (`on` を渡したとき)。いつも
   * 付けていた頃は、閉じる・切り抜き・全画面まで「切り替え (いまはオフ)」と読まれていた。
   * 押すと役目が変わるもの (再生/一時停止・音) は名前のほうで言うので、`on` は渡さない。
   *
   * **名前は `title` にも出す。** アイコンだけのボタンなので、PC でマウスを重ねたときに
   * 何のボタンか読めるように (アイコン中心はそのまま。指の端末では出ない)
   *
   * 文字を添えるときは中身 (`children`) を渡す。**丸くなくなる** (速めている間の速さ「1.25」)
   */
  let {
    icon,
    label,
    on,
    danger = false,
    submit = false,
    testid,
    onclick,
    children,
    menu,
  }: {
    /** アイコン (`icons.ts`)。文字だけのボタンでは省く (`undefined` を渡しても同じ) */
    icon?: IconShape | undefined;
    /** 読み上げに出す名前。押すと役目が変わるものは、いまの役目を書く */
    label: string;
    /**
     * 切り替えのボタンなら、いま入っているか (字幕を出しているときなど)。
     * **渡したときだけ `aria-pressed` を付ける** — 押すだけのボタン (閉じる・切り抜き) には渡さない
     */
    on?: boolean | undefined;
    /** 押すと戻せないもの。**聞き返しの2回目**に立てる (`icons.ts` の `OVERLAY_DANGER`) */
    danger?: boolean;
    /** 中の `<form>` を送るボタンにする (削除など) */
    submit?: boolean;
    testid?: string | undefined;
    onclick?: () => void;
    /** 添える文字。渡すと丸くなくなる (`undefined` は渡さないのと同じ。速さは等速のときだけ省く) */
    children?: import("svelte").Snippet | undefined;
    /** メニューの引き金にするときに `Menu` から受け取る属性 (`OverlayMenu`・`SettingsMenu`)。そのまま広げる */
    menu?: import("../Menu.svelte").MenuTrigger | undefined;
  } = $props();
</script>

<button
  type={submit ? "submit" : "button"}
  class="{OVERLAY_BTN} {children === undefined ? OVERLAY_ROUND : ''} {on
    ? OVERLAY_ON
    : danger
      ? OVERLAY_DANGER
      : OVERLAY}"
  {onclick}
  aria-label={label}
  aria-pressed={on}
  title={label}
  data-testid={testid}
  {...menu}
>
  {#if icon !== undefined}
    <Icon {icon} />
  {/if}
  {@render children?.()}
</button>

<style>
  /*
     * **映像の上に置くボタンの見た目は、ここ1箇所** (`icons.ts` の OVERLAY*)。
     * 3画面とも ControlButton を読み込むので、`:global` にしておけば
     * `<a>` (閉じる) や EdgeButton にも届く。
     *
     * Pico はボタンの色を変数 (`--pico-background-color` など) で持つので、変数を差し替える。
     * Pico は層 (`@layer blades`) の中なので、`:hover` などで主の色に戻されることはない。
     *
     * **ボタンは塗らない** (docs/design.md)。明るい映像の上でも読めるよう、**並び全体の裏に影を敷く**
     * (下の操作バーと右の列。`ControlBar`)。アイコンと字にも小さな影を付け、影の端に掛かっても読めるようにする。
     * 指を乗せた・キーボードで触っているボタンだけ、ごく薄い地で示す
     */
  :global(.ov-btn) {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    height: 3rem;
    min-height: 3rem;
    margin: 0;
    padding: 0 1.25rem;
    border: 0;
    border-radius: var(--dp-btn-radius);
    box-shadow: none;
    font-size: var(--dp-text-lg);
    line-height: 1;
    text-decoration: none;
    white-space: nowrap;
    flex-shrink: 0;
    background-color: var(--pico-background-color);
    color: var(--pico-color);
  }
  :global(.ov-btn.ov-round) {
    width: 3rem;
    padding: 0;
  }
  /*
     * **狭い枠 (スマホの縦) では 40px。** 48px のままだと、毎回使うものだけに
     * 絞っても 360px 幅の端末で一段に収まらない。指で押す的として 40px は割らない。
     * 文字のボタン (速さの数字など) は左右の余白も詰める
     * (舞台の `data-compact`。決め方は `PlayerStage`)
     */
  :global(.stage[data-compact] .ov-btn) {
    height: 2.5rem;
    min-height: 2.5rem;
    padding: 0 0.5rem;
    font-size: var(--dp-text-base);
  }
  :global(.stage[data-compact] .ov-btn.ov-round) {
    width: 2.5rem;
    padding: 0;
  }
  /* `.ov` だけで使うものもある (ライブの「音を出す」。そちらは自分で地を敷く) */
  :global(.ov),
  :global(.ov-btn) {
    --pico-background-color: transparent;
    --pico-border-color: transparent;
    --pico-color: #fff;
    --pico-box-shadow: none;
    filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.6));
  }
  :global(.ov-btn:is(:hover, :focus-visible)) {
    --pico-background-color: rgb(255 255 255 / 0.14);
  }
  /*
     * **オン (字幕を出している・速めているなど) は空色のアイコンと、下の短い線。** 塗らない。
     * 戻せないものの 2 回目 (削除の確認) と、「今」へ張り付いている「ライブ」「最新」は赤い字と赤い短い線。
     * どちらも暗い影の上で 4.5:1 以上になる明るさにしてある
     */
  :global(.ov-btn.ov-on) {
    --pico-color: #7dd3fc;
  }
  :global(.ov-btn.ov-danger) {
    --pico-color: #ff8a7a;
  }
  :global(.ov-btn:is(.ov-on, .ov-danger))::after {
    content: "";
    position: absolute;
    left: 50%;
    bottom: 0.3rem;
    width: 1rem;
    height: 2px;
    border-radius: 1px;
    background: currentColor;
    transform: translateX(-50%);
  }
  /* 透かしを減らす設定では、乗せたときの地も透かさない (並びの裏の影は `ControlBar` が透かさない地にする) */
  @media (prefers-reduced-transparency: reduce) {
    :global(.ov-btn:is(:hover, :focus-visible)) {
      --pico-background-color: #26282e;
    }
  }
</style>
