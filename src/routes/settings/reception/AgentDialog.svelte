<script lang="ts">
  import "@anyblades/blades/components/modal";
  import { onDestroy, tick, untrack } from "svelte";
  import ScanLine from "~icons/lucide/scan-line";

  import { submitting } from "#lib/actions.js";

  /**
   * **エージェントの登録と付け替えの窓。** 入力欄は「登録用の URL」の 1 つだけ (エージェントが出す `https://ホスト:25252#pair=…`)。
   *
   * - カメラを使える画面 (HTTPS か localhost で開き、ブラウザに QR を読む部品 `BarcodeDetector` がある) だけ「QR を読む」を出す。
   *   無ければ、スマートフォンのカメラで QR を読んで出た URL を貼ってもらう (QR の中身は URL の文字そのもの)
   * - 合言葉が入るので、欄は `autocomplete="off"` にし、送るのは POST の本文だけ
   * - 断られたら窓の中に理由を出し、閉じない (打った URL を残す)。通ったら閉じる
   */
  let {
    target,
    found = [],
    onclose,
  }: {
    /** 開く窓。`add` は登録、`move` は「URL を変える」。null で閉じる */
    target: { kind: "add" } | { kind: "move"; id: number; name: string } | null;
    /** LAN で見つかった、まだ登録していないエージェント (登録の窓にだけ出す。`agent-mdns.ts`) */
    found?: { id: string; name: string; host: string; port: number }[];
    onclose: () => void;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  let url = $state("");
  let message = $state<string | null>(null);
  /** 候補から選んだエージェントの名前 (合言葉を足すよう案内する) */
  let chosen = $state<string | null>(null);

  /** QR を読めるか。開くたびに確かめる (サーバで描くときは無い) */
  let canScan = $state(false);
  /** カメラの映像を出している間 */
  let scanning = $state(false);
  let video = $state<HTMLVideoElement | null>(null);
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** 開くたびに欄を空にする。追うのは `target` と `dialog` だけ */
  $effect(() => {
    const next = target;
    const element = dialog;
    if (element === null) return;
    untrack(() => {
      if (next === null) {
        stopScan();
        if (element.open) element.close();
        return;
      }
      url = "";
      message = null;
      chosen = null;
      canScan =
        window.isSecureContext &&
        "BarcodeDetector" in window &&
        navigator.mediaDevices?.getUserMedia !== undefined;
      if (!element.open) {
        element.showModal();
        input?.focus();
      }
    });
  });

  onDestroy(stopScan);

  function stopScan() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    scanning = false;
  }

  /**
   * カメラの映像から QR を読む。`https://` で始まるものが読めたら欄に入れて止める。
   * カメラを使わせてもらえなければ理由を出し、貼る形に戻す
   */
  async function startScan() {
    message = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
    } catch {
      message =
        "カメラを使えません。スマートフォンのカメラで QR を読み、出た URL を貼ってください";
      return;
    }
    // カメラの許可を待つ間に窓を閉じていたら、届いたカメラをすぐ止める (閉じたときの `stopScan` はもう済んでいる)
    if (dialog?.open !== true) {
      stopScan();
      return;
    }
    scanning = true;
    // 映像の枠は `scanning` で描くので、描き終えてから流し込む。枠が無ければカメラも止める
    await tick();
    if (video === null) {
      stopScan();
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    const Detector = (
      window as unknown as {
        BarcodeDetector: new (options: { formats: string[] }) => {
          detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
        };
      }
    ).BarcodeDetector;
    const detector = new Detector({ formats: ["qr_code"] });
    timer = setInterval(() => {
      if (video === null || video.readyState < 2) return;
      void detector
        .detect(video)
        .then((codes) => {
          const read = codes.find((code) => /^https:\/\//i.test(code.rawValue));
          if (read === undefined) return;
          url = read.rawValue;
          stopScan();
        })
        .catch(() => {});
    }, 300);
  }

  /**
   * 候補を選ぶ。宛先と `#pair=` までを欄に入れ、合言葉だけを足してもらう (合言葉は LAN に知らせていない)。
   * エージェントが出した URL をそのまま貼れば、欄ごと置き換わる (下の `paste`)
   */
  async function choose(agent: { name: string; host: string; port: number }) {
    url = `https://${agent.host}:${agent.port}#pair=`;
    chosen = agent.name;
    message = null;
    await tick();
    input?.focus();
    input?.setSelectionRange(url.length, url.length);
  }

  /** `https://` で始まるものを貼ったら、欄の中身ごと置き換える (候補を選んだあとに登録用の URL を貼ったとき) */
  function paste(event: ClipboardEvent) {
    const text = event.clipboardData?.getData("text")?.trim() ?? "";
    if (!/^https:\/\//i.test(text) || url === "") return;
    event.preventDefault();
    url = text;
  }

  const title = $derived(
    target?.kind === "move"
      ? `${target.name} の URL を変える`
      : "エージェントを追加",
  );
</script>

<dialog
  bind:this={dialog}
  onclose={() => {
    stopScan();
    onclose();
  }}
  aria-labelledby="agent-dialog-title"
  data-testid="agent-dialog"
>
  <button
    type="button"
    class="modal-backdrop"
    tabindex="-1"
    aria-label="閉じる"
    onclick={() => dialog?.close()}
  ></button>
  <article class="modal-box">
    <h2 id="agent-dialog-title">{title}</h2>
    <p class="small muted intro">
      {#if target?.kind === "move"}
        エージェントが出した登録用の URL
        を貼ります。アドレスだけ変わったなら、#pair=
        から後ろは無くても変えられます。
      {:else}
        エージェントが出した登録用の URL を貼ります。URL はエージェントのログか
        <span class="mono">denpa-agent --pair</span> に出ます。登録できるのは同じ世帯の機器だけです。
      {/if}
    </p>
    <form
      method="POST"
      action={target?.kind === "move" ? "?/moveAgent" : "?/addAgent"}
      use:submitting={() =>
        async ({ result, update }) => {
          if (result.type === "failure") {
            message = String(
              result.data?.["message"] ??
                (target?.kind === "move"
                  ? "URL を変えられませんでした"
                  : "登録できませんでした"),
            );
            return;
          }
          await update();
          dialog?.close();
        }}
    >
      {#if target?.kind === "move"}
        <input type="hidden" name="id" value={target.id} />
      {/if}
      <label class="field">
        <span class="field-label">登録用の URL</span>
        <input
          bind:this={input}
          bind:value={url}
          name="url"
          type="url"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          class="mono"
          placeholder="https://ホスト:25252#pair=…"
          data-testid="agent-url"
          onpaste={paste}
        />
      </label>
      {#if chosen !== null}
        <p class="small muted hint" data-testid="agent-found-hint">
          #pair= の後ろに合言葉を足すか、{chosen} が出した登録用の URL を貼ります。
        </p>
      {/if}
      {#if target?.kind === "add" && found.length > 0}
        <div class="found" data-testid="agent-found">
          <span class="small muted">LAN で見つかったエージェント</span>
          <ul>
            {#each found as agent (agent.id)}
              <li>
                <button
                  type="button"
                  class="small ghost"
                  onclick={() => void choose(agent)}
                  data-testid="agent-found-item"
                >
                  {agent.name}<span class="mono muted">{agent.host}</span>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if canScan}
        <div class="scan">
          {#if scanning}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              bind:this={video}
              muted
              playsinline
              data-testid="agent-qr-video"
            ></video>
            <button type="button" class="small ghost" onclick={stopScan}
              >中断</button
            >
          {:else}
            <button
              type="button"
              class="small secondary outline"
              onclick={startScan}
              data-testid="agent-qr"
            >
              <ScanLine aria-hidden="true" />QR を読む
            </button>
          {/if}
        </div>
      {/if}
      {#if message !== null}
        <div class="notice error small" role="alert" data-testid="agent-error">
          {message}
        </div>
      {/if}
      <footer class="modal-foot">
        <button
          type="button"
          class="secondary modal-close"
          onclick={() => dialog?.close()}>閉じる</button
        >
        <div class="modal-actions">
          <button
            type="submit"
            disabled={url.trim() === ""}
            data-testid="agent-submit"
            >{target?.kind === "move" ? "保存" : "追加"}</button
          >
        </div>
      </footer>
    </form>
  </article>
</dialog>

<style>
  .scan {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--dp-space-2);
    margin-top: var(--dp-space-2);
  }
  .scan button {
    margin: 0;
  }
  .hint {
    margin: var(--dp-space-1) 0 0;
  }
  .found {
    display: flex;
    flex-direction: column;
    gap: var(--dp-space-1);
    margin-top: var(--dp-space-3);
  }
  .found ul {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .found button {
    gap: var(--dp-space-2);
    margin: 0;
  }
  video {
    width: 100%;
    max-height: 16rem;
    border-radius: var(--dp-radius);
    background: var(--dp-subtle);
    object-fit: cover;
  }
  .notice {
    margin-top: var(--dp-space-3);
  }
</style>
