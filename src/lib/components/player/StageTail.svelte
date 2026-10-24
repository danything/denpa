<script lang="ts">
  import { onMount } from "svelte";

  import {
    canvasVideo,
    chooseCanvas,
    seeDriveNotice,
  } from "#lib/canvas-video.js";

  import DriveNotice from "../DriveNotice.svelte";
  import type { Ambient } from "./ambient.svelte.js";
  import type { Background } from "./background.svelte.js";
  import ControlButton from "./ControlButton.svelte";
  import Extras from "./Extras.svelte";
  import type { StageFullscreen } from "./fullscreen.svelte.js";
  import {
    AMBIENT,
    BACKGROUND,
    COMPAT,
    CUT,
    DATA,
    EXPAND,
    PIP,
    SHRINK,
  } from "./icons";
  import type { Pip } from "./pip.svelte.js";
  import type { SettingChoice, SettingRow, SettingToggle } from "./settings";
  import SettingsMenu from "./SettingsMenu.svelte";

  /**
   * 操作バーの右端 (3画面で同じ)。再生の設定 (⚙ `SettingsMenu`。並びと中身は docs/player.md)・小窓 (出せる端末だけ)・
   * 全画面。狭い枠 (`stage.fold`) では毎回は使わないものを ⚙ の頭に入れる (`fold`。小窓もここで足す)。
   * 互換モードは切り替えたらページを読み直す — `<video>` か canvas かはプレイヤーを組むときに決まる
   */
  interface Props {
    /** testid の頭 (`watch` / `chase` / `live`) */
    prefix: string;
    background: Background;
    ambient: Ambient;
    pip: Pip;
    fullscreen: StageFullscreen;
    /** 舞台 (`PlayerStage`) が渡す畳み方 */
    stage: { fold: boolean };
    /**
     * 狭い枠で操作バーから畳むもの (`settings.ts` の `SettingRow`)。操作バーと同じ順に。畳まないときは使わない。
     * 小窓はここで足す
     */
    fold?: SettingRow[];
    /** コーデック (`settings.ts` の `liveCodecs` / `recordingCodecs`)。選べないときは省く */
    codec?: SettingChoice | undefined;
    /** 音声 (`settings.ts` の `audioTracks`)。選べるものが2つ以上あるときだけ */
    audio?: SettingChoice | undefined;
    /** CMスキップ (観る画面で、CM の入った録画だけ) */
    cm?: { on: boolean; toggle: () => void } | undefined;
    /**
     * データ放送 (観る画面で、取り出してある録画だけ)。**映像の上の列には置かない** — 右端の列は
     * 全画面のタブレットで使う閉じる・切り抜き・削除のために空けておく (`ControlBar`)
     */
    data?: { on: boolean; toggle: () => void } | undefined;
    /** 字幕 (`settings.ts` の `subtitles`)。字幕を持っているときだけ */
    subtitle?: SettingChoice | undefined;
  }
  let {
    prefix,
    background,
    ambient,
    pip,
    fullscreen,
    stage,
    codec,
    audio,
    cm,
    data,
    subtitle,
    fold = [],
  }: Props = $props();

  /** 狭い枠で ⚙ の頭に入れるもの。小窓は出せる端末だけ */
  const head = $derived<SettingRow[]>(
    stage.fold
      ? [
          ...fold,
          ...(pip.available
            ? [
                {
                  kind: "toggle" as const,
                  id: "pip-mode",
                  label: "小窓",
                  icon: PIP,
                  on: pip.active,
                  toggle: () => pip.toggle(),
                },
              ]
            : []),
        ]
      : [],
  );

  /** 互換モードか。端末で決まるので、開いてから読む */
  let compat = $state(false);
  /** 入れようとしている (運転中の注意を出している) */
  let confirming = $state(false);
  onMount(() => {
    compat = canvasVideo();
  });

  /** 入れるときは運転中の注意を先に出す。切るのはその場で。どちらも読み直して組み直す */
  function setCompat(on: boolean): void {
    if (on) {
      confirming = true;
      return;
    }
    chooseCanvas(false);
    location.reload();
  }

  function acceptCompat(): void {
    seeDriveNotice();
    chooseCanvas(true);
    confirming = false;
    location.reload();
  }

  const toggles = $derived<SettingToggle[]>([
    ...(cm === undefined
      ? []
      : [
          {
            id: "skip-cm",
            label: "CMスキップ",
            icon: CUT,
            on: cm.on,
            toggle: cm.toggle,
          },
        ]),
    // 出すとリモコンが右の列に出るので、メニューは閉じる
    ...(data === undefined
      ? []
      : [
          {
            id: "data",
            label: "データ放送",
            icon: DATA,
            on: data.on,
            toggle: data.toggle,
            closes: true,
          },
        ]),
    {
      id: "ambient",
      label: "アンビエントモード",
      icon: AMBIENT,
      on: ambient.on,
      toggle: () => ambient.toggle(),
    },
    {
      id: "background",
      label: "バックグラウンド再生",
      icon: BACKGROUND,
      on: background.on,
      toggle: () => background.toggle(),
    },
    {
      id: "compat",
      label: "互換モード",
      icon: COMPAT,
      on: compat || confirming,
      toggle: () => setCompat(!compat),
      // 運転中の注意を出すので、メニューは閉じる
      closes: true,
    },
  ]);
  const choices = $derived(
    [subtitle, audio, codec].filter((item) => item !== undefined),
  );
</script>

<SettingsMenu {prefix} {head} {toggles} {choices} />
<!-- 出すときだけ置く。ライブは再生の前に出す注意を自分でも持っているので、いつも置くと2つになる -->
{#if confirming}
  <DriveNotice
    open
    onaccept={acceptCompat}
    oncancel={() => (confirming = false)}
  />
{/if}

{#if pip.available}
  <Extras>
    <ControlButton
      icon={PIP}
      label={pip.active ? "小窓をやめる" : "小窓で観る"}
      on={pip.active}
      testid="{prefix}-pip"
      onclick={() => pip.toggle()}
    />
  </Extras>
{/if}

<ControlButton
  icon={fullscreen.active ? SHRINK : EXPAND}
  label={fullscreen.active ? "全画面をやめる" : "全画面"}
  testid="{prefix}-full"
  onclick={fullscreen.toggle}
/>
