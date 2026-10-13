<script lang="ts">
    import ControlButton from './ControlButton.svelte';
    import { MORE } from './icons';

    /**
     * 「ほか」(⋯) のボタン。**畳むときだけ出す** (`Extras.svelte`。狭い枠か、押すものが一段に
     * 収まらないとき)。開け閉めの状態は舞台 (`PlayerStage`) が持つ — 操作列が引っ込んだら閉じる、
     * を1か所で決めるため。置き場所は全画面の左 (`StageTail`)
     */
    let {
        stage,
        testid,
    }: {
        stage: { fold: boolean; more: boolean; toggleMore: () => void };
        testid: string;
    } = $props();
</script>

{#if stage.fold}
    <ControlButton
        icon={MORE}
        label={stage.more ? 'ほかの操作を閉じる' : 'ほかの操作'}
        on={stage.more}
        {testid}
        onclick={stage.toggleMore}
    />
{/if}
