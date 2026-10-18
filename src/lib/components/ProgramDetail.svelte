<script lang="ts">
    import type { Snippet } from 'svelte';
    import ProgramFacts from '#lib/components/ProgramFacts.svelte';
    import type { ProgramDetail } from '#lib/types.js';

    /**
     * 番組の詳細を出すモーダル。
     *
     * 番組表・予約一覧・録画一覧のどこから開いても同じ見え方にするため、ここに寄せてある。
     * 下に並べるボタンだけは開いた場所で違うので snippet で受ける (渡さなければ「閉じる」だけ)。
     *
     * **中身は `ProgramFacts` が持っている** — 観る画面・ライブ・追っかけは
     * 枠なしで同じものを右 (FactsAside) に置くため。
     */
    let {
        program,
        onclose,
        notes = [],
        cmNote = null,
        fps = null,
        actions,
        transitionName,
    }: {
        program: ProgramDetail;
        onclose: () => void;
        notes?: { title: string; text: string }[];
        cmNote?: string | null;
        /** エンコードしたもののコマ数。録画から開いたときだけ入る (ProgramFacts へ素通し) */
        fps?: number | null;
        actions?: Snippet | undefined;
        /**
         * 箱に付ける画面の切り替えの名前 (View Transitions)。押した要素から広げて開くとき
         * (番組表のマス。`#lib/motion.svelte.ts` の `morph`) だけ渡す
         */
        transitionName?: string | undefined;
    } = $props();
</script>

<!--
    **高さは `%` で採る** (`app.css` で `html` に高さを与えてある)。
    `vh` はアドレスバーが引っ込んだときの高さ、`dvh` も端末 (PWA) によって合わない。
    外枠は `position: fixed` なので、その `100%` は**そのページが縦に動かずに
    出せる高さ**そのものになる。上下に少し余白を置いて、中身はその中で巻き取らせる。

    `<dialog>` にはしていない。開閉は渡す側が持っている (出すときだけ描く) ので、
    ここは箱と背景だけで足りる
-->
<div class="detail-modal" role="dialog" aria-modal="true" data-testid="program-detail">
    <button type="button" class="detail-backdrop" onclick={onclose} aria-label="閉じる"></button>
    <!--
        **巻き取るのは中身だけ。** 押すものは箱の下端に貼り付けたまま出しておく
        (説明が長くても開いた時点で見える。FactsAside と同じ考え方)
    -->
    <div class="detail-box modal-box" class:morph={transitionName !== undefined} style:view-transition-name={transitionName}>
        <div class="detail-body">
            <ProgramFacts {program} {notes} {cmNote} {fps} />
        </div>

        <!--
            **枠はこちらで持つ。** 右下に横並びなので、どこから開いても同じ並びになる。
            **閉じるはいちばん右** (見ないでも押せる)。入り切らなければ折り返す (`flex-wrap`)
        -->
        <div class="detail-actions modal-actions">
            {#if actions}
                {@render actions()}
            {:else}
                <button type="button" class="secondary" onclick={onclose} data-testid="detail-close">閉じる</button>
            {/if}
        </div>
    </div>
</div>

<style>
    .detail-modal {
        position: fixed;
        inset: 0;
        z-index: 60;
        /* grid だと箱の max-height: 100% が行の高さ (auto) に対して解決されて効かず、低い画面ではみ出した。flex なら外枠の高さに効く */
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
    }
    .detail-backdrop {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: var(--dp-backdrop);
        box-shadow: none;
        cursor: default;
        transition: opacity var(--dp-duration) var(--dp-ease);
    }
    /*
     * **出るときは、幕は透明から、箱は少し縮んだ姿から** (メニュー・ダイアログと同じ。`app.css`)。
     * 押したところから広げるとき (`transitionName`) は、箱の動きは画面の切り替えに任せる
     */
    .detail-box {
        transition:
            opacity var(--dp-duration) var(--dp-ease),
            transform var(--dp-duration) var(--dp-ease);
    }
    @starting-style {
        .detail-backdrop {
            opacity: 0;
        }
        .detail-box:not(.morph) {
            opacity: 0;
            transform: scale(0.96);
        }
    }
    /* 箱の見た目 (面・縁・角丸・影・幅) は `app.css` の `.modal-box` (ダイアログと同じ)。ここは中身を巻き取る並べ方だけ */
    .detail-box {
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .detail-body {
        min-height: 0;
        flex: 1 1 0%;
        overflow-y: auto;
    }
    /* 並べ方は `.modal-actions` */
    .detail-actions {
        position: relative;
        flex-shrink: 0;
    }
    .detail-actions :global(form) {
        margin: 0;
    }
</style>
