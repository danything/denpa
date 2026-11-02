<!--
    テレビのペアリングを済ませる画面。**開いただけでは済ませない** (理由は +page.server.ts)。
    端末の名前とコードを出し、テレビに出ているコードと同じか見比べてから押してもらう (RFC 8628 の 5.4)。
    JavaScript が動かない端末でも、同じボタンで送れる。画面では「ペアリングコード」と呼ぶ
-->

<script lang="ts">
  let { data, form } = $props();

  const view = $derived(form?.view ?? data.view);
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
  {:else if view.state === "pending"}
    <h1>{view.name} とペアリングしますか</h1>
    <p class="code" data-testid="device-code">{view.userCode}</p>
    <p>
      テレビに出ているコードと同じなら「ペアリング」を押してください。違うときや、人から送られてきたリンクのときは押さずに閉じてください。
    </p>
    <form method="POST" class="actions">
      <input type="hidden" name="code" value={view.userCode} />
      <button type="submit" data-testid="device-approve">ペアリング</button>
    </form>
  {:else if view.state === "approved" || view.state === "consumed"}
    <h1 data-testid="device-done">{view.name} とペアリングしました</h1>
    <p>テレビに戻ってください。</p>
  {:else}
    <h1>このペアリングコードは期限切れです</h1>
    <p>テレビでペアリングをやり直してください。コードの期限は10分です。</p>
  {/if}
</div>

<style>
  /* 見比べるもの。字の幅を揃え、少し離して読み違えないように */
  .code {
    color: var(--dp-fg);
    font-family: var(--dp-font-mono);
    font-size: var(--dp-text-xl);
    font-weight: var(--dp-weight-bold);
    letter-spacing: 0.12em;
    font-variant-numeric: tabular-nums;
  }
</style>
