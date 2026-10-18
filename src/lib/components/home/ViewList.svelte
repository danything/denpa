<script lang="ts">
    /**
     * 表示の切り替え (まとめて表示・完了した予約も表示・削除済みも表示・ファイルと照合)。
     * オン・オフの印 (`aria-pressed`) 付き。サイドバーと下からの一枚で同じもの
     */
    import { submitting } from '#lib/actions.js';
    import Icon from '#lib/components/player/Icon.svelte';
    import Check from '~icons/lucide/check';

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
        /** 「完了分も表示」「削除済みも表示」の行き先 (入っていれば外した URL) */
        finishedHref: string;
        deletedHref: string;
        showFinished: boolean;
        showDeleted: boolean;
        /** 照合を送り終えたあとにすること (一枚を閉じる) */
        done?: () => void;
    } = $props();
</script>

<div class="s-list" role="group" aria-label="表示の切り替え">
    <button
        type="button"
        class="s-item"
        aria-pressed={grouped}
        onclick={() => setGrouped(!grouped)}
        data-testid="recordings-group-toggle"
    >
        <span>まとめて表示</span>
        <span class="s-sub">{#if grouped}<Icon icon={Check} size="size-4" />{/if}</span>
    </button>
    <!-- URL で切り替えるのでリンク。入っているかは印と、読み上げには「オン」で -->
    <a class="s-item" href={finishedHref} data-testid="reservations-finished-toggle" data-on={showFinished}>
        <span>完了した予約も表示</span>
        <span class="s-sub">
            {#if showFinished}<Icon icon={Check} size="size-4" /><span class="visually-hidden">オン</span>{/if}
        </span>
    </a>
    <a class="s-item" href={deletedHref} data-testid="recordings-deleted-toggle" data-on={showDeleted}>
        <span>削除済みも表示</span>
        <span class="s-sub">
            {#if showDeleted}<Icon icon={Check} size="size-4" /><span class="visually-hidden">オン</span>{/if}
        </span>
    </a>
    <!-- 照合は送り終えてから閉じる (先に閉じると、結果の通知が出る前に一枚が消える) -->
    <form
        method="POST"
        action="?/reconcile"
        class="menu-form"
        use:submitting={() => async (options) => {
            await options.update();
            done();
        }}
    >
        <button type="submit" class="s-item" data-testid="reconcile-button"><span>ファイルと照合</span></button>
    </form>
</div>
