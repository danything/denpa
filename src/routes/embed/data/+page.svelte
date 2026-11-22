<script lang="ts">
  /**
   * **データ放送のページ** (テレビのアプリが映像の上に透明な WebView で重ねる)。描くのはブラウザと同じ `DataBroadcast`。
   *
   * 映像・キー・ライブの通知はアプリが持ち、MessagePort 1 本でやり取りする (`#lib/embed-data.ts`。約束は
   * [docs/api.md](../../../../docs/api.md#データ放送のページ-embeddata))。映像は WebView の外にあるので、場所はアプリへ知らせる (`onvideo`)。
   * 録画のデータ放送 (変化ログ) はページが自分で取得し、アプリが知らせる再生位置に合わせて流す
   */
  import { resolve } from "$app/paths";
  import { onMount } from "svelte";

  import type { Service } from "#lib/bml/engine.js";
  import DataBroadcast, {
    pressD,
  } from "#lib/components/player/DataBroadcast.svelte";
  import {
    type Incoming,
    type Outgoing,
    PlayClock,
    portFrom,
    readIncoming,
    readNotice,
  } from "#lib/embed-data.js";
  import type { HybridcastLink } from "#lib/live.js";
  import { DataLayer } from "#lib/player/data.svelte.js";

  let { data } = $props();

  /** 録画の再生位置に合わせて流し直す間隔 (ms)。観る画面が流し直す `timeupdate` と同じくらい */
  const FOLLOW_EVERY = 250;

  let port: MessagePort | null = null;
  function post(message: Outgoing): void {
    port?.postMessage(JSON.stringify(message));
  }

  const layer = new DataLayer();
  const clock = new PlayClock();

  /** `init` で決まる。来るまでは何も描かない */
  let mode = $state<"live" | "recording" | null>(null);
  /** ライブの局 (`GET /api/services` の `id`) */
  let service = $state<number | null>(null);
  /** 録画の ID */
  let recording = $state<number | null>(null);
  /** 開いているか (d)。アプリへは `open` で知らせる */
  let open = $state(false);
  /** 開く前から受信するか (アプリが決める。自動で受信する端末で、入口に自動起動の指定がある局・録画) */
  let receive = $state(false);
  let captions = $state(false);
  let cardId = $state<string | null>(null);
  let apps = $state<HybridcastLink[]>([]);
  /** 録画の変化ログを取得し終えたか */
  let timelineReady = $state(false);
  /** 録画のエンジンを作り直す合図 (戻ったら変える。観る画面の `dataChannel` と同じ) */
  let replay = $state("");

  let dataButton = $state<(() => boolean) | null>(null);
  let dataKey = $state<((code: number, down: boolean) => void) | null>(null);
  let note = $state("");
  let hydrated = $state(false);

  const current = $derived(
    service === null ? undefined : data.services.find((s) => s.id === service),
  );

  /** エンジンが受け持つもの (`DataBroadcast` の `channel`)。変わったら作り直す */
  const channel = $derived(
    mode === "live" && service !== null
      ? `live/${service}`
      : mode === "recording" && recording !== null && timelineReady
        ? `recording/${recording}${replay}`
        : null,
  );

  function listen(emit: Parameters<DataLayer["listen"]>[0]): void {
    if (mode === "recording") layer.listenAt(emit, clock.pos());
    else layer.listen(emit);
  }

  /** 録画の再生が進んだぶんを流す。**戻っていたらエンジンを作り直す** (観る画面の `feedData` と同じ) */
  function follow(): void {
    if (mode !== "recording" || !timelineReady) return;
    const to = clock.pos();
    if (!layer.follow(to)) {
      layer.rewind();
      replay = `:${to}`;
    }
  }

  async function loadTimeline(id: number): Promise<void> {
    const response = await fetch(
      resolve(`api/recordings/${id}/databroadcast`),
    ).catch(() => null);
    const timeline = response?.ok ? await response.json().catch(() => []) : [];
    if (recording !== id) return;
    layer.timeline = Array.isArray(timeline) ? timeline : [];
    layer.rewind();
    timelineReady = true;
  }

  /** 局が替わった。前の局の控え・カード・アプリは捨てる */
  function switchService(next: number): void {
    if (next === service) return;
    layer.drop();
    cardId = null;
    apps = [];
    service = next;
  }

  function handle(message: Incoming): void {
    switch (message.type) {
      case "init":
        // 2 度目の init は受けない (作り直すときは WebView ごと)
        if (mode !== null) return;
        open = message.open;
        receive = message.receive;
        captions = message.captions;
        if (message.mode === "live") {
          mode = "live";
          service = message.service;
        } else {
          mode = "recording";
          recording = message.recording;
          void loadTimeline(message.recording);
        }
        return;
      case "data":
        if (mode === "live") layer.deliver(message.message, open || receive);
        return;
      case "notice": {
        if (mode !== "live") return;
        const notice = readNotice(message.message);
        if (notice?.type === "card") cardId = notice.id;
        else if (notice?.type === "hybridcast") apps = notice.apps;
        return;
      }
      case "time":
        clock.set(message);
        follow();
        return;
      case "key":
        dataKey?.(message.code, message.down);
        return;
      case "d":
        pressD(open, dataButton, (on) => (open = on));
        return;
      case "close":
        open = false;
        return;
      case "receive":
        receive = message.on;
        if (!receive && !open) layer.drop();
        return;
      case "channel":
        if (mode === "live") switchService(message.service);
        return;
      case "captions":
        captions = message.on;
        return;
    }
  }

  /** 文書が別の局へ選局したい (epgTune)。一覧にある局ならアプリに選局を頼んで true。録画の再生中は断る */
  function tune(target: Service): boolean {
    if (mode !== "live") {
      post({ type: "toast", text: "録画の再生中は選局できません" });
      return false;
    }
    const found = data.services.find(
      (s) =>
        s.networkId === target.originalNetworkId &&
        s.serviceId === target.serviceId,
    );
    if (found === undefined) return false;
    post({
      type: "tune",
      service: found.id,
      onid: target.originalNetworkId,
      tsid: target.transportStreamId,
      sid: target.serviceId,
    });
    return true;
  }

  // 開いた・閉じた、通知が変わったらアプリへ。init (ポートを受けたあと) から送る
  $effect(() => {
    const on = open;
    if (mode !== null) post({ type: "open", on });
  });
  $effect(() => {
    const text = note;
    if (mode !== null) post({ type: "note", text });
  });

  onMount(() => {
    /*
     * **ポートは最初の 1 回だけ受ける。** 受けたら聞くのをやめ、あとから届いたもの (Hybridcast のアプリの iframe など) は受けない。
     * 送り元は `portFrom` が確かめる
     */
    const take = (event: MessageEvent): void => {
      const got = portFrom(event, {
        origin: location.origin,
        window,
      });
      if (got === null) return;
      removeEventListener("message", take);
      port = got;
      port.onmessage = (incoming) => {
        const message = readIncoming(incoming.data);
        if (message !== null) handle(message);
      };
      post({ type: "ready" });
    };
    addEventListener("message", take);
    const timer = setInterval(follow, FOLLOW_EVERY);
    hydrated = true;
    return () => {
      removeEventListener("message", take);
      clearInterval(timer);
      port?.close();
      port = null;
    };
  });
</script>

<svelte:head><title>データ放送 - denpa</title></svelte:head>

<div
  class="frame"
  data-testid="embed-data"
  data-hydrated={hydrated ? "true" : undefined}
  data-mode={mode ?? ""}
>
  {#if mode !== null}
    <DataBroadcast
      on={open}
      {receive}
      {channel}
      onvideo={(rect) => post({ type: "video", rect })}
      windowKeys={false}
      {listen}
      bind:pressD={dataButton}
      bind:key={dataKey}
      bind:note
      onfailed={() => post({ type: "failed", reason: "engine" })}
      postal={data.postalCode}
      prefecture={data.prefecture}
      network={mode === "live" && data.bmlNetwork}
      clock={mode === "recording" ? () => clock.air() : null}
      shownAt={() => clock.air()}
      {tune}
      mainAudio={(index) => post({ type: "audio", index })}
      cardId={mode === "live" ? cardId : null}
      apps={mode === "live" ? apps : []}
      serviceName={current?.name ?? ""}
      {captions}
      setCaptions={(on) => post({ type: "captions", on })}
    />
  {/if}
</div>

<style>
  /* 地を透かす。映像はアプリが WebView の下に映している */
  :global(html),
  :global(html[data-theme]),
  :global(body) {
    --pico-background-color: transparent;
    background: transparent;
  }

  .frame {
    position: fixed;
    inset: 0;
    overflow: hidden;
  }
</style>
