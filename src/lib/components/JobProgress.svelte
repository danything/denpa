<script lang="ts">
    import type { Snippet } from 'svelte';

    /**
     * 時間の掛かる仕事の進み具合 (チャンネルスキャン・ロゴの取得・引き継ぎ)。
     * **帯と「いくつ中いくつ」をいつも組で出す** — 帯だけでは、止まっているのか
     * 遅いだけなのかが読めない。後ろに添えるもの (いま何をしているか) は `children`
     */
    let {
        done,
        total,
        unit = '',
        testid,
        children,
    }: { done: number; total: number; unit?: string; testid?: string; children?: Snippet } = $props();
</script>

<progress value={done} max={Math.max(1, total)}></progress>
<div class="tiny soft" data-testid={testid}>
    <span>{done} / {total}{unit === '' ? '' : ` ${unit}`}</span>
    {#if children}{@render children()}{/if}
</div>
