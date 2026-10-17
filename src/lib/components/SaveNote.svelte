<script lang="ts">
    import type { SaveState } from '#lib/autosave.svelte.js';

    /**
     * その場で保存した結果を、節の見出しの横に小さく出す (`autosave`)。
     * 枠はいつも置いておき (読み上げに知らせる `role="status"`)、中身だけ替える
     */
    let { status }: { status: SaveState } = $props();
</script>

<span class="save-note tiny" role="status">
    {#if status.state === 'saving'}
        <span class="muted">保存中…</span>
    {:else if status.state === 'saved'}
        <span class="saved" data-testid="saved-result">保存しました</span>
    {:else if status.state === 'error'}
        <span class="text-error" data-testid="settings-error">
            保存できませんでした{status.message === '' ? '' : `: ${status.message}`}
        </span>
    {/if}
</span>

<style>
    .save-note {
        font-weight: normal;
    }
    .saved {
        color: var(--dp-ok-text);
    }
</style>
