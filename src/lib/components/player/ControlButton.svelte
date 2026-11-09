<script lang="ts">
  import Icon from "./Icon.svelte";
  import {
    type IconShape,
    OVERLAY,
    OVERLAY_BTN,
    OVERLAY_DANGER,
    OVERLAY_ROUND,
  } from "./icons";

  /**
   * 映像の上に置くボタン (3 画面で同じ)。押されている間の色と `aria-pressed` はここ 1 箇所。
   * `aria-pressed` は切り替えのボタン (`on` を渡したとき) にだけ付ける。押すと役目が変わるもの (再生/一時停止・音) は
   * 名前のほうで言う。名前は `title` にも出す (PC でマウスを重ねたときに読める)。文字を添えると丸くなくなる
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
     * **渡したときだけ `aria-pressed` を付ける**。押すだけのボタン (閉じる・切り抜き) には渡さない
     */
    on?: boolean | undefined;
    /** 押すと戻せないもの。**戻せない操作の 2 回目**に立てる (`icons.ts` の `OVERLAY_DANGER`) */
    danger?: boolean;
    /** 中の `<form>` を送るボタンにする (削除など) */
    submit?: boolean;
    testid?: string | undefined;
    onclick?: () => void;
    /** 添える文字。渡すと丸くなくなる (`undefined` は渡さないのと同じ。速さは等速のときだけ省く) */
    children?: import("svelte").Snippet | undefined;
    /** メニューの引き金にするときに `Menu` から受け取る属性 (`SpeedMenu`・`SettingsMenu`)。そのまま広げる */
    menu?: import("../Menu.svelte").MenuTrigger | undefined;
  } = $props();
</script>

<button
  type={submit ? "submit" : "button"}
  class="{OVERLAY_BTN} {children === undefined ? OVERLAY_ROUND : ''} {danger
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
   * 映像の上に置くボタンの見た目はここ 1 箇所 (`icons.ts` の OVERLAY*。`:global` なので `<a>` や EdgeButton にも届く)。
   * Pico の色の変数を差し替える。ボタンは塗らず (docs/design.md)、アイコンと字に小さな影を付ける。
   * 指を乗せた・キーボードで触っているボタンだけ、ごく薄い地で示す。
   * 文字のボタン (速さの数字・EdgeButton) の左右の余白は 12px、狭い枠では 8px
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
    padding: 0 var(--dp-space-3);
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
  /* 狭い枠 (`data-compact`) では 40px (指で押せる大きさはこれより小さくしない)。文字のボタンは左右の余白も詰める */
  :global(.stage[data-compact] .ov-btn) {
    height: 2.5rem;
    min-height: 2.5rem;
    padding: 0 var(--dp-space-2);
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
    --pico-color: var(--dp-on-video);
    --pico-box-shadow: none;
    filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.6));
  }
  :global(.ov-btn:is(:hover, :focus-visible)) {
    --pico-background-color: var(--dp-on-video-hover);
  }
  /*
   * オン (`aria-pressed="true"`) は空色のアイコンと下の短い線。線はほかの所と同じ「入っている切り替え」の 1 本 (`app.css`) で、
   * 色だけ字に合わせる。戻せないものの 2 回目と「今」に張り付いた「ライブ」「最新」は赤 (塗らない)
   */
  :global(.ov-btn[aria-pressed="true"]) {
    --pico-color: var(--dp-on-video-on);
    --dp-on-mark: currentColor;
  }
  :global(.ov-btn.ov-danger) {
    --pico-color: var(--dp-on-video-danger);
    --dp-on-mark: currentColor;
  }
  /* 透かしを減らす設定では、乗せたときの地も透かさない (並びの裏の影は `ControlBar` が濃くする) */
  @media (prefers-reduced-transparency: reduce) {
    :global(.ov-btn:is(:hover, :focus-visible)) {
      --pico-background-color: color-mix(
        in srgb,
        var(--dp-on-video) 14%,
        var(--dp-video-panel)
      );
    }
  }
</style>
