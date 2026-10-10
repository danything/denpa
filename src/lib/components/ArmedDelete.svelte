<script lang="ts">
    import { submitting } from '#lib/actions.js';
    import type { Arming } from '#lib/arming.svelte.js';
    import type { SubmitFunction } from '$app/forms';

    /**
     * 消すボタン。**1回目で聞き返し、2回目で送る** (`arming`。録画・予約・ルール・通知先で同じ)。
     * 幅が変わるとボタンが動いて押し間違えるので、どちらも2文字で揃える。
     *
     * 構えの鍵 (`armKey`) は同じ `deleting` を分け合う中で被らない値にする
     * (録画の一覧は録画と録り逃しの予約で共用するので、予約は負の値)
     */
    let {
        deleting,
        armKey,
        action = '?/delete',
        fields,
        submit,
        class: size = '',
        testid,
        confirmTestid = `${testid}-confirm`,
    }: {
        deleting: Arming;
        armKey: number;
        action?: string;
        /** 一緒に送る隠し欄 (名前 → 値) */
        fields: Record<string, string | number>;
        /** 送ったあとの始末 (`submitting` にそのまま渡す) */
        submit?: SubmitFunction;
        /** 大きさ (app.css の `xs` / `small`) */
        class?: string;
        testid: string;
        confirmTestid?: string;
    } = $props();

    /** 送り終えたら構えを下ろす。断られて行が残ったとき、「確定」を出したままにしない */
    const sent: SubmitFunction = (input) => {
        const after = submit?.(input);
        return async (options) => {
            if (typeof after === 'function') await after(options);
            else await options.update();
            deleting.fire();
        };
    };
</script>

<form method="POST" {action} use:submitting={sent}>
    {#each Object.entries(fields) as [name, value] (name)}
        <input type="hidden" {name} {value} />
    {/each}
    {#if deleting.armed === armKey}
        <button type="submit" class="{size} danger" data-testid={confirmTestid}>確定</button>
    {:else}
        <button type="button" class="{size} outline danger" onclick={() => deleting.arm(armKey)} data-testid={testid}>
            削除
        </button>
    {/if}
</form>
