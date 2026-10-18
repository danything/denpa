<script lang="ts">
    /**
     * 表示の切り替え (まとめて表示・完了した予約も表示・削除済みも表示・ファイルと照合)。
     * オン・オフの印 (`aria-checked`) 付き。頭の1行の「⋯」(`TimelineBar`) の中身
     */
    import { submitting } from '#lib/actions.js';

    let {
        grouped,
        setGrouped,
        finishedHref,
        deletedHref,
        showFinished,
        showDeleted,
        done = () => {},
    }: {
        grouped: boolean;
        setGrouped: (on: boolean) => void;
        /** 「完了した予約も表示」「削除済みも表示」の行き先 (入っていれば外した URL) */
        finishedHref: string;
        deletedHref: string;
        showFinished: boolean;
        showDeleted: boolean;
        /** 照合を送り終えたあとにすること (メニューを閉じる) */
        done?: () => void;
    } = $props();
</script>

<!--
    **頭の1行の「⋯」の中身** (`TimelineBar`)。入っているかはスイッチで見せる。押したら閉じる (一覧が変わるのを見せる)。
    照合は切り替えではないのでスイッチを付けない。照合は送り終えるまで開いたまま (押している間は回る印) で、終えたら閉じる
-->
<button
    type="button"
    role="menuitemcheckbox"
    class="menu-item view-item"
    aria-checked={grouped}
    onclick={() => setGrouped(!grouped)}
    data-testid="recordings-group-toggle"
>
    <span>まとめて表示</span>
    <span class="s-switch" class:on={grouped} aria-hidden="true"></span>
</button>
<!-- URL で切り替えるのでリンク。入っているかはスイッチと aria-checked で -->
<a role="menuitemcheckbox" class="menu-item view-item" aria-checked={showFinished} href={finishedHref}>
    <span>完了した予約も表示</span>
    <span class="s-switch" class:on={showFinished} aria-hidden="true"></span>
</a>
<a role="menuitemcheckbox" class="menu-item view-item" aria-checked={showDeleted} href={deletedHref}>
    <span>削除済みも表示</span>
    <span class="s-switch" class:on={showDeleted} aria-hidden="true"></span>
</a>
<!-- 照合は送り終えてから閉じる (先に閉じると、結果の通知が出る前に消える。押している間は回る印) -->
<form
    method="POST"
    action="?/reconcile"
    class="menu-form"
    use:submitting={() => async (options) => {
        await options.update();
        done();
    }}
>
    <button type="submit" role="menuitem" class="menu-item view-item" data-keep-open data-testid="reconcile-button">
        <span>ファイルと照合</span>
    </button>
</form>
