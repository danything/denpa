/**
 * ライブ視聴。**チューナーを開いて、エンコードして、繋いでいる人に配る。**
 *
 *     エージェント (MPEG-TS) → ffmpeg (fMP4) → 割る → WebSocket → MSE
 *
 * [stream-history.md](../../../docs/stream-history.md#実装の順序) の1番目にあたる。**字幕も同じ
 * ffmpeg から写して受け、同じ WebSocket で一緒に送る** (`captions.ts`) — 別々に
 * 起こすと時刻が揃わないため。データ放送 (docs/stream.md#データ放送の統合) も同じ WebSocket で一緒に送る (`databroadcast.ts`)。
 *
 * ## 同じチャンネルは1本でエンコードする
 *
 * 2人が同じチャンネルを見ても、チューナーも ffmpeg も1つで足りる。
 * **数えているのは見ている人の数**で、0になったら畳む。エージェント側でも
 * 同じチャンネルは選局を共有するが、こちらで畳まないと ffmpeg が残り続ける。
 *
 * ## 途中から入ってきた人
 *
 * MSE は init セグメントを先に受け取らないと**中身を1バイトも読まない**ので、
 * 最後に流した init を持っておいて、繋いできた人に真っ先に渡す。
 */

import {
  type Ait,
  AitReader,
  APPLICATION_TYPE_HTML5,
  CONTROL,
} from "@danything/arib/ait";
import {
  CAPTION_TEXT_VERSION,
  type CaptionLanguage,
} from "@danything/arib/caption-text";
import { PresentFollowing } from "@danything/arib/eit";
import { PacketStream } from "@danything/arib/psi";
import { ServiceFilter, StreamsWatch } from "@danything/arib/service-filter";
import { and, eq, gt, lte } from "drizzle-orm";

import {
  type Audio,
  type AudioTrack,
  audioTracks,
  parseAudios,
  pickTrack,
} from "#lib/arib.js";
import {
  type CaptionTrack,
  CHANNEL,
  type HybridcastLink,
  type LiveCodec,
  type Notice,
} from "#lib/live.js";
import { BroadcastClock, parseStart } from "#lib/ts/clock.js";
import { Fmp4Splitter } from "#lib/ts/fmp4.js";
import { MkvSplitter } from "#lib/ts/mkv.js";
import { BUSY } from "#lib/ts/playback.js";

import {
  captionFeed,
  type CaptionOut,
  captionOutput,
  type CaptionShown,
  CaptionText,
  NO_SUBTITLE,
  programSpec,
  rawCaptionArgs,
  textFrame,
  TrackList,
  worthLogging,
} from "./captions";
import {
  chasePlan,
  type ChaseResume,
  fileSize,
  followFile,
  resumeFrom,
  resumePlan,
} from "./chase";
import { config } from "./config";
import { DataBroadcast, type ResponseMessage } from "./databroadcast";
import { orm } from "./db";
import { deinterlace } from "./encoder";
import { followOnAir } from "./epg";
import { emit, type Yielded } from "./events";
import { type LiveHw, liveHw, liveHwArgs } from "./hwenc";
import { tunerOf, yieldedTo } from "./live-yield";
import { programs, recordings, services } from "./schema";
import { settings } from "./settings";
import { chunks, endInput, lines } from "./stream";
import { holdTranscode } from "./transcode";
import { getTuners, openWhenFree, type StreamUse } from "./tuner";
import type { Connection } from "./ws";

/**
 * セッションのエンコード方式。画面が選ぶのは LiveCodec だけで、`audio` は外から使う API
 * (`/api/services/<id>/live?audio=only`) の**音声だけ**。映像も字幕もエンコードせず、AAC の fMP4 を出す
 */
type StreamCodec = LiveCodec | "audio";

/**
 * エンコード方式。**方式は見ている人が選ぶ** (`LiveCodec`)。
 *
 * H.264 と AV1 で共通なのはここ。それぞれの中身は `videoArgs` / `audioArgs`。
 *
 * - `-fflags nobuffer` … 読む側で溜めない
 * - `-probesize` … **開いてから映像が出るまでの待ちの、削れる部分。**
 *   渡す前に1局へ絞ってあるが、**字幕まで見つけさせる**ので 100KB 採る
 *   (下の「局を名指しで選ぶ」に実測)
 * - `-frag_duration` … 0.05秒ぶんずつ moof/mdat を出す。既定では ffmpeg が
 *   数秒溜めてから出すので、その場でライブでなくなる
 * - `-copyts` は**付けない**。付けると放送の絶対時刻が mp4 の muxerまで届き、
 *   あれが 0 に詰め直すので受け側から見た 0 の意味が分からなくなる。
 *   付けないと ffmpeg が入口で1回だけ 0 に寄せ、**その寄せが字幕の出口にも
 *   同じだけ効く** — 映像と字幕が同じ物差しに乗る (`captions.ts` に実測)
 *
 * ## コマごとに切らない
 *
 * `frag_every_frame` にすると、**映像だけ・音声だけの塊が交互に並ぶ**。
 * mp4 の多重化はトラックごとにコマの来る間隔が違うためで、受け側の MSE は
 * その1つ1つを別の区切りとして扱う。結果、映像と音声が別々に並べ直されて、
 * 映像は絶えず引っかかり、音はずれる。時間で切れば1つの塊に両方入る。
 *
 * **どこまで細かくできるかは音声のコマが決める。** AAC は 1024 標本 = 48kHz で
 * 約 21ms、Opus は 20ms なので、どちらでも同じところに下限がある。それより
 * 短く切ると音声の入らない塊が出る。実機で数えた
 * 「塊あたりのトラック数」(2.00 が両方入っている状態):
 *
 *     0.20秒 → 毎秒 6個  1.93      0.05秒 → 毎秒 21個  1.94
 *     0.10秒 → 毎秒 11個 1.93      0.033秒→ 毎秒 32個  1.94
 *                                  0.016秒→ 毎秒 64個  1.74 ← 崩れる
 *
 * 0.05秒を採る。0.033秒でも保つが、音声のコマ (21ms) に近すぎる。
 *
 * ## `-flags low_delay` は付けない
 *
 * `-i` より前に書くと**エンコーダではなくデコーダに効く**。放送の MPEG-2 には
 * B フレームがあるので、この指定を受けたデコーダは表示順ではなく**復号順**で
 * フレームを出す。結果、1枚進んでは戻るように見える。
 *
 * 実測 (NHK総合の高校野球・本物の 60i): 隣り合うコマの差が交互に大小し、
 * その比は 2.17。外すと 1.11 に落ち、元の素材のフィールドを直に測った
 * 値 (1.02) に並ぶ。エンコーダ側の遅れは `-tune zerolatency` が見ている。
 *
 * **インタレ解除は録画と同じフィルタで行う** (`encoder.deinterlace`)。放送は 1080i
 * なので、デコードせずにブラウザへ渡すと動きのある場面が櫛状になる。録画と違って
 * コマ数はいつも倍にする (下の `-vf` の説明)。
 *
 * ## 字幕も同じ ffmpeg から受ける。**出口を2つ持つ**
 *
 * 映像は `pipe:1` に fMP4、字幕は `pipe:3` に Matroska (デコードせずに写したもの。
 * [captions.ts](captions.ts) の `captionOutput`)。**時刻を揃えるにはこうするしか
 * なかった** — 理由と実測、引き換え (選び直すと字幕も再エンコード) は captions.ts の冒頭。
 *
 * **`-loglevel` は下げない。** 選べる字幕は入口の見出しから読み取っていて
 * (`TrackList`)、あれは info で出る。騒がしいぶんは読む側で落とす (`watch`)。
 * 数字の進み具合だけは要らないので `-nostats` で止める。
 *
 * ## 局を名指しで選ぶ。**渡す前にも絞る**
 *
 * **1つの物理チャンネルに複数の局が入っている。** `0:v:0` は「最初に見つけた
 * 映像」でしかないので、MX2 を選んでも MX1 の映像が出うる。実機の T26 を調べると
 * 局が4つ (Eテレ1/2/3 と**ワンセグ**) 並んでいて、ワンセグは 320x180 の H.264 —
 * それを選んでしまうこともある。`0:p:<局>:v:0` なら選んだ局の中から選ぶ。
 *
 * **名指しだけでは足りない。** ffmpeg はその局を `-probesize` のぶん読む間に
 * 見つけられなければ、**そのまま終了する**。実機の tvk (T15) は tvk1/2/3 +
 * ワンセグ + データで、局ごとに14本以上のストリームがあり、400KB では
 * 読み切れずに降りていた:
 *
 *     Failed to set value '0:p:24632:v:0' for option 'map': Invalid argument
 *
 * わざと probesize を下げて、その T15 で測ったもの (3回ずつ):
 *
 *     probesize  20KB   丸ごと 0/3 通る    1局に絞る 3/3
 *     probesize  50KB   丸ごと 0/3 通る    1局に絞る 3/3
 *     probesize 120KB   丸ごと 1/3 通る    1局に絞る 3/3
 *     probesize 400KB   丸ごと 3/3 通る    1局に絞る 3/3
 *
 * **渡す前に1局へ絞れば 20KB でも通る。** 録画と同じ `ServiceFilter` を通すだけで、
 * ffmpeg が受け取るのは局が1つだけの TS になる。局を探す仕事が消える。
 *
 * 映像だけをエンコードしていた頃は 20KB まで下げてあった。6回ずつ測った差:
 *
 *     100KB   最短 474ms  中央 839ms  (6/6 通る)
 *      20KB   最短 441ms  中央 752ms  (6/6 通る)
 *
 * **中央値の差はばらつき** (放送の GOP 待ち 0〜501ms) で、**最短どうしの
 * 33ms が固定の費用**。いまは 100KB に戻してある — **字幕まで見つけさせる**
 * ので、映像だけのときの値では足りない (字幕だけを別の ffmpeg で取っていた
 * 頃も 100KB を使っていた)。33ms は、字幕が丸ごと出ないことと引き換えにできる
 * 額ではない
 *
 * 名指し (`0:p:<局>`) はそのまま残す。絞ったものに万一違う局が入っていたら、
 * **黙って別の局を映すより、そこで落ちるほうがいい**。
 *
 * ## 多重音声
 *
 * 「多重音声」と呼ばれるものは2通りある。**どちらも、エンコードするときに1本へ決める。**
 *
 * - **デュアルモノ** … 音声は1本で、左に主音声・右に副音声 (ARIB STD-B32)。
 *   そのままステレオにすると両方同時に鳴るので、選ばれた側を両耳へ配り直す
 *   (`pan`)。**録画と同じ見分け方** (`arib.ts` の `DUAL_MONO`)。録画は左右を
 *   2トラックに分けるが、こちらは出す音声トラックが1つなので片方を採る
 * - **複数の音声** … 音声そのものが2本以上入っている (解説放送など)。
 *   `-map` で何本目かを名指しする
 *
 * 選べるものを組み立てるのは `arib.audioTracks`。**画面には平らな一覧に見せる** —
 * 見ている人にとってはどちらも「音声を選ぶ」1つの操作でしかない。
 *
 * @param program 放送が名乗っている番号 (`NowPlaying.program`)。0以下なら
 *   最初に見つけた映像 (従来どおり)
 * @param audio どの音声を、どちら側で出すか
 * @param caption 何本目の字幕を出すか。**null なら字幕の出口を付けない** —
 *   字幕を持たない放送で字幕を求めると ffmpeg は組み立ての時点で降りるので、
 *   そうと分かったらこちらで再エンコードする (`Session.run`)
 * @param hw GPU でエンコードするならその経路 (`hwenc.liveHw`)。null ならソフトウェア (`videoArgs`)
 */
export function encodeArgs(
  program: number,
  audio: AudioTrack,
  codec: StreamCodec = "h264",
  caption: number | null = 0,
  hw: LiveHw | null = null,
): string[] {
  const picture = codec === "audio" ? null : videoArgs(codec, hw);
  const from = programSpec(program);
  return [
    "-hide_banner",
    // 数字の進み具合だけ止める。`-loglevel` は下げられない (上の説明)
    "-nostats",
    "-fflags",
    "nobuffer",
    // 1局に絞ってあるが、字幕まで見つけさせるぶん要る (上の説明)
    "-probesize",
    "100000",
    // GPU デバイスを開く。復号から GPU なら `-hwaccel` もここ (入力より前でないと効かない)
    ...(picture?.input ?? []),
    "-i",
    "pipe:0",
    // 音声だけなら映像はエンコードしない (StreamCodec)
    ...(picture !== null
      ? [
          /*
           * インタレ解除 (上の説明)。**ライブは常に60コマ。** 録画は本編映像から実測して
           * 30に落とすことがあるが (`encoder.measureSmoothMotion`)、ライブは映像が来る前に
           * 決めないといけない。60 に倒しておけば動きは絶対に落ちない (アニメで無駄が出るだけ)
           */
          "-vf",
          picture.filter,
          "-map",
          `${from}:v:0`,
          /*
           * **コマ数の上限を言っておく。**
           *
           * `-probesize` を大きくは取らないので、ffmpeg は入口でコマ数を読み切れず、
           * 時間の刻み (90kHz) から**でたらめな値**を起こすことがある。x264 は黙って
           * 受けるが、**SVT-AV1 は突っぱねる**:
           *
           *     Svt[error]: Instance 1: The maximum allowed frame rate is 240 fps
           *     [libsvtav1] Error setting encoder parameters: bad parameter
           *
           * 実機で probesize を 20KB まで下げて AV1 を選ぶと 0/3、この上限を付けると 3/3 通った。
           *
           * **固定 (`-r`) ではなく上限 (`-fpsmax`) にする。** 固定すると、放送が
           * 本当に 59.94p だったとき (720p の局) にコマを落とす。上限なら、
           * まともな値のときは何も起きず、でたらめな値のときだけ抑える。
           *
           * 値はインタレ解除の出方そのまま — 29.97 のインタレのフィールドを
           * 起こすので 59.94
           */
          "-fpsmax",
          "60000/1001",
          ...picture.encoder,
        ]
      : []),
    // 何本目の音声か。複数入っている放送では 0 が主とは限らない
    "-map",
    `${from}:a:${audio.stream}`,
    ...panArgs(audio),
    ...audioArgs(codec),
    "-f",
    "mp4",
    "-movflags",
    "+empty_moov+default_base_moof",
    // 0.05秒ぶんずつ。これ以上細かくすると音声の入らない塊が出る (上の説明)
    "-frag_duration",
    "50000",
    "-flush_packets",
    "1",
    "pipe:1",
    // **2つ目の出口。** 字幕をそのまま、映像と同じ物差しの時刻付きで出す
    ...(caption === null || picture === null
      ? []
      : captionOutput(from, caption)),
  ];
}

/** デュアルモノは片側だけを両耳へ。そのままだと左右から別の言語が同時に鳴る */
export function panArgs(audio: AudioTrack): string[] {
  if (audio.side === "main") return ["-af", "pan=stereo|c0=c0|c1=c0"];
  if (audio.side === "sub") return ["-af", "pan=stereo|c0=c1|c1=c1"];
  return [];
}

/**
 * 映像のエンコード方式。**見ている人が選べる** (`LiveCodec`)。
 *
 * ## H.264
 *
 * `-tune zerolatency` で B フレームを作らない (作ると必ず遅れる)。
 * **どの端末でも出る**ので既定。
 *
 * ## AV1
 *
 * 設計 (stream.md#前提) が最初から狙っていた方式。実機は HW エンコーダを持たない
 * (`ffmpeg -hwaccels` が空) が、**44スレッドあるので間に合う**。同じ電波を
 * 40秒ずつ通した実測 (1080i をデコードして60コマ/秒):
 *
 *     x264 veryfast   1バイト目 729ms   エンコードできた尺 38.5秒/41秒
 *     AV1 preset 12   1バイト目 1177ms  エンコードできた尺 39.1秒/41秒
 *
 * **確かなのは「落ちこぼれない」ことだけ** (エンコードできた尺が実時間に付いていっている)。
 * 立ち上がりは 0.45 秒ぶん遅い。
 *
 * **量は中身次第で、まだ何とも言えない。** どちらも品質を指定してエンコードしている
 * (ビットレートを決めていない) ので、出てくる量は場面で動く。実測も揃わなかった:
 *
 *     ある40秒   x264 3.3 Mbit/s   AV1 2.8 Mbit/s   ← AV1 が 15% 小さい
 *     別の25秒   x264 11.6 Mbit/s  AV1 11.4 Mbit/s  ← ほぼ同じ
 *
 * 音声は Opus に替える (`audioArgs`)。
 *
 * `lookahead=0` が要る。SVT-AV1 は既定で先を読むぶん貯めるので、付けないと
 * その貯めがそのまま遅れになる。preset は 12 — これより速い 13 はもう
 * 目に見えて粗く、遅い 10 は間に合わなくなる。
 *
 * **付けてもまだ溜め込む。** 電波が届いてから塊が出るまで H.264 の 0.24〜0.49秒
 * に対し **1.1〜1.5秒**。低遅延指定 (`pred-struct=1`) は
 * 実時間に間に合わなくなるので使えない。**AV1 を選ぶと放送の今から1秒ぶん
 * 離れる** (切り替えの画面には出していない)。
 *
 * ## GPU
 *
 * 設定でそのコーデックのエンコーダに GPU を選んであれば、**録画と同じ GPU でエンコードする**
 * (`hwenc.liveHw`。低遅延の引数とインタレ解除まで GPU に寄せる話は `hwenc.liveHwArgs`)。
 * 非力な機材 (Celeron J4125) では x264 ultrafast で2本目から追いつかなくなるため (issue #417)。
 * GPU が映像を1つも出さずに降りたら、ソフトウェアで再エンコードする (`Session.run`)
 *
 * ## 録画をその場で変換するときも同じエンコード方法
 *
 * `/api/recordings/<id>/stream` (`server/playback.ts`) もここを使う。元がエンコード済み
 * (インタレ解除が済んでいる) なら `interlaced` を false にする — インタレ解除を挟まず、
 * GPU も復号からは載せない (`full` は放送の MPEG-2 を GPU でデコードする経路)
 *
 * @returns `input` は `-i` より前、`filter` は `-vf` (無ければ空)、`encoder` は `-c:v` から
 */
export function videoArgs(
  codec: LiveCodec,
  hw: LiveHw | null,
  interlaced = true,
): { input: string[]; filter: string; encoder: string[] } {
  if (hw !== null) {
    const gpu = liveHwArgs(interlaced ? hw : { ...hw, full: false }, codec);
    return {
      input: gpu.input,
      // 復号から GPU なら CPU のインタレ解除は挟まない (挟むとフレームを降ろすことになる)
      filter: (hw.full && interlaced
        ? gpu.filter
        : [...(interlaced ? [deinterlace(true)] : []), ...gpu.filter]
      ).join(","),
      // -g はソフトウェアと揃える。合流の待ちはキーフレームの間隔で決まる
      encoder: ["-c:v", ...gpu.encoder, "-g", "60"],
    };
  }
  return {
    input: [],
    filter: interlaced ? deinterlace(true) : "",
    encoder: softwareArgs(codec),
  };
}

/** ソフトウェアでエンコードするときの `-c:v` から (上の説明) */
function softwareArgs(codec: LiveCodec): string[] {
  if (codec === "av1") {
    // -g は H.264 と揃える。合流の待ちはキーフレームの間隔で決まる
    return [
      "-c:v",
      "libsvtav1",
      "-preset",
      "12",
      "-g",
      "60",
      "-svtav1-params",
      "lookahead=0",
    ];
  }
  /*
   * **H.264 は量を捨てて速さを採る。** AV1 と役割を分けてある — あちらが
   * 「小さく」、こちらが「速く」。
   *
   * `ultrafast` は x264 がいちばん手を抜く設定。**画質は据え置き** (`-crf` を
   * 付けない = 既定の 23) なので、**出てくる映像は今までと同じ**で、量だけ増える。
   *
   * 実機で6回ずつ測ったもの。ばらつきは放送の GOP 待ち (0〜501ms) なので、
   * **短いほうの2つ**を見る:
   *
   *     veryfast  既定      最短 438ms  2番目 535ms   2.5 Mbit/s  ← 前
   *     ultrafast 既定      最短 386ms  2番目 429ms   8.2 Mbit/s  ← これ
   *     ultrafast crf 20    最短 524ms  2番目 584ms  10.7 Mbit/s
   *     ultrafast crf 18    最短 478ms  2番目 511ms  14.6 Mbit/s
   *     superfast crf 18    最短 599ms  2番目 615ms   8.6 Mbit/s
   *
   * **画質を上げると必ず遅くなる。** 最初の1枚が太り、書き出すのに時間が
   * かかるため — `crf 14` は 35.9 Mbit/s で最短 586ms、本当の無劣化 (`-qp 0`)
   * に至っては 235.7 Mbit/s で 643ms だった。**速さが目的なら上げてはいけない。**
   *
   * ## 山は抑えない (`-maxrate` を付けない)
   *
   * 上の 8.2 Mbit/s は**動きの少ない場面での値**で、高校野球の中継を25分
   * 受けたときの平均は 14.5 Mbit/s だった (素の WebSocket で 2.3GB)。
   * `-maxrate 8M -bufsize 8M` を入れれば 8.4 Mbit/s まで削れる。**入れていない。**
   *
   * **ライブは宅内で見るもの**という前提で決めている。宅内なら帯域は余って
   * いて、削って得るものが無い一方、**削るのは動きの多い場面の映像**で、
   * いちばん要るところが荒れる。宅外や細い経路のためには **AV1 を選ぶ方法が
   * ある** (`LIVE_CODECS`) — あちらは削るのではなく、同じ映像を小さく詰める。
   *
   * **一度入れて、外して、戻して、また外した。** 「一瞬止まって遅延が増えて
   * いく」を流量の話だと見立てて入れたが、原因は受け側の貯め方だった
   * ([stream.md](../../../docs/stream.md#一瞬止まって遅延が増えていく))。そのあと実機で「映像だけ遅れる」が
   * 出たので流量を疑って戻したが、そちらは**復号**の話で
   * (`live-player.svelte.ts` の `unslip`)、やはり山とは関係が無かった。
   * **2回とも、症状から流量を疑ったのが外れている**
   */
  return [
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-g",
    "60",
  ];
}

/**
 * 音声のエンコード方式。**AV1 と組むときは Opus。**
 *
 * 設計 (stream.md#前提) が狙っていた組み合わせで、**録画と同じ扱い**でもある
 * (`encoder.ts` は前から `libopus -b:a 256k`)。同じ音質なら AAC より小さく、
 * ブラウザは MSE で受け取れる (Chromium で `av01…,opus` を確かめ済み)。
 *
 * **256k は放送に合わせた値。** 元の放送が AAC 256kbps なので、録画側は
 * そこへ揃えてある。ライブだけ 192k で低かったのを、こちらへ寄せる。
 *
 * H.264 は AAC のまま。**どの端末でも出る**ほうを既定にしている以上、
 * 音声まで新しいものに替える理由が無い。
 *
 * どちらも 2ch に落とす。デュアルモノの配り直し (`-af pan=…`) はこの手前で
 * 効いているので、ここへ来るのは既に「出したい音」1本ぶん
 */
export function audioArgs(codec: StreamCodec): string[] {
  return codec === "av1"
    ? ["-c:a", "libopus", "-b:a", "256k", "-ac", "2"]
    : ["-c:a", "aac", "-b:a", "256k", "-ac", "2"];
}

/**
 * ブラウザに渡す codecs 文字列。**MSE はこれが合っていないと受け取らない。**
 *
 * 中身から起こすのが本筋だが (moov を読めば分かる)、エンコード方式はこちらで決めて
 * いるので、その組に対応する値を返す。
 *
 * - `avc1.640029` … High profile / Level 4.1。1080p60 まで
 * - `av01.0.08M.08` … Main profile / Level 4.0 / 8bit。同じく 1080p60 まで
 *
 * **音声も組で決まる** (`audioArgs`)。AV1 は Opus、H.264 は AAC
 */
export function codecsFor(codec: LiveCodec): string {
  return codec === "av1"
    ? 'video/mp4; codecs="av01.0.08M.08,opus"'
    : 'video/mp4; codecs="avc1.640029,mp4a.40.2"';
}

/**
 * 「放送休止」と読める番組名。
 *
 * 番組表がそう言っている局は、**電波そのものを止めていることがある**。
 * 実機の NHK総合 (T27) は保守の晩に停波していて、その間の選局は必ず
 * 同期しない — 同じ NHK でも Eテレ (T26) は休止中も搬送波を出したままで、
 * 一度も同期に失敗していない (48時間の記録)
 */
const RESTING = /休止|停波|放送終了/;

/**
 * いま放送休止なら、明ける時刻 (ms)。そうでなければ null。
 *
 * **番組表が言っていることしか見ない。** 電波の有無は測れないので、
 * 使えなかったときの言い換えにだけ使う (`whyNotTuned`)
 */
function resting(serviceId: number): number | null {
  if (!Number.isFinite(serviceId)) return null;
  const program = orm()
    .select({ name: programs.name, end_at: programs.end_at })
    .from(programs)
    .where(airingAt(serviceId))
    .get();
  if (program === undefined || !RESTING.test(program.name)) return null;
  return program.end_at;
}

/**
 * 使えなかったことを、**画面に出す言葉にする。**
 *
 * エージェントの言い分 (「電波が来ていないか、その周波数に放送がありません」) は
 * 言い切りとしては正しいが、**アンテナや配線を疑う文面**になる。放送そのものが
 * 止まっているだけのときは、そうと言えるほうがいい — denpa は番組表を持っていて、
 * エージェントは持っていないので、言い換えられるのはこちらだけ。
 *
 * **言い換えるのは「同期しなかった」ときだけ。** チューナーが塞がっていたときや
 * ffmpeg が降りたときに「放送休止です」と出すと、今度はこちらが嘘をつく
 *
 * @param why エージェントから返ってきた理由
 * @param until 放送休止が明ける時刻 (ms)。休止でなければ null
 */
export function whyNotTuned(why: string, until: number | null): string {
  if (until === null || !why.includes("同期しませんでした"))
    return "選局できませんでした";
  // コンテナの時計は Asia/Tokyo (`server/library.ts`)
  const clock = new Date(until).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `いまは放送休止です (${clock} まで)`;
}

interface Viewer {
  /** 送り先。WebSocket の視聴者は Connection、HTTP の視聴者 (liveStream) は映像だけを流すエンドポイント */
  connection: Pick<Connection, "send">;
  /** init を渡したか。渡す前に中身を送っても MSE は捨てる */
  ready: boolean;
  /** データ放送を出しているか。**求めた人にだけ配る** */
  wantsData: boolean;
  /**
   * **脇から字幕だけ受け取っている** (アプリ向けの字幕のエンドポイント。`liveCaptions`)。
   * いても畳む判断には数えない — 映像を観ている人がいなくなったら、字幕のためだけに
   * チューナーを使い続けない。畳んだら `ended` を伝えて閉じさせる
   */
  side?: boolean;
  /** 字幕の第何言語を出すか (1〜8)。省けば第1言語。**その人の選んだもの**で、局を変えても続く */
  language?: number;
}

/**
 * 字幕を持っていないと分かった局。**同じ間違いを繰り返さないため。**
 *
 * 字幕を出させた ffmpeg は、その放送に字幕が無いと**組み立ての時点で降りる** —
 * 映像も出ない。1回目は字幕なしで再エンコードして繋ぐが (`Session.run`)、覚えて
 * おかないと選局のたびに 2回起こすことになる。
 *
 * **番組が変われば付くことがある**ので、しばらくしたら忘れる
 */
const captionless = new Map<number, number>();
/** `captionless`・`gpuFailed` を忘れるまで (ms)。番組の変わり目より短く採る */
const FORGET = 15 * 60_000;

/** 覚えてから `FORGET` が過ぎていないか */
function remembered<K>(memo: Map<K, number>, key: K): boolean {
  const at = memo.get(key);
  return at !== undefined && Date.now() - at < FORGET;
}

/**
 * GPU でライブをエンコードできなかった経路と、その時刻。**しばらくはソフトウェアでエンコードする** (`pickLiveHw`)。
 *
 * 落ちる GPU は選局のたびに落ちるので、覚えておかないと毎回「GPU で起こして降りて
 * 再エンコードする」ぶん待たせ、毎回断り書きを出すことになる。ドライバや素材が変われば
 * 通ることもあるので、字幕と同じくしばらくしたら忘れる
 */
const gpuFailed = new Map<string, number>();
/** GPU デバイスを使う順番。録画と同じく、セッションごとに先頭のデバイスを入れ替える (`hwenc.hwChain`) */
let liveTurn = 0;

/** GPU からソフトウェアに降りたときに画面へ出す一行 */
const GPU_GAVE_UP =
  "GPU でエンコードできないため、ソフトウェアでエンコードしています";

function hwKey(codec: StreamCodec, hw: LiveHw): string {
  return `${codec}:${hw.way.device}:${hw.way.kind}:${hw.full}`;
}

/**
 * このセッションを GPU でエンコードするか。設定の印と試しのエンコード (`hwenc.liveHw`)、最近落ちたか。
 * 録画のその場の変換 (`server/playback.ts`) も使う — 元がエンコード済みなら `interlaced` を false
 * (復号からは GPU に載せない。`videoArgs`)
 */
export function pickLiveHw(codec: LiveCodec, interlaced = true): LiveHw | null {
  const found = liveHw(codec, settings().hwAllow, liveTurn++);
  if (found === null) return null;
  const hw = interlaced ? found : { ...found, full: false };
  return remembered(gpuFailed, hwKey(codec, hw)) ? null : hw;
}

/** GPU でエンコードできなかった経路を覚える。しばらくは `pickLiveHw` がソフトウェアを返す */
export function blameLiveHw(codec: StreamCodec, hw: LiveHw): void {
  gpuFailed.set(hwKey(codec, hw), Date.now());
}

/** 放送の実時刻を配り直す間隔 (ms)。配り続ける理由は `Session.tellClock` */
const CLOCK_EVERY = 5_000;

/**
 * 放送の「いま・次」を、変わっていなくても番組表と突き合わせ直す間隔 (ms。`Session.tap`)。
 *
 * **番組表を集め直すと、写した p/f が予定の時刻で上書きされることがある** (同じ番組を
 * schedule が後から運んでくる)。p/f が次に変わるのを待つと、延長の間ずっと予定に戻ったままになる。
 * 突き合わせは番組2つぶんの主キー引きで、違っていなければ何も書かない
 */
const ON_AIR_EVERY = 60_000;

/** 通知・データ放送は JSON にして運ぶ */
function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * 出す字幕の言語。**選んだ言語が載っていなければ第1言語** — 前の番組で英語を選んだまま、英語の無い局へ
 * 移ったときに何も出なくならないように (画面は通知を見て選び直す)
 */
function pickLanguage(languages: CaptionLanguage[], wanted: number): number {
  return languages.length === 0 || languages.some((l) => l.index === wanted)
    ? wanted
    : 1;
}

/**
 * 選べる字幕の通知。**言語は受け取る人に出しているもの**なので、全員に同じものは送れない。
 * 言語がまだ分からない (字幕管理データが届いていない) ときは `languages` を省く
 */
function captionsNotice(
  tracks: CaptionTrack[],
  track: number,
  languages: CaptionLanguage[],
  language: number,
): Notice {
  return {
    type: "captions",
    tracks,
    track,
    ...(languages.length === 0 ? {} : { languages, language }),
  };
}

/**
 * 字幕だけを写す ffmpeg を起こす (`rawCaptionArgs`)。字幕は4本目のパイプに出る。
 * 標準出力には何も出さないはずだが、**汲まずに放っておくと詰まったときに止まる**ので読み捨てる
 */
function spawnCaptioner(
  program: number,
  track: number,
): ReturnType<typeof Bun.spawn> {
  const proc = Bun.spawn([config.ffmpeg, ...rawCaptionArgs(program, track)], {
    stdio: ["pipe", "pipe", "pipe", "pipe"] as never,
  });
  void (async () => {
    for await (const _ of chunks(proc.stdout as ReadableStream<Uint8Array>)) {
      // 読み捨てる
    }
  })().catch(() => undefined);
  return proc;
}

class Session {
  private readonly viewers = new Set<Viewer>();
  /**
   * 放送の時計 (PCR) を、受け取った時刻と組にする ([ts/clock.ts](../ts/clock.ts))。
   *
   * **データ放送と違って、いつでも読みます。** 誰も見ていなくても1局ぶんの
   * TS は流れているし、読むのは PCR だけで安い。**受け取った時刻で組にする**
   * ので、ここより手前で溜めると、そのぶん遅れて見える
   */
  private readonly clock = new BroadcastClock();
  /** 絞ったあとを 188 バイトに切るもの。データ放送・時計・Hybridcast で分け合う (`tap`) */
  private readonly packets = new PacketStream();
  /** ffmpeg が入口で 0 に寄せたぶん (秒)。`start:` から読み取る */
  private startPts = Number.NaN;
  /** 最後に時計を配った時刻 (`tellClock`) */
  private toldClockAt = 0;
  /**
   * いまの ffmpeg が映像の中身 (init の次の塊) を1つでも出したか。
   * **GPU から降りてよいのは出す前だけ** (`run`) — 出したあとで落ちたのは GPU のせいとは限らない
   */
  private produced = false;
  /**
   * GPU からソフトウェアに降りたときの断り書き。**途中から入ってきた人にも渡す** (`add`)
   */
  private note: Notice | null = null;
  /**
   * ソフトウェアで再エンコードしている GPU の経路 (`hwKey`)。**ソフトウェアで映像が出たら**
   * GPU のせいだったと決めて覚え、断り書きを出す (`blameGpu`)
   */
  private blame: string | null = null;
  /** 選べる字幕 (ffmpeg の入口の見出しから)。放送そのままの経路で字幕の ffmpeg を起こし直したら作り直す (`captions`) */
  private list: TrackList;
  private readonly aborter = new AbortController();
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  /** 最後に流した init。途中から入ってきた人に真っ先に渡す */
  private init: Uint8Array | null = null;
  /**
   * いま出ている字幕。**途中から入ってきた人に真っ先に渡す。**
   *
   * 字幕は次が来るまで出しっぱなしなので、渡さないとその人には
   * 次の字幕まで何も出ない (数十秒あく)
   */
  private readonly showing = new Map<number, CaptionShown>();
  /** いまの字幕のストリームに載っている言語 (`CaptionText.languages`)。届くまでは空 */
  private languages: CaptionLanguage[] = [];
  /** 字幕が無いと言われたか。言われたら字幕なしで再エンコードする */
  private noSubtitle = false;
  /**
   * データ放送をデコードする側。**求められてから作り、誰も出していなければ畳む**
   * (理由と引き換えは databroadcast.ts の冒頭)
   */
  private data: DataBroadcast | null = null;
  /**
   * Hybridcast を見つける側 (`packages/arib/src/ait.ts`)。**押されなくても読む。**
   *
   * データ放送と違ってデコードする量がほとんど無い — PMT に印が無ければ AIT を
   * 待つこともしないので、載っていない局では**表を1枚も組み立てません**。
   * 求められてから読むようにすると「押すまで在ることが分からない」になり、
   * 出したいもの (在るという事実) がそのまま出せなくなります
   */
  private ait: AitReader | null = null;
  /**
   * 放送が言う「いま」と「次」(EIT[p/f]) を読む側 (`packages/arib/src/eit.ts`)。**ライブのときだけ。**
   *
   * 番組が切り替わった・延びたのを番組表に写し、画面に読み直させる (`epg.followOnAir`)。
   * 予定の時刻だけで追うと、延長・繰り下げで取り違える。追っかけ (`source`) は録画の
   * ファイルを読んでいて、流れている p/f は過去のものなので読まない
   */
  private onAir: PresentFollowing | null = null;
  /** 最後に番組表と突き合わせた時刻 (`ON_AIR_EVERY`) */
  private followedAt = 0;
  /** 最後に伝えた Hybridcast。**同じものを伝え直さない** */
  private toldApps = "";
  /** 最後に伝えた番組。**同じものを伝え直さない** (`programInfo`) */
  private toldEvent: number | null | undefined;
  /** 最後に伝えた中継の番号。**遅れて分かるので、分かった時点で伝え直す** */
  private toldTsid: number | null | undefined;
  /**
   * PAT に書いてある中継の番号 (`ServiceFilter`)。**読めるまでは null。**
   * データ放送に渡すためだけに覚える (`programInfo`)
   */
  private tsid: number | null = null;
  private stopped = false;
  /**
   * 自分の利用者がいるチューナー (`GET /denpa/tuners` の `index`)。使えたら覚える (`locate`)。
   * **取り上げられたら、このチューナーにいる録画が取り上げた相手** (`live-yield.ts`)。取り上げられたあとでは自分の利用者が
   * 一覧から消えているので、前に覚えておくしかない
   */
  private tuner: number | null = null;
  /** 覚えに行っている最中 (`locate`)。外されたときは、覚え終わるのを待ってから読む (`lose`) */
  private locating: Promise<void> = Promise.resolve();
  /** チューナーから1塊でも届いたか。届く前に途切れたのは選局の失敗で、届いたあとなら外された (`lose`) */
  private fed = false;
  /** チューナーからのストリームが、こちらが畳む前に途切れた (取り上げられた・繋ぎが切れた) */
  private cut = false;

  constructor(
    readonly channelType: string,
    readonly channel: string,
    /** 局の内部ID (`services.id`)。共有の目印に使う */
    readonly serviceId: number,
    /** 放送が名乗っている番号。**ffmpeg に渡すのはこちら** (NowPlaying の説明) */
    readonly program: number,
    /** どの音声を、どちら側で出すか */
    readonly audio: AudioTrack,
    /** どの方式でエンコードするか。**見ている人が選ぶ** */
    readonly codec: StreamCodec,
    /** その局の中で何本目の字幕を出すか */
    readonly track: number,
    /**
     * **エンコードせずに放送そのままの TS を配るか** (stream.md#放送そのままmpeg-2を送る。`runRaw`)。音声もエンコード方式も画面が
     * 決めるので、共有の目印からも外れる (`key`)
     */
    readonly raw: boolean,
    /**
     * 入力の差し替え。無ければチューナーから (ライブ)。
     * 追っかけ再生はこれで録画中のファイルを渡す (`openChase`)。
     * 呼ぶたびに読み直したストリームを返すこと — 字幕なしでの再エンコードに使う
     */
    private readonly source?: () => ReadableStream<Uint8Array>,
    /**
     * 追っかけで、番組が替わって作り直した (`restart`)。`consumed` は `source` の頭から読んだ量 (バイト)。
     * 作り直したところを覚えるのに使う (`chase.ts` の `resumeFrom`)
     */
    private readonly restarted?: (consumed: number) => void,
  ) {
    this.list = new TrackList(program);
    this.id = key(
      channelType,
      channel,
      serviceId,
      audio,
      raw ? "raw" : codec,
      track,
    );
  }

  /** 一覧 (`sessions`) での目印。**作ったときに決めて、畳むときも同じものを消す** */
  readonly id: string;

  get empty(): boolean {
    // 脇から字幕だけ受け取っている人は数えない (`Viewer.side`)
    for (const viewer of this.viewers) if (viewer.side !== true) return false;
    return true;
  }

  /**
   * まだエンコードしているか。**畳んだものを持ったままにしないため。**
   *
   * ffmpeg が降りると畳まれて一覧からも消えるが、**繋いでいる側は同じものを
   * 指したまま**になる。同じ局を選び直しても「もう見ている」と見なされて
   * 何も起きず、**「やり直す」を押しても直らない**
   */
  get alive(): boolean {
    return !this.stopped;
  }

  add(viewer: Viewer): void {
    this.viewers.add(viewer);
    // そのままの TS に init は無い。**どこから受け取っても頭から読める** (PAT/PMT は繰り返し来る)
    if (this.raw) viewer.ready = true;
    if (this.init !== null) this.hand(viewer, CHANNEL.videoInit, this.init);
    // 選べる字幕と、いま出ている1枚。**どちらも待たせない**
    if (this.list.tracks.length > 0)
      this.tellCaptions(viewer, this.list.tracks);
    const showing = this.showing.get(this.languageOf(viewer));
    if (showing !== undefined) this.handText(viewer, showing);
    // **待たせない。** 途中から来た人にも、分かっているぶんはその場で渡す
    if (this.toldApps !== "") {
      this.tellOne(viewer, {
        type: "hybridcast",
        apps: JSON.parse(this.toldApps),
      });
    }
    // **出したままの人は、局を変えても出したまま** (`refreshData`)
    if (viewer.wantsData) this.refreshData(viewer);
    const clock = this.clockNotice();
    if (clock !== null) this.tellOne(viewer, clock);
    if (this.note !== null) this.tellOne(viewer, this.note);
  }

  /**
   * 受け取った時刻と、エンコードしたものの物差しの対応。**両方そろってから。**
   *
   * `start:` は ffmpeg が入口を読み終えるまで出ないので、選局してすぐは
   * `null` です。画面は届いてから出す作りにしてあります
   */
  private clockNotice(): Notice | null {
    const anchor = this.clock.anchor;
    /*
     * **放送そのままの経路では寄せない。** 受け側の物差しは放送の PTS そのもの (自分で PES から読む)
     * なので、PCR をそのまま渡せば比べられる。ffmpeg の `start:` を待つ必要も無い
     */
    const shift = this.raw ? 0 : this.startPts;
    if (anchor === null || !Number.isFinite(shift)) return null;
    return {
      type: "clock",
      at: anchor.pcr - shift,
      unixMs: anchor.unixMs,
      now: Date.now(),
    };
  }

  /**
   * 時計を配り直す。**塊を配るついでに、数秒に1回だけ** (ずれる速さではない)。
   *
   * 配り続ける理由は2つ — 選局の直後はまだ TDT が来ておらず配れないことと、
   * **端末とサーバの時計のずれを測り直せる**ことです (`now`)
   */
  private tellClock(): void {
    const now = Date.now();
    if (now - this.toldClockAt < CLOCK_EVERY) return;
    const notice = this.clockNotice();
    if (notice === null) return;
    this.toldClockAt = now;
    this.tell(notice);
  }

  /** データ放送を出す・やめる。**求めた人のぶんだけ。** */
  wantData(viewer: Viewer, on: boolean): void {
    if (viewer.wantsData === on) return;
    viewer.wantsData = on;
    this.refreshData(viewer);
  }

  /**
   * いまデコードする必要があるかを見直す。**誰も出していなければ畳む。**
   *
   * `Viewer.wantsData` は**その人の意思**で、局を変えても消えない
   * (セッションは作り直しになるが、押した本人にとっては同じ「出したまま」)。
   * デコードするかどうかはそのつど数え直す。
   *
   * @param viewer 出すと言った本人。**いま揃っているものをまとめて渡す** —
   *   カルーセルは回り続けるのでそのうち揃うが、`pmt` だけは1回しか来ないので、
   *   逃すと何番のコンポーネントを出すかが分からないまま待つことになる
   */
  private refreshData(viewer?: Viewer): void {
    if (![...this.viewers].some((held) => held.wantsData)) {
      this.data?.close();
      this.data = null;
      return;
    }
    if (this.data === null) {
      this.data = new DataBroadcast((message) => this.handData(message));
    }
    if (viewer?.wantsData !== true) return;
    /*
     * **番組を先に伝える。** 描く側は入口の BML を開く前にこれを待つので、
     * 後回しにすると画面が出ない (`programInfo` の説明)
     */
    const program = this.programInfo();
    if (program?.type === "programInfo") {
      this.toldEvent = program.eventId;
      this.toldTsid = program.transportStreamId;
      this.tellData(viewer, program);
    }
    for (const message of this.data.replay()) this.tellData(viewer, message);
  }

  remove(viewer: Viewer): void {
    this.viewers.delete(viewer);
    // 出していた人が抜けたら、誰も出していないかを見直す (意思は消さない)
    this.refreshData();
  }

  /**
   * 1つ渡す。**init を渡す前に中身を送らない** (MSE が捨てる)。
   *
   * 中身は詰まったら捨ててよい。**遅れて全部届くより、飛んで今が映るほうがいい** —
   * 放送は待ってくれないので、積むと際限なく太る。init は捨てない
   * (捨てるとその人には以降ずっと映像が出ない)。
   *
   * **そのままの TS も捨ててよい。** 欠けた PES は受け側のデコーダが次の I フレームで立ち直る。
   * 1局 15Mbit/s を積み続けると、詰まった客1人でサーバの手元が数秒で数十 MB 太る
   */
  private hand(viewer: Viewer, kind: number, data: Uint8Array): void {
    if (kind === CHANNEL.videoInit) viewer.ready = true;
    else if (!viewer.ready) return;
    viewer.connection.send(
      kind,
      0n,
      data,
      kind === CHANNEL.videoMedia || kind === CHANNEL.rawTs,
    );
  }

  /** エンコードし始める。**畳むまで戻らない** */
  async run(): Promise<void> {
    const label = `${this.channelType}:${this.channel}`;
    if (this.raw) return this.runRaw(label);
    try {
      // 追っかけ (`source`) はチューナーを使わない — 電波は録画が受けている
      const tuned = this.source !== undefined ? null : await this.tune();

      /*
       * **字幕なしで再エンコードできるようにしておく。**
       *
       * 字幕を持たない放送に `[0:p:X:s:0]` を指定すると、ffmpeg は組み立ての
       * 時点で降りる — **映像も出ない**。そうと分かったら字幕を外して
       * もう一度起こす。TS は流れ続けているので、取り直しは要らない
       */
      // 音声だけなら字幕はエンコードしない
      let wanted =
        this.codec === "audio" || remembered(captionless, this.serviceId)
          ? null
          : this.track;
      // GPU でエンコードするか (`pickLiveHw`)。降りたらソフトウェアで再エンコードする (下)
      let hw = this.codec === "audio" ? null : pickLiveHw(this.codec);
      /*
       * **ライブの TS はリーダーを1つだけ作って、起こし直しても使い回す。**
       *
       * リーダー (`getReader`) は1人しか持てない。ffmpeg ごとに作ると、前の流し込みが
       * 手放すまで次が読めない — 手放すのは相手が降りたあと次の塊を書こうとして転んだとき
       * だが、書き込みは返ってこないこともある (下の「終わりは ffmpeg の終了で見る」)。
       * 使い回せば前の流し込みは何も握っていない。追っかけは読み直すので毎回作る
       */
      const feed = tuned === null ? null : chunks(tuned);
      for (;;) {
        // ライブは同じ TS が流れ続けている。追っかけは再エンコードのたびに読み直す
        const stream =
          feed ??
          (this.source === undefined ? undefined : chunks(this.source()));
        if (stream === undefined) return;
        this.produced = false;
        const proc = Bun.spawn(
          [
            config.ffmpeg,
            ...encodeArgs(this.program, this.audio, this.codec, wanted, hw),
          ],
          // 字幕は4本目のパイプ (pipe:3) へ出させる。**stdio の配列でしか増やせない**
          {
            stdio: [
              "pipe",
              "pipe",
              "pipe",
              ...(wanted === null ? [] : ["pipe"]),
            ] as never,
          },
        );
        this.proc = proc;

        /*
         * **流し込みと汲み出しを同時に回す。** 順にやると、ffmpeg の
         * 出力を誰も読まないまま入力を書き続けることになり、パイプが詰まって
         * 両方止まる (放送は止まってくれない)。**字幕のパイプも汲み続ける** —
         * 片方を放っておくと、そこが詰まったときに映像まで止まる。
         *
         * **終わりは ffmpeg の終了で見る。** 汲み出しは相手が死ねば
         * すぐ終わるが、**流し込みは終わらない** — 書き込み先が閉じても
         * 例外にならないことがあり、放送は止まらないので回り続ける。
         * 揃うのを待っていると、死んだことに永久に気づかない
         */
        let trouble: unknown = null;
        const watching = this.watch(proc);
        const running = Promise.all([
          this.pump(stream, proc, feed === null),
          this.drain(proc),
          watching,
          wanted === null ? Promise.resolve() : this.subtitles(proc),
        ]).catch((error: unknown) => {
          // 相手が降りたあとの EPIPE。**ここで受け止めないと再エンコードに来られない**
          trouble = error;
        });
        await Promise.race([running, proc.exited]);
        if (this.stopped) return;
        // チューナーから外された。ffmpeg が降りたのは入口が尽きたからで、エンコード方式のせいではない
        if (this.cut && this.fed) return await this.lose(label);
        /*
         * **降りた理由を読み終えてから決める。** `proc.exited` は最後の
         * 言い分より先に来るので、待たずに見ると「字幕が無い」を取り
         * こぼして、**再エンコードに来られない**。標準エラーは相手が死ねば
         * 必ず閉じるので、ここで待つのは安全 (流し込みのほうは閉じても
         * 例外にならないことがあるので待てない)
         */
        if (wanted !== null || hw !== null)
          await watching.catch(() => undefined);
        /*
         * 追っかけが**録れているところまで読み切った** (ffmpeg が入力を
         * 食べ終えて 0 で終わる)。終わりであってエラーではない。
         * 画面はこれで MediaSource を閉じる (`MediaSource.endOfStream`)
         */
        if (this.source !== undefined && (await proc.exited) === 0) {
          this.tell({ type: "ended" });
          return;
        }
        /*
         * **GPU が映像を1つも出さずに降りたら、ソフトウェアで再エンコードする。**
         *
         * 試しのエンコードが通っても、放送の素材 (大きさ・途中の切り替わり) で GPU が
         * 降りることはある。出す前なら見ている人はまだ何も受け取っていないので、
         * 経路を替えて起こし直すだけで済む。字幕が無くて降りたのなら GPU のせいではない
         * ので先にそちらを直す (下)。**黙って替えず、一行だけ言う** — 遅れ・CPU の重さが
         * 変わるので、設定の印を外すかどうか決める手がかりになる
         */
        if (
          hw !== null &&
          !this.produced &&
          !(wanted !== null && this.noSubtitle)
        ) {
          console.warn(
            `[live] ${label}: GPU (${hw.way.device} の ${hw.way.kind}${hw.full ? "・復号から" : ""}) でエンコードできなかったので、ソフトウェアで再エンコードします`,
          );
          this.blame = hwKey(this.codec, hw);
          hw = null;
          continue;
        }
        if (wanted === null || !this.noSubtitle) {
          // ここまで来たのは ffmpeg が自分で降りたとき
          this.died(
            label,
            trouble === null
              ? `ffmpeg が終了しました (${proc.exitCode ?? "不明"})`
              : String(trouble),
            "映像を出せませんでした",
          );
          return;
        }
        console.warn(
          `[live] ${label}: 字幕が無いので字幕なしで再エンコードします`,
        );
        captionless.set(this.serviceId, Date.now());
        wanted = null;
      }
    } catch (error) {
      this.died(
        label,
        String(error),
        this.source === undefined
          ? whyNotTuned(String(error), resting(this.serviceId))
          : "録画を読めませんでした",
      );
    } finally {
      this.stop();
    }
  }

  /**
   * エンコードできなくなったことを、**見ている人に伝える。** 黙って消えると前の映像が
   * `HOLD_MOST` (6秒) 貼られて黒くなるだけで、失敗に見えなかった (tvk T15 で
   * `-map 0:p:…` を解決できずに ffmpeg が降りていた)。こちらから畳んだとき (`stop`) は言わない
   */
  private died(label: string, why: string, message: string): void {
    if (this.stopped) return;
    console.warn(`[live] ${label}: ${why}`);
    this.tell({ type: "error", message });
  }

  /** エージェントに名乗る利用者の印。同じ局を観ている人どうしで同じになる (チューナーも共有) */
  private get use(): StreamUse {
    return `live ${this.channelType}/${this.channel}`;
  }

  /**
   * チューナーを使う。**空きが無ければ待って掛け直す** (チャンネルを変える一瞬は2台要る)。
   * 使えたら、どのチューナーに入ったかを覚えておく (`locate`。待たない)
   */
  private async tune(): Promise<ReadableStream<Uint8Array>> {
    const stream = await openWhenFree(
      this.channelType,
      this.channel,
      this.aborter.signal,
      this.use,
      config.priority.live,
      () => this.stopped,
    );
    this.locating = this.locate();
    return stream;
  }

  /** 自分の利用者がいるチューナーを覚える。訊けなければ覚えないまま (取り上げられても録画を名指しできないだけ) */
  private async locate(): Promise<void> {
    try {
      this.tuner = tunerOf(
        await getTuners(),
        this.channelType,
        this.channel,
        this.use,
      );
    } catch {
      this.tuner = null;
    }
  }

  /**
   * **チューナーから外された。** 畳んで、見ている人にリクエストし直させる (`lost`)。
   *
   * ここで取り直さないのは、エンコードしたものを途中から作り直すと受け側のバッファ (MSE・テレビの fMP4) が
   * 続きとして読めないため。リクエストし直せばバッファごと作り直しになり、同じ局のライブとして素直に繋がる。
   * リクエストし直すときの使い方はいつもの選局と同じ (`openWhenFree`)。約束どおり使ってよいチューナーがあればそこに入る。
   *
   * 録画にチューナーを取り上げられたのなら、その録画を添える (`live-yield.ts`)。画面は**リクエストし直しても入れなかったとき
   * だけ**それの追っかけに切り替える。HTTP で観ているもの (テレビのアプリ) にはストリームの中で伝えられ
   * ないので、同じものを通知 (`yielded`) でも流す
   */
  private async lose(label: string): Promise<void> {
    /*
     * 使った直後に取り上げられたら、覚えに行った答えがまだ戻っていないことがある。待ってから読む。
     * それでも一覧から自分が消えたあとに訊いていたら覚えられない (録画を名指しできず、リクエストし直すだけになる)
     */
    await this.locating;
    const recording = await yieldedTo(this.tuner);
    if (this.stopped) return;
    console.warn(
      `[live] ${label}: チューナーから外されました${recording === null ? "" : ` (録画 ${recording.id} に譲った)`}`,
    );
    if (recording !== null)
      emit("yielded", {
        serviceId: this.serviceId,
        recording,
      } satisfies Yielded);
    this.tell({ type: "lost", recording });
  }

  /**
   * **番組が替わって映像・音声・字幕の並び (PMT) が変わった。** 畳んで、見ている人にリクエストし直させる (`restart`)。
   *
   * ffmpeg は起きたときの並びのまま音声・字幕を選んでいて (`encodeArgs` の `-map`)、音声の本数や字幕の PID が
   * 変わっても追従しない。その場で ffmpeg を起こし直さないのは `lose` と同じ理由 — 時刻が 0 から数え直しになり、
   * 受け側のバッファ (MSE・テレビの fMP4) が続きとして読めない。画面はすぐリクエストし直す (音声を選び直した
   * ときと同じ。途切れるのはエンコードし始めのぶん)。新しい ffmpeg は新しい並びで起きる。
   *
   * **追っかけも同じ** (`source`)。ちがうのは、観ている側が届いたぶんを観終えてから、観ていた位置を
   * リクエストし直すこと (観ていない先を飛ばさない)。その近くをリクエストされたら変わったところのバイトから
   * 読むので (`restarted`・`chase.ts` の `resumePlan`)、前の番組の並びを読み直して作り直しを繰り返すことはない
   *
   * @param consumed 追っかけで、`source` の頭から読んだ量 (バイト)
   */
  private restart(consumed: number): void {
    if (this.stopped) return;
    console.log(
      `[live] ${this.id}: 番組が替わって音声・字幕の構成が変わったので、作り直します`,
    );
    this.restarted?.(consumed);
    this.tell({ type: "restart" });
    this.stop();
  }

  /**
   * 届いた塊を1局に絞り (`pump` の説明)、**絞ったあとを** データ放送・時計・
   * Hybridcast の見張りへ分ける。データ放送は誰も出していなければデコードしない (`wantData`)
   */
  private tap(filter: ServiceFilter | null, chunk: Uint8Array): Uint8Array {
    const out = filter === null ? chunk : filter.filter(chunk);
    if (filter !== null) this.tsid = filter.transportStreamId;
    if (out.length === 0) return out;
    // **188 バイトに切るのは1回だけ** (3つのパーサで使い回す。ライブの処理でいちばん重いところ)
    const receivedAt = Date.now();
    const data = this.data;
    const ait =
      this.program > 0 ? (this.ait ??= new AitReader(this.program)) : null;
    if (this.program > 0 && this.source === undefined)
      this.onAir ??= new PresentFollowing(this.program);
    const onAir = this.onAir;
    let switched = false;
    const found: Ait[] = [];
    for (const packet of this.packets.feed(out)) {
      data?.feedPacket(packet);
      this.clock.feedPacket(packet, receivedAt);
      ait?.feedPacket(packet, found);
      if (onAir?.feedPacket(packet) === true) switched = true;
    }
    if (found.length > 0) this.findHybridcast(found);
    if (
      onAir !== null &&
      (switched || receivedAt - this.followedAt >= ON_AIR_EVERY)
    ) {
      this.followOnAir(onAir);
    }
    return out;
  }

  /**
   * 放送の「いま」と「次」が変わった (か、しばらく突き合わせていない)。
   * **番組表に写す** (`epg.followOnAir`)。
   *
   * 書けなくても映像は止めない。番組表が予定のままになるだけで、次の突き合わせでまた写す
   */
  private followOnAir(onAir: PresentFollowing): void {
    this.followedAt = Date.now();
    const events = [onAir.present, onAir.following].filter(
      (event) => event !== null,
    );
    try {
      followOnAir(events);
    } catch (error) {
      console.warn(
        `[live] ${this.channelType}:${this.channel}: いまの番組を番組表に写せませんでした: ${error}`,
      );
    }
  }

  /**
   * エージェントから来た TS を ffmpeg へ。**その局のぶんだけ渡す。**
   *
   * 録画と同じ絞り方 (`packages/arib/src/service-filter.ts`)。丸ごと渡すと、局が3つ入っている TS で
   * ffmpeg が局を見つけられずに降りる (`encodeArgs` の説明)。
   *
   * **量はほとんど減らない。** 実測は tvk で 17.6 → 16.8 Mbit/s、日テレで
   * 17.3 → 14.5 Mbit/s。同じ TS に入っている局は**同じ ES を指している**ことが
   * 多いので (tvk1/2/3 は同じ中継を流している)、落ちるのは他局ぶんの表と
   * 詰め物だけ。狙いは量ではなく、**ffmpeg に局を探させないこと**。
   *
   * **放送の番号が分からないときは絞らない。** 絞りようが無いので、
   * 丸ごと渡して ffmpeg に最初の映像を採らせる (`encodeArgs` も同じ判断)
   *
   * ## `write` の返りを待つ。**待たないとサーバごと落ちる**
   *
   * bun の `FileSink.write` は、**捌けなければ Promise を返す**
   * (捌けたときは書けた数)。放っておくと、ffmpeg が降りたあとの
   * EPIPE が**誰にも受け取られない転び**になり、bun はそれで
   * **プロセスを終わらせる** — ライブ1本の後始末で、録画まで道連れになる。
   *
   * `try`/`catch` では止まらない。投げられるのではなく、捨てた Promise が
   * あとから転ぶため。実機で落ちた (字幕だけ別の ffmpeg でエンコードしていた頃の
   * 流し込みで EPIPE、終了コード 1)。同じ状況を作って数えると:
   *
   *     write を待たない   15回中 8回 落ちる
   *     write を待つ       15回中 0回
   *
   * 待つのは詰まりの面倒を見ることにもなる。捌けるまで読むのを止めれば
   * いいだけで、放送を落とすことにはならない (汲み出しは別に回っている)
   */
  private async pump(
    stream: AsyncGenerator<Uint8Array>,
    proc: ReturnType<typeof Bun.spawn>,
    /** リーダーを自分で閉じるか。ライブは起こし直しても使い回すので閉じない (`run`) */
    own: boolean,
  ): Promise<void> {
    const writer = proc.stdin as import("bun").FileSink;
    const filter = this.program > 0 ? new ServiceFilter(this.program) : null;
    /** この ffmpeg を起こしてから、映像・音声・字幕の並びが変わったか */
    const streams = new StreamsWatch();
    /** 頭から読んだ量 (バイト)。追っかけで作り直したところを覚えるのに使う (`restart`) */
    let consumed = 0;
    try {
      for (;;) {
        // `for await` にしない — 抜けるとリーダーごと閉じてしまう (使い回せなくなる)
        let next: IteratorResult<Uint8Array>;
        try {
          next = await stream.next();
        } catch (error) {
          // チューナーのストリームが例外で切れた (エージェントが落ちた・取り上げられた)。追っかけのファイルは数えない
          if (!own) this.cut = true;
          throw error;
        }
        if (next.done === true) {
          if (!own) this.cut = true;
          break;
        }
        if (!own) this.fed = true;
        /*
         * 起こし直したあとの古い流し込みは抜ける。その1塊は捨てるが、次の ffmpeg は
         * どのみちキーフレームから始めるので欠けは見えない
         */
        if (this.stopped || this.proc !== proc) break;
        consumed += next.value.length;
        const out = this.tap(filter, next.value);
        if (filter !== null && streams.changed(filter)) {
          this.restart(consumed);
          break;
        }
        if (out.length === 0) continue;
        // **書けたことを待つ** (上の説明)。待たないと、転んだときに受け止める先がない
        await writer.write(out);
        await writer.flush();
      }
    } finally {
      if (own) await stream.return(undefined);
      endInput(proc);
    }
  }

  /**
   * GPU のせいだったと決める。**ソフトウェアに替えて映像が出たときだけ** — 選局直後で
   * 映像がまだ来ていない・入力が途切れた、のように GPU と関係なく降りたのなら、
   * ソフトウェアでも出ずに「映像を出せませんでした」になる。そのとき GPU を15分
   * 外したり「GPU でエンコードできなかった」と言ったりすると嘘になる
   */
  private blameGpu(): void {
    if (this.blame === null) return;
    gpuFailed.set(this.blame, Date.now());
    this.blame = null;
    this.note = { type: "notice", message: GPU_GAVE_UP };
    this.tell(this.note);
  }

  /**
   * ffmpeg が出した fMP4 を割って配る。**割る道具は ffmpeg ごとに作る** — 起こし直したとき
   * (`run`)、前の ffmpeg の書きかけを次へ持ち越さない
   */
  private async drain(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const splitter = new Fmp4Splitter();
    for await (const chunk of chunks(
      proc.stdout as ReadableStream<Uint8Array>,
    )) {
      for (const segment of splitter.feed(chunk)) {
        if (segment.kind === "init") {
          this.init = segment.data;
          for (const viewer of this.viewers)
            this.hand(viewer, CHANNEL.videoInit, segment.data);
        } else {
          // 起こし直したあとに届いた前の ffmpeg の残りは数えない
          if (this.proc === proc && !this.produced) {
            this.produced = true;
            this.blameGpu();
          }
          for (const viewer of this.viewers)
            this.hand(viewer, CHANNEL.videoMedia, segment.data);
          this.tellClock();
        }
      }
    }
  }

  /**
   * ffmpeg が出した字幕を割って配る。**時刻はコマに付いてくる。**
   *
   * コンテナは Matroska ([ts/mkv.ts](../ts/mkv.ts))。並べただけでは
   * 時刻が乗らず、別のパイプに出させると数が合わずにずれる (`captions.ts`)
   */
  private async subtitles(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const fd = (proc.stdio as unknown as number[])[3];
    if (typeof fd !== "number") return;
    // 割る道具もデコードする側も ffmpeg ごと (`drain` と同じ理由。デコードする側は書式を字幕文を跨いで持つ)
    const frames = new MkvSplitter();
    const text = new CaptionText();
    for await (const chunk of chunks(Bun.file(fd).stream())) {
      for (const found of frames.feed(chunk)) {
        for (const shown of text.feed(found)) this.deliverText(shown);
        // 載っている言語が分かった・変わった。選べるように知らせ直す
        if (text.languagesChanged) {
          const before = new Map(
            [...this.viewers].map((viewer) => [
              viewer,
              this.languageOf(viewer),
            ]),
          );
          this.languages = text.languages;
          for (const viewer of this.viewers) {
            this.tellCaptions(viewer, this.list.tracks);
            // 出す言語が変わった人 (選んだ言語がこの番組に無い) には、その言語でいま出ている1枚を渡す
            if (before.get(viewer) !== this.languageOf(viewer))
              this.handShowing(viewer);
          }
        }
      }
    }
  }

  /** 文字の配置を1枚配る。**デコードして出てくるのは変わったときだけ**なので、間引かない */
  private deliverText(shown: CaptionShown): void {
    this.showing.set(shown.language, shown);
    for (const viewer of this.viewers) {
      if (this.languageOf(viewer) === shown.language)
        this.handText(viewer, shown);
    }
  }

  /**
   * 選べる字幕を1人に知らせる。**言語はその人に出しているもの** (`Viewer.language`) なので、全員に同じものは送れない。
   * 言語がまだ分からない (字幕管理データが届いていない) ときは `languages` を省く
   */
  private tellCaptions(viewer: Viewer, tracks: CaptionTrack[]): void {
    this.tellOne(
      viewer,
      captionsNotice(
        tracks,
        this.track,
        this.languages,
        this.languageOf(viewer),
      ),
    );
  }

  /** その人に出す言語 (`pickLanguage`) */
  private languageOf(viewer: Viewer): number {
    return pickLanguage(this.languages, viewer.language ?? 1);
  }

  /**
   * 字幕の言語を選び直す (`{ type: 'language' }`)。**再エンコードしない** — 全部の言語をデコードしているので、
   * 出すものを替えて、その言語でいま出ている1枚を渡すだけ (無ければ空の1枚で前の言語の字幕を消す)
   */
  setLanguage(viewer: Viewer, language: number): void {
    viewer.language = language;
    if (!this.viewers.has(viewer)) return;
    if (this.list.tracks.length > 0)
      this.tellCaptions(viewer, this.list.tracks);
    this.handShowing(viewer);
  }

  /** その人の言語でいま出ている1枚を渡す。無ければ空の1枚で、前の言語の字幕を消す */
  private handShowing(viewer: Viewer): void {
    const showing = this.showing.get(this.languageOf(viewer));
    if (showing !== undefined) {
      this.handText(viewer, showing);
      return;
    }
    // 時刻はいま出ている中でいちばん新しいものに揃える (受け側はその位置で前の1枚を置き換える)
    const at = Math.max(0, ...[...this.showing.values()].map((s) => s.at));
    this.handText(viewer, {
      at,
      page: {
        v: CAPTION_TEXT_VERSION,
        plane: [960, 540],
        duration: null,
        runs: [],
      },
    });
  }

  /**
   * データ放送を配る。**中身は JSON** (組み立て終わったモジュールの中の画像や音は
   * base64 で入っている — 借りている側がそう出す)。
   *
   * 映像と違って**捨てない**。落とすと、そのモジュールが次に回ってくるまで
   * 画面が欠けたままになる (カルーセルは数秒から数十秒で一周する)
   */
  private handData(message: ResponseMessage): void {
    const wanting = [...this.viewers].filter((viewer) => viewer.wantsData);
    if (wanting.length === 0) return;
    /*
     * **番組が変わったら伝え直す。** カルーセルの一覧が来るたびに見る
     * (数十秒に1回)。そのために時計を1つ増やすほどのことではない
     */
    if (message.type === "moduleListUpdated") {
      const program = this.programInfo();
      if (
        program?.type === "programInfo" &&
        (this.toldEvent !== program.eventId ||
          this.toldTsid !== program.transportStreamId)
      ) {
        this.toldEvent = program.eventId;
        this.toldTsid = program.transportStreamId;
        for (const viewer of wanting) this.tellData(viewer, program);
      }
    }
    // **組み立てるのは1回だけ。** 人数ぶん JSON にすると、人が増えたぶんだけ無駄に働く
    const data = json(message);
    for (const viewer of wanting)
      viewer.connection.send(CHANNEL.data, 0n, data);
  }

  private tellData(viewer: Viewer, message: ResponseMessage): void {
    viewer.connection.send(CHANNEL.data, 0n, json(message));
  }

  /**
   * いま流れている番組を、データ放送の側に伝える。**自前の番組表から作る。**
   *
   * 描く側 (`bml/resources.ts`) は局が替わったかの判断や `browser.getProgramID` などに使う。
   * 放送の EIT/SDT/NIT から組み立てることもできるが、denpa は同じものを
   * **もっと確かな形式で持っている** (番組表は溜め込んであり、放送を待たなくていい)。
   *
   * **`transportStreamId` だけは放送から取得します** (`ServiceFilter` が絞るときに
   * 読んだ PAT の値)。番組表には要らないので集めていませんが、**データ放送が
   * 受信機に訊いてきます** — テレ朝の TVerリンクは `browser.getProgramID(4)` で
   * これを取り、TVer のサーバへ機器の識別子と並べて送る。`null` のままだと
   * 文字の "null" が飛んで、あちらが `e` を返し、画面には
   * 「情報を取得することができませんでした。[エラーコード:DT-RE]」とだけ出ます
   * (実機で再現。`DT` は dtoken_common、`RE` は返り `e` の意味)。
   *
   * **PAT を読むまでは null のまま伝わります**。読めた時点で伝え直すので
   * (`handData` の `toldTsid`)、押すのが早すぎても待っていれば揃います
   */
  private programInfo(): ResponseMessage | null {
    const service = serviceOf(this.serviceId);
    if (service === undefined) return null;
    const program = orm()
      .select({
        event_id: programs.event_id,
        name: programs.name,
        start_at: programs.start_at,
        end_at: programs.end_at,
      })
      .from(programs)
      .where(airingAt(this.serviceId))
      .get();
    return {
      type: "programInfo",
      originalNetworkId: service.network_id,
      networkId: service.network_id,
      transportStreamId: this.tsid,
      serviceId: service.service_id,
      eventId: program?.event_id ?? null,
      eventName: program?.name ?? null,
      startTimeUnixMillis: program?.start_at ?? null,
      durationSeconds:
        program === undefined
          ? null
          : Math.round((program.end_at - program.start_at) / 1000),
      indefiniteDuration: false,
    };
  }

  private handText(
    viewer: Viewer,
    shown: Pick<CaptionShown, "at" | "page">,
  ): void {
    const { kind, pts, data } = textFrame(shown);
    viewer.connection.send(kind, pts, data);
  }

  /**
   * ffmpeg の言い分から、**選べる字幕と失敗**を読み取る。
   *
   * エンコードできない理由 (音声が無い・解像度が変わった) はここにしか出ない。
   * 捨てていると「映像が出ない」としか分からなくなる。
   *
   * `-loglevel` は下げられない (選べる字幕が info で出る) ので、要らない行も
   * 流れてくる。**残すのは本当に失敗した行だけ** (`worthLogging`) — 放送の
   * 欠けは日常的にあってデコーダがそのたびに喋るので、そこまで残すと
   * **本当の失敗が埋もれる**
   */
  private async watch(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    /*
     * **起きたときの一覧に数える。** 放送のままの経路で字幕の ffmpeg を起こし直したら (`captions`)、
     * 古いほうの残りの行は新しい一覧にも「字幕が無い」にも入れない
     */
    const list = this.list;
    for await (const line of lines(proc.stderr as ReadableStream<Uint8Array>)) {
      if (list !== this.list) return;
      /*
       * **選べる字幕は入口の見出しに出ている。** 1枚も来ていなくても
       * 分かるので、画面は待たずに切り替えを出せる (間隔の空く番組で
       * ボタンが出なかったのはこれを見ていなかったため)
       */
      if (list.feed(line)) {
        for (const viewer of this.viewers)
          this.tellCaptions(viewer, list.tracks);
        continue;
      }
      // 入口の見出しに出ている「0 に寄せたぶん」。時計を配るのに要る
      if (!Number.isFinite(this.startPts) && line.includes("start:")) {
        this.startPts = parseStart(line);
      }
      // 字幕が無い放送。**映像ごと落ちる**ので、字幕なしで再エンコードする (`run`)
      if (NO_SUBTITLE.test(line)) this.noSubtitle = true;
      if (worthLogging(line)) {
        console.warn(
          `[live] ${this.channelType}:${this.channel} ffmpeg: ${line.trim()}`,
        );
      }
    }
  }

  /**
   * Hybridcast が載っていれば、在ることと行き先を伝える。
   *
   * **同じものは伝え直さない。** 放送は同じ表を数秒ごとに繰り返し流すので、
   * 素直に配ると毎秒の通知になる。
   *
   * `autostart` のものだけ出す判断はしません — テレビが勝手に始めるかどうかの
   * 違いでしかなく、`present` (人が呼んだら始めるもの) も**在ることに変わりは
   * ない**ためです。押したときの言い方だけ変えます
   */
  private findHybridcast(found: Ait[]): void {
    for (const ait of found) {
      if (ait.applicationType !== APPLICATION_TYPE_HTML5) continue;
      const apps: HybridcastLink[] = ait.applications
        .filter(
          (app) =>
            app.controlCode === CONTROL.autostart ||
            app.controlCode === CONTROL.present,
        )
        .map((app) => ({
          name: app.name,
          url: app.url,
          organisationId: app.organisationId,
          applicationId: app.applicationId,
          autostart: app.controlCode === CONTROL.autostart,
        }));
      const mark = JSON.stringify(apps);
      if (mark === this.toldApps) continue;
      this.toldApps = mark;
      // 行き先をログにも出す。画面のボタンは window.open で URL をコピーできず、
      // WS はバイナリ多重化なので DevTools でも読みにくい。切り分け (疎通確認など) に要る
      for (const app of apps)
        console.log(`[hybridcast] ${app.name || "(名前なし)"}: ${app.url}`);
      this.tell({ type: "hybridcast", apps });
    }
  }

  tell(notice: Notice): void {
    for (const viewer of this.viewers) this.tellOne(viewer, notice);
  }

  private tellOne(viewer: Viewer, notice: Notice): void {
    viewer.connection.send(CHANNEL.control, 0n, json(notice));
  }

  /** 畳んだときに呼ぶもの (`whenStopped`) */
  private readonly stopping: (() => void)[] = [];

  /** 畳んだら呼ぶ。追っかけが変換の枠を返すのに使う (`openChase`)。もう畳んでいればその場で */
  whenStopped(fn: () => void): void {
    if (this.stopped) fn();
    else this.stopping.push(fn);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.aborter.abort();
    this.proc?.kill();
    this.data?.close();
    // 脇から字幕だけ受け取っている人は、映像が終わったことを知らないので伝えて閉じさせる
    for (const viewer of this.viewers)
      if (viewer.side === true) this.tellOne(viewer, { type: "ended" });
    // 選び直しで同じ目印の新しいものが載っていたら、そちらは消さない
    if (sessions.get(this.id) === this) sessions.delete(this.id);
    for (const fn of this.stopping.splice(0)) fn();
  }

  /**
   * **エンコードせずに、1局に絞った TS をそのまま配る** (stream.md#放送そのままmpeg-2を送る)。
   *
   *     エージェント → 1局に絞る → WebSocket (`CHANNEL.rawTs`) → ブラウザが自分でデコードする
   *
   * 映像の ffmpeg は起こさない — 立ち上がりの 0.5秒も、エンコードしているぶんの遅れも、サーバの
   * CPU (350〜470%) も消える。**起こすのは字幕を写す ffmpeg だけ** (`rawCaptionArgs`)。
   * 字幕は denpa がデコードして文字の配置にする (エンコードの経路と同じ)。
   *
   * **字幕の ffmpeg が転んでも映像は止めない。** エンコードの経路と違って、映像はそもそも
   * ffmpeg を通っていない。字幕を持たない放送で降りたら、覚えておいて (`captionless`)
   * 次からは起こさない
   */
  private async runRaw(label: string): Promise<void> {
    let captioner: RawCaptions | null = null;
    try {
      const tuned = await this.tune();
      if (!remembered(captionless, this.serviceId)) captioner = this.captions();
      const filter = this.program > 0 ? new ServiceFilter(this.program) : null;
      const streams = new StreamsWatch();
      try {
        for await (const chunk of chunks(tuned)) {
          if (this.stopped) break;
          this.fed = true;
          const out = this.tap(filter, chunk);
          /*
           * **番組が替わって並びが変わったら、字幕の ffmpeg だけ起こし直す** (`StreamsWatch`)。
           * 映像と音声は受け側が PMT を読んで自分で追う (`packages/arib/src/pes.ts` の `PesDemuxer`)。字幕は放送の
           * PTS のまま写すので (`-copyts`)、起こし直しても時刻は続く。字幕が無かった局にも増えて
           * いるかもしれないので、覚えていた「字幕が無い」は忘れて起こす
           */
          if (filter !== null && streams.changed(filter)) {
            console.log(
              `[live] ${this.id}: 番組が替わって音声・字幕の構成が変わったので、字幕を写し直します`,
            );
            captioner?.stop();
            captionless.delete(this.serviceId);
            // 選べる字幕は新しい ffmpeg の見出しから数え直す。前の番組の字幕は残さない
            this.showing.clear();
            this.languages = [];
            for (const viewer of this.viewers) this.tellCaptions(viewer, []);
            captioner = this.captions();
          }
          if (out.length === 0) continue;
          // **詰まったら捨てる** (`hand` の説明)。遅れて全部届くより、飛んで今が映るほうがいい
          for (const viewer of this.viewers)
            this.hand(viewer, CHANNEL.rawTs, out);
          this.tellClock();
          captioner?.feed(out);
        }
      } catch (error) {
        // 届く前に切れたのは選局の失敗 (下の catch)。届いたあとなら外された
        if (!this.fed) throw error;
      }
      // 届いたあとで途切れた = チューナーから外された。エンコードの経路と同じくリクエストし直させる (`lose`)
      if (this.fed && !this.stopped) return await this.lose(label);
      this.died(label, "放送が途切れました", "映像を出せませんでした");
    } catch (error) {
      this.died(
        label,
        String(error),
        whyNotTuned(String(error), resting(this.serviceId)),
      );
    } finally {
      captioner?.stop();
      this.stop();
    }
  }

  /**
   * 放送そのままの経路の字幕の ffmpeg を起こす (`rawCaptionArgs`)。**字幕のパイプと見出しを汲み続ける。**
   * 選べる字幕と「字幕が無い」もここの見出しから読み取る。**起こし直したら数え直す** (`runRaw`。番組が替わった)
   */
  private captions(): RawCaptions {
    this.list = new TrackList(this.program);
    this.noSubtitle = false;
    const proc = spawnCaptioner(this.program, this.track);
    const list = this.list;
    void this.watch(proc)
      .then(() => {
        // 起こし直されたあとの古いものは、「字幕が無い」を覚えさせない
        if (list === this.list && this.noSubtitle)
          captionless.set(this.serviceId, Date.now());
      })
      .catch(() => undefined);
    void this.subtitles(proc).catch(() => undefined);
    return new RawCaptions(proc);
  }
}

/**
 * 放送そのままの経路で字幕を写させている ffmpeg への流し込み。**映像を待たせない。**
 *
 * エンコードの経路では書き込みが捌けるまで待つ (`Session.pump`) — そうしないと転んだときに
 * サーバごと落ちるため。ここでも待つが、**待っている間に来た塊は字幕の側には渡さない**。
 * 映像はブラウザへ直に流れているので、字幕のために読むのを止めると映像まで止まる。
 * 取りこぼした塊で字幕が1枚欠けることはありうるが、映像が止まるよりずっといい
 */
class RawCaptions {
  private busy = false;
  private dead = false;

  constructor(private readonly proc: ReturnType<typeof Bun.spawn>) {}

  feed(data: Uint8Array): void {
    if (this.busy || this.dead) return;
    this.busy = true;
    const writer = this.proc.stdin as import("bun").FileSink;
    // **返りは必ず受ける** (捨てた Promise が転ぶと bun ごと落ちる。`Session.pump`)
    Promise.resolve()
      .then(() => writer.write(data))
      .then(() => writer.flush())
      .then(
        () => {
          this.busy = false;
        },
        () => {
          this.dead = true;
        },
      );
  }

  stop(): void {
    this.dead = true;
    endInput(this.proc);
    this.proc.kill();
  }
}

/**
 * エンコードしているものの目印。**局・音声・エンコード方式・字幕まで含める。**
 *
 * 1つの物理チャンネルに複数の局が入っているので、チャンネルだけでは足りない —
 * 局を名指しで選んでいる以上、出てくる映像が局ごとに違う。**音声も同じ** —
 * 二カ国語を主音声で見ている人と副音声で見ている人は別のものをエンコードしている。
 * **エンコード方式 (H.264 / AV1) も同じ** — 選んだ方式が違えば別のものになる。
 * 混ぜると片方が意図しないものを見ることになる。チューナーはエージェント側で
 * 共有になるので、増えるのは ffmpeg だけ。
 *
 * **字幕も入る。** 映像と同じ ffmpeg でエンコードするようになったので、何本目の字幕を
 * 出すかが違えば別のものになる (`encodeArgs`)。言語が複数ある放送でしか
 * 動かないところなので、そのために起こし直すのは年に数回のこと
 */
export const key = (
  type: string,
  channel: string,
  serviceId: number,
  audio: AudioTrack,
  form: StreamCodec | "raw",
  track: number,
  // **放送そのままでは音声で分けない** — 全部の音声を送って画面が選ぶ (`TuneCommand.raw`)
) =>
  `${type}:${channel}:${serviceId}:${form === "raw" ? "*" : audio.id}:${form}:${track}`;
const sessions = new Map<string, Session>();

/** エンコードし始めて一覧に載せる。畳むのは見ている人がいなくなったとき。ここでは待たない */
function begin(
  channelType: string,
  channel: string,
  serviceId: number,
  now: NowPlaying,
  codec: StreamCodec,
  track: number,
  raw: boolean,
): Session {
  const session = new Session(
    channelType,
    channel,
    serviceId,
    now.program,
    now.audio,
    codec,
    track,
    raw,
  );
  sessions.set(session.id, session);
  void session.run();
  return session;
}

/** 見に行く。既に同じものをエンコードしていれば、そのセッションを共有する */
function watch(
  channelType: string,
  channel: string,
  serviceId: number,
  now: NowPlaying,
  codec: StreamCodec,
  track: number,
  raw: boolean,
  viewer: Viewer,
): Session {
  const session =
    sessions.get(
      key(
        channelType,
        channel,
        serviceId,
        now.audio,
        raw ? "raw" : codec,
        track,
      ),
    ) ?? begin(channelType, channel, serviceId, now, codec, track, raw);
  session.add(viewer);
  return session;
}

/** HTTP のライブで、読まれずに溜まってよい量 (バイト)。超えたら閉じる */
export const LIVE_STREAM_BACKLOG = 32 * 1024 * 1024;

/**
 * HTTP の追っかけで、読まれずに溜まったら**元のTSの送り込みを止める**量 (バイト)。
 * 追っかけは倍速で送り込むので、相手が観る速さでしか読まなければ溜まり続け、
 * いずれ上の上限で閉じてしまう。ライブと違って入力 (伸びているファイル) は待てるので、
 * 止めて待つ (`chase.ts` の `followFile` の `hold`)。
 *
 * **閉じる上限 (`LIVE_STREAM_BACKLOG`) より必ず小さくする。** 逆だと止める前に閉じて
 * しまい、止める意味が無い。エンコードした映像は塊で届くので、間を十分あけておく (live.test.ts で固定)
 */
export const CHASE_STREAM_HOLD = 4 * 1024 * 1024;

/**
 * **HTTP で流すライブ** (`GET /api/services/<id>/live`)。画面の外のもの
 * (テレビのアプリ・Home Assistant の Cast) 向けに、画面と同じエンコード方式の fMP4 をそのまま流す。
 *
 * `raw` ならエンコードせずに、1局に絞っただけの TS をそのまま流す (画面の「MPEG-2」と同じ経路)。
 * `audio` なら音声だけ (AAC の fMP4。画面の無いスピーカーへの Cast 向け)。
 *
 * `audio` はエンコードする音声 (`AudioTrack.id`。画面の `TuneCommand.audio` と同じもの)。無いもの・省けば主音声。
 * 放送そのままでは効かない (全部の音声を送り、アプリが選ぶ)。
 *
 * 画面の視聴者と同じ取り合いに加わる — 同じ局・同じエンコード方式・**同じ音声**を誰かが見ていれば
 * 共有し (`key`)、最後の1人が抜けたら畳む。局が無ければ null
 */
export function liveStream(
  serviceId: number,
  codec: StreamCodec | "raw",
  audio?: string,
): ReadableStream<Uint8Array> | null {
  const row = serviceOf(serviceId);
  if (row === undefined) return null;
  return sessionStream((viewer) => {
    const raw = codec === "raw";
    return watch(
      row.type,
      row.channel,
      serviceId,
      nowPlaying(serviceId, audio),
      raw ? "h264" : codec,
      0,
      raw,
      viewer,
    );
  });
}

/**
 * **HTTP で流す追っかけ再生** (`GET /api/recordings/<id>/chase`)。テレビのアプリ向け。
 *
 * - `raw` … 録画中の元のTSを、`at` 秒に当たるところから**そのまま**流し、伸びるのを追い読みする
 *   (位置の当て方は `chasePlan` のバイト比例)。録り終えて尻まで読んだら閉じる
 * - `h264` / `av1` … 画面の追っかけ (`openChase`) と同じ再エンコードを、WebSocket ではなく
 *   HTTP の fMP4 で流す。読み切ったら (`ended`) 閉じる
 *
 * シークは `at` を変えてリクエストし直す (画面の追っかけと同じく、位置ごとに立て直す)。
 * `audio` はエンコードする音声 (`AudioTrack.id`)。無いもの・省けば主音声で、放送そのままでは効かない。
 * 録画が無い・まだ何も録れていなければ null。再エンコードでその場の変換の枠 (`transcode.ts`) が
 * 埋まっていれば `'busy'`
 */
export function chaseStream(
  recordingId: number,
  codec: LiveCodec | "raw",
  at: number,
  audio?: string,
): ReadableStream<Uint8Array> | null | "busy" {
  const source = chaseSource(recordingId);
  if (source === undefined || source.size === 0) return null;
  if (codec === "raw") {
    const { rec, path, size } = source;
    const plan = chasePlan(size, recordedSec(rec), at);
    return followFile(path, plan.offset, plan.paceBytesPerSec, () =>
      recordingDone(rec.id),
    );
  }
  const release = holdTranscode();
  if (release === null) return "busy";
  return sessionStream((viewer, held) =>
    openChase(
      {
        type: "chase",
        recordingId,
        at,
        audio,
        codec,
        caption: 0,
        language: undefined,
      },
      viewer,
      held,
      release,
    ),
  );
}

/**
 * **アプリ向けのライブの字幕** (`GET /api/services/<id>/captions`。docs/api.md)。そのままの TS
 * (`liveStream` の `raw`) を観ているアプリに、字幕 (文字の配置 0x22) を放送の PTS のまま流す —
 * ブラウザで放送そのままを送る経路 (stream.md#放送のままのときの字幕) と同じもの。
 *
 * **いま流している放送そのままのセッションを脇から共有する**だけで、チューナーは増やさない
 * (ブラウザで同じ局を放送そのままで観ていればそれも共有する)。共有する相手が無ければ null —
 * 映像 (`live?codec=raw`) を先に開いてからリクエストすること。映像が終われば閉じる (`Viewer.side`)
 */
export function liveCaptions(
  serviceId: number,
  language = 1,
): ReadableStream<Uint8Array> | null {
  const row = serviceOf(serviceId);
  if (row === undefined) return null;
  // 放送そのままの目印は音声で分けない (`key`)。何を渡しても同じ
  const session = sessions.get(
    key(
      row.type,
      row.channel,
      serviceId,
      nowPlaying(serviceId, undefined).audio,
      "raw",
      0,
    ),
  );
  if (session === undefined || !session.alive) return null;
  return captionFeed((out) => {
    const viewer: Viewer = {
      connection: { send: out.send },
      ready: false,
      wantsData: false,
      side: true,
      // 第何言語を流すか (`?language=`)。省けば第1言語 (今までどおり)
      language,
    };
    session.add(viewer);
    return () => depart(session, viewer);
  });
}

/** 録画の字幕を、求められた位置のどれだけ手前から読むか (秒)。**いま出ている字幕も出すため** (字幕は次が来るまで出しっぱなし) */
const CAPTION_LEAD = 10;

/** 観ている位置より先に読んでおく量 (秒)。頭のここまでは倍速の縛りを掛けずに読む (`followFile` の `burst`) */
const CAPTION_AHEAD = 10;

/**
 * 1本の録画に同時に起こしておく字幕の ffmpeg の数。**超えたら古いものから畳む。**
 *
 * アプリはシークのたびにリクエストし直すので、前の繋ぎが切れたと分かるのが遅れる (前段の nginx 越しなど) と
 * 一時的に何本も並ぶ。古いほどもう観ていない位置なので、新しいものを断るより古いものを畳む
 */
export const CAPTION_PER_RECORDING = 3;

/** 録画ごとに、いま起こしている字幕の ffmpeg の畳み方 (古い順) */
const recordingCaptioners = new Map<number, (() => void)[]>();

/**
 * **アプリ向けの録画の字幕** (`GET /api/recordings/<id>/captions?from=<秒>`。docs/api.md)。
 * 元のTS (録画中の追っかけ `chase?codec=raw` と、録り終えた `file?source=ts`) を観ているアプリに、
 * 字幕 (文字の配置) を放送の PTS のまま流す。
 *
 * 字幕だけを写す ffmpeg (`rawCaptionArgs`) を1本起こし、録画の元のTSを `from` の
 * `CAPTION_LEAD` 秒手前から流し込む。位置の当て方は追っかけと同じバイト比例 (`chasePlan`)。
 * 当たりがずれても受け側は PTS で突き合わせるので、手前に読んだぶんは「いま出ている字幕」になるだけ。
 *
 * **録り終えた録画でも、まるごと返さずに流す。** 1時間の BS は 7GB あり、字幕を全部抜くには
 * それを読み切る必要がある (観はじめが待たされる)。流すなら観る位置から読むだけで済み、
 * 追っかけと同じ仕組みで両方に答えられる。送り込みは追っかけと同じ倍速まで (頭の
 * `CAPTION_LEAD + CAPTION_AHEAD` 秒ぶんは縛らず読んで、観ている位置を追い越しておく)。受け側が
 * 読まなくなったら (アプリは先読みする枚数に上限がある) 録画を読むのも止める。
 * シークしたら `from` を変えてリクエストし直す
 */
export function recordingCaptions(
  recordingId: number,
  at: number,
  language = 1,
): ReadableStream<Uint8Array> | null {
  const source = chaseSource(recordingId);
  if (source === undefined || source.size === 0) return null;
  const { rec, path, size } = source;
  const recorded = recordedSec(rec);
  const plan = chasePlan(size, recorded, Math.max(0, at - CAPTION_LEAD));
  const burst = Math.round(
    (size / Math.max(1, recorded)) * (CAPTION_LEAD + CAPTION_AHEAD),
  );
  const program = aribServiceId(rec.service_id);
  const label = `rec ${rec.id}`;

  return captionFeed((out) => {
    const reader = followFile(
      path,
      plan.offset,
      plan.paceBytesPerSec,
      () => recordingDone(rec.id),
      // 受け側が読まなくなったら、録画を読むのも止める (作った字幕が溜まり続けないように)
      out.backedUp,
      burst,
    ).getReader();
    let stopped = false;
    /** いま写させている ffmpeg。番組が替わって並びが変わったら起こし直す (下の流し込み) */
    let proc = spawnRecordingCaptioner(
      program,
      label,
      language,
      out,
      () => proc,
    );
    const stop = () => {
      if (stopped) return;
      stopped = true;
      reader.cancel().catch(() => undefined);
      proc.kill();
      const rest = (recordingCaptioners.get(rec.id) ?? []).filter(
        (held) => held !== stop,
      );
      if (rest.length > 0) recordingCaptioners.set(rec.id, rest);
      else recordingCaptioners.delete(rec.id);
    };
    // 多すぎたら古いものから畳む (`CAPTION_PER_RECORDING`)。畳まれた接続は ffmpeg が降りて閉じる
    const held = recordingCaptioners.get(rec.id) ?? [];
    for (const old of held.slice(
      0,
      Math.max(0, held.length - CAPTION_PER_RECORDING + 1),
    ))
      old();
    recordingCaptioners.set(rec.id, [
      ...(recordingCaptioners.get(rec.id) ?? []),
      stop,
    ]);

    /*
     * 流し込み。**書けたことを待つ** (ffmpeg が詰まったら読むのも止まる)。
     *
     * **番組が替わって並びが変わったら、ffmpeg を起こし直す** (`StreamsWatch`)。字幕は放送の PTS のまま
     * 写すので (`-copyts`)、起こし直しても時刻は続く。録画の TS は1局に絞ってあるが、並びを読むのに通す
     */
    const filter = program > 0 ? new ServiceFilter(program) : null;
    const streams = new StreamsWatch();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || stopped) break;
          filter?.filter(value);
          if (filter !== null && streams.changed(filter)) {
            console.log(
              `[captions] ${label}: 番組が替わって音声・字幕の構成が変わったので、字幕を写し直します`,
            );
            const old = proc;
            proc = spawnRecordingCaptioner(
              program,
              label,
              language,
              out,
              () => proc,
            );
            endInput(old);
            old.kill();
          }
          const writer = proc.stdin as import("bun").FileSink;
          await writer.write(value);
          await writer.flush();
        }
      } finally {
        endInput(proc);
      }
    })().catch(() => undefined);
    return stop;
  });
}

/**
 * 録画の字幕を写す ffmpeg を1本起こし (`spawnCaptioner`)、選べる字幕と文字の配置を `out` へ送らせる。
 * **読み切ったら閉じる** (字幕を持たない録画なら、ffmpeg が組み立てで降りる) — ただし起こし直された
 * あとの古いもの (`current` が自分でない) は閉じない
 */
function spawnRecordingCaptioner(
  program: number,
  label: string,
  language: number,
  out: CaptionOut,
  current: () => ReturnType<typeof Bun.spawn>,
): ReturnType<typeof Bun.spawn> {
  const proc = spawnCaptioner(program, 0);
  // 選べる字幕は入口の見出しから (`TrackList`)。ffmpeg ごとに数え直す。失敗は残す
  const list = new TrackList(program);
  const text = new CaptionText();
  const effective = () => pickLanguage(text.languages, language);
  const tell = () =>
    out.send(
      CHANNEL.control,
      0n,
      json(captionsNotice(list.tracks, 0, text.languages, effective())),
    );
  void (async () => {
    for await (const line of lines(proc.stderr as ReadableStream<Uint8Array>)) {
      if (list.feed(line)) {
        tell();
      } else if (worthLogging(line) && !NO_SUBTITLE.test(line)) {
        console.warn(`[captions] ${label} ffmpeg: ${line.trim()}`);
      }
    }
  })().catch(() => undefined);

  // 字幕。文字の配置は変わったときしか出てこないので、間引かない
  const fd = (proc.stdio as unknown as number[])[3];
  const frames = new MkvSplitter();
  const captions = (async () => {
    if (typeof fd !== "number") return;
    for await (const chunk of chunks(Bun.file(fd).stream())) {
      for (const frame of frames.feed(chunk)) {
        for (const shown of text.feed(frame)) {
          // 求められた言語だけ (`?language=`)
          if (shown.language !== effective()) continue;
          const { kind, pts, data } = textFrame(shown);
          out.send(kind, pts, data);
        }
        if (text.languagesChanged && list.tracks.length > 0) tell();
      }
    }
  })().catch(() => undefined);

  void Promise.all([captions, proc.exited]).then(() => {
    if (current() === proc) out.close();
  });
  return proc;
}

/**
 * エンコードしたもの (`Session`) を HTTP の応答に流すところ。ライブと追っかけで共通。
 *
 * 流すのは映像のコンテナ (init + 中身) と元のTSだけで、字幕・データ放送・通知は捨てる。
 * エンコードできなくなったら・読み切ったら・チューナーから外されたら・番組が替わって作り直すなら (`error` / `ended` / `lost` / `restart`) 応答を閉じる。読むのが追いつかない
 * 相手も閉じる (溜め続けるとメモリが増え続け、fMP4 は途中を捨てると壊れる)。
 * `held` は溜まりすぎて送り込みを止めたいか (追っかけだけが使う。`CHASE_STREAM_HOLD`)
 */
export function sessionStream(
  open: (viewer: Viewer, held: () => boolean) => Session | null,
): ReadableStream<Uint8Array> {
  let session: Session | null = null;
  /** もう閉じたか。加えている最中 (watch の中) に閉じることがあるので、戻ってから見る */
  let closed = false;
  const viewer: Viewer = {
    connection: { send: () => {} },
    ready: false,
    wantsData: false,
  };
  const leave = () => {
    if (session !== null) depart(session, viewer);
    session = null;
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const close = () => {
          closed = true;
          leave();
          controller.close();
        };
        viewer.connection = {
          send(kind, _pts, payload) {
            if (closed) return;
            if (
              kind === CHANNEL.videoInit ||
              kind === CHANNEL.videoMedia ||
              kind === CHANNEL.rawTs
            ) {
              if ((controller.desiredSize ?? 0) < -LIVE_STREAM_BACKLOG)
                return close();
              controller.enqueue(payload);
              return;
            }
            if (kind !== CHANNEL.control) return;
            const notice = JSON.parse(
              new TextDecoder().decode(payload),
            ) as Notice;
            // 外された (`lost`)・作り直す (`restart`) ときも閉じる。リクエストし直すのは観ている側 (テレビのアプリは閉じたらリクエストし直す)
            if (
              notice.type === "error" ||
              notice.type === "ended" ||
              notice.type === "lost" ||
              notice.type === "restart"
            )
              close();
          },
        };
        session = open(
          viewer,
          () => (controller.desiredSize ?? 0) < -CHASE_STREAM_HOLD,
        );
        if (closed) leave();
      },
      cancel() {
        closed = true;
        leave();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }),
  );
}

/**
 * 誰も繋いでこなかったときに畳むまで (ms)。
 *
 * **画面はすぐ来る** — 実測で、ページを組みはじめてから WebSocket が繋がる
 * まで 160ms。それでも来ないなら開いたそばから離れた人なので、使ったままに
 * しない (ライブは録画の次に優先度が高いので、放っておくと番組表集めからチューナーを取り上げ続ける)。
 */
const WARM_WAIT = 8_000;

/**
 * **画面が繋いでくる前にエンコードし始める。**
 *
 * 開いてから映像が出るまでを実機で割ると ([stream.md](../../../docs/stream.md#開いてから映像が出るまでの内訳)):
 *
 *     画面が動き出してチケットを取り、WebSocket が繋がるまで   160ms
 *     ffmpeg の立ち上がり                              530ms
 *     放送の I フレーム待ち                          0〜501ms
 *
 * **前の 160ms は後ろと重ねられる。** これから開くのがどの局かは、画面を
 * 組む時点で分かっている — 番組表から名指しで来たか (`?service=`)、画面が
 * 覚えている前回の局か (`LAST_COOKIE`)、一覧の先頭。
 *
 * **1枚も出ないうちに繋がるので、合流の待ちは付かない。** エンコードしたものは
 * キーフレームから始まるが、それが出るのは 530ms 後なので、160ms で来る画面は
 * まだ何も渡されていない状態で繋がる。
 *
 * 待たない・投げない。使えなくても画面はいつもどおり繋いでくるので、
 * そのとき改めて開くだけ。
 */
export function warm(
  channelType: string,
  channel: string,
  serviceId: number,
  audio?: string,
  codec: LiveCodec = "h264",
  /**
   * 放送そのままで温めるか。**前回も放送そのままで見ていたときだけ** (呼ぶ側が決める)。
   * 放送そのままは ffmpeg を待たないぶん、削れるのはチューナーを取る時間だけだが、それでも 160ms は重なる
   */
  raw = false,
): void {
  if (channelType === "" || channel === "" || !Number.isFinite(serviceId))
    return;
  /*
   * **誰かがもうこの局を観ていれば温めない。** 画面は番組が切り替わるたびに読み直す
   * (`routes/live/+page.svelte`) ので、観ている最中にも何度もここへ来る。下の目印は
   * 音声と字幕まで含むので、番組が替わって主音声の決まり方が変わった・2本目の字幕を
   * 出している、だけで外れて、**誰も来ない ffmpeg を毎回起こしてしまう**。
   * 観ている人がいるなら、それは開き直しではなく読み直しのことが多い。別の端末が同じ局を
   * 別のエンコード方式で観ているときに開いた人は 160ms 削れなくなるだけで、選局はいつもどおり進む
   */
  for (const session of sessions.values()) {
    if (session.serviceId === serviceId && !session.empty) return;
  }

  const now = nowPlaying(serviceId, audio);
  // 字幕は1本目で温める。**選び直す人は稀**で、そのときは再エンコードになる。
  // 既にエンコードしていれば何もしない。開き直すたびに増やさない
  if (
    sessions.has(
      key(channelType, channel, serviceId, now.audio, raw ? "raw" : codec, 0),
    )
  )
    return;
  const session = begin(channelType, channel, serviceId, now, codec, 0, raw);

  /*
   * **誰も来なければ自分で畳む。** 見ている人がいなくなったら畳む仕掛け
   * (`attend` の `leave`) は、**1人も来なかった場合には動かない**
   */
  const timer = setTimeout(() => {
    if (session.empty) session.stop();
  }, WARM_WAIT);
  timer.unref?.();
}

/** 画面からの指示 (`#lib/live` の `Command`) を、省かれたところを既定で埋めて読んだもの */
type Asked =
  | { type: "data"; on: boolean }
  | { type: "language"; language: number }
  | {
      type: "tune";
      channelType: string;
      channel: string;
      serviceId: number;
      /** 省かれていれば主音声 (`nowPlaying` が決める) */
      audio: string | undefined;
      codec: LiveCodec;
      caption: number;
      /** 字幕の第何言語か。省かれていれば前のまま (`Viewer.language`) */
      language: number | undefined;
      /** 放送そのままで欲しいと言われたか */
      raw: boolean;
    }
  | ChaseAsked;

type ChaseAsked = {
  type: "chase";
  /** 整数でないものもここまでは来る。断るのは `openChase` (見ている人に理由を返すため) */
  recordingId: number;
  at: number;
  audio: string | undefined;
  codec: LiveCodec;
  caption: number;
  language: number | undefined;
};

/**
 * 画面から来た JSON を読む。**画面から来る値をそのまま信じない** — 知らない形式の
 * エンコード方式は H.264 に、数でないものは 0 に落とす。読めないもの (知らない type、
 * 局の名指しが無い tune) は null で、黙って捨てる。
 *
 * 選局と追っかけで読むのをここ1箇所にしてある (両方に足すものが片方だけにならないように)
 */
function parseCommand(message: Record<string, unknown>): Asked | null {
  const audio =
    typeof message["audio"] === "string" ? message["audio"] : undefined;
  const codec: LiveCodec = message["codec"] === "av1" ? "av1" : "h264";
  // **字幕も映像と同じ ffmpeg**。選び直すと再エンコードになる (`encodeArgs`)
  const caption = Number.isInteger(message["caption"])
    ? Math.max(0, Number(message["caption"]))
    : 0;
  // 字幕の言語 (データグループの番号 1〜8)。それ以外は聞かなかったことにする
  const number = Number(message["language"]);
  const language =
    Number.isInteger(number) && number >= 1 && number <= 8 ? number : undefined;
  switch (message["type"]) {
    case "data":
      return { type: "data", on: message["on"] === true };
    case "language":
      return language === undefined ? null : { type: "language", language };
    case "chase": {
      const at = Number(message["at"]);
      return {
        type: "chase",
        recordingId: Number(message["recordingId"]),
        at: Number.isFinite(at) ? Math.max(0, at) : 0,
        audio,
        codec,
        caption,
        language,
      };
    }
    case "tune": {
      const channelType = message["channelType"];
      const channel = message["channel"];
      if (typeof channelType !== "string" || channelType === "") return null;
      if (typeof channel !== "string" || channel === "") return null;
      return {
        type: "tune",
        channelType,
        channel,
        serviceId: Number(message["serviceId"]),
        audio,
        codec,
        caption,
        language,
        raw: message["raw"] === true,
      };
    }
    default:
      return null;
  }
}

/** 見ている人を降ろす。**最後の1人が抜けたら畳む** — 残すとチューナーを使ったままになる */
function depart(session: Session, viewer: Viewer): void {
  session.remove(viewer);
  if (session.empty) session.stop();
}

/**
 * 接続1本ぶんの受け持ち。**繋いでいる間だけチューナーを使う。**
 *
 * 接続そのものが在席の印になる (stream.md#入っているもの の畳み方)。
 * HTTP のストリームだと切断の検出が遅れるが、WebSocket なら閉じた時点で分かる。
 */
export function attend(connection: Connection): void {
  const viewer: Viewer = { connection, ready: false, wantsData: false };
  let current: Session | null = null;

  const leave = () => {
    if (current !== null) depart(current, viewer);
    current = null;
  };

  connection.onmessage = (message) => {
    const asked = parseCommand(message);
    if (asked === null) return;
    /*
     * **データ放送は求められてからデコードする** (`Session.wantData`)。選局の指示とは
     * 別に受ける — 押すたびに再エンコードしていたら映像が途切れる
     */
    if (asked.type === "data") {
      current?.wantData(viewer, asked.on);
      return;
    }
    // 字幕の言語は再エンコードせずに替える (`Session.setLanguage`)
    if (asked.type === "language") {
      if (current === null) viewer.language = asked.language;
      else current.setLanguage(viewer, asked.language);
      return;
    }
    if (asked.language !== undefined) viewer.language = asked.language;
    /*
     * **追っかけ再生** (issue #16)。シークも同じ指示の送り直しで、
     * そのたびに再エンコードする (ライブの選局し直しと同じ流儀)
     */
    if (asked.type === "chase") {
      leave();
      viewer.ready = false;
      current = openChase(asked, viewer);
      return;
    }
    const { channelType, channel, serviceId, audio, codec, caption, raw } =
      asked;

    const now = nowPlaying(serviceId, audio);

    /*
     * **同じものをエンコードしているなら、再エンコードしない。**
     *
     * ただし**畳まれていないことを確かめる** — ffmpeg が降りたセッションを
     * 指したままだと「もう見ている」と見なされ、選び直しても「やり直す」を
     * 押しても新しく起こさない。画面は待ち続けるだけになる
     */
    const same =
      current?.alive === true &&
      current.channelType === channelType &&
      current.channel === channel &&
      current.serviceId === serviceId &&
      current.raw === raw &&
      (raw || (current.audio.id === now.audio.id && current.codec === codec)) &&
      current.track === caption;

    /*
     * **知らせるのも印を戻すのも、共有する前に済ませる。**
     *
     * `watch` は既に誰かが見ているチャンネルなら、その場で持っている init を
     * 渡す (`Session.add`)。そのあとで `ready` を戻していた頃は、**渡した直後の
     * init を無かったことにして**いた — 以降の中身が全部 `hand` で止まり、
     * 共有したときだけ映像が出ない。
     *
     * `tuned` も先に出す。MediaSource を作るのは画面側で、init はそれより先には使えない。
     */
    viewer.ready = false;
    const notice: Notice = {
      type: "tuned",
      channelType,
      channel,
      codecs: codecsFor(codec),
      codec,
      raw,
      audio: now.audio.id,
      audios: now.audios,
    };
    connection.send(CHANNEL.control, 0n, json(notice));

    /*
     * **再エンコードしなくても、リクエストされたら必ず答える。**
     *
     * 黙って返していた頃は、**いま映している局をもう一度押すと映像が止まった**。
     * 画面側は `tune` のたびに MediaSource を捨てる作りで (`live-player.svelte.ts` の
     * `forget`)、`tuned` と init が来て初めて作り直す。何も変わらないからと
     * 黙ると、**捨てたきり二度と作られない** — 塊は届き続けるので、
     * エラーも出ないまま黒い画面で止まる (実機で踏んだ)。
     *
     * 答えるだけなら再エンコードにはならない。`add` は持っている init を
     * その場で渡すので、映像は 0.2秒 ほどで戻る
     */
    if (same && current !== null) {
      current.add(viewer);
      return;
    }

    leave();
    current = watch(
      channelType,
      channel,
      serviceId,
      now,
      codec,
      caption,
      raw,
      viewer,
    );
  };

  connection.onclose = () => {
    leave();
  };
}

/**
 * 追っかけで番組が替わって作り直したところ (`chase.ts` の `ChaseResume`)。録画ごとに最後の1つ。
 * 期限を過ぎたものは、次に覚えるときに消す (`rememberResume`)
 */
const chaseResumes = new Map<number, ChaseResume>();

function rememberResume(recordingId: number, resume: ChaseResume): void {
  for (const [id, held] of chaseResumes)
    if (held.until < Date.now()) chaseResumes.delete(id);
  chaseResumes.set(recordingId, resume);
}

/**
 * 追っかけ再生を1本起こす — **録画中の録画を、いま録れているところまで観る**
 * ([issue #16](https://github.com/danything/denpa/issues/16))。
 *
 * チューナーは使わない。録画が書き足している元のTSを追い読みして (`chase.ts`)、
 * ライブと同じ `Session` に流し込む。**共有はしない** — 観る位置が人ごとに
 * 違うので、同じものを観る2人はほぼ起きない。セッションの一覧 (`sessions`) にも
 * 載せない (見ている人が選び直すか抜ければ `leave` が畳む)。
 *
 * シークの当たりの付け方は `chasePlan` (chase.ts の冒頭)。
 *
 * **その場の変換の枠を 1 つ使う** (`transcode.ts`)。埋まっていれば断る。畳んだら返す。
 * HTTP のエンドポイント (`chaseStream`) は先に取って `held` で渡す (断るのを 503 にするため)
 */
function openChase(
  asked: ChaseAsked,
  viewer: Viewer,
  hold?: () => boolean,
  held?: () => void,
): Session | null {
  const tell = (notice: Notice) =>
    viewer.connection.send(CHANNEL.control, 0n, json(notice));
  const refuse = (text: string): null => {
    tell({ type: "error", message: text });
    return null;
  };
  const refuseHeld = (text: string): null => {
    held?.();
    return refuse(text);
  };

  const { recordingId, at, audio: wanted, codec, caption } = asked;
  const source = Number.isInteger(recordingId)
    ? chaseSource(recordingId)
    : undefined;
  if (source === undefined) return refuseHeld("録画が見つかりません");
  const { rec, path, size } = source;
  if (size === 0) return refuseHeld("まだ何も録画されていません");
  const release = held ?? holdTranscode();
  if (release === null) return refuse(BUSY);

  const finished = rec.finished_at !== null;
  // 番組が替わって作り直したところの近くなら、そのバイトから (`chase.ts` の `resumePlan`)
  const plan = resumePlan(
    chasePlan(size, recordedSec(rec), at),
    chaseResumes.get(rec.id),
  );

  const tracks = audioTracks(parseAudios(rec));
  const audio = pickTrack(tracks, wanted);
  // ffmpeg に名指しさせる放送の番号。録画TSは絞ってあるが、探させない理屈はライブと同じ
  const program = aribServiceId(rec.service_id);

  tell({
    type: "tuned",
    channelType: "chase",
    channel: String(rec.id),
    codecs: codecsFor(codec),
    codec,
    // 追っかけは変換せずに送る方式 (raw) にしない。録画の TS を倍速で送り込む作りで、受け側の貯め方が別物
    raw: false,
    audio: audio.id,
    audios: tracks,
  });
  tell({
    type: "timeline",
    at: plan.at,
    recordedSec: plan.recordedSec,
    // バーの全長。予定 (終わりのマージン込み) と録れたぶんの長いほう
    totalSec: Math.max(
      plan.recordedSec,
      (rec.end_at + config.endMargin - rec.created_at) / 1000,
    ),
    finished,
  });

  let session: Session;
  try {
    session = new Session(
      "chase",
      `${rec.id}@${Math.round(plan.at)}`,
      rec.service_id,
      program,
      audio,
      codec,
      caption,
      false,
      () =>
        followFile(
          path,
          plan.offset,
          plan.paceBytesPerSec,
          () => recordingDone(rec.id),
          hold,
        ),
      (consumed) => rememberResume(rec.id, resumeFrom(plan, consumed)),
    );
  } catch (failure) {
    // 起こせなかった。取った枠は返す
    release();
    throw failure;
  }
  session.whenStopped(release);
  void session.run();
  session.add(viewer);
  return session;
}

/**
 * 追っかけ・録画の字幕で読む録画と、その元のTS。消した・元のTSが無いものは undefined。
 * `size` は元のTSのいまの大きさで、読めなければ 0 (まだ何も録画されていない)
 */
function chaseSource(
  recordingId: number,
):
  | { rec: typeof recordings.$inferSelect; path: string; size: number }
  | undefined {
  const rec = orm()
    .select()
    .from(recordings)
    .where(eq(recordings.id, recordingId))
    .get();
  if (rec === undefined || rec.deleted_at !== null || rec.ts_path === null)
    return undefined;
  return { rec, path: rec.ts_path, size: fileSize(rec.ts_path) ?? 0 };
}

/** 録れている長さ (秒)。録り終えていれば実測、まだなら**録り始めてからの経過** */
function recordedSec(rec: typeof recordings.$inferSelect): number {
  return rec.finished_at !== null
    ? (rec.duration_ms ?? rec.end_at - rec.start_at) / 1000
    : (Date.now() - rec.created_at) / 1000;
}

/** もう書き足されないか。録り終えたら (行が消えたときも)、尻に着いた時点で読み終わり */
function recordingDone(id: number): boolean {
  const row = orm()
    .select({ finished_at: recordings.finished_at })
    .from(recordings)
    .where(eq(recordings.id, id))
    .get();
  return row === undefined || row.finished_at !== null;
}

interface NowPlaying {
  /**
   * 放送が名乗っている番号 (ARIB の service_id = TS の program_number)。
   * **`services.id` とは別物** — あちらは `network_id * 100000 + service_id` の
   * 内部IDで、TS の中には出てこない。**内部IDを渡すと** ffmpeg はその番号の局を
   * 探して見つけられず、**映像も音も出ない** (実機でやった)。ffmpeg に渡すのはこちら
   */
  program: number;
  /** 選べる音声。画面へそのまま送る */
  audios: AudioTrack[];
  /** そのうちエンコードするもの */
  audio: AudioTrack;
}

/**
 * いま流れている番組から、ffmpeg に渡す局の番号と音声を決める。**番組表を頼りにする。**
 *
 * - 局の番号 … ffmpeg に名指しさせる `program_number` (`NowPlaying.program`)
 * - 音声 … 番組表の `audios` から、選べるものを組み立てる (`arib.audioTracks`)。
 *   **古い行には `audios` が入っていない**ので、そのときは `audio_type` だけで
 *   デュアルモノかどうかを見る。どちらも無ければ「そのまま出す」1つ
 *
 * @param serviceId 局の内部ID (`services.id`)。画面から届くのはこれ
 * @param wanted 画面が求めてきた音声 (`AudioTrack.id`)。無いものなら先頭
 */
function nowPlaying(serviceId: number, wanted: string | undefined): NowPlaying {
  const decide = (program: number, audios: Audio[]): NowPlaying => {
    const tracks = audioTracks(audios);
    return {
      program,
      audios: tracks,
      audio: pickTrack(tracks, wanted),
    };
  };

  if (!Number.isFinite(serviceId)) return decide(0, []);
  const program = orm()
    .select({ audio_type: programs.audio_type, audios: programs.audios })
    .from(programs)
    .where(airingAt(serviceId))
    .get();
  return decide(aribServiceId(serviceId), parseAudios(program));
}

/** その局でいま流れている番組 (`programs` の絞り込み) */
function airingAt(serviceId: number, at = Date.now()) {
  return and(
    eq(programs.service_id, serviceId),
    lte(programs.start_at, at),
    gt(programs.end_at, at),
  );
}

/** ffmpeg に名指しさせる放送の番号 (ARIB のサービスID)。局が無ければ 0 = 探させない */
export function aribServiceId(serviceId: number): number {
  return serviceOf(serviceId)?.service_id ?? 0;
}

/** 局の行のうち、選局と放送の番号に要るぶん */
function serviceOf(serviceId: number) {
  return orm()
    .select({
      type: services.type,
      channel: services.channel,
      service_id: services.service_id,
      network_id: services.network_id,
    })
    .from(services)
    .where(eq(services.id, serviceId))
    .get();
}
