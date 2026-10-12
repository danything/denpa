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

/** 画面が選べるコーデック。`auto` は端末に合わせて決める (`pickOffer`) */
export type CodecChoice = 'auto' | 'h264' | 'av1';

/** ブラウザに聞く口。**試しで差し替えられるように**受け取る */
export interface MediaAbility {
    /** `<video>` にそのまま渡して読めるか (`canPlayType` が空でない) */
    play(type: string): boolean;
    /** MSE の器が受け取れるか (`isTypeSupported`)。器が無ければ false */
    mse(type: string): boolean;
}

/** どれで観るか */
export type Picked =
    | { way: 'file'; codec: PlayCodec; source: EncodedSource }
    | { way: 'stream'; codec: 'h264' | 'av1'; type: string };

/**
 * そのままのファイルを読めるか。Matroska と WebM の両方で聞く — Chrome は `video/x-matroska` に答えるが、
 * Safari は WebM としてしか答えない (AV1 の Matroska はそれで読める)。中身が分からないものは false
 */
function playsFile(offer: PlayOffer, can: MediaAbility): boolean {
    if (offer.way !== 'file' || offer.codecs === undefined) return false;
    return (
        can.play(`video/x-matroska; codecs="${offer.codecs}"`) ||
        can.play(`video/webm; codecs="${offer.codecs}"`)
    );
}

/** MSE に渡す型 */
export function streamType(offer: PlayOffer): string {
    return `video/mp4; codecs="${offer.codecs ?? ''}"`;
}

function playsStream(offer: PlayOffer, can: MediaAbility): boolean {
    return offer.way === 'stream' && offer.codecs !== undefined && can.mse(streamType(offer));
}

function asPicked(offer: PlayOffer): Picked | null {
    if (offer.way === 'file' && offer.source !== undefined) {
        return { way: 'file', codec: offer.codec, source: offer.source };
    }
    if (offer.way === 'stream' && offer.codec !== 'mpeg2') {
        return { way: 'stream', codec: offer.codec, type: streamType(offer) };
    }
    return null;
}

/**
 * **どれで観るか。** 人が選んだコーデックがあれば、それを観られる道 (ファイルそのまま → その場で流す)。
 * 観られなければ、または `auto` なら端末に合わせる:
 *
 * 1. **そのまま読めるファイル** (並びはサーバの順。主 → もう一方)
 * 2. MSE が受け取れる**詰め替え** (エンコード済みと同じコーデック。サーバは軽い)
 * 3. MSE が受け取れる**変換** (H.264 → AV1 の順。サーバはその場でエンコードする)
 * 4. 中身が分からないファイル (ffprobe が読めなかった) をそのまま渡す。読めなければ落とす口を出す
 *
 * MPEG-2 (`raw`) はここでは選ばない (そのまま再生する道は画面の設定で別に決める)。何も無ければ null
 */
export function pickOffer(
    info: PlaybackInfo,
    can: MediaAbility,
    choice: CodecChoice = 'auto',
): Picked | null {
    const files = info.offers.filter((offer) => offer.way === 'file');
    const streams = info.offers.filter((offer) => offer.way === 'stream');
    if (choice !== 'auto') {
        const file = files.find((offer) => offer.codec === choice && playsFile(offer, can));
        const stream = streams.find((offer) => offer.codec === choice && playsStream(offer, can));
        const chosen = file ?? stream;
        if (chosen !== undefined) return asPicked(chosen);
    }
    const order = [
        ...files.filter((offer) => playsFile(offer, can)),
        ...streams.filter((offer) => playsStream(offer, can) && files.some((f) => f.codec === offer.codec)),
        ...streams.filter((offer) => playsStream(offer, can)),
        ...files,
    ];
    const first = order[0];
    return first === undefined ? null : asPicked(first);
}

/**
 * **コーデックのメニューに並べるもの。** この端末で観られる道があるコーデック (H.264 → AV1)
 */
export function codecChoices(info: PlaybackInfo, can: MediaAbility): ('h264' | 'av1')[] {
    return (['h264', 'av1'] as const).filter((codec) =>
        info.offers.some(
            (offer) => offer.codec === codec && (playsFile(offer, can) || playsStream(offer, can)),
        ),
    );
}

/*
 * ---------------------------------------------------------------------------
 * 互換モード (`canvas-video.ts`)。**`<video>` を使わず canvas に描く** (`canvas-player.ts`)。
 * 使えるのは流すもの (`stream` の fMP4 と `raw` の元の TS) だけで、ファイルそのままは使えない
 * (Matroska を自分で読む作りは持たない)
 * ---------------------------------------------------------------------------
 */

/** 互換モードで描く形 */
export type CanvasCodec = PlayCodec;

/** この端末で描ける形 (`raw/support.ts` の `canvasSupport` と `rawUnsupported`) */
export type CanvasAbility = Record<CanvasCodec, boolean>;

/** 互換モードのメニューに並べるもの。**出せるものは描けなくても並べる** (押せなくして、理由を添える) */
export function canvasChoices(
    info: PlaybackInfo,
    can: CanvasAbility,
): { codec: CanvasCodec; drawable: boolean }[] {
    return (['h264', 'av1', 'mpeg2'] as const)
        .filter((codec) =>
            info.offers.some(
                (offer) => offer.codec === codec && offer.way === (codec === 'mpeg2' ? 'raw' : 'stream'),
            ),
        )
        .map((codec) => ({ codec, drawable: can[codec] }));
}

/**
 * **互換モードでどれで観るか。** 選んだものが描ければそれ。`auto` か、選んだものが描けなければ:
 *
 * 1. エンコード済みと同じ形の fMP4 (詰め替え。サーバは軽い)
 * 2. 変換する fMP4 (H.264 → AV1)
 * 3. 元の TS (MPEG-2)
 *
 * `avoid` は諦めた形 (描いている途中で間に合わなくなった)。何も描けなければ null
 */
export function pickCanvas(
    info: PlaybackInfo,
    can: CanvasAbility,
    choice: CodecChoice | 'mpeg2' = 'auto',
    avoid: readonly CanvasCodec[] = [],
): CanvasCodec | null {
    const usable = canvasChoices(info, can)
        .filter((item) => item.drawable && !avoid.includes(item.codec))
        .map((item) => item.codec);
    if (choice !== 'auto' && usable.includes(choice)) return choice;
    const light = usable.filter(
        (codec) =>
            codec !== 'mpeg2' && info.offers.some((offer) => offer.way === 'file' && offer.codec === codec),
    );
    return [...light, ...usable][0] ?? null;
}

/** 互換モードで、その形で観るとサーバがその場でエンコードするか (枠を使う。混んでいると断られる) */
export function canvasTranscodes(info: PlaybackInfo, codec: CanvasCodec): boolean {
    return codec !== 'mpeg2' && !info.offers.some((offer) => offer.way === 'file' && offer.codec === codec);
}

/** 選んだもので観るとき、サーバがその場でエンコードするか (枠を使う。混んでいると断られる) */
export function transcodes(info: PlaybackInfo, picked: Picked): boolean {
    return (
        picked.way === 'stream' &&
        !info.offers.some((offer) => offer.way === 'file' && offer.codec === picked.codec)
    );
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
