/**
 * 画面 (`engine.ts`) と worker (`worker.ts`) の取り決め。**両側から読む。**
 *
 * 分け方: TS をデコードする・映像をデコードして描く・音をデコードするのは worker、**音を鳴らすのと時計は画面**
 * (Web Audio は worker から触れない)。時計は画面から worker へ流す (`clock`)。
 */

/**
 * 何を受け取るか。**worker を作るときに決める** (描く先の canvas の使い方が違うので、途中で替えない)
 *
 * - `ts-mpeg2` … 元の TS (`CHANNEL.rawTs`)。MPEG-2 と AAC を WASM でデコードし、WebGL2 で描く
 * - `fmp4` … エンコードしたもの (ライブ・追っかけは `CHANNEL.videoInit` / `videoMedia`、観る画面は `/stream`)。映像は WebCodecs の
 *   VideoDecoder でデコードして 2D で描き、音 (AAC・Opus) は WASM でデコードする (`fmp4.ts`)。
 *   **<video> の再生が止まる端末** (テスラの車載ブラウザ) のための経路
 * - `mkv` … 端末に保存した録画 (エンコード済みの Matroska)。互換モードの観る画面で、読んだコマを `fmp4` と
 *   同じ経路でデコードして描く (`mkv.ts`)。音は選んだ1本 (`audio` の何本目か)
 */
export type RawInput = "ts-mpeg2" | "fmp4" | "mkv";

/** 縮めて返す大きさ (`grab`) */
export interface GrabSize {
  width: number;
  height: number;
}

/**
 * `createImageBitmap` に渡す縮め方。**`VideoFrame` の無いブラウザで、画面の側で `<video>` を縮めるときだけ使う**
 * (worker の中は `downscale.ts`)。`high` で縮める — 低いほど 1920 から 32 へ点で間引き、写すたびに色が揺れる
 */
export function shrink(size: GrabSize): ImageBitmapOptions {
  return {
    resizeWidth: size.width,
    resizeHeight: size.height,
    resizeQuality: "high",
  };
}

/** 画面 → worker */
export type ToWorker =
  | {
      type: "init";
      /** 描く先。`transferControlToOffscreen` で渡す */
      canvas: OffscreenCanvas;
      /** デコーダの置き場 (`/api/live/mpeg2`)。worker からは絶対 URL で読む */
      decoder: string;
      input: RawInput;
      /**
       * 放送の今を追わないか (追っかけ・録画)。溜まっても先へ飛ばず、止めている間も
       * 捨てない。そのかわり溢れそうなら受け取るのをやめて `full` を返す
       */
      follow: boolean;
    }
  /**
   * 届いたもの (TS、または fMP4 の init・媒体1つ)。**頭の9バイト (多重化の頭) を飛ばした位置から**。
   * fMP4 は箱の切れ目で届く (サーバが割ってから送る。`ts/fmp4.ts` の `Fmp4Splitter`)
   */
  | { type: "data"; buffer: ArrayBuffer; offset: number }
  /**
   * いま鳴っている PTS (90kHz。伸ばしたもの) と、それが鳴った時刻 (`performance.timeOrigin +
   * performance.now()` の ms)。**null は「止まっている」** — 映像もそこで止める
   */
  | { type: "clock"; pts: number | null; at: number }
  /**
   * 画面が切り替わった時刻 (画面の requestAnimationFrame。`performance.timeOrigin + performance.now()` の ms)。
   * worker はこれで次の切り替わりを見越し、その時点で出すフィールドを選ぶ (`cadence.ts`)
   */
  | { type: "vsync"; at: number }
  /**
   * 選局し直した・録画で飛んだ。**前の局のものは全部捨てる。** `from` (90kHz。届くものの PTS の物差しで、
   * 元の TS なら一周の中) があれば、それより前のコマはデコードするだけで描かない — サーバは飛び先の少し手前
   * (キーフレーム・1 秒前) から流すので、手前の映像 (CM を飛ばしたなら CM の映像) を出さないため
   */
  | { type: "reset"; from?: number | null }
  /** もう届かない (録画の尻まで読んだ。`engine.ts` の `finish`)。Matroska は待たせているコマを出しきる (`mkv.ts`) */
  | { type: "end" }
  /** 何本目の音声をデコードするか (`AudioTrack.stream`) */
  | { type: "audio"; index: number }
  /**
   * いま出しているコマを1枚ください (切り抜き)。**映像は worker の canvas にあって、
   * 画面の側からは画素を読めない** (`transferControlToOffscreen` で渡したので)。
   * `id` は返事 (`frame`) と組にするため。
   *
   * `size` を付けると、その大きさに縮めたものを返す (アンビエントモードの 32x18。`ambient.ts`)。
   * 縮めるのは worker の中で、元の大きさの画素は読み出さない
   */
  | { type: "grab"; id: number; size?: GrabSize }
  /**
   * 小窓 (PiP) へ出す映像の書き込み先 (`MediaStreamTrackGenerator` の `writable`)。
   * **描いた1コマをその場で書き込む** — canvas の画面への更新を待たない (`engine.ts` の `pipStream`)
   */
  | { type: "pip"; writable: WritableStream<VideoFrame> }
  /** 小窓へ書き込むか。出していない間は書かない (1コマごとに写すぶん重い) */
  | { type: "pipFlow"; on: boolean }
  /**
   * 画面が見えているか (`visibilitychange`)。**見えていない間は映像をデコードしない** — 同じ端末で 2 本見ていると、
   * 裏に回したほうも 1 コマ 10ms 前後デコードし続けて、見ているほうが間に合わなくなっていた。音は流し続ける
   */
  | { type: "visible"; on: boolean }
  /**
   * 止めていたのを再開した (`RawEngine.resume`)。ライブは放送の今から鳴らすので、映像は止めた所から大きく遅れて
   * いる。**時計が動き出してから追いつくまでは、間に合っていないと数えない** (`worker.ts` の `catchUp`)
   */
  | { type: "resume" };

/** worker → 画面 */
export type FromWorker =
  /** 使えなくなった (デコーダが無い・音がデコードできない・間に合わない。`budget.ts`)。**次の方式に移るか止まるかは画面が決める** */
  | { type: "fail"; reason: string }
  /**
   * デコードできた音1コマ。面ごとの float (-1〜1)。**時刻は伸ばした PTS** (`pes.unwrap`)
   */
  | {
      type: "audio";
      pts: number;
      duration: number;
      sampleRate: number;
      planes: Float32Array[];
    }
  /** 選局し直してから最初のフレームを描いた。**前の局の静止画を剥がす合図** */
  | { type: "shown" }
  /**
   * 描いている映像の大きさ (見せる大きさ。画素の縦横比を掛けたもの)。**変わったときだけ** 送る。
   * canvas は worker に渡してあるので、画面の側からは映像の形が分からない (`PlayerStage` が枠をこの形にする)
   */
  | { type: "size"; width: number; height: number }
  /**
   * デコーダ (WASM) を読み終え、それまで溜めていたものを渡しきった。**これより前は「尻まで読んだのに
   * 音が来ない」を終わりと見なさない** (`RawEngine.finish`)
   */
  | { type: "ready" }
  /** 数字 (1秒ごと)。画面に出すもの */
  | {
      type: "stats";
      dropped: number;
      p95: number;
      shown: number;
      thinned: boolean;
    }
  /** `grab` の返事。まだ何も出していなければ null */
  | { type: "frame"; id: number; bitmap: ImageBitmap | null }
  /**
   * 抱えきれなくなったので、届いたものを捨て始めた (`follow` のときだけ)。**画面は手元が尽きる前に
   * 再生している位置からリクエストし直す** (`live-player.svelte.ts` の `starved`)
   */
  | { type: "full" }
  /**
   * `reset` を済ませた。**これより前に出した音・`shown`・`full` は前の局 (録画なら飛ぶ前) のもの** — 画面はこれが届くまで捨てる
   * (`engine.ts` の `resetting`)。worker は届いた順にデコードするので、`reset` を受け取る前のぶんがまだ画面へ向かっていることがある
   */
  | { type: "reset" };
