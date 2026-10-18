<script lang="ts">
    import type { Ambient } from './ambient.svelte.js';
    import type { Background } from './background.svelte.js';
    import ControlButton from './ControlButton.svelte';
    import Extras from './Extras.svelte';
    import type { StageFullscreen } from './fullscreen.svelte.js';
    import { AMBIENT, BACKGROUND, CUT, EXPAND, PIP, SHRINK } from './icons';
    import MoreButton from './MoreButton.svelte';
    import type { Pip } from './pip.svelte.js';
    import SettingsMenu from './SettingsMenu.svelte';
    import type { SettingChoice, SettingToggle } from './settings';

    /**
     * 操作バーの右端。**3画面 (ライブ・追っかけ・録画) で同じ。**
     *
     * - **再生の設定 (⚙ `SettingsMenu`)。** 端末ごとに決めるものをまとめる。上から CMスキップ (観る画面で
     *   CM の入った録画だけ)・アンビエントモード・バックグラウンド再生・字幕 (持っているときだけ)・音声 (選べるときだけ)・コーデック。
     *   **畳むときも出しておく** — 中身を1つにまとめたぶん、ボタンは1つで済む
     *   - バックグラウンド再生 … 既定はオフで、裏に回したら止める。端末ごとに覚える (`background.svelte.ts`)
     *   - アンビエントモード … 既定はオンで、映像の色を枠の周りに広げる。端末ごとに覚える (`ambient.svelte.ts`)
     * - **小窓 (PiP)。** ページから出せない端末 (iPhone・iPad のホーム画面から開いたもの・API の無いブラウザ) では
     *   出さない (`pip.svelte.ts`)。畳むときは「ほか」に入れる
     * - **「ほか」(⋯)。** 畳むときだけ、全画面のすぐ左に出す (`MoreButton`)
     * - **全画面。** いつも出す
     */
    interface Props {
        /** testid の頭 (`watch` / `chase` / `live`) */
        prefix: string;
        background: Background;
        ambient: Ambient;
        pip: Pip;
        fullscreen: StageFullscreen;
        /** 舞台 (`PlayerStage`) が渡す畳み方と「ほか」の開け閉め */
        stage: { fold: boolean; more: boolean; toggleMore: () => void };
        /** コーデック (`settings.ts` の `liveCodecs` / `recordingCodecs`)。選べないときは省く */
        codec?: SettingChoice | undefined;
        /** 音声 (`settings.ts` の `audioTracks`)。選べるものが2つ以上あるときだけ */
        audio?: SettingChoice | undefined;
        /** CMスキップ (観る画面で、CM の入った録画だけ) */
        cm?: { on: boolean; toggle: () => void } | undefined;
        /** 字幕 (`settings.ts` の `subtitles`)。字幕を持っているときだけ */
        subtitle?: SettingChoice | undefined;
    }
    let { prefix, background, ambient, pip, fullscreen, stage, codec, audio, cm, subtitle }: Props = $props();

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
    ]);
    const choices = $derived([subtitle, audio, codec].filter((item) => item !== undefined));
</script>

<SettingsMenu {prefix} {toggles} {choices} />

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

<MoreButton {stage} testid="{prefix}-more" />

<ControlButton
    icon={fullscreen.active ? SHRINK : EXPAND}
    label={fullscreen.active ? '全画面をやめる' : '全画面'}
    testid="{prefix}-full"
    onclick={fullscreen.toggle}
/>
