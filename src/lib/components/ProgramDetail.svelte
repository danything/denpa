<script lang="ts">
    import type { Snippet } from 'svelte';
    import ProgramFacts from '$lib/components/ProgramFacts.svelte';
    import type { ProgramDetail } from '$lib/types';

    /**
     * 番組の詳細を出すモーダル。
     *
     * 番組表・予約一覧・録画一覧のどこから開いても同じ見え方にするため、ここに寄せてある。
     * 下に並べるボタンだけは開いた場所で違う(番組表なら予約、一覧なら閉じるだけ)ので
     * snippet で受ける。
     *
     * **中身は `ProgramFacts` が持っている** — 録画を観る画面 (`routes/watch/[id]`) は
     * 枠なしで同じものを左に置くため。
     */
    let {
        program,
        onclose,
        notes = [],
        cmNote = null,
        fps = null,
        actions,
    }: {
        program: ProgramDetail;
        onclose: () => void;
        notes?: { title: string; text: string }[];
        cmNote?: string | null;
        /** 焼いたもののコマ数。録画から開いたときだけ入る (ProgramFacts へ素通し) */
        fps?: number | null;
        actions?: Snippet | undefined;
    } = $props();
</script>

<!--
    **高さは `%` で採る** (`app.scss` で `html` に高さを与えてある)。

    中身を `max-height: 100vh` にすると、それは**アドレスバーが引っ込んだときの高さ**
    を指すので、スマホでバーが出ていると**中身が画面より高くなる**。外枠が
    はみ出しを切っていると、**題名も閉じるボタンも見えなくなる** (実機の Android Chrome、
    daisyUI の modal だった頃)。

    `dvh` に替えていたが、**それでも合わない端末があった** (実機の PWA で
    56px 大きく出た)。単位で言い当てず `%` で採る — 外枠は
    `position: fixed` なので、その `100%` は**そのページが縦に動かずに
    出せる高さ**そのものになる。上下に少し余白を置いて、中身はその中で巻き取らせる。

    Bits UI の Dialog にはしていない。開閉は渡す側が持っている (出すときだけ描く) ので、
    ここは箱と背景だけで足りる
-->
<div class="detail-modal" role="dialog" aria-modal="true" data-testid="program-detail">
    <button type="button" class="detail-backdrop" onclick={onclose} aria-label="閉じる"></button>
    <!--
        **巻き取るのは中身だけ。** 箱ごとスクロールさせていた頃は、番組の説明が
        長いと押すもの (テレビで再生・閉じる) が下に流れて、**開いた時点では
        見えなかった**。中身を自分の枠で巻き取らせ、押すものは箱の下端に
        貼り付けたまま出しておく (FactsAside と同じ考え方)
    -->
    <div class="detail-box">
        <div class="detail-body">
            <ProgramFacts {program} {notes} {cmNote} {fps} />
        </div>

        <!--
            **枠はこちらで持つ。** 渡す側に任せていた頃は、フォームが行を占める
            箱なので押すものが縦に積み上がり、左端に寄っていた。
            右下に横並びなので、どこから開いても同じ形になる。
            **閉じるはいちばん右。** 並びの終わりがいつも同じところにあると、
            見ないでも押せる。
            **入り切らなければ折り返す** (`flex-wrap`)。一列に押し込むと、
            スマホ幅で 4 つ並んだときにボタンが縮んで文字が縦に折れ、
            左端が枠の外に切れていた。
            **`position: relative` は「その他…」のメニューの基準。** メニューはボタン
            ではなくこの枠を基準に開くので、ボタンが枠の真ん中に折り返されても、
            メニューは枠の右端に揃って枠の幅の中に収まる
        -->
        <div class="detail-actions">
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
        padding: 1rem 0;
        box-sizing: border-box;
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
        background: rgb(0 0 0 / 0.55);
        box-shadow: none;
        cursor: default;
    }
    .detail-box {
        position: relative;
        display: flex;
        flex-direction: column;
        width: calc(100% - 2rem);
        max-width: 42rem;
        max-height: 100%;
        padding: 1.5rem;
        box-sizing: border-box;
        border-radius: 1rem;
        background: var(--dp-surface);
        border: 1px solid var(--dp-base-300);
        box-shadow: 0 20px 50px rgb(0 0 0 / 0.45);
    }
    .detail-body {
        min-height: 0;
        flex: 1 1 0%;
        overflow-y: auto;
    }
    .detail-actions {
        position: relative;
        display: flex;
        flex-shrink: 0;
        flex-wrap: wrap;
        justify-content: flex-end;
        align-items: center;
        gap: 0.5rem;
        margin-top: 1.5rem;
    }
    .detail-actions :global(form) {
        margin: 0;
    }
</style>
