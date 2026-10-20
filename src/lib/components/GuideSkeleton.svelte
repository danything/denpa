<script lang="ts">
    /**
     * 読み込み中に出す骨組みの形。**中身の数とは関係なく決め打ち。**
     *
     * 何局あるかは表と一緒に届くので、この時点では分からない。8列ぶん出して
     * おけば、狭い画面でも広い画面でも「ここに表が来る」ことは伝わる。
     *
     * 高さは**番組の尺のつもり**でばらけさせる。全部同じ高さだと表ではなく
     * ただの縞に見えた。乱数ではなく決め打ちなのは、描き直すたびに形が変わると
     * それ自体が動いて見えるため
     */
    const SKELETON_COLUMNS = 8;
    const SKELETON_CELLS = [
        [3, 1.5, 4.5, 2, 3, 2.5, 4, 1.5, 3, 2],
        [1.5, 5, 2, 3.5, 2, 3, 1.5, 4, 2.5, 2],
        [4, 2, 2.5, 4, 1.5, 3, 2, 3.5, 2.5, 2],
        [2, 3, 6, 1.5, 2.5, 2, 4, 1.5, 3, 1.5],
        [5, 1.5, 2, 3, 2.5, 4, 1.5, 3, 2, 2.5],
        [1.5, 4, 3, 2, 3.5, 2.5, 2, 4, 2.5, 2],
        [3.5, 2.5, 1.5, 5, 2, 3, 2, 2.5, 3, 2],
        [2, 6, 2.5, 1.5, 3, 2, 3.5, 2, 2.5, 2],
    ];
</script>

<!--
    **番組表の読み込み中の骨組み。** 表の中身を待っている間 (`guide/+page.svelte`) と、ほかの画面から
    番組表へ移る途中 (`GuidePending`。`+layout.svelte`) の両方で出す。形は同じにしておく —
    読み直したときと、ほかの画面から来たときで見え方が変わらない
-->
<div
    class="skeleton"
    data-testid="guide-skeleton"
    role="status"
    aria-label="番組表を読み込んでいます"
>
    <div class="skeleton-rows" aria-hidden="true">
        {#each { length: SKELETON_COLUMNS } as _, column (column)}
            <div class="skeleton-column">
                <div class="skeleton-head"></div>
                {#each SKELETON_CELLS[column] as height, cell (cell)}
                    <div class="skeleton-block" style="height: {height}rem"></div>
                {/each}
            </div>
        {/each}
    </div>
</div>

<style>
    /*
     * 読み込み中の骨組み。**表と同じ場所・同じ高さに置く** ので、
     * 中身が届いたときに下のものが飛び跳ねない。色と光の筋は `app.css` の `.skeleton`
     */
    .skeleton {
        padding: 0.75rem;
        /* 表と同じ場所を取っておく。届いた拍子に高さが変わると画面が跳ねる */
        flex: 1 1 0%;
        min-height: 0;
    }
    .skeleton-rows {
        display: flex;
        height: 100%;
        gap: 0.5rem;
    }
    .skeleton-column {
        display: flex;
        flex: 1 1 0;
        flex-direction: column;
        gap: 0.5rem;
        /* 狭い画面では右の列がはみ出すが、外側で切る (本物の表も横に流れる) */
        min-width: 6rem;
    }
    /* 局名の行の高さ (色は `app.css`。本物と同じで、ここだけ濃い) */
    .skeleton-head {
        height: 1.75rem;
    }
</style>
