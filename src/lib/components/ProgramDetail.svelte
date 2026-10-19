<script lang="ts">
    import type { Snippet } from 'svelte';
    import ProgramFacts from '#lib/components/ProgramFacts.svelte';
    import type { ProgramDetail } from '#lib/types.js';
    import X from '~icons/lucide/x';

    /**
     * 番組の詳細を出すモーダル。
     *
     * 番組表・ホーム (録画)・検索のどこから開いても同じ見え方にするため、ここに寄せてある。
     * 下に並べるボタンと、番組名の上に出す状態 (予約済み・放送終了など) だけは開いた場所で違うので
     * snippet で受ける (`actions`・`status`)。
     *
     * **閉じるのは右上の × だけ** (幕を押しても Esc でも閉じる)。下の並びに「閉じる」を置いていた頃は、
     * 押すものがどれも同じ控えのボタンで、どれが主なのか読めなかった。下には主のボタン (再生・予約) を
     * 1つだけ塗りで置き、ほかは控えにする。並びは主がいちばん右 (狭い画面では下から出る一枚になり、
     * 主がいちばん上の全幅のボタン)。
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
        status,
        transitionName,
    }: {
        program: ProgramDetail;
        onclose: () => void;
        notes?: { title: string; text: string }[];
        cmNote?: string | null;
        /** エンコードしたもののコマ数。録画から開いたときだけ入る (ProgramFacts へ素通し) */
        fps?: number | null;
        actions?: Snippet | undefined;
        /** 番組名の上に出す状態のバッジ (予約済み・放送終了)。押すものの並びには混ぜない */
        status?: Snippet | undefined;
        /**
         * 箱に付ける画面の切り替えの名前 (View Transitions)。押した要素から広げて開くとき
         * (番組表のマス。`#lib/motion.svelte.ts` の `morph`) だけ渡す
         */
        transitionName?: string | undefined;
    } = $props();

    let box: HTMLDivElement | undefined = $state();
</script>

<svelte:window
    onkeydown={(e) => {
        // 箱の中で開いたメニュー (「その他…」) があれば、Esc はそれを閉じるだけにする (よそのポップオーバーは見ない)
        if (e.key === 'Escape' && !e.defaultPrevented && box?.querySelector(':popover-open') == null) onclose();
    }}
/>

<!--
    **高さは `%` で採る** (`app.css` で `html` に高さを与えてある)。
    `vh` はアドレスバーが引っ込んだときの高さ、`dvh` も端末 (PWA) によって合わない。
    外枠は `position: fixed` なので、その `100%` は**そのページが縦に動かずに
    出せる高さ**そのものになる。上下に少し余白を置いて、中身はその中で巻き取らせる。

    `<dialog>` にはしていない。開閉は渡す側が持っている (出すときだけ描く) ので、
    ここは箱と背景だけで足りる
-->
<div class="detail-modal" role="dialog" aria-modal="true" data-testid="program-detail">
    <button type="button" class="detail-backdrop" onclick={onclose} aria-label="閉じる" tabindex="-1"></button>
    <!--
        **巻き取るのは中身だけ。** 押すものは箱の下端に貼り付けたまま出しておく
        (説明が長くても開いた時点で見える。FactsAside と同じ考え方)
    -->
    <div bind:this={box} class="detail-box modal-box" class:morph={transitionName !== undefined} style:view-transition-name={transitionName}>
        <button type="button" class="ghost icon small modal-close" onclick={onclose} aria-label="閉じる" data-testid="detail-close">
            <X aria-hidden="true" />
        </button>
        <div class="detail-body">
            {#if status}
                <div class="cluster detail-status">{@render status()}</div>
            {/if}
            <ProgramFacts {program} {notes} {cmNote} {fps} />
        </div>

        {#if actions}
            <div class="detail-actions modal-actions">
                {@render actions()}
            </div>
        {/if}
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
    /* 番組名と状態は × に掛からないところで折り返す (× は箱の右上に浮かせる。`app.css` の `.modal-close`) */
    .detail-body > :global(.title),
    .detail-status {
        padding-inline-end: 2.25rem;
    }
    .detail-status {
        margin-bottom: var(--dp-space-2);
    }
    /* 狭い画面では下から出る一枚 (箱の形は `app.css` の `.modal-box`) */
    @media (max-width: 639.98px) {
        .detail-modal {
            align-items: flex-end;
        }
        @starting-style {
            .detail-box:not(.morph) {
                transform: translateY(1rem);
            }
        }
    }
</style>
