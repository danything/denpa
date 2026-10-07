<script lang="ts">
    import type { Background } from './background.svelte.js';
    import ControlButton from './ControlButton.svelte';
    import Extras from './Extras.svelte';
    import type { StageFullscreen } from './fullscreen.svelte.js';
    import { BACKGROUND, EXPAND, PIP, SHRINK } from './icons';
    import type { Pip } from './pip.svelte.js';

    /**
     * 帯の右端。**3画面 (ライブ・追っかけ・録画) で同じ。**
     *
     * - **バックグラウンド再生。** 既定は切で、裏に回したら止める。端末ごとに覚える (`background.svelte.ts`)
     * - **小窓 (PiP)。** ページから出せない端末 (iPhone・iPad のホーム画面から開いたもの・口の無いブラウザ) では
     *   出さない (`pip.svelte.ts`)
     *
     * この2つは狭い枠では「ほか」に畳む。全画面はいつも出す
     */
    interface Props {
        /** testid の頭 (`watch` / `chase` / `live`) */
        prefix: string;
        background: Background;
        pip: Pip;
        fullscreen: StageFullscreen;
    }
    let { prefix, background, pip, fullscreen }: Props = $props();
</script>

<Extras>
    <ControlButton
        icon={BACKGROUND}
        label={background.on ? 'バックグラウンド再生をやめる' : 'バックグラウンド再生を入れる'}
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

<ControlButton
    icon={fullscreen.active ? SHRINK : EXPAND}
    label={fullscreen.active ? '全画面をやめる' : '全画面'}
    testid="{prefix}-full"
    onclick={fullscreen.toggle}
/>
