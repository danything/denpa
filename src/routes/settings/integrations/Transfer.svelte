<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";

  import JobProgress from "#lib/components/JobProgress.svelte";
  import Lead from "#lib/components/Lead.svelte";
  import { byteScale, dateTime } from "#lib/format.js";
  import type { CheckResult } from "#lib/server/transfer.js";

  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  /** 1 回に送る大きさ。リクエストの本文の上限 (`BODY_SIZE_LIMIT`、既定 512K) に収める */
  const CHUNK = 256 * 1024;
  /** 再起動を待つ上限。過ぎたら「再起動してください」を出す */
  const RESTART_WAIT = 90_000;

  const status = $derived(data.transfer);
  /** 取り込んで起き直したところ (`waitForRestart` が付けて開き直す) */
  const imported = $derived(
    page.url.searchParams.get("transfer") === "imported",
  );
  /** 書き出しで断られたとき (フォームの送信なので、理由は URL に載って戻ってくる) */
  const exportError = $derived(page.url.searchParams.get("transfer_error"));

  let file = $state<File | null>(null);
  let sent = $state(0);
  let total = $state(0);
  let phase = $state<
    "idle" | "sending" | "checking" | "checked" | "applying" | "restarting"
  >("idle");
  let result = $state<CheckResult | null>(null);
  let error = $state<string | null>(null);
  /** 置き場に無い録画があるときの「承知で取り込む」の 1 回目を押したか */
  let armed = $state(false);
  /** 再起動を待ちきれなかった (自動で起き直さない環境) */
  let restartLate = $state(false);

  const endpoint = (name: string) =>
    resolve(`settings/integrations/transfer/${name}`);

  async function call<T>(name: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(endpoint(name), { method: "POST", ...init });
    const body = (await response.json().catch(() => ({}))) as T & {
      message?: string;
      offset?: number;
    };
    if (!response.ok) {
      throw Object.assign(
        new Error(body.message ?? `HTTP ${response.status}`),
        { offset: body.offset, status: response.status },
      );
    }
    return body;
  }

  /** 選んだファイルを小分けにして送る。止まったら、サーバが持っている位置から送り直す */
  async function send(): Promise<void> {
    if (file === null) return;
    error = null;
    result = null;
    armed = false;
    phase = "sending";
    total = file.size;
    try {
      const begun = await call<{ offset: number; prepared: boolean }>(
        "upload",
        {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: file.name,
            size: file.size,
            lastModified: file.lastModified,
          }),
        },
      );
      sent = begun.offset;
      let retries = 0;
      while (sent < file.size) {
        try {
          const next = await call<{ offset: number }>(`upload?offset=${sent}`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: file.slice(sent, sent + CHUNK),
          });
          sent = next.offset;
          retries = 0;
        } catch (failure) {
          const { offset, status: code } = failure as {
            offset?: number;
            status?: number;
          };
          // 位置が食い違った。サーバの持っている位置から続ける
          if (code === 409 && typeof offset === "number") {
            sent = offset;
            continue;
          }
          // 繋がらない・途中で切れた (status が無い) ときは、少し置いて同じ位置から
          if (code === undefined && retries < 5) {
            retries++;
            await new Promise((r) => setTimeout(r, 1000 * retries));
            continue;
          }
          throw failure;
        }
      }
      await recheck();
    } catch (failure) {
      error = (failure as Error).message;
      phase = "idle";
    }
  }

  /** 確かめる (送り終えたあとと「もう一度確かめる」) */
  async function recheck(): Promise<void> {
    error = null;
    armed = false;
    phase = "checking";
    try {
      result = await call<CheckResult>("check");
      phase = "checked";
    } catch (failure) {
      error = (failure as Error).message;
      result = null;
      phase = "idle";
      file = null;
      sent = 0;
    }
  }

  async function apply(force: boolean): Promise<void> {
    error = null;
    phase = "applying";
    try {
      await call("apply", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      });
    } catch (failure) {
      error = (failure as Error).message;
      phase = "checked";
      armed = false;
      return;
    }
    phase = "restarting";
    await waitForRestart();
  }

  /**
   * 起き直すのを待って開き直す。先に落ちるのを待ち (止まる前の返事を「起きた」と取り違えない)、
   * それから返事が来るまで待つ。来なければ「再起動してください」
   */
  async function waitForRestart(): Promise<void> {
    const until = Date.now() + RESTART_WAIT;
    const alive = async () => {
      try {
        const response = await fetch(resolve("api/health"), {
          cache: "no-store",
          signal: AbortSignal.timeout(3000),
        });
        return response.ok;
      } catch {
        return false;
      }
    };
    let wentDown = false;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      const up = await alive();
      if (!up) wentDown = true;
      // 起き直しが速くて落ちたところを見逃しても、10 秒たてば開き直す
      else if (wentDown || Date.now() > until - RESTART_WAIT + 10_000) {
        const url = new URL(location.href);
        url.searchParams.delete("transfer_error");
        url.searchParams.set("transfer", "imported");
        url.hash = "transfer";
        location.replace(url);
        return;
      }
    }
    restartLate = true;
  }

  async function cancel(): Promise<void> {
    error = null;
    try {
      await call("cancel");
    } catch (failure) {
      error = (failure as Error).message;
      return;
    }
    file = null;
    sent = 0;
    total = 0;
    result = null;
    armed = false;
    phase = "idle";
    // 送りかけの表示 (load の `upload`) を消す
    location.reload();
  }

  /** 開き直したときに、送りかけ・確かめ終えたものがあれば続きから */
  const resumable = $derived(
    phase === "idle" && file === null && status.upload !== null,
  );
  const busy = $derived(
    phase === "sending" ||
      phase === "checking" ||
      phase === "applying" ||
      phase === "restarting",
  );
  const bytes = $derived(byteScale(total));
</script>

<!-- **たまにしか触らないもの。** 機械を替えるときだけ使う (docs/migrate.md「別の機械へ移す」) -->
<div class="sections readable">
  <section class="section">
    <div class="section-head">
      <h2>denpa を別の機械へ移す</h2>
    </div>
    <Lead>
      ルール・予約・録画の一覧・設定・局ロゴを書き出し、別の機械の denpa
      に取り込みます
      {#snippet more()}
        <p>
          <strong>録画のファイルは入りません。</strong
          >録画のフォルダは、フォルダの形を変えずに新しい機械へ写してください。取り込む前に写し終えておくと、置き場に無い録画を数えて止まらずに済みます。
        </p>
        <p>
          ログインの控えとペアリングの途中は入りません
          (移したらログインし直します)。テレビのアプリはペアリングし直さずに使えます。
        </p>
      {/snippet}
    </Lead>

    <h3>書き出す</h3>
    <!-- ダウンロードとして返すので、素のフォームで送る (`use:enhance` を付けない) -->
    <form method="POST" action={endpoint("export")} class="fields">
      <div class="cluster">
        <button
          type="submit"
          class="small"
          disabled={busy || status.upload !== null}
          data-testid="transfer-export"
        >
          書き出す
        </button>
      </div>
      <span class="hint">
        書き出したら、この denpa を止めてください (動かしたままだと、新しい
        denpa と二重に録ります)。
        {#if status.nextReservation !== null}
          次の予約は <span data-testid="transfer-next">
            {dateTime(status.nextReservation)}</span
          > です。
        {/if}
      </span>
      <span class="hint">
        ファイルには通知先の
        URL・郵便番号・録画の一覧が入ります。人に渡さず、移し終えたら消してください
      </span>
    </form>
    {#if exportError !== null}
      <div class="notice error" data-testid="transfer-export-error">
        {exportError}
      </div>
    {/if}

    <h3>取り込む</h3>
    {#if imported && !status.ready}
      <div class="notice success" data-testid="transfer-imported">
        取り込みました。録画の一覧と、設定の「チャンネル」の受信できるチャンネルを確かめてください
      </div>
    {:else if !status.empty && status.upload === null && !status.ready}
      <p class="small muted" data-testid="transfer-not-empty">
        この denpa
        にはもう録画・ルール・手動予約・録画の履歴のどれかがあるので、取り込めません。取り込めるのは、まだ使っていない
        denpa だけです
      </p>
    {:else if status.ready || phase === "restarting"}
      <div class="notice info" data-testid="transfer-restarting">
        {#if phase === "restarting" && !restartLate}
          再起動しています…
        {:else}
          再起動してください。起動の最初で取り込んだものに入れ替わります
        {/if}
      </div>
      {#if phase !== "restarting"}
        <div class="cluster">
          <button
            type="button"
            class="small outline danger"
            onclick={cancel}
            data-testid="transfer-cancel">取消</button
          >
        </div>
      {/if}
    {:else}
      <div class="fields">
        <label class="field">
          <span class="field-label">書き出したファイル</span>
          <input
            type="file"
            accept=".zst"
            disabled={busy}
            data-testid="transfer-file"
            onchange={(event) => {
              file = event.currentTarget.files?.[0] ?? null;
              result = null;
              error = null;
            }}
          />
          <span class="hint">
            古い denpa で書き出した <code>denpa-export-….tar.zst</code
            >。止まっても、同じファイルを選び直せば続きから送ります
          </span>
        </label>
        <div class="cluster">
          <button
            type="button"
            class="small"
            disabled={file === null || busy}
            onclick={send}
            data-testid="transfer-send"
          >
            {phase === "sending"
              ? "送っています…"
              : phase === "checking"
                ? "確かめています…"
                : "送って確かめる"}
          </button>
          {#if resumable && status.upload !== null}
            <!-- 単位は送りかけのファイルの大きさで決める (まだ選んでいないので `total` は 0) -->
            {@const upload = byteScale(status.upload.size)}
            <span class="small muted" data-testid="transfer-resume">
              {status.upload.name} ({upload.scaled(status.upload.received)} / {upload.scaled(
                status.upload.size,
              )}
              {upload.unit})
              を送りかけています。同じファイルを選ぶと続きから送ります
            </span>
          {/if}
          {#if status.upload !== null || result !== null || phase === "sending"}
            <button
              type="button"
              class="small outline danger"
              disabled={phase === "applying"}
              onclick={cancel}
              data-testid="transfer-cancel">取消</button
            >
          {/if}
        </div>
        {#if resumable && status.prepared}
          <div class="cluster">
            <button
              type="button"
              class="small outline"
              onclick={recheck}
              data-testid="transfer-recheck">もう一度確かめる</button
            >
          </div>
        {/if}
      </div>

      {#if phase === "sending" && total > 0}
        <div class="progress-block">
          <JobProgress
            done={bytes.scaled(sent)}
            total={bytes.scaled(total)}
            unit={bytes.unit}
            testid="transfer-progress"
          />
        </div>
      {/if}

      {#if error !== null}
        <div class="notice error" data-testid="transfer-error">{error}</div>
      {/if}

      {#if result !== null}
        <div class="progress-block" data-testid="transfer-result">
          <div class="cluster small">
            {#if result.manifest !== null}
              <span data-testid="transfer-source">
                denpa {result.manifest.version} ・ {dateTime(
                  result.manifest.exportedAt,
                )} に書き出し
              </span>
            {/if}
            <span data-testid="transfer-counts">
              ルール {result.counts.rules} 件 / 予約 {result.counts
                .reservations} 件 / 録画 {result.counts.recordings} 件 / 局ロゴ {result
                .counts.logos} 件
            </span>
          </div>
          <div class="cluster small">
            <span data-testid="transfer-files">
              置き場にある録画 {result.files.present} 件
            </span>
            {#if result.files.missing > 0}
              <span data-testid="transfer-missing">
                エンコードしたものが無い {result.files.missing} 件
              </span>
            {/if}
            {#if result.files.rawMissing > 0}
              <span>元のTSが無い {result.files.rawMissing} 件</span>
            {/if}
            {#if result.files.outside > 0}
              <span
                >置き場の外にあって見つからない {result.files.outside} 件</span
              >
            {/if}
            {#if result.files.jobsMissing > 0}
              <span>
                元のTSが無いエンコード待ち {result.files.jobsMissing} 件
              </span>
            {/if}
          </div>

          {#if result.blocked}
            <div class="notice warning" data-testid="transfer-blocked">
              置き場に無い録画があります。録画のフォルダを写してから「もう一度確かめる」を押してください。このまま取り込むと、無いものは起動のすぐあとに削除済みになります
            </div>
            {#if result.files.list.length > 0}
              <details class="log">
                <summary class="small">
                  無いもの ({result.files.list.length} 件{result.files.list
                    .length <
                  result.files.missing +
                    result.files.rawMissing +
                    result.files.outside
                    ? "まで"
                    : ""})
                </summary>
                <pre data-testid="transfer-missing-list">{result.files.list
                    .map((item) => `${item.name}  ${item.path}`)
                    .join("\n")}</pre>
              </details>
            {/if}
            <div class="cluster">
              <button
                type="button"
                class="small"
                disabled={busy}
                onclick={recheck}
                data-testid="transfer-recheck">もう一度確かめる</button
              >
              {#if armed}
                <button
                  type="button"
                  class="small danger"
                  disabled={busy}
                  onclick={() => apply(true)}
                  data-testid="transfer-force-confirm"
                  >無いものは削除済みになるのを承知で取り込む</button
                >
              {:else}
                <button
                  type="button"
                  class="small outline danger"
                  disabled={busy}
                  onclick={() => (armed = true)}
                  data-testid="transfer-force">このまま取り込む</button
                >
              {/if}
            </div>
          {:else}
            <div class="cluster">
              <button
                type="button"
                class="small"
                disabled={busy}
                onclick={() => apply(false)}
                data-testid="transfer-apply"
              >
                {phase === "applying" ? "取り込んでいます…" : "取り込む"}
              </button>
              <span class="hint">
                この denpa の今の DB
                とロゴは別の名前で残してから入れ替えます。押すと再起動します
              </span>
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </section>
</div>

<style>
  h3 {
    margin: 1rem 0 0.25rem;
  }
</style>
