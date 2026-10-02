<script lang="ts">
    import ControlButton from './ControlButton.svelte';
    import { MORE } from './icons';

    /**
     * 「ほか」(⋯) の口。**狭い枠でだけ出す** (`Extras.svelte`)。開け閉めの状態は
     * 舞台 (`PlayerStage`) が持つ — 操作列が引っ込んだら閉じる、を1か所で決めるため
     */
    let {
        stage,
        testid,
    }: {
        stage: { compact: boolean; more: boolean; toggleMore: () => void };
        testid: string;
    } = $props();
</script>

{#if stage.compact}
    <ControlButton
        path={MORE}
        label={stage.more ? 'ほかの操作を閉じる' : 'ほかの操作'}
        on={stage.more}
        {testid}
        onclick={stage.toggleMore}
    />
{/if}
