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
   * - Enter で送る (変換中は送らない)。Esc か ✕ で閉じる (一覧の下では一覧ごとしまう)。送れたら欄を空にし、失敗したら残す。自動で送り直さない
   * - 色・位置・大きさは、パレットのボタンで開く選択の行で選ぶ。端末ごとに覚える (`JIKKYO_STYLE_KEY`)
   * - 置き場は画面が決める。ふだんはコメントの一覧の下 (`panel`。一覧の中なので面も影も付けず、頭の字は入力欄の上の行に。
   *   ✕ は置かない。しまうのは一覧のボタン)。一覧を出せない形 (横にしたスマホ・全画面) では映像の上、操作バーのすぐ上
   */
  interface Props {
    feed: JikkyoFeed;
    /** いま映しているコマの放送時刻 (送れたものを置く所) */
    air: () => number | null;
    /** 放送からの遅れ (秒)。分からなければ null */
    lag: number | null;
    paused: boolean;
    /** コメントの一覧の下に置く (ほかは映像の上) */
    panel: boolean;
    /** 出たら入力欄にフォーカスを移す (押して開いたとき。覚えていた一覧を開き直したときは移さない) */
    focus: boolean;
    /** 書きかけ。画面が持つ (列を入れ替えて描き直しても消えない) */
    text: string;
    onclose: () => void;
  }
  let {
    feed,
    air,
    lag,
    paused,
    panel,
    focus,
    text = $bindable(),
    onclose,
  }: Props = $props();

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

  onMount(() => {
    style = readPostStyle(read(JIKKYO_STYLE_KEY));
    if (focus) input?.focus();
    const timer = setInterval(() => (ready = feed.writable), 250);
    ready = feed.writable;
    return () => clearInterval(timer);
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
  class:in-list={panel}
  data-testid="jikkyo-compose"
  {onkeydown}
>
  {#if picking}
    <!--
      色・位置・大きさ。どれも種別のタブと同じ並び (`app.css` の `.segmented`。塗らずに、選んでいるものは主の色の太字と下線。
      選び直すと下線が滑る)。映像の上では主の色を空色に替える
    -->
    <div class="pick" data-testid="jikkyo-style">
      <div role="group" aria-label="色" class="choices colors segmented">
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
      <div role="group" aria-label="位置" class="choices segmented">
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
      <div role="group" aria-label="大きさ" class="choices segmented">
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
    {#if !panel}
      <button
        type="button"
        class="icon"
        aria-label="閉じる"
        title="閉じる"
        onclick={onclose}
        data-testid="jikkyo-compose-close"
        ><Icon icon={CLOSE} size="size-5" /></button
      >
    {/if}
  </div>
  <span class="visually-hidden" role="status" aria-live="polite">{told}</span>
</div>

<style>
  /*
   * 映像の上では操作の層のカプセル (メニューと同じ暗い面。テーマで変えない)。コメントの一覧の下 (`panel`) では
   * 一覧の中身の続きなので、面も影も付けずページの色で描く。色はこの中の変数だけで替える
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
  .compose.in-list {
    --c-fg: var(--pico-color);
    --c-muted: var(--dp-muted);
    --c-on: var(--dp-primary-text);
    --c-hover: var(--dp-hover);
    --c-face: transparent;
    --c-field: var(--dp-field);
    --c-shadow: none;
    /* 選ぶ行と頭の字の間も、選ぶ行のまとまりの間と同じくらい空ける (詰めると選ぶ行の続きに見えた) */
    gap: var(--dp-space-3);
    margin: var(--dp-space-2) 0 0;
  }
  @media (prefers-reduced-transparency: reduce) {
    .compose:not(.in-list) {
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
  /*
   * 色の 8 つは 1 行に並べ、入りきらない幅 (一覧の下の列) では 4 つずつ 2 行にそろえる (6 と 2 に崩さない)。
   * 位置と大きさはその下の 1 行。まとまりの間はどれも同じ余白
   */
  .pick {
    container-type: inline-size;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--dp-space-3) var(--dp-space-4);
    padding: var(--dp-space-2);
    border-radius: var(--dp-radius-lg);
  }
  /* 選んでいる印 (`.segmented`) の色。映像の上はボタンのオンと同じ空色 (一覧の下はページの色のまま) */
  .compose:not(.in-list) .pick {
    --pico-primary: var(--c-on);
    --dp-primary-text: var(--c-on);
    --dp-hover-soft: var(--c-hover);
    --pico-secondary: var(--c-fg);
    --pico-secondary-hover: var(--c-fg);
  }
  .pick .colors {
    display: grid;
    grid-template-columns: repeat(8, 2.5rem);
    flex-basis: 100%;
    justify-content: center;
  }
  /* 8 つ (2.5rem と間 2px) が入らない幅 */
  @container (width < 21rem) {
    .pick .colors {
      grid-template-columns: repeat(4, 2.5rem);
    }
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
  /* 一覧の下は列の幅しか無いので、頭の字を 1 行目に、入力欄と押すものを 2 行目に置く */
  .in-list .row {
    flex-wrap: wrap;
    padding: 0;
  }
  .in-list .line {
    flex-basis: 100%;
    max-width: none;
  }
  .in-list .pick {
    justify-content: flex-start;
    padding: 0;
  }
  .in-list .pick .colors {
    justify-content: start;
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
  /* 選択肢 (`.choice`) の地と字は `.segmented` が決める (指を乗せたらごく薄い地) */
  button:not(.choice):is(:hover, :focus-visible):not(:disabled) {
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
  .choice {
    background: var(--pico-background-color);
    color: var(--pico-color);
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
