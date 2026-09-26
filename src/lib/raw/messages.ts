/**
 * 画面 (`engine.ts`) と worker (`worker.ts`) の取り決め。**両側から読む。**
 *
 * 分け方: TS を解く・絵を解いて描く・音を解くのは worker、**音を鳴らすのと時計は画面**
 * (Web Audio は worker から触れない)。時計は画面から worker へ流す (`clock`)。
 */

/** 画面 → worker */
export type ToWorker =
    | {
          type: 'init';
          /** 描く先。`transferControlToOffscreen` で渡す */
          canvas: OffscreenCanvas;
          /** 復号器の置き場 (`/api/live/mpeg2`)。worker からは絶対 URL で読む */
          decoder: string;
      }
    /** 届いた TS。**頭の9バイト (多重化の頭) を飛ばした位置から** */
    | { type: 'data'; buffer: ArrayBuffer; offset: number }
    /**
     * いま鳴っている PTS (90kHz。伸ばしたもの) と、それが鳴った時刻 (`performance.timeOrigin +
     * performance.now()` の ms)。**null は「止まっている」** — 絵もそこで止める
     */
    | { type: 'clock'; pts: number | null; at: number }
    /** 選局し直した。**前の局のものは全部捨てる** */
    | { type: 'reset' }
    /** 何本目の音声を解くか (`AudioTrack.stream`) */
    | { type: 'audio'; index: number };

/** worker → 画面 */
export type FromWorker =
    /** 復号器を読み終えた */
    | { type: 'ready' }
    /** 使えなくなった。**画面は焼いたものに戻る** */
    | { type: 'fail'; reason: string }
    /** 解く・描くのが間に合わない。**画面は焼いたものに戻る** (`budget.ts`) */
    | { type: 'slow'; reason: string }
    /**
     * 解けた音1コマ。面ごとの float (-1〜1)。**時刻は伸ばした PTS** (`pes.unwrap`)
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
    | { type: 'stats'; dropped: number; p95: number; shown: number; width: number; height: number };
