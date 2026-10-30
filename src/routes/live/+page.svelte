<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { MediaQuery } from "svelte/reactivity";

  import { submitting } from "#lib/actions.js";
  import type { Service } from "#lib/bml/engine.js";
  import DriveNotice from "#lib/components/DriveNotice.svelte";
  import { ambientMode } from "#lib/components/player/ambient.svelte.js";
  import { screenAwake } from "#lib/components/player/awake.svelte.js";
  import { backgroundPlayback } from "#lib/components/player/background.svelte.js";
  import { centerTap } from "#lib/components/player/center-tap.js";
  import ControlBar from "#lib/components/player/ControlBar.svelte";
  import ControlButton from "#lib/components/player/ControlButton.svelte";
  import ControlRow from "#lib/components/player/ControlRow.svelte";
  import { playerControls } from "#lib/components/player/controls.svelte.js";
  import DataBroadcast, {
    pressD,
  } from "#lib/components/player/DataBroadcast.svelte";
  import EdgeButton from "#lib/components/player/EdgeButton.svelte";
  import Extras from "#lib/components/player/Extras.svelte";
  import FactsAside from "#lib/components/player/FactsAside.svelte";
  import { stageFullscreen } from "#lib/components/player/fullscreen.svelte.js";
  import Icon from "#lib/components/player/Icon.svelte";
  import {
    AUDIO,
    CAMERA,
    CAPTION,
    CHECK,
    CODEC,
    DATA,
    INFO,
    OPEN_OUT,
    OVERLAY,
    PAUSE,
    PENCIL,
    PLAY,
    RECORD,
    SOUND_OFF,
    SPEED,
  } from "#lib/components/player/icons.js";
  import InfoBlock from "#lib/components/player/InfoBlock.svelte";
  import JikkyoCompose from "#lib/components/player/JikkyoCompose.svelte";
  import JikkyoLayer from "#lib/components/player/JikkyoLayer.svelte";
  import MediaStack from "#lib/components/player/MediaStack.svelte";
  import { pictureInPicture } from "#lib/components/player/pip.svelte.js";
  import PlayerLayout, {
    PHONE_LANDSCAPE,
  } from "#lib/components/player/PlayerLayout.svelte";
  import PlayerStage from "#lib/components/player/PlayerStage.svelte";
  import PlayerVeil from "#lib/components/player/PlayerVeil.svelte";
  import Remote from "#lib/components/player/Remote.svelte";
  import SeekBar from "#lib/components/player/SeekBar.svelte";
  import {
    liveAudio,
    liveCodecs,
    liveSubtitle,
    muteRow,
    speedRow,
  } from "#lib/components/player/settings.js";
  import { snapshotter } from "#lib/components/player/shot.svelte.js";
  import {
    captionWords,
    grabbedFrame,
    videoFrame,
  } from "#lib/components/player/snapshot.js";
  import SoundButton from "#lib/components/player/SoundButton.svelte";
  import SpeedMenu from "#lib/components/player/SpeedMenu.svelte";
  import StageNote from "#lib/components/player/StageNote.svelte";
  import StageTail from "#lib/components/player/StageTail.svelte";
  import { playerVolume } from "#lib/components/player/volume.svelte.js";
  import ProgramFacts from "#lib/components/ProgramFacts.svelte";
  import ServiceLogo from "#lib/components/ServiceLogo.svelte";
  import Toasts, {
    errorNotice,
    type Notice,
  } from "#lib/components/Toasts.svelte";
  import { programDetail } from "#lib/detail.svelte.js";
  import { driveGate } from "#lib/drive-gate.svelte.js";
  import { SERVICE_TYPE_LABEL, time } from "#lib/format.js";
  import { JikkyoFeed } from "#lib/jikkyo/feed.svelte.js";
  import { slides } from "#lib/jikkyo/ranking.js";
  import { JikkyoRanking } from "#lib/jikkyo/ranking.svelte.js";
  import { jikkyoSwitch } from "#lib/jikkyo/switch.svelte.js";
  import { livePlayer } from "#lib/live-player.svelte.js";
  import { liveUpdates } from "#lib/live-updates.svelte.js";
  import type { HybridcastLink } from "#lib/live.js";
  import { PHONE_FORM, TABLETOP } from "#lib/phone-form.js";
  import { reload } from "#lib/reload.svelte.js";
  import { FLOOR } from "#lib/ts/pacing.js";
  import { CHANNEL_TYPES } from "#lib/types.js";

  import type { LiveChannel } from "./+page.server";

  /** 番組の終わりから読み直すまで置く間 (下の「番組が替わったら読み直す」) */
  const PROGRAM_END_GRACE = 2_000;
  /** 読み直しの間の下限。端末の時計が進んでいると同じ番組が返り、すぐまた読み直すことになる */
  const PROGRAM_END_FLOOR = 5_000;

  let { data, form } = $props();
  // 局が入れ替わると読み込み直されるので、値ではなく参照で持つ
  const channels = $derived(data.channels as LiveChannel[]);

  /*
   * 番組が替わったら読み直す (操作列と一覧の番組名を前のまま残さない)。観ている局はサーバが放送の
   * EIT[p/f] を読んで知らせてくる (`programs`)。観ていない局は番組表の予定で、いちばん早く終わる番組の
   * 少し後に読み直す。読み直しても観ているものは変わらない
   */
  liveUpdates(["programs", "services"]);
  $effect(() => {
    const ends = channels.flatMap((channel) =>
      channel.now === null ? [] : [channel.now.endAt],
    );
    if (ends.length === 0) return;
    const wait = Math.max(
      Math.min(...ends) - Date.now() + PROGRAM_END_GRACE,
      PROGRAM_END_FLOOR,
    );
    // setTimeout は 2^31-1 ms (約24日) を超えると即座に鳴る
    const timer = setTimeout(reload, Math.min(wait, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  });

  /** 運転中の注意 (互換モード)。初めて canvas で再生する前に出し、押すまで再生を始めない */
  const drive = driveGate();
  const player = livePlayer({ confirm: drive.confirm });
  /** 映像と重ねもの (MediaStack が組む)。bind で受けるので開くまでは null */
  let video = $state<HTMLVideoElement | null>(null);
  let still = $state<HTMLCanvasElement | null>(null);
  let overlay = $state<HTMLCanvasElement | null>(null);
  let mediaBox = $state<HTMLElement | null>(null);
  /** リモコンのキーを渡す関数と、d を文書へ渡す関数 (`DataBroadcast` の press / pressD)。前者があれば指のリモコンを出す */
  let dataPress = $state<((code: number) => void) | null>(null);
  let dataButton = $state<(() => boolean) | null>(null);

  /**
   * サーバが決めた局で開く (`+page.server.ts` の `start`)。こちらでも同じ判断をしない — サーバは既に
   * その局をエンコードし始めている (`server/live.ts` の `warm`)
   */
  onMount(() => {
    // 重ねるものの置き場と入れ物を先に渡す (MPEG-2 は映像の代わりの canvas をここに差し込む)
    if (still !== null && overlay !== null)
      player.attach(still, overlay, mediaBox);
    if (data.start !== null && video !== null)
      void player.tune(video, data.start);
    return () => player.stop();
  });

  /** いま映している局。局で引く (物理チャンネルで引くと、1本に複数の局が入っていると先頭が塗られた) */
  const current = $derived(
    channels.find((c) => c.id === player.tuned?.serviceId),
  );

  /**
   * 実況のコメント (docs/watch.md の「実況のコメント」)。世帯の設定 (`data.jikkyo`) と端末の ⚙ の両方がオンで、
   * 局を映している間だけ NX-Jikkyo に繋ぐ。局を替えたら繋ぎ直す
   */
  const jikkyoOn = jikkyoSwitch();
  const jikkyo = new JikkyoFeed(true);
  const jikkyoChannel = $derived(
    data.jikkyo ? (current?.jikkyo ?? null) : null,
  );
  const jikkyoActive = $derived(
    data.jikkyo && jikkyoOn.on && player.tuned !== null,
  );
  $effect(() => {
    jikkyo.set(jikkyoChannel, jikkyoActive);
  });
  onMount(() => () => jikkyo.close());

  /**
   * 実況に書き込む 1 行 (`JikkyoCompose`)。出せるのは流しているときと同じ条件 (世帯と端末の両方がオンで、映している局に
   * 実況のチャンネルがある) で、書き込み用の設定は無い。開いている間は操作バーを引っ込めない。
   * 置き場は、スマホの形 (横にしたスマホ・テーブルトップ・全画面を除く) では下のタブのすぐ上、ほかは操作バーのすぐ上。
   * テーブルトップの下のタブは別の段にあり、映像の段の中からは浮かせられない (段の箱が `position: fixed` の基準になる)
   */
  const canWrite = $derived(
    jikkyoActive && jikkyoChannel !== null && player.yielded === null,
  );
  let writing = $state(false);
  $effect(() => {
    if (!canWrite) writing = false;
  });
  const phoneForm = new MediaQuery(PHONE_FORM);
  const phoneLandscape = new MediaQuery(PHONE_LANDSCAPE);
  const tabletop = new MediaQuery(TABLETOP);

  /**
   * 一覧は種別で切り替える (番組表と同じ並び)。局を持っている種別だけ出す。
   * 世帯の設定と端末の ⚙ の両方で実況がオンなら、最後に「実況」タブ (勢いの順。`JIKKYO_TAB`) を足す
   */
  const JIKKYO_TAB = "jikkyo";
  const jikkyoTab = $derived(
    data.jikkyo && jikkyoOn.on && channels.some((c) => c.jikkyo !== null),
  );
  const types = $derived([
    ...CHANNEL_TYPES.filter((t) => channels.some((c) => c.type === t)),
    ...(jikkyoTab ? [JIKKYO_TAB] : []),
  ]);
  /** 開いたときは、いま映している局の種別。「実況」タブを選んでいても、タブが消えたら戻す */
  let picked = $state<string | null>(null);
  const shown = $derived(
    (picked !== null && types.includes(picked) ? picked : null) ??
      current?.type ??
      types[0] ??
      "GR",
  );
  /** 「実況」タブの勢い。開いている間だけ 30 秒ごとに取得し、一覧を使っていなければ並べ直す */
  const ranking = new JikkyoRanking();
  $effect(() => {
    if (shown !== JIKKYO_TAB) return;
    // 開いた時点の局で並べる (受信設定が変わっても、次に開くまで変えない)
    const ids = untrack(() =>
      channels.filter((c) => c.jikkyo !== null).map((c) => c.id),
    );
    return ranking.open(ids);
  });
  const listed = $derived.by(() => {
    if (shown !== JIKKYO_TAB) return channels.filter((c) => c.type === shown);
    const supported = channels.filter((c) => c.jikkyo !== null);
    const order = ranking.order;
    if (order === null) return supported;
    const at = new Map(order.map((id, index) => [id, index]));
    // 開いた後に増えた局 (並びに無い) は末尾に
    return [...supported].sort(
      (a, b) => (at.get(a.id) ?? order.length) - (at.get(b.id) ?? order.length),
    );
  });

  /**
   * 局を選ぶ。エンコード方式は引き継ぐ (その端末で出るかの話)。音声は引き継がない (番組ごとに構成が変わる。
   * サーバが主音声に落とす)
   */
  function select(channel: LiveChannel): boolean {
    if (video === null) return false;
    void player.tune(video, {
      channelType: channel.type,
      channel: channel.channel,
      serviceId: channel.id,
      codec: player.codec,
    });
    return true;
  }

  /**
   * データ放送が「この局へ」と言ってきた (epgTune)。手で選んだのと同じ経路 (`select`) で切り替える。
   * original_network_id と service_id で探す (局の一覧は transport_stream_id を持っていない)。
   * 一覧に無い局なら false — 文書には失敗が返り、文書が自分で案内する
   */
  function tuneFromData(service: Service): boolean {
    const found = channels.find(
      (c) =>
        c.networkId === service.originalNetworkId &&
        c.serviceId === service.serviceId,
    );
    // 映像がまだ無い (選局できない) なら失敗にする。文書は閉じない
    return found !== undefined && select(found);
  }

  /**
   * 横にしたスマホでは、一覧から選んだら映像へ戻す (映像が高さいっぱいを取り、一覧はその下にある)。
   * 滑らせるのは CSS (下の style の `scroll-behavior`)
   */
  function backToPicture(): void {
    if (stageEl === null || !phoneLandscape.current) return;
    stageEl.scrollIntoView({ block: "start" });
  }

  /** 一覧の各行。開いたときに、いま映している局まで送る (局が100を超えると画面の外のほうが普通) */
  const rows: Record<number, HTMLElement | undefined> = $state({});
  /** 一覧そのもの。送るのはこの中だけ (下の説明) */
  let list = $state<HTMLElement | null>(null);
  /** 一度送ったら、あとは触らない。見ている途中で勝手に動くと邪魔になる */
  let scrolled = false;
  $effect(() => {
    const row = current === undefined ? undefined : rows[current.id];
    if (scrolled || row === undefined || list === null) return;
    scrolled = true;
    /*
     * `scrollIntoView` は使わない — 動かせるものは何でも動かすので、縦に積む幅では窓ごと動いて、
     * 読み込み直したときに映像が画面から出ていた。動かすのは一覧の中身だけ (中で動けない幅では何もしない)
     */
    const room = list.scrollHeight - list.clientHeight;
    if (room <= 0) return;
    // 位置は見えている座標から起こす。offsetTop は入れ子の基準がずれる
    const here = row.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    const middle =
      list.scrollTop + (here.top - box.top) - (box.height - here.height) / 2;
    list.scrollTop = Math.max(0, Math.min(room, middle));
  });

  /**
   * **「実況」タブで並べ直した行は、前の場所から滑る** (docs/design.md の「動き」)。
   * 並べ直す前に各行の上端を測り、並べ直した後にその差だけずらした姿 (`data-slide` と `--slide-from`) を置いて、
   * 印を外すと CSS が元の場所へ滑らせる。動きを減らす設定では時間が 0 なので、その場で置き換わる。
   * 最初の返事で番号順から並べ替えるとき (前の並びが無い) は滑らせない
   */
  let tops: Map<number, number> | null = null;
  let shownOrder: readonly number[] | null = null;
  $effect.pre(() => {
    const order = ranking.order;
    tops =
      shownOrder !== null &&
      order !== null &&
      untrack(() => shown) === JIKKYO_TAB
        ? untrack(rowTops)
        : null;
    shownOrder = order;
  });
  $effect(() => {
    void ranking.order;
    const before = tops;
    tops = null;
    if (before === null || list === null) return;
    untrack(() => slide(before));
  });
  /** 一覧の各行の上端 (局の ID → px) */
  function rowTops(): Map<number, number> {
    const at = new Map<number, number>();
    for (const [id, row] of Object.entries(rows)) {
      const item = row?.parentElement;
      if (item?.isConnected)
        at.set(Number(id), item.getBoundingClientRect().top);
    }
    return at;
  }
  function slide(before: Map<number, number>): void {
    const items: HTMLElement[] = [];
    for (const [id, offset] of slides(before, rowTops())) {
      const item = rows[id]?.parentElement;
      if (!item) continue;
      item.style.setProperty("--slide-from", `${offset}px`);
      item.dataset["slide"] = "";
      items.push(item);
    }
    if (items.length === 0) return;
    // ずらした姿を一度描いたことにしてから印を外す (測らせないと、ずらす前と後がまとめられて滑らない)
    list?.getBoundingClientRect();
    for (const item of items) delete item.dataset["slide"];
  }

  /** 右の列に出す番組の中身 (モーダルにしない)。あらすじや出演者は番組表の側にあるので、開いた時点で引き直す */
  const detail = programDetail();
  function openDetail(channel: LiveChannel): void {
    if (channel.now === null) return;
    void detail.open(channel.now.id, {
      name: channel.now.name,
      service_name: channel.name,
      start_at: channel.now.startAt,
      end_at: channel.now.endAt,
      description: channel.now.description ?? "",
    });
  }

  const controls = playerControls();
  /** 全画面にする枠と、その出入り (3画面共通) */
  let stageEl = $state<HTMLElement | null>(null);
  const fullscreen = stageFullscreen(() => stageEl);

  // 書き込む 1 行の置き場 (上の `canWrite`) と、開いている間は操作バーを残す
  const docked = $derived(
    phoneForm.current &&
      !phoneLandscape.current &&
      !tabletop.current &&
      !fullscreen.active,
  );
  $effect(() => {
    controls.writing = writing;
  });
  /** 閉じたら「実況に書く」へ焦点を戻す */
  function closeWriting(): void {
    writing = false;
    document.querySelector<HTMLElement>('[data-testid="live-write"]')?.focus();
  }

  /** 画面を落とさせない。止めている間も掛けたまま (追っかけの始まりで、画面を見ていることが多い) */
  const awake = screenAwake();
  $effect(() => {
    awake.on = player.state !== "idle" && player.state !== "error";
  });

  /** バックグラウンド再生。戻ったら、張り付いていたなら放送の今へ (止めた所からではなく) */
  let wasLive = false;
  const background = backgroundPlayback({
    nativeVideo: () => (player.canvas ? null : video),
    pip: () => pip.active,
    paused: () => player.paused,
    pause: () => {
      wasLive = player.live;
      player.toggle();
    },
    resume: () => {
      if (wasLive) player.goLive();
      // 戻る先がまだ無い (貯まりが空) と goLive は何もしないので、そのときは再開だけ
      if (player.paused) player.toggle();
    },
  });

  /** アンビエントモード。canvas に描いているときは worker から縮めた1枚をもらう */
  const ambient = ambientMode({
    playing: () => !player.paused,
    canvas: () => (player.canvas ? player : null),
    video: () => video,
  });

  /** 小窓 (PiP)。MPEG-2 は worker の canvas からストリームを取って出す。小窓で押された止める・再開は player に合わせる */
  const pip = pictureInPicture({
    video: () => video,
    raw: () => player.canvas,
    capture: () => player.capture(),
    flow: (on) => player.captureFlow(on),
    paused: () => player.paused,
    toggle: () => player.toggle(),
    auto: () => background.on,
    overlay: () => overlay,
    captions: () => player.captions && player.hasCaptions,
  });
  // MPEG-2 をデコードした音を「再生する音」と言うのは、入れているときと小窓を開いている間だけ (`raw/engine.ts`)
  $effect(() => {
    player.playback = background.on || pip.active;
  });

  /** 音量 (`volume.svelte.ts`)。canvas はエンジンの中で、`<video>` は Web Audio に通して掛ける */
  const volume = playerVolume({
    video: () => (player.canvas ? null : video),
    through: () => background.on || pip.active,
    remote: (paused) => {
      if (paused !== player.paused) player.toggle();
    },
  });
  $effect(() => {
    player.volume = volume.level;
  });

  /** 真ん中あたりを素早く2回で再生/一時停止 (`center-tap.ts`)。1回目は操作列の出し入れ */
  const stageTap = centerTap(() => player.toggle(), controls.toggle);

  /** いまの1コマを字幕ごと切り抜いてサーバに保存する (3画面共通。`shot.svelte.ts`) */
  const shooter = snapshotter(controls);
  const notices = $derived<Notice[]>([
    ...shooter.notices,
    ...pip.notices,
    // 録画ボタンの結果 (`?/record`)。押した本人へ、始まったか断られたかを言う
    ...(form?.recorded
      ? [
          {
            key: `record-${form.recorded}`,
            kind: "info" as const,
            text: `録画を始めます: ${form.recorded}`,
          },
        ]
      : []),
    ...errorNotice(form, "record-error"),
  ]);

  function snapshot(): void {
    void shooter.take(
      () => (player.canvas ? grabbedFrame(player.grab()) : videoFrame(video)),
      player.captions && player.hasCaptions ? overlay : null,
      current?.now?.name ?? current?.name ?? "ライブ",
      () => ({
        place: "live",
        service: player.tuned?.serviceId ?? 0,
        aired: player.airTime(),
      }),
      player.captions ? captionWords(player.shownCaption) : "",
    );
  }

  /** この番組に載っている Hybridcast (先頭だけ)。別のタブで開く (操作バーと ⚙ の行) */
  const hybridcast = $derived(player.hybridcast[0]);
  function hybridcastLabel(app: HybridcastLink): string {
    return `${app.name === "" ? "Hybridcast" : app.name} を別のタブで開く`;
  }
  function openApp(app: HybridcastLink): void {
    window.open(app.url, "_blank", "noopener,noreferrer");
  }
</script>

<!--
    映像を左、局を右 (YouTube の再生画面と同じ形)。広い画面ではページごとスクロールさせず、動くのは右の一覧だけ
    (`+layout.svelte` の `fill`)。1000px 未満では縦に積む
-->
<PlayerLayout testid="live">
  <!-- 舞台と映像の束は追っかけと共通 (PlayerStage / MediaStack) -->
  <PlayerStage
    {controls}
    {fullscreen}
    {ambient}
    testid="live-frame"
    bind:element={stageEl}
  >
    {#snippet children(stage)}
      <MediaStack
        holding={player.holding}
        captionsOn={player.captions && player.hasCaptions}
        onclick={stageTap}
        prefix="live"
        bind:video
        bind:still
        bind:overlay
        bind:box={mediaBox}
      >
        {#snippet under()}
          <!-- 映像 → 実況 → 字幕。世帯の設定がオンのときだけ置く。データ放送を出している間は重ねない -->
          {#if data.jikkyo}
            <JikkyoLayer
              feed={jikkyo}
              air={() => player.airTime()}
              show={jikkyoActive && jikkyoChannel !== null && !player.showData}
              paused={player.paused}
              rate={player.rate}
            />
          {/if}
        {/snippet}
      </MediaStack>

      <!-- データ放送。映像はここ (`media`) とだけ伝えて描くのはエンジンに任せる。局が変わったら作り直す -->
      <!-- 常に受信する端末は、開く前から動かす (局を映している間だけ。`data-receive.ts`) -->
      <DataBroadcast
        on={player.showData}
        receive={player.receiveData && player.tuned !== null}
        channel={player.tuned === null
          ? null
          : `${player.tuned.channelType}/${player.tuned.channel}/${player.tuned.serviceId}`}
        media={mediaBox}
        listen={player.listenData}
        bind:press={dataPress}
        bind:pressD={dataButton}
        postal={data.postalCode}
        prefecture={data.prefecture}
        network={data.bmlNetwork}
        tune={tuneFromData}
        apps={player.hybridcast}
        serviceName={current?.name ?? ""}
        captions={player.captions}
        setCaptions={(on) => {
          if (on !== player.captions) player.toggleCaptions();
        }}
      />

      <!--
                出せなかった間も出しておく (逃げ道のコーデックの選び直しは ⚙ にしか無い)。録画に譲って
                追っかけを観ている間も出す (局をリクエストするものだけ外す)
            -->
      {#if player.tuned !== null || player.yielded !== null}
        <!-- 右端の縦の列。観る画面と同じ場所・並び (いちばん上は録画。観る画面では閉じる) -->
        <ControlBar side shown={controls.shown}>
          <!--
                        いま観ている番組を録る (手動予約と同じ `?/record`。二重にはならない)。
                        録画に譲っている間は出さない (もう録っている)。データ放送も局のもの
                    -->
          {#if player.tuned !== null}
            <form method="POST" action="?/record" use:submitting>
              <input
                type="hidden"
                name="service"
                value={player.tuned.serviceId}
              />
              <ControlButton
                icon={RECORD}
                label="いまの番組を録画する"
                submit
                testid="live-record"
              />
            </form>
            <ControlButton
              icon={DATA}
              label={player.showData ? "データ放送を消す" : "データ放送を出す"}
              on={player.showData}
              testid="live-data-button"
              onclick={() =>
                pressD(player.showData, dataButton, (on) => player.setData(on))}
            />
          {/if}
          <!-- MPEG-2 でも切り抜ける (worker の canvas から1枚もらう。`snapshot.grabbedFrame`) -->
          <ControlButton
            icon={shooter.saved ? CHECK : CAMERA}
            label="この場面を切り抜く"
            testid="live-shot"
            onclick={() => void snapshot()}
          />
          <!-- 実況に書き込む 1 行を開く (`canWrite`。追い付いていないときも出し、1 行のほうで理由を言う) -->
          {#if canWrite}
            <ControlButton
              icon={PENCIL}
              label="実況に書く"
              on={writing}
              testid="live-write"
              onclick={() => (writing = !writing)}
            />
          {/if}
        </ControlBar>

        <!-- 操作バーは映像が出る前から出しておく (出たり消えたりすると押そうとしたところで動く) -->
        <ControlBar shown={controls.shown} testid="live-controls">
          <!-- 実況に書き込む 1 行 (操作バーのすぐ上)。スマホの形では下のタブのすぐ上 (`docked`。置く所は同じで、CSS で浮かせる) -->
          {#if writing}
            <JikkyoCompose
              feed={jikkyo}
              air={() => player.airTime()}
              lag={player.fromAir}
              paused={player.paused}
              {docked}
              onclose={closeWriting}
            />
          {/if}
          <!--
                        上に位置、下に押すもの (観る画面と同じ二段)。放送の今にいる間は右端に張り付かせる
                        (貯めているぶん後ろにいるが、描くと摘みが左へ動いて見える)。MPEG-2 では出さない
                        (遡れるほど持っていない)。録画に譲っている間も出さない (戻るのは通知の「ライブに戻る」)
                    -->
          {#if !player.canvas && player.yielded === null}
            <SeekBar
              value={player.live ? player.newest : player.position}
              min={player.oldest}
              max={player.newest}
              step={0.1}
              onseek={(at) => player.seek(at)}
              paused={player.paused}
              testid="live-seek"
            />
          {/if}

          <!-- 並びは観る画面と同じ (`ControlRow`) -->
          <ControlRow testid="live-buttons">
            <ControlButton
              icon={player.paused ? PLAY : PAUSE}
              label={player.paused ? "再生" : "一時停止"}
              testid="live-play"
              onclick={() => player.toggle()}
            />
            <!-- 畳むときは音・Hybridcast・速さを ⚙ の頭に入れる (`Extras`・`StageTail` の `fold`。字幕は ⚙ の「字幕」) -->
            <Extras>
              <SoundButton
                silenced={player.silenced}
                testid="live-sound"
                onclick={player.toggleMute}
                {volume}
              />

              <!--
                        字幕を持っている番組でだけ出す。1枚も届いていなくても出す (`server/captions.ts` の
                        `TrackList`。届いてから出すと間隔の空く番組で出なかった)
                    -->
              {#if player.hasCaptions}
                <ControlButton
                  icon={CAPTION}
                  label={player.captions ? "字幕を消す" : "字幕を出す"}
                  on={player.captions}
                  testid="live-caption"
                  onclick={() => player.toggleCaptions()}
                />
              {/if}

              <!--
                        Hybridcast は載っている番組でだけ出す。別のタブで開くだけ (受信機の API が無いので多くは
                        動かない。[stream.md](../../../docs/stream.md#hybridcast))。できる顔をしないよう「外へ出ていく」印にする
                    -->
              {#if hybridcast !== undefined}
                <ControlButton
                  icon={OPEN_OUT}
                  label={hybridcastLabel(hybridcast)}
                  testid="live-hybridcast"
                  onclick={() => openApp(hybridcast)}
                />
              {/if}
            </Extras>

            <!-- 放送の今にいるかどうか。離れていれば押して戻れる (`EdgeButton`) -->
            {#if player.yielded === null}
              <EdgeButton
                active={player.live}
                label="ライブ"
                onclick={() => player.goLive()}
                testid="live-edge"
              />
            {/if}

            <!-- 録画に譲っている間は、観ている録画の局と番組 -->
            <InfoBlock
              range={player.yielded === null && current?.now
                ? { start: current.now.startAt, end: current.now.endAt }
                : null}
              service={player.yielded?.recording.serviceName ??
                current?.name ??
                ""}
              title={player.yielded?.recording.title ??
                current?.now?.name ??
                null}
              titleTestid="live-title"
              rangeTestid="live-range"
            >
              {#snippet status()}
                <!-- 放送からの遅れ (`live-player` の `fromAir`。隣のテレビとの差)。出るまでは貯まりだけ -->
                {#if player.fromAir !== null}
                  <span>放送から {player.fromAir.toFixed(1)}秒</span>
                {/if}
                <!-- 手元の貯まり (`buffered.end - currentTime`)。上流は入っていない -->
                {#if player.delay !== null}
                  <span
                    >{player.fromAir === null ? "遅延" : "・バッファ"}
                    {player.delay.toFixed(1)}秒</span
                  >
                {/if}
                <!--
                                    測り直す (`relearn`)。覚えているものがあるときだけ、遅延のすぐ隣に置く。
                                    読みものの行なので丸いボタンにはしない (操作バーが厚くなる)
                                -->
                {#if player.remembered > FLOOR}
                  <button
                    type="button"
                    class="relearn"
                    onclick={() => player.relearn()}
                    data-testid="live-relearn">測り直す</button
                  >
                {/if}
                <!-- 詰まった回数。止まったときだけ (`live-player` の `stalls`) -->
                {#if player.stalls > 0}
                  ・ <span data-testid="live-stalls"
                    >途切れ {player.stalls}回</span
                  >
                {/if}
                <!-- いま効いている下限と、届く間隔のいちばん長いもの。途切れの報告に添えてもらう (#1210) -->
                {#if player.stalls > 0 || player.floor > FLOOR}
                  ・ <span
                    data-testid="live-floor"
                    data-target={player.target}
                    data-floor={player.floor}
                    data-gap={player.gapMost}
                    >下限 {player.floor.toFixed(2)}秒 (受信の間隔 最大 {player.gapMost.toFixed(
                      2,
                    )}秒)</span
                  >
                {/if}
                <!-- 描かれずに捨てられたコマ。映像だけ遅れるときの切り分け (`live-player` の `dropped`) -->
                {#if player.dropped > 0}
                  ・ <span>コマ落ち {player.dropped}</span>
                {/if}
                <!-- 映像だけの遅れ。開いたままにせず飛び直す (`unslip`) ので、直した回数も出す -->
                {#if player.slipMost > 0}
                  ・ <span
                    >映像の遅れ 最大 {Math.round(
                      player.slipMost * 1000,
                    )}ms</span
                  >
                {/if}
                {#if player.slips > 0}
                  ・ <span>映像の遅れを補正 {player.slips}回</span>
                {/if}
                <!-- 再生の速さ。遅延を詰めるのに変えている。Safari は変えるたびにつまずく (`ts/pacing.ts` の `Steering`) -->
                {#if player.rateChanges > 0}
                  ・ <span data-testid="live-rate"
                    >{player.rate === 1
                      ? ""
                      : `速さ ${player.rate}倍 ・ `}速さを変えた回数 {player.rateChanges}回</span
                  >
                {/if}
                <!-- MPEG-2 を1コマデコードするのに掛かる時間。8割を3秒超え続けたらエンコードしたものに戻る (`raw/budget.ts`) -->
                {#if player.canvas && player.decodeMs > 0}
                  ・ <span
                    >デコード {player.decodeMs.toFixed(1)}ms{player.thinned
                      ? " (コマを間引いています)"
                      : ""}</span
                  >
                {/if}
              {/snippet}
            </InfoBlock>

            <!-- 追っかけ中の速さ。追っかけている間だけ (放送より先は無い。追いついたら自分でライブに戻る) -->
            {#if player.chasing}
              <Extras>
                <SpeedMenu
                  label="追っかけの速さ"
                  speed={player.speed}
                  onselect={(speed) => player.setSpeed(speed)}
                />
              </Extras>
            {/if}

            <!--
                            AV1 を受け取れなければ H.264 に戻して理由を出す (`live-player.svelte.ts` の `start`)。
                            末尾の MPEG-2 はエンコードせずに放送そのままをデコードする経路
                        -->
            <StageTail
              prefix="live"
              {volume}
              fold={[
                muteRow(SOUND_OFF, player.silenced, player.toggleMute),
                ...(hybridcast === undefined
                  ? []
                  : [
                      {
                        kind: "action" as const,
                        id: "open-hybridcast",
                        label: hybridcastLabel(hybridcast),
                        icon: OPEN_OUT,
                        run: () => openApp(hybridcast),
                      },
                    ]),
                ...(player.chasing
                  ? [
                      speedRow({
                        icon: SPEED,
                        label: "追っかけの速さ",
                        speed: player.speed,
                        onselect: (speed) => player.setSpeed(speed),
                      }),
                    ]
                  : []),
              ]}
              {background}
              {ambient}
              {pip}
              {fullscreen}
              {stage}
              receive={{
                on: player.receiveData,
                toggle: () => player.toggleReceiveData(),
              }}
              jikkyo={data.jikkyo
                ? {
                    on: jikkyoOn.on,
                    toggle: jikkyoOn.toggle,
                    missing: jikkyoChannel === null,
                    down: jikkyo.down,
                  }
                : undefined}
              codec={liveCodecs({
                icon: CODEC,
                codec: player.codec,
                raw: player.raw,
                unavailable: player.unavailable,
                onselect: (key) => player.setCodec(key),
                onraw: () => player.setRaw(),
              })}
              audio={liveAudio(AUDIO, player)}
              subtitle={liveSubtitle(CAPTION, player)}
            />
          </ControlRow>
        </ControlBar>
      {/if}

      {#if player.silenced && player.state === "playing"}
        <!--
                    押されるまで音は出せない (前回の局で勝手に始めるので、ブラウザが音ありの再生を断る)。
                    並びの外に1つだけ浮かぶので、地は映像の上の通知と同じに自分で敷く
                -->
        <button
          type="button"
          class="small unmute {OVERLAY}"
          onclick={() => player.unmute()}
        >
          音を出す
        </button>
      {/if}

      {#if player.state !== "playing"}
        <!-- 何も出ていない間に何が起きているかを出す (`PlayerVeil`)。黒いままだと壊れて見える -->
        <PlayerVeil
          holding={player.holding}
          busy={player.state === "connecting"}
          note={player.resuming ? "繋ぎ直しています" : ""}
          error={player.state === "error" ? player.message : ""}
          idle="局を選んでください"
          testid="live-status"
        >
          {#snippet actions()}
            <!-- 録画に譲っている間は出さない (通知の「ライブに戻る」と2つ並ぶと迷う) -->
            {#if player.yielded === null}
              <button
                type="button"
                class="small secondary"
                onclick={() => current && select(current)}
                data-testid="live-retry">やり直す</button
              >
            {/if}
          {/snippet}
        </PlayerVeil>
      {/if}
    {/snippet}

    <!-- 映像の上の通知は舞台の列に積む (`PlayerStage` の `notes`)。幕 (`PlayerVeil`) の文言は真ん中なので重ならない -->
    {#snippet notes()}
      <!--
                    録画に譲った (`live-player` の `giveWay`)。「ライブに戻る」を置くので、この通知だけ押せる形で並べる
                    (見た目は StageNote と同じ。追っかけの「観る画面で」と同じ扱い)
                -->
      {#if player.yielded}
        {@const yielded = player.yielded}
        <span class="stage-note yielded" data-testid="live-yielded">
          <span>
            録画のため局を切り替えました: <span class="broadcast"
              >{yielded.recording.title}</span
            >
            (録画中を再生しています)
          </span>
          <button
            type="button"
            class="back-live"
            disabled={player.returning}
            onclick={() => player.backToLive()}
            data-testid="live-back">ライブに戻る</button
          >
        </span>
        {#if yielded.refused}
          <StageNote testid="live-refused"
            >録画が終わるまでライブは見られません ({time(
              yielded.recording.endAt,
            )})</StageNote
          >
        {/if}
      {/if}
      <!-- 指定されたとおりにできなかったときの断り書き (H.264 に戻した・ソフトウェアでエンコードしている) -->
      {#if player.warning}
        <StageNote testid="live-warning">{player.warning}</StageNote>
      {/if}
    {/snippet}
  </PlayerStage>

  <!--
        右の列。幅は固定で、映像側だけ伸ばす。番組表と同じ並びで、高さは残りぜんぶ
    -->
  {#snippet aside()}
    {#if detail.current}
      <!--
            番組の中身は、この列を入れ替えて出す (モーダルにしない — 映像に被さると観ながら読めない)
        -->
      <FactsAside
        testid="live-detail"
        back={{
          label: "局の一覧",
          onclick: () => detail.close(),
          testid: "live-detail-close",
        }}
      >
        <ProgramFacts program={detail.current} />
      </FactsAside>
    {:else}
      <!-- 幅と高さ・サイドバーの形は FactsAside と同じ (PlayerLayout が持つ。一覧は中身が違うので列だけ揃える) -->
      <aside class="live-side">
        <!--
                データ放送を開いている間だけ、リモコンを一覧の上に出す (入れ替えない — 押しながら局も変えたい)。
                常に受信していても、開くまでは出さない
            -->
        {#if dataPress !== null}
          <Remote press={dataPress} />
        {/if}

        <!-- 番組表と同じ並び・同じ見た目。探す場所がずれないようにする -->
        <div role="group" class="type-tabs segmented">
          {#each types as type (type)}
            <!-- いま出している種別は aria-pressed で言う (色だけにしない) -->
            <button
              type="button"
              class="small {shown === type ? '' : 'secondary outline'}"
              aria-pressed={shown === type}
              onclick={(event) => {
                picked = type;
                // マウスや指で押したときは焦点を外す。残すと、あとで何かキーを押したときに焦点の線が下線と二重に出る
                // (`detail` が 0 ならキーボードで押したので残す)
                if (event.detail > 0) event.currentTarget.blur();
              }}
              data-testid="live-type-{type}"
            >
              {type === JIKKYO_TAB ? "実況" : SERVICE_TYPE_LABEL[type]}
            </button>
          {/each}
        </div>
        <!-- 枠の無い行を並べる (サイドバーの一覧と同じ形) -->
        <!-- 勢いを読めないときは一覧の頭に 1 行だけ (通知は出さない。並びは番号順) -->
        {#if shown === JIKKYO_TAB && ranking.failed}
          <p class="ranking-note" data-testid="live-ranking-note">
            いまは勢いを読めません
          </p>
        {/if}
        <!--
          「実況」タブの並べ直しは、一覧を使っている間は待つ (`JikkyoRanking.hold`)。指は touch のほうで見る
          (巻き始めると pointer は取り消されるが、touch は指を離すまで続く)。フォーカスはキーボードで入ったときだけ
          (マウスで押したボタンに残るフォーカスでは止めない)
        -->
        <ul
          bind:this={list}
          class="channels side-list"
          data-mixed={shown === JIKKYO_TAB ? "" : undefined}
          data-testid="live-channels"
          onpointerenter={() => ranking.hold("pointer", true)}
          onpointerleave={() => ranking.hold("pointer", false)}
          ontouchstart={() => ranking.hold("touch", true)}
          ontouchend={() => ranking.hold("touch", false)}
          ontouchcancel={() => ranking.hold("touch", false)}
          onfocusin={(event) =>
            ranking.hold(
              "focus",
              (event.target as HTMLElement).matches(":focus-visible"),
            )}
          onfocusout={() => ranking.hold("focus", false)}
          onscroll={() => ranking.scrolled()}
        >
          {#each listed as channel (channel.id)}
            <!-- いま映しているものかどうかは、この行の中で何度も使う -->
            {@const tuned = current?.id === channel.id}
            <!-- 「実況」タブでは 2 段目の頭に勢い (1 分あたりのコメント数)。ほかのタブには付けない -->
            {@const force =
              shown === JIKKYO_TAB
                ? ranking.forces?.get(channel.id)
                : undefined}
            <li class="channel-item side-item">
              <button
                type="button"
                bind:this={rows[channel.id]}
                class="channel"
                onclick={() => {
                  select(channel);
                  backToPicture();
                }}
                aria-current={tuned ? "true" : undefined}
                data-testid="live-channel"
                data-current={tuned ? "true" : "false"}
                data-channel="{channel.type}/{channel.channel}"
                data-service={channel.id}
              >
                <!-- ロゴのまだ無い局は局名の頭の 1 字 (種別のラベルだとどの局も同じ箱になる) -->
                <ServiceLogo
                  id={channel.id}
                  has={channel.hasLogo}
                  style="width: 2rem; height: 2rem; font-size: var(--dp-text-sm)"
                  fallback={Array.from(channel.name.trim())[0] ?? channel.type}
                />
                <!--
                                いま映しているものはほかの選んでいる行と同じく左の縦線と主の色の太字 (`app.css` の `.side-item`。バッジは狭い列で局名を潰した)。
                                読み上げには `aria-current` と隠した「視聴中」で渡す
                            -->
                <span class="channel-text">
                  <!--
                                    テレビの番号を局名の頭に添える (地上波はリモコン番号、BS/CS は3桁)。
                                    番号の無い局も幅は取る — 局名の頭がそろう
                                -->
                  <span class="channel-name broadcast">
                    {#if tuned}<span
                        class="visually-hidden"
                        data-testid="live-tuned-mark">視聴中</span
                      >{/if}{#if channel.number !== null}<span
                        class="visually-hidden"
                        >{channel.type === "GR"
                          ? "リモコン"
                          : "チャンネル"}</span
                      >{/if}<span
                      class="channel-number"
                      data-testid="live-number">{channel.number ?? ""}</span
                    >{channel.name}
                  </span>
                  {#if channel.now || force !== undefined}
                    <span class="channel-now broadcast">
                      {#if force !== undefined}<span
                          class="force"
                          data-testid="live-force"
                          ><span title="1分あたりのコメント数">勢い</span>
                          {force}</span
                        >{#if channel.now}・{/if}{/if}{channel.now?.name ?? ""}
                    </span>
                  {/if}
                </span>
              </button>

              <!-- 中身を読むボタンは行と別に置く (行は選局。読みたいだけで局が変わっては困る) -->
              {#if channel.now}
                <button
                  type="button"
                  class="ghost small channel-detail"
                  onclick={() => openDetail(channel)}
                  aria-label="{channel.now.name} の詳細"
                  data-testid="live-channel-detail"
                >
                  <Icon icon={INFO} size="size-5" />
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      </aside>
    {/if}
  {/snippet}
</PlayerLayout>

<!-- 返事が変わったことは `source` で渡す (他の画面と同じ。閉じた通知の扱いは Toasts) -->
<Toasts
  {notices}
  source={form}
  ondismiss={(key) => {
    shooter.dismiss(key);
    pip.dismiss(key);
  }}
/>

<!-- 運転中の注意 (互換モードで初めて再生する前に1回)。押すまで再生を始めない -->
<DriveNotice open={drive.open} onaccept={drive.accept} />

<style>
  /*
     * 右の一覧の列 (幅と高さは `PlayerLayout`)。一覧 (`.channels`) だけは列の端まで広げて中で余白を取る
     * (スクロールバーを窓の右端に出すため)
     */
  .live-side {
    display: flex;
    flex-direction: column;
    /* 上は映像の上と同じ値 (`--dp-side-top`。FactsAside と同じ) */
    padding: var(--dp-side-top, var(--dp-side-pad, 0)) var(--dp-side-pad, 0) 0;
  }
  /*
     * 横にしたスマホでは、一覧から選ぶと映像へ滑って戻る (`backToPicture`)。巻くのは外枠 (`PlayerLayout` の `.layout`)。
     * 局の一覧を出しているこの画面のこの形だけにする (条件は `PHONE_LANDSCAPE` と同じ)
     */
  @media (orientation: landscape) and (max-height: 500px) and (pointer: coarse) and (prefers-reduced-motion: no-preference) {
    :global([data-player-layout]:has(> [data-player-side] > .live-side)) {
      scroll-behavior: smooth;
    }
  }
  /* 測り直す操作。読みものの行に置くので、ボタンの形にはしない */
  .relearn {
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-decoration: underline dotted;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .relearn:hover {
    color: var(--dp-on-video);
  }
  /* 録画に譲った通知。通知の列は押せない (`PlayerStage`) ので、この通知だけ押せるように戻す。見た目は StageNote と同じ (`.stage-note`) */
  .yielded {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.25rem 0.25rem 0.25rem 0.75rem;
    pointer-events: auto;
  }
  .back-live {
    width: auto;
    margin: 0;
    padding: 0.125rem 0.75rem;
    border: 0;
    background: transparent;
    color: var(--dp-on-video);
    font-weight: var(--dp-weight-bold);
    font-size: var(--dp-text-xs);
  }
  .back-live:hover:not(:disabled) {
    background: var(--dp-on-video-hover);
  }
  .unmute {
    --pico-background-color: var(--dp-video-veil);
    position: absolute;
    top: 0.75rem;
    left: 0.75rem;
  }
  /* 列の幅いっぱいに伸びるので、タブを均等に広げる。左に寄せると右に溝だけが余った */
  .type-tabs {
    display: flex;
    margin-bottom: 0.5rem;
  }
  .type-tabs > button {
    flex: 1;
  }
  .channels {
    flex: 1;
    margin: 0 calc(-1 * var(--dp-side-pad, 0px));
    /* 行の面の端は上の種別のタブの端と同じ所。巻き取る箱は列の幅いっぱい (スクロールバーは窓の右端) */
    padding: 0 var(--dp-side-pad, 0px) var(--dp-side-pad, 0);
    overflow-y: auto;
  }
  /* 高さの決まった列の中で巻く (二段組と、テーブルトップの下の段。`PlayerLayout`) */
  @media (min-width: 1000px),
    (device-posture: folded) and (vertical-viewport-segments: 2) {
    .channels {
      min-height: 0;
    }
  }
  /* 一行 = 局を選ぶボタンと中身を読むボタン。指を乗せたときの地と左の縦線は行に付ける (`app.css` の `.side-item`) */
  .channel-item {
    flex-shrink: 0;
    align-items: stretch;
    gap: 0;
    padding: 0;
    font-size: inherit;
    /* 地は行の決まりと同じ。並べ直した行は前の場所から滑る (上の `slide`) */
    transition:
      background-color var(--dp-duration),
      translate var(--dp-duration-move) var(--dp-ease-spring);
  }
  /* 並べ直した直後の 1 回だけ、前の場所にずらして置く (印を外すと滑る。印は `slide` が付けるので、Svelte からは見えない) */
  .channel-item:global([data-slide]) {
    translate: 0 var(--slide-from);
    transition: none;
  }
  .channel {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 0.75rem;
    margin: 0;
    padding: 0.5rem 0.75rem;
    border: 0;
    border-radius: var(--dp-radius);
    background: transparent;
    color: inherit;
    text-align: left;
    font-size: inherit;
    font-weight: var(--dp-weight);
    cursor: pointer;
  }
  /*
     * 番号は局名の頭に小さく淡く。2 桁ぶん取って右に寄せ、局名の頭をそろえる
     * (E2E 20 の「種別のタブと下の一覧の端がそろう」)
     */
  .channel-number {
    display: inline-block;
    min-width: 2ch;
    margin-right: 0.375rem;
    text-align: right;
    font-size: var(--dp-text-xs);
    font-variant-numeric: tabular-nums;
    color: var(--dp-muted);
  }
  .channel-text {
    min-width: 0;
    flex: 1;
  }
  .channel-name,
  .channel-now {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .channel-name {
    font-size: var(--dp-text-sm);
  }
  /* 字の色は行の決まり (`app.css` の `.side-item`) が付ける。太字にするのは局名だけ */
  .channel[aria-current] .channel-name {
    font-weight: var(--dp-weight-bold);
  }
  .channel-now {
    font-size: var(--dp-text-xs);
    color: var(--dp-muted);
  }
  /* 「実況」タブは種別が混ざる (地上波は 1〜2 桁、BS・CS は 3 桁) ので、番号の幅を 3 桁にそろえる */
  .channels[data-mixed] .channel-number {
    min-width: 3ch;
  }
  /* 勢いは控えた字のまま、数字の幅をそろえる (書き換わっても番組名が揺れない) */
  .force {
    font-variant-numeric: tabular-nums;
  }
  /* 勢いを読めないときの 1 行。一覧の行と同じ左の余白で、控えた字 */
  .ranking-note {
    margin: 0;
    padding: var(--dp-space-2) var(--dp-space-3);
    font-size: var(--dp-text-xs);
    color: var(--dp-muted);
  }
  .channel-detail {
    height: auto;
    flex-shrink: 0;
    align-self: stretch;
    margin: 0;
  }
  /* (i) はマウスでは行に乗せたとき (フォーカスしたとき) だけ出す (並べると局名より目立つ)。指の端末ではいつも */
  @media (hover: hover) and (pointer: fine) {
    .channel-detail {
      opacity: 0;
      transition: opacity var(--dp-duration);
    }
    .channel-item:is(:hover, :focus-within) .channel-detail {
      opacity: 1;
    }
  }
</style>
