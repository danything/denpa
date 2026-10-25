/**
 * ライブ視聴の受け側。**WebSocket で受けて MSE へ流す。**
 *
 * MSE は取ってこない。`appendBuffer()` に渡すバイト列をどこから持ってくるかは
 * こちら次第で、denpa は WebSocket から受ける ([stream.md](../../docs/stream.md#websocket-プロトコル))。
 * 同じ1本で字幕もデータ放送も一緒に送る作りなので、種別で振り分ける。
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

import type { AudioTrack } from "#lib/arib.js";
import { canvasVideo, driveNoticeSeen } from "#lib/canvas-video.js";
import { CaptionPainter } from "#lib/components/player/caption-draw.js";
import {
  CAPTION_LANGUAGE_KEY,
  CAPTION_ON_KEY,
  pickLanguage,
  storedCaptionsOn,
} from "#lib/components/player/caption-pref.js";
import { eachFrame } from "#lib/components/player/frames.js";
import { denpaFontUrl } from "#lib/font.js";
import { forget, read, write } from "#lib/keep.js";
import {
  type CaptionTrack,
  CHANNEL,
  CHASE_EDGE,
  type Command,
  type HybridcastLink,
  LAST_COOKIE,
  LIVE_CODECS,
  type LiveCodec,
  type Notice,
  SOCKET_PATH,
  type Tuned,
  type YieldedRecording,
} from "#lib/live.js";
import { RawEngine } from "#lib/raw/engine.js";
import type { GrabSize, RawInput } from "#lib/raw/messages.js";
import {
  type CanvasSupport,
  canvasSupport,
  rawUnsupported,
} from "#lib/raw/support.js";
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
  FIXED,
  FLOOR,
  GAP_MOST,
  GAP_WINDOW,
  nextTarget,
  pacing,
  SMOOTH,
  STEADY,
  type Steering,
} from "#lib/ts/pacing.js";

type LiveState = "idle" | "connecting" | "playing" | "error";

/**
 * 遅れて見られる長さ (秒)。**止めている間も受け取り続けるので、上限が要る。**
 *
 * ブラウザが抱えられる量には上限があり、超えると `appendBuffer` が落ちる。
 * 5分あれば、電話に出て戻ってくるくらいは追いつける。
 */
const KEEP = 300;
/**
 * 抱えてよい量 (バイト)。時間だけで切ると、ビットレートの高い映像 (H.264 は実測 35.9Mbit/s。5分で 1.3GB) で
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
/** 貯める量を決め直す間隔 (ms)。塊は毎秒20個来るので、そのたびには回さない */
const SETTLE_EVERY = 5_000;
/**
 * 貯まりの低いところを見る長さ (秒。`pacing` の `low`)。**次の塊が届く直前の貯まりを拾う。**
 *
 * まとめて届く経路では、塊は 0.3〜0.5 秒おきに束で来る。束の先頭の直前がいちばん低く、
 * 束の残りは届くたびに高く見える。何回ぶんかの束を収める長さにする
 */
const LOW_SPAN = 2;
/**
 * 映した1枚ごとに貯まりを見るときの、`pace` を回す間隔 (ms)。**塊が届かない間も止まる前に手を打つ。**
 *
 * `pace` は塊が届いたとき (`updateend`) にしか回っていなかったので、空いている間は
 * 何もできなかった。そこで遅くし始めれば、空きの終わりまで持つことがある
 */
const PACE_EVERY = 250;
/**
 * 選局や飛んだ直後、詰まりを数えない間 (ms)。
 *
 * **自分で起こした詰まりで貯める量を増やさない。** MediaSource を作り直せば必ず
 * `waiting` が上がるし、飛べば読み込み直しになる。宅外で本当に届かない
 * のとは別ものなので、混ぜると遅延が伸びたまま戻らない
 */
const GRACE = 3_000;
/**
 * 前のフレームを貼っておく上限 (ms)。**次が出なくても、いつかは剥がす。**
 *
 * 貼りっぱなしにすると、選局に失敗したときに「前のチャンネルが止まっている」
 * 画面が残る。壊れているのに動いて見えるのがいちばん悪い
 */
const HOLD_MOST = 6_000;
/**
 * 繋ぎが切れたときに待つ時間 (ms)。**倍々に伸ばして、この上限で頭打ち。**
 *
 * いちばん多いのは**サーバの入れ替え** (デプロイ)。コンテナごと作り直すので数十秒
 * 帰ってこないが、帰ってくることは分かっている。切れた時点で諦めていた頃は、
 * 観ている最中に「選んでください」に戻って**自分で選び直す**ことになっていた
 */
const RETRY_FIRST = 1_000;
const RETRY_MOST = 10_000;
/** 番組が替わって作り直す (`restart`) のが、これより短い間に続いたら待つ (ms) */
const RESTART_CALM = 30_000;
/** 追っかけで作り直したあと、手元がこれ (秒) を切ったらリクエストし直す (`resumeChase`) */
const RESUME_LEFT = 0.3;
/** 手元を見る間隔 (ms。`resumeChase`) */
const RESUME_EVERY = 250;
/** 手元が残ったまま位置がこれ (ms) だけ進まなければ、観終えるのを待たずにリクエストし直す (`resumeChase`) */
const RESUME_STUCK = 3_000;
/**
 * 映像だけがこれだけ遅れたら飛び直す (秒)。声と口のずれが分かりはじめるのが 0.1 秒あたり。
 * 実機で無事なときの遅れは最大 0.058 秒だったので、飛んでばかりにはならない (0.15 では分かるのに直らなかった)
 */
const SLIP_MOST = 0.1;
/**
 * 互換モードの追っかけで、抱えきれずに受け取るのをやめたあと、手元がこれを切ったらリクエストし直す (秒)。
 * 読み直し (ffmpeg の立ち上がりとキーフレーム待ち) は 1 秒ほどなので、尽きる前に間に合う
 */
const REFILL = 5;
/** 飛び直す間隔の下限 (ms)。**復号が追いつかない状態は飛んでも直らない** */
const UNSLIP_EVERY = 3_000;
/*
 * コマ落ちでは飛び直さない。実機の Windows Edge は落ち着いたあとでも絶えず 5.6% 落ちていて、合図にすると
 * 3秒ごとに飛び続けた (飛ぶたびに音が 0.02 秒飛ぶ)。飛んでもコマ落ちは減らなかった
 */
/** 飛び直すときに進める幅 (秒)。**1コマぶん** — 音が飛んだと分かる長さではない */
const FRAME = 0.02;
/**
 * 映像が出せるようになるのを待ってよい上限 (ms)。
 *
 * **貯まっただけでは始めない** (`canStart`)。それでも `readyState` が上がって
 * こないことはある (映像の無い放送・復号に失敗) ので、待ちきりにはしない
 */
const START_WAIT = 1_500;
/** 再生位置がキーフレームに着いたとみなす幅 (秒。`pace`)。ブラウザが時刻を丸めるぶん */
const KEY_SLACK = 0.001;
/** 0.1秒刻みに丸める (画面に出す値。細かく書き換えて描き直させない) */
const tenth = (value: number): number => Math.round(value * 10) / 10;

/**
 * データ放送の通知を、受け取る側ができるまでに取っておく数 (`heldData`)。待つのは 700KB を落とす間だけで
 * 数十で足りるが、モジュールは1通が 100KB を超えることがあるので、立たなかったときに際限なく抱え込ませない
 */
const HOLD_DATA = 300;

/**
 * 見ている局を覚える。置き場は cookie 1つで、読むのはサーバ (`LAST_COOKIE` の説明)。
 * 音声も覚える — 番組が変わって無くなっても、サーバは先頭に落とす (`arib.pickTrack`)
 */
function remember(target: Tuned): void {
  const value = encodeURIComponent(JSON.stringify(target));
  // パスは接頭辞込み。`/live` と決め打ちすると、前段の接頭辞の下では読む画面に届かない
  document.cookie = `${LAST_COOKIE}=${value}; path=${resolve("live")}; max-age=31536000; samesite=lax`;
}

/**
 * 覚えておく「これより下へは貯めない量」の置き場 (`ts/pacing` の `nextTarget`)。端末ごとに覚える —
 * 経路の性質なので、宅内の PC と出先のタブレットで違う。開くたびに `FLOOR` から始めていた頃は、
 * 開いて30秒以内に必ず1回止まっていた
 */
const FLOOR_KEY = "live-floor";

function storedFloor(): number {
  // 読めない繋ぎ (プライベート窓) では下限から始める (`keep.read`)
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
 * 速さの寄せ方 (`ts/pacing.ts` の `Steering`)。**Safari (Apple の WebKit) だけ、速さを触る回数を減らす** (`STEADY`)。
 * iPad と iPhone はどのブラウザも中身が WebKit なので、ここに入る。
 *
 * **URL に `?steer=off` を付けると、ライブで速さを変えない** (`FIXED`)。速さを変えるのが乱れの元かを
 * 確かめるためだけのもので、⚙ には出さない (#1210)
 */
function chooseSteering(): Steering {
  if (typeof location === "undefined") return SMOOTH;
  if (new URLSearchParams(location.search).get("steer") === "off") return FIXED;
  return navigator.vendor === "Apple Computer, Inc." ? STEADY : SMOOTH;
}

interface LivePlayerOptions {
  /**
   * 運転中の注意を見せて、「わかりました」を待つ (互換モード。`canvas-video.ts`)。
   * **まだ見せていない端末で、canvas で描く前に1回だけ呼ぶ。** 押されるまで再生を始めない
   */
  confirm?: () => Promise<void>;
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
  /** どこまで戻れて、いまどこにいるか (シークバー。0.1秒刻み) */
  let oldest = $state(0);
  let newest = $state(0);
  let position = $state(0);
  /** 選べる音声。1つしか無ければ画面は切り替えを出さない */
  let audios = $state<AudioTrack[]>([]);
  /** いま鳴らしている音声 (`AudioTrack.id`) */
  let audio = $state("");
  /** いまエンコードしてもらっているコーデック。**サーバが返してきたものを持つ** */
  let codec = $state<LiveCodec>("h264");
  /**
   * 断り書き。失敗ではないが、リクエストされたとおりにできなかったとき (AV1 を出せないので H.264 に戻した・
   * サーバの `notice`)。`message` と違って選局で消さない — 戻した先が映っても理由が残っているように
   */
  let warning = $state("");
  /** 前のフレームを貼っているか。**次のフレームが出るまでの黒を埋める** */
  let holding = $state(false);
  /**
   * データ放送を出すか (テレビの d ボタン)。サーバは押されてからデコードする (`server/live.ts` の `wantData`)。
   * 局を変えても押したままにする
   */
  let showData = $state(false);
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
   * たいていは日本語1つで、英語の字幕が付く番組がたまにある
   */
  let captionLanguages = $state<CaptionLanguage[]>([]);
  /** 出している言語 (`CaptionLanguage.index`)。サーバは視聴者ごとに出し分ける */
  let captionLanguage = $state(1);
  /**
   * 選べる字幕。1枚も届いていなくても分かる (サーバが入口で読んでいる)。届いてから出していた頃は、
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
   * シークで再エンコードするたびに base が変わる。画面に見せる位置は base + position
   */
  let chase = $state<{ recordingId: number; base: number } | null>(null);
  /** 追っかけの物差し (`timeline` の通知)。録画中は右端を壁時計で伸ばして読む */
  let chaseTimeline = $state<{
    recordedSec: number;
    totalSec: number;
    finished: boolean;
    since: number;
  } | null>(null);
  /** 追っかけが録れているところまで読み切ったか */
  let chaseEnded = $state(false);
  /** 読み切ったら、流し残しが尽きたところでMediaSource を閉じる (`finishStream`) */
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
   * 試して入れなかったか (画面は「録画が終わるまでライブは見られません」を出す)
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
   * **MSE の代わりに `raw/engine.ts` を使う。** それ以外 (繋ぎ・通知・字幕・データ放送・
   * 貯め方の決め方) はエンコードする経路と同じものを通す。違うのは描く先と時計だけ:
   *
   * | | エンコードする経路 | 変換しない経路 |
   * | --- | --- | --- |
   * | 描く先 | `<video>` + MSE | canvas (worker の WebGL2) |
   * | 時計 | `video.currentTime` (0 起点) | 鳴っている音の PTS (放送の時刻そのまま) |
   * | 貯まり | `buffered.end - currentTime` | 届いた音の端 − 鳴っている位置 |
   * | 止めて再開 | 止めた所から (5分戻れる) | **放送の今から** (遡るほど持っていない) |
   */
  /** いま MPEG-2 で見ているか。**サーバが `tuned` でそう答えたときだけ** */
  let raw = $state(false);
  /**
   * canvas で描いているか (放送のままの MPEG-2 か、互換モードのエンコードしたものか)。**操作列の出し分けに使う** —
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
   * 車載ブラウザ) のため。サーバへのリクエストのしかたは変えず、届いた fMP4 を MSE ではなくRawEngine
   * (`RawEngine` の `fmp4`) へ流す。**ここでは `<video>` に戻らない** — 描けなくなったら
   * MPEG-2 へ、それも無理なら理由を出して止まる
   */
  /** 互換モードか。**選局のたびに読み直す** (再生の設定 ⚙ でオン/オフされる) */
  let compat = $state(false);
  /** この端末で描ける形式 (`raw/support.ts` の `canvasSupport`)。調べるまで null */
  let compatSupport = $state<CanvasSupport | null>(null);
  /** 互換モードで描くのを諦めたか。**選び直すまでリクエストし直さない** (MPEG-2 の `rawGaveUp` と同じ) */
  let compatGaveUp = false;
  /** MPEG-2 を選んでいるか。**リクエストするかどうかの元** — 実際に MPEG-2 になったかは `raw` */
  let rawChosen = false;
  /**
   * MPEG-2 を諦めたか (デコードするのが間に合わない・音がデコードできない・デコーダが無い)。**この画面を開いている
   * 間はリクエストし直さない** — 戻しては諦めるを繰り返すと、そのたびに映像が止まる
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
  /** canvas で描く経路の刻み。貯まり・貯める量の決め直しを回す (`rawPace`) */
  let rawTimer: ReturnType<typeof setInterval> | null = null;
  /** canvas で描くとき、1コマデコードするのに掛かっている時間 (ms、95パーセンタイル)。**画面に出す** */
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
  /** 字幕を描く係。重ねる先の canvas は画面から預かる (`attach`) */
  let painter: CaptionPainter | null = null;
  /** 貼りっぱなしを避けるための目覚まし */
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 待たせている字幕。時刻の順 ([ts/captions.ts](./ts/captions.ts))。時刻は映像と同じ ffmpeg が付けた物差しで、
   * 字幕のほうが先に届くので、再生位置が追いつくまで持っておく
   */
  let cues: Cue[] = [];
  /** いま描いている1枚。同じものを描き直さない */
  let shown: CaptionPage | null = null;
  /** もう再生を始めたか。始めるまでは貯める */
  let running = false;
  /**
   * 描かれずに捨てられたコマの数 (画面に出す)。音・字幕・再生位置は同じ時計に乗っているので、映像だけ遅れるなら
   * 遅れているのは復号。遅延の数字には出ないので、この数で切り分ける
   */
  let dropped = $state(0);
  /** `droppedVideoFrames` を最後に読んだ値 (`countDropped`)。Safari は飛ぶたびに 0 に戻すので差を足し上げる */
  let droppedSeen = 0;
  /** 途中から入った流れの、最初のキーフレームまでを渡さない係 (`ts/key-gate.ts`)。**始める位置もここで決まる** */
  const keyGate = new KeyGate();
  /** 映した1枚が再生位置からどれだけ遅れているか (秒)。音と字幕は再生位置に乗るので、口の動きだけずれる (`unslip`) */
  let slip = $state(0);
  /** 飛び直した回数。**画面に出す** — 直し続けているなら、まだ足りていない */
  let slips = $state(0);
  /** 速さの寄せ方 (`chooseSteering`) */
  const steering = chooseSteering();
  /**
   * 選局してから再生の速さを変えた回数。**画面に出す** — Safari は変えるたびにつまずく
   * (`ts/pacing.ts` の `Steering`) ので、補正やコマ落ちの数と並べて見る (#1210)
   */
  let rateChanges = $state(0);
  /** いまの再生の速さ。**画面に出す** (等速でないときだけ) */
  let rate = $state(1);
  /**
   * サーバが受け取った時刻と、エンコードしたものの物差しの対応 (`clock` の通知)。
   * **届くまでは null** — 画面は届いてから出す
   */
  let broadcast = $state<{ at: number; unixMs: number } | null>(null);
  /** サーバの時計 − 端末の時計 (ms)。**端末の時計を当てにしないため** */
  let skew = 0;
  /** 放送との本当の差 (秒。0.1秒刻み)。`at` は物差しの上の再生位置。`clock` が届くまでは null */
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
  /** 次に飛び直してよい時刻 */
  let unslipAfter = 0;
  /*
   * 映像の遅れは JS から見えないことがある (Windows の Chrome / Edge は映像を DOM と別の面に出す)。
   * なので起きる条件の途切れ (`stalled`) で飛び直す (`settle`)。コマ落ちを合図にしない理由は `UNSLIP_EVERY` の下
   */
  /** 貯まりが足りた最初の時刻。**映像を待ちきりにしないため** (`canStart`) */
  let enoughAt = 0;
  /** 繋ぎ直しの目覚まし。**待っている間だけ入っている** */
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
  /** 最後に塊が届いた時刻 (秒)。0 なら次の1つは間隔に数えない (選局した直後・止めている間) */
  let lastArrival = 0;
  /** ここしばらくの貯まりの低いところ (`pacing` の `low`)。時刻は秒 */
  const lows = new Extreme(LOW_SPAN, false);
  /** ここ数秒の届く間隔のいちばん長いもの (`pacing` の `dip`)。時刻は秒 */
  const dips = new Extreme(LOW_SPAN, true);
  /** 映した1枚ごとに `pace` を回した最後の時刻 (ms。`PACE_EVERY`) */
  let pacedAt = 0;
  /** 画面に出す、いちばん長く空いた間隔 (秒)。**不具合の報告に要る** (`gapMost`) */
  let gapMost = $state(0);
  /**
   * この時刻まで、詰まっても数えない (選局・飛んだ直後は必ず `waiting` が上がる)。自分で起こした詰まりで
   * 貯める量を伸ばすと、伸ばした先が下限として残って遅延が戻らない (`pacing.ts` の `PROBE`)
   */
  let quiet = 0;
  /** 追加待ちの列。`appendBuffer` は1つずつしか受け付けない (前のが終わる前に呼ぶと止まる) */
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
      // (でないと幕が前のフレームを塗り潰す)。剥がすのは新しい局の1枚目 (`shown`)
      if (engine === null) return;
      /*
       * **貼る canvas は空にしておく。** 中身はエンコードしていたころに写したフレームのまま残っていて、
       * MPEG-2 の canvas より上にある — 空にしないと、選局のたびにその古いフレーム (前にエンコードして
       * 見ていた局の) が一瞬かぶさって見える
       */
      if (still !== null) still.width = 0;
    } else {
      if (element === null || still === null) return;
      // まだ1枚も出ていない (初めて開いたとき)。写すものが無い
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
   * 一瞬黒くなる。`requestVideoFrameCallback` は「1枚映した」ところで来る。
   * 持っていないブラウザでは `timeupdate` で代える (1枚ぶん遅いが実害は無い)
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

  /** 字幕を貼り直し続けている映像。**1つにつき1本** */
  let following: HTMLVideoElement | null = null;

  /**
   * 字幕を映した1枚ごとに貼り直す ([frames.ts](components/player/frames.ts))。塊が届いたとき (`pace`) だけだと
   * 遅れる方向にずれていた (実機で平均 15ms・最大 53ms)。止めて見ている間は来ないので、片付けは `pace` に置く
   */
  function follow(video: HTMLVideoElement): void {
    if (following === video) return;
    following = video;
    eachFrame(video, (frame) => {
      // 別の映像に移ったら、こちらは畳む
      if (following !== video) return false;
      // 映した1枚の時刻と再生位置の差 (`slip`)。`requestVideoFrameCallback` を持つブラウザでだけ測れる
      if (frame !== undefined) {
        const late = video.currentTime - frame.mediaTime;
        slip = Math.max(late, 0);
        if (slip > slipMost) slipMost = slip;
        if (slip > SLIP_MOST) unslip(video);
      }
      paint(video.currentTime);
      // 塊が届かない間も貯まりを見て、ときどき `pace` を回す (`PACE_EVERY`)
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
   * いまの貯まりを、低いところの候補として覚える (`lows`)。**届く直前と、映した1枚ごとに呼ぶ。**
   * ライブで再生しているときだけ (追っかけは貯まりを狙いに寄せない)
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

  /** 届く間隔と貯まりの低いところを忘れる。**選局したとき・飛んだとき** (前の局・前の位置の値は当てにならない) */
  function forgetFlow(): void {
    lows.clear();
    dips.clear();
    lastArrival = 0;
  }

  /**
   * いま覆うべき空き (秒)。覚えている間隔と、**いま空いている最中の間隔**の長いほう —
   * 詰まりはたいてい空きの途中で起きるので、届くのを待たずに数える
   */
  function gapNow(): number {
    const now = performance.now() / 1000;
    const ongoing = lastArrival > 0 ? Math.min(GAP_MOST, now - lastArrival) : 0;
    return Math.max(gaps.peek(now) ?? 0, ongoing);
  }

  /**
   * 貯まりの低いところに足す量 (`pacing` の `dip`)。ここ数秒の届く間隔と、**いま空いている最中の間隔**の長いほう —
   * 覆えている空きの途中で「足りない」と見て遅くしない (遅くするのは本当に足りないときだけ)。
   * 空いている最中の間隔は、覚えている間隔 (`gaps`) までしか足さない — それより長く空いたら、遅くして持たせにいく
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
  }

  /**
   * 映像だけ遅れているのを、その場へ飛び直して直す (復号が間に合わないと映像だけ取り残され、戻らない)。
   * 飛び直すとデコーダは積み残しを捨てて出し直す。連発はさせない (`UNSLIP_EVERY`)
   */
  function unslip(video: HTMLVideoElement): void {
    const now = Date.now();
    if (now < unslipAfter || video.paused || video.seeking) return;
    unslipAfter = now + UNSLIP_EVERY;
    slips++;
    slip = 0;
    // これで上がる `waiting` は数えない (`quiet`)
    quiet = now + GRACE;
    // **1コマぶんだけ前へ。** 同じ値を入れ直すのは飛んだことにならない
    video.currentTime += FRAME;
  }

  /** 再生位置に合う1枚だけ字幕を描く ([ts/captions.ts](./ts/captions.ts) の `currentCue` / `showing`) */
  function paint(at: number): boolean {
    if (painter === null) return false;
    const next = captions ? showing(currentCue(cues, at), at) : null;
    if (next === shown) return false;
    shown = next;
    painter.show(next);
    return true;
  }

  /** 待たせているぶんを片付ける。**いま出している1枚は残す** (出しっぱなしのため) */
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
      // 追っかけを読み切っていて、流し残しも無ければ、ここでMediaSource を閉じる
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
   * 追っかけを読み切ったらMediaSource を閉じる (`MediaSource.endOfStream`)。
   * 締めないと、バッファの端で「読み込み中」のまま止まって見える。
   * 流し残し (`pending`) があるうちは待つ — 締めると残りが入らなくなる
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
   * 再生位置を面倒みる。**届いた端でそのまま出すと、絶えず止まる。**
   *
   * 少し貯めてから始め、離れたら速めて詰める ([pacing.ts](./ts/pacing.ts))。
   * 別のタブへ行って戻ってきたときだけ飛ぶ — 飛ぶと音が切れるので、
   * 常用するとそれ自体が「かくつき」になる。
   */
  function pace(video: HTMLVideoElement): void {
    if (engine === null) countDropped(video);
    if (buffer === null || buffer.updating || buffer.buffered.length === 0)
      return;
    const end = buffer.buffered.end(buffer.buffered.length - 1);
    const behind = end - video.currentTime;
    // 0.1秒刻みにする (塊は毎秒20個届く。そのたびに書き換えると画面を無駄に描き直す)
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
     * 止めて見ている間は映した1枚が来ない (`follow`) のでここでする
     */
    paint(video.currentTime);
    sweep(video.currentTime);

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
     * 貯まりは倍速の送り込み (`server/chase.ts`) でどんどん伸びる。飛びも
     * 詰めもせず、少し貯まったら選んだ速さで進むだけ。読み切った後は
     * 貯まりを待たない (もう来ない)
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
     * 持っている頭はその塊の頭 — キーフレームより1〜2コマ手前のことがある。そこから始めると、
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
      steering,
    });

    /*
     * **追いついたらライブに戻す。** 押してもらう必要は無い — 追いついた
     * ところで選んだ速さのまま進むと放送を追い越し、溜まりを使い切って止まる
     */
    if (next.caught) {
      chasing = false;
      speed = 1;
    }
    if (next.seek !== null) {
      video.currentTime = next.seek;
      quiet = Date.now() + GRACE;
      lows.clear();
    }
    if (next.rate !== null) steerTo(video, next.rate);
    // 読み直すと 1 に戻るので、入れた値ではなく今の値を出す
    rate = video.playbackRate;
    if (next.play && !running && canStart(video)) startPlaying(video);
  }

  /** 再生を始める。前のフレームは1枚映ってから剥がす (ここで剥がすと一瞬黒くなる) */
  function startPlaying(video: HTMLVideoElement): void {
    running = true;
    state = "playing";
    void play(video);
    onFrame(video, thaw);
  }

  /**
   * ライブの速さを変える。**同じ値は入れ直さない** — `pacing` は寄せ終わっても 1 を返し続ける。
   * 変えたら数える (`rateChanges`。追っかけで選んだ速さは数えない)
   */
  function steerTo(video: HTMLVideoElement, next: number): void {
    if (video.playbackRate === next) return;
    video.playbackRate = next;
    if (!chasing) rateChanges++;
  }

  /**
   * 始めてよいか。貯まっただけでは始めない — いまの位置のフレームを出せる (`HAVE_CURRENT_DATA`) まで待たないと、
   * 前の局の静止画のまま新しい局の音が鳴る。映像の無い放送で音まで止めないよう、待ちきりにはしない (`START_WAIT`)。
   * 1枚目が少し止まって見えるのは直さない ([stream.md](../../docs/stream.md#新しい局の1枚目が少し止まるのは直さない))
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
   * 溜まりすぎを古いほうから刈る (止めている間も受け取り続けるので、放っておくと `QuotaExceededError` に着く)。
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
   * 捨てられたコマを足し上げる (`droppedSeen`)。**塊が届くたびに読む** (`pace`) — 飛ぶ直前までの
   * ぶんを、Safari が 0 に戻す前に拾う
   */
  function countDropped(video: HTMLVideoElement): void {
    const now = video.getVideoPlaybackQuality?.().droppedVideoFrames;
    if (now === undefined) return;
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
     * **途切れたら飛び直す** (`unslipAfter` の下の説明)。測れた遅れ (`slip`) を
     * 待たない — あれは見えないことがある。canvas で描く経路には要らない (映像は音の時計を追うだけ)
     */
    if (stalled && element !== null && !canvas) unslip(element);
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
   * 鳴らす。断られたら音を諦めて映像だけ出す (前回の局で勝手に始めるので、開いた直後は自動再生として断られる)
   */
  async function play(video: HTMLVideoElement): Promise<void> {
    video.muted = silenced;
    try {
      await video.play();
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

  /** 音を出す。**押されて呼ばれる** — ここまで来ればブラウザは断らない */
  function unmute(): void {
    silenced = false;
    engine?.unmute();
    if (element === null || canvas) return;
    element.muted = false;
    void element.play().catch(() => {
      /* 押したのに断られることはない */
    });
  }

  /** 音を止める。備え付けの操作を出さないので、こちらで用意する */
  function mute(): void {
    silenced = true;
    engine?.mute();
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
   * 覚えた下限を捨てて測り直す (経路が変わったときの出口)。高すぎる側に外れると 10分ごとに 0.3秒ずつしか
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
    quiet = Date.now() + GRACE;
    if (paused) toggle();
  }

  /**
   * 字幕の言語を選ぶ。**再エンコードしない** — サーバは載っている言語を全部デコードしていて、
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

  /** 繋がっていれば指示を送る */
  function send(command: Command): void {
    if (socket !== null && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(command));
  }

  /** 字幕を出す・消す。端末ごとに覚える (`caption-pref.ts`) */
  function setCaptions(on: boolean): void {
    captions = on;
    write(CAPTION_ON_KEY, on ? "1" : "0");
    if (element !== null) paint(element.currentTime);
  }

  /**
   * 字幕のストリームを選び直す。音声と同じで再エンコードになる — 字幕は映像と同じ ffmpeg でエンコードしている
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
    // 追っかけ再生 (`chase`) では常に選べる — 放送の今より先が無いのはライブだけ
    if (!chasing && chase === null) return;
    speed = next;
    if (element !== null) element.playbackRate = next;
  }

  /**
   * 持っている範囲の中で移る。シークバーを押されたとき。
   *
   * **後ろへ戻したら追っかけに入る。** 入れないと `pacing` が「大きく離れた」と
   * 見て放送の今へ跳ね返すので、戻した先が1秒も映らない
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
    quiet = Date.now() + GRACE;
  }

  /**
   * 追っかけのシーク。**二段構え。**
   *
   * 手元に残っている範囲なら `video.currentTime` を動かすだけ (一瞬)。
   * 外なら `chase` を送り直してサーバに ffmpeg ごと立て直させる — 元のTSに
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
        quiet = Date.now() + GRACE;
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
    buffer = null;
    source = null;
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
   * 受け取ったものを忘れる。**繋ぎはそのまま。**
   *
   * **待たせている字幕は必ず捨てる。** 再エンコードになれば mp4 の時刻は 0 から
   * 数え直しになるので、前の時刻で待たせているものは**どれも合わなくなる**
   * (音声やエンコード方式を選び直しただけでも再エンコードになる。`server/live.ts`)。
   *
   * @param keepList 選べる字幕の一覧は残すか。**同じ局の中での選び直しだけ
   *   true** — 局が変われば持っている字幕も変わる (字幕そのものが無い局もある)
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

  /** 画面を離れる。**貼ったフレームも剥がす** — 戻ってきたときに残っていては困る */
  function stop(): void {
    left = true;
    if (retry !== null) clearTimeout(retry);
    retry = null;
    stopResuming();
    reset();
    stopRaw();
    thaw();
    // 字幕を描く係も畳む (canvas の大きさの見張りを外す)
    painter?.close();
    painter = null;
  }

  /** 出せなかったことにする。**貼ったフレームは剥がす** — 動いて見えるほうが悪い */
  function fail(text: string): void {
    state = "error";
    message = text;
    attempts = 0;
    thaw();
  }

  /**
   * 待ってから繋ぎ直す (いちばん多いのはサーバの入れ替え)。待ちは倍々で `RETRY_MOST` まで。回数の上限は
   * 置かない — 点けっぱなしで戻ってきたときに映っていてほしい
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
    const wait = Math.min(RETRY_MOST, RETRY_FIRST * 2 ** attempts);
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
   * 音声を選び直す。繋ぎ直さずにリクエストし直す — サーバは音声ごとに別の ffmpeg を回すので MediaSource から
   * 作り直しになるが、チューナーはそのままで、前のフレームを貼っておくので黒くはならない
   */
  function setAudio(id: string): void {
    if (element === null || id === audio) return;
    // MPEG-2 では再エンコードしない。TS には全部の音声が入っている (`RawEngine.selectAudio`)
    if (raw && engine !== null && tuned !== null) {
      audio = id;
      tuned = { ...tuned, audio: id };
      remember(tuned);
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
   * エンコード方式を選び直す。音声と同じ扱い (`setAudio`)。受け取れない端末では `start` が H.264 に戻す
   */
  function setCodec(next: LiveCodec): void {
    // 互換モードで描けない形式は選ばせない (切り替えにも出さない。`unavailable`)
    if (unavailable().includes(next)) return;
    // 選び直したなら、前の断り書きは用済み。諦めていた互換モードも試し直す
    warning = "";
    compatGaveUp = false;
    // MPEG-2 からエンコードしたものへ。同じエンコード方式でもリクエストし直す (`swapCodec` は同じなら何もしない)
    if (rawChosen) {
      rawChosen = false;
      if (element !== null && tuned !== null) {
        void tune(element, { ...tuned, codec: next, raw: false }, true);
        return;
      }
    }
    swapCodec(next);
  }

  /**
   * MPEG-2 で見る (コーデックのメニューの末尾)。エンコード方式と同じく**この端末に覚える** (`LAST_COOKIE`)。
   * 前に諦めていても、選び直したなら試し直す
   */
  function setRaw(): void {
    if (rawChosen && raw) return;
    warning = "";
    rawGaveUp = false;
    if (element !== null && tuned !== null)
      void tune(element, { ...tuned, raw: true }, true);
  }

  /**
   * データ放送を出す・やめる (テレビの d ボタン)。
   *
   * **サーバはリクエストされてからデコードする。** 押すまでは1バイトも届かないかわりに、
   * 押してから出るまでカルーセルが一周するのを待つことになる
   * (`server/databroadcast.ts`)。
   */
  function setData(on: boolean): void {
    if (showData === on) return;
    showData = on;
    // 畳んだら、待たせてあるぶんも捨てる
    if (!on) heldData = [];
    socket?.send(JSON.stringify({ type: "data", on } satisfies Command));
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

  /** 中身。**断り書きを消さない**ので、戻すときにも使える */
  function swapCodec(next: LiveCodec): void {
    // 出せなかった後は、同じコーデックでもリクエストし直す (選び直すのが、やり直しの手段にもなる)
    if (element === null || (next === codec && state !== "error")) return;
    if (chase !== null) {
      codec = next;
      reopenChase();
      return;
    }
    if (tuned === null) return;
    // 局は変わらないので、選べる字幕の一覧はそのまま使える (`forget`)
    void tune(element, { ...tuned, codec: next }, true);
  }

  /**
   * 重ねるものの置き場を預かる。**画面が組み上がってから1回だけ。**
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
    painter = new CaptionPainter(subtitles, denpaFontUrl());
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
    tuned = target;
    audio = target.audio ?? "";
    codec = target.codec ?? "h264";
    // MPEG-2 で見るかは局を変えても引き継ぐ (エンコード方式と同じ)。覚えておくと次に開いたときサーバが先回りする (`warm`)
    rawChosen = target.raw ?? rawChosen;
    remember({ ...target, raw: rawChosen });
    await begin(video, keepList);
  }

  /**
   * 追っかけ再生を開く ([issue #16](https://github.com/danything/denpa/issues/16))。
   * **録画中の録画を、いま録れているところまで観る。** 再生の仕組みも繋ぎ方もライブと
   * 同じで、送る指示だけ違う (`chase`)。範囲の外へのシークもこれ —
   * サーバが ffmpeg ごと立て直す (選局し直しと同じ流儀)
   */
  async function openChase(
    video: HTMLVideoElement,
    recordingId: number,
    at = 0,
    keepList = false,
  ): Promise<void> {
    tuned = null;
    chase = { recordingId, base: Math.max(0, at) };
    chaseEnded = false;
    await begin(video, keepList);
  }

  /** 追っかけを再生していた位置から開き直す (再エンコード・繋ぎ直しのたび。通しの位置は分かる) */
  function reopenChase(): void {
    if (chase !== null && element !== null)
      void openChase(element, chase.recordingId, chase.base + position, true);
  }

  /**
   * 局を選ぶ (画面から)。**録画に譲っていたことは忘れる** — 選び直したのは本人で、
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
    // リクエストし直しで伸びた待ちは持ち越さない (追っかけが切れたら1秒から繋ぎ直す)
    attempts = 0;
    void openChase(element, recording.id, CHASE_EDGE);
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
   * いまリクエストしたいこと。**繋いだ直後と繋ぎ直しで同じものを送る** —
   * 中身を書き写していた頃は、足したものをどちらかへ足し忘れると
   * 「繋ぎ直したときだけ抜ける」という出方をした
   */
  function wantedCommand(): Command | null {
    if (chase !== null) {
      return {
        type: "chase",
        recordingId: chase.recordingId,
        at: chase.base,
        ...(audio === "" ? {} : { audio }),
        codec,
        caption: captionTrack,
        language: captionLanguage,
      };
    }
    if (tuned !== null)
      return {
        type: "tune",
        ...tuned,
        caption: captionTrack,
        language: captionLanguage,
        raw: wantsRaw(),
      };
    return null;
  }

  /**
   * MPEG-2 でリクエストするか。**MPEG-2 を選んでいて、デコードできて、まだ諦めていない**とき
   */
  function wantsRaw(): boolean {
    return rawChosen && rawProblem === null && !rawGaveUp;
  }

  /** 互換モードで描けない形式。**切り替えで選ばせない** (互換モードでなければ空) */
  function unavailable(): LiveCodec[] {
    const support = compatSupport;
    if (!compat || support === null) return [];
    return LIVE_CODECS.map((c) => c.id).filter((id) => !support[id]);
  }

  /**
   * 互換モードの支度 (`begin` の頭)。**入っていなければ何もしない。**
   *
   * 運転中の注意をまだ見せていなければ見せて、押されるまで待つ。描ける形式を調べ、選んでいる形式が
   * 描けなければ描けるほうへ寄せる (H.264 → AV1 → MPEG-2)。**`<video>` には戻らない** —
   * どれも描けなければ理由を出して false (リクエストしない)
   */
  async function prepareCompat(): Promise<boolean> {
    compat = canvasVideo();
    if (!compat) return true;
    if (!driveNoticeSeen() && options.confirm !== undefined)
      await options.confirm();
    compatSupport ??= await canvasSupport();
    if (rawProblem === undefined) rawProblem = await rawUnsupported();
    if (wantsRaw()) return true;
    const usable = (id: LiveCodec) =>
      !compatGaveUp && compatSupport?.[id] === true;
    if (usable(codec)) return true;
    const other = LIVE_CODECS.find((c) => usable(c.id));
    if (other !== undefined) {
      const before = LIVE_CODECS.find((c) => c.id === codec)?.label ?? codec;
      warning = `${before} を再生できないため、${other.label} に切り替えました`;
      codec = other.id;
      if (tuned !== null) {
        tuned = { ...tuned, codec };
        remember({ ...tuned, raw: rawChosen });
      }
      return true;
    }
    // エンコードしたものはどちらも描けない。MPEG-2 なら描ける (覚えはしない — 互換モードを切れば元に戻る)。
    // 追っかけに MPEG-2 は無い (サーバが変換せずには送らない)
    if (chase === null && rawProblem === null && !rawGaveUp && tuned !== null) {
      rawChosen = true;
      return true;
    }
    fail("再生できる形式がありません");
    return false;
  }

  /** 繋いでリクエストする。選局 (`tune`) と追っかけ (`openChase`) の共通の後半 */
  async function begin(
    video: HTMLVideoElement,
    keepList: boolean,
  ): Promise<void> {
    element = video;
    left = false;
    // リクエストし直すのはこれ。観終えるのを待っていたなら、もう待たない (`resumeChase`)
    stopResuming();
    /*
     * **MPEG-2 を選んでいるなら、デコードできるかを先に確かめる** (1回だけ。`raw/support.ts`)。
     * デコードできない端末では最初からエンコードしたものをリクエストし、理由を断り書きに出す
     */
    if (rawChosen && rawProblem === undefined) {
      rawProblem = await rawUnsupported();
    }
    // デコードできない端末では覚えておかない (開くたびに断り書きが出る)
    if (rawChosen && typeof rawProblem === "string") {
      rawChosen = false;
      if (tuned !== null) remember({ ...tuned, raw: false });
      warning = `MPEG-2 を再生できません: ${rawProblem}`;
    }
    if (!(await prepareCompat())) return;
    // 数え直す。再エンコードでもMediaSource から作り直しになるので、前の数は続きではない
    stalls = 0;
    // 字幕は映した1枚ごとに貼り直す (`follow`)。2度目からは何もしない
    follow(video);
    // 次のフレームが出るまで前のフレームを貼る。**閉じる前に写す** (閉じると何も映らなくなる)
    freeze();
    // 繋がっていれば繋ぎ直さない (1本に何度でも指示を送れる。`server/live.ts` の `attend`)
    const open = socket !== null && socket.readyState === WebSocket.OPEN;
    if (open) forget(keepList);
    else reset(keepList);

    state = "connecting";
    message = "";
    quiet = Date.now() + GRACE;

    if (open) {
      const command = wantedCommand();
      if (command !== null) send(command);
      return;
    }

    /*
     * **チケットを先に取る。** ブラウザは WebSocket の握手に `Authorization` を
     * 付けてくれないので、認証を通れることをここで示す (`tickets.ts`)
     */
    let ticket: string;
    try {
      const res = await fetch(resolve("api/live/ticket"), { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      ticket = ((await res.json()) as { ticket: string }).ticket;
    } catch {
      // 繋ぎ直しの最中なら、サーバがまだ帰っていないだけ。待ち直す
      if (attempts > 0) reconnect();
      else fail("繋がりませんでした");
      return;
    }

    const scheme = location.protocol === "https:" ? "wss" : "ws";
    // このエンドポイントは SvelteKit のルートではない (server.js が受ける) ので、型の付いた `resolve` に
    // パスごとは渡せない。頭 (`resolve('')` = 接頭辞 + `/`) だけ借りる
    const ws = new WebSocket(
      `${scheme}://${location.host}${resolve("")}${SOCKET_PATH.slice(1)}?ticket=${ticket}`,
    );
    ws.binaryType = "arraybuffer";
    socket = ws;

    ws.onopen = () => {
      // 繋がった。次に切れたときはまた1秒から待ち直す
      attempts = 0;
      const command = wantedCommand();
      if (command !== null) ws.send(JSON.stringify(command));
      // データ放送を出すかどうかはサーバでは繋ぎ (Viewer) に紐づいていて、切れると忘れられる
      if (showData)
        ws.send(JSON.stringify({ type: "data", on: true } satisfies Command));
    };

    ws.onerror = () => {
      // 繋ぎ直しの最中。すぐ後ろに `onclose` が来るので、そちらで待ち直す
      if (attempts > 0) return;
      if (state !== "playing") fail("繋がりませんでした");
    };

    // 切れたら繋ぎ直す (`reconnect`)
    ws.onclose = () => {
      if (socket !== ws || state === "error") return;
      socket = null;
      if (left || (tuned === null && chase === null) || element === null) {
        state = "idle";
        return;
      }
      reconnect();
    };

    ws.onmessage = (event) => {
      const data = event.data as ArrayBuffer;
      const kind = new DataView(data).getUint8(0);
      const body = new Uint8Array(data, 9);

      // 元の TS。写さずに worker へ移す (`RawEngine.feed`。頭の9バイトは多重化の頭)
      if (kind === CHANNEL.rawTs) {
        arrived();
        // 届く間隔は数えない (`arrive`)。元の TS はチューナーから読めたぶんずつ来るので、塊の間合いが決まっていない
        engine?.feed(data, 9);
        return;
      }

      if (kind === CHANNEL.control) {
        const notice = JSON.parse(new TextDecoder().decode(body)) as Notice;
        if (notice.type === "error") {
          // リクエストし直しても入れなかった。取り上げた録画か、「ライブに戻る」を試していたなら追っかけへ
          const to = returning ? (yielded?.recording ?? null) : fallback;
          if (to !== null && tuned !== null) giveWay(to, returning);
          else fail(notice.message);
        } else if (notice.type === "lost") {
          /*
           * チューナーから外された (録画に取り上げられた・エージェントとの繋ぎが切れた)。いつもの繋ぎ直しで
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
          // 字幕の本数も変わるかもしれない。無い番号を頼むと字幕ごと外されるので1本目に戻す
          if (chase === null) captionTrack = 0;
          if (chase !== null) resumeChase(!calm);
          else if (!calm) reconnect();
          else if (tuned !== null && element !== null)
            void tune(element, tuned, true);
        } else if (notice.type === "notice") {
          // 映像は出ている。断り書きに残す (GPU でエンコードできずにソフトウェアへ降りた、など)
          warning = notice.message;
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
        } else if (notice.type === "timeline") {
          /*
           * 追っかけの物差し。**base はサーバが決めた実際の開始位置に
           * 合わせ直す** — リクエストした位置は録れている範囲に収められることがある
           */
          if (chase !== null) chase = { ...chase, base: notice.at };
          chaseTimeline = {
            recordedSec: notice.recordedSec,
            totalSec: notice.totalSec,
            finished: notice.finished,
            since: Date.now(),
          };
        } else if (notice.type === "ended") {
          // 録れているところまで読み切った。流し残しが尽きたらMediaSource を閉じる
          chaseEnded = true;
          ending = true;
          finishStream();
        } else if (notice.type === "tuned") {
          // 選べる音声はここで初めて分かる (いま流れている番組次第)
          audios = notice.audios;
          audio = notice.audio;
          codec = notice.codec;
          if (notice.raw) startRaw(video);
          else if (compat) startCompat(video, notice.codec);
          else start(video, notice.codecs, notice.codec);
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
            // 追加中でなければ投げる。気にしない
          }
        }
      }
      // データ放送 (`ResponseMessage` の JSON)。受け取る側がまだ無いときは取っておく (`heldData`)
      if (kind === CHANNEL.data) {
        const message = JSON.parse(
          new TextDecoder().decode(body),
        ) as ResponseMessage;
        if (onData !== null) onData(message);
        // 出すつもりが無いなら取っておく意味も無い
        else if (showData && heldData.length < HOLD_DATA)
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
          // **足す前の貯まりが、次の塊が届く直前の低いところ** (`lows`)。間隔もここで測る
          if (element !== null) sampleLow(element);
          arrive();
          // 途中から入ったら、最初のキーフレームまでは渡さない (`ts/key-gate.ts`)
          if (!keyGate.pass(body)) return;
        }
        pending.push(body);
        drain();
        return;
      }

      /*
       * 字幕。文字の配置の JSON (`caption-text.ts`)。映像と同じ ffmpeg が付けた時刻に置く — 字幕のほうが先に
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
          return; // 壊れた1枚。次が来る
        }
        // 知らないバージョンは描かない (置き場所の読み方が違うかもしれない)
        if (page.v !== CAPTION_TEXT_VERSION) return;
        cues = insertCue(cues, { at, page });
      }
    };
  }

  /**
   * MediaSource を用意する (`codecs` はサーバが決めて送ってくる)。受け取れない形式なら、黒いままにせず
   * H.264 へ戻してそう言う
   */
  function start(
    video: HTMLVideoElement,
    codecs: string,
    baked: LiveCodec,
  ): void {
    // canvas で描いていたものからエンコードしたものへ戻るとき (諦めた・選び直した)。canvas を畳んで <video> を出す
    stopRaw();
    // iPhone の Safari には MediaSource が無く、ManagedMediaSource だけがある (`ts/media-source.ts`)
    const picked = pickMediaSource();
    if (picked === null || !picked.Source.isTypeSupported(codecs)) {
      if (baked !== "h264") {
        warning = "AV1 を再生できないため、H.264 に切り替えました";
        swapCodec("h264");
        return;
      }
      fail("再生できない形式です");
      return;
    }
    // 前の MediaSource の名残を落とす (音声の選び直しは繋ぎ直さないので `reset` を挟まない)
    clear();
    // エンコード方式が変われば太さも変わる。数え直す
    received = 0;
    receivedFrom = 0;
    const media = new picked.Source();
    source = media;
    /*
     * ManagedMediaSource は AirPlay を断らないと開かない (HLS は持っていない)。ほかの違い (送り込む頃合い・
     * ブラウザが捨てる) は手当てしない — ライブは待てず、`trim`・`pace` は毎回 `buffered` を読み直す
     */
    if (picked.managed) video.disableRemotePlayback = true;
    video.src = URL.createObjectURL(media);
    media.addEventListener(
      "sourceopen",
      () => {
        URL.revokeObjectURL(video.src);
        // 終わりが無いと言っておく。言わないと尺が届くたびに伸び、備え付けの再生位置が行き来する
        media.duration = Number.POSITIVE_INFINITY;
        buffer = media.addSourceBuffer(codecs);
        // 並べ直させない (`sequence` だと1つ取りこぼすと以降ずっと映像と音声がずれる)
        buffer.mode = "segments";
        buffer.addEventListener("updateend", () => {
          drain();
          pace(video);
        });
        /*
         * 1枚目が描かれてから前の局の静止画を剥がす (`play()` のあとだと貼ったまま音が鳴った)。待ち構えるのは
         * `loadedmetadata` から — `loadeddata` からでは1枚目を逃して、音より 54〜80ms 遅れて剥がれていた
         */
        video.addEventListener("loadedmetadata", () => onFrame(video, thaw), {
          once: true,
        });
        /*
         * 詰まったことを覚えて貯める量を決める (`nextTarget`)。同じ関数を渡す — `<video>` は同じものなので、
         * その場で作っていた頃は MediaSource を作り直すたびに聞き手が増え、1回の途切れを3回に数えていた
         */
        video.addEventListener("waiting", onWaiting);
        drain();
      },
      { once: true },
    );
  }

  /**
   * RawEngine を用意する (`tuned` で raw: true と答えられた)。**2度目からは作り直さず開き直すだけ** —
   * worker とデコーダの読み込み (500KB) を選局のたびにやり直さない
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
    if (compatSupport?.[baked] !== true) {
      const label = LIVE_CODECS.find((c) => c.id === baked)?.label ?? baked;
      fallBack(`${label} を再生できません`, "fmp4");
      return;
    }
    openEngine(video, "fmp4");
  }

  /**
   * RawEngine を開く。**同じものを受け取る RawEngine があれば作り直さず開き直すだけ**、違うもの
   * (MPEG-2 ⇔ エンコードしたもの) なら作り直す — 描く先の canvas の使い方が違う (WebGL2 ⇔ 2D)。
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
            shown: () => thaw(),
            stalled: onWaiting,
            gaveUp: (reason) => fallBack(reason, input),
            // ロック画面・車の操作で `<audio>` を直に止められた・再開された
            remote: (stop) => {
              if (stop !== paused) toggle();
            },
            // 追っかけで抱えきれなくなった。手元が尽きる前に再生している位置からリクエストし直す (`rawPace`)
            full: () => {
              starved = true;
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
   * canvas で描くのを諦める。**理由は断り書きに残す** (`warning`) — 黙って戻すと、設定を入れたのに効いて
   * いない理由が分からない。
   *
   * - MPEG-2 を諦めた … エンコードしたものに戻す。互換モードならエンコードしたものも canvas に描く
   *   (`prepareCompat`)。互換モードでエンコードしたものも描けなければ、理由を出して止まる
   * - 互換モードのエンコードしたものを諦めた … MPEG-2 で描けるならそちらへ、無理なら理由を出して止まる。
   *   **`<video>` には戻らない** (テスラでは止まってしまう)
   */
  function fallBack(reason: string, input: RawInput): void {
    stopRaw();
    if (input === "fmp4") {
      compatGaveUp = true;
      if (
        chase === null &&
        rawProblem === null &&
        !rawGaveUp &&
        element !== null &&
        tuned !== null
      ) {
        warning = `${reason}。MPEG-2 に切り替えました`;
        void tune(element, { ...tuned, raw: true }, true);
        return;
      }
      fail(reason);
      return;
    }
    rawGaveUp = true;
    if (
      compat &&
      (compatGaveUp || !LIVE_CODECS.some((c) => compatSupport?.[c.id] === true))
    ) {
      fail("MPEG-2 の再生を続けられませんでした");
      return;
    }
    warning = reason;
    if (element !== null && tuned !== null) void tune(element, tuned, true);
  }

  /**
   * canvas で描く経路の `pace`。**時計が音なので、`updateend` の代わりに刻みで回す。**
   * 貯まり・放送からの遅れ・字幕の貼り直し・貯める量の決め直しを、エンコードする経路と同じ形で出す
   */
  function rawPace(): void {
    if (engine === null) return;
    if (!running && engine.playing) {
      running = true;
      state = "playing";
      // 自動再生で断られた。**押すまで映像だけ進める** (壁時計。`RawEngine.blocked`)。
      // 音も消しておく — 他を押したついでに鳴りだすと、画面の「消音」と食い違う
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
      // 再生位置 (再エンコードの頭からの秒)。追っかけは base を足して通しで出す (`chasePosition`)
      if (tenth(at) !== position) position = tenth(at);
    }
    /*
     * **互換モードの追っかけで抱えきれなくなっていたら、手元が尽きる前に再生している位置からリクエストし直す**
     * (`RawEvents.full`)。サーバは倍速で送り込むので観ている先が伸び続け、worker は上限で
     * 受け取るのをやめている。読み直しの間 (1秒ほど) は前のフレームのまま止まる
     */
    if (chase !== null && starved && !paused && engine.lead < REFILL) {
      starved = false;
      reopenChase();
    }
    settle();
  }

  return {
    get state() {
      return state;
    },
    /** MPEG-2 で見ているか (エンコードしていない)。コーデックのメニューが MPEG-2 を指すか */
    get raw() {
      return raw;
    },
    /**
     * canvas で描いているか (放送のままの MPEG-2 か、互換モードのエンコードしたものか)。**操作列の出し分けに使う** —
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
    },
    /** canvas で描くとき、1コマデコードするのに掛かっている時間 (ms、95パーセンタイル)。canvas で描いていなければ 0 */
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
     * 覚えている下限 (秒)。**測り直すボタンを出すかどうかの判断に使う** —
     * 下限のままなら忘れるものが無い (`relearn`)
     */
    get remembered() {
      return floor;
    },
    /**
     * いま効いている下限 (秒)。覚えた下限 (`remembered`) と、届く間隔を覆う高さ (`cover`) の高いほう。
     * **不具合の報告に要る** — 止まった原因が届き方なのか、ほかなのかを切り分ける
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
    /** 選べる音声。1つしか無ければ切り替えを出さない */
    get audios() {
      return audios;
    },
    /** いま鳴らしている音声 (`AudioTrack.id`) */
    get audio() {
      return audio;
    },
    /** いまエンコードしてもらっているコーデック */
    get codec() {
      return codec;
    },
    /** リクエストされたとおりにできなかったときの断り書き。無ければ空 */
    get warning() {
      return warning;
    },
    setCodec,
    setRaw,
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
    listenData,
    /** 字幕を出しているか */
    get captions() {
      return captions;
    },
    /** 放送が字幕を持っているか。**1枚も届いていなくても分かる** */
    get hasCaptions() {
      return captionTracks.length > 0;
    },
    /** この番組に載っている Hybridcast (行き先。データ放送が起動を求めたら開く) */
    get hybridcast() {
      return hybridcast;
    },
    /** 選べる字幕。2本以上あれば画面は選び直しを出す */
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
    /** 追っかけの物差し。右端は送られた時点の値 — 録画中は画面が壁時計で伸ばす */
    get chaseTimeline() {
      return chaseTimeline;
    },
    /** 追っかけが録れているところまで読み切ったか */
    get chaseEnded() {
      return chaseEnded;
    },
  };
}
