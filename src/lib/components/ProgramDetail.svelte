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
    **高さは `dvh` で採る。**

    daisyUI の既定は、外枠が `position: fixed; inset: 0`、中身が `max-height: 100vh`。
    どちらも**アドレスバーが引っ込んだときの高さ**を指すので、スマホでバーが
    出ていると**中身が画面より高くなる**。外枠は `overflow: clip` なので、
    はみ出したぶんは上下とも切り落とされ、**題名も閉じるボタンも見えなくなる**
    (実機の Android Chrome)。

    `dvh` は「いま見えている高さ」なので、バーの出入りにそのまま追従する。
    上下に少し余白を置いて、中身はその中で巻き取らせる (`max-h-full` +
    daisyUI の `overflow-y: auto`)。
-->
<div class="modal modal-open h-[100dvh] py-4" role="dialog" data-testid="program-detail">
    <div class="modal-box max-h-full max-w-2xl">
        <ProgramFacts {program} {notes} {cmNote} />

        <!--
            **枠はこちらで持つ。** 渡す側に任せていた頃は、フォームが行を占める
            箱なので押すものが縦に積み上がり、左端に寄っていた。
            `modal-action` は右下に横並びなので、どこから開いても同じ形になる。
            **閉じるはいちばん右。** 並びの終わりがいつも同じところにあると、
            見ないでも押せる
        -->
        <div class="modal-action">
            {#if actions}
                {@render actions()}
            {:else}
                <button class="btn" onclick={onclose} data-testid="detail-close">閉じる</button>
            {/if}
        </div>
    </div>
    <button class="modal-backdrop" onclick={onclose} aria-label="閉じる"></button>
</div>
