/**
 * **録画の観方の取り決め** (`GET /api/recordings/<id>/playback` と `/stream`)。画面にもサーバにも依らない。
 *
 * 分担: **サーバは「何を出せるか・どの形で出すか・時刻の物差し」を決める。画面は「どれを使うか」を
 * 決める** (端末で再生できるか、人が選んだコーデック、MPEG-2 をそのまま再生する設定)。サーバは
 * 端末が何かを知らない。決め方は `server/playback.ts`
 */

/** 出せる映像の形 */
export type PlayCodec = 'h264' | 'av1' | 'mpeg2';

/**
 * 出し方。
 *
 * - `file` … エンコード済みのファイルそのまま (`/api/recordings/<id>/file?source=`)。Range で読む
 * - `stream` … サーバがその場で fMP4 にして流す (`/stream?codec=`)。エンコード済みと同じコーデックなら
 *   詰め替えるだけ、違えばエンコードし直す。シークは `from` を変えて頼み直す
 * - `raw` … 元の TS を飛び先から流す (`/stream?codec=mpeg2`)。画面が自分で再生する
 */
export type PlayWay = 'file' | 'stream' | 'raw';

/** 配るファイルの名指し (`#lib/source.ts` の `FileSource` のうち、エンコード済み) */
export type EncodedSource = 'encoded' | 'alt';

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
 * `from` と流れの時刻は、どれもこれで数える。
 *
 * - `encoded` … エンコード済みのファイルの時刻
 * - `ts` … 元の TS の頭を 0 とした時刻 (エンコード済みが無い録画)
 */
export type PlayAxis = 'encoded' | 'ts';

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
export const ORIGIN_HEADER = 'X-Denpa-Origin';

/** 混んでいて断ったときの言い分 (503) */
export const BUSY = 'サーバが混んでいます';
