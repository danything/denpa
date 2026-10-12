/**
 * 画面 (`engine.ts`) と worker (`worker.ts`) の取り決め。**両側から読む。**
 *
 * 分け方: TS をデコードする・絵をデコードして描く・音をデコードするのは worker、**音を鳴らすのと時計は画面**
 * (Web Audio は worker から触れない)。時計は画面から worker へ流す (`clock`)。
 */

/**
 * 何を受け取るか。**worker を作るときに決める** (描く先の canvas の使い方が違うので、途中で替えない)
 *
 * - `ts-mpeg2` … 元の TS (`CHANNEL.rawTs`)。MPEG-2 と AAC を WASM でデコードし、WebGL2 で描く
 * - `fmp4` … ライブ・追っかけのエンコードしたもの (`CHANNEL.videoInit` / `videoMedia`)。映像は WebCodecs の
 *   VideoDecoder でデコードして 2D で描き、音 (AAC・Opus) は WASM でデコードする (`fmp4.ts`)。
 *   **<video> の再生が止まる端末** (テスラの車載ブラウザ) のための道
 * - `mkv` … 端末に保存した録画 (エンコード済みの Matroska)。互換モードの観る画面で、読んだコマを `fmp4` と
 *   同じ道でデコードして描く (`mkv.ts`)。音は選んだ1本 (`audio` の何本目か)
 */
export type RawInput = 'ts-mpeg2' | 'fmp4' | 'mkv';

/** 画面 → worker */
export type ToWorker =
    | {
          type: 'init';
          /** 描く先。`transferControlToOffscreen` で渡す */
          canvas: OffscreenCanvas;
          /** デコーダの置き場 (`/api/live/mpeg2`)。worker からは絶対 URL で読む */
          decoder: string;
          input: RawInput;
          /**
           * 放送の今を追わないか (互換モードの追っかけ)。溜まっても先へ飛ばず、止めている間も
           * 捨てない。そのかわり溢れそうなら受け取るのをやめて `full` を返す
           */
          follow: boolean;
      }
    /**
     * 届いたもの (TS、または fMP4 の init・媒体1つ)。**頭の9バイト (多重化の頭) を飛ばした位置から**。
     * fMP4 は箱の切れ目で届く (サーバが割ってから送る。`ts/fmp4.ts` の `Fmp4Splitter`)
     */
    | { type: 'data'; buffer: ArrayBuffer; offset: number }
    /**
     * いま鳴っている PTS (90kHz。伸ばしたもの) と、それが鳴った時刻 (`performance.timeOrigin +
     * performance.now()` の ms)。**null は「止まっている」** — 絵もそこで止める
     */
    | { type: 'clock'; pts: number | null; at: number }
    /**
     * 選局し直した・録画で飛んだ。**前の局のものは全部捨てる。** `from` (90kHz。届くものの PTS の物差しで、
     * 元の TS なら一周の中) があれば、それより前のコマはデコードするだけで描かない — サーバは飛び先の少し手前
     * (鍵のコマ・1 秒前) から流すので、手前の絵 (CM を飛ばしたなら CM の絵) を出さないため
     */
    | { type: 'reset'; from?: number | null }
    /** 何本目の音声をデコードするか (`AudioTrack.stream`) */
    | { type: 'audio'; index: number }
    /**
     * いま出しているコマを1枚ください (切り抜き)。**絵は worker の canvas に居て、
     * 画面の側からは画素を読めない** (`transferControlToOffscreen` で渡したので)。
     * `id` は返事 (`frame`) と組にするため
     */
    | { type: 'grab'; id: number }
    /**
     * 小窓 (PiP) へ出す絵の書き込み口 (`MediaStreamTrackGenerator` の `writable`)。
     * **描いた1コマをその場で書き込む** — canvas の画面への更新を待たない (`engine.ts` の `pipStream`)
     */
    | { type: 'pip'; writable: WritableStream<VideoFrame> }
    /** 小窓へ書き込むか。出していない間は書かない (1コマごとに写すぶん重い) */
    | { type: 'pipFlow'; on: boolean };

/** worker → 画面 */
export type FromWorker =
    /** 使えなくなった (デコーダが無い・音がデコードできない・間に合わない。`budget.ts`)。**画面はエンコードしたものに戻る** */
    | { type: 'fail'; reason: string }
    /**
     * デコードできた音1コマ。面ごとの float (-1〜1)。**時刻は伸ばした PTS** (`pes.unwrap`)
     */
    | {
          type: 'audio';
          pts: number;
          duration: number;
          sampleRate: number;
          planes: Float32Array[];
      }
    /** 選局し直してから最初の絵を描いた。**前の局の静止画を剥がす合図** */
    | { type: 'shown' }
    /** 数字 (1秒ごと)。画面に出すもの */
    | { type: 'stats'; dropped: number; p95: number; shown: number }
    /** `grab` の返事。まだ何も出していなければ null */
    | { type: 'frame'; id: number; bitmap: ImageBitmap | null }
    /**
     * 抱えきれなくなったので、届いたものを捨て始めた (`follow` のときだけ)。**画面は手元が尽きる前に
     * 居る場所から頼み直す** (`live-player.svelte.ts` の `starved`)
     */
    | { type: 'full' };
