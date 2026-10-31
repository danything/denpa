<script lang="ts">
  import { onMount, tick } from "svelte";

  import { arming } from "#lib/arming.svelte.js";
  import type { CanvasPlayer } from "#lib/canvas-player.js";
  import { clock, dateTime, durationMs, percent, size } from "#lib/format.js";
  import { type OfflineVideo, resumeQueue, videos } from "#lib/offline-db.js";
  import {
    offline,
    rememberResume,
    removeEverywhere,
    removeLocal,
  } from "#lib/offline.svelte.js";

  /**
   * 端末に保存した録画。**電波が無くてもここだけは開く** — サービスワーカーが
   * この画面を控えておき、繋がらないときの行き先にする (service-worker/index.ts)。
   *
   * プレイヤーはこの画面に内蔵する。オフラインでは /watch/<id> へは行けない
   * (あの画面はサーバが組む) ので、ここで直接観られるようにしておく。
   * オンラインで観るぶんには従来どおり /watch が端末のコピーを使う。
   *
   * **`<video>` で読めなければ canvas に描く** (観る画面の互換モードと同じエンジン。`canvas-player.ts`・
   * `mkv-source.ts`)。保存したものは Matroska で、iPhone の Safari の `<video>` は Matroska を読めない
   * (再生ボタンに斜線が出るだけだった)。読めるかは前もって聞いても当てにならない (Chrome は Matroska を
   * 再生できるのに `canPlayType` は読めないと答える) ので、`<video>` に渡して断られたら移る
   */

  let list = $state<OfflineVideo[]>([]);
  let loading = $state(true);

  /** いま観ているもの。blob の URL は使い終わったら破棄する */
  let playing = $state<OfflineVideo | null>(null);
  let src = $state<string | null>(null);
  let poster = $state<string | null>(null);
  let video = $state<HTMLVideoElement | null>(null);
  /** 観はじめる位置 (秒)。前回の続き */
  let startAt = 0;
  /** 何本目に観はじめたものか。読み込みを待つ間に閉じた・別のものを観はじめたら、遅れて来た結果を捨てる */
  let session = 0;

  /** canvas に描いているとき (`<video>` に断られた)。描きはじめるまでは `drawn` が null */
  let canvasMode = $state(false);
  let drawn = $state<CanvasPlayer | null>(null);
  let stage = $state<HTMLElement | null>(null);
  let drawnAt = $state(0);
  let drawnLength = $state(0);
  let drawnPaused = $state(false);
  let drawnMuted = $state(false);
  let drawnWaiting = $state(false);
  /** 位置のつまみを動かしている間の値。離したら飛ぶ */
  let scrub = $state<number | null>(null);
  /** 観られなかった理由 */
  let problem = $state<string | null>(null);
  /**
   * 消すのは2回押し。挙動はほかの画面と共通 ([arming.svelte.ts](../../lib/arming.svelte.ts))。
   * サーバからも消えることが分かる言葉で聞き返す
   */
  const deleting = arming('[data-testid="offline-delete"]');

  async function load(): Promise<void> {
    list = (await videos.all()).sort((a, b) => b.startAt - a.startAt);
    loading = false;
  }

  onMount(() => () => {
    stop();
    for (const url of posterUrls.values()) URL.revokeObjectURL(url);
    posterUrls.clear();
  });

  // 控えが変わったら映し直す。SW の「保存できた」も startOffline (`+layout.svelte` が始める) が受け取って revision に出る
  $effect(() => {
    offline.revision;
    void load();
  });

  function stop(): void {
    session += 1;
    drawn?.destroy();
    drawn = null;
    canvasMode = false;
    drawnWaiting = false;
    scrub = null;
    problem = null;
    if (src !== null) URL.revokeObjectURL(src);
    if (poster !== null) URL.revokeObjectURL(poster);
    src = null;
    poster = null;
    playing = null;
  }

  async function play(item: OfflineVideo): Promise<void> {
    if (item.state !== "ready" || item.video === undefined) return;
    stop();
    playing = item;
    src = URL.createObjectURL(item.video);
    poster =
      item.poster === undefined ? null : URL.createObjectURL(item.poster);
    // 前回の続きから。オフライン中の位置は resumeQueue に覚えている
    const kept = await resumeQueue.get(item.id);
    startAt = kept?.at ?? 0;
    if (video !== null) video.currentTime = startAt;
  }

  /** `<video>` に断られた (読めない入れ物・形式)。canvas に描く */
  async function fallBack(): Promise<void> {
    const item = playing;
    if (item?.video === undefined || canvasMode) return;
    const mine = session;
    const at = video?.currentTime || startAt;
    canvasMode = true;
    if (src !== null) URL.revokeObjectURL(src);
    src = null;
    const [{ canvasPlayer }, { openMkv }, { canvasSupport }] =
      await Promise.all([
        import("#lib/canvas-player.js"),
        import("#lib/mkv-source.js"),
        import("#lib/raw/support.js"),
      ]);
    const [source, support] = await Promise.all([
      openMkv(item.video).catch(() => null),
      canvasSupport(),
    ]);
    if (mine !== session) return;
    if (source?.codec == null) {
      problem = "この録画を読み込めませんでした";
      return;
    }
    if (!support[source.codec]) {
      problem = `この端末では再生できません (${source.codec === "av1" ? "AV1" : "H.264"} を描けません)`;
      return;
    }
    await tick();
    if (mine !== session || stage === null) return;
    const length = source.duration ?? (item.durationMs ?? 0) / 1000;
    const close = (reason: string) => {
      drawn?.destroy();
      drawn = null;
      problem = reason;
    };
    try {
      drawn = canvasPlayer({
        host: stage,
        before: null,
        input: "mkv",
        request: (from) => Promise.resolve(source.request(from)),
        duration: length,
        // Blob は読むのが速すぎる。観ている位置の少し先までしか読まない (`canvas-player.ts` の `room`)
        ...(length > 0 ? { bytesPerSecond: item.video.size / length } : {}),
        start: at >= length - 1 ? 0 : at,
        audio: "0",
        /*
         * **「再生する音」として鳴らす。** そうしないと iPhone は消音スイッチで Web Audio を黙らせる
         * (`<video>` は消音スイッチでも鳴る)。押して観はじめたものなので、`<video>` と同じに扱う
         */
        background: true,
        paused: false,
        state: (state) => {
          if (state === "failed") close("録画を読み込めませんでした");
        },
        gaveUp: (reason) => close(`再生できませんでした (${reason})`),
        remote: (stop) => (stop ? drawn?.pause() : drawn?.play()),
        waiting: (on) => (drawnWaiting = on),
        ended: () => (drawnPaused = true),
        tick: drawnTick,
      });
    } catch (error) {
      problem = `再生を始められませんでした (${error instanceof Error ? error.message : String(error)})`;
      return;
    }
    drawnLength = length;
    drawnAt = drawn.currentTime;
    drawnPaused = drawn.paused;
    drawnMuted = false;
  }

  /** canvas の刻み。位置を映し、覚える */
  function drawnTick(): void {
    if (drawn === null) return;
    drawnAt = drawn.currentTime;
    drawnPaused = drawn.paused;
    // 自動再生で断られて音を出せていない。消音にしておき、押して出してもらう (観る画面と同じ)
    if (!drawnMuted && drawn.blocked && !drawn.paused) {
      drawnMuted = true;
      drawn.mute(true);
    }
    remember(drawnAt, drawnLength);
  }

  function toggleDrawn(): void {
    if (drawn === null) return;
    if (drawn.paused) drawn.play();
    else drawn.pause();
    drawnPaused = drawn.paused;
  }

  function unmuteDrawn(): void {
    drawn?.mute(false);
    drawnMuted = false;
  }

  /** 視聴位置を覚える (数秒おき)。オンラインに戻ったときにまとめて送る */
  let lastKept = 0;
  function remember(at: number, length: number): void {
    if (playing === null) return;
    if (Math.abs(at - lastKept) < 5) return;
    lastKept = at;
    // 落としたものはエンコードしたもの
    void rememberResume(playing.id, at, length, "encoded");
  }
  function onTime(): void {
    if (video !== null) remember(video.currentTime, video.duration || 0);
  }

  async function remove(item: OfflineVideo): Promise<void> {
    if (deleting.armed !== item.id) {
      deleting.arm(item.id);
      return;
    }
    // フォーム送信ではないので、消したら自分で2回押しを戻す
    deleting.fire();
    if (playing?.id === item.id) stop();
    await removeEverywhere(item);
    await load();
  }

  const posterUrls = new Map<number, string>();
  /** 一覧のサムネイル。blob から作った URL は使い回し、ページを離れるとき破棄する (onMount) */
  function posterUrl(item: OfflineVideo): string | null {
    if (item.poster === undefined) return null;
    let url = posterUrls.get(item.id);
    if (url === undefined) {
      url = URL.createObjectURL(item.poster);
      posterUrls.set(item.id, url);
    }
    return url;
  }
</script>

<svelte:head>
  <title>端末に保存した録画 - denpa</title>
</svelte:head>

<!-- 聞き返しは他所を触ったら取り下げる (`stand`) -->
<svelte:window onclick={deleting.stand} />

<div class="page">
  <h1>端末に保存した録画</h1>
  <p class="lead small muted">
    電波の無いところでも観られます。ここで削除すると、
    <strong>次にオンラインに戻ったとき、サーバの録画も消えます</strong>。
  </p>

  {#if playing !== null}
    <div class="player">
      {#if !canvasMode && src !== null}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          bind:this={video}
          {src}
          poster={poster ?? undefined}
          controls
          autoplay
          playsinline
          ontimeupdate={onTime}
          onerror={fallBack}
        ></video>
      {:else if canvasMode}
        <!-- canvas はエンジンがここに入れる (`canvas-player.ts`) -->
        <div class="stage" bind:this={stage} data-testid="offline-stage">
          {#if problem === null && (drawn === null || drawnWaiting)}
            <span class="loading small">読み込んでいます…</span>
          {/if}
        </div>
        {#if drawn !== null}
          <div class="controls">
            <button
              type="button"
              class="ghost small"
              onclick={toggleDrawn}
              data-testid="offline-toggle"
            >
              {drawnPaused ? "再生" : "一時停止"}
            </button>
            <input
              type="range"
              min="0"
              max={Math.max(1, Math.floor(drawnLength))}
              step="1"
              value={scrub ?? drawnAt}
              aria-label="再生位置"
              oninput={(event) => (scrub = Number(event.currentTarget.value))}
              onchange={(event) => {
                drawn?.seek(Number(event.currentTarget.value));
                scrub = null;
              }}
            />
            <span class="clock tiny muted">
              {clock(scrub ?? drawnAt)} / {clock(drawnLength)}
            </span>
            {#if drawnMuted}
              <button type="button" class="ghost small" onclick={unmuteDrawn}>
                音を出す
              </button>
            {/if}
          </div>
        {/if}
      {/if}
      {#if problem !== null}
        <p class="problem small text-error" role="alert">{problem}</p>
      {/if}
      <div class="player-bar">
        <span class="name truncate small broadcast">{playing.name}</span>
        <button type="button" class="ghost xs" onclick={stop}>閉じる</button>
      </div>
    </div>
  {/if}

  {#if loading}
    <p class="muted">読み込んでいます…</p>
  {:else if list.length === 0}
    <div class="empty glow">
      <p>まだ何も保存していません。</p>
      <p class="small muted">
        録画の詳細の「端末に保存」を押すと、オフラインでも観られるようになります。
      </p>
    </div>
  {:else}
    <ul class="list">
      {#each list as item (item.id)}
        <li class="row item">
          {#if posterUrl(item) !== null}
            <img src={posterUrl(item)} alt="" class="thumb" />
          {:else}
            <div class="thumb blank"></div>
          {/if}
          <div class="info">
            <div class="name truncate small broadcast">{item.name}</div>
            <div class="tiny muted">
              <span class="broadcast">{item.serviceName}</span> ・ {dateTime(
                item.startAt,
              )}
              {#if item.durationMs !== null}
                ・ {durationMs(item.durationMs)}
              {/if}
              {#if item.video !== undefined}
                ・ {size(item.video.size)}
              {/if}
              {#if item.source === "hevc"}
                ・ H.265
              {:else if item.source === "alt"}
                ・ H.264
              {/if}
            </div>
          </div>
          {#if item.state === "downloading"}
            {@const progress = offline.entries[item.id]?.progress ?? null}
            <span class="tag keep">
              保存中{progress === null ? "…" : ` ${percent(progress)}`}
            </span>
          {:else if item.state === "failed"}
            <span class="tag error keep">保存に失敗</span>
          {:else}
            <button type="button" class="small keep" onclick={() => play(item)}>
              観る
            </button>
          {/if}
          {#if item.state === "failed"}
            <!-- 失敗した控えの片付け。**サーバの録画には触らない** (中身が無いだけ) -->
            <button
              type="button"
              class="ghost small keep"
              onclick={async () => {
                await removeLocal(item.id);
                await load();
              }}
            >
              失敗した保存データを消す
            </button>
          {:else}
            <button
              type="button"
              class="small keep {deleting.armed === item.id
                ? 'danger'
                : 'outline danger'}"
              onclick={() => remove(item)}
              data-testid="offline-delete"
            >
              {deleting.armed === item.id ? "端末とサーバから削除" : "削除"}
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if Object.keys(offline.pendingDelete).length > 0}
    <p class="pending tiny muted">
      {Object.keys(offline.pendingDelete).length} 件は、次にオンラインに戻ったときにサーバからも削除します。
    </p>
  {/if}
</div>

<style>
  .page {
    max-width: 48rem;
    margin: 0 auto;
  }
  h1 {
    margin-bottom: 0.25rem;
    font-size: 1.25rem;
  }
  .lead {
    margin-bottom: 1rem;
  }
  .player {
    margin-bottom: 1rem;
  }
  .player video {
    display: block;
    width: 100%;
    border-radius: var(--dp-radius);
    background: var(--dp-video);
  }
  /* canvas の入れ物。canvas は中いっぱいに置かれる (`raw/engine.ts`) */
  .stage {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border-radius: var(--dp-radius);
    background: var(--dp-video);
  }
  .loading {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: grid;
    place-items: center;
    color: var(--dp-on-video);
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  .controls input[type="range"] {
    min-width: 0;
    flex: 1 1 0%;
    margin: 0;
  }
  .clock {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
  .problem {
    margin: 0.25rem 0 0;
  }
  .player-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.25rem;
  }
  .name {
    font-weight: var(--dp-weight);
  }
  /* 空のときも枠で囲まず、見出しの下に左揃えで (断られた画面と同じ置き方) */
  .empty {
    padding-block: var(--dp-space-4);
  }
  .empty p:first-child {
    margin-bottom: 0.25rem;
  }
  /* 1 件ずつ件の面 (`app.css` の `.item`) に乗せ、件の間は余白 (docs/design.md の「何行かある一覧」。ホームの行と同じ) */
  .list {
    display: flex;
    flex-direction: column;
    gap: var(--dp-list-gap);
    margin: 0;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 4rem;
    /* Pico は `li` に下の余白と四角の印を付ける */
    margin: 0;
    padding: 0.5rem 0.75rem;
    list-style: none;
  }
  @media (pointer: coarse) {
    .row {
      min-height: 4.5rem;
    }
  }
  .thumb {
    width: 5rem;
    height: 3rem;
    border-radius: var(--dp-radius-sm);
    object-fit: cover;
  }
  .thumb.blank {
    background: var(--dp-line);
  }
  .info {
    min-width: 0;
    flex: 1 1 0%;
  }
  .keep {
    flex-shrink: 0;
  }
  .pending {
    margin-top: 0.75rem;
  }
</style>
