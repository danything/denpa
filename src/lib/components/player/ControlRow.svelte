<script lang="ts">
    import type { Snippet } from 'svelte';

    /**
     * 下の帯の「押すものの行」。**3画面で同じ並び** — 再生・音・字幕が左から順で、
     * 全画面がいちばん右。画面を移っても同じ場所にあると、見ないでも押せる
     */
    let { testid, children }: { testid?: string; children: Snippet } = $props();
</script>

<div class="cluster row" data-testid={testid}>
    {@render children()}
</div>

<style>
    .row {
        --gap: 0.25rem;
        margin-top: 0.25rem;
        color: #fff;
    }
    /* 狭い枠では全画面だけ右端へ寄せる (読みものが上の行へ移って、間を埋めるものが無い) */
    :global(.stage[data-compact]) .row > :global(:last-child) {
        margin-left: auto;
    }
</style>
