<!--
    テレビのペアリングを済ませる画面 (+page.server.ts)。

    開いたらすぐ自分でフォームを送る (許すのは POST の側。先読みで黙って済まないように)。
    JavaScript が動かない端末には、同じフォームのボタンを出す。
    コードは出さない (QR の URL に入って自動で渡り、見比べる相手がいない)。済んだら端末の名前を出す。
    **画面では「ペアリングコード」と呼ぶ** — 以前は内部の呼び名のまま
    「見つかりません」と出していて、何のことか読めなかった
-->

<script lang="ts">
  import { onMount } from "svelte";

  let { data, form } = $props();

  const view = $derived(form?.view ?? data.view);
  // 送る前の `form` は SvelteKit では null のことも undefined のこともある。どちらも「まだ送っていない」
  const pending = $derived(
    !form && !data.viaToken && data.view?.state === "pending",
  );

  let auto: HTMLFormElement | undefined = $state();
  onMount(() => {
    if (pending) auto?.requestSubmit();
  });
</script>

<svelte:head><title>テレビのペアリング - denpa</title></svelte:head>

<div class="solo glow" data-testid="device-page">
  {#if data.viaToken || form?.viaToken}
    <h1>アクセストークンではペアリングできません</h1>
    <p>
      テレビのペアリングは、ブラウザ (信頼するネットワークか OIDC のログイン)
      で開いてください。
    </p>
  {:else if view === null}
    <h1>このペアリングコードは見つかりません</h1>
    <p>
      QR
      を読み直すか、テレビでペアリングをやり直してください。コードの期限は10分です。
    </p>
  {:else if pending}
    <h1>{view.name} とペアリングしています…</h1>
    <form method="POST" bind:this={auto}>
      <input type="hidden" name="code" value={view.userCode} />
      <noscript><button type="submit">ペアリング</button></noscript>
    </form>
  {:else if view.state === "approved" || view.state === "consumed"}
    <h1 data-testid="device-done">{view.name} とペアリングしました</h1>
    <p>テレビに戻ってください。</p>
  {:else}
    <h1>このペアリングコードは期限切れです</h1>
    <p>テレビでペアリングをやり直してください。コードの期限は10分です。</p>
  {/if}
</div>
