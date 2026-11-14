/**
 * ライブ視聴の受け側。**WebSocket で受けて MSE へ流す。**
 *
 * MSE は取ってこない。`appendBuffer()` に渡すバイト列をどこから持ってくるかは
 * こちら次第で、denpa は WebSocket から受ける ([stream.md](../../docs/stream.md#websocket-プロトコル))。
 * 同じ 1 本で字幕もデータ放送も一緒に送る作りなので、種別で振り分ける。
 *
 * 放送のまま (MPEG-2) と互換モードは、MSE の代わりに `raw/engine.ts` へ流して canvas に描く (下の「変換せずに送る経路」)。
 */

import { resolve } from "$app/paths";
import type { ResponseMessage } from "@danything/arib/bml-protocol";
import {
  CAPTION_TEXT_VERSION,
  type CaptionLanguage,
  type CaptionPage,
} from "@danything/arib/caption-text";
import { CLOCK } from "@danything/arib/pes";
import { untrack } from "svelte";

import {
  ADAPT_NOTE,
  type AdaptDecision,
  adaptNote,
  GRACE,
  HOLD as ADAPT_HOLD,
  PROBE_START,
  RungAdapter,
  type Step,
  stepOrder,
  SWITCH_NOTE,
} from "#lib/adapt.js";
import type { AudioTrack } from "#lib/arib.js";
import { canvasVideo, driveNoticeSeen } from "#lib/canvas-video.js";
import { CaptionPainter } from "#lib/components/player/caption-draw.js";
import {
  CAPTION_LANGUAGE_KEY,
  CAPTION_ON_KEY,
  pickLanguage,
  storedCaptionsOn,
} from "#lib/components/player/caption-pref.js";
import {
  closesData,
  DATA_RECEIVE_KEY,
  storedDataReceive,
  wantsData,
} from "#lib/components/player/data-receive.js";
import { eachFrame } from "#lib/components/player/frames.js";
import {
  DecodeLag,
  SLIP_MOST,
  slipHidden,
  unslipper,
} from "#lib/components/player/unslip.js";
import { writeCookie } from "#lib/cookie.js";
import { broadcastHevcPlayable, browserHevcProbe } from "#lib/hevc-4k.js";
import { forget, read, write } from "#lib/keep.js";
import {
  LagMeter,
  PROBE_GIVE_UP,
  probeBytes,
  probeRate,
  replacesWarning,
  retryAfterMs,
  rungFields,
  servedStep,
  stepFields,
  STUCK_LEAST,
  Throughput,
  videoFrozen,
} from "#lib/live-adapt.js";
import { holdStep, rawChasePosition } from "#lib/live-chase.js";
import {
  autoCodec,
  type BroadcastCodec,
  broadcastFormat,
  formatLabel,
  keptChoice,
  type LiveChoice,
  type LiveFormat,
  shownCodec,
} from "#lib/live-choice.js";
import { liveTuner, pinnedTuner } from "#lib/live-tuner.svelte.js";
import {
  type CaptionTrack,
  CHANNEL,
  CHASE_EDGE,
  codecsFor,
  type Command,
  type HybridcastLink,
  LAST_COOKIE,
  LIVE_CODECS,
  type LiveCodec,
  mseType,
  type Notice,
  SOCKET_PATH,
  TICKET_LIFETIME,
  type Tuned,
  type YieldedRecording,
} from "#lib/live.js";
import { separateLiveAudio } from "#lib/native-audio-choice.js";
import { RawEngine } from "#lib/raw/engine.js";
import type { GrabSize, RawInput } from "#lib/raw/messages.js";
import { NativeAudio } from "#lib/raw/native-audio.js";
import { audioContext } from "#lib/raw/seam.js";
import {
  type CanvasSupport,
  canvasSupport,
  rawUnsupported,
} from "#lib/raw/support.js";
import { LOWEST_RUNG, type Pace } from "#lib/rungs.js";
import {
  type Cue,
  currentCue,
  insertCue,
  showing,
  trimCues,
} from "#lib/ts/captions.js";
import { KeyGate } from "#lib/ts/key-gate.js";
import { pickMediaSource } from "#lib/ts/media-source.js";
import {
  CEILING,
  cover,
  Extreme,
  FLOOR,
  GAP_MOST,
  GAP_WINDOW,
  nextTarget,
  pacing,
  SMOOTH,
  STEADY,
  type Steering,
  steeringWhen,
} from "#lib/ts/pacing.js";
import { retryWait } from "#lib/ts/playback.js";
import { MAX_LEVEL } from "#lib/volume.js";

type LiveState = "idle" | "connecting" | "playing" | "error";

/**
 * 遅れて見られる長さ (秒)。**止めている間も受け取り続けるので、上限が要る。**
 *
 * ブラウザが抱えられる量には上限があり、超えると `appendBuffer` が落ちる。
 * 5 分あれば、電話に出て戻ってくるくらいは追いつける。
 */
const KEEP = 300;
/**
 * 抱えてよい量 (バイト)。時間だけで切ると、ビットレートの高い映像 (H.264 は実測 35.9Mbit/s。5 分で 1.3GB) で
 * ブラウザの上限を超え、`QuotaExceededError` からあと映像が出なくなる。時間とバイト数の小さいほうで切る
 */
const BUDGET = 120 * 1024 * 1024;
/** 戻れる幅の下限 (秒)。ここまで縮めても足りないなら、そもそも抱えられない */
const KEEP_LEAST = 20;
/**
 * 刈るときに再生位置の後ろへ残す幅 (秒)。
 *
 * ちょうどで切ると、出している最中のところを取り上げることになる。数秒あれば
 * 押し戻し (`pacing` の詰め) にも足りる
 */
const BEHIND = 2;
/** 貯める量を決め直す間隔 (ms)。塊は毎秒 20 個来るので、そのたびには回さない */
const SETTLE_EVERY = 5_000;
/**
 * バッファの低いところを見る長さ (秒。`pacing` の `low`)。**次の塊が届く直前のバッファを捉える。**
 *
 * まとめて届く経路では、塊は 0.3〜0.5 秒おきに束で来る。束の先頭の直前がいちばん低く、
 * 束の残りは届くたびに高く見える。何回ぶんかの束を収める長さにする
 */
const LOW_SPAN = 2;
/**
 * 映した 1 枚ごとにバッファを見るときの、`pace` を回す間隔 (ms)。**塊が届かない間も止まる前に手を打つ。**
 *
 * 塊が届いたとき (`updateend`) だけでは、空いている間に何もできない。空きの途中で遅くし始めれば、終わりまで持つことがある
 */
const PACE_EVERY = 250;
/** 画面を離れて止めた試しのデータの印 (`AbortController.abort` の理由)。上限の時間で止めたものとは違い、測った値に使わない */
const LEFT = "left";
/**
 * 前のフレームを貼っておく上限 (ms)。**次が出なくても、いつかは剥がす。**
 *
 * 貼りっぱなしにすると、選局に失敗したときに「前のチャンネルが止まっている」
 * 画面が残る。壊れているのに動いて見えるのがいちばん悪い
 */
const HOLD_MOST = 6_000;
/** 番組が替わって作り直す (`restart`) のが、これより短い間に続いたら待つ (ms) */
const RESTART_CALM = 30_000;
/** 追っかけで作り直したあと、手元がこれ (秒) を切ったらリクエストし直す (`resumeChase`) */
const RESUME_LEFT = 0.3;
/** 手元を見る間隔 (ms。`resumeChase`) */
const RESUME_EVERY = 250;
/** 手元が残ったまま位置がこれ (ms) だけ進まなければ、観終えるのを待たずにリクエストし直す (`resumeChase`) */
const RESUME_STUCK = 3_000;
/**
 * canvas で、描いたコマ数がこれだけ増えなければ映像だけ止まっていると見る (ms。`stuckNow`)。RawEngine は描いたコマ数を
 * 1 秒ごとにしか知らせないので、`<video>` の `STUCK_LEAST` (0.5 秒) より長くとる
 */
const CANVAS_FROZEN = 1_500;
/**
 * 互換モードの追っかけで、抱えきれずに受け取るのをやめたあと、手元がこれを切ったらリクエストし直す (秒)。
 * 読み直し (ffmpeg の立ち上がりとキーフレーム待ち) は 1 秒ほどなので、尽きる前に間に合う
 */
const REFILL = 5;
/**
 * 映像が出せるようになるのを待ってよい上限 (ms)。
 *
 * **貯まっただけでは始めない** (`canStart`)。それでも `readyState` が上がって
 * こないことはある (映像の無い放送・デコードに失敗) ので、待ちきりにはしない
 */
const START_WAIT = 1_500;
/** 再生位置がキーフレームに着いたとみなす幅 (秒。`pace`)。ブラウザが時刻を丸めるぶん */
const KEY_SLACK = 0.001;
/**
 * 段を上げ下げするかを決める間隔 (ms。`adapt`)。`adapt.ts` の数え方 (バッファが 2 秒減り続けた・`pace` が 2 回続けて伸びた)
 * を細かく読めて、塊ごと (毎秒 20 個) には回さない
 */
const ADAPT_EVERY = 500;
/** 0.1 秒刻みに丸める (画面に出す値。細かく書き換えて描き直させない) */
const tenth = (value: number): number => Math.round(value * 10) / 10;

/**
 * データ放送の通知を、受け取る側ができるまでに取っておく数 (`heldData`)。待つのは 700KB を落とす間だけで
 * 数十で足りるが、モジュールは 1 通が 100KB を超えることがあるので、立たなかったときに際限なく抱え込ませない
 */
const HOLD_DATA = 300;

/**
 * 見ている局を覚える。置き場は cookie 1 つで、読むのはサーバ (`LAST_COOKIE` の説明)。
 * 音声も覚える。番組が変わって無くなっても、サーバは主音声に落とす (`arib.pickTrack`)。
 * 形式は**メニューで選んだもの** (`choice`) を覚え、自動で決まった形式は覚えない (開いた場所で変わる)
 */
function remember(target: Tuned, choice: LiveChoice): void {
  const value = encodeURIComponent(
    JSON.stringify({
      channelType: target.channelType,
      channel: target.channel,
      serviceId: target.serviceId,
      ...(target.audio === undefined ? {} : { audio: target.audio }),
      choice,
    }),
  );
  // パスは接頭辞込み (`cookie.writeCookie`)
  writeCookie(LAST_COOKIE, value, resolve("live"));
}

/**
 * 覚えておく「これより下へは貯めない量」の置き場 (`ts/pacing` の `nextTarget`)。端末ごとに覚える。
 * 経路の性質なので、宅内の PC と出先のタブレットで違う。開くたびに `FLOOR` から始めていた頃は、
 * 開いて 30 秒以内に必ず 1 回止まっていた
 */
const FLOOR_KEY = "live-floor";

function storedFloor(): number {
  // localStorage が読めないとき (プライベートウィンドウなど) は下限から始める (`keep.read`)
  const saved = Number(read(FLOOR_KEY));
  if (!Number.isFinite(saved)) return FLOOR;
  return Math.min(CEILING, Math.max(FLOOR, saved));
}

function rememberFloor(seconds: number): void {
  write(FLOOR_KEY, String(seconds));
}

/** 忘れる。まっさらな端末と同じ状態に戻す (`relearn`) */
function clearFloor(): void {
  forget(FLOOR_KEY);
}

/**
 * 小窓 (PiP) で何かを出しているか。標準の API と、それが無い古い Safari の `webkitPresentationMode` の両方を見る (`pip.svelte.ts` と同じ)。
 * 映像を描く canvas の代わりの video を小窓にすることがあるので、この video に限らない
 */
function inPictureInPicture(): boolean {
  if (document.pictureInPictureElement) return true;
  return [...document.querySelectorAll("video")].some(
    (video) =>
      (video as HTMLVideoElement & { webkitPresentationMode?: string })
        .webkitPresentationMode === "picture-in-picture",
  );
}

/**
 * 速さの寄せ方 (`ts/pacing.ts` の `Steering`)。**Safari (Apple の WebKit) だけ、速さを触る回数を減らす** (`STEADY`)。
 * iPad と iPhone はどのブラウザも中身が WebKit なので、ここに入る。見分け方は音を別に鳴らすかと同じ (`native-audio-choice.ts`)。
 * ほかのブラウザも、画面が隠れている間は `STEADY` にする (`steeringWhen`)
 */
function chooseSteering(): Steering {
  return separateLiveAudio() ? STEADY : SMOOTH;
}

interface LivePlayerOptions {
  /**
   * 運転中の注意を見せて、「了解」を待つ (互換モード。`canvas-video.ts`)。
   * **まだ見せていない端末で、canvas で描く前に 1 回だけ呼ぶ。** 押されるまで再生を始めない
   */
  confirm?: () => Promise<void>;
  /**
   * `<video>` で観るとき、音を別に鳴らすか (`raw/native-audio.ts`。WebKit だけ。`native-audio-choice.ts`)。
   * ライブ画面だけが渡す。追っかけは渡さない (`<video>` の音のまま)
   */
  separateAudio?: () => boolean;
  /**
   * コーデックのメニューで選んでいるもの (`#lib/live-choice.ts`)。ライブは覚えている選択 (`LAST_COOKIE`。読むのはサーバ)、
   * 追っかけは覚えないので省く (自動)
   */
  choice?: LiveChoice;
  /** 開いた名前が家の中か (サーバが決める。`server/viewing.ts`)。「自動」の形式を決めるのに使う */
  indoor?: boolean;
  /**
   * ライブで H.265 を出せるか (ライブのエンコーダが GPU のときだけ。サーバが決める。`server/viewing.ts`)。
   * 追っかけは渡しても使わない (段 0 の追っかけは H.265 を出さない。段を下げた変換はサーバが `playable` から選ぶ)
   */
  hevc?: boolean;
  /**
   * その場でエンコードできるコーデック (AV1 → H.265 → H.264 の順。サーバが決める。`server/viewing.ts` の `liveCodecs`)。
   * コーデックのメニューには、この先頭から端末で再生できるものを 1 つだけ並べる (`menuCodec`)。省くと H.264 だけ
   */
  liveCodecs?: readonly LiveCodec[];
  /**
   * 最初に繋ぐときのチケット (`server/tickets.ts`)。ライブのページを組むときにサーバが配る。**1 回だけ使う** (`takePageTicket`)。
   * 追っかけは渡さない (`/api/live/ticket` で取る)
   */
  ticket?: string | null;
}

export function livePlayer(options: LivePlayerOptions = {}) {
  let state = $state<LiveState>("idle");
  let message = $state("");
  let tuned = $state<Tuned | null>(null);
  /** 音を消しているか (押して消した・自動再生を断られた) */
  let silenced = $state(false);
  /**
   * 手元に貯めている長さ (秒)。**受け取った最後のフレームと、いま映しているフレームの差**
   * (`buffered.end - currentTime`。放送との差は `fromAir`)。ここが遅延の大半で、
   * エンコード方式より効く。出しているのは、詰まりが増えていないかを見ながら詰めていくため
   */
  let delay = $state<number | null>(null);
  /** 止めているか。**押して止めた間も受け取り続ける** */
  let paused = $state(false);
  /**
   * 止めている間に抱えきれなくなって、受け取ったぶんを捨てたか。そのまま再生しても数秒で
   * 行き止まりになるので、押されたら取り直す (`toggle`)
   */
  let starved = false;
  /** 放送の今に張り付いているか。離れていれば「ライブへ」を出す */
  let live = $state(true);
  /**
   * 追っかけ再生か (わざと遅れて見ている)。止めたときと、シークバーを後ろへ戻したときに立つ。
   * 立っている間は放送の今を追いかけず、選ばれた速さで進む。追いついたら自分で下りる
   */
  let chasing = $state(false);
  /** 追っかけ中の速さ。ライブに戻れば 1 に戻す */
  let speed = $state(1);
  /** 縮めるときの行き先の下限 (秒。`nextTarget`)。選局しても開き直しても持ち越す (経路の性質。`FLOOR_KEY`) */
  const initialFloor = storedFloor();
  let floor = $state(initialFloor);
  /** どれだけ貯めているか (秒)。詰まると伸び、無事が続くと縮む。始まりは下限と同じで、あとは別々に動く */
  let target = $state(initialFloor);
  /** どこまで戻れて、いまどこにいるか (シークバー。0.1 秒刻み) */
  let oldest = $state(0);
  let newest = $state(0);
  let position = $state(0);
  /** 選べる音声。1 つしか無ければ画面は切り替えを出さない */
  let audios = $state<AudioTrack[]>([]);
  /** いま鳴らしている音声 (`AudioTrack.id`) */
  let audio = $state("");
  /** いまエンコードしてもらっているコーデック。**サーバが返してきたものを持つ** */
  let codec = $state<LiveCodec>("h264");
  /**
   * コーデックのメニューで選んだもの。**リクエストする形式の元**で、実際の形式は選ぶたびに決める (`pickFormat`)。
   * 自動なら端末と開いた場所に合わせ (`autoCodec`)、選んだものは家の中でも外でもそのまま使う。
   * 覚えていたエンコードするものがメニューに並んでいなければ、自動として扱う (`inUse`。値は書き換えない)
   */
  let choice = $state<LiveChoice>(options.choice ?? "auto");
  /** AV1 を受け取れなかった (`start`)。**この画面を開いている間は**自動で AV1 を選ばない。選び直せば試し直す */
  let av1GaveUp = false;
  /**
   * H.265 を受け取れなかった (`start`)、またはサーバが GPU でエンコードできずに降りた (`error`)。AV1 と同じく、
   * **この画面を開いている間は**自動で H.265 を選ばない。選び直せば試し直す
   */
  let hevcGaveUp = false;
  /**
   * 断り書き。失敗ではないが、リクエストされたとおりにできなかったとき (AV1 を出せないので次の形式に切り替えた・
   * サーバの `notice`)。`message` と違って選局では消さない。戻した先が映り始めても理由を読めるように。
   * かわりに出してから決まった長さで引っ込める (`note`)。引っ込めたあとも、切り替えた先はメニューの行 (「自動 (H.264)」) に残る
   */
  let warning = $state("");

  /*
   * ---- 回線に合わせて段を上げ下げする ([stream.md](../../docs/stream.md#ライブと追っかけの画面)) ----
   *
   * 決めるのは `adapt.ts` の `RungAdapter` で、ここは測った値を渡し、決まった段でリクエストし直すだけ (`adapt`)。
   * 段を動かすのは**メニューで「自動」を選んでいるときだけ**。段 0 は自動で決まった形式 (家の中なら MPEG-2) で、
   * 段 1〜3 はサーバが選んだコーデックの変換、`audio` は音声だけ。互換モード (canvas に描くエンコードしたもの) でも同じに動かし、
   * サーバには canvas に描けるコーデックだけを渡す (`playable`。H.265 は描かない)。デコードが間に合うかは `raw/budget.ts` が見て、
   * 回線とは混ぜない
   */
  /** いま再生中の段 (`tuned` の答え)。メニューの「自動 (H.264 540p)」に出す */
  let served = $state<Step>(0);
  /** リクエストする段。局を変えても、追っかけのシークでも持ち越す */
  let asked: Step = 0;
  const adapter = new RungAdapter();
  /** 受け取りの速さ (`AdaptSample.throughput`)。リクエストし直すたびに測り直す */
  const throughput = new Throughput();
  /** 放送に対する遅れの伸び (`AdaptSample.lag`)。リクエストし直すたびに測り直す */
  const lagMeter = new LagMeter();
  /** 測った回線の速さ (`AdaptSample.capacity`。`probeLink`)。まだ測っていなければ null */
  let capacity: { bps: number; at: number } | null = null;
  /**
   * 別に鳴らす音の AudioContext。**作り直しても使い回す** (`NativeAudio` の `shared`)。iOS の Safari は、押したとき以外に作った
   * AudioContext を止めたまま始めるので、画質を切り替えるたびに作り直すと、自動再生を断られたとみて消音にしていた (#2728)。
   * 閉じるのは画面を離れるとき (`stop`)
   */
  let audioContextForLive: AudioContext | null = null;

  /**
   * 最初のコマを映した (`at` は `performance.now()`)。`startup` の内訳を 1 行出す。video の経路は映した 1 枚、canvas の経路は
   * 新しい局の 1 枚目を描いたとき (`RawEvents.shown`)。
   *
   * **`tuned` が届く前に来たものは前の局のコマなので数えない。** 繋がっている接続で局を替えると、`tuned` が届くまで
   * 前の局を映し続けている (canvas の経路では前の局のまま動いていて、10〜38ms で出ていた)
   */
  function reportStartup(at: number): void {
    if (startup?.tuned === undefined) return;
    const ms = (value?: number) =>
      value === undefined ? "-" : `${Math.round(value)}ms`;
    const ticket =
      startup.ticket === "page" ? "ページから" : ms(startup.ticket);
    console.info(
      `[live] 開くまで チケット ${ticket} / 繋がる ${ms(startup.open)} / tuned ${ms(startup.tuned)} / 最初のバイト ${ms(startup.bytes)} / 最初のコマ ${ms(at - startup.at)}`,
    );
    startup = null;
  }
  /** いまの MediaSource に流しているエンコード方式。`<video>` がエラーになったら、これをやめる (`onMediaError`) */
  let mseCodec: LiveCodec | null = null;
  /** 最後にコマが映った時刻 (`performance.now`。`stuckNow`)。測れない・選局し直したあとまだ映っていなければ 0 */
  let lastFrameAt = 0;
  /**
   * 開いてから最初のコマまでの内訳 (ms。`begin` を呼んだ時点から)。最初のコマを映したときに 1 行だけコンソールに出す。
   * 選局の遅さが端末・サーバ・エージェントのどこにあるかを、エージェントの記録 (`TunerPool` の「同期・送り出し」) と突き合わせて割るため
   */
  let startup: {
    at: number;
    /** チケットを受け取った。ページを組むときに受け取ったもの (`takePageTicket`) を使ったときは `page` */
    ticket?: number | "page";
    open?: number;
    tuned?: number;
    /** `tuned` のあとで、元の TS の最初の塊が届いた (前の局の残りを数えない) */
    bytes?: number;
  } | null = null;
  /** 断り書きを引っ込める時計 (`note`) */
  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  /** 次の選局で繋ぎ直すか (足りなくて下げるとき。`tune`) */
  let freshSocket = false;
  /** 取っている最中の試しのデータを止める (`probeLink`)。取っていなければ null */
  let probing: AbortController | null = null;
  /** この時刻 (ms) までは試しのデータを取らない (サーバに回数の制限で断られたとき。`probeLink`) */
  let probeAfter = 0;
  /** 上げた段をリクエストした時刻と、上げる前の段。映り始めるまで (`adapt` の `PROBE_START`) */
  let upAsk: { from: Step; at: number } | null = null;
  /** `<video>` が先を持たなくなった時刻 (`stuckNow`) */
  let starvedSince: number | null = null;
  /** 最後に届いた `pace` (`AdaptSample.pace`)。届くたびに新しいオブジェクトにする */
  let lastPace: Pace | null = null;
  /** リクエストしてから `tuned` が来るまで。この間は段を決めない (前の段のストリームを新しい段として測ってしまう) */
  let awaiting = false;
  /** 詰まっているか。`<video>` は `waiting` から `playing` まで、canvas は詰まった次の刻みまで (`adapt`) */
  let stuck = false;
  /** 段を下げた変換で GPU が降りたコーデック (AV1・H.265 はソフトウェアに降りない)。段を下げるときの `playable` から外す */
  const rungOff = new Set<LiveCodec>();
  /** `encode`・`pinned` の断り書きと、最後に出した時刻。その状態が `ADAPT_HOLD` のあいだ来なければ消す */
  let standing: { text: string; at: number } | null = null;
  /** 段を決める刻み (`ADAPT_EVERY`)。最初の選局で入れ、画面を離れたら止める */
  let adaptTimer: ReturnType<typeof setInterval> | null = null;

  /** 前のフレームを貼っているか。**次のフレームが出るまでの黒を埋める** */
  let holding = $state(false);
  /**
   * データ放送を出すか (テレビの d ボタン)。サーバは押されてからデコードする (`server/live.ts` の `wantData`)。
   * 別の局へ移ったら閉じる (`closesData`)
   */
  let showData = $state(false);
  /** 最後に選局した局 (`Tuned.serviceId`)。追っかけの間も覚えておき、同じ局へ戻ったら開いたまま */
  let lastService: number | null = null;
  /**
   * データ放送を自動で受信するか (データ放送のボタンの長押し)。**端末ごとに覚える** (`data-receive.ts`)。
   * いまの局の入口に自動起動の指定があれば (`autoStart`)、開いていなくてもサーバにリクエストし、入口の文書を裏で動かす
   * (`DataBroadcast` の `receive`)
   */
  let receiveData = $state(false);
  /**
   * いまの局の入口に自動起動の指定があるか (サーバが PMT を読んで知らせる `Notice` の `autoStart`)。
   * 別の局へ移ったら、次の局の通知が来るまで false
   */
  let autoStart = $state(false);
  $effect(() => {
    receiveData = storedDataReceive(read(DATA_RECEIVE_KEY));
    // 選局の指示より先に送らない (`syncData`)。読んだ値に合わせるだけ
    untrack(syncData);
  });
  /** サーバに受信をリクエストしているか (最後に送ったもの)。繋ぎ直したらリクエストしていないところから */
  let askedData = false;
  /** データ放送の通知を渡す先。**描いているものがあるときだけ** */
  let onData: ((message: ResponseMessage) => void) | null = null;
  /**
   * 受け取る側ができるまでの控え。サーバは押された瞬間に番組・PMT・モジュールをまとめて送るが、描く側は
   * 700KB を落としてから立ち上がる。番組 (`programInfo`) は一度きりなので、捨てると押しても何も出なかった
   */
  let heldData: ResponseMessage[] = [];
  /** 字幕を出すか。**押して切り替えられる** (テレビの字幕ボタン)。端末ごとに覚える (`caption-pref.ts`) */
  let captions = $state(true);
  // 開いた端末で決まる。サーバで組むときは無いので、開いてから読む
  $effect(() => {
    captions = storedCaptionsOn(read(CAPTION_ON_KEY));
  });
  /**
   * いまの字幕のストリームに載っている言語 (`captions` の通知)。字幕管理データが届くまでは空。
   * たいていは日本語 1 つで、英語の字幕が付く番組がたまにある
   */
  let captionLanguages = $state<CaptionLanguage[]>([]);
  /** 出している言語 (`CaptionLanguage.index`)。サーバは視聴者ごとに出し分ける */
  let captionLanguage = $state(1);
  /**
   * 選べる字幕。1 枚も届いていなくても分かる (サーバが入口で読んでいる)。届いてから出していた頃は、
   * 間隔の空く番組でボタンが出なかった
   */
  let captionTracks = $state<CaptionTrack[]>([]);
  /** いま出している字幕 (`CaptionTrack.index`) */
  let captionTrack = $state(0);
  /**
   * この番組に載っている Hybridcast。ボタンは別のタブで開き、データ放送が起動を求めたら
   * denpa の中で開く (`DataBroadcast`。受信機の API は用意できる範囲だけ) ([docs/stream.md](../../docs/stream.md#hybridcast))
   */
  let hybridcast = $state<HybridcastLink[]>([]);
  /**
   * 追っかけ再生 ([issue #16](https://github.com/danything/denpa/issues/16))。
   * 観ている録画と、**いまの ffmpeg が 0 と数える位置** (base 秒)。
   * シークで再エンコードするたびに base が変わる。画面に見せる位置は base + position。
   * `broadcast` は録画の放送のコーデック (4K の局の録画 `.mmts` は `hevc`。`openChase`)
   */
  let chase = $state<{
    recordingId: number;
    base: number;
    broadcast: BroadcastCodec;
  } | null>(null);
  /** 追っかけの物差し (`timeline` の通知)。録画中は右端を壁時計で伸ばして読む */
  let chaseTimeline = $state<{
    recordedSec: number;
    totalSec: number;
    finished: boolean;
    since: number;
  } | null>(null);
  /** 追っかけが録れているところまで読み切ったか */
  let chaseEnded = $state(false);
  /** 追っかけを録れているところまで鳴らしきったか (canvas で描くとき。`RawEvents.ended`)。押しても再開しない (`toggle`) */
  let drained = false;
  /**
   * 追っかけを元の TS で受けるときの物差しの 0 (録画の先頭の PTS。`timeline` の `origin`)。届いていなければ null で、
   * そのときは鳴らし始めた PTS を `base` の位置とみなす (`rawHead`。`rawChaseAt`)
   */
  let origin: number | null = null;
  /** `origin` が無いとき、リクエストし直してから最初に鳴った位置 (秒。PTS のまま) */
  let rawHead: number | null = null;
  /** サーバに送るのを止めさせているか (`{ type: 'hold' }`。追っかけを元の TS で受けているときだけ。`holdFeed`) */
  let feedHeld = false;
  /** 読み切ったら、流し残しが尽きたところで MediaSource を閉じる (`finishStream`) */
  let ending = false;

  /*
   * ---- 録画に譲ったとき ([docs/stream.md](../../docs/stream.md#録画に譲る)) ----
   *
   * ライブは録画にだけ譲る。チューナーを取り上げられたらサーバが `lost` を言ってくるので、**まず同じ局をリクエストし直す**
   * (使ってよいチューナーが空いていればそこに入り、見ているものは変わらない)。リクエストし直しても入れなかった
   * ときだけ、チューナーを取り上げた録画の追っかけに切り替える。「ライブに戻る」(`backToLive`) はリクエストし直しを試し、
   * 入れなければ追っかけに戻る
   */
  /** チューナーを取り上げた録画。**リクエストし直しが入れなかったら、これの追っかけに切り替える** (入れたら忘れる) */
  let fallback: YieldedRecording | null = null;
  /**
   * 録画に譲って追っかけを観ている。`back` は戻る先のライブ、`refused` は「ライブに戻る」を
   * 試して入れなかったか (画面は「録画が終わるまでライブは観られません」を出す)
   */
  let yielded = $state<{
    recording: YieldedRecording;
    back: Tuned;
    refused: boolean;
  } | null>(null);
  /** 「ライブに戻る」を試している最中 */
  let returning = $state(false);

  /*
   * ---- 変換せずに送る経路 ([stream.md](../../docs/stream.md#放送そのままmpeg-2を送る)) ----
   *
   * **MSE の代わりに `raw/engine.ts` を使う。** それ以外 (接続・通知・字幕・データ放送・
   * 貯め方の決め方) はエンコードする経路と同じものを通す。違うのは描く先と時計だけ。
   *
   * | | エンコードする経路 | 変換しない経路 |
   * | --- | --- | --- |
   * | 描く先 | `<video>` + MSE | canvas (worker の WebGL2) |
   * | 時計 | `video.currentTime` (0 起点) | 鳴っている音の PTS (放送の時刻そのまま) |
   * | バッファ | `buffered.end - currentTime` | 届いた音の端 − 鳴っている位置 |
   * | 止めて再開 | 止めた所から (5 分戻れる) | **放送の今から** (遡るほど持っていない) |
   */
  /** いま MPEG-2 で見ているか。**サーバが `tuned` でそう答えたときだけ** */
  let raw = $state(false);
  /**
   * canvas で描いているか (放送のままの MPEG-2 か、互換モードのエンコードしたものか)。**操作バーの出し分けに使う**。
   * どちらも遡れない (止めて再開は放送の今から)
   */
  let canvas = $state(false);
  let engine: RawEngine | null = null;
  /** いまの RawEngine が何を受け取っているか (`raw/messages.ts` の `RawInput`)。RawEngine が無ければ null */
  let engineInput: RawInput | null = null;
  /** いまの RawEngine が追っかけ用か (`RawEngine` の `chase`。放送の今を追わない)。作るときに決まる */
  let engineChase = false;
  /*
   * ---- 互換モード (`canvas-video.ts`) ----
   *
   * **エンコードしたもの (H.264 / AV1) も canvas に描く。** `<video>` の再生が止まる端末 (テスラの
   * 車載ブラウザ) のため。サーバへのリクエストのしかたは変えず、届いた fMP4 を MSE ではなく RawEngine
   * (`RawEngine` の `fmp4`) へ流す。**ここでは `<video>` に戻らない**。描けなくなったら
   * MPEG-2 へ、それも無理なら理由を出して止まる
   */
  /** 互換モードか。**選局のたびに読み直す** (再生の設定 ⚙ でオン/オフされる) */
  let compat = $state(false);
  /** この端末で描ける形式 (`raw/support.ts` の `canvasSupport`)。調べるまで null */
  let compatSupport = $state<CanvasSupport | null>(null);
  /** 互換モードで描くのをやめたか。**選び直すまでリクエストし直さない** (MPEG-2 の `rawGaveUp` と同じ) */
  let compatGaveUp = false;
  /** MPEG-2 を選んでいるか。**リクエストするかどうかの元**。実際に MPEG-2 になったかは `raw` */
  let rawChosen = false;
  /**
   * MPEG-2 をやめたか (デコードするのが間に合わない・音がデコードできない・デコーダが無い)。**この画面を開いている
   * 間はリクエストし直さない**。MPEG-2 に戻すたびに同じ理由でまたやめることになり、そのたびに映像が止まる
   */
  let rawGaveUp = false;
  /** この端末でデコードできない理由 (`raw/support.ts`)。調べるまでは undefined */
  let rawProblem: string | null | undefined;
  /** 映像の入れ物。RawEngine の canvas はここに差し込む (`attach`) */
  let host: HTMLElement | null = null;
  /**
   * canvas で描くときの音 (RawEngine が鳴らす) を「再生する音」として鳴らすか (`RawEngine.background`。Safari は Audio Session、
   * ほかは `<audio>` を通す)。**バックグラウンド再生をオンにしているか、押して小窓を開いている間**
   * (画面が決める。`background.svelte.ts`)
   */
  let playback = false;
  /** 音量 (%。`#lib/volume.ts`)。canvas で描くときに RawEngine へ渡す。`<video>` のぶんは画面が持つ (`volume.svelte.ts`) */
  let volume = MAX_LEVEL;
  /** 音を別に鳴らしているとき (`separateAudio`)。`<video>` は消音にしてある */
  let nativeAudio: NativeAudio | null = null;
  /** canvas で描く経路の刻み。バッファ・貯める量の決め直しを回す (`rawPace`) */
  let rawTimer: ReturnType<typeof setInterval> | null = null;
  /** canvas で描くとき、1 コマデコードするのに掛かっている時間 (ms、95 パーセンタイル)。**画面に出す** */
  let decodeMs = $state(0);
  /** MPEG-2 のコマを間引いているか (間に合わないので B フレームを飛ばしている。`raw/worker.ts` の `thin`) */
  let thinned = $state(false);

  let socket: WebSocket | null = null;
  let source: MediaSource | null = null;
  let buffer: SourceBuffer | null = null;
  /** いま鳴らしている `<video>`。押して音を出すのに要る */
  let element: HTMLVideoElement | null = null;
  /** 前のフレームの写し先。画面から預かる */
  let still: HTMLCanvasElement | null = null;
  /** 字幕を描く `CaptionPainter`。重ねる先の canvas は画面から預かる (`attach`) */
  let painter: CaptionPainter | null = null;
  /** 貼りっぱなしを避けるためのタイマー */
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 待たせている字幕。時刻の順 ([ts/captions.ts](./ts/captions.ts))。時刻は映像と同じ ffmpeg が付けた物差しで、
   * 字幕のほうが先に届くので、再生位置が追いつくまで持っておく
   */
  let cues: Cue[] = [];
  /** いま描いている 1 枚。同じものを描き直さない */
  let shown: CaptionPage | null = null;
  /** もう再生を始めたか。始めるまでは貯める */
  let running = false;
  /**
   * 描かれずに捨てられたコマの数 (画面に出す)。音・字幕・再生位置は同じ時計に乗っているので、映像だけ遅れるなら
   * 遅れているのはデコード。遅延の数字には出ないので、この数で切り分ける
   */
  let dropped = $state(0);
  /** `droppedVideoFrames` を最後に読んだ値 (`countDropped`)。Safari は飛ぶたびに 0 に戻すので差を足し上げる */
  let droppedSeen = 0;
  /** 途中から入ったストリームの、最初のキーフレームまでを渡さない処理 (`ts/key-gate.ts`)。**始める位置もここで決まる** */
  const keyGate = new KeyGate();
  /** 映した 1 枚が再生位置からどれだけ遅れているか (秒)。音と字幕は再生位置に乗るので、口の動きだけずれる (`unslip`) */
  let slip = $state(0);
  /** 飛び直した回数。**画面に出す**。直し続けているなら、まだ足りていない */
  let slips = $state(0);
  /** 速さの寄せ方 (`chooseSteering`) */
  const steering = chooseSteering();
  /**
   * 選局してから再生の速さを変えた回数。**画面に出す**。Safari は変えるたびにつまずく
   * (`ts/pacing.ts` の `Steering`) ので、補正やコマ落ちの数と並べて見る (#1210)
   */
  let rateChanges = $state(0);
  /** いまの再生の速さ。**画面に出す** (等速でないときだけ) */
  let rate = $state(1);
  /**
   * サーバが受け取った時刻と、エンコードしたものの物差しの対応 (`clock` の通知)。
   * **届くまでは null**。画面は届いてから出す
   */
  let broadcast = $state<{ at: number; unixMs: number } | null>(null);
  /** サーバの時計 − 端末の時計 (ms)。**端末の時計を当てにしないため** */
  let skew = 0;
  /** 放送との本当の差 (秒。0.1 秒刻み)。`at` は物差しの上の再生位置。`clock` が届くまでは null */
  function airLag(at: number): number | null {
    if (broadcast === null) return null;
    return (
      Math.round(
        (Date.now() + skew - (broadcast.unixMs + (at - broadcast.at) * 1000)) /
          100,
      ) / 10
    );
  }
  /**
   * 放送からどれだけ遅れて観ているか (秒)。隣に置いたテレビとの差で、上流 (選局・エンコード・回線) も入る。
   * 「遅延」(`delay`) は手元にあと何秒ぶん持っているかで、別物 (docs/stream.md)
   */
  let fromAir = $state<number | null>(null);
  /**
   * 映像の遅れの、これまでの最大 (秒。MediaSource を作り直すと 0)。いまの値はたいてい `unslip` が直したあとなので、
   * 飛び直す前にどこまで開いたかを残す。0 のままずれるなら、ずれているのは中身 (エンコードした時点) のほう
   */
  let slipMost = $state(0);
  /** 映像だけ遅れたときの飛び直し (`unslip.ts`) */
  const unslipping = unslipper();
  /** デコードが追いついていないか (`unslip.ts` の `DecodeLag`)。「自動」の段を下げる合図と、再生を速めないかを決める */
  const decodeLag = new DecodeLag();
  /*
   * 映像の遅れは JS から見えないことがある (Windows のブラウザは映像を DOM と別の面に出す)。
   * そういう端末 (`slipHidden`) では、起きる条件の途切れ (`stalled`) で飛び直す (`settle`)。コマ落ちを合図にしない理由は `unslip.ts` の `UNSLIP_EVERY` の下
   */
  const hidesSlip = slipHidden();
  /** バッファが足りた最初の時刻。**映像を待ちきりにしないため** (`canStart`) */
  let enoughAt = 0;
  /** 繋ぎ直しのタイマー。**待っている間だけ入っている** */
  let retry: ReturnType<typeof setTimeout> | null = null;
  /** 続けて何回繋ぎ直しに失敗したか。0 でなければ繋ぎ直しの最中で、繋げなくても失敗にしない */
  let attempts = $state(0);
  /** 最後に作り直しを受けた時刻 (`restart`。`RESTART_CALM`) */
  let restartedAt = 0;
  /** 追っかけで作り直したあと、届いたぶんを観終えるのを待っている (`resumeChase`) */
  let resuming: ReturnType<typeof setInterval> | null = null;
  /** 画面を離れた。**もう繋ぎ直さない** */
  let left = false;
  /** 最後に詰まった時刻。無事が続いたかを見る */
  let lastStall = 0;
  /** 前回 `nextTarget` を回してから詰まったか */
  let stalled = false;
  /**
   * 選局してから何回詰まったか (画面に出す)。経路が荒れているかどうかは遅延の値よりこの数のほうが早く出る
   * ([stream.md](../../docs/stream.md#一瞬止まって遅延が増えていく))
   */
  let stalls = $state(0);
  /** 最後に `nextTarget` を回した時刻 */
  let lastSettled = 0;
  /** 下限を最後に動かした時刻。**下げ直すのはゆっくり** (`pacing` の `FORGET`) */
  let lastFloor = 0;
  /**
   * 映像の塊が届く間隔のうち、ここ数分でいちばん長いもの (`pacing` の `cover`)。
   * **止まる前から、空く間隔を覆えるだけ貯める** (#1210)。時刻は秒 (`performance.now`)
   */
  const gaps = new Extreme(GAP_WINDOW, true);
  /** 最後に塊が届いた時刻 (秒)。0 なら次の 1 つは間隔に数えない (選局した直後・止めている間) */
  let lastArrival = 0;
  /** ここしばらくのバッファの低いところ (`pacing` の `low`)。時刻は秒 */
  const lows = new Extreme(LOW_SPAN, false);
  /** ここ数秒の届く間隔のいちばん長いもの (`pacing` の `dip`)。時刻は秒 */
  const dips = new Extreme(LOW_SPAN, true);
  /** 映した 1 枚ごとに `pace` を回した最後の時刻 (ms。`PACE_EVERY`) */
  let pacedAt = 0;
  /** 画面に出す、いちばん長く空いた間隔 (秒)。**不具合の報告に要る** (`gapMost`) */
  let gapMost = $state(0);
  /**
   * この時刻まで、詰まっても数えない (選局・飛んだ直後は必ず `waiting` が上がる)。自分で起こした詰まりで
   * 貯める量を伸ばすと、伸ばした先が下限として残って遅延が戻らない (`pacing.ts` の `PROBE`)
   */
  let quiet = 0;
  /** 追加待ちの列。`appendBuffer` は 1 つずつしか受け付けない (前のが終わる前に呼ぶと止まる) */
  const pending: Uint8Array[] = [];
  /** 受け取った映像の量と、数えはじめた時刻。**戻れる幅を決めるのに使う** */
  let received = 0;
  let receivedFrom = 0;

  /**
   * 前のフレームを写して、次が出るまで貼っておく (切り替えの間の黒を埋める)。切り替えの待ちの大半は
   * こちらでは動かせない ([stream.md](../../docs/stream.md#開いてから映像が出るまでの内訳)) ので、
   * 黒い画面を見せずに済ませる
   */
  function freeze(): void {
    if (canvas) {
      // canvas で描く経路では canvas が次のフレームまで前のフレームを持っている。写さずに「貼っている」ことにする
      // (でないと幕が前のフレームを塗り潰す)。剥がすのは新しい局の 1 枚目 (`shown`)
      if (engine === null) return;
      /*
       * **貼る canvas は空にしておく。** 中身はエンコードしていたころに写したフレームのまま残っていて、
       * MPEG-2 の canvas より上にある。空にしないと、選局のたびにその古いフレーム (前にエンコードして
       * 見ていた局の) が一瞬かぶさって見える
       */
      if (still !== null) still.width = 0;
    } else {
      if (element === null || still === null) return;
      // まだ 1 枚も出ていない (初めて開いたとき)。写すものが無い
      if (element.readyState < 2 || element.videoWidth === 0) return;
      const ctx = still.getContext("2d");
      if (ctx === null) return;
      still.width = element.videoWidth;
      still.height = element.videoHeight;
      ctx.drawImage(element, 0, 0, still.width, still.height);
    }
    holding = true;
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = setTimeout(thaw, HOLD_MOST);
  }

  /** 剥がす。**次のフレームが実際に出てから** (`onFrame`) */
  function thaw(): void {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (holding) holding = false;
  }

  /**
   * 次のフレームが画面に出たら呼ぶ。
   *
   * `play()` が返っただけでは**まだ何も映っていない**ので、そこで剥がすと
   * 一瞬黒くなる。`requestVideoFrameCallback` は「1 枚映した」ところで来る。
   * 持っていないブラウザでは `timeupdate` で代える (1 枚ぶん遅いが実害は無い)
   */
  function onFrame(video: HTMLVideoElement, done: () => void): void {
    const request = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?(cb: () => void): number;
      }
    ).requestVideoFrameCallback;
    if (typeof request === "function") request.call(video, done);
    else video.addEventListener("timeupdate", done, { once: true });
  }

  /** 字幕を貼り直し続けている映像。**1 つにつき 1 本** */
  let following: HTMLVideoElement | null = null;

  /**
   * 字幕を映した 1 枚ごとに貼り直す ([frames.ts](components/player/frames.ts))。塊が届いたとき (`pace`) だけだと
   * 遅れる方向にずれていた (実機で平均 15ms・最大 53ms)。止めて見ている間は来ないので、片付けは `pace` に置く
   */
  function follow(video: HTMLVideoElement): void {
    if (following === video) return;
    following = video;
    // 飛んだ直後の 1 コマは測らない (`unslipper`)。選局し直しの追いつき (`pacing` の `seek`) も含む
    video.addEventListener("seeking", () => unslipping.seeked());
    eachFrame(video, (frame) => {
      // 別の映像に移ったら、こちらは畳む
      if (following !== video) return false;
      // 映した 1 枚の時刻と再生位置の差 (`slip`)。`requestVideoFrameCallback` を持つブラウザでだけ測れる
      if (frame !== undefined) {
        lastFrameAt = performance.now();
        reportStartup(lastFrameAt);
        // 飛んだ直後の 1 コマは飛ぶ前の時刻を持っていることがあるので測らない (`unslipper`)
        const measured = unslipping.measure(video, frame.mediaTime);
        if (measured !== null) {
          slip = measured;
          if (slip > slipMost) slipMost = slip;
          if (slip > SLIP_MOST) decodeLag.late(Date.now());
          unslip(video, slip);
        }
      }
      paint(video.currentTime);
      // 塊が届かない間もバッファを見て、ときどき `pace` を回す (`PACE_EVERY`)
      sampleLow(video);
      const now = performance.now();
      if (now - pacedAt >= PACE_EVERY) {
        pacedAt = now;
        pace(video);
      }
      return true;
    });
  }

  /**
   * いまのバッファを、低いところの候補として覚える (`lows`)。**届く直前と、映した 1 枚ごとに呼ぶ。**
   * ライブで再生しているときだけ (追っかけはバッファを狙いに寄せない)
   */
  function sampleLow(video: HTMLVideoElement): void {
    if (buffer === null || buffer.updating || buffer.buffered.length === 0)
      return;
    if (!running || paused || chase !== null || chasing) return;
    lows.push(
      performance.now() / 1000,
      buffer.buffered.end(buffer.buffered.length - 1) - video.currentTime,
    );
  }

  /**
   * 映像の塊が届いた。**前の塊との間隔を覚える** (`gaps`)。
   *
   * 数えるのは、ライブを再生していて、止めておらず、画面が見えているときだけ。
   * 隠れているタブは届き方も描き方も絞られるので、混ぜると間隔が長く見える
   */
  function arrive(): void {
    const now = performance.now() / 1000;
    const counting =
      running &&
      !paused &&
      chase === null &&
      (typeof document === "undefined" || !document.hidden);
    if (counting && lastArrival > 0) {
      const gap = now - lastArrival;
      // 長すぎる空きは途絶え (`GAP_MOST`)。覆いにいかない
      if (gap <= GAP_MOST) {
        gaps.push(now, gap);
        dips.push(now, gap);
      }
    }
    lastArrival = counting ? now : 0;
  }

  /** 届く間隔とバッファの低いところを忘れる。**選局したとき・飛んだとき** (前の局・前の位置の値は当てにならない) */
  function forgetFlow(): void {
    lows.clear();
    dips.clear();
    lastArrival = 0;
  }

  /**
   * いま覆うべき空き (秒)。覚えている間隔と、**いま空いている最中の間隔**の長いほう。
   * 詰まりはたいてい空きの途中で起きるので、届くのを待たずに数える
   */
  function gapNow(): number {
    const now = performance.now() / 1000;
    const ongoing = lastArrival > 0 ? Math.min(GAP_MOST, now - lastArrival) : 0;
    return Math.max(gaps.peek(now) ?? 0, ongoing);
  }

  /**
   * バッファの低いところに足す量 (`pacing` の `dip`)。ここ数秒の届く間隔と、**いま空いている最中の間隔**の長いほう。
   * 覆えている空きの途中で「足りない」と見て遅くしない (遅くするのは本当に足りないときだけ)。
   * 空いている最中の間隔は、覚えている間隔 (`gaps`) までしか足さない。それより長く空いたら、遅くして持たせにいく
   */
  function dipNow(): number {
    const now = performance.now() / 1000;
    const ongoing =
      lastArrival > 0 ? Math.min(gaps.peek(now) ?? 0, now - lastArrival) : 0;
    return Math.max(dips.peek(now) ?? 0, ongoing);
  }

  /** 詰まった (`<video>` の `waiting`・RawEngine の `stalled`)。**自分で飛んだぶんと、止めているときは数えない** (`quiet`) */
  function onWaiting(): void {
    if (paused || Date.now() < quiet) return;
    stalled = true;
    stalls += 1;
    lastStall = Date.now();
    stuck = true;
  }

  /** `<video>` がまた動き出した。詰まりの終わり (`stuck`) */
  function onPlaying(): void {
    stuck = false;
  }

  /**
   * 再生位置を動かした (飛んだ・シーク・ライブへ)。これで上がる `waiting` を数えず (`quiet`)、
   * 飛んで減ったバッファを回線が足りないせいに数えない (`RungAdapter.reset`)
   */
  function jumped(): void {
    const now = Date.now();
    quiet = now + GRACE;
    adapter.reset(now);
  }

  /**
   * **段を上げ下げするかを決める** (`ADAPT_EVERY` ごと)。測った値を `RungAdapter` に渡し、返ってきたら動かす (`act`)。
   * 決めないのは、止めている間・リクエストしてから `tuned` が来るまで・まだ再生していない間。
   * ただし上げた段が映り始めるまでの待ちは数える (`PROBE_START`)
   */
  function adapt(): void {
    if (left || paused) {
      // 止めている間の先の無さを、再開したときの詰まりに数えない (`stuckNow`)
      starvedSince = null;
      return;
    }
    const now = Date.now();
    const starting = awaiting || !running || state !== "playing";
    /*
     * **上げた段がいつまでも映り始めなければ戻す** (`PROBE_START`)。足りない段では最初のキーフレームが届かず、
     * `tuned` も溜まった前の段の映像の後ろに並ぶ。刻みは映っている間しか回らないので、ここで数える
     */
    if (inUse() !== "auto") upAsk = null;
    if (upAsk !== null && starting) {
      if (now - upAsk.at >= PROBE_START) {
        const from = upAsk.from;
        upAsk = null;
        adapter.abandon(now);
        act({ step: from, reason: "slow" }, now);
      }
      return;
    }
    if (starting) return;
    upAsk = null;
    /*
     * 互換モードで H.264 を描けない (打ち切って MPEG-2 に移った・VideoDecoder が H.264 を持たない)。段を下げた先は、
     * GPU でエンコードできるものが無ければソフトウェアの H.264 になる (`server/live.ts` の `rungCodec`) ので描けない
     */
    if (compat && !playable().includes("h264")) return;
    const ahead = aheadNow();
    if (ahead === null) return;
    // 放送に対する遅れ (`LagMeter`)。追っかけは録画を実時間より速く読むので測らない
    const edge = edgeNow();
    if (edge !== null && chase === null) lagMeter.push(now, edge);
    const rate = throughput.rate(now);
    const decision = adapter.tick({
      now,
      route: "live",
      current: served,
      manual: inUse() !== "auto",
      throughput: rate,
      ahead,
      waiting: stuckNow(now),
      pace: lastPace,
      // ライブは段 0 のビットレートを渡さない。段 0 へ上げるときは、段 0 で足りていたときに測った速さと比べる (`RungAdapter.liveBps`)
      baseKbps: null,
      lag: chase === null ? lagMeter.growth(now) : null,
      capacity,
      // canvas に描く経路は自分で変換した映像へ戻る (`raw/budget.ts`)。`<video>` だけ渡す
      behind: !canvas && decodeLag.behind(now),
    });
    // canvas の詰まりには終わりの合図が無い。1 回の刻みで数える
    if (canvas) stuck = false;
    act(decision, now);
    const want = adapter.wantProbe();
    if (want !== null) void probeLink(want, rate ?? 0);
  }

  /**
   * 詰まっているか (`AdaptSample.waiting`)。canvas は詰まった次の刻み (`stuck`) と、描いたコマが `CANVAS_FROZEN` 増えないとき。`<video>` は `waiting` から `playing` までに
   * 加えて、先を持たない状態が `STUCK_LEAST` 続いたとき。`waiting` は自分で飛んだあと 3 秒数えない (`quiet`) ので、
   * 止まっては飛ぶのを繰り返すと、それだけでは詰まりが見えない
   */
  function stuckNow(now: number): boolean {
    if (canvas) {
      /*
       * canvas (MPEG-2・互換モード) は、描いたコマ数 (RawEngine の `frameAt`。1 秒ごとに届く) が `CANVAS_FROZEN` 増えなければ、
       * 音は鳴っているのに映像だけ止まっていると見る。`<video>` の `requestVideoFrameCallback` の代わり
       */
      const at = engine?.frameAt ?? 0;
      const frozen = videoFrozen({
        now,
        frameAt: at,
        least: CANVAS_FROZEN,
        playing: engine?.playing === true,
        audioOnly: served === "audio",
        hidden: document.hidden,
      });
      return stuck || frozen;
    }
    if (element === null) return stuck;
    /*
     * **映像だけが止まって音が続く**のも詰まりに数える。キーフレームの大きな塊が細い回線で遅れて届くと、音の時計は進むのに
     * 映るコマが来ない (`readyState` は落ちず `waiting` も来ない)。映ったコマ (`requestVideoFrameCallback`) が
     * `STUCK_LEAST` 来なければそう見る。測れないブラウザ (`lastFrameAt` が 0)・音声だけ・画面が裏のときは見ない
     */
    const frozen = videoFrozen({
      now: performance.now(),
      frameAt: lastFrameAt,
      least: STUCK_LEAST,
      playing: true,
      audioOnly: served === "audio",
      hidden: document.hidden,
    });
    const starving =
      (element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA || frozen) &&
      !element.seeking;
    if (!starving) starvedSince = null;
    else starvedSince ??= now;
    return (
      stuck || (starvedSince !== null && now - starvedSince >= STUCK_LEAST)
    );
  }

  /** 届いた映像の端 (メディアの時刻、秒。`LagMeter`)。canvas は届いた音の端。まだ無ければ null */
  function edgeNow(): number | null {
    if (canvas) return engine?.edge ?? null;
    if (buffer === null || buffer.buffered.length === 0) return null;
    return buffer.buffered.end(buffer.buffered.length - 1);
  }

  /**
   * **上げる前に回線の速さを測る** (`RungAdapter.wantProbe`)。ライブのストリームは実時間でしか届かないので、受け取りの速さを見ても
   * 余裕は分からない。試しのデータ (`GET /api/playback/probe`) を、要る速さの残りで `PROBE_SPAN` かかる量だけ取り、
   * 再生中の段の受け取りの速さと足して `capacity` にする。`PROBE_GIVE_UP` でやめる (細い回線で取り続けると映像が細る)
   */
  async function probeLink(need: number, stream: number): Promise<void> {
    if (probing !== null || Date.now() < probeAfter) return;
    const control = new AbortController();
    probing = control;
    const bytes = probeBytes(need, stream);
    const giveUp = setTimeout(() => control.abort(), PROBE_GIVE_UP);
    const startAt = performance.now();
    let firstAt: number | null = null;
    let firstBytes = 0;
    let got = 0;
    let lastAt = startAt;
    try {
      const res = await fetch(resolve(`api/playback/probe?bytes=${bytes}`), {
        cache: "no-store",
        signal: control.signal,
      });
      if (res.status === 429) {
        // 間を置かずに取ろうとした (同じ利用者のほかの画面が測った直後など)。言われた時間までは測らず、測ったことにもしない
        probeAfter = Date.now() + retryAfterMs(res.headers.get("Retry-After"));
        return;
      }
      /*
       * 5xx などで試しのデータが取れなかったときは、余裕が無かったと測ったことにする (`capacity` は再生中の段のぶんだけ)。
       * 測っていないことにすると、`wantProbe` が次の刻みでまた測らせ、困っているサーバから刻み (`ADAPT_EVERY`) ごとに取得する。
       * 余裕が無いことにすれば上げずに待ち直し、待ちが明けてから測り直す。サーバが困っている間に段を上げることもない
       */
      const reader = res.ok ? res.body?.getReader() : undefined;
      while (reader !== undefined) {
        const { done, value } = await reader.read();
        if (done) break;
        lastAt = performance.now();
        got += value.byteLength;
        if (firstAt === null) {
          firstAt = lastAt;
          firstBytes = value.byteLength;
        }
      }
    } catch {
      // やめた (`PROBE_GIVE_UP`)・繋がらなかった。そこまでに届いた量で測る
      lastAt = performance.now();
    } finally {
      clearTimeout(giveUp);
      if (probing === control) probing = null;
    }
    if (left || control.signal.reason === LEFT) return;
    const rate = probeRate({
      startAt,
      firstAt,
      firstBytes,
      lastAt,
      bytes: got,
    });
    capacity = { bps: stream + (rate ?? 0), at: Date.now() };
  }

  /**
   * いま先に溜まっている長さ (秒)。canvas は届いた音の端までの長さ、`<video>` は届く直前の低いところ (`lows`。ライブで再生して
   * いるときだけ溜まる) といまの値の低いほう。まだ何も無ければ null
   */
  function aheadNow(): number | null {
    if (canvas) return engine?.lead ?? null;
    if (element === null || buffer === null || buffer.buffered.length === 0)
      return null;
    const edge =
      buffer.buffered.end(buffer.buffered.length - 1) - element.currentTime;
    return Math.min(edge, lows.peek(performance.now() / 1000) ?? edge);
  }

  /**
   * 決まったことをする。段を動かすなら断り書きを出してリクエストし直す (前のコマを貼ったまま。`requestAgain`)。
   * `encode`・`pinned` は断り書きだけで、ほかの理由の断り書きは上書きしない (サーバが軽くしたときの文は `encode` で替える。`replacesWarning`)
   */
  function act(decision: AdaptDecision | null, now: number): void {
    if (decision === null) {
      if (standing !== null && now - standing.at >= ADAPT_HOLD) {
        if (warning === standing.text) warning = "";
        standing = null;
      }
      return;
    }
    const text = adaptNote(decision, served);
    if (decision.reason === "encode" || decision.reason === "pinned") {
      if (replacesWarning(decision.reason, warning, standing?.text ?? null))
        warning = text;
      standing = { text, at: now };
      return;
    }
    const { step } = decision;
    /*
     * 追っかけには音声だけが無い。段 3 のまま流す。互換モードも同じ (映像の無い fMP4 を canvas に流す経路を
     * 確かめていない)
     */
    if (step === "audio" && (chase !== null || compat)) return;
    standing = null;
    // 上げたなら、映り始めるまでを数える (`adapt` の `PROBE_START`)
    upAsk = decision.reason === "restored" ? { from: served, at: now } : null;
    // 足りなくて下げるなら、溜まった前の段の映像の後ろに並ばないように繋ぎ直す (`tune`)
    freshSocket = decision.reason === "slow" && chase === null;
    asked = step;
    // 段を動かした断り書きは、観る画面と同じく少しで引っ込める (`ADAPT_NOTE`)
    note(text, ADAPT_NOTE);
    requestAgain();
  }

  /**
   * 断り書きを出し、`hold` (ms) で引っ込める。**ほかの断り書きで替わっていれば消さない。** 形式を切り替えた・サーバの `notice` は
   * `SWITCH_NOTE` (10 秒)。段の文より長いので `ADAPT_NOTE` より長く出す。切り替えた先はメニューの行 (「自動 (H.264)」) に残る。
   * 出しっぱなしにしていた頃は、メニューで選び直すまで映像の上に残り、局を替えても押しても消えなかった
   * (`StageNote` は押せない)。
   * 引っ込めないのは `encode`・`pinned` の文だけで、その状態が来なくなったら消す (`act`)
   */
  function note(text: string, hold = SWITCH_NOTE): void {
    warning = text;
    if (noteTimer !== null) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      noteTimer = null;
      if (warning === text) warning = "";
    }, hold);
  }

  /**
   * 段を下げるとき、端末が再生できるコーデック (`TuneCommand.playable`)。受け取れないもの・打ち切ったものは外す。
   * 互換モードは canvas に描けるもの (`canvasCan`。H.265 は描かない)
   */
  function playable(): LiveCodec[] {
    return LIVE_CODECS.map((c) => c.id).filter(
      (id) =>
        !rungOff.has(id) &&
        !(id === "av1" && av1GaveUp) &&
        !(id === "hevc" && hevcGaveUp) &&
        (compat ? !compatGaveUp && canvasCan(id) : mseCan(id)),
    );
  }

  /**
   * 映像だけ遅れているのを、その場へ飛び直して直す (`unslip.ts`)。測った遅れ (`measured`) があれば
   * `SLIP_MOST` を超えたときだけ、無ければ遅れを見ずに飛ぶ (途切れたとき。`settle`)
   */
  function unslip(video: HTMLVideoElement, measured?: number): void {
    const jumped =
      measured === undefined
        ? unslipping.jump(video)
        : unslipping.fix(video, measured);
    if (!jumped) return;
    // 測った遅れで飛んだときだけ数える。測れない端末が詰まって飛ぶぶんはデコードの重さではない
    if (measured !== undefined) decodeLag.jumped(Date.now());
    slips++;
    slip = 0;
    // これで上がる `waiting` は数えない (`quiet`)
    quiet = Date.now() + GRACE;
  }

  /** 再生位置に合う 1 枚だけ字幕を描く ([ts/captions.ts](./ts/captions.ts) の `currentCue` / `showing`) */
  function paint(at: number): boolean {
    if (painter === null) return false;
    const next = captions ? showing(currentCue(cues, at), at) : null;
    if (next === shown) return false;
    shown = next;
    painter.show(next);
    return true;
  }

  /** `at` より前に出し終えたぶんを片付ける。**`at` で出す 1 枚は残す** (出しっぱなしのため) */
  function sweep(at: number): void {
    const kept = trimCues(cues, at);
    if (kept.length !== cues.length) cues = kept;
  }

  function drain(): void {
    // 抱えきれなくなったら (`pace` が立てる `starved`)、届いたその場で捨てる
    if (starved) {
      pending.length = 0;
      return;
    }
    if (buffer === null || buffer.updating || pending.length === 0) {
      // 追っかけを読み切っていて、流し残しも無ければ、ここで MediaSource を閉じる
      finishStream();
      return;
    }
    const next = pending.shift();
    if (next === undefined) return;
    try {
      buffer.appendBuffer(next as BufferSource);
    } catch {
      // 追いつけなくなった。次の init から入り直す
      pending.length = 0;
    }
  }

  /**
   * 追っかけを読み切ったら MediaSource を閉じる (`MediaSource.endOfStream`)。
   * 締めないと、バッファの端で「読み込み中」のまま止まって見える。
   * 流し残し (`pending`) があるうちは待つ。締めると残りが入らなくなる
   */
  function finishStream(): void {
    if (!ending || source === null || source.readyState !== "open") return;
    if (buffer === null || buffer.updating || pending.length > 0) return;
    try {
      source.endOfStream();
    } catch {
      // 追加中だった。次の updateend の drain で締め直す
    }
  }

  /**
   * 再生位置を合わせる。**届いた端でそのまま出すと、絶えず止まる。**
   *
   * 少し貯めてから始め、離れたら速めて詰める ([pacing.ts](./ts/pacing.ts))。
   * 別のタブへ行って戻ってきたときだけ飛ぶ。飛ぶと音が切れるので、
   * 常用するとそれ自体が「かくつき」になる。
   */
  function pace(video: HTMLVideoElement): void {
    if (engine === null) countDropped(video);
    if (buffer === null || buffer.updating || buffer.buffered.length === 0)
      return;
    const end = buffer.buffered.end(buffer.buffered.length - 1);
    const behind = end - video.currentTime;
    // 0.1 秒刻みにする (塊は毎秒 20 個届く。そのたびに書き換えると画面を無駄に描き直す)
    const rounded = running ? tenth(behind) : null;
    if (rounded !== delay) delay = rounded;
    // 放送の今に張り付いているか。少しの揺れでは離れたことにしない
    const atLive = behind <= target + 1.5;
    if (atLive !== live) live = atLive;

    const truly = airLag(video.currentTime);
    if (truly !== fromAir) fromAir = truly;

    if (tenth(buffer.buffered.start(0)) !== oldest)
      oldest = tenth(buffer.buffered.start(0));
    if (tenth(end) !== newest) newest = tenth(end);
    if (tenth(video.currentTime) !== position)
      position = tenth(video.currentTime);

    /*
     * 片付けは毎回する (止めて見ている間は出す番が来ず、際限なく溜まった)。貼り直しも、
     * 止めて見ている間は映した 1 枚が来ない (`follow`) のでここでする
     */
    paint(video.currentTime);
    // 字幕は戻れるいちばん前から残す。シークバーで溜めの中を戻ったときに、その間の字幕を出すため
    sweep(Math.min(video.currentTime, buffer.buffered.start(0)));

    trim(end);
    settle();

    // 押して止めている間は動かさない (飛ばすと「止めた所から見る」ができなくなる)
    if (paused) {
      /*
       * 追っかけは、抱えきれる幅を超えたらそこから先を受け取らない。刈ると止めた所を捨てることになるので、
       * 印を立てて受け取る側 (`drain`) で捨て、再開のときに止めた所から読み直す (`toggle`)。
       * ライブは放送が待ってくれないので、古いほうから刈る (`trim`)
       */
      if (chase !== null && end - video.currentTime > keepFor()) starved = true;
      return;
    }

    /*
     * **追っかけは放送の今を追いかけない。** 右端は「録れているところ」で、
     * バッファは倍速の送り込み (`server/chase.ts`) でどんどん伸びる。飛びも
     * 詰めもせず、少し貯まったら選んだ速さで進むだけ。読み切った後は
     * バッファを待たない (もう来ない)
     */
    if (chase !== null) {
      if (
        !running &&
        (end - video.currentTime >= 0.8 || chaseEnded) &&
        canStart(video)
      )
        startPlaying(video);
      if (running && video.playbackRate !== speed) video.playbackRate = speed;
      return;
    }

    /*
     * **始める位置は最初のキーフレーム** (`keyGate`)。渡すのはキーフレームを含む塊からなので、
     * 持っている先頭はその塊の先頭。キーフレームより 1〜2 コマ手前のことがある。そこから始めると、
     * Safari はその手前のコマをデコードしては捨てる (コマ落ちに数える)。
     *
     * **飛んだあとは比べない。** Chromium は入れた時刻をマイクロ秒に丸めて返すので、キーフレームの
     * 時刻とぴったりは揃わない。比べ続けると「まだ手前にいる」と見て飛び続け、始まらない
     */
    const first = buffer.buffered.start(0);
    const key = keyGate.at;
    const toKey =
      !running &&
      key !== null &&
      key > first &&
      key < end &&
      video.currentTime < key - KEY_SLACK;
    const start = toKey ? key : first;
    // 隠れている間は速さを触る回数を減らす (`steeringWhen`)。小窓 (PiP) で観ている間はタブが隠れていても見えているので、ふだんどおり
    const hidden =
      typeof document !== "undefined" &&
      document.visibilityState === "hidden" &&
      !inPictureInPicture();

    const next = pacing({
      start,
      end,
      at: video.currentTime,
      playing: running,
      target,
      chasing,
      speed,
      // **届いた直後の高いところで決めない** (`pacing` の `low`)
      low: lows.peek(performance.now() / 1000) ?? undefined,
      dip: dipNow(),
      rate: video.playbackRate,
      steering: steeringWhen(hidden, steering),
    });

    /*
     * **追いついたらライブに戻す。** 押してもらう必要は無い。追いついた
     * ところで選んだ速さのまま進むと放送を追い越し、バッファを使い切って止まる
     */
    if (next.caught) {
      chasing = false;
      speed = 1;
    }
    if (next.seek !== null) {
      video.currentTime = next.seek;
      lows.clear();
      jumped();
    }
    /*
     * **映像が遅れているあいだは速めない** (`DecodeLag.slipping`)。遅れを詰めようと速く回すと、デコードがさらに重くなる
     * (エミュレータで AV1 1080p を 1.05 倍で回し続けていた)。遅くするのはそのまま
     */
    if (next.rate !== null)
      steerTo(
        video,
        decodeLag.slipping(Date.now()) ? Math.min(next.rate, 1) : next.rate,
      );
    // 読み直すと 1 に戻るので、入れた値ではなく今の値を出す
    rate = video.playbackRate;
    if (next.play && !running && canStart(video)) startPlaying(video);
  }

  /** 再生を始める。前のフレームは 1 枚映ってから剥がす (ここで剥がすと一瞬黒くなる) */
  function startPlaying(video: HTMLVideoElement): void {
    running = true;
    state = "playing";
    void play(video);
    onFrame(video, thaw);
  }

  /**
   * ライブの速さを変える。**同じ値は入れ直さない**。`pacing` は寄せ終わっても 1 を返し続ける。
   * 変えたら数える (`rateChanges`。追っかけで選んだ速さは数えない)
   */
  function steerTo(video: HTMLVideoElement, next: number): void {
    if (video.playbackRate === next) return;
    video.playbackRate = next;
    if (!chasing) rateChanges++;
  }

  /**
   * 始めてよいか。貯まっただけでは始めない。いまの位置のフレームを出せる (`HAVE_CURRENT_DATA`) まで待たないと、
   * 前の局の静止画のまま新しい局の音が鳴る。映像の無い放送で音まで止めないよう、待ちきりにはしない (`START_WAIT`)。
   * 1 枚目が少し止まって見えるのは直さない ([stream.md](../../docs/stream.md#新しい局の1枚目が少し止まるのは直さない))
   */
  function canStart(video: HTMLVideoElement): boolean {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return true;
    const now = Date.now();
    if (enoughAt === 0) enoughAt = now;
    return now - enoughAt >= START_WAIT;
  }

  /** どれだけ戻れるか (秒)。受け取っている速さから `BUDGET` に収まる長さを出す。測れるまでは `KEEP` */
  function keepFor(): number {
    const seconds = (Date.now() - receivedFrom) / 1000;
    if (receivedFrom === 0 || seconds < 2 || received === 0) return KEEP;
    const perSecond = received / seconds;
    return Math.max(KEEP_LEAST, Math.min(KEEP, BUDGET / perSecond));
  }

  /**
   * 多すぎるバッファを古いほうから削る (止めている間も受け取り続けるので、放っておくと `QuotaExceededError` に着く)。
   * 追っかけはいま出している所より後ろを刈らない (受け取るほうを止める。`pace` の `starved`)。ライブは刈って、
   * 再生位置が刈った所に残っていれば残っている先頭へ移す (置き去りにすると動かなくなる)
   */
  function trim(end: number): void {
    if (buffer === null || buffer.updating || buffer.buffered.length === 0)
      return;
    const at = element === null ? 0 : element.currentTime;
    const want = end - keepFor();
    const cut = chase === null ? want : Math.min(want, at - BEHIND);
    if (buffer.buffered.start(0) >= cut) return;
    try {
      buffer.remove(0, cut);
      if (element !== null && at < cut) element.currentTime = cut + BEHIND;
    } catch {
      // 追加中だった。次の機会に
    }
  }

  /**
   * 捨てられたコマを足し上げる (`droppedSeen`)。**塊が届くたびに読む** (`pace`)。飛ぶ直前までの
   * ぶんを、Safari が 0 に戻す前に数える
   */
  function countDropped(video: HTMLVideoElement): void {
    const quality = video.getVideoPlaybackQuality?.();
    if (quality === undefined) return;
    const now = quality.droppedVideoFrames;
    decodeLag.frames(Date.now(), quality.totalVideoFrames, now);
    const more = now >= droppedSeen ? now - droppedSeen : now;
    droppedSeen = now;
    if (more > 0) dropped += more;
  }

  /** 貯める量を決め直す。**止まったら伸ばし、無事が続いたら縮める** */
  function settle(): void {
    const now = Date.now();
    if (!stalled && now - lastSettled < SETTLE_EVERY) return;
    // 捨てられたコマも同じ間隔で読む (canvas で描くとき。`<video>` のぶんは `pace` が足し上げる)。**選局からの通し**
    if (engine !== null) dropped = engine.dropped;
    /*
     * **遅れが見えない端末は、途切れたら飛び直す** (`unslipping` の下の説明)。測れた遅れ (`slip`) を待たない。
     * 見える端末では飛ばない (遅れていなくても音が 0.02 秒飛ぶ。`slipHidden`)。canvas で描く経路には要らない (映像は音の時計を追うだけ)
     */
    if (stalled && hidesSlip && element !== null && !canvas) unslip(element);
    const gap = gapNow();
    const most = Math.round(gap * 100) / 100;
    if (most !== gapMost) gapMost = most;
    const next = nextTarget(
      { target, floor },
      stalled,
      (now - lastStall) / 1000,
      (now - lastFloor) / 1000,
      gap,
    );
    stalled = false;
    lastSettled = now;
    if (next.floor !== floor) {
      floor = next.floor;
      lastFloor = now;
      // 次に開いたときはここから始める。探し直しは経路が変わったときだけ
      rememberFloor(floor);
    }
    if (next.target !== target) target = next.target;
    if (engine !== null) engine.target = target;
  }

  /**
   * 鳴らす。断られたら音をやめて映像だけ出す (前回の局で勝手に始めるので、開いた直後は自動再生として断られる)
   */
  async function play(video: HTMLVideoElement): Promise<void> {
    nativeAudio?.setMuted(silenced);
    video.muted = nativeAudio !== null || silenced;
    try {
      await video.play();
      if (nativeAudio?.blocked) mute();
    } catch {
      video.muted = true;
      silenced = true;
      try {
        await video.play();
      } catch {
        // それでも駄目。画面の再生ボタンを押してもらう
      }
    }
  }

  /** 音を出す。**押されて呼ばれる**。ここまで来ればブラウザは断らない */
  function unmute(): void {
    silenced = false;
    engine?.unmute();
    if (element === null || canvas) return;
    nativeAudio?.setMuted(false);
    element.muted = nativeAudio !== null;
    void element.play().catch(() => {
      /* 押したのに断られることはない */
    });
  }

  /** 音を止める。備え付けの操作を出さないので、こちらで用意する */
  function mute(): void {
    silenced = true;
    engine?.mute();
    nativeAudio?.setMuted(true);
    if (element !== null) element.muted = true;
  }

  /**
   * 止める・再開する。止めても受け取りは続き、止めた時点で追っかけに入る (再開しても放送の今へ飛ばない。
   * 戻りたいときは `goLive`)
   */
  function toggle(): void {
    if (element === null) return;
    /*
     * canvas で描く経路は、再開は放送の今から (遡れるほど持っておけない)。
     * 互換モードの追っかけは止めた所から (`RawEngine` の `chase`)
     */
    if (canvas && engine !== null) {
      // 追っかけを録れているところまで鳴らしきったあとは、もう鳴らすものが無い。戻す (シーク) とリクエストし直す
      if (paused && drained && chase !== null) return;
      paused = !paused;
      if (paused) engine.pause();
      else {
        quiet = Date.now() + GRACE;
        engine.resume();
      }
      return;
    }
    if (paused) {
      paused = false;
      // 抱えきれずに受け取りを止めていた (`starved`。追っかけだけ)。止めた所から読み直す
      if (starved && chase !== null) {
        starved = false;
        void openChase(
          element,
          chase.recordingId,
          chase.base + element.currentTime,
          true,
        );
        return;
      }
      starved = false;
      void element.play().catch(() => {
        /* 押されて呼ばれるので断られない */
      });
    } else {
      paused = true;
      chasing = true;
      element.pause();
    }
  }

  /**
   * 覚えた下限を捨てて測り直す (経路が変わったときの出口)。高すぎる側に外れると 10 分ごとに 0.3 秒ずつしか
   * 下がらない (`nextTarget` の `FORGET`)。貯めているぶんもその場で下限まで詰めて放送の今へ戻す
   */
  function relearn(): void {
    clearFloor();
    floor = FLOOR;
    lastFloor = Date.now();
    target = FLOOR;
    // 覚えている届く間隔も、前の経路のもの
    gaps.clear();
    gapMost = 0;
    forgetFlow();
    goLive();
  }

  /** 放送の今へ追いつく。**追っかけをやめて、見ていたぶんを飛ばす** */
  function goLive(): void {
    // canvas で描く経路はいつも放送の今。止めていたら再開するだけ
    if (canvas) {
      if (paused) toggle();
      return;
    }
    if (element === null || buffer === null || buffer.buffered.length === 0)
      return;
    const end = buffer.buffered.end(buffer.buffered.length - 1);
    element.currentTime = Math.max(buffer.buffered.start(0), end - target);
    chasing = false;
    speed = 1;
    element.playbackRate = 1;
    jumped();
    if (paused) toggle();
  }

  /**
   * 字幕の言語を選ぶ。**再エンコードしない**。サーバは載っている言語を全部デコードしていて、
   * 出す言語を視聴者ごとに替えるだけ (`server/live.ts` の `setLanguage`)。待たせている字幕は前の言語なので捨てる
   *
   * @param remember 端末に覚えるか。押して選んだときだけ (番組に合わせて選び直したときは覚えない)
   */
  function setCaptionLanguage(index: number, remember = true): void {
    if (remember) {
      const code = captionLanguages.find((l) => l.index === index)?.code ?? "";
      if (code !== "") write(CAPTION_LANGUAGE_KEY, code);
    }
    if (index === captionLanguage) return;
    captionLanguage = index;
    clearCaptions();
    send({ type: "language", language: index });
  }

  /** 指示を送る。**送れたか**を返す (繋がっていない・繋ぎ直している間は送らずに false) */
  function send(command: Command): boolean {
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(command));
    return true;
  }

  /** 字幕を出す・消す。端末ごとに覚える (`caption-pref.ts`) */
  function setCaptions(on: boolean): void {
    captions = on;
    write(CAPTION_ON_KEY, on ? "1" : "0");
    if (element !== null) paint(element.currentTime);
  }

  /**
   * 字幕のストリームを選び直す。音声と同じで再エンコードになる。字幕は映像と同じ ffmpeg でエンコードしている
   * (時刻を揃えるため。`server/captions.ts`)。MediaSource から作り直すので、待たせているぶんも映像も捨てる
   */
  function setCaptionTrack(index: number): void {
    if (index === captionTrack) return;
    if (chase !== null && element !== null) {
      captionTrack = index;
      reopenChase();
      return;
    }
    if (tuned === null) return;
    // 一覧は同じ局のものなので残す (`forget`)
    forget(true);
    captionTrack = index;
    const command = wantedCommand();
    if (command !== null) send(command);
  }

  /**
   * 追っかけの速さを選ぶ。**遅れて見ているとき (と追っかけ再生) だけ効く。**
   *
   * ライブに張り付いているときに速められては困る (放送より先は無い)。
   * 追いついたら 1 に戻す (`pace`)
   */
  function setSpeed(next: number): void {
    // canvas で描く経路は等速だけ (音を自前で鳴らしている。速めると音程が変わる)
    if (canvas) return;
    // 追っかけ再生 (`chase`) では常に選べる。放送の今より先が無いのはライブだけ
    if (!chasing && chase === null) return;
    speed = next;
    if (element !== null) element.playbackRate = next;
  }

  /**
   * 持っている範囲の中で移る。シークバーを押されたとき。
   *
   * **後ろへ戻したら追っかけに入る。** 入れないと `pacing` が「大きく離れた」と
   * 見て放送の今へ戻すので、戻した先が 1 秒も映らない
   */
  function seek(to: number): void {
    if (element === null || buffer === null || buffer.buffered.length === 0)
      return;
    const start = buffer.buffered.start(0);
    const end = buffer.buffered.end(buffer.buffered.length - 1);
    const at = Math.min(end, Math.max(start, to));
    element.currentTime = at;
    // 端の近くへ戻しただけならライブのまま。少しの操作で追っかけにしない
    if (end - at > target + 1.5) chasing = true;
    jumped();
  }

  /**
   * 追っかけのシーク。**二段構え。**
   *
   * 手元に残っている範囲なら `video.currentTime` を動かすだけ (一瞬)。
   * 外なら `chase` を送り直してサーバに ffmpeg ごと立て直させる。元の TS に
   * 時間の索引は無いので、飛び先はバイト比例で当たりを付ける (`server/chase.ts`)
   */
  function chaseSeek(to: number): void {
    if (chase === null || element === null) return;
    // 互換モードは手元に戻れるほど持っていない (圧縮のまま持つのは先だけ)。いつもリクエストし直す
    if (canvas) {
      void openChase(element, chase.recordingId, to, true);
      return;
    }
    const local = to - chase.base;
    if (buffer !== null && buffer.buffered.length > 0) {
      const start = buffer.buffered.start(0);
      const end = buffer.buffered.end(buffer.buffered.length - 1);
      if (local >= start && local <= end) {
        element.currentTime = Math.min(end, Math.max(start, local));
        jumped();
        return;
      }
    }
    void openChase(element, chase.recordingId, to, true);
  }

  /**
   * 再生の状態だけ初期に戻す。**繋ぎ直さない。**
   *
   * 音声を選び直したときはサーバが再エンコードするので、MediaSource は作り直すが繋ぎ直す
   * 必要は無い (`setAudio`)。MediaSource を作り直す `start` からも通る
   */
  function clear(): void {
    nativeAudio?.destroy();
    nativeAudio = null;
    buffer = null;
    source = null;
    mseCodec = null;
    running = false;
    delay = null;
    paused = false;
    // 取り直すのだから、捨てたことは持ち越さない
    starved = false;
    live = true;
    // 局や音声を選び直したら、追っかけていた場所はもう無い
    chasing = false;
    speed = 1;
    oldest = 0;
    newest = 0;
    position = 0;
    slip = 0;
    slipMost = 0;
    decodeLag.reset();
    rateChanges = 0;
    enoughAt = 0;
    // 作り直すと元の数も 0 から数え直す。いまの値を起点にして、前の局のぶんを持ち越さない
    dropped = 0;
    droppedSeen = element?.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0;
    // 局が変われば物差しごと変わる。次の `clock` を待つ
    broadcast = null;
    fromAir = null;
    pending.length = 0;
    // 作り直した MediaSource は開いている。読み切りの印は次の `ended` が立て直す
    ending = false;
    stuck = false;
  }

  /**
   * 繋ぎも含めて畳む。**画面を離れるときと、繋ぎ直すとき**
   *
   * @param keepList 選んでいる字幕を残すか (`forget`)。同じ局へ繋ぎ直すときだけ true
   */
  function reset(keepList = false): void {
    socket?.close();
    socket = null;
    forget(keepList);
  }

  /**
   * 受け取ったものを忘れる。**接続はそのまま。**
   *
   * **待たせている字幕は必ず捨てる。** 再エンコードになれば mp4 の時刻は 0 から
   * 数え直しになるので、前の時刻で待たせているものは**どれも合わなくなる**
   * (音声やエンコード方式を選び直しただけでも再エンコードになる。`server/live.ts`)。
   *
   * @param keepList 選べる字幕の一覧は残すか。**同じ局の中での選び直しだけ
   *   true**。局が変われば持っている字幕も変わる (字幕そのものが無い局もある)
   */
  function forget(keepList: boolean): void {
    clearCaptions();
    if (!keepList) {
      captionTracks = [];
      captionTrack = 0;
      captionLanguages = [];
      // **局ごとのもの。** 局を変えたら、前の局のアプリを出したままにしない
      hybridcast = [];
    }
    clear();
  }

  /** 待たせている字幕を捨てる。**再エンコードのたび** (`forget` の説明) */
  function clearCaptions(): void {
    cues = [];
    shown = null;
    painter?.show(null);
  }

  /**
   * **追っかけで番組が替わって作り直した** (`restart`)。届いたぶんを観終えてから、観ていた位置をリクエストし直す。
   *
   * ライブと違って、届いたぶんは観ている位置より先にある (倍速で送り込まれている。`server/chase.ts`)。すぐ
   * リクエストし直すとそこを飛ばしてしまう。サーバは変わったところの近くをリクエストされたら、変わったところから
   * 読む (`server/chase.ts` の `resumePlan`)。続けて来たら (`RESTART_CALM`) いつもの繋ぎ直しに乗せる
   *
   * @param wait いつもの繋ぎ直しの待ちに乗せるか
   */
  function resumeChase(wait: boolean): void {
    if (resuming !== null) clearInterval(resuming);
    /** 位置が最後に進んだ時刻。**手元が残ったまま進まなくなっても待ち続けない** (`RESUME_STUCK`) */
    let movedAt = Date.now();
    let last = -1;
    resuming = setInterval(() => {
      if (left || chase === null || element === null) {
        stopResuming();
        return;
      }
      const onCanvas = canvas && engine !== null;
      const now = onCanvas ? position : element.currentTime;
      if (paused || now !== last) movedAt = Date.now();
      last = now;
      if (paused) return;
      const ahead = onCanvas
        ? (engine?.lead ?? 0)
        : buffer === null || buffer.buffered.length === 0
          ? 0
          : buffer.buffered.end(buffer.buffered.length - 1) -
            element.currentTime;
      if (ahead > RESUME_LEFT && Date.now() - movedAt < RESUME_STUCK) return;
      stopResuming();
      // <video> の位置は届いたときにしか写していない (`pace`)。もう届かないので、ここで写す
      if (!onCanvas) position = tenth(element.currentTime);
      if (wait) reconnect();
      else reopenChase();
    }, RESUME_EVERY);
  }

  function stopResuming(): void {
    if (resuming !== null) clearInterval(resuming);
    resuming = null;
  }

  /** 画面を離れる。**貼ったフレームも剥がす**。戻ってきたときに残っていては困る */
  function stop(): void {
    left = true;
    if (retry !== null) clearTimeout(retry);
    retry = null;
    if (adaptTimer !== null) clearInterval(adaptTimer);
    adaptTimer = null;
    stopResuming();
    // 離れたら試しのデータは取り続けず、段の断り書きも書き換えない
    probing?.abort(LEFT);
    probing = null;
    if (noteTimer !== null) clearTimeout(noteTimer);
    noteTimer = null;
    reset();
    stopRaw();
    thaw();
    void audioContextForLive?.close().catch(() => undefined);
    audioContextForLive = null;
    // 字幕を描くものも畳む (canvas の大きさを読む `ResizeObserver` を外す)
    painter?.close();
    painter = null;
    // コマごとの貼り直し (`follow`) も畳む
    following = null;
  }

  /** 出せなかったことにする。**貼ったフレームは剥がす**。動いて見えるほうが悪い */
  function fail(text: string): void {
    state = "error";
    message = text;
    attempts = 0;
    // 段を上げたあとの待ち (`upAsk`) を残すと、エラーの画面のまま段を下げてリクエストし直す
    upAsk = null;
    thaw();
  }

  /**
   * 待ってから繋ぎ直す (いちばん多いのはサーバの入れ替え)。待ちは倍々で 10 秒まで (`retryWait`)。回数の上限は
   * 置かない。点けっぱなしで戻ってきたときに映っていてほしい。切れた時点で打ち切っていた頃は、
   * 観ている最中に「選んでください」に戻って自分で選び直すことになっていた
   */
  function reconnect(): void {
    if (
      retry !== null ||
      left ||
      (tuned === null && chase === null) ||
      element === null
    )
      return;
    state = "connecting";
    message = "";
    const wait = retryWait(attempts);
    attempts++;
    retry = setTimeout(() => {
      retry = null;
      if (left || element === null) return;
      if (chase !== null) {
        reopenChase();
        return;
      }
      if (tuned === null) return;
      // 局は変わらないので、選べる字幕の一覧は残す
      void tune(element, tuned, true);
    }, wait);
  }

  /**
   * 音声を選び直す。繋ぎ直さずにリクエストし直す。サーバは音声ごとに別の ffmpeg を回すので MediaSource から
   * 作り直しになるが、チューナーはそのままで、前のフレームを貼っておくので黒くはならない
   */
  function setAudio(id: string): void {
    if (element === null || id === audio) return;
    // MPEG-2 では再エンコードしない。TS には全部の音声が入っている (`RawEngine.selectAudio`。ライブも追っかけも)
    if (raw && engine !== null) {
      audio = id;
      if (tuned !== null) {
        tuned = { ...tuned, audio: id };
        remember(tuned, choice);
      }
      pickAudio();
      return;
    }
    if (chase !== null) {
      audio = id;
      reopenChase();
      return;
    }
    if (tuned === null) return;
    // 局は変わらないので、選べる字幕の一覧はそのまま使える (`forget`)
    void tune(element, { ...tuned, audio: id }, true);
  }

  /**
   * コーデックのメニューで選ぶ (自動・エンコードするもの・MPEG-2)。音声と同じ扱い (`setAudio`) で、選んだものは
   * **この端末に覚える** (`LAST_COOKIE`。ライブだけ)。選び直したなら前の断り書きは用済みで、打ち切っていた形式も試し直す。
   * 決まる形式が今と同じならリクエストし直さない (自動で AV1 になっていて AV1 を選んだ、など)
   */
  function setChoice(next: LiveChoice): void {
    // 互換モードで描けない形式は選ばせない (並べるが押せない。`unavailable`)
    if (next !== "auto" && next !== "raw" && unavailable().includes(next))
      return;
    const before: LiveFormat = rawChosen && raw ? "raw" : codec;
    choice = next;
    warning = "";
    standing = null;
    compatGaveUp = false;
    av1GaveUp = false;
    hevcGaveUp = false;
    rawGaveUp = false;
    rungOff.clear();
    // 手で選んだものは段を下げない (`adapt`)。下げていたら元の画質でリクエストし直す
    if (next !== "auto") asked = 0;
    if (element === null) return;
    if (tuned !== null) remember(tuned, choice);
    // MPEG-2 をデコードできるかをまだ確かめていなければ、決まる形式が分からない。リクエストし直して確かめる
    const unknown = rawProblem === undefined && needsRawCheck();
    // 段を下げて流しているなら、形式はサーバが選んでいる。自動のままなら変わらない
    const same =
      served === 0 && asked === 0
        ? decideFormat() === before
        : next === "auto" && asked === served;
    if (!unknown && same && state !== "error") return;
    requestAgain();
  }

  /** 選んでいるものから決まる形式が、MPEG-2 になりうるか (デコードできるかを確かめる必要があるか)。4K の局の放送のままは HEVC */
  function needsRawCheck(): boolean {
    return (
      broadcastKind() === "mpeg2" &&
      (inUse() === "raw" || (inUse() === "auto" && options.indoor === true))
    );
  }

  /** いまの局の放送のコーデック (`Tuned.broadcast`)。追っかけは録画の放送のコーデック (4K の局の録画は HEVC。`openChase`) */
  function broadcastKind(): BroadcastCodec {
    return chase === null ? (tuned?.broadcast ?? "mpeg2") : chase.broadcast;
  }

  /** MSE で受け取れるか (`#lib/live.ts` の `codecsFor` で問い合わせる。サーバが渡すものと同じ) */
  function mseCan(next: LiveCodec): boolean {
    return pickMediaSource()?.Source.isTypeSupported(codecsFor(next)) ?? false;
  }

  /**
   * 4K の局の放送の HEVC を再生できるか (`probeBroadcastHevc`)。4K の局を初めて開くとき (`begin`) か、TS で送る 4K の局と
   * 答えで分かったとき (`checkBroadcastHevc`) に 1 回だけ調べる。調べるまでは undefined
   */
  let broadcastHevc: boolean | undefined;

  /** 放送の HEVC を再生できるかを調べる (`#lib/hevc-4k.ts`) */
  function probeBroadcastHevc(): Promise<boolean> {
    return broadcastHevcPlayable(browserHevcProbe(pickMediaSource()?.Source));
  }

  /**
   * TS に HEVC を入れて送る 4K の局と、答え (`tuned` の `broadcast`) で分かったときに確かめる。
   * 再生できなければ H.265 をやめて次の形式に移る (`giveUpCodec`)
   */
  function checkBroadcastHevc(): void {
    void probeBroadcastHevc().then((playable) => {
      broadcastHevc = playable;
      if (!playable && codec === "hevc" && !hevcGaveUp) giveUpCodec("hevc");
    });
  }

  /** H.265 を使えるか。4K の局は放送の HEVC の詰め替えを再生できるか、TS の局はサーバが GPU でエンコードできて受け取れるか */
  function hevcCan(): boolean {
    if (compat || hevcGaveUp) return false;
    if (broadcastKind() === "hevc") return broadcastHevc === true;
    return chase === null && options.hevc === true && mseCan("hevc");
  }

  /**
   * **コーデックのメニューに並べる、エンコードするもの (1 つだけ)。** サーバがその場でエンコードできる並び (`options.liveCodecs`) の
   * 先頭から、この端末で再生できるもの (`#lib/live-choice.ts` の `shownCodec`)。再生できるかは MSE で受け取れるか (互換モードなら描けるか) で見て、
   * 途中で打ち切ったか (`av1GaveUp` など) は見ない (見るとメニューが開いている間に入れ替わる)。
   * H.265 は追っかけ・互換モード・4K の局 (放送のままが HEVC の詰め替え) では出さないので並びから外す
   */
  function menuCodec(): LiveCodec | null {
    const noHevc = compat || chase !== null || broadcastKind() === "hevc";
    const live = (options.liveCodecs ?? ["h264"]).filter(
      (id) => !(noHevc && id === "hevc"),
    );
    return shownCodec(live, (id) => (compat ? canvasCan(id) : mseCan(id)));
  }

  /** いま使う選択。覚えていたエンコードするものは、メニューに並んでいるもの (`menuCodec`) と同じときだけ (`keptChoice`) */
  function inUse(): LiveChoice {
    return keptChoice(choice, menuCodec());
  }

  /**
   * **選んでいるものから、リクエストする形式を決める。** 自動なら `autoCodec`。選んだものは使えればそのまま、
   * 使えなければ外と同じ順 (AV1 → H.265 → H.264、互換モードは AV1 → H.264 → MPEG-2) で代わりを探す。何も使えなければ null。
   * 使えるかは、MPEG-2 はデコードできて打ち切っていないか、AV1・H.265・H.264 は受け取れて (互換モードなら描けて) 打ち切っていないか。
   * H.265 はそのうえで、ライブのエンコーダが GPU のときだけ (`options.hevc`)。互換モードと TS の局の追っかけでは使わない。
   * ライブと追っかけで決め方は同じ (使えない形式を外すだけ)。
   * **4K の局は、放送のままが HEVC の詰め替え** (`BroadcastCodec`)。MPEG-2 の場所に HEVC が入り (`autoOrder`)、H.265 は
   * 放送の HEVC を再生できるか (`hevcCan`) で決める
   */
  function decideFormat(): LiveFormat | null {
    const kind = broadcastKind();
    const can = {
      rawOk: kind === "mpeg2" && rawProblem === null && !rawGaveUp,
      av1: compat
        ? !compatGaveUp && compatSupport?.av1 === true
        : !av1GaveUp && mseCan("av1"),
      hevc: hevcCan(),
      h264: compat
        ? !compatGaveUp && compatSupport?.h264 === true
        : mseCan("h264"),
      compat,
      broadcast: kind,
    };
    const chosen = inUse();
    if (chosen === "auto")
      return autoCodec({ ...can, indoor: options.indoor === true });
    const wanted = chosen === "raw" ? broadcastFormat(kind) : chosen;
    const ok = wanted === "raw" ? can.rawOk : can[wanted];
    return ok ? wanted : autoCodec({ ...can, indoor: false });
  }

  /**
   * 形式を決めて (`decideFormat`)、リクエストする形式 (`codec`・`rawChosen`) に移す。選んだものと違う形式になったら
   * 理由を断り書きに出す (先に出ている理由があればそちら)。何も使えなければ理由を出して false
   */
  function pickFormat(): boolean {
    const kind = broadcastKind();
    // MPEG-2 を選んでいてもデコードできない端末では、選択を自動に戻して覚え直す (開くたびに断り書きが出る)
    if (
      choice === "raw" &&
      kind === "mpeg2" &&
      typeof rawProblem === "string"
    ) {
      note(`MPEG-2 を再生できません: ${rawProblem}`);
      choice = "auto";
      if (tuned !== null) remember(tuned, choice);
    }
    const next = decideFormat();
    if (next === null) {
      fail("再生できる形式がありません");
      return false;
    }
    const chosen = inUse();
    const wanted = chosen === "raw" ? broadcastFormat(kind) : chosen;
    if (chosen !== "auto" && next !== wanted && warning === "")
      note(
        `${formatLabel(chosen, kind)} を再生できないため、${formatLabel(next)} に切り替えました`,
      );
    rawChosen = next === "raw";
    if (next !== "raw") codec = next;
    if (tuned !== null) tuned = { ...tuned, codec, raw: rawChosen };
    return true;
  }

  /**
   * データ放送を出す・やめる (テレビの d ボタン)。
   *
   * **サーバはリクエストされてからデコードする。** 押すまでは 1 バイトも届かないかわりに、
   * 押してから出るまでカルーセルが一周するのを待つことになる
   * (`server/databroadcast.ts`)。
   */
  function setData(on: boolean): void {
    if (showData === on) return;
    showData = on;
    syncData();
  }

  /** データ放送を自動で受信するかを切り替える。端末ごとに覚える (`data-receive.ts`) */
  function toggleReceiveData(): void {
    receiveData = !receiveData;
    write(DATA_RECEIVE_KEY, receiveData ? "1" : "0");
    syncData();
  }

  /** いまサーバにリクエストしたいか (`wantsData`) */
  function wantData(): boolean {
    return wantsData({
      open: showData,
      auto: receiveData,
      tuned: tuned !== null,
      autoStart,
    });
  }

  /**
   * サーバにリクエストするかを、開いているか・自動で受信するか・局を映しているか・入口に自動起動の指定があるかから
   * 決め直す (`wantsData`)。変わったときだけ送る。**リクエストは選局の指示のあとに送る**。前の局のセッションにリクエストすると、
   * 前の局のものが届く (やめるほうは選局の指示より先に送ってよい。`begin`)
   */
  function syncData(): void {
    const want = wantData();
    // 受け取らないなら、待たせてあるぶんも捨てる
    if (!want) heldData = [];
    if (want === askedData || socket?.readyState !== WebSocket.OPEN) return;
    askedData = want;
    send({ type: "data", on: want });
  }

  /**
   * データ放送の通知を受け取る先を預かる。**描く側がいるときだけ渡す。**
   *
   * 渡す形式はデコードする側と描く側の取り決め (`ResponseMessage`。`packages/arib/src/bml-protocol.ts`) なので、
   * ここは素通しでいい。
   *
   * **預かった時点で、待たせてあるぶんを先に流す** (`heldData`)
   */
  function listenData(
    handler: ((message: ResponseMessage) => void) | null,
  ): void {
    onData = handler;
    const held = heldData;
    heldData = [];
    if (handler === null) return;
    for (const message of held) handler(message);
  }

  /**
   * 重ねるものの置き場を預かる。**画面が組み上がってから 1 回だけ。**
   *
   * @param frozen 切り替えの間、前のフレームを貼っておく先 (`freeze`)
   * @param subtitles 字幕を重ねる先 (`paint`)
   */
  function attach(
    frozen: HTMLCanvasElement,
    subtitles: HTMLCanvasElement,
    box: HTMLElement | null = null,
  ): void {
    still = frozen;
    painter?.close();
    painter = new CaptionPainter(subtitles);
    host = box;
  }

  /**
   * 選局する。**繋がっていれば繋ぎ直さない。**
   *
   * @param keepList 選べる字幕の一覧を残すか。**同じ局の中での選び直しだけ
   *   true** (`forget` の説明)。待たせている字幕はどの道いつも捨てる
   */
  async function tune(
    video: HTMLVideoElement,
    target: Tuned,
    keepList = false,
  ): Promise<void> {
    chase = null;
    chaseTimeline = null;
    // 別の局へ移ったらデータ放送を閉じる。サーバへは `begin` の `syncData` で送る
    if (closesData(lastService, target.serviceId)) {
      showData = false;
      autoStart = false;
    }
    lastService = target.serviceId;
    tuned = target;
    audio = target.audio ?? "";
    /*
     * 形式はメニューの選択 (`choice`) から `begin` が決め直す (`pickFormat`。`target` の `codec`・`raw` は使わない)。
     * 局を変えても選択は引き継ぐ (その端末で出るかの話)。覚えておくと次に開いたときサーバが同じ決め方で先回りする (`warm`)
     */
    remember(target, choice);
    await begin(video, keepList);
  }

  /**
   * 追っかけ再生を開く ([issue #16](https://github.com/danything/denpa/issues/16))。
   * **録画中の録画を、いま録れているところまで観る。** 再生の仕組みも接続のしかたもライブと
   * 同じで、送る指示だけ違う (`chase`)。範囲の外へのシークもこれ。
   * サーバが ffmpeg ごと立て直す (選局し直しと同じ流儀)。
   * `broadcast` は録画の放送のコーデック (4K の局の録画は `hevc`。放送のままは HEVC の詰め替え)。省けば、同じ録画を開き直すなら前のまま
   */
  async function openChase(
    video: HTMLVideoElement,
    recordingId: number,
    at = 0,
    keepList = false,
    broadcast?: BroadcastCodec,
  ): Promise<void> {
    tuned = null;
    chase = {
      recordingId,
      base: Math.max(0, at),
      broadcast:
        broadcast ??
        (chase?.recordingId === recordingId ? chase.broadcast : "mpeg2"),
    };
    chaseEnded = false;
    drained = false;
    await begin(video, keepList);
  }

  /** 追っかけを再生していた位置から開き直す (再エンコード・繋ぎ直しのたび。通しの位置は分かる) */
  function reopenChase(): void {
    if (chase !== null && element !== null)
      void openChase(element, chase.recordingId, chase.base + position, true);
  }

  /**
   * 局を選ぶ (画面から)。**録画に譲っていたことは忘れる**。選び直したのは本人で、
   * 戻る先も追っかけももう要らない。リクエストし直し・再エンコードの中から呼ぶ `tune` は忘れない
   */
  function choose(video: HTMLVideoElement, target: Tuned): Promise<void> {
    fallback = null;
    yielded = null;
    returning = false;
    return tune(video, target);
  }

  /**
   * リクエストし直しても入れなかった。**チューナーを取り上げた録画の追っかけに切り替える** (録れているところの少し手前から)。
   * 戻る先 (いまリクエストしていたライブ) は覚えておく (`backToLive`)
   *
   * @param refused 「ライブに戻る」を試して入れなかったのか (取り上げられた直後のリクエストし直しなら false)
   */
  function giveWay(recording: YieldedRecording, refused: boolean): void {
    const back = tuned ?? yielded?.back;
    if (element === null || back === undefined) return;
    fallback = null;
    returning = false;
    yielded = { recording, back, refused };
    // リクエストし直しで伸びた待ちは持ち越さない (追っかけが切れたら 1 秒から繋ぎ直す)
    attempts = 0;
    // 4K の局の録画は HEVC で開く (省くと MPEG-2 として開き、HEVC を受け取れない端末がリクエストし直しを繰り返す)
    void openChase(
      element,
      recording.id,
      CHASE_EDGE,
      false,
      recording.broadcast,
    );
  }

  /** 「ライブに戻る」。同じ局をリクエストし直し、入れなければ追っかけに戻る (`giveWay`) */
  function backToLive(): void {
    if (yielded === null || element === null || returning) return;
    returning = true;
    void tune(element, yielded.back);
  }

  /** リクエストし直したライブの中身が届いた。**入れた**ので、譲っていたことは忘れる */
  function arrived(): void {
    if (tuned === null) return;
    fallback = null;
    if (!returning) return;
    returning = false;
    yielded = null;
  }

  /**
   * いまリクエストしたいこと。**繋いだ直後と繋ぎ直しで同じものを送る**。
   * 中身を書き写していた頃は、足したものをどちらかへ足し忘れると
   * 「繋ぎ直したときだけ抜ける」という出方をした
   */
  function wantedCommand(): Command | null {
    if (chase !== null) {
      // 追っかけには音声だけが無い (ライブで音声だけにしていたまま録画に譲ったとき)。段 3 にする
      const lowered = rungFields(
        asked === "audio" ? LOWEST_RUNG : asked,
        playable(),
      );
      return {
        type: "chase",
        recordingId: chase.recordingId,
        at: chase.base,
        ...(audio === "" ? {} : { audio }),
        codec,
        caption: captionTrack,
        language: captionLanguage,
        raw: wantsRaw(),
        ...lowered,
      };
    }
    if (tuned !== null) {
      const tuner = pinnedTuner();
      return {
        type: "tune",
        ...tuned,
        caption: captionTrack,
        language: captionLanguage,
        raw: wantsRaw(),
        ...(tuner === null ? {} : { tuner }),
        // 段を下げるなら段と再生できるコーデック (コーデックはサーバが選ぶ)。放送のままは外す
        ...stepFields(asked, playable()),
      };
    }
    return null;
  }

  /**
   * MPEG-2 でリクエストするか。**MPEG-2 を選んでいて、デコードできて、まだ打ち切っていない**とき
   */
  function wantsRaw(): boolean {
    return rawChosen && rawProblem === null && !rawGaveUp;
  }

  /** 互換モードで描けない形式。**切り替えで選ばせない** (互換モードでなければ空) */
  function unavailable(): LiveCodec[] {
    if (!compat || compatSupport === null) return [];
    return LIVE_CODECS.map((c) => c.id).filter((id) => !canvasCan(id));
  }

  /** 互換モードで描けるか (`raw/support.ts` の `canvasSupport`)。H.265 は互換モードでは使わない */
  function canvasCan(id: LiveCodec): boolean {
    return id !== "hevc" && compatSupport?.[id] === true;
  }

  /**
   * 互換モードの支度 (`begin` の最初)。**入っていなければ何もしない。**
   *
   * 運転中の注意をまだ見せていなければ見せて、押されるまで待つ。描ける形式と MPEG-2 をデコードできるかを調べる
   * (どの形式にするかは `pickFormat`。**`<video>` には戻らない**。どれも描けなければ理由を出してリクエストしない)
   */
  async function prepareCompat(): Promise<void> {
    compat = canvasVideo();
    if (!compat) return;
    if (!driveNoticeSeen() && options.confirm !== undefined)
      await options.confirm();
    compatSupport ??= await canvasSupport();
    if (rawProblem === undefined) rawProblem = await rawUnsupported();
  }

  /**
   * `begin` を呼んだ回数。待っている間 (デコードできるかの確認・運転中の注意・チケット) に選び直された・画面を離れたら、
   * 古いほうはそこでやめる (`superseded`)。続けると WebSocket が 2 本開き、閉じられないほうが前の局を流し続ける
   */
  let begun = 0;

  /**
   * ページと一緒に受け取ったチケット (`options.ticket`) と、受け取った時刻 (`performance.now()`)。使ったら・古くなったら null
   */
  let pageTicket =
    typeof options.ticket === "string"
      ? { token: options.ticket, at: performance.now() }
      : null;

  /**
   * ページと一緒に受け取ったチケットを 1 回だけ渡す。**繋ぐのに使えるのは最初の 1 回だけ** (`tickets.ts` で 1 回使ったら消える)。
   * 受け取ってから寿命の半分 (`TICKET_LIFETIME`) を過ぎていたら渡さない (運転中の注意を待った・裏のタブで開いた)。
   * 渡せなければ null で、`/api/live/ticket` から取る
   */
  function takePageTicket(): string | null {
    const given = pageTicket;
    pageTicket = null;
    if (given === null || performance.now() - given.at > TICKET_LIFETIME / 2)
      return null;
    return given.token;
  }

  /** `mine` 回目の `begin` より後に選び直されたか、画面を離れたか */
  function superseded(mine: number): boolean {
    return mine !== begun || left;
  }

  /** 繋いでリクエストする。選局 (`tune`) と追っかけ (`openChase`) の共通の後半 */
  async function begin(
    video: HTMLVideoElement,
    keepList: boolean,
  ): Promise<void> {
    const mine = ++begun;
    startup = { at: performance.now() };
    element = video;
    left = false;
    // リクエストし直すのはこれ。観終えるのを待っていたなら、もう待たない (`resumeChase`)
    stopResuming();
    /*
     * **MPEG-2 になりうるなら、デコードできるかを先に確かめる** (1 回だけ。`raw/support.ts`)。
     * MPEG-2 を選んでいる・自動で家の中から開いた (`needsRawCheck`)。デコードできない端末では最初から
     * エンコードしたものをリクエストする (選んでいたなら理由を断り書きに出す。`pickFormat`)
     */
    if (needsRawCheck() && rawProblem === undefined) {
      rawProblem = await rawUnsupported();
    }
    // 4K の局なら、放送の HEVC を再生できるかを先に確かめる (1 回だけ。`#lib/hevc-4k.ts`)
    if (broadcastKind() === "hevc" && broadcastHevc === undefined) {
      broadcastHevc = await probeBroadcastHevc();
    }
    await prepareCompat();
    if (superseded(mine) || !pickFormat()) return;
    // 数え直す。再エンコードでも MediaSource から作り直しになるので、前の数は続きではない
    stalls = 0;
    /*
     * 段を決めるのに測った値も捨てる (選局・シーク・段の切り替え。`RungAdapter.reset`)。`tuned` が来るまでは決めない。
     * 段そのものは持ち越す
     */
    awaiting = true;
    lastPace = null;
    throughput.reset(Date.now());
    lagMeter.reset();
    starvedSince = null;
    lastFrameAt = 0;
    adapter.reset(Date.now());
    adaptTimer ??= setInterval(adapt, ADAPT_EVERY);
    // 字幕は映した 1 枚ごとに貼り直す (`follow`)。2 度目からは何もしない
    follow(video);
    // 次のフレームが出るまで前のフレームを貼る。**閉じる前に写す** (閉じると何も映らなくなる)
    freeze();
    /*
     * **回線が足りなくて下げるときは、繋ぎ直す** (`freshSocket`)。前の段の映像は回線の途中 (サーバ・中継・カーネル・
     * リバースプロキシ) に溜まっていて、同じ接続で送る指示の答え (`tuned`) も下げた段の映像もその後ろに並ぶ。手元で
     * 0.25 Mbit/s に絞ったときは、音声だけにすると決めてから `tuned` が届くまで 32 秒かかった。閉じれば溜まったぶんは捨てられる
     */
    if (freshSocket && socket !== null) {
      const old = socket;
      socket = null;
      old.onmessage = null;
      old.close();
    }
    freshSocket = false;
    // 繋がっていれば繋ぎ直さない (1 本に何度でも指示を送れる。`server/live.ts` の `attend`)
    const open = socket !== null && socket.readyState === WebSocket.OPEN;
    if (open) forget(keepList);
    else reset(keepList);

    state = "connecting";
    message = "";
    quiet = Date.now() + GRACE;
    // サーバは新しい指示で送るのを止めた印を戻す (`server/live.ts` の `attend`)。物差しの 0 も届き直す
    feedHeld = false;
    origin = null;
    rawHead = null;

    if (open) {
      const command = wantedCommand();
      /*
       * やめるなら選局の指示より先に送る。サーバは受信をリクエストしている人が次の局のセッションに入ると、
       * 覚えているぶん (実機で約 2MB) をまとめて送る (`server/live.ts` の `refreshData`)
       */
      if (!wantData()) syncData();
      if (command !== null) send(command);
      // 局を映すか (追っかけ・録画に譲るか) で、自動で受信のときのリクエストが変わる
      syncData();
      return;
    }

    /*
     * **チケットを先に取る。** ブラウザは WebSocket の握手に `Authorization` を
     * 付けてくれないので、認証を通れることをここで示す (`tickets.ts`)。
     * 最初の 1 回はページと一緒に受け取ったものを使い、`/api/live/ticket` の往復を省く (`takePageTicket`)
     */
    const fromPage = takePageTicket();
    let ticket: string;
    if (fromPage !== null) {
      ticket = fromPage;
      if (startup !== null) startup.ticket = "page";
    } else {
      try {
        const res = await fetch(resolve("api/live/ticket"), {
          method: "POST",
        });
        if (!res.ok) throw new Error(String(res.status));
        ticket = ((await res.json()) as { ticket: string }).ticket;
        if (startup !== null) startup.ticket = performance.now() - startup.at;
      } catch {
        if (superseded(mine)) return;
        // 繋ぎ直しの最中なら、サーバからまだ応答が無いだけ。待ち直す
        if (attempts > 0) reconnect();
        else fail("繋がりませんでした");
        return;
      }
      if (superseded(mine)) return;
    }
    /*
     * ページと一緒に受け取ったチケットで繋がらなかったか。**断られたら `/api/live/ticket` から取り直す**。
     * 戻るで開き直したページは、ブラウザが手元に持っていた HTML (使い終えたチケットが入っている) を出すことがある。
     * サーバを起動し直していても、配ったチケットは残っていない
     */
    let opened = false;

    const scheme = location.protocol === "https:" ? "wss" : "ws";
    // このエンドポイントは SvelteKit のルートではない (server.js が受ける) ので、型の付いた `resolve` に
    // パスごとは渡せない。接頭辞 (`resolve('')` = 接頭辞 + `/`) だけを使う
    const ws = new WebSocket(
      `${scheme}://${location.host}${resolve("")}${SOCKET_PATH.slice(1)}?ticket=${ticket}`,
    );
    ws.binaryType = "arraybuffer";
    socket = ws;

    ws.onopen = () => {
      opened = true;
      if (startup !== null) startup.open = performance.now() - startup.at;
      // 繋がった。次に切れたときはまた 1 秒から待ち直す
      attempts = 0;
      const command = wantedCommand();
      if (command !== null) ws.send(JSON.stringify(command));
      // データ放送を受け取るかどうかはサーバでは接続 (Viewer) に紐づいていて、切れると忘れられる
      askedData = false;
      syncData();
    };

    ws.onerror = () => {
      // 繋ぎ直しの最中か、ページと一緒に受け取ったチケットを断られた。すぐ後ろに `onclose` が来るので、そちらで待ち直す
      if (attempts > 0 || (fromPage !== null && !opened)) return;
      if (state !== "playing") fail("繋がりませんでした");
    };

    // 切れたら繋ぎ直す (`reconnect`)
    ws.onclose = () => {
      if (socket !== ws || state === "error") return;
      socket = null;
      // ページと一緒に受け取ったチケットを断られた。`/api/live/ticket` から取って繋ぎ直す (もう `takePageTicket` は渡さない)
      if (fromPage !== null && !opened && !left && element !== null) {
        void begin(element, keepList);
        return;
      }
      if (left || (tuned === null && chase === null) || element === null) {
        state = "idle";
        return;
      }
      reconnect();
    };

    ws.onmessage = (event) => {
      const data = event.data as ArrayBuffer;
      // 段を下げる先を決めるのに、受け取りの速さを測る (`adapt`)。中身を問わず数える
      throughput.push(Date.now(), data.byteLength);
      const kind = new DataView(data).getUint8(0);
      const body = new Uint8Array(data, 9);

      // 元の TS。写さずに worker へ移す (`RawEngine.feed`。先頭の 9 バイトは種別と時刻)
      if (kind === CHANNEL.rawTs) {
        arrived();
        /*
         * **`tuned` より前に届いたものは前の局の残りなので数えない。** 繋がっている接続で局を替えると、サーバは `tuned` を
         * 新しい局のデータより先に送る。数えていた頃は、前の局の残りで 6〜10ms と出ていた
         */
        if (startup?.tuned !== undefined)
          startup.bytes ??= performance.now() - startup.at;
        // 届く間隔は数えない (`arrive`)。元の TS はチューナーから読めたぶんずつ来るので、塊の間合いが決まっていない
        engine?.feed(data, 9);
        return;
      }

      if (kind === CHANNEL.control) {
        const notice = JSON.parse(new TextDecoder().decode(body)) as Notice;
        if (notice.type === "error") {
          // リクエストし直しても入れなかった。取り上げた録画か、「ライブに戻る」を試していたなら追っかけへ
          const to = returning ? (yielded?.recording ?? null) : fallback;
          if (notice.unpin === true && tuned !== null) {
            // 名指しのチューナーがもう無い。名指しをやめて、エージェントに選ばせてリクエストし直す (docs/watch.md)
            liveTuner.set(null);
            note(notice.message);
            requestAgain();
          } else if (to !== null && tuned !== null) giveWay(to, returning);
          else if (
            !raw &&
            served !== 0 &&
            served !== "audio" &&
            (codec === "av1" || codec === "hevc") &&
            !rungOff.has(codec)
          ) {
            /*
             * 段を下げた変換で GPU が降りた (AV1・H.265 はソフトウェアに降りない)。段を下げている間はそのコーデックを
             * `playable` から外し、同じ段をリクエストし直す (サーバが次のコーデックを選ぶ)
             */
            rungOff.add(codec);
            note(`${notice.message}。ほかの形式に切り替えました`);
            requestAgain();
          } else if (
            codec === "hevc" &&
            !raw &&
            !hevcGaveUp &&
            chase === null &&
            tuned !== null &&
            broadcastKind() === "mpeg2"
          ) {
            /*
             * H.265 でリクエストして降りた (サーバが GPU でエンコードできなかった。ソフトウェアには降りられない)。
             * この画面を開いている間は H.265 をやめて、次の形式でリクエストし直す (`decideFormat`)。
             * 4K の局の `hevc` は詰め替えで GPU を使わないので、エラーは形式のせいではない。ここには入れない
             */
            hevcGaveUp = true;
            note(`${notice.message}。ほかの形式に切り替えました`);
            requestAgain();
          } else fail(notice.message);
        } else if (notice.type === "lost") {
          /*
           * チューナーから外された (録画に取り上げられた・エージェントとの接続が切れた)。いつもの繋ぎ直しで
           * 同じ局をリクエストし直し、入れなかったら取り上げた録画へ (上の `error`)
           */
          fallback = notice.recording;
          reconnect();
        } else if (notice.type === "restart") {
          /*
           * 番組が替わって音声・字幕の構成が変わった。同じ局をすぐリクエストし直す (前のフレームは貼ったまま)。
           * 続けて来たら、いつもの繋ぎ直し (待ちが倍々) に乗せて連打しない
           */
          const now = Date.now();
          const calm = now - restartedAt >= RESTART_CALM;
          restartedAt = now;
          if (chase !== null) resumeChase(!calm);
          else {
            // 字幕の本数も変わるかもしれない。無い番号をリクエストすると字幕ごと外されるので 1 本目に戻す
            captionTrack = 0;
            if (!calm) reconnect();
            else if (tuned !== null && element !== null)
              void tune(element, tuned, true);
          }
        } else if (notice.type === "notice") {
          // 映像は出ている。断り書きに残す (GPU でエンコードできずにソフトウェアへ降りた、サーバが混んでいて段を下げられなかった、など)
          note(notice.message);
          standing = null;
        } else if (notice.type === "pace") {
          // 送り出しの具合。届くたびに新しいオブジェクトにする (`AdaptSample.pace`。同じものの `dropped` は 1 回だけ数える)
          lastPace = {
            backlog: notice.backlog,
            dropped: notice.dropped,
            speed: notice.speed,
          };
        } else if (notice.type === "captions") {
          captionTracks = notice.tracks;
          captionTrack = notice.track;
          // 載っている言語が分かったら、覚えている言語 (ISO 639) に合わせる (`caption-pref.ts`)
          captionLanguages = notice.languages ?? [];
          if (notice.languages !== undefined) {
            const want = pickLanguage(
              notice.languages,
              read(CAPTION_LANGUAGE_KEY),
            );
            const now = notice.language ?? 1;
            captionLanguage = now;
            if (want !== now) setCaptionLanguage(want, false);
          }
        } else if (notice.type === "clock") {
          /*
           * サーバが受け取った時刻と物差しの対応。端末の時計は当てにせず、サーバの時計との差 (`skew`) で数える。
           * MPEG-2 の物差しは放送の PTS そのものなので、一周をまたいでいたら伸ばして合わせる
           */
          const at =
            raw && engine !== null
              ? engine.unwrap(notice.at * CLOCK) / CLOCK
              : notice.at;
          broadcast = { at, unixMs: notice.unixMs };
          skew = notice.now - Date.now();
        } else if (notice.type === "hybridcast") {
          hybridcast = notice.apps;
        } else if (notice.type === "autoStart") {
          // いまの局の入口に自動起動の指定があるか。自動で受信する端末は、あればリクエストする (`wantsData`)
          if (chase === null) {
            autoStart = notice.on;
            syncData();
          }
        } else if (notice.type === "timeline") {
          /*
           * 追っかけの物差し。**base はサーバが決めた実際の開始位置に
           * 合わせ直す**。リクエストした位置は録れている範囲に収められることがある
           */
          if (chase !== null) chase = { ...chase, base: notice.at };
          // 元の TS で受けるとき、届いた PTS から位置を出す物差しの 0 (`rawChaseAt`)
          origin = notice.origin ?? null;
          chaseTimeline = {
            recordedSec: notice.recordedSec,
            totalSec: notice.totalSec,
            finished: notice.finished,
            since: Date.now(),
          };
        } else if (notice.type === "ended") {
          // 録れているところまで読み切った。流し残しが尽きたら MediaSource を閉じる (canvas なら鳴らしきって止める)
          chaseEnded = true;
          ending = true;
          finishStream();
          engine?.finish();
        } else if (notice.type === "tuned") {
          if (startup !== null)
            startup.tuned ??= performance.now() - startup.at;
          // 選べる音声はここで初めて分かる (いま流れている番組次第)
          audios = notice.audios;
          audio = notice.audio;
          awaiting = false;
          /*
           * **サーバが PMT を読んで、TS に HEVC を入れて送る 4K の局と分かった** (`broadcast`)。放送のままをリクエストしていても
           * 答えは HEVC の詰め替えで、下の `start` で MSE に移る。この局を開いている間は「放送のまま」を HEVC として扱い、
           * 次からの指示にも付ける (`Tuned.broadcast`。サーバは選局の前から HEVC の詰め替えとして受ける)
           */
          if (
            notice.broadcast === "hevc" &&
            chase === null &&
            tuned !== null &&
            tuned.broadcast !== "hevc"
          ) {
            /*
             * リクエストする形式も、4K の局で「放送のまま」を選んだときと同じ `hevc` にする (`pickFormat`)。`tuned.codec` が
             * 前のまま (`h264` など) だと、字幕の選び直しのように選局し直さずに送る指示で、HEVC の詰め替えではなくエンコードになる
             */
            tuned = { ...tuned, broadcast: "hevc" };
            if (!notice.raw) {
              rawChosen = false;
              if (notice.codec !== "audio") codec = notice.codec;
              tuned = { ...tuned, codec, raw: false };
            }
            if (broadcastHevc === undefined) checkBroadcastHevc();
          }
          const step = servedStep(notice);
          // 追っかけで音声だけを選んでいたときは、実際には段 3 をリクエストしている (`wantedCommand`)
          const requested =
            chase !== null && asked === "audio" ? LOWEST_RUNG : asked;
          if (stepOrder(step) < stepOrder(requested)) {
            // サーバが混んでいて下げられなかった (理由は続く `notice`)。段の切り替えとして数えられないので、20 秒は同じ段を返させない
            adapter.refused(Date.now());
            asked = step;
          }
          served = step;
          // 音声だけのときは、映像のコーデックを前のまま持つ (メニューは「自動 (音声だけ)」)
          if (notice.codec !== "audio") codec = notice.codec;
          if (notice.raw) startRaw(video);
          else if (compat) startCompat(video, codec);
          // 音声だけ (AAC) を受け取れない端末は無いが、受け取れなければ H.264 と同じく理由を出して止まる
          else
            start(
              video,
              notice.codecs,
              notice.codec === "audio" ? "h264" : notice.codec,
            );
        }
        return;
      }

      /*
       * **互換モードのエンコードしたもの。** MSE ではなく RawEngine へ、写さずに移す (`RawEngine.feed`)。
       * **init が来たら中身を捨てて開き直す** (エンコードする経路で SourceBuffer を作り直すのと同じ。
       * 再エンコードすると時刻は 0 から数え直しになるので、前の音や映像の待ちと混ぜない)
       */
      if (
        (kind === CHANNEL.videoInit || kind === CHANNEL.videoMedia) &&
        engineInput === "fmp4"
      ) {
        if (kind === CHANNEL.videoInit) {
          arrived();
          engine?.reset();
          forgetFlow();
        } else {
          arrive();
        }
        engine?.feed(data, 9);
        return;
      }

      if (kind === CHANNEL.videoInit) {
        arrived();
        /*
         * **init が来たら作り直す。** チャンネルを変えると映像の形式も変わるので、
         * 前の SourceBuffer に足すと中身が混ざって再生が止まる
         */
        pending.length = 0;
        if (buffer !== null && source?.readyState === "open") {
          try {
            buffer.abort();
          } catch {
            // 追加中でなければ例外になる。無視してよい
          }
        }
      }
      // データ放送 (`ResponseMessage` の JSON)。受け取る側がまだ無いときは取っておく (`heldData`)
      if (kind === CHANNEL.data) {
        const message = JSON.parse(
          new TextDecoder().decode(body),
        ) as ResponseMessage;
        if (onData !== null) onData(message);
        // 受け取るつもりが無いなら取っておく意味も無い
        else if (askedData && heldData.length < HOLD_DATA)
          heldData.push(message);
        return;
      }

      if (kind === CHANNEL.videoInit || kind === CHANNEL.videoMedia) {
        // 戻れる幅を決めるのに、どれだけ来ているかを数える (`keepFor`)
        if (receivedFrom === 0) receivedFrom = Date.now();
        received += body.byteLength;
        if (kind === CHANNEL.videoInit) {
          forgetFlow();
          keyGate.init(body);
        } else {
          // **足す前のバッファが、次の塊が届く直前の低いところ** (`lows`)。間隔もここで測る
          if (element !== null) sampleLow(element);
          arrive();
          // 途中から入ったら、最初のキーフレームまでは渡さない (`ts/key-gate.ts`)
          if (!keyGate.pass(body)) return;
        }
        nativeAudio?.feed(body, kind === CHANNEL.videoInit);
        pending.push(body);
        drain();
        return;
      }

      /*
       * 字幕。文字の配置の JSON (`caption-text.ts`)。映像と同じ ffmpeg が付けた時刻に置く。字幕のほうが先に
       * 届くので、届いた時点の位置に置くと早く出ていた ([stream.md](../../docs/stream.md#時刻同期))
       */
      if (kind === CHANNEL.captionText) {
        if (element === null) return;
        const stamp = Number(new DataView(data).getBigUint64(1));
        // 変換しない経路は放送の PTS のまま来る (`server/captions.ts` の `rawCaptionArgs`)。一周をまたいだら伸ばす
        const at =
          (raw && engine !== null ? engine.unwrap(stamp) : stamp) / CLOCK;
        let page: CaptionPage;
        try {
          page = JSON.parse(
            new TextDecoder().decode(new Uint8Array(data, 9)),
          ) as CaptionPage;
        } catch {
          return; // 壊れた 1 枚。次が来る
        }
        // 知らないバージョンは描かない (置き場所の読み方が違うかもしれない)
        if (page.v !== CAPTION_TEXT_VERSION) return;
        cues = insertCue(cues, { at, page });
      }
    };
  }

  /**
   * その形式をやめて次の形式へ切り替え、そう言う。この画面を開いている間は、自動でもその形式を選ばない (`decideFormat`)。
   * 次の形式が無ければ、リクエストし直した先 (`pickFormat`) が理由を出して止まる
   */
  function giveUpCodec(baked: Exclude<LiveCodec, "h264">): void {
    if (baked === "av1") av1GaveUp = true;
    else hevcGaveUp = true;
    const next = decideFormat();
    if (next !== null)
      note(
        `${formatLabel(baked)} を再生できないため、${formatLabel(next)} に切り替えました`,
      );
    requestAgain();
  }

  /**
   * **`<video>` がエラーになった。送り込みを止めて、次の形式へ切り替える。** `isTypeSupported` が受け取れると
   * 答えても、流すと断る形式がある (Android の Chrome 133 は MP4 の `Opus` を受け取ると答え、流すと
   * `CHUNK_DEMUXER_ERROR_APPEND_FAILED` で断った。`live.ts` の `mseType`)。Chrome は断ったあと SourceBuffer を外すので、
   * `buffer` を捨てる。外れたものの `buffered` を読むと `InvalidStateError` になり、そのまま「読み込み中」で止まっていた
   */
  function onMediaError(): void {
    const failed = mseCodec;
    if (failed === null || source === null) return;
    mseCodec = null;
    buffer = null;
    pending.length = 0;
    if (failed !== "h264") giveUpCodec(failed);
    else fail("映像を再生できませんでした。選び直すと繋ぎ直します");
  }

  /**
   * MediaSource を用意する (`codecs` はサーバが決めて送ってくる)。受け取れない形式なら、黒いままにせず
   * 次の形式 (`decideFormat`) に切り替えて、そう通知する
   */
  function start(
    video: HTMLVideoElement,
    codecs: string,
    baked: LiveCodec,
  ): void {
    // canvas で描いていたものからエンコードしたものへ戻るとき (打ち切った・選び直した)。canvas を畳んで <video> を出す
    stopRaw();
    // iPhone の Safari には MediaSource が無く、ManagedMediaSource だけがある (`ts/media-source.ts`)
    const picked = pickMediaSource();
    // MP4 の `Opus` は、小文字を受け取れる端末には小文字で渡す (`live.ts` の `mseType`)
    const type =
      picked === null
        ? codecs
        : mseType(codecs, (t) => picked.Source.isTypeSupported(t));
    if (picked === null || !picked.Source.isTypeSupported(type)) {
      if (baked !== "h264") {
        giveUpCodec(baked);
        return;
      }
      fail("再生できない形式です");
      return;
    }
    // 前の MediaSource の名残を落とす (音声の選び直しは繋ぎ直さないので `reset` を挟まない)
    clear();
    mseCodec = baked;
    // 受け取れると答えたのに、流すと断る形式がある (`onMediaError`)。同じ関数なので何度足しても 1 つ
    video.addEventListener("error", onMediaError);
    // エンコード方式が変われば太さも変わる。数え直す
    received = 0;
    receivedFrom = 0;
    /*
     * **音を別に鳴らせなくなっても再生は止めない。** `<video>` の音に戻す (音量のつまみは効かないが、
     * 前と同じに観られる)。自動で選んだ経路なので、それが失敗して観られなくなるのでは困る
     */
    const giveUpAudio = (reason: string): void => {
      nativeAudio?.destroy();
      nativeAudio = null;
      video.muted = silenced;
      note(`音を別に鳴らせないため、音量のつまみは効きません (${reason})`);
    };
    if (options.separateAudio?.()) {
      try {
        const separate = new NativeAudio(
          video,
          (reason) => {
            if (nativeAudio === separate) giveUpAudio(reason);
          },
          `${resolve("").replace(/\/$/, "")}/api/live/mpeg2`,
          (audioContextForLive ??= audioContext("interactive")),
        );
        nativeAudio = separate;
        separate.setVolume(volume);
        separate.setMuted(silenced);
        separate.setBackground(playback);
      } catch (error) {
        giveUpAudio(error instanceof Error ? error.message : String(error));
      }
    }
    const media = new picked.Source();
    source = media;
    /*
     * ManagedMediaSource は AirPlay を断らないと開かない (HLS は持っていない)。ほかの違い (送り込む頃合い・
     * ブラウザが捨てる) は手当てしない。ライブは待てず、`trim`・`pace` は毎回 `buffered` を読み直す
     */
    if (picked.managed) video.disableRemotePlayback = true;
    const objectUrl = URL.createObjectURL(media);
    video.src = objectUrl;
    media.addEventListener(
      "sourceopen",
      () => {
        URL.revokeObjectURL(objectUrl);
        // 開く前に作り直した (選局し直した) あとに届いた古いほう。新しい MediaSource には触らない
        if (source !== media) return;
        // 終わりが無いと言っておく。言わないと尺が届くたびに伸び、備え付けの再生位置が行き来する
        media.duration = Number.POSITIVE_INFINITY;
        buffer = media.addSourceBuffer(type);
        // 並べ直させない (`sequence` だと 1 つ取りこぼすと以降ずっと映像と音声がずれる)
        buffer.mode = "segments";
        buffer.addEventListener("updateend", () => {
          drain();
          pace(video);
        });
        /*
         * 1 枚目が描かれてから前の局の静止画を剥がす (`play()` のあとだと貼ったまま音が鳴った)。待ち構えるのは
         * `loadedmetadata` から。`loadeddata` からでは 1 枚目を逃して、音より 54〜80ms 遅れて剥がれていた
         */
        video.addEventListener("loadedmetadata", () => onFrame(video, thaw), {
          once: true,
        });
        /*
         * 詰まったことを覚えて貯める量を決める (`nextTarget`)。同じ関数を渡す。`<video>` は同じものなので、
         * その場で作っていた頃は MediaSource を作り直すたびにリスナーが増え、1 回の途切れを 3 回に数えていた
         */
        video.addEventListener("waiting", onWaiting);
        // 詰まりの終わり (段を決めるのに使う。`stuck`)。同じく同じ関数を渡す
        video.addEventListener("playing", onPlaying);
        drain();
      },
      { once: true },
    );
  }

  /**
   * RawEngine を用意する (`tuned` で raw: true と答えられた)。**2 度目からは作り直さず開き直すだけ**。
   * worker とデコーダの読み込み (1MB ほど) を選局のたびにやり直さない
   */
  function startRaw(video: HTMLVideoElement): void {
    if (!openEngine(video, "ts-mpeg2")) return;
    raw = true;
    pickAudio();
  }

  /**
   * 互換モードの RawEngine を用意する (`tuned` でエンコードしたものと答えられた)。エンコードしたもの (fMP4) を MSE でなく
   * RawEngine へ流して canvas に描く。**サーバが別の形式に落としてきて** (AV1 をエンコードできなかった) それが
   * 描けない形式なら、MPEG-2 か理由へ (`fallBack`)
   */
  function startCompat(video: HTMLVideoElement, baked: LiveCodec): void {
    if (!canvasCan(baked)) {
      fallBack(`${formatLabel(baked)} を再生できません`, "fmp4");
      return;
    }
    openEngine(video, "fmp4");
  }

  /**
   * RawEngine を開く。**同じものを受け取る RawEngine があれば作り直さず開き直すだけ**、違うもの
   * (MPEG-2 ⇔ エンコードしたもの) なら作り直す。描く先の canvas の使い方が違う (WebGL2 ⇔ 2D)。
   * 開けなければ false
   */
  function openEngine(video: HTMLVideoElement, input: RawInput): boolean {
    clear();
    const forChase = chase !== null;
    if (engine !== null && (engineInput !== input || engineChase !== forChase))
      stopRaw();
    if (engine === null) {
      // エンコードしたものを流していた <video> は止める。音が二重に鳴らないように
      video.pause();
      video.removeAttribute("src");
      video.load();
      try {
        const box = host ?? video.parentElement;
        if (box === null) throw new Error("表示先がありません");
        engine = new RawEngine(
          box,
          still,
          target,
          {
            // 新しい局の 1 枚目を描いた。動き出すのは貯まってから (`rawPace`) だが、開くまでの時間はここで出す
            shown: () => {
              thaw();
              reportStartup(performance.now());
            },
            stalled: onWaiting,
            gaveUp: (reason, slow) => fallBack(reason, input, slow),
            // ロック画面・車の操作で `<audio>` を直に止められた・再開された
            remote: (stop) => {
              if (stop !== paused) toggle();
            },
            // 追っかけで抱えきれなくなった。手元が尽きる前に再生している位置からリクエストし直す (`rawPace`)
            full: () => {
              starved = true;
            },
            // 追っかけを録れているところまで鳴らしきった (`ended` の通知で `finish` したあと)。止めておく
            ended: () => {
              drained = true;
              if (paused || engine === null) return;
              paused = true;
              engine.pause();
            },
          },
          playback,
          input,
          forChase,
        );
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        fallBack(
          input === "fmp4"
            ? `再生を始められませんでした (${why})`
            : `MPEG-2 の再生を始められませんでした (${why})`,
          input,
        );
        return false;
      }
      engineInput = input;
      engineChase = forChase;
      // 押されたときの処理は <video> に付いている (`MediaStack`)。見えなくするだけで、そこに残す
      video.style.opacity = "0";
      // 音を消していたなら、canvas で描くときも消したまま始める
      if (silenced) engine.mute();
      engine.volume = volume;
    } else {
      engine.reset();
    }
    canvas = true;
    if (rawTimer === null) rawTimer = setInterval(rawPace, 20);
    return true;
  }

  /** 選んでいる音声を RawEngine に伝える。**再エンコードしない** (`setAudio`) */
  function pickAudio(): void {
    const track =
      audios.find((candidate) => candidate.id === audio) ?? audios[0];
    if (engine !== null && track !== undefined)
      engine.selectAudio(track.stream, track.side);
  }

  /** RawEngine を畳む。**エンコードしたものに戻るときと、画面を離れるとき** */
  function stopRaw(): void {
    if (rawTimer !== null) clearInterval(rawTimer);
    rawTimer = null;
    engine?.destroy();
    engine = null;
    engineInput = null;
    engineChase = false;
    raw = false;
    canvas = false;
    decodeMs = 0;
    thinned = false;
    if (element !== null) element.style.opacity = "";
  }

  /**
   * canvas で描くのをやめる。**理由は断り書きに残す** (`warning`)。黙って戻すと、設定を入れたのに効いて
   * いない理由が分からない。
   *
   * - MPEG-2 をやめた … エンコードしたものに戻す。互換モードならエンコードしたものも canvas に描く
   *   (`prepareCompat`)。互換モードでエンコードしたものも描けなければ、理由を出して止まる
   * - 互換モードのエンコードしたものをやめた … MPEG-2 で描けるならそちらへ、無理なら理由を出して止まる。
   *   **`<video>` には戻らない** (テスラでは止まってしまう)
   *
   * 間に合わずにやめたとき (`slow` がある) は、掛かった条件をコンソールに出力する
   */
  function fallBack(reason: string, input: RawInput, slow?: string): void {
    stopRaw();
    if (slow !== undefined)
      console.warn(
        `[live] ${input === "fmp4" ? "互換モードの描画" : "MPEG-2"} を打ち切りました: ${slow}`,
      );
    if (input === "fmp4") {
      compatGaveUp = true;
      if (rawProblem === null && !rawGaveUp) {
        note(`${reason}。MPEG-2 に切り替えました`);
        /*
         * 段を下げていたら段 0 に戻す。下げた段のままだと `stepFields` が `raw` を外し、描けるものの無い
         * `playable` でまた変換をリクエストする。MPEG-2 に移ったあとは段を動かさない (`adapt`)
         */
        asked = 0;
        requestAgain();
        return;
      }
      fail(reason);
      return;
    }
    rawGaveUp = true;
    if (compat && (compatGaveUp || !LIVE_CODECS.some((c) => canvasCan(c.id)))) {
      fail("MPEG-2 の再生を続けられませんでした");
      return;
    }
    note(reason);
    requestAgain();
  }

  /**
   * 形式を決め直してリクエストし直す (打ち切った形式は `decideFormat` が外す)。ライブは同じ局を、追っかけは
   * 再生していた位置から
   */
  function requestAgain(): void {
    if (element === null) return;
    if (chase !== null) reopenChase();
    else if (tuned !== null) void tune(element, tuned, true);
  }

  /**
   * canvas で描く経路の `pace`。**時計が音なので、`updateend` の代わりに刻みで回す。**
   * バッファ・放送からの遅れ・字幕の貼り直し・貯める量の決め直しを、エンコードする経路と同じ形で出す
   */
  function rawPace(): void {
    if (engine === null) return;
    if (!running && engine.playing) {
      running = true;
      state = "playing";
      // 自動再生で断られた。**押すまで映像だけ進める** (壁時計。`RawEngine.blocked`)。
      // 音も消しておく。他を押したついでに鳴りだすと、画面の「消音」と食い違う
      if (engine.blocked) mute();
    }
    const at = engine.position;
    const cost = tenth(engine.decodeMs);
    if (cost !== decodeMs) decodeMs = cost;
    if (engine.thinned !== thinned) thinned = engine.thinned;
    const rounded = running ? tenth(engine.lead) : null;
    if (rounded !== delay) delay = rounded;
    if (!live) live = true;
    if (at !== null) {
      const truly = airLag(at);
      if (truly !== fromAir) fromAir = truly;
      paint(at);
      sweep(at);
      // 再生位置 (再エンコードの先頭からの秒)。追っかけは base を足して通しで出す (`chasePosition`)
      const local = tenth(
        raw && chase !== null ? rawChaseAt(at, chase.base) : at,
      );
      if (local !== position) position = local;
    }
    if (raw && chase !== null) holdFeed(engine.lead);
    /*
     * **互換モードの追っかけで抱えきれなくなっていたら、手元が尽きる前に再生している位置からリクエストし直す**
     * (`RawEvents.full`)。サーバは倍速で送り込むので観ている先が伸び続け、worker は上限で
     * 受け取るのをやめている。読み直しの間 (1 秒ほど) は前のフレームのまま止まる
     */
    if (chase !== null && starved && !paused && engine.lead < REFILL) {
      starved = false;
      reopenChase();
    }
    settle();
  }

  /**
   * 追っかけを元の TS で受けているときの再生位置 (`base` からの秒)。PTS は放送の時刻のままなので、録画の先頭の PTS
   * (`origin`) を引いて通しの位置を出す (観る画面の MPEG-2 と同じ `sinceHead`)。バイト数から割り出した `base`
   * より正しい。`origin` が無ければ、鳴らし始めた位置を `base` とみなす
   */
  function rawChaseAt(at: number, base: number): number {
    if (origin !== null) return rawChasePosition(at, base, origin);
    rawHead ??= at;
    return at - rawHead;
  }

  /**
   * 追っかけを元の TS で受けているとき、**サーバに送るのを止めさせる・続けさせる** (`{ type: 'hold' }`。`live-chase.ts` の `holdStep`)。
   * サーバは倍速で送り込み、元の TS は捨てられない (捨てると観ていない先が欠ける) ので、受信バッファが溜まったら止めさせる。
   * 一時停止している間も止めさせる。**送れたときだけ覚える。** 繋ぎ直している間に送れなかったぶんは、繋がってから送り直す
   */
  function holdFeed(lead: number): void {
    feedHeld = holdStep(feedHeld, lead, paused, (on) =>
      send({ type: "hold", on }),
    );
  }

  return {
    get state() {
      return state;
    },
    /** いま観ている形式 (コーデックのメニューの「自動 (…)」に添える)。MPEG-2 なら `raw` */
    get format(): LiveFormat {
      return raw ? "raw" : codec;
    },
    /** いまの局の放送のコーデック。コーデックのメニューの「放送のまま」の名前に使う (4K の局は H.265) */
    get broadcast(): BroadcastCodec {
      return broadcastKind();
    },
    /**
     * canvas で描いているか (放送のままの MPEG-2 か、互換モードのエンコードしたものか)。**操作バーの出し分けに使う**。
     * どちらも遡れない。切り抜き・小窓も canvas から取る
     */
    get canvas() {
      return canvas;
    },
    /** この端末で描けない形式 (互換モードのとき)。コーデックのメニューで選ばせない */
    get unavailable() {
      return unavailable();
    },
    /**
     * canvas で描いているときの、いま出しているコマ (切り抜き)。**映像は worker の canvas に
     * あって、`<video>` からは写せない** (`RawEngine.grab`)。canvas で描いていなければ null。
     * `size` を付けると縮めたもの (アンビエントモード)
     */
    grab(size?: GrabSize): Promise<ImageBitmap | null> {
      return canvas && engine !== null
        ? engine.grab(size)
        : Promise.resolve(null);
    },
    /**
     * canvas で描いているときの映像ストリーム (PiP)。**映像は worker の canvas にあって、`<video>` は
     * 空のまま**なので、そのストリームを別の `<video>` に映す (`pip.svelte.ts`)。
     * 取り方は `RawEngine.pipStream`。canvas で描いていない・取れない (Firefox) なら null
     */
    capture(): MediaStream | null {
      return canvas && engine !== null ? engine.pipStream() : null;
    },
    /** 小窓へ映像を流すか (`RawEngine.pipFlow`)。出していない間は写さない */
    captureFlow(on: boolean): void {
      engine?.pipFlow(on);
    },
    /** canvas で描くときの音を「再生する音」として鳴らすか (`playback`)。`<video>` で観ているなら `<video>` が鳴らすので関係ない */
    set playback(on: boolean) {
      playback = on;
      if (engine !== null) engine.background = on;
      nativeAudio?.setBackground(on);
    },
    /** 音量 (%)。canvas で描くときの音に掛ける。`<video>` の音は画面が Web Audio に通して掛ける (`volume.svelte.ts`) */
    set volume(level: number) {
      volume = level;
      if (engine !== null) engine.volume = level;
      nativeAudio?.setVolume(level);
    },
    /** canvas で描くとき、1 コマデコードするのに掛かっている時間 (ms、95 パーセンタイル)。canvas で描いていなければ 0 */
    get decodeMs() {
      return decodeMs;
    },
    /** MPEG-2 のコマを間引いているか */
    get thinned() {
      return thinned;
    },
    get message() {
      return message;
    },
    get tuned() {
      return tuned;
    },
    /** 音を止められているか。押して出してもらう */
    get silenced() {
      return silenced;
    },
    /** 手元に貯めている長さ (秒)。再生していないときは null */
    get delay() {
      return delay;
    },
    /** 選局してから詰まった回数。0 のときは画面に出さない */
    get stalls() {
      return stalls;
    },
    /** 繋ぎ直しを待っている最中か。**待っていることを画面に出すため** */
    get resuming() {
      return attempts > 0;
    },
    /** 描かれずに捨てられたコマ。**映像だけ遅れるときの切り分けに** */
    get dropped() {
      return dropped;
    },
    /**
     * 覚えている下限 (秒)。**測り直すボタンを出すかどうかの判断に使う**。
     * 下限のままなら忘れるものが無い (`relearn`)
     */
    get remembered() {
      return floor;
    },
    /**
     * いま効いている下限 (秒)。覚えた下限 (`remembered`) と、届く間隔を覆う高さ (`cover`) の高いほう。
     * **不具合の報告に要る**。止まった原因が届き方なのか、ほかなのかを切り分ける
     */
    get floor() {
      return Math.max(floor, cover(gapMost));
    },
    /** ここ数分でいちばん長く空いた、映像の塊が届く間隔 (秒)。0 なら測っていない */
    get gapMost() {
      return gapMost;
    },
    /** いま貯めようとしている量 (秒) */
    get target() {
      return target;
    },
    /** 放送からの遅れ (秒)。隣のテレビとの差 */
    get fromAir() {
      return fromAir;
    },
    get slipMost() {
      return slipMost;
    },
    /** 映像の遅れを直すために飛び直した回数 */
    get slips() {
      return slips;
    },
    /** いまの再生の速さ */
    get rate() {
      return rate;
    },
    /** 選局してから、ライブで再生の速さを変えた回数 */
    get rateChanges() {
      return rateChanges;
    },
    /**
     * **いま映しているコマの放送時刻** (unix ms、サーバの時計)。`clock` の通知と再生位置から出す
     * (実況のコメントを合わせる。`JikkyoLayer`)。`clock` がまだ届いていなければ null
     */
    airTime(): number | null {
      if (broadcast === null) return null;
      const at =
        engine !== null ? engine.position : (element?.currentTime ?? null);
      if (at === null) return null;
      return broadcast.unixMs + (at - broadcast.at) * 1000;
    },
    /** 押して止めているか */
    get paused() {
      return paused;
    },
    /** 放送の今に張り付いているか */
    get live() {
      return live;
    },
    /** どこまで戻れるか (いちばん古い時刻) */
    get oldest() {
      return oldest;
    },
    /** 放送の今 (いちばん新しい時刻) */
    get newest() {
      return newest;
    },
    /** いま映している時刻 */
    get position() {
      return position;
    },
    /** 選べる音声。1 つしか無ければ切り替えを出さない */
    get audios() {
      return audios;
    },
    /** いま鳴らしている音声 (`AudioTrack.id`) */
    get audio() {
      return audio;
    },
    /** いま再生中の段 (`#lib/adapt.ts` の `Step`。回線に合わせて下げた画質)。0 は下げていない */
    get step() {
      return served;
    },
    /** リクエストされたとおりにできなかったときの断り書き。無ければ空 */
    get warning() {
      return warning;
    },
    /** コーデックのメニューで選んでいるもの (自動・エンコードするもの・MPEG-2)。並んでいないものを覚えていれば自動 (`inUse`) */
    get choice() {
      return inUse();
    },
    /** コーデックのメニューに並べる、エンコードするもの (`menuCodec`) */
    get shown() {
      return menuCodec();
    },
    setChoice,
    /** 前のフレームを貼っているか。**切り替えの間の黒を埋めている** */
    get holding() {
      return holding;
    },
    /** 追っかけ再生か。**わざと遅れて見ている** */
    get chasing() {
      return chasing;
    },
    /** 追っかけの速さ。ライブでは常に 1 */
    get speed() {
      return speed;
    },
    setSpeed,
    /** データ放送を出しているか */
    get showData() {
      return showData;
    },
    setData,
    /** データ放送を自動で受信するか (端末ごと) */
    get receiveData() {
      return receiveData;
    },
    /**
     * 開く前から受信して、入口を裏で動かしているか (`DataBroadcast` の `receive`)。自動で受信していて、局を映していて、
     * その局の入口に自動起動の指定があるとき
     */
    get receivingData() {
      return receiveData && tuned !== null && autoStart;
    },
    toggleReceiveData,
    listenData,
    /** 字幕を出しているか */
    get captions() {
      return captions;
    },
    /** いま描いている字幕の 1 枚 (切り抜きに文字を添える)。出していなければ null */
    get shownCaption(): CaptionPage | null {
      return shown;
    },
    /** 放送が字幕を持っているか。**1 枚も届いていなくても分かる** */
    get hasCaptions() {
      return captionTracks.length > 0;
    },
    /** この番組に載っている Hybridcast (行き先。データ放送が起動を求めたら開く) */
    get hybridcast() {
      return hybridcast;
    },
    /** 選べる字幕。2 本以上あれば画面は選び直しを出す */
    get captionTracks() {
      return captionTracks;
    },
    /** いま出している字幕 (`CaptionTrack.index`) */
    get captionTrack() {
      return captionTrack;
    },
    setCaptionTrack,
    /** いまの字幕のストリームに載っている言語。分かるまでは空 */
    get captionLanguages() {
      return captionLanguages;
    },
    /** 出している言語 (`CaptionLanguage.index`) */
    get captionLanguage() {
      return captionLanguage;
    },
    setCaptionLanguage,
    setCaptions,
    /** 字幕の出し入れ。テレビの字幕ボタンと同じ */
    toggleCaptions() {
      setCaptions(!captions);
    },
    attach,
    seek,
    toggle,
    goLive,
    relearn,
    tune: choose,
    unmute,
    /** 消音の切り替え。映像の要素を直に触ると、繋ぎ直しのたびに `silenced` で上書きされて戻る */
    toggleMute() {
      if (silenced) unmute();
      else mute();
    },
    /** 録画に譲って、その追っかけを観ているか (戻る先と、戻れなかったか)。譲っていなければ null */
    get yielded() {
      return yielded;
    },
    /** 「ライブに戻る」を試している最中か */
    get returning() {
      return returning;
    },
    backToLive,
    setAudio,
    stop,
    /* ---- 追っかけ再生 ([issue #16](https://github.com/danything/denpa/issues/16)) ---- */
    openChase,
    chaseSeek,
    /** 追っかけの再生位置 (秒)。再エンコードをまたいで通しで数える */
    get chasePosition() {
      return chase === null ? 0 : chase.base + position;
    },
    /** 追っかけの物差し。右端は送られた時点の値。録画中は画面が壁時計で伸ばす */
    get chaseTimeline() {
      return chaseTimeline;
    },
    /** 追っかけが録れているところまで読み切ったか */
    get chaseEnded() {
      return chaseEnded;
    },
  };
}
