<script lang="ts" module>
  import { read } from "#lib/keep.js";
  import { SPEEDS } from "#lib/ts/pacing.js";

  /** 録画の速さを覚える鍵。観る画面と追っかけで共通 (エンコードする前と後で同じ録画を観る) */
  export const SPEED_KEY = "watch-speed";

  /** 前に選んだ速さ。読めない・知らない値なら等速 */
  export function storedSpeed(): number {
    const saved = Number(read(SPEED_KEY));
    return SPEEDS.includes(saved as (typeof SPEEDS)[number]) ? saved : 1;
  }
</script>

<script lang="ts">
  import { speedLabel } from "#lib/ts/pacing.js";

  import Menu from "../Menu.svelte";
  import ControlButton from "./ControlButton.svelte";
  import { stageMenu } from "./controls.svelte";
  import { SPEED } from "./icons";

  /**
   * 速さの切り替え。**3画面で同じ見た目。**
   * `label` だけ画面の言葉 (ライブは「追っかけの速さ」、他は「再生の速さ」)。
   *
   * **ボタンは、等速ならメーターのアイコンだけの丸、速めている間は数字だけ (「1.25」)。**
   * 速めているときだけ数字が出れば、それ自体が「いま速めている」の印になる (押されている
   * 見た目 `on` も同じとき)。ボタンの上では × を付けない — 速さのボタンだと分かっているので要らない。
   *
   * **選択肢は「×1.25」のまま。** 開いた並びは数字だけが縦に並ぶので、何の数か (倍) を書いておく。
   * 開け閉めは `Menu` (popover。最前面に出るので、舞台を全画面にしている間も隠れない)。
   * testid: 枠は `{testid}-menu`、選択肢は `{testid}-option` に `data-speed`
   */
  let {
    testid,
    label,
    speed,
    onselect,
  }: {
    testid?: string | undefined;
    label: string;
    speed: number;
    onselect: (speed: number) => void;
  } = $props();

  let open = $state(false);
  /** 開いている間は操作列を残し、メニューは舞台の枠の中に収める (`stageMenu`) */
  const stage = stageMenu(() => open);
</script>

<!--
    中身 (`children`) は速めているときだけ渡す。ControlButton は中身が無いときだけ丸くする。
    ボタンは1つのまま、アイコンと数字を差し替える (`{#if}` で ControlButton ごと出し分けない)
-->
{#snippet number()}
  <span style="font-variant-numeric: tabular-nums">{speed}</span>
{/snippet}

<Menu
  bind:open
  side="top"
  align="end"
  boundary={stage}
  class="overlay-menu speed-menu"
  testid={testid && `${testid}-menu`}
>
  {#snippet trigger(menu)}
    <span class="speed">
      <ControlButton
        {menu}
        label={speedLabel(label, speed)}
        {testid}
        on={speed !== 1}
        icon={speed === 1 ? SPEED : undefined}
        children={speed === 1 ? undefined : number}
      />
    </span>
  {/snippet}
  {#each SPEEDS as value (value)}
    <button
      type="button"
      role="menuitem"
      class="menu-item option"
      onclick={() => onselect(value)}
      data-testid={testid && `${testid}-option`}
      data-speed={value}
      data-active={value === speed ? "" : undefined}
      aria-current={value === speed ? "true" : undefined}
    >
      ×{value}
    </button>
  {/each}
</Menu>

<style>
  /*
     * **数字のときも、丸いボタンと同じ幅から。** 文字を添えるボタンの余白 (1.25rem) では
     * 「1.25」で 80px と、隣の丸 (48px) に比べて横に間延びする。「2」は丸と同じ幅まで広げる。
     * 等速の丸 (`ov-round`) には当てない — 幅も余白も丸の決まりのまま
     */
  .speed {
    display: contents;
  }
  .speed :global(.ov-btn:not(.ov-round)) {
    min-width: 3rem;
    padding-inline: 0.75rem;
  }
  /* 狭い枠 (舞台の `data-compact`) では丸が 40px になる (`ControlButton`)。数字も同じ幅から */
  :global(.stage[data-compact]) .speed :global(.ov-btn:not(.ov-round)) {
    min-width: 2.5rem;
  }
  /*
     * 箱と選択肢の地・項目の間は `SettingsMenu` と同じなので app.css (`.menu`・`.overlay-menu`) に置く。
     * ここは数字を大きく真ん中にそろえるだけ。畳むときは速さのボタンごと ⚙ の頭に入れるので (`Extras`)、
     * このメニューは畳まないときだけ出る
     */
  :global(.overlay-menu.speed-menu) {
    font-size: var(--dp-text-lg);
  }
  :global(.overlay-menu.speed-menu .option) {
    justify-content: center;
    font-variant-numeric: tabular-nums;
  }
</style>
