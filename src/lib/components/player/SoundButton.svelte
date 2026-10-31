<script module lang="ts">
  /**
   * つまみを浮かべる端末。指の端末の「乗せた」は押した後にしか来ないので、浮かべない。
   * ⚙ に音量のつまみを置くかもこれで決める (`StageTail`)
   */
  export const POINTER = "(hover: hover) and (pointer: fine)";
</script>

<script lang="ts">
  import { LEVEL_STEP, MAX_LEVEL, stepLevel } from "#lib/volume.js";

  import ControlButton from "./ControlButton.svelte";
  import { stageMenu } from "./controls.svelte";
  import { SOUND_OFF, SOUND_ON } from "./icons";

  /**
   * 操作バーの音のボタン (3画面で同じ)。押すと消音の切り替え。
   *
   * **マウスで指せる端末では、乗せるとボタンの真上に縦の音量のつまみが浮かぶ** (動画サイトでよくある形)。
   * キーボードでボタンに来たときも開く。つまみの上ではホイールでも変えられる。外れたら少し待ってから閉じる
   * (ボタンからつまみへ斜めに動かしたときに、角で閉じないように)。開いている間は操作バーを残す (`stageMenu`)。
   *
   * 指の端末 (ホバーが無い) では浮かばない。⚙ のつまみ (`SettingsMenu`) を使う。**音量のつまみは画面に1つだけ** —
   * ⚙ のつまみは、このボタンがつまみを出せないときだけ出す (`StageTail`)。指の端末と、畳むとき (狭い枠か、
   * 一段に収まらないとき。このボタンごと ⚙ に入る) がそれ。
   *
   * testid: ボタンは `testid`、浮かぶ面は `{testid}-pop`、つまみは `{testid}-volume`
   */
  let {
    silenced,
    testid,
    onclick,
    volume,
  }: {
    /** いま消しているか */
    silenced: boolean;
    testid: string;
    onclick: () => void;
    /** 音量 (%。`volume.svelte.ts`) */
    volume: { level: number; set: (level: number) => void };
  } = $props();

  /** 外れてから閉じるまで (ms)。ボタンとつまみの間を斜めに動かす間 */
  const LINGER = 400;

  let open = $state(false);
  /** つまみをつまんでいる間。外へはみ出して動かしても閉じない */
  let dragging = false;
  let hovered = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let root = $state<HTMLElement | null>(null);

  stageMenu(() => open);

  $effect(() => () => {
    if (timer !== null) clearTimeout(timer);
  });

  const can = (): boolean => window.matchMedia(POINTER).matches;

  function show(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (can()) open = true;
  }

  function later(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      // キーボードで中にいる間は残す (マウスで押したフォーカスでは残さない)
      if (
        !hovered &&
        !dragging &&
        root?.querySelector(":focus-visible") === null
      )
        open = false;
    }, LINGER);
  }

  function onwheel(event: WheelEvent): void {
    if (event.deltaY === 0) return;
    event.preventDefault();
    volume.set(stepLevel(volume.level, event.deltaY < 0 ? 1 : -1));
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -- 乗せた・外れたを受けるだけ。押すのは中のボタンとつまみ -->
<span
  class="sound"
  bind:this={root}
  data-open={open ? "" : undefined}
  onpointerenter={(event) => {
    if (event.pointerType !== "mouse") return;
    hovered = true;
    show();
  }}
  onpointerleave={(event) => {
    if (event.pointerType !== "mouse") return;
    hovered = false;
    later();
  }}
  onfocusin={(event) => {
    // マウスで押したときのフォーカスでは開かない (外れても閉じなくなる)
    if ((event.target as HTMLElement).matches(":focus-visible")) show();
  }}
  onfocusout={(event) => {
    if (!root?.contains(event.relatedTarget as Node | null)) later();
  }}
  onkeydown={(event) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      open = false;
    }
  }}
>
  <ControlButton
    icon={silenced ? SOUND_OFF : SOUND_ON}
    label={silenced ? "音を出す" : "音を消す"}
    {testid}
    {onclick}
  />
  <span class="pop" data-testid="{testid}-pop" {onwheel}>
    <span class="value num" aria-hidden="true">{volume.level}%</span>
    <input
      type="range"
      min="0"
      max={MAX_LEVEL}
      step={LEVEL_STEP}
      value={volume.level}
      style:--fill="{(volume.level / MAX_LEVEL) * 100}%"
      aria-label="音量"
      aria-valuetext="{volume.level}%"
      data-testid="{testid}-volume"
      oninput={(event) => volume.set(Number(event.currentTarget.value))}
      onpointerdown={() => {
        dragging = true;
        // 離した・取り上げられた (`pointercancel`) のどちらでも終える。残ると閉じなくなる
        const done = new AbortController();
        const end = () => {
          done.abort();
          dragging = false;
          if (!hovered) later();
        };
        window.addEventListener("pointerup", end, { signal: done.signal });
        window.addEventListener("pointercancel", end, { signal: done.signal });
      }}
    />
  </span>
</span>

<style>
  .sound {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }
  /*
     * 浮かぶ面は映像の上のメニューと同じ (暗い面で映像を透かす。ぼかさない。app.css の `.overlay-menu`)。
     * ボタンの真上に、隙間を空けずに置く (乗せたまま上へ動かしても外れない)
     */
  .pop {
    position: absolute;
    left: 50%;
    bottom: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    width: 3rem;
    margin-left: -1.5rem;
    padding: 0.5rem 0;
    border-radius: var(--dp-radius-lg);
    background: var(--dp-video-menu);
    box-shadow:
      0 2px 6px rgb(0 0 0 / 0.35),
      0 18px 40px rgb(0 0 0 / 0.45);
    color: var(--dp-on-video);
    /* 閉じる: 短く引っ込み、消えてから押せなくする (メニューと同じ動き。app.css の `.menu`) */
    visibility: hidden;
    opacity: 0;
    transform: translateY(0.375rem) scale(0.94);
    transform-origin: bottom center;
    transition:
      opacity var(--dp-duration-exit) var(--dp-ease-exit),
      transform var(--dp-duration-exit) var(--dp-ease-exit),
      visibility 0s linear var(--dp-duration-exit);
  }
  .sound[data-open] .pop {
    visibility: visible;
    opacity: 1;
    transform: none;
    transition:
      opacity var(--dp-duration-enter) var(--dp-ease-spring),
      transform var(--dp-duration-enter) var(--dp-ease-spring),
      visibility 0s;
  }
  /* 指の端末では浮かべない (⚙ のつまみを使う)。条件は `POINTER` と同じ */
  @media not ((hover: hover) and (pointer: fine)) {
    .pop {
      display: none;
    }
  }
  @media (prefers-reduced-transparency: reduce) {
    .pop {
      background: var(--dp-video-panel);
    }
  }
  .value {
    font-size: var(--dp-text-xs);
    line-height: 1;
  }
  /*
     * 縦のつまみ。溝・入れたぶん・丸は再生位置のバー (`SeekBar`) と ⚙ の音量と同じ (docs/design.md の
     * 「映像の上の操作」)。下が 0%。的の幅は 44px
     */
  .pop input {
    --track: color-mix(in srgb, var(--dp-on-video) 22%, transparent);
    --filled: var(--pico-primary-background);
    writing-mode: vertical-lr;
    direction: rtl;
    display: block;
    width: 2.75rem;
    height: 6.5rem;
    margin: 0;
    padding: 0;
    border: 0;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }
  .pop input:focus {
    background: transparent;
  }
  /* 2つのブラウザの擬似要素は1つの規則にまとめられない (知らないほうが規則ごと捨てる) */
  .pop input::-webkit-slider-runnable-track {
    width: 0.25rem;
    border: 0;
    border-radius: var(--dp-radius-full);
    background: linear-gradient(
      to top,
      var(--filled) var(--fill),
      var(--track) var(--fill)
    );
  }
  .pop input::-moz-range-track {
    width: 0.25rem;
    border: 0;
    border-radius: var(--dp-radius-full);
    background: linear-gradient(
      to top,
      var(--filled) var(--fill),
      var(--track) var(--fill)
    );
  }
  .pop input::-webkit-slider-thumb {
    appearance: none;
    width: 0.75rem;
    height: 0.75rem;
    margin-left: -0.25rem;
    border: 0;
    border-radius: var(--dp-radius-full);
    background: var(--filled);
    box-shadow: 0 0 2px rgb(0 0 0 / 0.5);
  }
  .pop input::-moz-range-thumb {
    width: 0.75rem;
    height: 0.75rem;
    border: 0;
    border-radius: var(--dp-radius-full);
    background: var(--filled);
    box-shadow: 0 0 2px rgb(0 0 0 / 0.5);
  }
</style>
