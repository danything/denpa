<script lang="ts">
  import { tick } from "svelte";

  import { LEVEL_STEP, MAX_LEVEL } from "#lib/volume.js";

  import Menu from "../Menu.svelte";
  import ControlButton from "./ControlButton.svelte";
  import { stageMenu } from "./controls.svelte";
  import Icon from "./Icon.svelte";
  import { BACK, FORWARD, SETTINGS, SOUND_ON } from "./icons";
  import type {
    SettingAction,
    SettingChoice,
    SettingRow,
    SettingToggle,
  } from "./settings";

  /**
   * 再生の設定 (⚙。3画面で同じ)。何を並べるかは `StageTail`、振る舞いは docs/player.md。上の並びは切り替えが先で
   * その場で変わり (`menuitemcheckbox`)、選ぶものは押すと選択肢の並びに入る (先頭が「戻る」、選ぶと閉じる。
   * `menuitemradio`。Esc か ← で戻る)。狭い枠では操作バーから畳んだもの (`head`) を頭に置き、余白で分ける。
   * 音量のつまみ (`volume`) は畳んだものの次、切り替えの前に置き、指でもつまめる高さにする。←→ で動かし、
   * ↑↓ はほかの行と同じく行を移る。
   *
   * testid: ボタンは `{prefix}-settings`、枠は `{prefix}-settings-menu`、行は `{prefix}-{id}`、
   * 選択肢は `{prefix}-{id}-option` に `data-{id}={key}` (例: `data-codec="av1"`)、音量のつまみは `{prefix}-volume`
   */
  let {
    prefix,
    head = [],
    toggles,
    choices,
    volume,
  }: {
    /** testid の頭 (`watch` / `chase` / `live`) */
    prefix: string;
    /** 狭い枠で操作バーから畳んだもの。上の並びの頭に置く */
    head?: SettingRow[];
    toggles: SettingToggle[];
    choices: SettingChoice[];
    /** 音量 (%。`volume.svelte.ts`) */
    volume?: { level: number; set: (level: number) => void } | undefined;
  } = $props();

  let open = $state(false);
  /** 開いている選択肢の並び (`SettingChoice` の `id`)。上の並びなら null */
  let view = $state<string | null>(null);
  const opened = $derived(
    [...head.filter((row) => row.kind === "choice"), ...choices].find(
      (c) => c.id === view,
    ),
  );
  let pane = $state<HTMLElement | null>(null);

  // 閉じたら上の並びに戻しておく。次に開いたとき途中から始まらないように
  $effect(() => {
    if (!open) view = null;
  });
  /**
   * **開いている選択肢の並びが無くなったら、上の並びへ戻る** (音声が2本から1本に減ったときなど)。
   * 消えた項目にいたフォーカスは上の並びの先頭へ移す (そのままだと行き場を失って、↑↓が効かなくなる)
   */
  $effect(() => {
    if (view === null || opened !== undefined) return;
    view = null;
    void tick().then(() => {
      // 消えた項目にいたときだけ (フォーカスは body に落ちている)。ほかを触っているなら奪わない
      if (
        document.activeElement !== null &&
        document.activeElement !== document.body
      )
        return;
      pane
        ?.querySelector<HTMLElement>(".menu-item")
        ?.focus({ preventScroll: true });
    });
  });

  /** 開いている間は操作列を残し、メニューは舞台の枠の中に収める (`stageMenu`) */
  const stage = stageMenu(() => open);

  /** 並びを替え、フォーカスを移す (入ったら選ばれているもの、戻ったら入った行) */
  async function go(next: string | null): Promise<void> {
    const from = view;
    view = next;
    await tick();
    const target =
      next === null
        ? pane?.querySelector<HTMLElement>(`[data-setting="${from}"]`)
        : (pane?.querySelector<HTMLElement>(
            ".option[data-active]:not([data-disabled])",
          ) ??
          pane?.querySelector<HTMLElement>(".option:not([data-disabled])"));
    target?.focus({ preventScroll: true });
  }

  function onkeydown(event: KeyboardEvent): void {
    if (
      view !== null &&
      (event.key === "Escape" || event.key === "ArrowLeft")
    ) {
      event.preventDefault();
      void go(null);
    } else if (view === null && event.key === "ArrowRight") {
      const id = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-choice]",
      )?.dataset["setting"];
      if (id === undefined) return;
      event.preventDefault();
      void go(id);
    }
  }
</script>

{#snippet action(item: SettingAction)}
  <button
    type="button"
    role="menuitem"
    class="menu-item setting"
    data-setting={item.id}
    data-testid="{prefix}-{item.id}"
    onclick={() => item.run()}
  >
    <Icon icon={item.icon} />
    <span class="label">{item.label}</span>
  </button>
{/snippet}

{#snippet toggle(item: SettingToggle)}
  <button
    type="button"
    role="menuitemcheckbox"
    class="menu-item setting"
    aria-checked={item.on}
    aria-disabled={item.disabled === true ? "true" : undefined}
    data-disabled={item.disabled === true ? "" : undefined}
    data-keep-open={item.closes === true ? undefined : ""}
    data-setting={item.id}
    data-testid="{prefix}-{item.id}"
    onclick={() => {
      if (item.disabled !== true) item.toggle();
    }}
  >
    <Icon icon={item.icon} />
    <span class="label"
      >{item.label}{#if item.note !== undefined}<span class="note">
          ({item.note})</span
        >{/if}</span
    >
    <span class="switch" data-on={item.on ? "" : undefined} aria-hidden="true"
    ></span>
  </button>
{/snippet}

{#snippet choice(item: SettingChoice)}
  <button
    type="button"
    role="menuitem"
    class="menu-item setting"
    aria-haspopup="menu"
    data-keep-open
    data-choice
    data-setting={item.id}
    data-testid="{prefix}-{item.id}"
    onclick={() => go(item.id)}
  >
    <Icon icon={item.icon} />
    <span class="label">{item.label}</span>
    <span class="value">{item.value}</span>
    <Icon icon={FORWARD} />
  </button>
{/snippet}

<Menu
  bind:open
  side="top"
  align="end"
  boundary={stage}
  class="overlay-menu settings-menu"
  testid="{prefix}-settings-menu"
>
  {#snippet trigger(menu)}
    <ControlButton
      {menu}
      icon={SETTINGS}
      label="再生の設定"
      testid="{prefix}-settings"
    />
  {/snippet}
  <!-- svelte-ignore a11y_no_static_element_interactions -- キーは中の項目から上がってくるものを受けるだけ -->
  <div class="pane" bind:this={pane} {onkeydown}>
    {#if opened === undefined}
      {#each head as row (row.id)}
        {#if row.kind === "action"}
          {@render action(row)}
        {:else if row.kind === "toggle"}
          {@render toggle(row)}
        {:else}
          {@render choice(row)}
        {/if}
      {/each}
      <!-- 畳んだものといつもの行の境目。線は引かず、上下を空ける (app.css の `.menu hr`) -->
      {#if head.length > 0}<hr />{/if}
      {#if volume !== undefined}
        <!--
          音量。名前と値の下につまみ。行は押しても閉じない (`data-keep-open`)。
          ↑↓ で行を移るために、つまみ自身を項目 (`menu-item`) にする
        -->
        <div class="volume" role="group" aria-label="音量">
          <div class="volume-head" aria-hidden="true">
            <Icon icon={SOUND_ON} />
            <span class="label">音量</span>
            <span class="value num">{volume.level}%</span>
          </div>
          <input
            type="range"
            class="menu-item"
            min="0"
            max={MAX_LEVEL}
            step={LEVEL_STEP}
            value={volume.level}
            style:--fill="{(volume.level / MAX_LEVEL) * 100}%"
            aria-label="音量"
            aria-valuetext="{volume.level}%"
            data-keep-open
            data-testid="{prefix}-volume"
            oninput={(event) => volume?.set(Number(event.currentTarget.value))}
          />
        </div>
      {/if}
      {#each toggles as item (item.id)}
        {@render toggle(item)}
      {/each}
      {#each choices as item (item.id)}
        {@render choice(item)}
      {/each}
    {:else}
      <button
        type="button"
        role="menuitem"
        class="menu-item setting back"
        data-keep-open
        data-testid="{prefix}-settings-back"
        onclick={() => go(null)}
      >
        <Icon icon={BACK} />
        <span class="label">{opened.label}</span>
      </button>
      {#each opened.options as option (option.key)}
        <button
          type="button"
          role="menuitemradio"
          class="menu-item option"
          aria-checked={option.active}
          aria-disabled={option.disabled === true ? "true" : undefined}
          data-disabled={option.disabled === true ? "" : undefined}
          data-active={option.active ? "" : undefined}
          data-testid="{prefix}-{opened.id}-option"
          {...{ [`data-${opened.id}`]: option.key }}
          onclick={() => {
            if (option.disabled !== true) opened.pick(option.key);
          }}
        >
          {option.label}
        </button>
      {/each}
    {/if}
  </div>
</Menu>

<style>
  /*
     * **幅は上の並びと選択肢の並びで変えない。** 入るたびに枠の幅が変わると、押した位置から行が逃げる。
     * 名前と値が1行に収まる幅から。**値は省かずに出したい** (音声の「主音声ステレオ (日本語)」など) ので、
     * 映像の上のほかのメニュー (20rem まで) より広く取り、それでも入らなければ値だけ2行に折る
     */
  :global(.overlay-menu.settings-menu) {
    min-width: 17rem;
    max-width: min(24rem, 90vw);
  }
  .pane {
    display: contents;
  }
  .setting :global(svg) {
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
  }
  .label {
    flex: 1 1 auto;
    white-space: nowrap;
    padding-inline-end: 0.75rem;
  }
  /*
     * 値は名前と同じ大きさの字で、色だけ控える。長い値は2行まで右にそろえて折り、
     * それでも入らないぶんだけ「…」で止める
     */
  .value {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    min-width: 0;
    max-width: 13rem;
    overflow: hidden;
    font-size: inherit;
    line-height: 1.3;
    text-align: right;
    color: var(--dp-muted);
  }
  /* 注記は値と同じく色だけ控える (押せない形式の「(再生できません)」と同じ言い方) */
  .note {
    color: var(--dp-muted);
  }
  .back {
    margin-bottom: 0.375rem;
  }
  /*
     * 音量のつまみ。名前と値は行と同じ並び (余白も `.menu-item` と同じ)、その下につまみ。
     * つまみの的は高さ 44px (車のタブレットで指でつまめる)。溝・入れたぶん・丸は再生位置のバー (`SeekBar`) と同じ
     * (docs/design.md の「映像の上の操作」)。触っているときは行ごと薄い地 (ほかの項目のフォーカスと同じ)
     */
  /* `role="group"` に Pico が付ける横並び (`inline-flex`) を消し、つまみを名前と値の下に置く */
  .volume {
    display: block;
    padding: 0.5rem 0.75rem 0;
    border-radius: calc(var(--dp-radius-lg) - var(--menu-pad, 0.5rem));
  }
  .volume:has(input:focus) {
    background: var(--dp-hover);
  }
  .volume-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .volume input {
    --track: color-mix(in srgb, var(--dp-on-video) 22%, transparent);
    --filled: var(--pico-primary-background);
    display: block;
    width: 100%;
    height: 2.75rem;
    margin: 0;
    padding: 0;
    appearance: none;
    background: transparent;
    cursor: pointer;
    touch-action: pan-y;
  }
  .volume input:focus {
    background: transparent;
  }
  /* 2つのブラウザの擬似要素は1つの規則にまとめられない (知らないほうが規則ごと捨てる) */
  .volume input::-webkit-slider-runnable-track {
    height: 0.25rem;
    border: 0;
    border-radius: var(--dp-radius-full);
    background: linear-gradient(
      to right,
      var(--filled) var(--fill),
      var(--track) var(--fill)
    );
  }
  .volume input::-moz-range-track {
    height: 0.25rem;
    border: 0;
    border-radius: var(--dp-radius-full);
    background: linear-gradient(
      to right,
      var(--filled) var(--fill),
      var(--track) var(--fill)
    );
  }
  .volume input::-webkit-slider-thumb {
    appearance: none;
    width: 0.75rem;
    height: 0.75rem;
    margin-top: -0.25rem;
    border: 0;
    border-radius: var(--dp-radius-full);
    background: var(--filled);
    box-shadow: 0 0 2px rgb(0 0 0 / 0.5);
  }
  .volume input::-moz-range-thumb {
    width: 0.75rem;
    height: 0.75rem;
    border: 0;
    border-radius: var(--dp-radius-full);
    background: var(--filled);
    box-shadow: 0 0 2px rgb(0 0 0 / 0.5);
  }
  /* オン/オフのスイッチ。状態は行の `aria-checked` で読ませ、これは見た目だけ */
  .switch {
    position: relative;
    flex-shrink: 0;
    width: 2.25rem;
    height: 1.25rem;
    border-radius: var(--dp-radius-full);
    /* 切っているときの地は文字色を薄めたもの。線の色 (`--dp-line`) では暗いほうで面に沈む */
    background: color-mix(in srgb, currentColor 28%, transparent);
    transition: background-color var(--dp-duration) var(--dp-ease);
  }
  .switch::after {
    content: "";
    position: absolute;
    top: 0.125rem;
    left: 0.125rem;
    width: 1rem;
    height: 1rem;
    border-radius: var(--dp-radius-full);
    background: var(--dp-on-video);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);
    transition: transform var(--dp-duration-move) var(--dp-ease-spring);
  }
  /*
     * 入っているときもテーマの主の色は使わない (映像の上はテーマで変えない。docs/design.md の「色」)。
     * 白を濃く敷いた溝にし、オン/オフは丸の位置でも分かる。メニューの面はいつも暗い (app.css の `.overlay-menu`)
     */
  .switch[data-on] {
    background: color-mix(in srgb, var(--dp-on-video) 60%, transparent);
  }
  .switch[data-on]::after {
    transform: translateX(1rem);
  }
</style>
