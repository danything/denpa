<script lang="ts">
    import type { Snippet } from 'svelte';
    import ProgramFacts from '#lib/components/ProgramFacts.svelte';
    import type { ProgramDetail } from '#lib/types.js';

    /**
     * 番組の詳細を出すモーダル。
     *
     * 番組表・ホーム (録画)・検索のどこから開いても同じ見え方にするため、ここに寄せてある。
     * 下に並べるボタンと、番組名の上に出す状態 (予約済み・放送終了など) だけは開いた場所で違うので
     * snippet で受ける (`actions`・`status`)。
     *
     * **閉じるは左下の「閉じる」** (幕を押しても Esc でも閉じる)。主のボタン (再生・予約) は右下に
     * 1つだけ塗りで置き、ほかは控えにする。閉じるを右の並びに混ぜていた頃は、どれも同じ控えのボタンで
     * どれが主なのか読めず、右上の × にしたら × がスクロールバーに重なった。左右に分ければ主が埋もれない
     * (狭い画面では下から出る一枚になり、主がいちばん上・閉じるがいちばん下の全幅のボタン)。
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
    /** 下に重ねたボタンの並びの高さ。中身の最後の行がその上まで巻き上がるよう、下に同じだけ空ける */
    let actionsHeight = $state(0);
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
        **巻き取るのは中身だけ。** 押すものは箱の下端に重ねたまま出しておく
        (説明が長くても開いた時点で見える。FactsAside と同じ考え方)。並びの地は塗らず、
        中身はボタンの間と後ろに透けて見える (下に地の帯を敷くと、そこだけ何も書いていない帯になった)。
        続きがあるときは、ボタンの手前で中身を薄く消していく (下の CSS)
    -->
    <div bind:this={box} class="detail-box modal-box" class:morph={transitionName !== undefined} style:view-transition-name={transitionName}>
        <!--
            フェードの長さ (`animation-duration`) は要素に直に書く。時間で動くものではない (巻き取った量で濃さが
            決まるだけ) が、動きを減らす設定で Pico の層が `!important` で 1ms に縮める。層の中の `!important` には
            層の外の規則では勝てず、要素に直に書いたものだけが勝つ
        -->
        <div class="detail-body" style:--detail-bottom={`calc(${actionsHeight}px + 2 * var(--dp-space-5))`} style:animation-duration|important="auto">
            {#if status}
                <div class="cluster detail-status">{@render status()}</div>
            {/if}
            <ProgramFacts {program} {notes} {cmNote} {fps} />
        </div>

        <div class="detail-actions modal-actions" bind:offsetHeight={actionsHeight}>
            <button type="button" class="secondary detail-close" onclick={onclose} data-testid="detail-close">閉じる</button>
            {#if actions}
                {@render actions()}
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
        /*
         * **巻き取るのは箱いっぱいの中身** (余白は中身の側で取る)。スクロールバーは箱の右端に出る
         * (余白の内側に出すと、字のすぐ横に浮いて見えた)。中身は箱の下端まで巻き取り、ボタンの並びは上に重ねる
         */
        padding: 0;
    }
    .detail-body {
        min-height: 0;
        flex: 1 1 0%;
        overflow-y: auto;
        padding: var(--dp-space-5);
        /* 最後の行がボタンの並びの上まで上がりきるよう、並びの高さと上下の余白ぶん空ける */
        padding-bottom: var(--detail-bottom);
    }
    /*
     * **続きがあるときだけ、ボタンの手前で中身を薄く消していく** (フェード)。字がボタンの後ろを
     * そのまま通ると、ボタンも字も読みにくい。マスクは箱 (巻き取る枠) に掛かるので、中身を巻き取っても
     * 消える位置はボタンの手前のまま。濃さ (`--detail-fade`) は巻き取った量で決め、いちばん下まで
     * 読んだら消える (最後の行がはっきり見える)。巻き取れないほど短い中身では掛からない
     * (スクロールの物差しが無いので `--detail-fade` は初めの 0 のまま)。スクロール連動のアニメーションが
     * 無いブラウザでは、アニメーションがすぐ終わって 0 になり、フェードの無い形になる
     */
    .detail-body {
        mask-image: linear-gradient(
            to bottom,
            #000 calc(100% - var(--detail-bottom) - 1.5rem),
            rgb(0 0 0 / calc(1 - 0.85 * var(--detail-fade))) calc(100% - var(--detail-bottom) + 1rem)
        );
        animation: detail-fade auto linear both;
        animation-timeline: scroll(self);
    }
    @keyframes detail-fade {
        0%,
        92% {
            --detail-fade: 1;
        }
        100% {
            --detail-fade: 0;
        }
    }
    /*
     * 並べ方は `.modal-actions`。箱の下端に重ね、地は塗らない。ボタンの無い所は押しても中身に届く
     * (字を選ぶ・巻き取る)。閉じるは左端、ほかは右に寄せる
     */
    .detail-actions {
        position: absolute;
        inset-inline: var(--dp-space-5);
        bottom: var(--dp-space-5);
        margin: 0;
        pointer-events: none;
    }
    .detail-actions > :global(*) {
        pointer-events: auto;
    }
    .detail-actions :global(form) {
        margin: 0;
    }
    .detail-close {
        margin-inline-end: auto;
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
