<script lang="ts">
    import type { Background } from './background.svelte.js';
    import ControlButton from './ControlButton.svelte';
    import Extras from './Extras.svelte';
    import type { StageFullscreen } from './fullscreen.svelte.js';
    import { BACKGROUND, EXPAND, PIP, SHRINK } from './icons';
    import MoreButton from './MoreButton.svelte';
    import type { Pip } from './pip.svelte.js';

    /**
     * 操作バーの右端。**3画面 (ライブ・追っかけ・録画) で同じ。**
     *
     * - **バックグラウンド再生。** 既定はオフで、裏に回したら止める。端末ごとに覚える (`background.svelte.ts`)
     * - **小窓 (PiP)。** ページから出せない端末 (iPhone・iPad のホーム画面から開いたもの・API の無いブラウザ) では
     *   出さない (`pip.svelte.ts`)
     * - **「ほか」(⋯)。** 畳むときだけ、全画面のすぐ左に出す (`MoreButton`)
     *
     * バックグラウンドと小窓は畳むときは「ほか」に入れる。全画面はいつも出す
     */
    interface Props {
        /** testid の頭 (`watch` / `chase` / `live`) */
        prefix: string;
        background: Background;
        pip: Pip;
        fullscreen: StageFullscreen;
        /** 舞台 (`PlayerStage`) が渡す畳み方と「ほか」の開け閉め */
        stage: { fold: boolean; more: boolean; toggleMore: () => void };
    }
    let { prefix, background, pip, fullscreen, stage }: Props = $props();
</script>

<Extras>
    <ControlButton
        icon={BACKGROUND}
        label={background.on ? 'バックグラウンド再生をやめる' : 'バックグラウンド再生をオンにする'}
        on={background.on}
        testid="{prefix}-background"
        onclick={() => background.toggle()}
    />
</Extras>
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
