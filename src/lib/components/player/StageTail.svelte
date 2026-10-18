<script lang="ts">
    import { onMount } from 'svelte';
    import { canvasVideo, chooseCanvas, seeDriveNotice } from '#lib/canvas-video.js';
    import DriveNotice from '../DriveNotice.svelte';
    import type { Ambient } from './ambient.svelte.js';
    import type { Background } from './background.svelte.js';
    import ControlButton from './ControlButton.svelte';
    import Extras from './Extras.svelte';
    import type { StageFullscreen } from './fullscreen.svelte.js';
    import { AMBIENT, BACKGROUND, COMPAT, CUT, EXPAND, PIP, SHRINK } from './icons';
    import type { Pip } from './pip.svelte.js';
    import SettingsMenu from './SettingsMenu.svelte';
    import type { SettingChoice, SettingRow, SettingToggle } from './settings';

    /**
     * 操作バーの右端。**3画面 (ライブ・追っかけ・録画) で同じ。**
     *
     * - **再生の設定 (⚙ `SettingsMenu`)。** 端末ごとに決めるものをまとめる。上から CMスキップ (観る画面で
     *   CM の入った録画だけ)・アンビエントモード・バックグラウンド再生・互換モード・字幕 (持っているときだけ)・音声 (選べるときだけ)・コーデック。
     *   **畳むときも出しておく** — 中身を1つにまとめたぶん、ボタンは1つで済む
     *   - バックグラウンド再生 … 既定はオフで、裏に回したら止める。端末ごとに覚える (`background.svelte.ts`)
     *   - アンビエントモード … 既定はオンで、映像の色を枠の周りに広げる。端末ごとに覚える (`ambient.svelte.ts`)
     *   - 互換モード … 動画が止まる端末 (テスラの車載ブラウザ) 向けに canvas に描く。端末ごとに覚える (`canvas-video.ts`)。
     *     入れるときは運転中の注意を出し、「わかりました」で入る (`DriveNotice`)。**切り替えたらページを読み直す** —
     *     `<video>` で観るか canvas に描くかはプレイヤーを組むときに決まる (観る画面は開いたとき、ライブは選局のたび)
     * - **小窓 (PiP)。** ページから出せない端末 (iPhone・iPad のホーム画面から開いたもの・API の無いブラウザ) では
     *   出さない (`pip.svelte.ts`)。畳むときは ⚙ の頭に入れる (`pip-mode`)
     * - **狭い枠 (`stage.fold`) では、毎回は使わないものを ⚙ の頭に入れる** (`fold`。音・速さ・Hybridcast と小窓)。
     *   「ほか」(⋯) のボタンを別に置いていた頃は、狭い操作バーに ⋯ と ⚙ が並んでいた
     * - **全画面。** いつも出す
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
        /** 字幕 (`settings.ts` の `subtitles`)。字幕を持っているときだけ */
        subtitle?: SettingChoice | undefined;
    }
    let { prefix, background, ambient, pip, fullscreen, stage, codec, audio, cm, subtitle, fold = [] }: Props = $props();

    /** 狭い枠で ⚙ の頭に入れるもの。小窓は出せる端末だけ */
    const head = $derived<SettingRow[]>(
        stage.fold
            ? [
                  ...fold,
                  ...(pip.available
                      ? [
                            {
                                kind: 'toggle' as const,
                                id: 'pip-mode',
                                label: '小窓',
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
        ...(cm === undefined ? [] : [{ id: 'skip-cm', label: 'CMスキップ', icon: CUT, on: cm.on, toggle: cm.toggle }]),
        { id: 'ambient', label: 'アンビエントモード', icon: AMBIENT, on: ambient.on, toggle: () => ambient.toggle() },
        {
            id: 'background',
            label: 'バックグラウンド再生',
            icon: BACKGROUND,
            on: background.on,
            toggle: () => background.toggle(),
        },
        {
            id: 'compat',
            label: '互換モード',
            icon: COMPAT,
            on: compat || confirming,
            toggle: () => setCompat(!compat),
            // 運転中の注意を出すので、メニューは閉じる
            closes: true,
        },
    ]);
    const choices = $derived([subtitle, audio, codec].filter((item) => item !== undefined));
</script>

<SettingsMenu {prefix} {head} {toggles} {choices} />
<!-- 出すときだけ置く。ライブは再生の前に出す注意を自分でも持っているので、いつも置くと2つになる -->
{#if confirming}
    <DriveNotice open onaccept={acceptCompat} oncancel={() => (confirming = false)} />
{/if}

{#if pip.available}
    <Extras>
        <ControlButton
            icon={PIP}
            label={pip.active ? '小窓をやめる' : '小窓で観る'}
            on={pip.active}
            testid="{prefix}-pip"
            onclick={() => pip.toggle()}
        />
    </Extras>
{/if}

<ControlButton
    icon={fullscreen.active ? SHRINK : EXPAND}
    label={fullscreen.active ? '全画面をやめる' : '全画面'}
    testid="{prefix}-full"
    onclick={fullscreen.toggle}
/>
