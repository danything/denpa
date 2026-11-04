/**
 * **回線に合わせて下げる画質の段。** サーバ (変換の引数・ライブを共有する単位) と画面 (`adapt.ts` の上げ下げ・メニューの表示) が
 * 同じ表を使う (docs/stream.md「回線に合わせて画質を下げる」)。
 *
 * 段は解像度で組む。ビットレートは「その解像度で画質が保てる上限」で、回線に合わせて削らずに次の段へ下りる。
 * 段どうしがそろうので、同じ段の人どうしでライブのエンコードを共有できる。
 *
 * - 段 0 は下げない (エンコード済みのファイル・MPEG-2・ふだんのエンコード)
 * - 段 1〜3 は 30 コマ。放送は 1080i (30 コマ相当) で、60 コマに比べてエンコードが半分、1 コマあたりのビットが倍になる。
 *   元が 30 コマ以下のエンコード済み (24 コマ) はコマを足さずにそのままのコマ数で縮める (`server/live.ts` の `rungVideo`)
 * - 段 1〜3 の音声は 96 kbit/s。ふだんの 256 kbit/s は 2.4 Mbit/s の回線の 1 割を使う
 */

/** 段の番号。0 は下げない */
export type Rung = 0 | 1 | 2 | 3;

/** 下げた段 (変換するもの) の中身 */
export interface RungSpec {
  /** 映像の高さ。幅は縦横比を保って偶数にそろえる */
  height: number;
  /** コマ数の上限。元がこれ以下のエンコード済みは、そのままのコマ数 */
  fps: number;
  /** 映像のビットレートの上限 (kbit/s) */
  videoKbps: number;
}

/** 段 1〜3。値は実測 (RK3588・J4125) で直す前提の目安 */
export const RUNG_SPECS: Readonly<Record<Exclude<Rung, 0>, RungSpec>> = {
  1: { height: 720, fps: 30, videoKbps: 3000 },
  2: { height: 540, fps: 30, videoKbps: 1500 },
  3: { height: 360, fps: 30, videoKbps: 600 },
};

/** 段 1〜3 の音声のビットレート (kbit/s) */
export const RUNG_AUDIO_KBPS = 96;

/** 下げた段のうち、いちばん低いもの */
export const LOWEST_RUNG = 3 satisfies Rung;

/** クエリや指示の値を段として読む。読めない値は 0 (下げない) */
export function parseRung(value: unknown): Rung {
  const n = typeof value === "string" ? Number(value) : value;
  return n === 1 || n === 2 || n === 3 ? n : 0;
}

/** メニューと断り書きに出す名前 (「540p」)。段 0 は null */
export function rungLabel(rung: Rung): string | null {
  return rung === 0 ? null : `${RUNG_SPECS[rung].height}p`;
}

/**
 * **サーバが測った送り出しの状態** (WebSocket の `pace`。2 秒ごとか変わったときに送る)。
 * 回線が細いのか、サーバのエンコードが遅いのかを画面が読み分けるために使う
 */
export interface Pace {
  /** 送れずに溜まっている量 (バイト) */
  backlog: number;
  /** 前の `pace` から捨てた映像の塊の数 */
  dropped: number;
  /** エンコードの速さ (出力した時刻の進み ÷ 実時間)。エンコードしない経路は null */
  speed: number | null;
}

/**
 * エンコードの速さ (`Pace.speed`) がこれを切ったら遅れている。サーバが軽い組み合わせで作り直すか決める (`server/live.ts` の
 * `LIGHT_SLOW`) のも、画面がエンコードの遅れと読む (`adapt.ts`) のも同じ値にする。1 ちょうどにしないのは、塊の届き方で
 * 1 の前後に揺れるため (5 秒の窓で 0.05 秒ぶんの塊 1 つが 1%)。画面だけ 1 で切っていた頃は、2 Mbit/s で 720p を流した
 * ときに 0.99 が 4 秒続いて「サーバのエンコードが追いつかないため、再生が止まります」が出て、その間は段を下げなかった
 */
export const ENCODE_SLOW = 0.95;
