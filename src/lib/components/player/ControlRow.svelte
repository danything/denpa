<script lang="ts">
    import type { Snippet } from 'svelte';

    /**
     * 下の操作バーの「押すものの行」。**3画面で同じ並び** — 再生・音・字幕が左から順で、
     * 全画面がいちばん右。画面を移っても同じ場所にあると、見ないでも押せる。
     *
     * **折り返さない** (`flex-wrap: nowrap`)。入りきらないときは毎回は使わないもの (`Extras`) を
     * 再生の設定 (⚙) に畳む — 畳むかどうかは舞台 (`PlayerStage` の `data-fold`) が決める。
     * 折り返していた頃は、スマホの縦で読みもの (時刻) が押すものの上に一行を取り、操作バーが
     * 二段になって映像の下を余計に使っていた。はみ出したぶんは隠す (横だけ。縦に隠すと押したときの
     * 枠線が切れる)。
     */
    let { testid, children }: { testid?: string; children: Snippet } = $props();
</script>

<div class="row" data-testid={testid} data-stage-row>
    {@render children()}
</div>

<style>
    .row {
        display: flex;
        flex-wrap: nowrap;
        align-items: center;
        gap: 0.25rem;
        margin-top: 0.25rem;
        overflow-x: clip;
        color: #fff;
    }
    /* 狭い枠では間を少し詰める (押す的の大きさは `ControlButton` が 40px で保つ) */
    :global(.stage[data-compact]) .row {
        gap: 0.125rem;
    }
</style>
