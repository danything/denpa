<script lang="ts">
  import { clampLevel, LEVEL_STEP, MAX_LEVEL, stepLevel } from "#lib/volume.js";

  import Icon from "./Icon.svelte";
  import { SOUND_LOW, SOUND_OFF, SOUND_ON } from "./icons";

  /**
   * 音量のつまみ。**音のボタンの上に浮かぶ縦のもの (`SoundButton`) と ⚙ の横のもの (`SettingsMenu`) で同じ姿。**
   *
   * 太いカプセル全体がつまみで、入れたぶんを下 (横なら左) から落ち着かせた主の色 (`--dp-video-fill`) で塗る。細い溝と丸は無い。
   * 中の端にスピーカーのアイコンを置き、音量で替える (0% は消した形・半分より下は波1本・それより上は波2本)。
   * 値 (%) は**変えている間だけ** 反対の端に出し、止めて少し経ったら消す。読み上げには `aria-valuetext` でいつも渡す。
   *
   * - 押すのはカプセルの全体。押した所へすぐ飛び、つまんだまま動かせる (指でも。iOS の range は丸しかつまめないので、
   *   入力欄には指とマウスを受けさせず、ここで受ける。`SeekBar` と同じ)
   * - キーボードと読み上げは見えない `<input type="range">` が受け持つ (↑↓←→・PageUp/PageDown・Home/End)
   * - キーとホイールで変えたときは塗りが短く動いて追いつき、つまんでいる間は指にそのまま付いてくる
   */
  let {
    level,
    set,
    vertical = false,
    label = false,
    wheel = false,
    item = false,
    testid,
    ondrag,
  }: {
    /** いまの音量 (%) */
    level: number;
    set: (level: number) => void;
    /** 縦に置く (下が 0%)。省くと横 (左が 0%) */
    vertical?: boolean;
    /** アイコンの隣に「音量」の名前を出す (⚙ の行。ほかの行と同じ並び) */
    label?: boolean;
    /** ホイールでも変える (上へ回すと大きく) */
    wheel?: boolean;
    /** メニューの項目にする (`menu-item`。↑↓ で行を移る先になり、押しても閉じない) */
    item?: boolean;
    testid: string;
    /** つまみ始めた・離した */
    ondrag?: (active: boolean) => void;
  } = $props();

  /** 止めてから値を消すまで (ms) */
  const SHOW_FOR = 1_000;

  let root = $state<HTMLElement | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  /** つまんでいる指 (マウス) の `pointerId` */
  let pointer = $state<number | null>(null);
  /** 値を出している間 */
  let changing = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const icon = $derived(
    level === 0 ? SOUND_OFF : level < MAX_LEVEL / 2 ? SOUND_LOW : SOUND_ON,
  );

  $effect(() => () => {
    if (timer !== null) clearTimeout(timer);
  });

  /** 値を出し、止めて `SHOW_FOR` 経ったら消す (つまんでいる間は消さない) */
  function flash(): void {
    changing = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pointer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      changing = false;
    }, SHOW_FOR);
  }

  function change(next: number): void {
    const to = clampLevel(next);
    flash();
    if (to !== level) set(to);
  }

  /** 指 (マウス) の下の音量。刻みの目に乗せる (入力欄の `step` と同じ) */
  function under(event: PointerEvent): number {
    const rect = root!.getBoundingClientRect();
    const ratio = vertical
      ? (rect.bottom - event.clientY) / rect.height
      : (event.clientX - rect.left) / rect.width;
    const at = Math.min(1, Math.max(0, ratio)) * MAX_LEVEL;
    return Math.round(at / LEVEL_STEP) * LEVEL_STEP;
  }

  function down(event: PointerEvent): void {
    // 2本目の指は受けない (1本目の離したのを取りこぼさないように)
    if (event.button !== 0 || root === null || pointer !== null) return;
    // 押した所へすぐ。文字選び・ページの送り・既定のフォーカスは起こさない
    event.preventDefault();
    root.setPointerCapture(event.pointerId);
    pointer = event.pointerId;
    input?.focus({ preventScroll: true });
    ondrag?.(true);
    change(under(event));
  }

  function move(event: PointerEvent): void {
    if (event.pointerId === pointer) change(under(event));
  }

  /** 離した・取り上げられた (`pointercancel`)。どちらでも終える (残るとつまんだままになる) */
  function up(event: PointerEvent): void {
    if (event.pointerId !== pointer) return;
    pointer = null;
    flash();
    ondrag?.(false);
  }

  function onwheel(event: WheelEvent): void {
    if (!wheel || event.deltaY === 0) return;
    event.preventDefault();
    change(stepLevel(level, event.deltaY < 0 ? 1 : -1));
  }
</script>

<!-- 押すのはカプセルの全体。キーボードは入力欄が受け持つ -->
<!-- svelte-ignore a11y_no_static_element_interactions -- 役割は中の入力欄 (range) が持つ。ここは指とマウスを受けるだけ -->
<div
  class="volume-slider"
  bind:this={root}
  data-vertical={vertical ? "" : undefined}
  data-dragging={pointer !== null ? "" : undefined}
  data-changing={changing ? "" : undefined}
  style:--level={level / MAX_LEVEL}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  {onwheel}
>
  <div class="capsule" aria-hidden="true">
    <div class="fill"></div>
    <span class="icon"><Icon {icon} size="size-5" /></span>
    {#if label}<span class="name">音量</span>{/if}
    <span class="value num">{level}%</span>
  </div>
  <input
    bind:this={input}
    type="range"
    class:menu-item={item}
    min="0"
    max={MAX_LEVEL}
    step={LEVEL_STEP}
    value={level}
    aria-label="音量"
    aria-valuetext="{level}%"
    aria-orientation={vertical ? "vertical" : "horizontal"}
    data-keep-open={item ? "" : undefined}
    data-testid={testid}
    oninput={(event) => change(Number(event.currentTarget.value))}
  />
</div>

<style>
  /*
     * カプセルは丸く閉じ (`--dp-radius-full`)、入れたぶんの塗りは中で切り取る。色は再生位置のバー (`SeekBar`) と
     * 同じく落ち着かせた主の色 (`--dp-video-fill`。docs/design.md の「映像の上の操作」)。アイコンと字は白に小さな影 (塗りの上でも、空の所でも読める)。
     * 的は縦なら幅、横なら高さ 44px (`--hit`)。縦のカプセルは少し細く見せ、的だけ左右へ広げる。
     * `touch-action` — 横のもの (⚙。指の端末) は縦にはメニューを送れるようにし、縦のものはページを動かさない
     */
  .volume-slider {
    --hit: 2.75rem;
    position: relative;
    display: flex;
    justify-content: center;
    width: 100%;
    height: var(--hit);
    cursor: pointer;
    touch-action: pan-y;
    user-select: none;
    -webkit-user-select: none;
  }
  .volume-slider[data-vertical] {
    width: var(--hit);
    height: 7.5rem;
    touch-action: none;
  }
  .capsule {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    height: 100%;
    padding: 0 0.75rem;
    overflow: hidden;
    border-radius: var(--dp-radius-full);
    /*
       * 空の所。⚙ の中ではメニューの面を黒で沈め (塗りと 3:1 以上)、浮かべるときは映像の上の面 (`SoundButton` が渡す)
       */
    background: var(--volume-empty, color-mix(in srgb, #000 40%, transparent));
    box-shadow: var(--volume-shadow, none);
    color: var(--dp-on-video);
  }
  [data-vertical] .capsule {
    flex-direction: column-reverse;
    justify-content: space-between;
    width: 2.5rem;
    padding: 0.75rem 0;
  }
  /*
     * 塗りは全体の大きさのまま、`scale` で入れたぶんだけ見せる (描き直さずに動かせる)。
     * キーとホイールでは短く動いて追いつき、つまんでいる間は動かさずにそのまま付いてくる
     */
  .fill {
    position: absolute;
    inset: 0;
    background: var(--dp-video-fill);
    transform: scaleX(var(--level));
    transform-origin: left center;
    transition: transform var(--dp-duration) var(--dp-ease);
  }
  [data-vertical] .fill {
    transform: scaleY(var(--level));
    transform-origin: center bottom;
  }
  [data-dragging] .fill {
    transition: none;
  }
  .icon,
  .name,
  .value {
    position: relative;
    filter: drop-shadow(0 0 2px rgb(0 0 0 / 0.5));
  }
  .icon {
    display: flex;
  }
  .name {
    flex: 1 1 auto;
    white-space: nowrap;
  }
  /* 値は変えている間だけ。出すときはすぐ、消すときは短く薄れる */
  .value {
    margin-inline-start: auto;
    font-size: var(--dp-text-xs);
    line-height: 1;
    opacity: 0;
    transition: opacity var(--dp-duration-exit) var(--dp-ease-exit);
  }
  [data-vertical] .value {
    margin: 0;
  }
  [data-changing] .value {
    opacity: 1;
    transition: opacity var(--dp-duration) var(--dp-ease);
  }
  .volume-slider:has(input:focus-visible) .capsule {
    outline: 2px solid var(--pico-primary);
    outline-offset: 2px;
  }
  /*
     * 入力欄はカプセルの上に重ねて透かす。**指とマウスは受けない** (つまむのは外側が受け持つ)。
     * 2つのブラウザの擬似要素は1つの規則にまとめられない (知らないほうが規則ごと捨てる)
     */
  input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    opacity: 0;
    pointer-events: none;
    appearance: none;
    background: transparent;
  }
  [data-vertical] input {
    writing-mode: vertical-lr;
    direction: rtl;
  }
  input:focus {
    background: transparent;
    box-shadow: none;
  }
  input::-webkit-slider-thumb {
    appearance: none;
    width: 1px;
    height: 1px;
    border: 0;
  }
  input::-moz-range-thumb {
    width: 1px;
    height: 1px;
    border: 0;
  }
</style>
