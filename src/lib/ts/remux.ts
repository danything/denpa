/**
 * **焼いたものをそのまま読めないブラウザに、サーバで fMP4 へ詰め替えて渡す** (#503)。
 * 決め方と、器に溜めたものの数え方だけ (画面にもサーバにも依らない)。
 *
 * 焼いたものは Matroska (映像 + Opus)。iPhone の Safari は Matroska を WebM としてしか
 * 読まず、WebM に入れてよい映像は VP8 / VP9 / AV1 だけ (H.264 は開発者向けの設定の奥)。
 * それで H.264 の録画だけ黒いまま止まっていた。ライブ・追っかけと同じ fMP4 (H.264 + AAC) に
 * 詰め替えれば MSE (iPhone は `ManagedMediaSource`) で出せる。映像は焼き直さず写すだけ、
 * 音声だけ AAC にする (`server/remux.ts`)。流し方は `remux-player.ts`
 *
 * **2027-09 以降に外す** (この詰め替えの道ごと: `ts/remux.ts`・`server/remux.ts`・`remux-player.ts`・
 * `api/recordings/<id>/media`・`remux` と docs/library.md の断り書き)。AV1 を解けない iPhone
 * (無印の 15 まで) は 2025-09 で売られなくなった。その2年後には AV1 で焼けば済む
 */

/** 配るファイルの名指し (`#lib/source.ts` の `FileSource` のうち、焼いたもの) */
export type EncodedSource = 'encoded' | 'alt';

/** 焼いたファイル1本の中身 (`GET /api/recordings/<id>/media`) */
export interface MediaFile {
    source: EncodedSource;
    /** 映像の codecs 文字列 (`avc1.640028` / `av01.0.08M.08`)。読めない・無ければ null */
    video: string | null;
    /** 音声の codecs 文字列 (`opus` / `mp4a.40.2`)。読めない・無ければ null */
    audio: string | null;
    /** 音声トラックの名前 (入れ物の title)。無名は空文字 */
    audios: string[];
    /** 尺 (秒)。読めなければ null */
    duration: number | null;
}

/** ブラウザに聞く口。**試しで差し替えられるように**受け取る */
export interface MediaAbility {
    /** `<video>` にそのまま渡して読めるか (`canPlayType` が空でない) */
    play(type: string): boolean;
    /** MSE の器が受け取れるか (`isTypeSupported`)。器が無ければ false */
    mse(type: string): boolean;
}

export type Playback =
    | { way: 'direct'; source: EncodedSource }
    | { way: 'remux'; source: EncodedSource; codecs: string; audios: string[]; duration: number };

/** 詰め替えたものの codecs。音声は必ず AAC にする (`server/remux.ts`) */
export function remuxType(file: Pick<MediaFile, 'video' | 'audios'>): string {
    const codecs = file.audios.length > 0 ? `${file.video},mp4a.40.2` : `${file.video}`;
    return `video/mp4; codecs="${codecs}"`;
}

/**
 * どれを、どう観るか。
 *
 * 1. **そのまま読めるファイルがあれば、それ。** Matroska と WebM の両方で聞く —
 *    Chrome は `video/x-matroska` に答えるが、Safari は WebM としてしか答えない
 *    (AV1 の Matroska はそれで読める)
 * 2. 無ければ、**MSE が受け取れるものを詰め替える**
 * 3. どちらも無ければ (iOS 16 以前の iPhone など MSE の器が無い端末) そのまま渡し、
 *    読めなかったら今までどおり落とす口を出す
 *
 * 主 (`encoded`) を先に見る。両方焼いた録画では、AV1 を解けない端末が H.264 (`alt`) に回る。
 * 中身が読めなかったもの (ffprobe が居ない・壊れている) は判断に使わない
 */
export function pickPlayback(files: MediaFile[], can: MediaAbility): Playback {
    const known = files.filter((file) => file.video !== null);
    for (const file of known) {
        const codecs = file.audio === null ? `${file.video}` : `${file.video},${file.audio}`;
        if (can.play(`video/x-matroska; codecs="${codecs}"`) || can.play(`video/webm; codecs="${codecs}"`)) {
            return { way: 'direct', source: file.source };
        }
    }
    for (const file of known) {
        if (file.duration === null || !(file.duration > 0)) continue;
        const type = remuxType(file);
        if (can.mse(type)) {
            return {
                way: 'remux',
                source: file.source,
                codecs: type,
                audios: file.audios,
                duration: file.duration,
            };
        }
    }
    return { way: 'direct', source: 'encoded' };
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
 * 跳んだ先 `t` を、**頼み直さずに待てば届くか。**
 *
 * - いま溜まっている区間の中なら、そのまま
 * - 読んでいる最中 (`from` から頼んだ流れが伸びている) で、その伸びる先の少し先
 *   (`slack` 秒) までなら待つ。10秒送りのたびに頼み直すと、毎回鍵フレームまで戻って
 *   詰め直すぶん遅い
 *
 * @param from 読んでいる流れの頼んだ位置。読んでいなければ null
 */
export function covers(ranges: Ranges, t: number, from: number | null, slack: number): boolean {
    if (aheadOf(ranges, t) > 0) return true;
    if (from === null || t < from - GAP) return false;
    // 頼んだ位置から伸びている区間の尻。まだ何も届いていなければ頼んだ位置
    let end = from;
    for (const [start, stop] of ranges) {
        if (start <= from + GAP && stop >= from) end = Math.max(end, stop);
    }
    return t <= end + slack;
}
