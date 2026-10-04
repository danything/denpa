<!--
    テレビのペアリングを済ませる画面 (+page.server.ts)。

    開いたらすぐ自分でフォームを送る (許すのは POST の側。先読みで黙って済まないように)。
    JavaScript が動かない端末には、同じフォームのボタンを出す。
    札 (ABCD-EFGH) は済んだあとも出す — テレビに出ている札と見比べられるように
-->

<script lang="ts">
    import { onMount } from 'svelte';

    let { data, form } = $props();

    const view = $derived(form?.view ?? data.view);
    const pending = $derived(form === null && data.view?.state === 'pending');

    let auto: HTMLFormElement | undefined = $state();
    onMount(() => {
        if (pending) auto?.requestSubmit();
    });
</script>

<svelte:head><title>テレビの設定 - denpa</title></svelte:head>

<div class="wrap">
    <div class="panel card" data-testid="device-card">
        {#if view === null}
            <h1>この札は見つかりません</h1>
            <p class="small muted">
                QR を読み直すか、テレビでペアリングをやり直してください。札は10分で切れます。
            </p>
        {:else if pending}
            <h1>{view.name} を設定しています…</h1>
            <p class="code mono" data-testid="device-code">{view.userCode}</p>
            <form method="POST" bind:this={auto}>
                <input type="hidden" name="code" value={view.userCode} />
                <noscript><button type="submit">設定する</button></noscript>
            </form>
        {:else if view.state === 'approved' || view.state === 'consumed'}
            <h1 data-testid="device-done">{view.name} を設定しました</h1>
            <p class="code mono" data-testid="device-code">{view.userCode}</p>
            <p class="small muted">テレビに戻ってください。テレビに出ている札と同じなら済んでいます。</p>
        {:else}
            <h1>この札は切れています</h1>
            <p class="code mono">{view.userCode}</p>
            <p class="small muted">テレビでペアリングをやり直してください。札は10分で切れます。</p>
        {/if}
    </div>
</div>

<style>
    .wrap {
        display: flex;
        min-height: 60vh;
        align-items: center;
        justify-content: center;
        padding: 1rem;
    }
    .card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        max-width: 24rem;
        padding: 2rem;
        text-align: center;
    }
    .code {
        font-size: 1.5rem;
        letter-spacing: 0.1em;
    }
</style>
