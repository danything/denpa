<script lang="ts">
    import type { Snippet } from 'svelte';
    import { submitting } from '#lib/actions.js';

    /**
     * 押すとアクションを1つ送るだけのボタン (`<form method="POST">` + 隠し欄 + 送るボタン)。
     * 送っている間の見た目と二度押し止めは `submitting` が持つ
     */
    let {
        action,
        fields = {},
        class: kind = '',
        testid,
        disabled = false,
        children,
    }: {
        action: string;
        /** 一緒に送る隠し欄 (名前 → 値) */
        fields?: Record<string, string | number>;
        /** ボタンの見た目 (app.css の `xs` / `outline` / `danger` など) */
        class?: string;
        testid?: string;
        disabled?: boolean;
        children: Snippet;
    } = $props();
</script>

<form method="POST" {action} use:submitting>
    {#each Object.entries(fields) as [name, value] (name)}
        <input type="hidden" {name} {value} />
    {/each}
    <button type="submit" class={kind} {disabled} data-testid={testid}>{@render children()}</button>
</form>
