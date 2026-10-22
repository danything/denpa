/**
 * ライブ視聴で、サーバとブラウザが取り決めていること。**両側から読む。**
 *
 * 1本の WebSocket で全部を一緒に送る ([stream.md](../../docs/stream.md#websocket-プロトコル))。
 *
 *     [1 byte: 種別][8 bytes: 時刻 (90kHz, BE)][中身...]
 *
 * 時刻は**エンコードした mp4 の物差し** — 受け側の `video.currentTime` と直に
 * 突き合わせられる。映像と字幕を**同じ ffmpeg** でエンコードしているので、入口で
 * 0 に寄せる幅が両方に同じだけ効く (`server/captions.ts` に実測)。
 * 別々の ffmpeg でエンコードしていた頃は寄せ幅が違って突き合わせられず、
 * 字幕は時刻ではなく「待たせる量」で合わせていた。
 */

import type { AudioTrack } from "./arib";
import type { CaptionLanguage } from "./caption-text";

/**
 * エンコード方式。**見ながら切り替えられる** (`live/+page.svelte`)。
 *
 * - `h264` … 量を捨てて速さを採る (`server/live.ts` の `videoArgs`)。
 *   **どの端末でも出る**ので既定
 * - `av1` … 量を採る。実機 (Xeon E5-2696 v4、HW エンコーダ無し) でも
 *   1080i をデコードして60コマ/秒で間に合うが、**放送の今から1秒ぶん離れる** —
 *   SVT-AV1 が溜め込むため (`server/live.ts` の `videoArgs` に実測)
 *
 * **どちらがどれだけ小さいかは場面で動く。** どちらも品質を指定してエンコードして
 * いる (ビットレートを決めていない) ので、実測も揃わなかった
 * ([stream.md](../../docs/stream.md#エンコード))
 *
 * **MPEG-2 (放送のまま) はここに並べない。** エンコード方式ではなく「エンコードしない」なので、
 * 画質の切り替えの末尾に別に並べる (`player/settings.ts` の `liveCodecs` の `onraw`)
 * (`TuneCommand.raw`。[stream.md](../../docs/stream.md#放送そのままmpeg-2を送る))
 */
export type LiveCodec = "h264" | "av1";

/** 選べるエンコード方式。画面の切り替えに並べる順そのまま (説明は付けない — 選ぶのは端末の相性だけ) */
export const LIVE_CODECS: { id: LiveCodec; label: string }[] = [
  { id: "h264", label: "H.264" },
  { id: "av1", label: "AV1" },
];

/**
 * 選べる字幕1つぶん。**取り決めなので、ここに置く** — 組み立てるのは
 * サーバ (`server/captions.ts` の `TrackList`) だが、画面も同じ形式で読む
 */
export interface CaptionTrack {
  /** その局の中で何本目か。ffmpeg の `0:p:<局>:s:<これ>` に渡す */
  index: number;
  /** ISO 639-2。放送が名乗っていなければ null */
  lang: string | null;
  /** 「字幕 (日本語)」「字幕2 (英語)」 */
  label: string;
}

/** 多重化の種別。番号は stream.md#websocket-プロトコル の表そのまま */
export const CHANNEL = {
  /** 映像の init セグメント (ftyp + moov) */
  videoInit: 0x00,
  /** 映像の中身 (moof + mdat) */
  videoMedia: 0x01,
  /**
   * **元の TS** (1局に絞っただけ。エンコードしない経路。[stream.md](../../docs/stream.md#放送そのままmpeg-2を送る))。
   * 映像・音声・PAT/PMT が入っていて、受け側が自分でデコードする (`raw/`)。init は無い
   */
  rawTs: 0x02,
  /** 音声の init セグメント。**いまは使わない** (映像と同じコンテナに入れている) */
  audioInit: 0x10,
  /** 音声の中身。同上 */
  audioMedia: 0x11,
  /**
   * **字幕の文字の配置** (JSON。`caption-text.ts` の `CaptionPage`)。サーバが置き場所まで決め、
   * 受け側が描く。前の1枚を丸ごと置き換える (`runs` が空なら消す)。
   * 0x20 (字幕の画像) と 0x21 (字幕を消す) は以前の取り決めで、もう使わない (番号は空けておく)
   */
  captionText: 0x22,
  /** データ放送。第3段階 */
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
      type: "tuned";
      channelType: string;
      channel: string;
      /** MSE に渡す codecs 文字列。エンコード方式から決まる */
      codecs: string;
      /** いまエンコードしているコーデック。画面の切り替えがどれを指すか */
      codec: LiveCodec;
      /** **エンコードせずに元の TS を送るか** (`CHANNEL.rawTs`) */
      raw: boolean;
      /** いまエンコードしている音声 (`AudioTrack.id`) */
      audio: string;
      /** 選べる音声。1つしか無ければ画面は切り替えを出さない */
      audios: AudioTrack[];
    }
  | {
      /**
       * 選べる字幕。**1枚も届いていなくても分かる。**
       *
       * 放送が字幕を持っているかどうかは、ffmpeg が入口で読んだ
       * ストリーム一覧に出ている (`captions.ts` の `TrackList`)。届いてから
       * 出していた頃は、**間隔の空く番組を開くと切り替えが出なかった**。
       * 言語が複数ある放送はここが2本以上になる
       */
      type: "captions";
      tracks: CaptionTrack[];
      /** いま出しているもの (`CaptionTrack.index`) */
      track: number;
      /**
       * いまの字幕のストリームに載っている言語 (字幕管理データから)。**届くまでは省く** — 知らない受け側は
       * 読み飛ばせばよく、そのときは第1言語だけが届く
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
    }
  | {
      /**
       * 追っかけ再生が**録れているところまで読み切った**。エラーではない。
       * 画面は MediaSource を閉じる (`MediaSource.endOfStream`) — 閉じないと、
       * バッファの端で「読み込み中」のまま止まって見える
       */
      type: "ended";
    }
  | {
      /**
       * **Hybridcast が載っている番組。** AIT を読んで分かる
       * ([ts/ait.ts](ts/ait.ts))。
       *
       * 画面は行き先を出し、データ放送が起動を求めたら denpa の中で開きます
       * ([docs/stream.md](../../docs/stream.md#hybridcast))。
       *
       * 載っていない局では**一度も来ません** (PMT に印が無いので、
       * AIT を待つこともしない)
       */
      type: "hybridcast";
      apps: HybridcastLink[];
    }
  | {
      /**
       * **サーバが受け取った時刻と、エンコードしたものの物差しの対応** ([ts/clock.ts](ts/clock.ts))。
       *
       * これが無いと、画面に出せる「遅延」は**手元の貯まりの差**
       * (`buffered.end - currentTime`) だけになります。あれは「あと何秒ぶん
       * 持っているか」であって、放送との差ではありません — 選局から
       * ffmpeg のエンコードの完了、回線まで、**上流でかかった時間はどれも入って
       * いない**。
       *
       * **PCR と ffmpeg の `start:` がそろってから来ます。** それまでは来ないので、
       * 画面は届いてから出す
       */
      type: "clock";
      /** エンコードしたものの物差しの、この時刻が */
      at: number;
      /** サーバがこの時刻 (unix ms) に受け取ったものにあたる */
      unixMs: number;
      /**
       * これを送った時点のサーバの時計 (unix ms)。
       *
       * **端末の時計を当てにしない**ためです。合っていない端末は珍しくなく、
       * ずれていればそのぶんそのまま遅延の数字に出ます。届いた時刻と
       * 突き合わせれば、以降はサーバの時計の上で数えられる
       */
      now: number;
    }
  | {
      /**
       * **失敗ではないが、リクエストどおりにできなかった**ことの一行。映像は出ている。
       * いまは「GPU でエンコードできなかったのでソフトウェアでエンコードしている」だけ (`server/live.ts` の
       * `GPU_GAVE_UP`)。画面は断り書き (`warning`) に出す
       */
      type: "notice";
      message: string;
    }
  | {
      /**
       * **チューナーから外された** (読んでいたストリームが、こちらが畳む前に途切れた)。セッションはここで畳む。
       *
       * いちばん多いのは録画にチューナーを取り上げられたとき (ライブは録画にだけ譲る。docs/agent.md「選ぶ順の約束」)。
       * 画面は同じ局をリクエストし直す — 使ってよいチューナーが空いていればそこに入り、見ているものは変わらない。
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
  | { type: "error"; message: string };

/**
 * **ライブがチューナーを譲った録画** (`Notice` の `lost`、通知の `yielded`)。
 *
 * 読むのはサーバ (`server/live-yield.ts`)。ライブは取り上げられる前に自分の利用者がいたチューナーを覚えておき、
 * 取り上げられたあとでそのチューナーの利用者にいる録画 (`rec <録画ID>`) を名指しする。エージェントは予約を知らない
 */
export interface YieldedRecording {
  /** 録画ID。追っかけ (`chase` / `GET /api/recordings/<id>/chase`) に渡す */
  id: number;
  /** 番組名 (記号を落としたもの。録画の一覧の `title` と同じ) */
  title: string;
  serviceName: string;
  /** 録り終える時刻 (UNIX ミリ秒。終わりのマージン込み)。それまでそのチューナーは空かない */
  endAt: number;
}

/**
 * 譲った録画の追っかけを**録れているところの少し手前から**観るときにリクエストする位置 (秒)。
 * サーバは録れている範囲に収める (`server/chase.ts` の `chasePlan`)。ライブの代わりに観るので、頭からではなく今に近いところ。
 * どの録画よりも長い値 (1週間) にしてある
 */
export const CHASE_EDGE = 7 * 24 * 60 * 60;

/** 画面に出す Hybridcast のアプリ。データ放送が起動を求めたら denpa の中で開く。ボタンは別のタブで開く */
export interface HybridcastLink {
  /** 放送が付けた名前。入っていなければ空 */
  name: string;
  url: string;
  /** 放送局 (organisation_id) とアプリ (application_id)。受信機の記憶をアプリごとに分けるのと、起動の手がかりに使う */
  organisationId: number;
  applicationId: number;
  /** `true` なら「選局したら勝手に始めよ」(テレビはそうする) */
  autostart: boolean;
}

/**
 * ブラウザ→サーバの指示。
 *
 * **局まで渡す。** 物理チャンネルだけでは、いま流れている番組が引けない
 * (1つの物理チャンネルに複数の局が入っている)。番組が引けないと、インタレ解除で
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
   * 字幕の言語を選ぶ (第何言語か。1〜8)。**再エンコードしない** — 字幕のストリーム1本に全部の言語が入っていて、
   * サーバは全部デコードしている (`server/captions.ts` の `CaptionText`)。出す言語を視聴者ごとに替えるだけ
   */
  | { type: "language"; language: number };

/**
 * 追っかけ再生 — **録画中の録画を頭から観る** (issue #16)。
 *
 * チューナーは使わない。録画が書き足している元のTSをサーバが追い読みして、
 * ライブと同じ形式 (fMP4 → この WebSocket) で再エンコードする (`server/chase.ts`)。
 *
 * **シークもこれを送り直す。** 元のTSに時間の索引は無いので、飛ぶときは
 * ffmpeg ごと立て直す (ライブの選局し直しと同じ流儀)。バッファに残っている
 * 範囲内なら画面は送らずに `video.currentTime` だけ動かす
 */
type ChaseCommand = {
  type: "chase";
  recordingId: number;
  /** 再生開始位置 (秒)。省くと頭から */
  at?: number;
  /** どの音声を出すか。`TuneCommand.audio` と同じ理屈 */
  audio?: string;
  /** どのコーデックでエンコードするか。省くと `h264` */
  codec?: LiveCodec;
  /** 何本目の字幕か。省くと1本目 */
  caption?: number;
  /** 字幕の第何言語を出すか (1〜8)。省くと第1言語 */
  language?: number;
};

type TuneCommand = {
  type: "tune";
  channelType: string;
  channel: string;
  serviceId: number;
  /**
   * どの音声を出すか (`AudioTrack.id`)。省くと先頭 = 主音声。
   *
   * **選ぶのはサーバ側。** 音声を全部まとめて送って画面で切り替える手もあるが、
   * MSE は1つのコンテナに複数の音声を入れた fMP4 を、ブラウザによっては
   * 切り替えられない (`audioTracks` の実装がまちまち)。エンコードするときに1本に
   * 決めてしまえば、どのブラウザでも同じように鳴る
   */
  audio?: string;
  /**
   * どのコーデックでエンコードするか。省くと `h264`。
   *
   * **音声と同じで、選び直すと再エンコードになる** (MediaSource から作り直し)。
   * チャンネルは変わらないのでチューナーはそのまま
   */
  codec?: LiveCodec;
  /**
   * どの字幕を出すか (`CaptionTrack.index`)。省くと1本目。
   *
   * **言語が複数ある放送はたまにある。** 音声と同じで、選び直すと再エンコードに
   * なる — 字幕は映像と同じ ffmpeg でエンコードしている (`server/live.ts` の
   * `encodeArgs`)。そうしないと時刻が揃わない
   */
  caption?: number;
  /**
   * 字幕の第何言語を出すか (1〜8)。省くと第1言語。**選び直しは `{ type: 'language' }` で** (再エンコードしない)
   */
  language?: number;
  /**
   * **エンコードせずに元の TS で欲しい** ([stream.md](../../docs/stream.md#放送そのままmpeg-2を送る))。
   *
   * 画質の切り替えで MPEG-2 を選び (`player/settings.ts` の `liveCodecs` の `onraw`)、ブラウザがデコードできる (`raw/support.ts`) ときに画面がリクエストする。
   * 変換せずに送ると音声は画面が選ぶので、`audio` は選び直しても再エンコードにならない
   */
  raw?: boolean;
};

/** WebSocket の宛先 */
export const SOCKET_PATH = "/api/live/socket";

/** どの局を、どの音声で開くか。**画面もサーバも同じ形式で扱う** */
export interface Tuned {
  channelType: string;
  channel: string;
  /** 局の内部ID (`services.id`)。いま流れている番組からコマ数を決めるのに要る */
  serviceId: number;
  /** どの音声を出すか (`AudioTrack.id`)。省くと主音声 */
  audio?: string;
  /** どのコーデックでエンコードするか。省くと `h264` */
  codec?: LiveCodec;
  /** MPEG-2 のままリクエストするか (`TuneCommand.raw`)。**覚えておくのは、次に開くときに先回りするため** (`server/live.ts` の `warm`) */
  raw?: boolean;
}

/**
 * 前回見ていた局を覚えておく cookie。中身は `Tuned` の JSON。
 *
 * **cookie にするのは、サーバにも読めるようにするため。** 画面を組む時点で
 * 「これからどの局を開くか」が分かっていないと、**繋いでくる前にエンコードし始め
 * られない** (`server/live.ts` の `warm`)。
 *
 * **どの局を開くかを決めるのはサーバ側1箇所** (`live/+page.server.ts`)。
 * 画面はそこで決まったものを開くだけなので、localStorage には持たない —
 * 二重に持つと、決め方がずれたときに**先にエンコードしたものが使われず、画面は
 * 別の局を開く**という形で静かに壊れる。
 *
 * `/live` にだけ付ける。他の画面の要求に毎回ぶら下げるものではない
 */
export const LAST_COOKIE = "denpa_live_last";
