<!--
    テレビのペアリングを済ませる画面 (+page.server.ts)。

    開いたらすぐ自分でフォームを送る (許すのは POST の側。先読みで黙って済まないように)。
    JavaScript が動かない端末には、同じフォームのボタンを出す。
    札は出さない (QR の URL に入って自動で渡り、見比べる相手がいない)。済んだら端末の名前を出す
-->

<script lang="ts">
    import { onMount } from 'svelte';

    let { data, form } = $props();

    const view = $derived(form?.view ?? data.view);
    // 送る前の `form` は SvelteKit では null のことも undefined のこともある。どちらも「まだ送っていない」
    const pending = $derived(!form && !data.viaToken && data.view?.state === 'pending');

    let auto: HTMLFormElement | undefined = $state();
    onMount(() => {
        if (pending) auto?.requestSubmit();
    });
</script>

<svelte:head><title>テレビの設定 - denpa</title></svelte:head>

<div class="wrap">
    <div class="panel card" data-testid="device-card">
        {#if data.viaToken || form?.viaToken}
            <h1 data-testid="device-refused">アプリの鍵では設定できません</h1>
            <p class="small muted">
                テレビのペアリングは、ブラウザ (信頼するネットワークか OIDC のログイン) で開いてください。
            </p>
        {:else if view === null}
            <h1>この札は見つかりません</h1>
            <p class="small muted">
                QR を読み直すか、テレビでペアリングをやり直してください。札は10分で切れます。
            </p>
        {:else if pending}
            <h1>{view.name} を設定しています…</h1>
            <form method="POST" bind:this={auto}>
                <input type="hidden" name="code" value={view.userCode} />
                <noscript><button type="submit">設定する</button></noscript>
            </form>
        {:else if view.state === 'approved' || view.state === 'consumed'}
            <h1 data-testid="device-done">{view.name} を設定しました</h1>
            <p class="small muted">テレビに戻ってください。</p>
        {:else}
            <h1>この札は切れています</h1>
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
</style>
