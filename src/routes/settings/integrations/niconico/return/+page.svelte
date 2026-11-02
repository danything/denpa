<script lang="ts">
  import { afterNavigate, goto, replaceState } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";

  /**
   * **ニコニコとの連携の戻り先** (denpa-hub がここへ返す。パスは hub との約束で `#lib/niconico.ts` の `RETURN_PATH`)。
   * フラグメントの `#result=` (hub が denpa のサーバの鍵で暗号化したトークン) か `#error=` を読み、
   * **すぐに URL から消してから** `result` をサーバへ送る (履歴に残さない)。つながったら設定の「実況」へ戻る。
   * 失敗したときはここに理由を出す
   */
  /** 戻る先 (設定の「連携」の「実況」) */
  const back = `${resolve("/settings/integrations")}#jikkyo`;
  let message = $state("連携しています…");
  let failed = $state(false);

  function fail(text: string): void {
    message = text;
    failed = true;
  }

  // ルーターが動き出してから (`replaceState` は onMount の時点ではまだ呼べない)。開いたときに 1 回だけ
  let started = false;
  afterNavigate(() => {
    if (started) return;
    started = true;
    void finish();
  });

  async function finish(): Promise<void> {
    const params = new URLSearchParams(location.hash.slice(1));
    replaceState(page.url.pathname, page.state);
    const error = params.get("error");
    const result = params.get("result");
    if (error !== null)
      return fail(
        error === "access_denied"
          ? "ニコニコで許可されなかったため、連携しませんでした"
          : `連携できませんでした (${error})`,
      );
    if (result === null)
      return fail(
        "連携の結果がありません。設定の「連携」の「実況」からやり直してください",
      );
    try {
      const res = await fetch(
        resolve("/settings/integrations/niconico/finish"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ result }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
      };
      if (body.ok === true)
        return goto(back, {
          replaceState: true,
        });
      fail(body.message ?? `連携できませんでした (HTTP ${res.status})`);
    } catch {
      fail(
        "denpa のサーバに届きませんでした。もう一度「ニコニコと連携」を押してください",
      );
    }
  }
</script>

<div class="sections readable">
  <section class="section">
    <div class="section-head">
      <h2>ニコニコと連携</h2>
    </div>
    <p
      class={failed ? "notice error" : "small muted"}
      role="status"
      data-testid="niconico-return"
    >
      {message}
    </p>
    {#if failed}
      <p class="small">
        <a href={back}>設定の「連携」へ戻る</a>
      </p>
    {/if}
  </section>
</div>
