<script lang="ts">
  import { resolve } from "$app/paths";
  import { onMount, untrack } from "svelte";

  import { submitting } from "#lib/actions.js";
  import { arming } from "#lib/arming.svelte.js";
  import DriveNotice from "#lib/components/DriveNotice.svelte";
  import CloseLink from "#lib/components/player/CloseLink.svelte";
  import ControlBar from "#lib/components/player/ControlBar.svelte";
  import ControlButton from "#lib/components/player/ControlButton.svelte";
  import ControlRow from "#lib/components/player/ControlRow.svelte";
  import { playerControls } from "#lib/components/player/controls.svelte.js";
  import { dataReceiveNote } from "#lib/components/player/data-receive.js";
  import DataBroadcast, {
    pressD,
  } from "#lib/components/player/DataBroadcast.svelte";
  import Extras from "#lib/components/player/Extras.svelte";
  import FactsAside from "#lib/components/player/FactsAside.svelte";
  import { stageFullscreen } from "#lib/components/player/fullscreen.svelte.js";
  import {
    AUDIO,
    CAMERA,
    CAPTION,
    CHECK,
    CODEC,
    JIKKYO,
    NEXT,
    PAUSE,
    PLAY,
    PREV,
    SOUND_OFF,
    SPEED,
    TRASH,
  } from "#lib/components/player/icons.js";
  import InfoBlock from "#lib/components/player/InfoBlock.svelte";
  import JikkyoLayer from "#lib/components/player/JikkyoLayer.svelte";
  import JikkyoList from "#lib/components/player/JikkyoList.svelte";
  import { dataRemoteKey, playerKeys } from "#lib/components/player/keys.js";
  import NewYear from "#lib/components/player/NewYear.svelte";
  import PlayerLayout from "#lib/components/player/PlayerLayout.svelte";
  import PlayerStage from "#lib/components/player/PlayerStage.svelte";
  import PlayerVeil from "#lib/components/player/PlayerVeil.svelte";
  import Remote from "#lib/components/player/Remote.svelte";
  import SeekBar from "#lib/components/player/SeekBar.svelte";
  import {
    audioTracks,
    muteRow,
    recordingCodecs,
    speedRow,
    subtitles,
  } from "#lib/components/player/settings.js";
  import { snapshotter } from "#lib/components/player/shot.svelte.js";
  import { captionWords } from "#lib/components/player/snapshot.js";
  import SoundButton from "#lib/components/player/SoundButton.svelte";
  import SpeedMenu from "#lib/components/player/SpeedMenu.svelte";
  import { stageTap } from "#lib/components/player/stage-tap.js";
  import StageNote from "#lib/components/player/StageNote.svelte";
  import StageTail from "#lib/components/player/StageTail.svelte";
  import VolumeNote from "#lib/components/player/VolumeNote.svelte";
  import { playerWiring } from "#lib/components/player/wiring.svelte.js";
  import ProgramFacts from "#lib/components/ProgramFacts.svelte";
  import Toasts, {
    errorNotice,
    type Notice,
  } from "#lib/components/Toasts.svelte";
  import { programDetail, recordingFacts } from "#lib/detail.svelte.js";
  import {
    clock,
    cmNoteWorthShowing,
    recordedDuration,
    size,
  } from "#lib/format.js";
  import { JikkyoFeed } from "#lib/jikkyo/feed.svelte.js";
  import { jikkyoListSwitch, jikkyoSwitch } from "#lib/jikkyo/switch.svelte.js";
  import { read as stored, write as remind } from "#lib/keep.js";
  import { liveUpdates } from "#lib/live-updates.svelte.js";
  import { fixedMediaVolume } from "#lib/native-audio-choice.js";
  import { offline, removeLocal } from "#lib/offline.svelte.js";
  import { recordingPlayback } from "#lib/player/core-recording.svelte.js";
  import { BRIEF_NOTE, Note } from "#lib/player/notes.svelte.js";
  import { keepResume, keepResuming } from "#lib/resume.js";
  import { stepSpeed } from "#lib/ts/pacing.js";
  import type { CodecChoice, PlaybackInfo } from "#lib/ts/playback.js";
  import {
    CallGaps,
    type Chapter,
    chapterAt,
    cmLead,
    cmSpans,
    isCm,
    nextChapterAt,
    nextCmStart,
    plainMarks,
    playbackAt,
    prevChapterAt,
    type Ruler,
    skipCmAtStart,
    skipTarget,
    toTsTime,
  } from "#lib/ts/watch.js";

  let { data, form } = $props();
  const rec = $derived(data.recording);
  /** 観るものがあるか。エンコード済みか、録り終えた元の TS (`+page.server.ts`) */
  const ready = $derived(data.playable);

  /**
   * **再生の核 (`player/core-recording.svelte.ts`)。** どれで観るか・読み出し側・段の切り替え・字幕・データ放送・断り書きを持つ。
   * この画面は CM 飛ばし・チャプター・実況・どこまで観たか・削除を持ち、核がコマを映すたびに CM を跨ぐかを決める (`hooks`)
   */
  const player = recordingPlayback({
    recording: () => rec,
    // svelte-ignore state_referenced_locally
    scene: data.scene,
    ready: () => ready,
    indoor: () => data.indoor,
    hasData: () => data.hasData,
    autoStart: () => data.autoStart,
    stir: () => controls.stir(),
    wiring: () => wiring,
    hooks: {
      arrive,
      frame,
      covering: () => hopping,
      waiting: () => waiting,
      settle,
      ended: finished,
    },
  });

  /** 映像とその上の操作をまとめた箱。全画面にするのはこちら */
  let stage = $state<HTMLElement | null>(null);
  /** 全画面の出入り (3 画面共通。[fullscreen.svelte.ts](../../../lib/components/player/fullscreen.svelte.ts)) */
  const fullscreen = stageFullscreen(() => stage);

  /** 自動で受信するかを切り替えたときの通知 */
  const dataReceive = new Note();
  /** リモコンのキーを渡す関数と、d を文書へ渡す関数 (`DataBroadcast` の press / pressD) */
  let dataPress = $state<((code: number) => void) | null>(null);
  /** データ放送が映像の上に出す通知 (`DataBroadcast` の `note`。舞台の通知の列に積む) */
  let dataNote = $state("");
  let dataButton = $state<(() => boolean) | null>(null);
  /** データ放送を自動で受信するかを切り替える (⚙ の「データ放送」の長押し・Shift+D)。切り替えたら通知を出す (ライブと同じ) */
  function toggleReceiveData(): void {
    player.toggleReceiveData();
    dataReceive.show(dataReceiveNote(player.receiveData), BRIEF_NOTE);
  }

  /**
   * 実況のコメント (docs/watch.md の「実況のコメント」)。世帯の設定と端末の ⚙ の両方がオンなら、
   * 録画の区間のコメントを過去ログ API から開いたときに 1 回で取り、再生位置の放送時刻に合わせて流す
   */
  const jikkyoOn = jikkyoSwitch();
  const jikkyo = new JikkyoFeed(false);
  $effect(() => jikkyo.setNg(data.jikkyoNg));
  const jikkyoActive = $derived(data.jikkyoAllowed && jikkyoOn.on);
  $effect(() => {
    const target = data.jikkyo;
    jikkyo.set(target?.channel ?? null, jikkyoActive);
    // 録画の終わりは予定なので、少し後ろまで取得する (今より後は fetchKakolog が切る)
    if (target !== null && jikkyoActive)
      untrack(() => jikkyo.kakolog(target.head, () => target.end + 60_000));
  });
  onMount(() => () => jikkyo.close());

  /**
   * 右の列に出す「コメントの一覧」(`JikkyoList`)。流しているときと同じ条件で、映像の右端に縦に並ぶボタンで出す (端末ごとに覚える)。
   * 右の列の無い形 (横にしたスマホ・全画面) では出さず、ボタンも置かない。時刻は録画の中の再生位置で出し、押すとそこへ飛ぶ
   */
  const jikkyoList = jikkyoListSwitch(
    () => jikkyoActive && data.jikkyo !== null,
    () => fullscreen.active,
  );
  /**
   * 放送時刻 `at` が、観ているもの (エンコードしたもの・元の TS) のどこか (`airTime` の逆)。
   * 録画の先頭より前は「開始前」、切った CM の中は「CM」で、飛べない
   */
  function placeAir(at: number): number | "before" | "cut" {
    if (player.info === null) return "before";
    return playbackAt((at - data.head) / 1000, ruler(player.info));
  }

  /** 観ているものの物差し (`Ruler`)。元の TS なら null */
  function ruler(plan: PlaybackInfo): Ruler | null {
    return plan.axis === "encoded"
      ? { kept: rec.cm_kept, skip: rec.encode_skip ?? 0 }
      : null;
  }

  /**
   * いま観ている場面の放送時刻。再生位置を元の TS の秒に直して (CM を切ったものは切った区間を戻して) 先頭の放送時刻に足す。
   * 実況のコメントとデータ放送の時計 (`clock`) が使う。**切った CM の区間は飛び越すので、そこに書かれたコメントは流れない**
   */
  function airTime(): number | null {
    if (player.info === null) return null;
    return data.head + toTsTime(player.mediaTime(), ruler(player.info)) * 1000;
  }

  let chapters = $state<Chapter[]>([]);
  /** シークバーをつまんで動かしている間の位置 (`SeekBar` の `scrub`)。触っていなければ `null` */
  let scrub = $state<number | null>(null);

  /** 操作バーの出し入れ ([controls.svelte.ts](../../../lib/components/player/controls.svelte.ts)) */
  const controls = playerControls();

  /**
   * 画面を暗くさせない処理・バックグラウンド再生・アンビエントモード・小窓・音量 (3 画面で共通。`wiring.svelte.ts`)。
   * 裏から戻ったら止めた所から
   */
  const wiring = playerWiring({
    target: player.target,
    video: () => player.video,
    overlay: () => player.overlay,
    pause: player.pause,
    resume: player.play,
    // WebKit は MSE の `<video>` を通すと無音になる。その場で流しているもの (`remux-player.ts`) は通さない
    silentTap: player.silentTap,
    // iPhone・iPad は `<video>` の音量を変えられない。どの経路でもつまみを出さず、放送のままの大きさで鳴らす
    fixed: fixedMediaVolume,
  });
  const { background, ambient, pip, volume } = wiring;

  /**
   * CM を自動で飛ばすか (CM はチャプターとして動画に入っている)。端末ごとに覚える。
   * 観はじめに入れるかどうかは `skipCmAtStart` (ロゴでの判定に失敗した 1 本はオフで始める)
   */
  const SKIP_CM_KEY = "watch-skip-cm";
  let skipCm = $state(false);
  /** CM を飛ばしたことを短く出す。何も出さずに飛ぶと壊れたように見える */
  const skipNote = new Note();
  /** 跨いでいる間、最後の本編のコマで覆っているか (覆う面は核の `cover`) */
  let hopping = $state(false);
  /**
   * 飛んだ先が映るのを待っているか。`hopping` とは別。開いた直後は覆いだけ先に出してチャプターを待つが、
   * まだ飛ぶ判断はしていないので、覆いを理由に `hopCm` を止めてはいけない
   */
  let waiting = false;
  /** 飛んだ先 (秒)。ここまで来たら覆いを外す */
  let hopTo = 0;
  /** 飛んだ先に着いたと数えたコマ数。`SETTLED` まで数えてから覆いを外す */
  let settled = 0;
  /**
   * 覆いを外すまでに待つコマ数。`requestVideoFrameCallback` はコンポジタへ渡したところで呼ばれ、
   * Windows の Chrome / Edge は映像を DOM と別の面に出すので、1 コマで外すと画面だけ CM のまま残る
   * (実機)。4 コマ (0.13 秒) なら飛んだ間合いに紛れる。`mediaTime` の無いブラウザは `currentTime` で数える
   */
  const SETTLED = 4;
  /** 覆いの外し忘れ止め。飛んだ先が来ないまま止まっても、いつかは外す */
  let hopGiveUp: ReturnType<typeof setTimeout> | null = null;
  /** 覆っておく上限 (ms) */
  const HOP_GIVE_UP = 2_000;

  /** 押し間違い防止に 2 回押させる (どの画面とも同じ。`arming.svelte.ts`) */
  const deleting = arming('[data-testid^="watch-delete"]');

  const detail = programDetail();

  /**
   * 開いたら、そのまま観はじめる。一覧の行を押したことで得た許可 (user activation) がまだ効いているので
   * `play()` も全画面も通る。読み込み直したときだけ通らないので、どちらも失敗しても無視する
   */
  onMount(() => {
    skipCm = skipCmAtStart(rec.cm_note, stored(SKIP_CM_KEY));
    // チャプターが来るまで覆っておく (始まりが CM のことが多い。`settle`)
    if (skipCm) shut();
    void loadChapters().then(() => {
      chaptersReady = true;
      settle();
    });
    void detail.open(rec.program_id, facts);
    if (!ready) return;
    // 指のときは最初から全画面 (観るために置いてある画面)。画面の幅では決めない (幅で決めると狭いウィンドウの PC まで全画面になる)
    if (window.matchMedia("(pointer: coarse)").matches) fullscreen.enter();
    // 15 秒おきは再生している間だけ。閉じ際はいつも送る
    const stopResuming = keepResuming((leaving) => {
      if (leaving || player.playing) remember(leaving);
    });
    return () => {
      stopResuming();
      deleting.fire();
      skipNote.close();
      dataReceive.close();
      if (hopGiveUp !== null) clearTimeout(hopGiveUp);
    };
  });

  // 全画面の出入り (iPhone で広げたときは `resize` が来ない) で、字幕と覆いを映像に重ね直す
  $effect(() => {
    void fullscreen.active;
    const frame = requestAnimationFrame(player.place);
    return () => cancelAnimationFrame(frame);
  });

  /**
   * **どこまで観たかを覚える。** 覚えるかどうかの判断は `ts/watch.ts` が持つ
   * (サーバも同じものを見る)。送り方は追っかけと共通 (`#lib/resume.ts`)
   */
  function remember(leaving = false): void {
    if (!ready) return;
    const now = player.progress();
    if (now === null) return;
    keepResume(rec.id, now.at, now.duration, player.info?.axis, leaving);
  }

  /**
   * **末尾まで来たことを、その場で覚える** (`onended`)。控えは 15 秒おきで流れている間だけなので、
   * 末尾の CM を自動で飛ぶと終端の控えが書かれず、一覧で観かけのまま残っていた (`ts/watch.ts` の `resumePoint`)。
   * `remember` を直に渡すと `leaving` にイベントが入って真になるので包む
   */
  function finished(): void {
    remember();
  }

  /**
   * チャプターの位置 (`api/recordings/<id>/chapters`)。CM もチャプターなので、そのまま CM 飛ばしになる。
   * 無い録画もあり、取れなければ送りのボタンを出さないだけ
   */
  async function loadChapters(): Promise<void> {
    try {
      // 端末に保存したものがあればそちら (オフラインでも CM 飛ばしが効く)。探し終えるのを待ってから
      const copy = await player.localLookup;
      const held = copy?.chapters as { chapters?: typeof chapters } | undefined;
      if (held?.chapters !== undefined) {
        chapters = held.chapters;
        return;
      }
      // 前に読んだものを持っていても、変わっていないか確かめさせる (CM 検出のやり直しは同じファイルを書き直す)
      const res = await fetch(player.feed.chaptersUrl, {
        cache: "no-cache",
      });
      if (!res.ok) return;
      chapters = (await res.json()).chapters ?? [];
    } catch {
      // 出せないだけ。観るのに支障は無い
    }
  }

  /**
   * CM 検出をやり直したら、チャプターだけ取り直す (`chapters` の通知)。位置も再生も触らない
   * (いまいる所が CM になれば次のコマで `hopCm` が飛ぶ)。端末に保存したものは保存したときのまま
   */
  liveUpdates([], {
    chapters: (payload) => {
      if ((payload as { recordingId?: unknown }).recordingId === rec.id)
        void loadChapters();
    },
  });

  /** CM 飛ばしのオン/オフ。いま CM の中にいればその場で飛ぶ (「CM が始まったから押した」がいちばん多い) */
  function toggleSkipCm(): void {
    skipCm = !skipCm;
    remind(SKIP_CM_KEY, skipCm ? "1" : "0");
    if (skipCm) hopCm();
    controls.stir();
  }

  /**
   * 飛んだ先が映ったかを数える (`RecordingHooks.arrive`)。`<video>` は映したコマごとに、飛んでいる最中か飛んだ先より手前なら数え直す。
   * canvas は刻みごとに、流れていて飛んだ先に来ていれば数える
   */
  function arrive(at: number, ready: boolean, canvas: boolean): void {
    if (!waiting) return;
    if (canvas) {
      if (ready && at >= hopTo && ++settled >= SETTLED) open();
      return;
    }
    if (!ready || at < hopTo) settled = 0;
    else if (++settled >= SETTLED) open();
  }

  /** コマを映した・刻んだ (`RecordingHooks.frame`)。canvas には CM の先頭を渡し、呼んだ間隔を測って、CM の中なら飛ぶ */
  function frame(shown: number | undefined, flowing: boolean | null): void {
    guardCm();
    if (flowing !== null) markCall(flowing);
    hopCm(shown);
  }

  /**
   * CM を跨ぐ判断をした呼び出しの間隔 (`ts/watch.ts` の `CallGaps`)。`<video>` は映したコマごと (`follow`)、
   * canvas は刻みごと (`canvasTick`) に測る。画面の処理が詰まって間遠になっていれば、先読み (`cmLead`) を伸ばす
   */
  const callGaps = new CallGaps();

  /** CM の手前で飛ぶ判断をする呼び出しが来た。流れている間だけ間隔を測り、止めた・飛んでいる間は数えない */
  function markCall(flowing: boolean): void {
    if (flowing && !waiting) callGaps.mark(performance.now());
    else callGaps.pause();
  }

  /**
   * 次の CM の先頭を、canvas のプレイヤーに「ここから先は描かない」と渡す (`canvas-player.ts` の `stopAt`)。
   * 画面の刻み (40 ms) が遅れて飛ぶのが間に合わなくても、CM の 1 コマ目は描かれず、本編の最後のコマのまま飛ぶ。
   * 飛ばさないとき (オフ・つまんでいる最中・作り直している最中) は外す
   */
  function guardCm(): void {
    if (!player.hasCanvas()) return;
    player.stopAt(
      skipCm && scrub === null && !player.holding
        ? nextCmStart(chapters, player.mediaTime())
        : null,
    );
  }

  /**
   * CM の中にいたら、その終わりまで飛ぶ (続いている CM はまとめて。判断は `ts/watch.ts`)。
   * `shown` は `<video>` が映したばかりのコマの時刻 (`follow`)。位置 (`currentTime`) より先にいることがある
   * (Chromium は次の画面の切り替わりに出すコマを先に渡す) ので、先にいるほうで決める
   */
  function hopCm(shown?: number): void {
    // 飛んだ先を待っている最中と、シークバーをつまんでいる最中 (離したら着いた先で決める) は飛ばない
    if (waiting || !skipCm || !player.hasMedia()) return;
    // 段を替えるために作り直している最中も飛ばない。位置はまだ観ていた所に戻っていない (`hold`)
    if (scrub !== null || player.holding) return;
    const now = player.mediaTime();
    // 飛んだ直後のコマは飛ぶ前の時刻を持っていることがある (`unslip`)。離れていれば使わない
    const here =
      shown !== undefined && Math.abs(shown - now) < 1
        ? Math.max(now, shown)
        : now;
    // canvas は早送りしない (`setSpeed`)
    const lead = cmLead(
      player.hasCanvas() ? 1 : player.speed,
      callGaps.worst(performance.now()),
    );
    const to = skipTarget(chapters, here, lead);
    if (to === null) return;
    /*
     * canvas は覆わない。プレイヤーは CM の先頭から先を描かず (`guardCm`)、飛んだあとも飛び先より前のフレームを捨て、
     * 描けるまで本編の最後のコマを出したままにする (`raw/worker.ts` の `floor`)。字幕だけ消す
     */
    if (!player.hasCanvas()) shut(here);
    else player.clearCaptions();
    hopTo = to;
    waiting = true;
    player.seekMedia(to);
    // 続きから始めたばかりなら、そちらだけ言う (CM を跨いだのは中の都合)
    if (player.continued) return;
    skipNote.show("CM を飛ばしました", BRIEF_NOTE);
  }

  /**
   * いま映っているコマを写して覆う (飛ぶ前に呼ぶ)。写すのは本編にいるときだけ。CM の中
   * (チャプターがまだ無いときも) で写すと覆いが CM の 1 コマになる。写せないときは黒で塗って枠ごと覆う。
   * CM の字幕も一緒に消す。`at` は映っているコマの位置 (`hopCm`。省けば `currentTime`)
   */
  function shut(at?: number): void {
    const video = player.video;
    const cover = player.cover;
    const here =
      video === null ? null : chapterAt(chapters, at ?? video.currentTime);
    const source =
      video !== null &&
      here !== null &&
      !isCm(here.title) &&
      video.videoWidth > 0
        ? video
        : null;
    const ctx = cover?.getContext("2d") ?? null;
    if (cover !== null && ctx !== null) {
      cover.width = source?.videoWidth ?? 16;
      cover.height = source?.videoHeight ?? 9;
      if (source !== null) {
        try {
          ctx.drawImage(source, 0, 0, cover.width, cover.height);
        } catch {
          // 写せなかった。黒いままなので、下は見えない
        }
      } else {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, cover.width, cover.height);
      }
    }
    player.blanked = source === null;
    hopping = true;
    player.clearCaptions();
    player.place();
    if (hopGiveUp !== null) clearTimeout(hopGiveUp);
    hopGiveUp = setTimeout(open, HOP_GIVE_UP);
  }

  /** 覆いを外す。飛んだ先が映ったとき (`follow`) と、待つ上限の時間を過ぎたとき */
  function open(): void {
    hopping = false;
    waiting = false;
    settled = 0;
    if (hopGiveUp !== null) {
      clearTimeout(hopGiveUp);
      hopGiveUp = null;
    }
  }

  /**
   * 観はじめの 1 回。チャプターが揃い、始める位置 (続きか先頭か。`resume`) も決まってから、始まりが CM なら飛ぶ。
   * 取得している間は黒く覆っておく (本編前の CM が一瞬流れていた)。位置を待たないと始まりの CM を
   * 飛んでから続きへ移り、リロードのたびに「CM を飛ばしました」が出ていた。両方から呼び、遅いほうで決める
   */
  let chaptersReady = false;
  function settle(): void {
    if (!chaptersReady || !player.resumed) return;
    hopCm();
    // 飛ばなかった (CM ではなかった・切ってある)。覆いは要らない
    if (!waiting) open();
  }

  /** 映像を押されたときの読み方は追っかけと同じ (`stage-tap.ts`) */
  const press = stageTap({
    toggle: player.togglePlay,
    controls: () => controls.toggle(),
    seekBy: player.seekBy,
  });

  /**
   * キーでも動かせるようにする。全画面のときはこれがいちばん早い。
   * **割り当てはライブ・追っかけと共通** (`components/player/keys.ts`。修飾キーの扱いもあちら)。
   * データ放送を出している間の空白・十字キーはあちらのリモコン (`dataRemoteKey`。ライブと同じ)
   */
  const playerKey = playerKeys({
    togglePlay: player.togglePlay,
    seekBy: player.seekBy,
    toggleCaptions: player.toggleCaptions,
    snapshot,
    toggleFull: fullscreen.toggle,
    stepSpeed: (by) => player.setSpeed(stepSpeed(player.speed, by)),
    toggleMute: player.toggleMute,
    stepVolume: volume.step,
    toggleDataAuto: () => {
      if (data.hasData) toggleReceiveData();
    },
  });
  function keys(event: KeyboardEvent): void {
    if (player.showData && dataRemoteKey(event)) return;
    playerKey(event);
  }

  const current = $derived(chapterAt(chapters, player.at));
  /** CM の入っている録画でだけ、飛ばすボタンを出す (押しても何も起きない操作を並べない) */
  const hasCm = $derived(chapters.some((chapter) => isCm(chapter.title)));
  /** シークバーで琥珀に塗る CM の区間と、それ以外の切れ目 */
  const cmOnBar = $derived(cmSpans(chapters));
  const marksOnBar = $derived(plainMarks(chapters));

  /** あと何分で終わるか。倍速のぶんは割る (2 倍で「残り 30 分」と出ても掛かるのは 15 分) */
  const remaining = $derived(
    Math.max(
      0,
      (player.length - player.at) / (player.drawing ? 1 : player.speed || 1),
    ),
  );

  /** 右に出す中身。録画の行が持っているぶん (追っかけと同じ)。番組表から引けたら `detail` が差し替える */
  const facts = $derived(recordingFacts(rec));

  /** 切り抜き。保存できたか・端末に保存したかを言う */
  const shooter = snapshotter(controls);

  /**
   * **録画の再生中は選局できない。** データ放送が「この局へ」と求めたら (epgTune)、文書には失敗を
   * 返し (`DataBroadcast` の tune)、観ている人にはそう知らせる
   */
  let tuneRefused = $state<Notice | null>(null);
  function refuseTune(): boolean {
    tuneRefused = {
      key: `tune-${Date.now()}`,
      kind: "info",
      text: "録画の再生中は選局できません",
    };
    return false;
  }

  /** 削除は断られたときだけ知らせる (消せたら一覧へ戻る) */
  const notices = $derived<Notice[]>([
    ...errorNotice(form, "watch-delete"),
    ...shooter.notices,
    ...pip.notices,
    ...(tuneRefused === null ? [] : [tuneRefused]),
  ]);

  /**
   * いまの 1 コマを字幕・コメントごと切り抜いてサーバに保存する (3 画面共通。[shot.svelte.ts](../../../lib/components/player/shot.svelte.ts))。
   * canvas に描いているときはプレイヤーから 1 枚もらう (`<video>` は空)
   */
  function snapshot(): void {
    const captions = player.captions;
    const drawn = captions.on && captions.shown !== null;
    void shooter.take(
      player.frame,
      drawn ? player.overlay : null,
      rec.name,
      () => ({
        place: "watch",
        recording: rec.id,
        at: player.mediaTime(),
        source: player.info?.axis,
      }),
      drawn ? captionWords(captions.shown) : "",
    );
  }
</script>

<svelte:head><title>{rec.name} - denpa</title></svelte:head>
<svelte:window onclick={deleting.stand} onkeydown={keys} />

<!-- ライブ (`/live`) と同じレイアウト (PlayerLayout)。映像が左、読むものが右 -->
<PlayerLayout testid="watch">
  {#if !ready}
    <!-- 録っている最中は load が追っかけへ送るので、ここに来るのはエンコード済みも元の TS も無い録画 -->
    <!-- 1 つだけ言う画面 (`app.css` の `.solo`。開けなかったときと同じ置き方) -->
    <div class="solo glow">
      <h1>まだ観られません</h1>
      <p>観られるファイルがありません。</p>
      {#if rec.encode_error}
        <p>{rec.encode_error}</p>
      {/if}
    </div>
  {:else}
    <PlayerStage
      {controls}
      {fullscreen}
      {ambient}
      pip={pip.active}
      testid="watch-stage"
      bind:element={stage}
    >
      {#snippet children(layout)}
        <!--
          **映像の箱。データ放送はこれを小窓へ寄せる** (`DataBroadcast` の `placeVideo`)。ライブと同じ。
          押すのは映像そのもので、ボタンはその上に重ねる (`--dp-z-stage-controls`)
        -->
        <div
          bind:this={player.mediaBox}
          style="position:absolute; inset:0; width:100%; height:100%;"
        >
          <!--
            `<video>` は 2 つ。映していない側 (透明・消音) は、段を替えるときに次の観かたを用意する間だけ読み込む (`prepareStep`)。
            イベントは映している側のものだけ受ける (空にした側の位置 0 で CM を飛んだりしない)
          -->
          {#each [0, 1] as slot (slot)}
            {@const shown = slot === player.front}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              bind:this={player.videos[slot]}
              src={shown ? player.src : player.spareSrc}
              style="position:absolute; inset:0; width:100%; height:100%; background:var(--dp-video);"
              style:opacity={shown ? null : "0"}
              style:pointer-events={shown ? null : "none"}
              playsinline
              aria-hidden={shown ? undefined : "true"}
              data-spare={shown ? undefined : ""}
              onclick={(event) => {
                if (event.currentTarget === player.video) press(event);
              }}
              onplay={player.events.play}
              onpause={player.events.pause}
              onended={player.events.ended}
              onwaiting={player.events.waiting}
              onstalled={player.events.waiting}
              onseeking={player.events.seeking}
              onplaying={player.events.flowing}
              oncanplay={player.events.flowing}
              ontimeupdate={player.events.timeupdate}
              onseeked={player.events.seeked}
              onsuspend={player.events.suspend}
              onloadedmetadata={player.events.loadedmetadata}
              onvolumechange={player.events.volumechange}
              onerror={player.events.error}
              data-testid={shown ? "watch-video" : "watch-video-spare"}
            >
            </video>
          {/each}
          <div bind:this={player.jikkyoSlot} style="display:contents">
            {#if data.jikkyoAllowed}
              <JikkyoLayer
                feed={jikkyo}
                air={airTime}
                show={jikkyoActive && data.jikkyo !== null && !player.showData}
                paused={!player.playing}
                rate={player.drawing ? 1 : player.speed}
                ahead
              />
            {/if}
          </div>
          <!--
            字幕は `<track>` ではなく canvas に放送の置き場所のまま描く (左右の位置・背景の箱・外字が落ちるため)。
            映像と同じ箱に入れて、データ放送の小窓へ一緒に縮ませる (ライブの `MediaStack` と同じ)。
            位置と大きさは `place` が書く。段は実況のコメント (`--dp-z-stage-comments`) より上、操作バーのボタン (`--dp-z-stage-controls`) より下
          -->
          <canvas
            bind:this={player.overlay}
            style="position:absolute; z-index:var(--dp-z-stage-captions); pointer-events:none;"
            data-testid="watch-captions-canvas"
            data-on={player.captions.on && player.hasCaptions}
            aria-hidden="true"
          ></canvas>
          <!--
            CM を跨ぐ間と、段を替えるためにプレイヤーを作り直す間 (`hold`) の覆い。字幕と同じ段で、字幕のあとに置くので上に重なる。操作バーや通知 (`--dp-z-stage-controls`) の下。出し入れは `hidden` で。
            style に式を書くと `hopping` が変わるたびに書き直され、`place` が書いた位置と大きさが消える
          -->
          <canvas
            bind:this={player.cover}
            style="position:absolute; z-index:var(--dp-z-stage-captions); pointer-events:none;"
            hidden={!hopping && !player.holding}
            aria-hidden="true"
            data-testid="watch-cover"
            data-blank={player.blanked}
          ></canvas>
        </div>
        <!--
          録画のデータ放送。エンコードするときに取り出した変化ログ (`data.hasData`) を再生位置に合わせて流す
          (`feedData`/`listenData`)。双方向は使わない (録画した時点の送り先は、もう使えない)
        -->
        <DataBroadcast
          on={player.showData}
          receive={player.receiving}
          channel={player.dataChannel}
          media={player.mediaBox}
          listen={player.listenData}
          bind:press={dataPress}
          bind:pressD={dataButton}
          bind:note={dataNote}
          postal={data.broadcast.postalCode}
          prefecture={data.broadcast.prefecture}
          network={false}
          clock={airTime}
          shownAt={airTime}
          tune={refuseTune}
        />

        <!-- 年越しのカウントダウンと紙吹雪 (季節の演出)。年越しをまたぐ録画で、再生位置の放送の時刻で数える。データ放送を出している間は出さない -->
        <NewYear
          at={airTime}
          force={jikkyoActive && data.jikkyo !== null
            ? () => {
                const w = airTime();
                return w === null ? 0 : jikkyo.force(w);
              }
            : null}
          hidden={player.showData}
          testid="watch-new-year"
        />

        <!--
          観られないわけと、待っていることを言う幕 (`problem`)。見た目の決まりはライブ・追っかけと共通 (`PlayerVeil`)。
          観られないときは映像を暗く覆い、詰まりと繋ぎ直しの最中は映っている映像を覆わずに回るものだけを出す。
          何も出さずに止まっていると壊れたように見え、待てばいいのかが決められない (サーバの入れ替えでは数十秒繋がらない)
        -->
        {#if player.problem !== "" || player.buffering || player.resuming}
          <PlayerVeil
            holding={player.problem === ""}
            busy
            resuming={player.resuming}
            error={player.problem}
            detail={player.problemDetail}
            actions={player.lighter.length > 0 ? lighterChoices : undefined}
            testid="watch-status"
          />
        {/if}

        <!--
          右端の縦の列は観る流れの外の操作 (上から閉じる・切り抜き・コメントの一覧・削除。理由は `ControlBar`)。
          削除はいちばん下 (指が触れても 2 回押しで確かめる)。データ放送 (d) は ⚙ の中
        -->
        <ControlBar side shown={controls.shown} testid="watch-side">
          <CloseLink testid="watch-close" />
          <ControlButton
            icon={shooter.saved ? CHECK : CAMERA}
            label="この場面を切り抜く"
            testid="watch-shot"
            onclick={snapshot}
          />
          <!-- 右の列の先頭に「コメントの一覧」を出す・しまう (`jikkyoList`) -->
          {#if jikkyoList.can}
            <ControlButton
              icon={JIKKYO}
              label="コメントの一覧"
              on={jikkyoList.on}
              testid="watch-jikkyo-list"
              onclick={jikkyoList.toggle}
            />
          {/if}
          <!--
            観終わったその場で消せるように。2 回目も同じ大きさの丸 (`icons.ts` の `OVERLAY_DANGER`)。
            消せたら端末のコピーも片付け (一覧の行の削除と同じ)、断られたら 2 回押しを戻す (`ArmedDelete` と同じ)
          -->
          <form
            method="POST"
            action="?/delete"
            use:submitting={() =>
              async ({ result, update }) => {
                if (result.type === "redirect") {
                  if (offline.entries[rec.id] !== undefined)
                    void removeLocal(rec.id);
                } else deleting.fire();
                await update();
              }}
          >
            <input type="hidden" name="id" value={rec.id} />
            {#if deleting.armed !== null}
              <ControlButton
                icon={CHECK}
                label={offline.entries[rec.id] === undefined
                  ? "削除を確定"
                  : "端末とサーバから削除"}
                danger
                submit
                testid="watch-delete-confirm"
              />
            {:else}
              <ControlButton
                icon={TRASH}
                label="削除"
                testid="watch-delete"
                onclick={() => deleting.arm(rec.id)}
              />
            {/if}
          </form>
        </ControlBar>

        <!-- 下端の操作バー。並びは 3 画面で同じ (`ControlBar`・`ControlRow`) -->
        <ControlBar shown={controls.shown} testid="watch-controls">
          <!--
            シークバーの CM は琥珀で塗る (denpa-tv と同じ)。送りを何回押すかが分かる。
            色だけに頼らず、読み上げでは位置にいまのチャプターの名前を添える
          -->
          <SeekBar
            value={player.at}
            max={player.length || 0}
            step={0.1}
            onseek={player.seekTo}
            preview={player.drawing ? undefined : player.previewSeek}
            bind:scrub
            cm={cmOnBar}
            marks={marksOnBar}
            valuetext={current === null
              ? undefined
              : `${clock(player.at)}、${current.title}`}
            paused={!player.playing}
            testid="watch-seek"
          />

          <ControlRow testid="watch-buttons">
            <!--
              10 秒送り・戻しは置いていない。PC は矢印キー、指は左右の端を素早く 2 回
              (`ts/watch.ts` の `tap`) でできる
            -->
            <ControlButton
              icon={player.playing ? PAUSE : PLAY}
              label={player.playing ? "一時停止" : "再生"}
              testid="watch-play"
              onclick={player.togglePlay}
            />
            <!-- 畳むときは音と速さを ⚙ の先頭に入れる (`Extras`・`StageTail` の `fold`。字幕は ⚙ の「字幕」) -->
            <Extras>
              <SoundButton
                silenced={player.muted}
                testid="watch-sound"
                onclick={player.toggleMute}
                {volume}
              />

              <!-- 字幕を持っている録画でだけ出す。押しても何も起きない操作を並べない (`/live` と同じ) -->
              {#if player.hasCaptions}
                <ControlButton
                  icon={CAPTION}
                  label={player.captions.on ? "字幕を消す" : "字幕を出す"}
                  on={player.captions.on}
                  testid="watch-captions"
                  onclick={player.toggleCaptions}
                />
              {/if}
            </Extras>

            <!--
              チャプター送りは入っているときだけ (前のバージョンで CM を切ってエンコードしたものには無い)。
              畳むときも残す。CM や本編の始まりへ毎回のように使う
            -->
            {#if chapters.length > 1}
              <ControlButton
                icon={PREV}
                label="前のチャプター"
                onclick={() =>
                  player.seekTo(prevChapterAt(chapters, player.at))}
              />
              <ControlButton
                icon={NEXT}
                label="次のチャプター"
                testid="watch-next-chapter"
                onclick={() =>
                  player.seekTo(nextChapterAt(chapters, player.at))}
              />
            {/if}

            <InfoBlock
              range={{ start: rec.start_at, end: rec.end_at }}
              service={rec.service_name}
              title={rec.name}
              titleTestid="watch-name"
            >
              {#snippet prefix()}
                {#if player.local}
                  <!-- サーバではなく端末のコピーで観ている。事実なのでバッジにせず控えた字 (docs/design.md の「印の意味」) -->
                  <span class="local">端末</span><span class="local">・</span>
                {/if}
              {/snippet}
              {#snippet status()}
                <!-- 残りは倍速のぶんを割った実際に掛かる時間 (`remaining`)。狭い枠では `.long` を省く -->
                <span class="clock" data-testid="watch-clock">
                  {clock(scrub ?? player.at)} / {clock(player.length)}<span
                    class="long">{"・残り "}{clock(remaining)}</span
                  >
                </span>
                {#if current !== null}
                  <span class="long">{"・"}<span>{current.title}</span></span>
                {/if}
              {/snippet}
            </InfoBlock>

            <!-- 早送りは追っかけと同じ。canvas に描くとき (互換モード・MPEG-2) は等速だけ -->
            {#if !player.compat && !player.drawing}
              <Extras>
                <SpeedMenu
                  testid="watch-speed"
                  label="再生の速さ"
                  speed={player.speed}
                  onselect={(value) => player.setSpeed(value)}
                />
              </Extras>
            {/if}

            <!--
              ⚙ の行は使えるときだけ出す。CM スキップは CM の入った録画、コーデックは観られる方式が
              2 つ以上 (`codecMenu`)、音声は 2 本以上 (`syncAudio`)
            -->
            <StageTail
              prefix="watch"
              {volume}
              fold={[
                muteRow(SOUND_OFF, player.muted, player.toggleMute),
                ...(player.compat || player.drawing
                  ? []
                  : [
                      speedRow({
                        icon: SPEED,
                        label: "再生の速さ",
                        speed: player.speed,
                        onselect: (value) => player.setSpeed(value),
                      }),
                    ]),
              ]}
              {background}
              {ambient}
              {pip}
              {fullscreen}
              stage={layout}
              cm={hasCm ? { on: skipCm, toggle: toggleSkipCm } : undefined}
              data={data.hasData
                ? {
                    on: player.showData,
                    toggle: () =>
                      pressD(
                        player.showData,
                        dataButton,
                        (on) => void player.setData(on),
                      ),
                    auto: player.receiveData,
                    toggleAuto: toggleReceiveData,
                  }
                : undefined}
              jikkyo={data.jikkyoAllowed
                ? {
                    on: jikkyoOn.on,
                    toggle: jikkyoOn.toggle,
                    missing: data.jikkyo === null,
                    down: jikkyo.down,
                  }
                : undefined}
              subtitle={player.hasCaptions
                ? subtitles({
                    icon: CAPTION,
                    on: player.captions.on,
                    languages: player.captions.languages,
                    language: player.captions.language,
                    onoff: player.setCaptions,
                    onlanguage: player.setCaptionLanguage,
                  })
                : undefined}
              codec={player.codecMenu.length > 0
                ? recordingCodecs({
                    icon: CODEC,
                    choices: player.codecMenu,
                    selected: player.codecMenu.some(
                      (item) => item.key === player.choice,
                    )
                      ? player.choice
                      : "auto",
                    // 「自動」で段を下げている間は、いまの形式と高さを添える (「自動 (H.264 540p)」)
                    auto: player.autoLabel,
                    onpick: (key) =>
                      player.chooseCodec(key as CodecChoice | "mpeg2"),
                  })
                : undefined}
              audio={player.audios.length > 1
                ? audioTracks({
                    icon: AUDIO,
                    items: player.audios.map((label, i) => ({
                      key: i,
                      label,
                      active: i === player.audioIndex,
                    })),
                    onselect: (key) => player.selectAudio(key),
                  })
                : undefined}
            />
          </ControlRow>
        </ControlBar>
      {/snippet}

      <!-- 映像の上の通知は舞台の列に積む (`PlayerStage` の `notes`)。何も出さずに途中から始めたり飛んだりすると壊れて見える -->
      {#snippet notes()}
        {#if dataNote !== ""}
          <StageNote testid="watch-data-note">{dataNote}</StageNote>
        {/if}
        {#if dataReceive.text !== ""}
          <StageNote testid="watch-data-receive-note"
            >{dataReceive.text}</StageNote
          >
        {/if}
        {#if player.continued}
          <StageNote testid="watch-resumed">続きから再生しています</StageNote>
        {/if}
        {#if skipNote.text !== ""}
          <StageNote testid="watch-skipped">{skipNote.text}</StageNote>
        {/if}
        {#if player.warning !== ""}
          <!-- 互換モードの断り書き (切り替えた理由)。ライブと同じ出し方 -->
          <StageNote>{player.warning}</StageNote>
        {/if}
        {#if player.adaptNote !== ""}
          <!-- 回線に合わせて段を替えた理由 (`watch-adapt.ts`) -->
          <StageNote testid="watch-adapt">{player.adaptNote}</StageNote>
        {/if}
        <VolumeNote {volume} testid="watch-volume-note" />
      {/snippet}
    </PlayerStage>
  {/if}

  <!--
    右は番組の中身。観ながら読めるよう、映像に被せず全部ここに出す。番組の中身の下のボタンは、この録画の切り抜きへのリンクだけ
    (閉じる・削除は映像の上の列。全画面のタブレットで映像から出ずに押す)。データ放送のリモコンとコメントの一覧は、出している間だけ先頭に置く
  -->
  {#snippet aside()}
    <FactsAside testid="watch-facts">
      {#snippet top()}
        <!-- データ放送のリモコンは、出している間だけ右の列の先頭に出す (ライブと同じ) -->
        {#if dataPress !== null}
          <Remote press={dataPress} />
        {/if}
        <!-- 実況のコメントの一覧も、出している間は列の先頭 (リモコンの下) -->
        {#if jikkyoList.shown}
          <JikkyoList
            feed={jikkyo}
            air={airTime}
            place={placeAir}
            seek={player.seekTo}
            edge={() => data.jikkyo?.end ?? null}
          />
        {/if}
      {/snippet}

      <!-- 出演者などは番組表の側にある。引き直せたらそちら、引けない古い録画は行のぶんだけ -->
      <ProgramFacts
        program={detail.current ?? facts}
        cmNote={cmNoteWorthShowing(rec.cm_note) ? rec.cm_note : null}
        fps={rec.fps}
      />

      <div class="small muted meta num" data-testid="watch-meta">
        {recordedDuration(rec)}・{size(rec.ts_size)}
      </div>
      {#if data.clips > 0}
        <a
          class="small clips-link"
          href={resolve(`clips?recording=${rec.id}`)}
          data-testid="watch-clips"
          >この録画の切り抜き <span class="num">({data.clips})</span></a
        >
      {/if}
    </FactsAside>
  {/snippet}
</PlayerLayout>

<!-- サーバが混んでいるときに勧める、変換させずに観られるもの (幕の「サーバが混んでいます」の下) -->
{#snippet lighterChoices()}
  <div class="cluster choices">
    <!-- 主のボタンは先頭の 1 つだけ。残りは控え (docs/design.md の「ボタン」) -->
    {#each player.lighter as codec, at (codec)}
      <button
        type="button"
        class={at === 0 ? "small" : "small secondary"}
        data-testid="watch-busy-switch"
        onclick={() => player.chooseCodec(codec)}
      >
        {player.codecLabel(codec)} で観る
      </button>
    {/each}
  </div>
{/snippet}

<Toasts
  {notices}
  source={form}
  ondismiss={(key) => {
    shooter.dismiss(key);
    pip.dismiss(key);
    if (tuneRefused?.key === key) tuneRefused = null;
  }}
/>

<!-- 運転中の注意 (互換モードで初めて再生する前に 1 回。ライブ・追っかけと同じ)。押すまで再生を始めない -->
<DriveNotice open={player.drive.open} onaccept={player.drive.accept} />

<style>
  /* 幕のボタンは文言の下の真ん中に (`PlayerVeil`) */
  .choices {
    justify-content: center;
  }
  /* 時間帯・局と同じ並びに、控えた字で「・」でつなぐ (「・」の両側は並びの隙間で、InfoBlock の `.sep` と同じ空き) */
  .local {
    flex-shrink: 0;
    color: var(--dp-on-video-muted);
  }
  .meta {
    margin-top: var(--dp-space-3);
  }
  /* この録画の切り抜きへ。押せる高さは一覧の行の操作と同じ 40px */
  .clips-link {
    display: inline-flex;
    align-items: center;
    gap: var(--dp-space-1);
    min-height: 2.5rem;
    margin-top: var(--dp-space-1);
  }
</style>
