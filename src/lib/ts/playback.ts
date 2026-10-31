/**
 * **録画の観方の取り決め** (`GET /api/recordings/<id>/playback` と `/stream`)。画面にもサーバにも依らない。
 *
 * 分担: **サーバは「何を出せるか・どの形式で出すか・時刻の物差し」を決める。画面は「どれを使うか」を
 * 決める** (端末で再生できるか、人が選んだコーデック、MPEG-2 をそのまま再生する設定)。サーバは
 * 端末が何かを知らない。決め方は `server/playback.ts`
 */

/** 出せる映像の形式。H.265 はエンコード済みがあるときだけ (ファイルそのままと詰め替え。その場の変換では作らない) */
export type PlayCodec = "h264" | "hevc" | "av1" | "mpeg2";

/**
 * 出し方。
 *
 * - `file` … エンコード済みのファイルそのまま (`/api/recordings/<id>/file?source=`)。Range で読む
 * - `stream` … サーバがその場で fMP4 にして流す (`/stream?codec=`)。エンコード済みと同じコーデックなら
 *   詰め替えるだけ、違えばエンコードし直す。シークは `from` を変えてリクエストし直す
 * - `raw` … 元の TS を飛び先から流す (`/stream?codec=mpeg2`)。画面が自分で再生する
 */
export type PlayWay = "file" | "stream" | "raw";

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
 * - `ts` … 元の TS の頭を 0 とした時刻 (エンコード済みが無い録画)
 */
export type PlayAxis = "encoded" | "ts";

export interface PlaybackInfo {
  /** 尺 (秒)。物差しの上の長さ */
  duration: number;
  axis: PlayAxis;
  audios: PlayAudio[];
  /** 出せるもの。並びに意味は無い (どれを使うかは画面が決める) */
  offers: PlayOffer[];
}

/**
 * MPEG-2 をそのまま流すときの応答ヘッダ。**物差しの 0 にあたる PTS** (90kHz、0〜2^33-1)。
 * 元の TS の頭の PTS に、エンコードしたときに捨てた頭 (`encode_skip`) を足したもの。
 * 画面の時刻 = (PTS − これ) を一周の中で取って 90000 で割ったもの (`ts/seek.ts` の `sinceHead`)
 */
export const ORIGIN_HEADER = "X-Denpa-Origin";

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

/** 流しているものの様子。流れている・繋ぎ直している・諦めた・混んでいて断られた */
export type StreamState = "flowing" | "retrying" | "failed" | "busy";

/** 続けてリクエストし直す上限 */
export const STREAM_RETRIES = 8;

/** `retries` 回リクエストし直したあと、次にリクエストするまで待つ時間 (ms)。倍々に伸ばして 10秒で頭打ち (デプロイの入れ替えは数十秒かかる) */
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

/** ブラウザに問い合わせる関数。**試しで差し替えられるように**受け取る */
export interface MediaAbility {
  /** `<video>` にそのまま渡して読めるか (`canPlayType` が空でない) */
  play(type: string): boolean;
  /** MSE が受け取れるか (`isTypeSupported`)。MediaSource が無ければ false */
  mse(type: string): boolean;
}

/** どれで観るか */
export type Picked =
  | { way: "file"; codec: PlayCodec; source: EncodedSource }
  | { way: "stream"; codec: "h264" | "hevc" | "av1"; type: string };

/**
 * そのままのファイルを読めるか。Matroska と WebM の両方で聞く — Chrome は `video/x-matroska` に答えるが、
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
export function streamType(offer: PlayOffer): string {
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
 * 観る画面・端末に保存・テレビのアプリで同じ順にする
 */
export const ENCODED_ORDER = ["av1", "hevc", "h264"] as const;

/** `ENCODED_ORDER` の順に並べ替える (同じコーデックの中では元の並びのまま) */
function byEncodedOrder(offers: PlayOffer[]): PlayOffer[] {
  const rank = (codec: PlayCodec) => {
    const at = (ENCODED_ORDER as readonly PlayCodec[]).indexOf(codec);
    return at === -1 ? ENCODED_ORDER.length : at;
  };
  return [...offers].sort((a, b) => rank(a.codec) - rank(b.codec));
}

/**
 * **どれで観るか。** 人が選んだコーデックがあれば、それを観られる方法 (ファイルそのまま → その場で流す)。
 * 観られなければ、または `auto` なら端末に合わせる:
 *
 * 1. **そのまま読めるファイル** (AV1 → H.265 → H.264。小さいほうが先 — 同じ画質なら回線もディスクも食わない)
 * 2. MSE が受け取れる**詰め替え** (エンコード済みと同じコーデック。サーバは軽い。並びは 1 と同じ)
 * 3. MSE が受け取れる**変換** (H.264 → AV1 の順。サーバはその場でエンコードする。H.265 には変換しない)
 * 4. 中身が分からないファイル (ffprobe が読めなかった) をそのまま渡す。読めなければ観る画面が観られる先を案内する
 *
 * MPEG-2 (`raw`) はここでは選ばない (そのまま再生する方式は画面の設定で別に決める)。何も無ければ null
 */
export function pickOffer(
  info: PlaybackInfo,
  can: MediaAbility,
  choice: CodecChoice = "auto",
): Picked | null {
  const files = byEncodedOrder(
    info.offers.filter((offer) => offer.way === "file"),
  );
  const streams = info.offers.filter((offer) => offer.way === "stream");
  if (choice !== "auto") {
    const file = files.find(
      (offer) => offer.codec === choice && playsFile(offer, can),
    );
    const stream = streams.find(
      (offer) => offer.codec === choice && playsStream(offer, can),
    );
    const chosen = file ?? stream;
    if (chosen !== undefined) return asPicked(chosen);
  }
  const order = [
    ...files.filter((offer) => playsFile(offer, can)),
    ...byEncodedOrder(
      streams.filter(
        (offer) => playsStream(offer, can) && hasFile(info, offer.codec),
      ),
    ),
    ...streams.filter((offer) => playsStream(offer, can)),
    ...files,
  ];
  const first = order[0];
  return first === undefined ? null : asPicked(first);
}

/**
 * **音声を選ぶために、その場で流すほうへ移るときの行き先。** ファイルをそのまま読んでいて、ブラウザが
 * 入れ物の音声を出さない (`video.audioTracks` が無い。Chrome・Firefox の既定) ときに使う —
 * そのままでは2本目の音声 (副音声・解説) を選べない。流すほうはサーバが選んだ1本を流す (`/stream?audio=`)。
 *
 * 同じコーデックの詰め替え (サーバは軽い) を先に、無ければ `pickOffer` と同じ順の変換。MSE が
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
 * **コーデックのメニューに並べるもの。** この端末で観られる方法があるコーデック (H.264 → H.265 → AV1)。
 * H.265 はエンコード済みがある録画にだけある (その場の変換では作らない)
 */
export function codecChoices(
  info: PlaybackInfo,
  can: MediaAbility,
): ("h264" | "hevc" | "av1")[] {
  return (["h264", "hevc", "av1"] as const).filter((codec) =>
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
 * 互換モードで描く形式。**H.265 は描かない** — 描く側 (`ts/fmp4.ts`・`raw/support.ts`) は H.264・AV1・MPEG-2 しか
 * 読まない。H.265 だけの録画も、AV1 か H.264 に変換して流せば描ける
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
 * **互換モードでどれで観るか。** 選んだものが描ければそれ。`auto` か、選んだものが描けなければ:
 *
 * 1. エンコード済みと同じ形式の fMP4 (詰め替え。サーバは軽い)
 * 2. 変換する fMP4 (H.264 → AV1)
 * 3. 元の TS (MPEG-2)
 *
 * `avoid` は諦めた形式 (描いている途中で間に合わなくなった)。何も描けなければ null
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
  return [...light, ...usable][0] ?? null;
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

/** 選んだもので観るとき、サーバがその場でエンコードするか (枠を使う。混んでいると断られる) */
export function transcodes(info: PlaybackInfo, picked: Picked): boolean {
  return picked.way === "stream" && !hasFile(info, picked.codec);
}

/** `TimeRanges` を配列にしたもの (`[始まり, 終わり]` 秒) */
export type Ranges = readonly (readonly [number, number])[];

/** `t` を含む区間の、`t` から先に溜まっている長さ (秒)。含む区間が無ければ 0 */
export function aheadOf(ranges: Ranges, t: number): number {
  for (const [start, end] of ranges) {
    if (start <= t + GAP && t < end) return end - t;
  }
  return 0;
}

/**
 * 区間どうしの小さな隙間は無いものと見る (秒)。映像と音声の頭が数十ms ずれるぶん
 * (音声の頭は AAC の前置きぶん早い) と、ブラウザが跨いで再生する程度の隙間
 */
const GAP = 0.5;

/**
 * 飛んだ先 `t` を、**リクエストし直さずに待てば届くか。**
 *
 * - いま溜まっている区間の中なら、そのまま
 * - 読んでいる最中 (`from` からリクエストしたストリームが伸びている) で、その伸びる先の少し先
 *   (`slack` 秒) までなら待つ。10秒送りのたびにリクエストし直すと、毎回キーフレームまで戻って
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
  // リクエストした位置から伸びている区間の尻。まだ何も届いていなければリクエストした位置
  let end = from;
  for (const [start, stop] of ranges) {
    if (start <= from + GAP && stop >= from) end = Math.max(end, stop);
  }
  return t <= end + slack;
}
