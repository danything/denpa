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
        actions,
    }: {
        program: ProgramDetail;
        onclose: () => void;
        notes?: { title: string; text: string }[];
        cmNote?: string | null;
        actions?: Snippet;
    } = $props();
</script>

<!--
    **高さは `%` で採る** (`app.css` で `html` に高さを与えてある)。

    daisyUI の既定は、外枠が `position: fixed; inset: 0`、中身が `max-height: 100vh`。
    これは**アドレスバーが引っ込んだときの高さ**を指すので、スマホでバーが
    出ていると**中身が画面より高くなる**。外枠は `overflow: clip` なので、
    はみ出したぶんは上下とも切り落とされ、**題名も閉じるボタンも見えなくなる**
    (実機の Android Chrome)。

    `dvh` に替えていたが、**それでも合わない端末があった** (実機の PWA で
    56px 大きく出た)。単位で言い当てず `%` で採る — 外枠は
    `position: fixed` なので、その `100%` は**そのページが縦に動かずに
    出せる高さ**そのものになる。中身はその中で巻き取らせる (`max-h-full`)。
    上下に少し余白を置いて、中身はその中で巻き取らせる (`max-h-full` +
    daisyUI の `overflow-y: auto`)。
-->
<div class="modal modal-open h-full py-4" role="dialog" data-testid="program-detail">
    <!--
        **巻き取るのは中身だけ。** 箱ごとスクロールさせていた頃は、番組の説明が
        長いと押すもの (テレビで再生・閉じる) が下に流れて、**開いた時点では
        見えなかった**。中身を自分の枠で巻き取らせ、押すものは箱の下端に
        貼り付けたまま出しておく (FactsAside と同じ考え方)
    -->
    <div class="modal-box flex max-h-full max-w-2xl flex-col">
        <div class="min-h-0 flex-1 overflow-y-auto">
            <ProgramFacts {program} {notes} {cmNote} />
        </div>

        <!--
            **枠はこちらで持つ。** 渡す側に任せていた頃は、フォームが行を占める
            箱なので押すものが縦に積み上がり、左端に寄っていた。
            `modal-action` は右下に横並びなので、どこから開いても同じ形になる。
            **閉じるはいちばん右。** 並びの終わりがいつも同じところにあると、
            見ないでも押せる
        -->
        <div class="modal-action shrink-0">
            {#if actions}
                {@render actions()}
            {:else}
                <button type="button" class="btn" onclick={onclose} data-testid="detail-close">閉じる</button>
            {/if}
        </div>
    </div>
    <button type="button" class="modal-backdrop" onclick={onclose} aria-label="閉じる"></button>
</div>
