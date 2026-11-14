/**
 * ライブ視聴で、サーバとブラウザが取り決めていること。**両側から読む。**
 *
 * 1 本の WebSocket で全部を一緒に送る ([stream.md](../../docs/stream.md#websocket-プロトコル))。
 *
 *     [1 byte: 種別][8 bytes: 時刻 (90kHz, BE)][中身...]
 *
 * 時刻は**エンコードした mp4 の物差し**。受け側の `video.currentTime` と直に
 * 突き合わせられる。映像と字幕を**同じ ffmpeg** でエンコードしているので、入口で
 * 0 に寄せる幅が両方に同じだけ効く (`server/captions.ts` に実測)。変換せずに送る経路 (`rawTs`) と
 * その字幕は放送の PTS のまま
 */

import type { CaptionLanguage } from "@danything/arib/caption-text";

import type { AudioTrack } from "./arib";
import { CODEC_LABEL } from "./hw";
import type { BroadcastCodec } from "./live-choice";
import type { Pace, Rung } from "./rungs";

/**
 * エンコード方式 ([stream.md](../../docs/stream.md#エンコード))。`av1` は量を採るが、SVT-AV1 が溜め込むぶん放送の今から
 * 1 秒ほど離れる (`server/live.ts` の `videoArgs`)。`h264` は速さを採り、どの端末でも出る。
 * `hevc` (H.265) は**ライブのエンコーダが GPU のときだけ**出す (ソフトウェアのエンコーダを組んでいない。`#lib/hw.ts` の
 * `SOFTWARE_CODECS`)。出せるかはサーバが決めて画面に渡す (`server/viewing.ts` の `ViewingOptions.hevc`)。段 0 の追っかけでは出さない (段を下げると `rungCodec` が選ぶことがある)。
 * **画面の既定は「自動」** (`#lib/live-choice.ts` の `autoCodec`)。指示で省かれたときの既定は `h264` のまま (テレビのアプリ)。
 * MPEG-2 (放送のまま) は「エンコードしない」なのでここに並べない (`TuneCommand.raw`)
 */
export type LiveCodec = "h264" | "hevc" | "av1";

/**
 * エンコード方式と名前。並びは小さい順で、コーデックのメニューもこの順 (「自動」のあと。選ぶのは端末の相性だけなので、説明は付けない)。
 * メニューに並べるのは `#lib/live-choice.ts` の `HIDDEN_CODECS` を除いたもの
 */
export const LIVE_CODECS: { id: LiveCodec; label: string }[] = [
  { id: "av1", label: CODEC_LABEL.av1 },
  { id: "hevc", label: CODEC_LABEL.hevc },
  { id: "h264", label: CODEC_LABEL.h264 },
];

/**
 * ブラウザに渡す codecs 文字列。**MSE はこれが合っていないと受け取らない。**
 *
 * 画面も MSE で受け取れるかを先に確かめるのに使う (`live-player.svelte.ts`)。中身から起こすのが本筋だが (moov を読めば分かる)、エンコード方式はこちらで決めて
 * いるので、その組に対応する値を返す。
 *
 * - `avc1.640029` … High profile / Level 4.1。1080p60 まで
 * - `av01.0.08M.08` … Main profile / Level 4.0 / 8bit。同じく 1080p60 まで
 * - `hvc1.1.6.L123.B0` … Main profile / Level 4.1。同じく 1080p60 まで。入れ物の中の名前も `hvc1` にする
 *   (`server/live.ts` の `videoArgs`。ffmpeg の既定の `hev1` は Safari が受け取らない)
 * - `Opus` … MP4 での Opus の名前 (中の箱の名前と同じく大文字の O)。Safari は小文字の `opus` を断る。
 *   **Chromium は `Opus` を受け取ると答えても、流すと断ることがある** (Android の Chrome 133。`mseType` で小文字に替える)。
 *   入れ物が WebM なら小文字が正しいので、エンコード済みのファイルは `opus` のまま
 * - `audio` … 音声だけ (AAC)。回線に合わせて下げる最後の手 (`TuneCommand.codec`)
 *
 * **音声も組で決まる** (`server/live.ts` の `audioArgs`)。AV1 は Opus、H.264・H.265 は AAC
 * (H.265 を受け取りたいのは AV1 をデコードできない端末で、MP4 の Opus を受け取れるとは限らない)
 *
 * 4K の局 (`broadcast` が `hevc`) の `hevc` は、放送の HEVC と AAC をエンコードせずに詰め替えたもの (`BROADCAST_HEVC`)
 */
export function codecsFor(
  codec: LiveCodec | "audio",
  broadcast: BroadcastCodec = "mpeg2",
): string {
  if (codec === "audio") return 'audio/mp4; codecs="mp4a.40.2"';
  if (codec === "av1") return 'video/mp4; codecs="av01.0.08M.08,Opus"';
  if (codec === "hevc")
    return broadcast === "hevc"
      ? BROADCAST_HEVC
      : 'video/mp4; codecs="hvc1.1.6.L123.B0,mp4a.40.2"';
  return 'video/mp4; codecs="avc1.640029,mp4a.40.2"';
}

/**
 * **4K の局の放送の HEVC と AAC を詰め替えた fMP4** (`server/live.ts` の 4K の経路。`mp4/mmt.ts`)。
 * Main 10 Profile・Level 5.1 (2160p60)。入れ物の中の名前は `hvc1` (Safari は `hev1` を受け取らない。VPS・SPS・PPS は `hvcC` にだけ置く。`mp4/mmt.ts`)
 */
export const BROADCAST_HEVC = 'video/mp4; codecs="hvc1.2.4.L153.B0,mp4a.40.2"';

/**
 * **MSE に渡す型。MP4 の `Opus` は、小文字の `opus` を受け取れる端末では小文字にする。**
 * Android の Chrome 133 は `Opus` を `isTypeSupported` で受け取ると答えるのに、流すと
 * `CHUNK_DEMUXER_ERROR_APPEND_FAILED: Audio stream codec opus doesn't match SourceBuffer codecs` で断り、
 * 小文字なら 1280x720 の AV1 を再生できた (エミュレータで確かめた)。Safari は小文字を断るので、大文字のまま渡す (`codecsFor`)
 */
export function mseType(
  type: string,
  supported: (type: string) => boolean,
): string {
  if (!type.startsWith("video/mp4") || !type.includes(",Opus")) return type;
  const lower = type.replace(",Opus", ",opus");
  return supported(lower) ? lower : type;
}

/**
 * 選べる字幕 1 つぶん。**取り決めなので、ここに置く**。組み立てるのは
 * サーバ (`server/captions.ts` の `TrackList`) だが、画面も同じ形式で読む
 */
export interface CaptionTrack {
  /** その局の中で何本目か。ffmpeg の `0:p:<局>:s:<これ>` に渡す */
  index: number;
  /** ISO 639-2。放送が名乗っていなければ null */
  lang: string | null;
  /** 「字幕 (日本語)」「字幕 2 (英語)」 */
  label: string;
}

/** 多重化の種別。番号は stream.md#websocket-プロトコル の表そのまま */
export const CHANNEL = {
  /** 映像の init セグメント (ftyp + moov) */
  videoInit: 0x00,
  /** 映像の中身 (moof + mdat) */
  videoMedia: 0x01,
  /**
   * **元の TS** (1 局に絞っただけ。エンコードしない経路。[stream.md](../../docs/stream.md#放送そのままmpeg-2を送る))。
   * 映像・音声・PAT/PMT が入っていて、受け側が自分でデコードする (`raw/`)。init は無い
   */
  rawTs: 0x02,
  // 0x10・0x11 (音声) は使わない (映像と同じコンテナに入れている)
  /**
   * **字幕の文字の配置** (JSON。`caption-text.ts` の `CaptionPage`)。サーバが置き場所まで決め、
   * 受け側が描く。前の 1 枚を丸ごと置き換える (`runs` が空なら消す)。
   * 0x20 (字幕の画像) と 0x21 (字幕を消す) は以前の取り決めで、もう使わない (番号は空けておく)
   */
  captionText: 0x22,
  /** データ放送 (JSON。`packages/arib/src/bml-protocol.ts` の `ResponseMessage`)。リクエストされてから送る (`Command` の `data`。押されたか、自動で受信する端末が自動起動の指定のある局を映しているとき) */
  data: 0x30,
  /** 制御。**ここだけ双方向**で、中身は JSON */
  control: 0x40,
} as const;

/**
 * サーバ→ブラウザの通知。`control` に JSON で載る。
 *
 * **選べる音声は、繋いだあとでないと分からない。** どれが選べるかは
 * いま流れている番組次第 (二カ国語の映画が終わればステレオに戻る) なので、
 * 画面が持っている局の一覧からは決められない。選局のたびに現物を送る
 */
export type Notice =
  | {
      /**
       * いまの局の PMT で、データ放送の入口の部品に自動起動の指定 (`auto_start_flag`) があるか (`server/databroadcast.ts` の `AutoStartWatch`)。
       * PMT を読んで決まったときと変わったとき、途中から入ってきた人には入ったときに来る。カルーセルは読まない。
       * 自動で受信する端末は、これが true の局でだけ受信をリクエストする (`components/player/data-receive.ts` の `wantsData`)。
       * 4K の局 (TLV) と追っかけでは来ない
       */
      type: "autoStart";
      on: boolean;
    }
  | {
      type: "tuned";
      channelType: string;
      channel: string;
      /** MSE に渡す codecs 文字列。エンコード方式から決まる */
      codecs: string;
      /**
       * いまエンコードしているコーデック。コーデックのメニューがどれを指すか。`audio` は音声だけ
       * (`TuneCommand.codec`。回線に合わせて下げる最後の手)
       */
      codec: LiveCodec | "audio";
      /** **エンコードせずに元の TS を送るか** (`CHANNEL.rawTs`) */
      raw: boolean;
      /**
       * いまの段 (`#lib/rungs.ts`。回線に合わせて下げた画質)。0 は下げていない。リクエストした段より高ければ、
       * サーバが混んでいて下げられなかった (理由は続く `notice`)。段を下げたときの `codec` はサーバが `playable` から選んだもの
       */
      rung: Rung;
      /** いまエンコードしている音声 (`AudioTrack.id`) */
      audio: string;
      /** 選べる音声。1 つしか無ければ画面は切り替えを出さない */
      audios: AudioTrack[];
      /**
       * サーバが PMT を読んで、TS に HEVC を入れて送る 4K の局と分かったときだけ `hevc`。画面はその局を開いている間、
       * 「放送のまま」を HEVC の詰め替えとして扱う (`Tuned.broadcast`)。放送のままをリクエストしても、答えは `hevc` になる
       * (`server/live.ts` の `servedFormat`)
       */
      broadcast?: BroadcastCodec;
    }
  | {
      /** 選べる字幕。ffmpeg が入口で読んだストリーム一覧から分かるので、1 枚も届いていなくても来る (`captions.ts` の `TrackList`) */
      type: "captions";
      tracks: CaptionTrack[];
      /** いま出しているもの (`CaptionTrack.index`) */
      track: number;
      /**
       * いまの字幕のストリームに載っている言語 (字幕管理データから)。**届くまでは省く**。読めない受け側は
       * 読み飛ばせばよく、そのときは第 1 言語だけが届く
       */
      languages?: CaptionLanguage[];
      /** この視聴者に出している言語 (`CaptionLanguage.index`) */
      language?: number;
    }
  | {
      /**
       * 追っかけ再生の物差し ([docs/stream.md](../../docs/stream.md)、issue #16)。
       * `chase` に答えて `tuned` の直後に来る。
       *
       * **右端は伸び続ける。** 録画中は `recordedSec` を送った時点の値なので、
       * 画面は壁時計で足しながら描く (`finished` になったら止める)
       */
      type: "timeline";
      /** 実際に始まる再生位置 (秒)。リクエストした位置が録れている範囲に収められた後 */
      at: number;
      /** いま録れている長さ (秒) */
      recordedSec: number;
      /** 予定の長さ (秒)。バーの全長。録れたほうが長ければそちらが勝つ */
      totalSec: number;
      /** 録り終わっているか。true なら右端はもう伸びない */
      finished: boolean;
      /**
       * 元の TS で送るとき (`ChaseCommand.raw`)、**録画の先頭の PTS** (90kHz。`ts/seek.ts` の `tsHead`)。画面は届いた
       * PTS からこれを引いて再生位置を出す (`sinceHead`)。バイト数から割り出した位置 (`at`) より正しい。読めなければ省く
       */
      origin?: number;
    }
  | {
      /**
       * 追っかけ再生が**録れているところまで読み切った**。エラーではない。
       * 画面は MediaSource を閉じる (`MediaSource.endOfStream`)。閉じないと、
       * バッファの端で「読み込み中」のまま止まって見える
       */
      type: "ended";
    }
  | {
      /**
       * Hybridcast が載っている番組 (AIT を読んで分かる。[packages/arib/src/ait.ts](../../packages/arib/src/ait.ts))。載っていない局では一度も来ない
       * ([docs/stream.md](../../docs/stream.md#hybridcast))
       */
      type: "hybridcast";
      apps: HybridcastLink[];
    }
  | {
      /**
       * サーバが受け取った時刻と、エンコードしたものの物差しの対応 ([ts/clock.ts](ts/clock.ts))。放送との差
       * (上流も入る) を出すのに要る。PCR と ffmpeg の `start:` がそろってから来る
       */
      type: "clock";
      /** エンコードしたものの物差しの、この時刻が */
      at: number;
      /** サーバがこの時刻 (unix ms) に受け取ったものにあたる */
      unixMs: number;
      /** これを送った時点のサーバの時計 (unix ms)。端末の時計を当てにせず、届いた時刻と突き合わせる */
      now: number;
    }
  | {
      /**
       * **失敗ではないが、リクエストどおりにできなかった**ことの一行。映像は出ている。
       * 「GPU でエンコードできなかったのでソフトウェアでエンコードしている」(`server/live.ts` の `GPU_GAVE_UP`) や、
       * 「サーバが混んでいて画質を下げられなかった」(`rungs.ts` の `busyNote`) など。画面は断り書き (`warning`) に出す
       */
      type: "notice";
      message: string;
    }
  | ({
      /**
       * **送り出しの具合** (`#lib/rungs.ts` の `Pace`。`server/pace.ts`)。2 秒ごとか、塊を捨てた・バッファが動いたときに来る。
       * 回線が細いのか、サーバのエンコードが遅いのかを読み分けて段を決める (`adapt.ts`)
       */
      type: "pace";
    } & Pace)
  | {
      /**
       * **チューナーから外された** (読んでいたストリームが、こちらが畳む前に途切れた)。セッションはここで畳む。
       *
       * いちばん多いのは録画にチューナーを取り上げられたとき (ライブは録画にだけ譲る。docs/agent.md「選ぶ順の約束」)。
       * 画面は同じ局をリクエストし直す。使ってよいチューナーが空いていればそこに入り、見ているものは変わらない。
       * **リクエストし直しても入れなかったときだけ** `recording` の追っかけに切り替える (`live-player.svelte.ts`)。
       * チューナーを取り上げた録画が分からない (録画ではなかった・エージェントに訊けなかった) なら null
       */
      type: "lost";
      recording: YieldedRecording | null;
    }
  | {
      /**
       * **番組が替わって映像・音声・字幕の並び (PMT) が変わった。** セッションはここで畳む (`server/live.ts` の `restart`)。
       * ffmpeg は起きたときの並びのまま音声・字幕を選んでいるので、作り直さないと追従しない。
       * 画面はすぐ同じ局をリクエストし直す (音声を選び直したときと同じ)。追っかけは届いたぶんを観終えてから、
       * 観ていた位置をリクエストし直す (`live-player.svelte.ts` の `resumeChase`)
       */
      type: "restart";
    }
  | {
      type: "error";
      message: string;
      /**
       * **名指しのチューナー (`TuneCommand.tuner`) がエージェントの一覧にもう無い。** 画面は名指しをやめて (`live-tuner.svelte.ts`)、
       * 自動でリクエストし直す (docs/watch.md)
       */
      unpin?: true;
    };

/**
 * **ライブがチューナーを譲った録画** (`Notice` の `lost`、通知の `yielded`)。
 *
 * 読むのはサーバ (`server/live-yield.ts`)。ライブは取り上げられる前に自分の利用者がいたチューナーを覚えておき、
 * 取り上げられたあとでそのチューナーの利用者にいる録画 (`rec <録画ID>`) を名指しする。エージェントは予約を持たない
 */
export interface YieldedRecording {
  /** 録画 ID。追っかけ (`chase` / `GET /api/recordings/<id>/chase`) に渡す */
  id: number;
  /** 番組名 (記号を落としたもの。録画の一覧の `title` と同じ) */
  title: string;
  serviceName: string;
  /** 録り終える時刻 (UNIX ミリ秒。終わりのマージン込み)。それまでそのチューナーは空かない */
  endAt: number;
  /** 録画の放送のコーデック (4K の局の録画 `.mmts` は `hevc`)。追っかけをこの形式で開く */
  broadcast: BroadcastCodec;
}

/**
 * 譲った録画の追っかけを**録れているところの少し手前から**観るときにリクエストする位置 (秒)。
 * サーバは録れている範囲に収める (`server/chase.ts` の `chasePlan`)。ライブの代わりに観るので、先頭からではなく今に近いところ。
 * どの録画よりも長い値 (1 週間) にしてある
 */
export const CHASE_EDGE = 7 * 24 * 60 * 60;

/** 画面に出す Hybridcast のアプリ。データ放送が起動を求めたら denpa の中で開く。ボタンは別のタブで開く */
export interface HybridcastLink {
  /** 放送が付けた名前。入っていなければ空 */
  name: string;
  url: string;
  /** 放送局 (organisation_id) とアプリ (application_id)。起動を求められたときに、どのアプリかの手がかりに使う (受信機の記憶は配信元のオリジンで分ける) */
  organisationId: number;
  applicationId: number;
  /** `true` なら「選局したら勝手に始めよ」(テレビはそうする) */
  autostart: boolean;
}

/**
 * ブラウザ→サーバの指示。
 *
 * **局まで渡す。** 物理チャンネルだけでは、いま流れている番組が引けない
 * (1 つの物理チャンネルに複数の局が入っている)。番組が引けないと、インタレ解除で
 * コマ数を倍にするかどうかを決められない (国内アニメだけ倍にしない)。
 *
 * **音声もここで指定する。** 選び直しは再エンコードになる (下の説明) ので、
 * 選局と同じ指示に乗せる
 */
export type Command =
  | TuneCommand
  | ChaseCommand
  /**
   * データ放送を出す・やめる。
   *
   * **リクエストされてからデコードする。** 見ている人のほとんどは押さないものなので、
   * 全員のぶんをデコードし続ける理由が無い (`server/databroadcast.ts`)。
   * 引き換えに、**押してから出るまでカルーセルが一周するのを待つ**
   */
  | { type: "data"; on: boolean }
  /**
   * 字幕の言語を選ぶ (第何言語か。1〜8)。**再エンコードしない**。字幕のストリーム 1 本に全部の言語が入っていて、
   * サーバは全部デコードしている (`server/captions.ts` の `CaptionText`)。出す言語を視聴者ごとに替えるだけ
   */
  | { type: "language"; language: number }
  /**
   * **追っかけの元の TS を送るのを止めてほしい・続けてほしいときに、画面が送る** (`ChaseCommand.raw` で受けているときだけ効く)。
   * 画面は受信バッファが溜まったときと一時停止している間に `on: true` を、受信バッファが減ったら `on: false` を送る。サーバは `on: true` の間、
   * 録画のファイルを読まずに待つ。サーバは倍速で送り込む (`server/chase.ts`) が、元の TS は捨てると観ていない先が欠けるので、
   * 捨てる代わりにこれで止める
   */
  | { type: "hold"; on: boolean };

/**
 * 追っかけ再生。**録画中の録画を先頭から観る** (issue #16)。
 *
 * チューナーは使わない。録画が書き足している元の TS をサーバが追い読みして、
 * ライブと同じ形式 (fMP4 → この WebSocket) で再エンコードする (`server/chase.ts`)。
 * `raw` なら再エンコードせず、元の TS をそのまま送る (ライブの MPEG-2 と同じ `CHANNEL.rawTs`)。
 *
 * **シークもこれを送り直す。** 元の TS に時間の索引は無いので、飛ぶときは
 * ffmpeg ごと立て直す (ライブの選局し直しと同じ流儀)。バッファに残っている
 * 範囲内なら画面は送らずに `video.currentTime` だけ動かす
 */
type ChaseCommand = {
  type: "chase";
  recordingId: number;
  /** 再生開始位置 (秒)。省くと先頭から */
  at?: number;
  /** どの音声を出すか。`TuneCommand.audio` と同じ理屈 */
  audio?: string;
  /** どのコーデックでエンコードするか。省くと `h264` */
  codec?: LiveCodec;
  /** 何本目の字幕か。省くと 1 本目 */
  caption?: number;
  /** 字幕の第何言語を出すか (1〜8)。省くと第 1 言語 */
  language?: number;
  /** **エンコードせずに元の TS で欲しい** (`TuneCommand.raw` と同じ。`codec` は効かない) */
  raw?: boolean;
  /** 回線に合わせて下げた段 (`TuneCommand.rung` と同じ)。追っかけはもともと枠を使うので、枠が埋まって下げられないことは無い */
  rung?: Rung;
  /** 端末が再生できるコーデック (`TuneCommand.playable` と同じ) */
  playable?: LiveCodec[];
};

type TuneCommand = {
  type: "tune";
  channelType: string;
  channel: string;
  serviceId: number;
  /**
   * どの音声を出すか (`AudioTrack.id`)。省くと先頭 = 主音声。選ぶのはサーバ。複数の音声を入れた fMP4 は
   * ブラウザによって切り替えられない (`audioTracks` の実装がまちまち)
   */
  audio?: string;
  /**
   * どのコーデックでエンコードするか。省くと `h264`。音声と同じで、選び直すと再エンコードになる。
   * `audio` は映像を止めて音声だけにする (回線に合わせて下げる最後の手。`#lib/adapt.ts`)。`rung` を 1〜3 にすると音声は 96k
   */
  codec?: LiveCodec | "audio";
  /** どの字幕を出すか (`CaptionTrack.index`)。省くと 1 本目。字幕は映像と同じ ffmpeg なので、選び直すと再エンコード */
  caption?: number;
  /**
   * 字幕の第何言語を出すか (1〜8)。省くと第 1 言語。**選び直しは `{ type: 'language' }` で** (再エンコードしない)
   */
  language?: number;
  /**
   * **エンコードせずに元の TS で欲しい** ([stream.md](../../docs/stream.md#放送そのままmpeg-2を送る))。
   *
   * コーデックのメニューで MPEG-2 を選ぶか、自動で家の中から開き (`#lib/live-choice.ts`)、ブラウザがデコードできる (`raw/support.ts`) ときに画面がリクエストする。
   * 変換せずに送ると音声は画面が選ぶので、`audio` は選び直しても再エンコードにならない
   */
  raw?: boolean;
  /**
   * **デバッグ用に、このチューナーだけで選局する** (エージェントの `tuner`。設定の「この端末」で選ぶ。`live-tuner.svelte.ts`)。
   * 省くとエージェントが選ぶ。使えなければ、ほかへ振り替えずに理由を返す
   */
  tuner?: string;
  /**
   * **回線に合わせて下げた段** (`#lib/rungs.ts`。0〜3。省くと 0 で、今までと同じ)。1〜3 なら段の高さ・30 コマ・ビットレートの上限で
   * 変換する。コーデックは `codec` ではなく、サーバが `playable` から選んで `tuned` で知らせる。`raw` では効かない。
   * 同じ段を誰も観ていなければその場で変換する本数の枠を使い、埋まっていれば下げない (`tuned` の `rung` と `notice`)
   */
  rung?: Rung;
  /**
   * 端末が再生できるコーデック。段を下げるとき、サーバはこの中から AV1 → H.265 → H.264 の順に GPU でエンコードできる最初のものを選び、
   * 無ければソフトウェアの H.264 にする。省くと `codec` と H.264
   */
  playable?: LiveCodec[];
};

/** WebSocket の宛先 */
export const SOCKET_PATH = "/api/live/socket";

/**
 * WebSocket に繋ぐチケットの寿命 (ms。`server/tickets.ts`)。取ってすぐ繋ぐだけなので短くてよい。
 * 画面は、ページを組むときに受け取ったチケットをこの半分までしか使わない (`live-player.svelte.ts` の `takePageTicket`)。
 * サーバと端末の時計は合わせていないので、端末の時計で受け取ってからの時間を数え、HTML が届くまでのぶんを半分の余裕で覆う
 */
export const TICKET_LIFETIME = 30_000;

/** どの局を、どの音声で開くか。**画面もサーバも同じ形式で扱う** */
export interface Tuned {
  channelType: string;
  channel: string;
  /** 局の内部 ID (`services.id`)。いま流れている番組からコマ数を決めるのに要る */
  serviceId: number;
  /** どの音声を出すか (`AudioTrack.id`)。省くと主音声 */
  audio?: string;
  /**
   * サーバが先回りしてエンコードしている形式 (`server/viewing.ts` の `liveStart`・`warmFormat`)。画面の `tune` は読まず、
   * 形式はメニューの選択 (`choice`) から決め直す (`pickFormat`)。cookie には残さない
   */
  codec?: LiveCodec;
  /** 先回りしている形式が MPEG-2 のままか。`codec` と同じく画面の `tune` は読まない */
  raw?: boolean;
  /**
   * 放送のコーデック (`#lib/live-choice.ts` の `BroadcastCodec`)。省くと MPEG-2。4K の局は `hevc` で、画面は「放送のまま」を
   * HEVC の詰め替えとしてリクエストする (`pickFormat`)。TS に HEVC を入れて送る 4K の局は、局の一覧では分からず、サーバの答え
   * (`tuned` の `broadcast`) で `hevc` にする。開いている間だけで、局を替えると一覧の値に戻る。サーバは `hevc` のときだけ読み
   * (`server/live.ts` の `attend`)、4K の局 (TLV) は局の行の `transport` で決める
   */
  broadcast?: BroadcastCodec;
}

/**
 * 前回見ていた局を覚えておく cookie (`/live` にだけ付ける。中身は局・音声と、コーデックのメニューで選んだもの (`choice`。
 * `#lib/live-choice.ts`) の JSON。前の形式の `codec`・`raw` は読まない)。サーバが読んで、繋いでくる前に
 * エンコードし始める (`server/live.ts` の `warm`)。どの局を開くかはサーバ側 1 箇所で決める (`server/viewing.ts` の `liveStart`)。
 * localStorage と二重に持つと、先にエンコードしたものが使われず別の局が開いていた
 */
export const LAST_COOKIE = "denpa_live_last";
