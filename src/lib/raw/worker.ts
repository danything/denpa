/// <reference lib="webworker" />
/**
 * **変換せずに送られてきた TS をデコードして描く** worker (docs/stream.md#放送そのままmpeg-2を送る)。
 *
 *     TS ─→ PES (packages/arib/src/pes.ts) ┬→ 映像: WASM の MPEG-2 デコーダ (wasm/decoder.c) → WebGL2 (render.ts)
 *                           └→ 音声: ADTS → 同じ WASM の AAC デコーダ → 画面へ (鳴らすのは画面)
 *
 * 音をデコードするのも同じ worker。AAC は1秒ぶんで数 ms (stream.md#放送そのままmpeg-2を送る) と、映像をデコードする手間の
 * 1% にも届かないので、worker を分けて受け渡しを増やすほどではない。
 *
 * **時計は画面が持つ** (鳴っている音。`playout.ts`)。ここは届いた時計に合わせて、番が
 * 来たコマを出すだけ。
 *
 * **エンコードしたもの (fMP4) を canvas に描く経路もここで受ける** (`messages.ts` の `RawInput`)。
 * <video> の再生が止まる端末 (テスラの車載ブラウザ) のための経路で、映像は WebCodecs、音は
 * 同じ WASM (AAC・Opus) でデコードする。中身は `fmp4.ts`。時計・小窓・切り抜き・見張りはこことで共有する
 *
 * ## 貯めるのはデコードする前
 *
 * 貯め (0.2秒〜) のぶんをデコードしたフレームで持つと、1080 のフレームは1枚 3MB あるので 1秒で 90MB になる。
 * **圧縮のまま持っておき、番の少し前 (`AHEAD`) にデコードする。** デコードするのは実測で1コマ 10ms 前後
 * なので、0.3 秒前に始めれば間に合う。デコードできたフレームはデコーダの中で順番待ちさせる
 * (`dec_peek` / `dec_pop`)。
 *
 * ## 頭は I フレームから
 *
 * MPEG-2 は I フレームからしかデコードし始められない。選局の直後や飛ばしたあとは、I が来る
 * まで捨てる (放送の GOP は 0.5 秒)。前のフレームを参照するコマを先に渡すと、デコーダは灰色の
 * 映像を出してしまう。
 *
 * ## 録画は飛び先より前を描かない
 *
 * 録画の観る画面 (`canvas-player.ts`) で飛ぶと、サーバは飛び先の少し手前 (I フレーム・1 秒前) から
 * 流してくる。**飛び先 (`reset` の `from`) より前のコマは、参照に使うためデコードするだけで描かない** (`floor`)。
 * 描けるまでは前のフレームのまま。録画は捨てて先へ飛ばない (`follow`) ので、圧縮のまま持つ量は読む側が抑える
 */

import {
  AdtsSplitter,
  CLOCK,
  type Pes,
  PesDemuxer,
  unwrap,
} from "@danything/arib/pes";

import { DecodeBudget } from "./budget";
import { fieldAt, type Shown, SmoothClock, Vsync, VsyncClock } from "./cadence";
import { downscale } from "./downscale";
import { Fmp4Video, FOLLOW_BYTES_MOST } from "./fmp4";
import type { FromWorker, GrabSize, RawInput, ToWorker } from "./messages";
import { MkvInput } from "./mkv";
import { YuvRenderer } from "./render";

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** 番のこれだけ前からデコードする (90kHz)。デコードするのは1コマ 10ms 前後 */
const AHEAD = 0.3 * CLOCK;
/**
 * デコードできたフレームを待たせる上限。**これ以上は先にデコードしない** (1枚 3MB)。
 * 実測 (`tests/bench`。docs/stream.md#デコードしたフレームを持つ数) では、1回に 1 枚ずつデコードするので
 * 待たせるのは多くて 3〜5 枚で、8 にも届かない。2 だと追いつかずに毎秒 30 フィールド前後まで落ちた。
 * WASM のメモリは最初の 64MB のまま増えないので、上げても下げても使う量は変わらない。
 * fMP4 の `DECODED_MOST` (fmp4.ts) と同じ数だが、数えているもの (あちらは GPU の VideoFrame) も決め手も違う
 */
const DECODED_MOST = 8;
/** 圧縮のまま持っておく上限 (90kHz)。止めている間に溜め込まない */
const PENDING_MOST = 8 * CLOCK;
/** これだけ遅れたら、デコードしながら追いつくのをやめて I フレームまで飛ぶ (90kHz) */
const BEHIND_MOST = 0.5 * CLOCK;
/** 1コマの長さの目安 (90kHz)。29.97 コマ。実際の間隔が分かればそれを使う */
const FRAME = 3003;
/** 音の復号が続けて転んだら諦める回数 */
const AUDIO_ERRORS_MOST = 20;
/**
 * 録画 (`follow`) で圧縮のまま持っておく上限。**時間 (90kHz) とバイト数の小さいほう。** 読む側
 * (`canvas-player.ts`) が先へ読みすぎないようにしているので、ふつうは届かない。超えたら受け取るのを
 * やめて `full` を返す (fMP4 の `FOLLOW_AHEAD_MOST` と同じ考え)。バイト数は fMP4 と同じ `FOLLOW_BYTES_MOST`
 */
const FOLLOW_PENDING_MOST = 30 * CLOCK;
/** 飛び先より手前をデコードして捨てるとき、1回の刻みでデコードする上限 (1枚 10〜20ms) */
const UNDER_PER_TICK = 4;

interface Decoder {
  _dec_open(): number;
  _aac_open(): number;
  _opus_open(extra: number, length: number): number;
  _audio_push(data: number, length: number): number;
  _audio_peek(): number;
  _dec_push(data: number, length: number, pts: number): number;
  _dec_count(): number;
  _dec_peek(): number;
  _dec_peek_pts(): number;
  _dec_pts_at(index: number): number;
  _dec_pop(): void;
  _dec_last_ms(): number;
  _dec_skip(on: number): void;
  _malloc(size: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
}

interface Pending {
  pts: number;
  dts: number;
  data: Uint8Array;
  intra: boolean;
}

let decoder: Decoder | null = null;
let renderer: YuvRenderer | null = null;
let input = { pointer: 0, size: 0 };

let demuxer = new PesDemuxer();
const adts = new AdtsSplitter();
let audioIndex = 0;
/** 圧縮のまま待たせている映像 (デコードする順) */
let pending: Pending[] = [];
/** I フレームを見たか。**見るまでは渡さない** */
let started = false;
/** PTS を伸ばす手元の物差し (`unwrap`)。選局し直すと捨てる */
let near: number | null = null;
/** 鳴っている PTS の時計 (`cadence.ts`) */
const clock = new SmoothClock();
/** 画面の切り替わり (`cadence.ts`)。画面の requestAnimationFrame から届く */
const vsync = new Vsync();
/** 画面の切り替わりごとの PTS (`cadence.ts`) */
const locked = new VsyncClock();
/** いま出しているコマ */
let current: Shown | null = null;
/** 描く先。小窓へ書き込むときに、描いたものをここから写す (`toPip`) */
let surface: OffscreenCanvas | null = null;
/** 小窓 (PiP) の書き込み先と、書き込むか (`messages.ts` の `pip` / `pipFlow`) */
let pip: WritableStreamDefaultWriter<VideoFrame> | null = null;
let pipFlowing = true;
/** 画面が見えていないか (`visible`)。見えていない間は、小窓へ書いていなければ映像をデコードしない */
let hidden = false;
/** 最後に描いたもの。**同じなら描き直さない** */
let drawn = { pts: Number.NaN, field: Number.NaN };
let frameTicks = FRAME;
let lastFramePts: number | null = null;
let shownSinceReset = false;
let failed = false;
/** 放送の今を追わないか (追っかけ・録画。`messages.ts` の `follow`)。`init` で決まる */
let follow = false;
/** 録画で抱えきれなくなったか。**次の `reset` (リクエストし直し) まで、届いたものは捨てる** */
let overflowed = false;
/** 圧縮のまま持っているバイト数 (`FOLLOW_BYTES_MOST`) */
let pendingBytes = 0;
/**
 * 飛び先 (`reset` の `from`)。**これより前のコマはデコードするだけで描かない。** 届いたものの近くに伸ばすまでは
 * 一周の中の値 (`floorRaw`) で持つ。最初の1枚を描いたら外す
 */
let floorRaw: number | null = null;
let floor: number | null = null;

/** いま開いている音の形式 (`標本化周波数/チャンネル数`)。変わったら開き直す */
let audioConfig = "";
let audioErrors = 0;
/** 音のコマを WASM のメモリへ写す置き場 (`input` は映像が使う) */
let audioInput = { pointer: 0, size: 0 };

let budget = new DecodeBudget();
/** 何を受け取っているか (`messages.ts` の `RawInput`)。`init` で決まる */
let mode: RawInput = "ts-mpeg2";
/** エンコードしたもの (fMP4) を描く係。`fmp4` のときだけ (`fmp4.ts`) */
let fmp4: Fmp4Video | null = null;
/** 端末に保存した録画 (Matroska) を読む係。`mkv` のときだけ (`mkv.ts`)。読んだコマは `fmp4` へ渡す */
let mkv: MkvInput | null = null;
/**
 * デコーダ (WASM) を読み終える前に届いた fMP4。**読み終えたら順に渡す** — 頭 (init) は選局の直後に
 * 1回しか来ないので、落とすと以降を1つも読めない。読み終えたら null
 */
let early: Uint8Array[] | null = [];
/** `early` に溜めたバイト数 (録画は `FOLLOW_BYTES_MOST` まで) */
let earlyBytes = 0;
/** `early` を溜めている間に尻まで届いた (`end`)。溜めたぶんを渡しきってから出しきる */
let earlyEnd = false;
/** `early` に溜める上限 (箱の数)。1秒に 20 個ほど来るので、読み込みが 10 秒掛かっても足りる */
const EARLY_MOST = 200;
let dropped = 0;
let shown = 0;
let statsAt = 0;

function post(message: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

/** 最後に画面へ伝えた絵の大きさ (`postSize`) */
let told = { width: 0, height: 0 };

/** 描いた絵の大きさが変わっていたら画面へ伝える (`messages.ts` の `size`)。描くたびに呼ぶ */
function postSize(): void {
  if (surface === null) return;
  const { width, height } = surface;
  if (width === told.width && height === told.height) return;
  told = { width, height };
  post({ type: "size", width, height });
}

function fail(reason: string): void {
  if (failed) return;
  failed = true;
  post({ type: "fail", reason });
}

/** 描く道具を用意できなかった */
function failToShow(error: unknown): void {
  fail(
    `映像を表示できません (${error instanceof Error ? error.message : String(error)})`,
  );
}

/** 伸ばした PTS にする (`pes.unwrap`)。映像と音声で同じ物差しを使う */
function extend(pts: number): number {
  const value = near === null ? pts : unwrap(pts, near);
  near = value;
  return value;
}

/** ES の中の最初のフレームが I か (picture_start_code の後ろの picture_coding_type) */
function isIntra(data: Uint8Array): boolean {
  for (let i = 0; i + 5 < data.length; i++) {
    if (
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 1 &&
      data[i + 3] === 0
    ) {
      return ((data[i + 5]! >> 3) & 0x07) === 1;
    }
  }
  return false;
}

/**
 * **次に画面が切り替わるときの PTS。** いまの PTS ではなく、描いたものが画面に出る時点で見る
 * (`cadence.ts`)。画面の切り替わりが分からなければ (裏に回った・届く前) いまの PTS
 */
function now(): number | null {
  const wall = performance.timeOrigin + performance.now();
  const target = vsync.next(wall);
  const pts = clock.at(target ?? wall);
  return target === null || pts === null ? pts : locked.pick(target, pts);
}

function onVideo(pes: Pes): void {
  const intra = isIntra(pes.data);
  if (!started) {
    if (!intra) return;
    started = true;
  }
  const last = pending.at(-1);
  const pts =
    pes.pts === null ? (last?.pts ?? 0) + frameTicks : extend(pes.pts);
  const dts = pes.dts === null ? pts : extend(pes.dts);
  pending.push({ pts, dts, data: pes.data, intra });
  pendingBytes += pes.data.length;
  if (follow) {
    /*
     * 録画は捨てて先へ飛ばない (止めた所から再開する)。読む側が読みすぎないようにしているが、
     * それでも抱えきれなくなったら受け取るのをやめて、いまの位置からリクエストし直してもらう
     */
    if (
      !overflowed &&
      (pending.at(-1)!.dts - pending[0]!.dts > FOLLOW_PENDING_MOST ||
        pendingBytes > FOLLOW_BYTES_MOST)
    ) {
      overflowed = true;
      post({ type: "full" });
    }
    return;
  }
  // 溜め込みすぎ (止めている・裏に回っている)。いちばん新しい I から持ち直す
  if (
    pending.length > 1 &&
    pending.at(-1)!.dts - pending[0]!.dts > PENDING_MOST
  ) {
    skipTo(Number.POSITIVE_INFINITY);
  }
}

/** 待たせている圧縮の頭を1つ取り出す */
function shift(): Pending {
  const item = pending.shift() as Pending;
  pendingBytes -= item.data.length;
  return item;
}

/** 飛び先より前のコマか (`floor`)。**飛び先は、届いたものの物差しに伸ばしてから比べる** */
function under(pts: number): boolean {
  if (floorRaw !== null && near !== null) {
    floor = unwrap(floorRaw, near);
    floorRaw = null;
  }
  return floor !== null && pts < floor;
}

/** デコードできたフレームのうち、飛び先より前のものを捨てる (描かない。参照には使い終えている) */
function dropUnder(): void {
  if (decoder === null) return;
  while (decoder._dec_count() > 0 && under(decoder._dec_pts_at(0)))
    decoder._dec_pop();
}

/**
 * `target` より手前でいちばん新しい I フレームまで飛ぶ。**デコーダも開き直す** —
 * 飛ばしたコマを参照するフレームを出させないため
 */
function skipTo(target: number): void {
  let found = -1;
  for (let i = 0; i < pending.length; i++) {
    if (pending[i]!.dts > target) break;
    if (pending[i]!.intra) found = i;
  }
  if (found <= 0) return;
  pending = pending.slice(found);
  pendingBytes = pending.reduce((sum, item) => sum + item.data.length, 0);
  decoder?._dec_open();
}

function onAudio(pes: Pes): void {
  if (decoder === null) return;
  for (const frame of adts.feed(
    pes.data,
    pes.pts === null ? null : extend(pes.pts),
  )) {
    /*
     * 形式が変わったら (局・番組の切り替わりで 5.1ch ⇔ ステレオ、標本化周波数) 開き直す。
     * デコーダは ADTS の頭を読んで自分で合わせもするが、前の形式の持ち越し (重ね合わせの
     * 半コマ) を新しい形式に混ぜないため
     */
    const config = `${frame.sampleRate}/${frame.channels}`;
    if (config !== audioConfig) {
      if (decoder._aac_open() !== 0) {
        fail("音声を再生できませんでした");
        return;
      }
      audioConfig = config;
    }
    decodeAudio(decoder, frame.data, frame.pts);
  }
}

/**
 * ADTS の1コマをデコードして画面へ渡す。**壊れたコマは飛ばす** (放送の取りこぼし)。
 * 続けて転ぶなら諦める
 */
function decodeAudio(decoder: Decoder, data: Uint8Array, pts: number): void {
  audioInput = ensure(decoder, audioInput, data.length);
  decoder.HEAPU8.set(data, audioInput.pointer);
  const samples = decoder._audio_push(audioInput.pointer, data.length);
  if (samples < 0) {
    if (++audioErrors > AUDIO_ERRORS_MOST) fail("音声を再生できませんでした");
    return;
  }
  if (samples === 0) return;
  audioErrors = 0;
  // デコードしたあとに読む — メモリが伸びると HEAPU8 の下の ArrayBuffer が替わる
  const info = decoder._audio_peek() >> 2;
  const heap = decoder.HEAP32;
  const channels = heap[info]!;
  const sampleRate = heap[info + 1]!;
  const planes: Float32Array[] = [];
  for (let i = 0; i < channels; i++) {
    // 写して持ち出す。デコーダの面は次のコマで上書きされる
    planes.push(
      new Float32Array(
        decoder.HEAPU8.buffer,
        heap[info + 3 + i]!,
        samples,
      ).slice(),
    );
  }
  post(
    {
      type: "audio",
      pts,
      duration: (samples / sampleRate) * CLOCK,
      sampleRate,
      planes,
    },
    planes.map((plane) => plane.buffer),
  );
}

/** WASM のメモリに `size` バイトの置き場を用意する。**足りるうちは使い回す** */
function ensure(
  decoder: Decoder,
  slot: { pointer: number; size: number },
  size: number,
): { pointer: number; size: number } {
  if (size <= slot.size) return slot;
  if (slot.pointer !== 0) decoder._free(slot.pointer);
  return { pointer: decoder._malloc(size), size };
}

/** 1 PES ぶんをデコーダへ。**WASM のメモリへ写してから渡す** */
function decode(item: Pending): void {
  if (decoder === null) return;
  input = ensure(decoder, input, item.data.length);
  decoder.HEAPU8.set(item.data, input.pointer);
  decoder._dec_push(input.pointer, item.data.length, item.pts);
  budget.record(decoder._dec_last_ms());
}

/** いちばん古いデコードできたフレームをテクスチャへ上げて、`current` にする */
function take(): void {
  if (decoder === null || renderer === null) return;
  const info = decoder._dec_peek() >> 2;
  if (info === 0) return;
  const heap = decoder.HEAP32;
  const bytes = decoder.HEAPU8;
  const width = heap[info]!;
  const height = heap[info + 1]!;
  const strides: [number, number, number] = [
    heap[info + 2]!,
    heap[info + 3]!,
    heap[info + 4]!,
  ];
  const chromaRows = (height + 1) >> 1;
  const plane = (i: number, rows: number) =>
    bytes.subarray(
      heap[info + 5 + i]!,
      heap[info + 5 + i]! + strides[i]! * rows,
    );
  const flags = heap[info + 8]!;
  const sarNum = heap[info + 9]!;
  const sarDen = heap[info + 10]!;
  // 縦横比が分からなければ 16:9 とみなす (日本の HD 放送はどれもそう)
  const displayWidth =
    sarNum > 0 && sarDen > 0
      ? Math.round((width * sarNum) / sarDen)
      : Math.round((height * 16) / 9);
  renderer.upload(
    {
      width,
      height,
      strides,
      data: [plane(0, height), plane(1, chromaRows), plane(2, chromaRows)],
      colorspace: heap[info + 11]!,
    },
    displayWidth,
  );
  const pts = decoder._dec_peek_pts();
  if (lastFramePts !== null) {
    const gap = pts - lastFramePts;
    // 1コマの長さを実際の間隔から知る (59.94p の局・3:2 のフィルム)
    if (gap > 0 && gap < 3 * FRAME) frameTicks = gap;
  }
  lastFramePts = pts;
  current = { pts, interlaced: (flags & 1) !== 0, topFirst: (flags & 2) !== 0 };
  decoder._dec_pop();
}

function draw(field: number): void {
  if (renderer === null || current === null) return;
  if (drawn.pts === current.pts && drawn.field === field) return;
  renderer.draw(field);
  drawn = { pts: current.pts, field };
  postSize();
  toPip();
  shown++;
  if (!shownSinceReset) {
    shownSinceReset = true;
    // 飛び先に着いた。ここから先は番の順に出るので、もう比べない
    floor = null;
    floorRaw = null;
    post({ type: "shown" });
  }
}

/**
 * 描いたばかりの1コマを小窓へ書き込む。**描いたのと同じ回のうちに写す** — 描いたものは
 * 残さない作り (`preserveDrawingBuffer` 無し) なので、回をまたぐと消えている。
 *
 * canvas の画面への更新 (`captureStream`) から取っていた頃は、Ubuntu (GNOME) で Chrome の
 * 窓が小窓の後ろに隠れると映像が止まった。隠れた窓は画面の更新が回らず、canvas も
 * 更新されない (ページは見えている扱いのまま。Alt+Tab で縮小図を描かせると動き出す)。
 * 書き込みは画面の更新と関係なく流れる。
 *
 * **詰まっていたら捨てる** (`desiredSize`)。小窓が受け取りきれないまま積むと遅れていく
 */
function toPip(): void {
  if (
    pip === null ||
    !pipFlowing ||
    surface === null ||
    (pip.desiredSize ?? 0) <= 0
  )
    return;
  let frame: VideoFrame;
  try {
    frame = new VideoFrame(surface, {
      timestamp: Math.round(performance.now() * 1000),
    });
  } catch {
    return;
  }
  const writer = pip;
  writer.write(frame).catch(() => {
    // 受け手が畳まれた (小窓のストリームを止めた・変換しない経路を出た)。もう書かない
    frame.close();
    if (pip === writer) pip = null;
  });
}

/** 刻むたびに: 番の近いものをデコードし、番が来たコマを出す */
function tick(): void {
  if (decoder === null || failed) return;
  schedule();
  // 互換モード (WebCodecs) は見えていなくても止めない — デコードするのはたいてい GPU で、端末の CPU を取り合わない
  if (fmp4 !== null) {
    tickFmp4(fmp4);
    return;
  }
  const at = now();

  /*
   * **見えていない間は映像をデコードしない** (小窓へ書いているときは別)。待たせている圧縮は、溜まりすぎたら
   * いちばん新しい I から持ち直す (`onVideo` の `PENDING_MOST`)。見えるようになったら、大きく遅れているので I まで飛んで
   * デコードし直す (下の `BEHIND_MOST`)。**ここでデコーダを開き直さない** — 音と共通なので、音まで止まる
   */
  if (hidden && (pip === null || !pipFlowing)) {
    report();
    return;
  }

  /*
   * **新しい局の1枚目は、デコードできたらすぐ出して待つ** — 前の局の映像のまま新しい局の音を
   * 聞かせると、見えているものと聞こえるものが食い違う。音の時計が動き出していても
   * 待たない: 放送の映像は音より先に届く (VBV の遅れ) ので、番を待つと 1 枚目が
   * 0.5〜2 秒遅れていた (本番の実測)。番が来るまではこの1枚のまま止めておく。
   *
   * **録画で飛んだあとは、飛び先より前をデコードして捨てる** (`floor`)。それまでは前のフレームのまま
   * (CM を飛ばしたなら本編の映像のまま)。1回にデコードするのは `UNDER_PER_TICK` 枚まで
   */
  if (!shownSinceReset) {
    const limit =
      floor !== null || floorRaw !== null
        ? UNDER_PER_TICK
        : Number.POSITIVE_INFINITY;
    for (let i = 0; ; i++) {
      dropUnder();
      if (decoder._dec_count() > 0 || pending.length === 0 || i >= limit) break;
      decode(shift());
    }
    if (decoder._dec_count() > 0) {
      take();
      draw(current?.interlaced === true ? (current.topFirst ? 0 : 1) : -1);
    }
  }
  // 止まっている (貯めている)
  if (at === null) return;

  // 大きく遅れている (裏から戻った・止めていた)。デコードしながら追うより I まで飛ぶ
  const head = pending[0];
  if (head !== undefined && head.dts < at - BEHIND_MOST) skipTo(at);

  /*
   * **先に出す。描いた回はデコードしない** — 描いたものはその回の終わりに画面へ渡るので、続けて
   * デコードする (1枚 10〜20ms) と回が延び、次の画面の切り替わりに間に合わないことがある。
   * 番のコマがまだデコードできていなければ、デコードしてから出す
   */
  if (!present(decoder, at)) {
    /*
     * **1回にデコードするのは1枚まで** (遅れているときだけ3枚まで)。1枚 10〜20ms かかるので、
     * まとめてデコードするとその間コマを出せず、番を過ぎて捨てるコマが増える。
     * 先にデコードしたものがあるうちは、画面の切り替わりの直後にだけ始める (`Vsync.settled`)
     */
    const ready =
      decoder._dec_count() === 0 ||
      vsync.settled(performance.timeOrigin + performance.now());
    for (
      let i = 0;
      ready &&
      i < 3 &&
      pending.length > 0 &&
      decoder._dec_count() < DECODED_MOST;
      i++
    ) {
      const next = pending[0]!;
      if (next.dts > at + AHEAD || (i > 0 && next.dts > at)) break;
      decode(shift());
    }
    dropUnder();
    present(decoder, at);
  }

  // 映像が時計からどれだけ遅れているか。**デコードできたフレームが無いまま番を過ぎている**ぶん
  const late =
    current === null || decoder._dec_count() > 0
      ? 0
      : Math.max(0, (at - current.pts - frameTicks) / CLOCK);
  thin(decoder, late);
  watch(
    late,
    frameTicks,
    0,
    "再生が追いつかないため、変換した映像に切り替えました",
    thinning ? 2 : 1,
  );
}

/*
 * ---- 間に合わないときは B フレームを飛ばす (`dec_skip`) ----
 * 1 秒の間にコマを `THIN_DROPS` 枚以上捨てたか、映像が `THIN_LATE` 秒以上遅れたら、参照されないコマ (B) をデコードしない。
 * 動きは 1 秒 10〜15 コマに落ちるが、デコードに掛かる時間は半分ほどになり、紙芝居 (テロップが震える) にならずに済む。
 * 決めた長さ (`thinHold`) が過ぎたら戻してみて、戻してすぐまた遅れたら次は倍の長さにする。
 * それでも間に合わなければ、いつもどおりエンコードしたものに戻る (`budget.ts`)
 */
const THIN_DROPS = 3;
const THIN_LATE = 0.1;
/** 最初に飛ばし続ける長さ (ms) と、伸ばす上限 */
const THIN_FIRST = 20_000;
const THIN_LONGEST = 300_000;
/** 戻してからこれだけのうちにまた遅れたら、次は長く飛ばす (ms) */
const THIN_RELAPSE = 10_000;
/** 裏から戻ってから、捨てたコマ・遅れを数えはじめるまで (ms)。追いつくのに掛かる時間 (I まで飛んでデコードし直す) */
const BACK_GRACE = 2_000;
let thinning = false;
let thinUntil = 0;
let thinHold = THIN_FIRST;
let thinOffAt = Number.NEGATIVE_INFINITY;
let thinCheckAt = 0;
let thinDropped = 0;

/**
 * 飛ばすのをやめて、数え直す。局を変えたとき (`reset`) と、裏から戻ったとき。
 * **戻った直後は追いつくまでコマを捨てる** (飛び先の I まで捨て、番を過ぎたものも捨てる) ので、それを
 * 「間に合っていない」と数えると、戻るたびに B を飛ばしはじめていた。`grace` (ms) のあいだは数えない
 */
function resetThin(grace = 0): void {
  if (thinning) decoder?._dec_skip(0);
  thinning = false;
  thinHold = THIN_FIRST;
  thinOffAt = Number.NEGATIVE_INFINITY;
  thinCheckAt = performance.now() + grace;
  thinDropped = dropped;
}

function thin(decoder: Decoder, late: number): void {
  const wall = performance.now();
  // 裏から戻った直後 (`resetThin` の `grace`)。追いつくまでに捨てたコマは数えない
  if (wall < thinCheckAt) {
    thinDropped = dropped;
    return;
  }
  if (wall - thinCheckAt < 1000) return;
  const lost = dropped - thinDropped;
  thinDropped = dropped;
  thinCheckAt = wall;
  if (!thinning) {
    if (lost < THIN_DROPS && late < THIN_LATE) return;
    thinHold =
      wall - thinOffAt < THIN_RELAPSE
        ? Math.min(THIN_LONGEST, thinHold * 2)
        : THIN_FIRST;
    thinning = true;
    thinUntil = wall + thinHold;
    decoder._dec_skip(1);
  } else if (wall >= thinUntil) {
    thinning = false;
    thinOffAt = wall;
    decoder._dec_skip(0);
  }
}

/** 番が来たコマを上げ、`at` に出すフィールドを描く。描いたら true */
function present(decoder: Decoder, at: number): boolean {
  // 次のフレームがもう番を迎えているなら、手前のフレームは上げずに捨てる
  while (decoder._dec_count() >= 2 && decoder._dec_pts_at(1) <= at) {
    decoder._dec_pop();
    dropped++;
  }
  if (decoder._dec_count() >= 1 && decoder._dec_pts_at(0) <= at) take();
  if (current === null) return false;
  const before = shown;
  draw(fieldAt(current, at, frameTicks));
  return shown !== before;
}

/** エンコードしたもの (fMP4) の刻み。描くのは `fmp4.ts` で、ここは遅れを見張って数を出すだけ */
function tickFmp4(video: Fmp4Video): void {
  const at = now();
  video.tick(at);
  if (at === null) return;
  const late =
    video.current === null || video.waiting > 0
      ? 0
      : Math.max(0, (at - video.current - video.frameTicks) / CLOCK);
  dropped = video.dropped;
  watch(late, video.frameTicks, video.queued, "再生が追いつきません");
}

/** 間に合っているかを見張り (`budget.ts`)、1秒ごとに数を出す */
function watch(
  late: number,
  frame: number,
  queued: number,
  reason: string,
  stretch = 1,
): void {
  const wall = performance.now();
  if (budget.tick(wall, (frame / CLOCK) * 1000, late, queued, dropped, stretch))
    fail(reason);
  report();
}

/** 1秒ごとに数を出す (見えていない間も。音のコマ数は画面がこの知らせで書き出す) */
function report(): void {
  const wall = performance.now();
  if (wall - statsAt < 1000) return;
  statsAt = wall;
  post({ type: "stats", dropped, p95: budget.p95, shown, thinned: thinning });
}

let scheduled = false;
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  const next = () => {
    scheduled = false;
    tick();
  };
  /*
   * **rAF ではなく細かい時計で刻む。** worker の rAF は描いたものが画面に出る速さに
   * 引っ張られ、実機の録画 (1080i) をヘッドレスで流すと毎秒 6 回しか来なかった — 1回に
   * 何枚もデコードすることになり、コマを出す番を逃し続ける。4ms ごとに1枚ずつデコードして、番が来た
   * コマを出す (描いたものはその回の終わりに画面へ渡る)
   */
  setTimeout(next, 4);
}

function reset(from: number | null): void {
  // 局が変われば重さも変わる
  resetThin();
  demuxer = new PesDemuxer();
  demuxer.audioIndex = audioIndex;
  adts.reset();
  pending = [];
  pendingBytes = 0;
  overflowed = false;
  floorRaw = from;
  floor = null;
  started = false;
  near = null;
  clock.clear();
  locked.clear();
  current = null;
  drawn = { pts: Number.NaN, field: Number.NaN };
  lastFramePts = null;
  shownSinceReset = false;
  budget.reset();
  mkv?.reset();
  if (fmp4 !== null) fmp4.reset(from);
  else decoder?._dec_open();
  if (early !== null) {
    early = [];
    earlyBytes = 0;
    earlyEnd = false;
  }
  // 次のコマで開き直す (前の局の持ち越しを捨てる)
  audioConfig = "";
  audioErrors = 0;
}

/**
 * いま出しているコマを1枚返す (切り抜き。`messages.ts` の `grab`)。
 * **最後に描いたフィールドのまま** 描き直す — 1080i で別のフィールドを描くと、
 * 画面に見えていたものと半コマずれる。
 *
 * `size` があれば縮めたものを返す (アンビエントモード)。MPEG-2 は描き直した直後の面を
 * 半分ずつ縮めて写す (`downscale.ts`) — 呼んだ時点の面を写すので、描いたのと同じ回のうちなら読める
 * (`toPip` と同じ)。全部を `readPixels` で読み出す切り抜きの経路は通らない
 */
async function grab(id: number, size: GrabSize | undefined): Promise<void> {
  let bitmap: ImageBitmap | null = null;
  try {
    if (fmp4 !== null) bitmap = await fmp4.grab(size);
    else if (
      renderer !== null &&
      current !== null &&
      !Number.isNaN(drawn.field)
    ) {
      if (size !== undefined && surface !== null) {
        renderer.draw(drawn.field);
        bitmap = await downscale(surface, surface.width, surface.height, size);
      } else {
        const image = renderer.capture(drawn.field);
        if (image !== null) bitmap = await createImageBitmap(image);
      }
    }
  } catch {
    // 読めなかった。写せないと返す (画面は何もしない)
  }
  post({ type: "frame", id, bitmap }, bitmap === null ? [] : [bitmap]);
}

/**
 * エンコードしたもの (fMP4) の音を受け取る側 (`fmp4.ts` の `AudioSink`)。デコードするのは MPEG-2 の経路と同じ WASM —
 * AAC は ADTS の頭を付けて (`fmp4.ts` が付ける)、Opus は OpusHead を渡して開く
 */
function openAudio(codec: "aac" | "opus", config: Uint8Array | null): boolean {
  if (decoder === null) return false;
  audioErrors = 0;
  if (codec === "aac") return decoder._aac_open() === 0;
  if (config === null) return false;
  audioInput = ensure(decoder, audioInput, config.length);
  decoder.HEAPU8.set(config, audioInput.pointer);
  return decoder._opus_open(audioInput.pointer, config.length) === 0;
}

function startFmp4(canvas: OffscreenCanvas, follow: boolean): boolean {
  if (typeof VideoDecoder !== "function") {
    fail("再生できない形式です");
    return false;
  }
  try {
    fmp4 = new Fmp4Video(
      canvas,
      {
        audio: {
          open: openAudio,
          push: (data, pts) => {
            if (decoder !== null) decodeAudio(decoder, data, pts);
          },
        },
        drew: (first) => {
          shown++;
          postSize();
          toPip();
          if (first) post({ type: "shown" });
        },
        fail,
        record: (ms) => budget.record(ms),
        full: () => post({ type: "full" }),
      },
      follow,
    );
  } catch (error) {
    failToShow(error);
    return false;
  }
  // 渡してから出てくるまでの時間は物差しにしない (GPU の経路は詰まっていなくても溜める。`budget.ts`)
  budget = new DecodeBudget(false);
  return true;
}

async function init(
  canvas: OffscreenCanvas,
  base: string,
  kind: RawInput,
  chase: boolean,
): Promise<void> {
  mode = kind;
  surface = canvas;
  follow = chase;
  // 録画の元の TS も、デコーダを読み終えるまで溜めておく (音を落とすと、鳴らし始めが遅れる)。ライブは今までどおり
  if (kind === "ts-mpeg2" && !follow) early = null;
  if (kind !== "ts-mpeg2") {
    if (!startFmp4(canvas, follow)) return;
    if (kind === "mkv" && fmp4 !== null) mkv = new MkvInput(fmp4, audioIndex);
  } else {
    try {
      renderer = new YuvRenderer(canvas);
    } catch (error) {
      failToShow(error);
      return;
    }
  }
  try {
    const url = new URL(`${base}/decoder.mjs`, scope.location.origin).href;
    const module = (await import(/* @vite-ignore */ url)) as {
      default: (options: object) => Promise<Decoder>;
    };
    decoder = await module.default({
      locateFile: (name: string) =>
        new URL(`${base}/${name}`, scope.location.origin).href,
    });
    if (decoder._dec_open() !== 0 || decoder._aac_open() !== 0)
      throw new Error("開けません");
  } catch {
    fail(
      kind !== "ts-mpeg2"
        ? "音声を再生できません"
        : "この denpa は MPEG-2 をそのまま再生できません",
    );
    return;
  }
  const held = early ?? [];
  early = null;
  earlyBytes = 0;
  for (const bytes of held) feed(bytes);
  if (earlyEnd) {
    earlyEnd = false;
    mkv?.finish();
  }
  post({ type: "ready" });
  schedule();
}

/** 届いたものを読む (fMP4 は箱ごと、Matroska は要素ごと、TS は PES に組んで) */
function feed(bytes: Uint8Array): void {
  if (mode === "fmp4") {
    fmp4?.feed(bytes);
    return;
  }
  if (mode === "mkv") {
    mkv?.feed(bytes);
    return;
  }
  // 録画で抱えきれなくなった。リクエストし直し (`reset`) まで受け取らない
  if (overflowed) return;
  const { pes, changed } = demuxer.feed(bytes);
  if (changed) demuxer.selectAudio(audioIndex);
  for (const item of pes) {
    if (item.kind === "video") onVideo(item);
    else onAudio(item);
  }
}

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      void init(message.canvas, message.decoder, message.input, message.follow);
      break;
    case "data": {
      if (failed) return;
      const bytes = new Uint8Array(message.buffer, message.offset);
      // デコーダを読み終えるまでは溜めておく (`early`)。録画は数ではなくバイト数で区切る (塊の大きさが決まっていない)
      if (early !== null) {
        if (
          follow ? earlyBytes < FOLLOW_BYTES_MOST : early.length < EARLY_MOST
        ) {
          early.push(bytes);
          earlyBytes += bytes.length;
        }
        break;
      }
      feed(bytes);
      break;
    }
    case "clock":
      clock.set(message.pts, message.at);
      break;
    case "vsync":
      vsync.feed(message.at);
      break;
    case "reset":
      reset(message.from ?? null);
      break;
    case "end":
      // 尻まで読んだ。デコーダを読み終えるまでは溜めたぶんの後ろで (`early`)
      if (early !== null) earlyEnd = true;
      else mkv?.finish();
      break;
    case "audio":
      // エンコードしたものには選んだ音声1本しか入っていない (選び直すとサーバが再エンコードする)
      if (mode === "mkv") {
        // 保存した録画はトラックを選び直す (次の頭から効く。画面がリクエストし直す)
        mkv?.selectAudio(message.index);
        break;
      }
      if (mode === "fmp4") break;
      audioIndex = message.index;
      demuxer.selectAudio(message.index);
      adts.reset();
      // 別の音声の持ち越しを混ぜない。次のコマで開き直す
      audioConfig = "";
      break;
    case "grab":
      void grab(message.id, message.size);
      break;
    case "pip":
      void pip?.abort().catch(() => undefined);
      pip = message.writable.getWriter();
      // 1枚目は書く (受け手がコマの大きさを知るまで小窓に出せない)。そのあとは画面が決める
      pipFlowing = true;
      break;
    case "pipFlow":
      pipFlowing = message.on;
      break;
    case "visible":
      hidden = !message.on;
      // 見えていない間に溜まった遅れは数えない (戻った直後に「間に合っていない」と見ない)
      budget.reset();
      if (message.on) resetThin(BACK_GRACE);
      break;
  }
};
