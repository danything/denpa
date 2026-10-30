<script lang="ts">
  import { onMount } from "svelte";

  import {
    COLOR_VALUES,
    POSITIONS,
    POST_COLORS,
    type PostColor,
    type PostStyle,
    readPostStyle,
    SIZES,
  } from "#lib/jikkyo/command.js";
  import type { JikkyoFeed } from "#lib/jikkyo/feed.svelte.js";
  import {
    caughtUp,
    graphemes,
    MAX_LENGTH,
    refusal,
    SHOW_LEFT,
    spacing,
  } from "#lib/jikkyo/post.js";
  import { read, write } from "#lib/keep.js";

  import Icon from "./Icon.svelte";
  import { CLOSE, PALETTE } from "./icons";

  /**
   * **NX-Jikkyo に書き込む 1 行** (ライブだけ。決まりは docs/watch.md の「実況に書き込む」、送り方は `nx.ts`)。
   *
   * - 「NX-Jikkyo に書きます」・入力欄・色などを選ぶボタン・「送る」・✕ を 1 つのカプセルに並べる。書けないときと失敗したときは、
   *   頭の字をその理由 1 行に替える (トーストは出さない)
   * - Enter で送る (変換中は送らない)。Esc か ✕ で閉じる。送れたら欄を空にし、失敗したら残す。自動で送り直さない
   * - 色・位置・大きさは、パレットのボタンで開く選択の行で選ぶ。端末ごとに覚える (`JIKKYO_STYLE_KEY`)
   * - 置き場は画面が決める。映像の上 (操作バーのすぐ上) か、スマホの形の下のタブのすぐ上 (`docked`。ソフトキーボードが
   *   出たら `visualViewport` に合わせて上へ)
   */
  interface Props {
    feed: JikkyoFeed;
    /** いま映しているコマの放送時刻 (送れたものを置く所) */
    air: () => number | null;
    /** 放送からの遅れ (秒)。分からなければ null */
    lag: number | null;
    paused: boolean;
    /** 下のタブのすぐ上に置く (スマホの形) */
    docked: boolean;
    onclose: () => void;
  }
  let { feed, air, lag, paused, docked, onclose }: Props = $props();

  /** 色・位置・大きさを覚えておく鍵 (端末ごと。頭の `player-` は画面をまたいで効くもの) */
  const JIKKYO_STYLE_KEY = "player-jikkyo-style";

  const COLOR_NAMES: Record<PostColor, string> = {
    white: "白",
    red: "赤",
    pink: "ピンク",
    orange: "オレンジ",
    yellow: "黄",
    green: "緑",
    cyan: "水色",
    blue: "青",
  };
  const POSITION_NAMES = { ue: "上", naka: "流れる", shita: "下" } as const;
  const SIZE_NAMES = { big: "大", medium: "中", small: "小" } as const;
  /** 頭の 1 行のいつもの表示と、書けない理由 (何か所かで出す) */
  const IDLE = "NX-Jikkyo に書きます";
  const BEHIND = "ライブに戻ると書けます";
  const CLOSED = "(いまは書けません)";

  let text = $state("");
  let busy = $state(false);
  /** 送った結果・送れなかった理由。打ち直したら消す */
  let note = $state("");
  /** 読み上げに 1 回だけ伝える (送れた・失敗した) */
  let told = $state("");
  let picking = $state(false);
  let style = $state<PostStyle>(readPostStyle(null));
  /** 繋がっているかは $state ではないので、0.25 秒おきに読み直す */
  let ready = $state(false);
  let input = $state<HTMLInputElement | null>(null);
  /** ソフトキーボードのぶん持ち上げる高さ (px。`docked` のときだけ) */
  let lift = $state(0);

  onMount(() => {
    style = readPostStyle(read(JIKKYO_STYLE_KEY));
    input?.focus();
    const timer = setInterval(() => (ready = feed.writable), 250);
    ready = feed.writable;
    return () => clearInterval(timer);
  });

  $effect(() => {
    const view = window.visualViewport;
    if (!docked || view === null) {
      lift = 0;
      return;
    }
    const measure = () => {
      lift = Math.max(0, window.innerHeight - view.height - view.offsetTop);
    };
    measure();
    view.addEventListener("resize", measure);
    view.addEventListener("scroll", measure);
    return () => {
      view.removeEventListener("resize", measure);
      view.removeEventListener("scroll", measure);
    };
  });

  const caught = $derived(caughtUp(lag, paused));
  const why = $derived(refusal(text));
  const left = $derived(MAX_LENGTH - graphemes(text.trim()));
  /** 頭の 1 行。結果 → 書けない理由 → 中身の断り → いつもの表示 の順 */
  const line = $derived(
    note !== ""
      ? note
      : !caught
        ? BEHIND
        : !ready && !busy
          ? CLOSED
          : why !== null && why !== ""
            ? why
            : IDLE,
  );
  const warn = $derived(line !== IDLE);

  function choose(next: Partial<PostStyle>): void {
    style = { ...style, ...next };
    write(JIKKYO_STYLE_KEY, JSON.stringify(style));
  }

  function tell(message: string): void {
    note = message;
    told = message;
  }

  async function send(): Promise<void> {
    if (busy) return;
    const body = text.trim();
    const refused = refusal(text);
    if (refused !== null) {
      if (refused !== "") tell(refused);
      return;
    }
    if (!caught) return tell(BEHIND);
    const now = Date.now();
    if (spacing.left(now) > 0) return tell("3 秒待ってください");
    if (!feed.writable) return tell(CLOSED);
    spacing.mark(now);
    busy = true;
    note = "";
    const result = await feed.post(body, $state.snapshot(style), air);
    busy = false;
    switch (result) {
      case "sent":
        text = "";
        note = "";
        told = `書き込みました: ${body}`;
        break;
      case "unknown":
        tell("送れたか分かりません");
        break;
      case "not-on-air":
        tell("スレッドが替わりました。もう一度送ってください");
        break;
      case "rejected":
        tell("この書き込みは受け付けられませんでした");
        break;
      case "closed":
        tell(CLOSED);
        break;
    }
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onclose();
      return;
    }
    if (event.target !== input || event.key !== "Enter") return;
    // 変換を決めた Enter では送らない (Safari は isComposing を落とすので keyCode 229 も見る)
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void send();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="compose"
  class:docked
  style:--lift="{lift}px"
  data-testid="jikkyo-compose"
  {onkeydown}
>
  {#if picking}
    <!-- 色・位置・大きさ。メニューと同じ形 (塗らずに、選んでいるものは空色の太字と短い線) -->
    <div class="pick" data-testid="jikkyo-style">
      <div role="group" aria-label="色" class="choices">
        {#each POST_COLORS as color (color)}
          <button
            type="button"
            class="choice swatch"
            aria-label={COLOR_NAMES[color]}
            title={COLOR_NAMES[color]}
            aria-pressed={style.color === color}
            onclick={() => choose({ color })}
            data-testid="jikkyo-color-{color}"
            ><span class="dot" style:background={COLOR_VALUES[color]}
            ></span></button
          >
        {/each}
      </div>
      <div role="group" aria-label="位置" class="choices">
        {#each POSITIONS as position (position)}
          <button
            type="button"
            class="choice"
            aria-pressed={style.position === position}
            onclick={() => choose({ position })}
            data-testid="jikkyo-position-{position}"
            >{POSITION_NAMES[position]}</button
          >
        {/each}
      </div>
      <div role="group" aria-label="大きさ" class="choices">
        {#each SIZES as size (size)}
          <button
            type="button"
            class="choice"
            aria-pressed={style.size === size}
            onclick={() => choose({ size })}
            data-testid="jikkyo-size-{size}">{SIZE_NAMES[size]}</button
          >
        {/each}
      </div>
    </div>
  {/if}
  <div class="row">
    <label
      class="line"
      class:warn
      for="jikkyo-compose-input"
      data-testid="jikkyo-compose-line">{line}</label
    >
    <input
      bind:this={input}
      bind:value={text}
      id="jikkyo-compose-input"
      type="text"
      enterkeyhint="send"
      autocomplete="off"
      spellcheck="false"
      placeholder="コメント"
      aria-label="コメント"
      oninput={() => (note = "")}
      data-testid="jikkyo-compose-input"
    />
    {#if left < SHOW_LEFT}
      <span class="left" class:over={left < 0} data-testid="jikkyo-compose-left"
        >{left}</span
      >
    {/if}
    <button
      type="button"
      class="icon"
      aria-label="色・位置・大きさ"
      title="色・位置・大きさ"
      aria-expanded={picking}
      onclick={() => (picking = !picking)}
      data-testid="jikkyo-style-button"
      ><span class="tint" style:color={COLOR_VALUES[style.color]}
        ><Icon icon={PALETTE} size="size-5" /></span
      ></button
    >
    <button
      type="button"
      class="send"
      disabled={busy || why !== null}
      onclick={() => void send()}
      data-testid="jikkyo-compose-send">送る</button
    >
    <button
      type="button"
      class="icon"
      aria-label="閉じる"
      title="閉じる"
      onclick={onclose}
      data-testid="jikkyo-compose-close"
      ><Icon icon={CLOSE} size="size-5" /></button
    >
  </div>
  <span class="visually-hidden" role="status" aria-live="polite">{told}</span>
</div>

<style>
  /*
   * 操作の層のカプセル。映像の上ではメニューと同じ暗い面 (テーマで変えない)、下のタブの上 (`docked`) では
   * ページの操作の層の面。色はこの中の変数だけで替える
   */
  .compose {
    --c-fg: var(--dp-on-video);
    --c-muted: var(--dp-on-video-muted);
    --c-on: var(--dp-on-video-on);
    --c-hover: var(--dp-on-video-hover);
    --c-face: var(--dp-video-menu);
    --c-field: rgb(255 255 255 / 0.12);
    --c-shadow: 0 2px 6px rgb(0 0 0 / 0.35), 0 18px 40px rgb(0 0 0 / 0.45);
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-bottom: 0.5rem;
    color: var(--c-fg);
  }
  .compose.docked {
    --c-fg: var(--pico-color);
    --c-muted: var(--dp-muted);
    --c-on: var(--dp-primary-text);
    --c-hover: var(--dp-hover);
    --c-face: var(--dp-float);
    --c-field: var(--dp-field);
    --c-shadow: var(--dp-shadow-pop);
    position: fixed;
    inset-inline: 0.75rem;
    bottom: max(
      calc(var(--dp-tabbar, 0px) + 0.375rem),
      calc(var(--lift) + 0.375rem)
    );
    z-index: 30;
    margin: 0;
  }
  @media (prefers-reduced-transparency: reduce) {
    .compose:not(.docked) {
      --c-face: var(--dp-video-panel);
    }
  }
  .row,
  .pick {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.25rem 0.25rem 0.75rem;
    border-radius: var(--dp-radius-full);
    background: var(--c-face);
    box-shadow: var(--c-shadow);
  }
  .pick {
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.5rem;
    border-radius: var(--dp-radius-lg);
  }
  .line {
    flex-shrink: 1;
    min-width: 0;
    max-width: 40%;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--dp-text-xs);
    color: var(--c-muted);
  }
  .line.warn {
    color: var(--c-fg);
    font-weight: var(--dp-weight-bold);
  }
  input {
    flex: 1;
    min-width: 6rem;
    height: 2.5rem;
    margin: 0;
    padding: 0 0.75rem;
    border: 0;
    border-radius: var(--dp-radius-full);
    background: var(--c-field);
    color: var(--c-fg);
    font-size: var(--dp-text-base);
    box-shadow: none;
  }
  input::placeholder {
    color: var(--c-muted);
  }
  input:focus-visible {
    outline: 2px solid var(--c-on);
    outline-offset: 0;
  }
  .left {
    font-size: var(--dp-text-xs);
    font-variant-numeric: tabular-nums;
    color: var(--c-muted);
  }
  .left.over {
    color: var(--c-fg);
    font-weight: var(--dp-weight-bold);
  }
  button {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: auto;
    height: 2.5rem;
    min-width: 2.5rem;
    margin: 0;
    padding: 0 0.75rem;
    border: 0;
    border-radius: var(--dp-radius-full);
    background: transparent;
    box-shadow: none;
    color: var(--c-fg);
    font-size: var(--dp-text-sm);
    white-space: nowrap;
  }
  button.icon {
    padding: 0;
  }
  button:is(:hover, :focus-visible):not(:disabled) {
    background: var(--c-hover);
  }
  button:disabled {
    opacity: 0.5;
  }
  .send {
    font-weight: var(--dp-weight-bold);
  }
  .tint {
    display: inline-flex;
    filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.6));
  }
  .choices {
    display: flex;
    gap: 0.125rem;
  }
  /* 選んでいるものは空色 (ページの上では主の色) の太字と、下の短い線。塗らない */
  .choice[aria-pressed="true"] {
    color: var(--c-on);
    font-weight: var(--dp-weight-bold);
    background-image: none;
  }
  .choice[aria-pressed="true"]::after {
    content: "";
    position: absolute;
    left: 50%;
    bottom: 0.125rem;
    width: 1rem;
    height: 2px;
    border-radius: 1px;
    background: var(--c-on);
    translate: -50% 0;
  }
  .swatch {
    padding: 0;
  }
  .dot {
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgb(0 0 0 / 0.5);
  }
</style>
