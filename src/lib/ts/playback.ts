/**
 * **録画の観方の取り決め** (`GET /api/recordings/<id>/playback` と `/stream`)。画面にもサーバにも依らない。
 *
 * 分担: **サーバは「何を出せるか・どの形式で出すか・時刻の物差し」を決める。画面は「どれを使うか」を
 * 決める** (端末で再生できるか、人が選んだコーデック)。決め方は `server/playback.ts`。
 * テレビのアプリは再生できる形式 (`?playable=`) を送り、サーバが同じ `pickOffer` で選んで `auto` で返す (`autoPick`)
 */

import { codecsFor, type LiveCodec } from "../live";
import {
  autoOrder,
  type BroadcastCodec,
  type LiveFormat,
} from "../live-choice";
import type { Ruler } from "./watch";

/** 出せる映像の形式。H.265 はエンコード済みがあるとき (ファイルそのままと詰め替え) と、4K の局の元の録画 (放送の HEVC の詰め替え) だけ。その場の変換では作らない */
export type PlayCodec = "h264" | "hevc" | "av1" | "mpeg2";

/**
 * 出し方。
 *
 * - `file` … エンコード済みのファイルそのまま (`/api/recordings/<id>/file?source=`)。Range で読む
 * - `stream` … サーバがその場で fMP4 にして流す (`/stream?codec=`)。エンコード済みと同じコーデックなら
 *   詰め替えるだけ、違えばエンコードし直す。シークは `from` を変えてリクエストし直す
 * - `raw` … 元の TS を飛び先から流す (`/stream?codec=mpeg2`)。画面が自分で再生する
 */
type PlayWay = "file" | "stream" | "raw";

/** 配るファイルの名指し (`#lib/source.ts` の `FileSource` のうち、エンコード済み) */
export type EncodedSource = "encoded" | "hevc" | "alt";

export interface PlayOffer {
  codec: PlayCodec;
  way: PlayWay;
  /** `file` のとき、どのファイルか */
  source?: EncodedSource;
  /**
   * 中身の codecs (`avc1.640028,opus`)。`file` は入れ物 (Matroska / WebM) の、`stream` は fMP4 の。
   * 画面が `canPlayType` / `isTypeSupported` に聞くのに使う。`file` で中身を読めなかったときは無い
   */
  codecs?: string;
}

export interface PlayAudio {
  /** `/stream?audio=` に渡すもの */
  id: string;
  /** 画面に出す名前。無名は空 */
  label: string;
}

/**
 * 時刻の物差し。**1 ページで 1 つ。** 字幕・チャプター (CM 飛ばし)・データ放送・続きの位置・`/stream` の
 * `from` とストリームの時刻は、どれもこれで数える。
 *
 * - `encoded` … エンコード済みのファイルの時刻
 * - `ts` … 元の TS の先頭を 0 とした時刻 (エンコード済みが無い録画)
 */
export type PlayAxis = "encoded" | "ts";

export interface PlaybackInfo {
  /** 尺 (秒)。物差しの上の長さ */
  duration: number;
  axis: PlayAxis;
  audios: PlayAudio[];
  /** 出せるもの。並びに意味は無い (どれを使うかは画面が決める) */
  offers: PlayOffer[];
  /**
   * 物差しの時刻を元の TS の時刻に戻すための情報 (`ts/watch.ts` の `Ruler`。`toTsTime`)。**`axis` が `encoded` のときだけ。**
   * 元の TS の時刻に録画の先頭の放送時刻 (`GET /api/recordings/<id>` の `jikkyo.head`) を足すと、その場面の放送時刻になる
   * (アプリが実況のコメントを場面に合わせる。docs/api.md)
   */
  ruler?: Ruler;
  /** サーバが選んだ観方 (`autoPick`)。**`?playable=` を付けて聞いたときだけ**ある。選べなければ null */
  auto?: AutoPick | null;
  /**
   * 放送のままのコーデック。**4K の局の元の録画 (`.mmts`) だけ** `hevc` (放送の HEVC の詰め替え)。省けば MPEG-2。
   * 録画しか無いときの「自動」の順で、MPEG-2 の場所に HEVC を入れる (`autoOrder`。ライブの 4K の局と同じ)
   */
  broadcast?: BroadcastCodec;
}

/**
 * **サーバが選んだ観方** (`GET /api/recordings/<id>/playback?playable=` の `auto`。テレビのアプリ向け)。
 * `file` は `file?source=`、`stream` は `stream?codec=`、`raw` は `stream?codec=mpeg2` で開く
 */
type AutoPick =
  | { way: "file"; codec: PlayCodec; source: EncodedSource }
  | { way: "stream"; codec: LiveCodec }
  | { way: "raw"; codec: "mpeg2" };

/**
 * MPEG-2 をそのまま流すときの応答ヘッダ。**物差しの 0 にあたる PTS** (90kHz、0〜2^33-1)。
 * 元の TS の先頭の PTS に、エンコードしたときに先頭で捨てた長さ (`encode_skip`) を足したもの。
 * 画面の時刻 = (PTS − これ) を一周の中で取って 90000 で割ったもの (`ts/seek.ts` の `sinceHead`)
 */
export const ORIGIN_HEADER = "X-Denpa-Origin";

/**
 * 流すときの応答ヘッダ (`stream`・`chase`・`live`)。**中身の形式** (`h264` / `hevc` / `av1`、音声だけなら `audio`、
 * 放送のままの TS なら `raw`。`stream?codec=mpeg2` も `raw`)。段を下げたとき (`?rung=`) と `codec=auto` はサーバが `?playable=` から
 * 選ぶので、画面はこれで MSE に渡す codecs を決める (`#lib/live.ts` の `codecsFor`)
 */
export const CODEC_HEADER = "X-Denpa-Codec";

/** fMP4 で流すときの応答ヘッダ。**いまの段** (`#lib/rungs.ts`。0〜3)。0 なら下げていない */
export const RUNG_HEADER = "X-Denpa-Rung";

/**
 * `stream` の応答ヘッダ。**送り出しの具合を読む id** (`GET /api/playback/pace?id=`。中身は `#lib/rungs.ts` の `Pace`)。
 * 閉じたあとは 404
 */
export const PACE_HEADER = "X-Denpa-Pace";

/** 音声だけの fMP4 (`?codec=audio`) を MSE に渡す型。サーバは AAC にする (`server/playback.ts` の `audioOnlyArgs`) */
export const AUDIO_TYPE = 'audio/mp4; codecs="mp4a.40.2"';

/**
 * `CODEC_HEADER` の値から、MSE に渡す型を決める。段を下げた変換 (`?rung=`) はサーバがコーデックを選ぶので、
 * 画面は応答を受けてから型を決める。読めない値なら null
 */
export function typeOfCodec(codec: string | null): string | null {
  if (codec === "h264" || codec === "hevc" || codec === "av1")
    return codecsFor(codec);
  return codec === "audio" ? AUDIO_TYPE : null;
}

/** `codec=auto` で、端末が再生できる形式 (`?playable=`) から選べるものが無かったときの言い分 (406) */
export const NO_FORMAT = "再生できる形式がありません";

/** 混んでいて断ったときの言い分 (503) */
export const BUSY = "サーバが混んでいます";

/** サーバが「混んでいます」と断ったか (`server/playback.ts` の 503)。デプロイの最中の 503 (前段が返すもの) とは言い分で見分ける */
export async function busyAnswer(response: Response): Promise<boolean> {
  try {
    return ((await response.json()) as { message?: unknown }).message === BUSY;
  } catch {
    return false;
  }
}

/*
 * ---------------------------------------------------------------------------
 * 切れたときのリクエストし直し。**`<video>` でファイルを読むとき (観る画面の `recover`)・MSE で流すとき
 * (`remux-player.ts`)・canvas に描くとき (`canvas-player.ts`) で同じ数にする**
 * ---------------------------------------------------------------------------
 */

/** 流しているものの様子。流れている・繋ぎ直している・打ち切った・混んでいて断られた */
export type StreamState = "flowing" | "retrying" | "failed" | "busy";

/** 続けてリクエストし直す上限 */
export const STREAM_RETRIES = 8;

/** `retries` 回リクエストし直したあと、次にリクエストするまで待つ時間 (ms)。倍々に伸ばして 10 秒で頭打ち (デプロイの入れ替えは数十秒かかる) */
export function retryWait(retries: number): number {
  return Math.min(10_000, 1000 * 2 ** retries);
}

/** リクエストし直せば直りうる失敗か (繋がらない・途中で落ちた・サーバの 5xx)。4xx・読めない中身は何度やっても同じ */
export function retryable(error: unknown): boolean {
  return (
    error instanceof TypeError || String(error).startsWith("Error: HTTP 5")
  );
}

/** 画面が選べるコーデック。`auto` は端末に合わせて決める (`pickOffer`) */
export type CodecChoice = "auto" | "h264" | "hevc" | "av1";

/** ブラウザに問い合わせる関数。**テストで差し替えられるように**受け取る */
export interface MediaAbility {
  /** `<video>` にそのまま渡して読めるか (`canPlayType` が空でない) */
  play(type: string): boolean;
  /** MSE が受け取れるか (`isTypeSupported`)。MediaSource が無ければ false */
  mse(type: string): boolean;
  /** 元の TS (MPEG-2) をこの端末でデコードできるか (`raw/support.ts` の `rawUnsupported`)。省けばできない */
  mpeg2?: boolean;
}

/**
 * どれで観るか。`raw` は元の TS をそのまま流してこの端末でデコードする (`canvas-player.ts` の `ts-mpeg2`。
 * 互換モードと同じく canvas に描く)
 */
export type Picked =
  | { way: "file"; codec: PlayCodec; source: EncodedSource }
  | { way: "stream"; codec: "h264" | "hevc" | "av1"; type: string }
  | { way: "raw"; codec: "mpeg2" };

/** 元の TS をそのまま流せて、この端末でデコードできるか */
function playsRaw(info: PlaybackInfo, can: MediaAbility): boolean {
  return (
    can.mpeg2 === true &&
    info.offers.some((offer) => offer.way === "raw" && offer.codec === "mpeg2")
  );
}

const RAW: Picked = { way: "raw", codec: "mpeg2" };

/**
 * そのままのファイルを読めるか。Matroska と WebM の両方で聞く。Chrome は `video/x-matroska` に答えるが、
 * Safari は WebM としてしか答えない (AV1 の Matroska はそれで読める)。中身が分からないものは false
 */
function playsFile(offer: PlayOffer, can: MediaAbility): boolean {
  if (offer.way !== "file" || offer.codecs === undefined) return false;
  return (
    can.play(`video/x-matroska; codecs="${offer.codecs}"`) ||
    can.play(`video/webm; codecs="${offer.codecs}"`)
  );
}

/** MSE に渡す型 */
function streamType(offer: PlayOffer): string {
  return `video/mp4; codecs="${offer.codecs ?? ""}"`;
}

function playsStream(offer: PlayOffer, can: MediaAbility): boolean {
  return (
    offer.way === "stream" &&
    offer.codecs !== undefined &&
    can.mse(streamType(offer))
  );
}

function asPicked(offer: PlayOffer): Picked | null {
  if (offer.way === "file" && offer.source !== undefined) {
    return { way: "file", codec: offer.codec, source: offer.source };
  }
  if (offer.way === "stream" && offer.codec !== "mpeg2") {
    return { way: "stream", codec: offer.codec, type: streamType(offer) };
  }
  return null;
}

/**
 * エンコード済みを選ぶ順。**AV1 → H.265 → H.264** (小さくなる順。主を選ぶ順 `#lib/hw.ts` の `HW_CODECS` と同じ)。
 * 「自動」の順はライブ・追っかけと同じ関数から出す (`#lib/live-choice.ts` の `autoOrder`)。観る画面・端末に保存・
 * テレビのアプリで同じ順にする
 */
export const ENCODED_ORDER = autoOrder("encoded");

/** `autoOrder` の形式をコーデックの名前に (放送のままは MPEG-2) */
function asCodecs(order: readonly LiveFormat[]): PlayCodec[] {
  return order.map((format) => (format === "raw" ? "mpeg2" : format));
}

/** `order` の順に並べ替える。並びに無いものは後ろ、同じコーデックの中では元の並びのまま */
function byOrder(
  offers: PlayOffer[],
  order: readonly PlayCodec[],
): PlayOffer[] {
  const rank = (codec: PlayCodec) => {
    const at = order.indexOf(codec);
    return at === -1 ? order.length : at;
  };
  return [...offers].sort((a, b) => rank(a.codec) - rank(b.codec));
}

/**
 * **どれで観るか。** 人が選んだコーデックがあれば、それを観られる方法 (ファイルそのまま → その場で流す。MPEG-2 は元の TS)。
 * 観られなければ、または `auto` なら端末に合わせる。
 *
 * **録画しか無い (エンコード済みが無い) ときは、ライブ・追っかけと同じ「その場でエンコード」の順** (`autoOrder`。家の中なら
 * MPEG-2 → H.264 → AV1、外なら AV1 → H.264。`autoOrder` の H.265 は、サーバが H.265 に変換しないので選ばれない)。4K の局の録画
 * (`broadcast` が `hevc`) は MPEG-2 の場所に放送の HEVC の詰め替えが入る (家の中なら HEVC → H.264 → AV1)。エンコード済みがあるときは次の順。
 *
 * 1. **そのまま読めるファイル** (AV1 → H.265 → H.264。小さいほうが先。同じ画質なら回線もディスクも使わない)
 * 2. MSE が受け取れる**詰め替え** (エンコード済みと同じコーデック。サーバは軽い。並びは 1 と同じ)
 * 3. MSE が受け取れる**変換** (ライブ・追っかけと同じ「その場でエンコード」の順。家の中なら H.264 → AV1、外なら AV1 → H.264。
 *    サーバはその場でエンコードする。H.265 のストリームは詰め替えだけなので 2 に入る)
 * 4. 中身が分からないファイル (ffprobe が読めなかった) をそのまま渡す。読めなければ観る画面が観られる先を案内する
 *
 * エンコード済みがあるときの自動は MPEG-2 を選ばない (元の TS が残っていれば、選べば観られる)。何も無ければ null
 *
 * @param indoor 開いた名前が家の中か (`#lib/host.ts` の `indoorHost`)。録画しか無いときの順に効く
 */
export function pickOffer(
  info: PlaybackInfo,
  can: MediaAbility,
  choice: CodecChoice | "mpeg2" = "auto",
  indoor = false,
): Picked | null {
  const files = byOrder(
    info.offers.filter((offer) => offer.way === "file"),
    ENCODED_ORDER,
  );
  const streams = info.offers.filter((offer) => offer.way === "stream");
  const raw = playsRaw(info, can);
  if (choice === "mpeg2") {
    if (raw) return RAW;
  } else if (choice !== "auto") {
    const file = files.find(
      (offer) => offer.codec === choice && playsFile(offer, can),
    );
    const stream = streams.find(
      (offer) => offer.codec === choice && playsStream(offer, can),
    );
    const chosen = file ?? stream;
    if (chosen !== undefined) return asPicked(chosen);
  }
  if (files.length === 0) {
    for (const format of autoOrder({
      indoor,
      compat: false,
      ...(info.broadcast === undefined ? {} : { broadcast: info.broadcast }),
    })) {
      if (format === "raw") {
        if (raw) return RAW;
        continue;
      }
      const stream = streams.find(
        (offer) => offer.codec === format && playsStream(offer, can),
      );
      if (stream !== undefined) return asPicked(stream);
    }
    return null;
  }
  const order = [
    ...files.filter((offer) => playsFile(offer, can)),
    ...byOrder(
      streams.filter(
        (offer) => playsStream(offer, can) && hasFile(info, offer.codec),
      ),
      ENCODED_ORDER,
    ),
    ...byOrder(
      streams.filter((offer) => playsStream(offer, can)),
      asCodecs(autoOrder({ indoor, compat: false })),
    ),
    ...files,
  ];
  const first = order[0];
  return first === undefined ? null : asPicked(first);
}

/** codecs の文字列 (`av01.0.08M.08,opus`) の映像のコーデック。読めなければ null */
function videoCodecOf(type: string): LiveCodec | null {
  const head = /codecs="([^".,]*)/.exec(type)?.[1]?.toLowerCase();
  if (head === "av01") return "av1";
  if (head === "hvc1" || head === "hev1") return "hevc";
  if (head === "avc1" || head === "avc3") return "h264";
  return null;
}

/**
 * **端末が再生できる形式 (`?playable=`) を、`pickOffer` に渡す問い合わせにする。** ファイルそのままも fMP4 も、
 * 映像のコーデックが並びにあれば再生できるとみなす (テレビのアプリは Matroska も fMP4 も同じデコーダで読む)。
 * `raw` は元の TS (MPEG-2)
 */
export function playableAbility(formats: readonly LiveFormat[]): MediaAbility {
  const has = (type: string) => {
    const codec = videoCodecOf(type);
    return codec !== null && formats.includes(codec);
  };
  return { play: has, mse: has, mpeg2: formats.includes("raw") };
}

/**
 * **サーバが選ぶ観方** (`playback?playable=` の `auto`)。ブラウザの「自動」と同じ `pickOffer` で選ぶ。
 * `pickOffer` の最後の手 (中身が分からないファイルをそのまま渡す) は、コーデックが並びにあるときだけ使う。
 * 端末が再生できる形式に無いものは返さない。選べなければ null
 */
export function autoPick(
  info: PlaybackInfo,
  formats: readonly LiveFormat[],
  indoor: boolean,
): AutoPick | null {
  const picked = pickOffer(info, playableAbility(formats), "auto", indoor);
  if (picked === null) return null;
  if (picked.way === "raw") return picked;
  if (picked.codec === "mpeg2" || !formats.includes(picked.codec)) return null;
  return picked.way === "file"
    ? { way: "file", codec: picked.codec, source: picked.source }
    : { way: "stream", codec: picked.codec };
}

/**
 * **音声を選ぶために、その場で流すほうへ移るときの行き先。** ファイルをそのまま読んでいて、ブラウザが
 * 入れ物の音声を出さない (`video.audioTracks` が無い。Chrome・Firefox の既定) ときに使う。
 * そのままでは 2 本目の音声 (副音声・解説) を選べない。流すほうはサーバが選んだ 1 本を流す (`/stream?audio=`)。
 *
 * 同じコーデックの詰め替え (サーバは軽い) を先に、無ければサーバが並べた順で先頭の変換。MSE が
 * 受け取れるものが無ければ null (= 移れないので、音声の切り替えは出さない)
 */
export function streamForAudio(
  info: PlaybackInfo,
  can: MediaAbility,
  codec: PlayCodec,
): Picked | null {
  const streams = info.offers.filter((offer) => playsStream(offer, can));
  const chosen = streams.find((offer) => offer.codec === codec) ?? streams[0];
  return chosen === undefined ? null : asPicked(chosen);
}

/**
 * **コーデックのメニューの並び。** `ENCODED_ORDER` (AV1 → H.265 → H.264) の後ろに MPEG-2。
 * ライブ・追っかけのメニュー (`components/player/settings.ts` の `liveCodecs`) と同じ並びにする。
 * 選ぶ順 (`pickOffer`・`pickCanvas`) とは別で、並べるだけに使う
 */
export const MENU_ORDER: readonly PlayCodec[] = [...ENCODED_ORDER, "mpeg2"];

/**
 * **コーデックのメニューに並べるもの。** この端末で観られる方法があるコーデックを `MENU_ORDER` の順に。
 * H.265 はエンコード済みがある録画と 4K の局の元の録画にだけある (その場の変換では作らない)。MPEG-2 は元の TS が残っていて、この端末で
 * デコードできるときだけ。`hidden` は並べない (メニューは `#lib/live-choice.ts` の `WATCH_HIDDEN_CODECS` を渡す。
 * 混んでいるときに勧めるものは全部から選ぶので渡さない)。外すのはメニューだけで、自動 (`pickOffer`) は今までどおり選ぶ
 */
export function codecChoices(
  info: PlaybackInfo,
  can: MediaAbility,
  hidden: readonly PlayCodec[] = [],
): PlayCodec[] {
  return MENU_ORDER.filter((codec) =>
    codec === "mpeg2"
      ? playsRaw(info, can)
      : !hidden.includes(codec) &&
        info.offers.some(
          (offer) =>
            offer.codec === codec &&
            (playsFile(offer, can) || playsStream(offer, can)),
        ),
  );
}

/*
 * ---------------------------------------------------------------------------
 * 互換モード (`canvas-video.ts`)。**`<video>` を使わず canvas に描く** (`canvas-player.ts`)。
 * サーバから使えるのは流すもの (`stream` の fMP4 と `raw` の元の TS) だけで、ファイルそのままは使わない
 * (端末に保存した Matroska は別の経路で読む。`src/lib/mkv-source.ts`)
 * ---------------------------------------------------------------------------
 */

/**
 * 互換モードで描く形式。**H.265 は描かない。** 描く側 (`raw/support.ts`) は H.264・AV1・MPEG-2 しか
 * 問い合わせない (`ts/fmp4.ts` は H.265 も読むが、サーバが送り出した映像の長さを数えるため)。
 * H.265 だけの録画も、AV1 か H.264 に変換して流せば描ける
 */
export type CanvasCodec = Exclude<PlayCodec, "hevc">;

/** この端末で描ける形式 (`raw/support.ts` の `canvasSupport` と `rawUnsupported`) */
export type CanvasAbility = Record<CanvasCodec, boolean>;

/** 互換モードのメニューに並べるもの。**出せるものは描けなくても並べる** (押せなくして、理由を添える) */
export function canvasChoices(
  info: PlaybackInfo,
  can: CanvasAbility,
): { codec: CanvasCodec; drawable: boolean }[] {
  return (["h264", "av1", "mpeg2"] as const)
    .filter((codec) =>
      info.offers.some(
        (offer) =>
          offer.codec === codec &&
          offer.way === (codec === "mpeg2" ? "raw" : "stream"),
      ),
    )
    .map((codec) => ({ codec, drawable: can[codec] }));
}

/**
 * **互換モードでどれで観るか。** 選んだものが描ければそれ。`auto` か、選んだものが描けなければ次の順。
 *
 * 1. エンコード済みと同じ形式の fMP4 (詰め替え。サーバは軽い)
 * 2. ライブの互換モードと同じ順 (`autoOrder`。変換する AV1 → H.264 → 元の TS の MPEG-2)
 *
 * `avoid` は打ち切った形式 (描いている途中で間に合わなくなった)。何も描けなければ null
 */
export function pickCanvas(
  info: PlaybackInfo,
  can: CanvasAbility,
  choice: CodecChoice | "mpeg2" = "auto",
  avoid: readonly CanvasCodec[] = [],
): CanvasCodec | null {
  const usable = canvasChoices(info, can)
    .filter((item) => item.drawable && !avoid.includes(item.codec))
    .map((item) => item.codec);
  if (choice !== "auto" && choice !== "hevc" && usable.includes(choice))
    return choice;
  const light = usable.filter((c) => c !== "mpeg2" && hasFile(info, c));
  // 互換モードの順は家の中か外かで変わらない
  const order = asCodecs(autoOrder({ indoor: false, compat: true }));
  const rest = order.filter((c): c is CanvasCodec =>
    usable.includes(c as CanvasCodec),
  );
  return [...light, ...rest][0] ?? null;
}

/** その形式のエンコード済みのファイルがあるか (無ければ、流すときにサーバがその場でエンコードする) */
function hasFile(info: PlaybackInfo, codec: PlayCodec): boolean {
  return info.offers.some(
    (offer) => offer.way === "file" && offer.codec === codec,
  );
}

/** 互換モードで、その形式で観るとサーバがその場でエンコードするか (枠を使う。混んでいると断られる) */
export function canvasTranscodes(
  info: PlaybackInfo,
  codec: CanvasCodec,
): boolean {
  return codec !== "mpeg2" && !hasFile(info, codec);
}

/**
 * 選んだもので観るとき、サーバがその場でエンコードするか (枠を使う。混んでいると断られる)。
 * 4K の局の元の録画の H.265 (`broadcast` が `hevc`) は放送の HEVC の詰め替えで、エンコードしない
 */
export function transcodes(info: PlaybackInfo, picked: Picked): boolean {
  if (picked.way !== "stream" || hasFile(info, picked.codec)) return false;
  return !(picked.codec === "hevc" && info.broadcast === "hevc");
}

/** `TimeRanges` を配列にしたもの (`[始まり, 終わり]` 秒) */
export type Ranges = readonly (readonly [number, number])[];

/** `t` を含む区間の終わり (秒)。含む区間が無ければ null */
function endAround(ranges: Ranges, t: number): number | null {
  for (const [start, end] of ranges) {
    if (start <= t + GAP && t < end) return end;
  }
  return null;
}

/** `t` を含む区間の、`t` から先に溜まっている長さ (秒)。含む区間が無ければ 0 */
export function aheadOf(ranges: Ranges, t: number): number {
  const end = endAround(ranges, t);
  return end === null ? 0 : end - t;
}

/**
 * 区間どうしの小さな隙間は無いものと見る (秒)。映像と音声の先頭が数十 ms ずれるぶん
 * (音声の先頭は AAC の前置きぶん早い) と、ブラウザが跨いで再生する程度の隙間
 */
const GAP = 0.5;

/**
 * 飛んだ先 `t` を、**リクエストし直さずに待てば届くか。**
 *
 * - いま溜まっている区間の中なら、そのまま
 * - 読んでいる最中 (`from` からリクエストしたストリームが伸びている) で、その伸びる先の少し先
 *   (`slack` 秒) までなら待つ。10 秒送りのたびにリクエストし直すと、毎回キーフレームまで戻って
 *   詰め直すぶん遅い
 *
 * @param from 読んでいるストリームのリクエストした位置。読んでいなければ null
 */
export function covers(
  ranges: Ranges,
  t: number,
  from: number | null,
  slack: number,
): boolean {
  if (aheadOf(ranges, t) > 0) return true;
  if (from === null || t < from - GAP) return false;
  // リクエストした位置から伸びている区間の末尾。まだ何も届いていなければリクエストした位置
  let end = from;
  for (const [start, stop] of ranges) {
    if (start <= from + GAP && stop >= from) end = Math.max(end, stop);
  }
  return t <= end + slack;
}

/**
 * **段を切り替えるときに、新しいストリームを始める位置** (`remux-player.ts` の `switchTo`)。いまの位置を含む区間の末尾で、
 * それより前に溜まっているものはそのまま再生する。いまの位置が溜まっていなければ、いまの位置。
 *
 * 区間の途中で切ると、残したコマが参照するコマ (後ろの P フレーム) まで消えることがある。末尾なら、残すものは揃っている
 */
export function switchPoint(ranges: Ranges, t: number): number {
  return endAround(ranges, t) ?? t;
}
