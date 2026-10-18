<script lang="ts">
    /**
     * 表示の切り替え (まとめて表示・完了した予約も表示・削除済みも表示・ファイルと照合)。
     * オン・オフの印 (`aria-checked`) 付き。頭の1行の「⋯」(`TimelineBar`) の中身
     */
    import { submitting } from '#lib/actions.js';
    import Icon from '#lib/components/player/Icon.svelte';
    import ArrowRight from '~icons/lucide/arrow-right';

    let {
        grouped,
        setGrouped,
        finishedHref,
        deletedHref,
        showFinished,
        showDeleted,
        done = () => {},
        variant = 'menu',
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
        /** 「⋯」の中 (`menu`) か、サイドバーの並び (`list`) か。形と読み上げの役割だけが変わる */
        variant?: 'menu' | 'list';
    } = $props();
    const item = $derived(variant === 'menu' ? 'menu-item view-item' : 's-item view-item');
</script>

<!--
    **表示の切り替え** (狭い画面は頭の1行の「⋯」(`TimelineBar`)、広い画面はサイドバーの「表示」)。入っているかはスイッチで見せる。
    「⋯」の中では押したら閉じる (一覧が変わるのを見せる)。
    照合は切り替えではないのでスイッチを付けない。照合は送り終えるまで開いたまま (押している間は回る印) で、終えたら閉じる
-->
{#if variant === 'menu'}
    <button
        type="button"
        role="menuitemcheckbox"
        class={item}
        aria-checked={grouped}
        onclick={() => setGrouped(!grouped)}
        data-testid="recordings-group-toggle"
    >
        <span>まとめて表示</span>
        <span class="s-switch" class:on={grouped} aria-hidden="true"></span>
    </button>
    <!-- URL で切り替えるのでリンク。入っているかはスイッチと aria-checked で -->
    <a role="menuitemcheckbox" class={item} aria-checked={showFinished} href={finishedHref}>
        <span>完了した予約も表示</span>
        <span class="s-switch" class:on={showFinished} aria-hidden="true"></span>
    </a>
    <a role="menuitemcheckbox" class={item} aria-checked={showDeleted} href={deletedHref}>
        <span>削除済みも表示</span>
        <span class="s-switch" class:on={showDeleted} aria-hidden="true"></span>
    </a>
{:else}
    <button
        type="button"
        role="switch"
        class={item}
        aria-checked={grouped}
        onclick={() => setGrouped(!grouped)}
        data-testid="recordings-group-toggle"
    >
        <span>まとめて表示</span>
        <span class="s-switch" class:on={grouped} aria-hidden="true"></span>
    </button>
    <a role="switch" class={item} aria-checked={showFinished} href={finishedHref}>
        <span>完了した予約も表示</span>
        <span class="s-switch" class:on={showFinished} aria-hidden="true"></span>
    </a>
    <a role="switch" class={item} aria-checked={showDeleted} href={deletedHref}>
        <span>削除済みも表示</span>
        <span class="s-switch" class:on={showDeleted} aria-hidden="true"></span>
    </a>
{/if}
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
    <button
        type="submit"
        role={variant === 'menu' ? 'menuitem' : undefined}
        class={item}
        data-keep-open
        data-testid="reconcile-button"
    >
        <span>ファイルと照合</span>
        {#if variant === 'list'}<Icon icon={ArrowRight} size="size-4" />{/if}
    </button>
</form>
