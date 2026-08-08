/**
 * ライブ視聴の字幕。**映像と同じ ffmpeg で、絵にして配る。**
 *
 *     エージェント (MPEG-TS) → ffmpeg ┬→ fMP4  (映像・音声) → WebSocket → MSE
 *                                     └→ mkv   (字幕の絵)   → WebSocket → canvas
 *
 * [stream.md](../../../docs/stream.md) §5.2 にあたる第2段階。放送に絵は流れて
 * こない — 乗っているのは文字と「どこに・どの大きさで・何色で・背景の箱つきで」
 * という指定で、テレビはそれを見て毎回自分で描いている。libaribcaption に同じように
 * 描かせたものが `-sub_type bitmap` で、**それが「放送どおりの字幕の絵」**になる。
 * 外字もここでは絵として出るので、対応表の取りこぼしが起きない。
 *
 * 描画系を録画と共通にしてあるので、**録画で見たものとライブで見たものが同じ絵**に
 * なる。ブラウザ側で B24 を解く道 (aribb24.js) を採らなかったのはこれが理由
 * (stream.md §6)。
 *
 * ## 映像と同じ ffmpeg で焼く。**それが時刻を揃える唯一の道だった**
 *
 * 以前は字幕だけ別の ffmpeg で取り出していた。**そうすると時刻が揃わない。**
 * ffmpeg は入口で時刻を 0 に寄せ直すが、その寄せ幅は**プロセスごとに違う** —
 * 別々に起こした2本は焼き始めの鍵フレームが 0〜0.5秒 ずれるので、出てきた
 * 時刻を突き合わせても意味を持たない (装置を5通り作って -60〜+450ms とばらけ、
 * 同じ局の2回で 150ms 動いた)。`-copyts` で放送の絶対時刻を保っても駄目で、
 * **mp4 の多重化器がその時刻を 0 に詰め直す**ため、受け側から見た 0 が
 * どの放送時刻かは外から知りようがない。
 *
 * 1本にすると、**入口の寄せが1回だけになって両方の出口に効く**。実機で
 * 突き合わせると、`-copyts` で測った字幕の時刻から映像の1枚目を引いたものと、
 * 一本化して出てきた時刻が**1ms 以内で一致**した:
 *
 *     -copyts の字幕 (絶対)  15733.5255 → 元TSの頭を引いて 0.829 秒
 *     一本化した字幕                                        0.829000 秒
 *
 * 費用もほぼ無い。同じ20秒を焼かせた実測で **10.6秒 (字幕つき) 対 10.7秒
 * (映像だけ)** — MPEG-2 の復号とインタレ解除と符号化に比べれば、字幕を描いて
 * PNG にするぶんは埋もれる。
 *
 * 引き換えに、**音声や焼き方を選び直すと字幕も焼き直し**になる (前は局ごとに
 * 1本だったので途切れなかった)。字幕は次が来るまで出しっぱなしのものなので、
 * 焼き直しの間は最後の1枚を配り直して繋ぐ (`Session.showing`)。
 *
 * ## 時刻は絵と一緒に運ばせる
 *
 * 生の PNG を並べただけ (`image2pipe`) では時刻が乗らない。以前は `showinfo` に
 * 喋らせて**標準エラーの行と標準出力の PNG を来た順に組にして**いたが、
 * **数が合わない** — 実機の日テレで70秒測ると PNG 77枚に対して showinfo は79行で、
 * 余った2行のぶんだけ以降ずっと1つずれる (一度ずれたら戻らない)。ずれると、
 * 字幕が出た枚に1つ前の「空」が当たって**消す**に化け、**字幕が1秒ほど遅れて
 * 出て、消えるのも遅れる**という、報告そのままの出方をする。
 *
 * いまは Matroska で受ける ([ts/mkv.ts](../ts/mkv.ts))。**時刻がコマそのものに
 * 付いてくる**ので、別々の口を突き合わせる必要がそもそも無い。
 *
 * ## PNG は ffmpeg に組ませる
 *
 * 設計では生の RGBA を受け取って、denpa が切り抜き・256色化・パレット PNG の
 * 組み立てまでやることにしていた。**実機で測ったら、ffmpeg に PNG まで
 * 畳ませるほうが速かった。** 同じ TS 30秒ぶんを通したときの実測:
 *
 *     生の RGBA   1.94秒   406 MB    1枚 8.29 MB
 *     PNG         1.05秒   1.76 MB   1枚 36 KB    ← これ
 *     256色 PNG   4.30秒   0.94 MB   1枚 19 KB
 *
 * **生のほうが遅いのは、書く量が桁違いだから** (毎秒 13MB をパイプに流す)。
 * 256色に落とせば半分になるが、そのために CPU を4倍払うことになる。
 *
 * ## 変わったときだけ送る
 *
 * sub2video は**同じ絵を何度も出す**。一本化すると映像のコマが心拍になるので
 * 出てくる枚数はさらに増える (実機で毎秒8枚)。そのまま流すと帯域を食うが、
 * **中身が変わっているのはごく一部**なので、同じ絵は配り直さない
 * (`Session.deliver`)。空の枚も、そのまま送って受け側に描かせる — 全部透明な
 * 絵を重ねるのは「消す」と同じ結果になるので、空かどうかを見分ける必要が無い。
 */

import { type CaptionTrack, CHANNEL } from '$lib/live';

/**
 * 字幕を描く画面の大きさ。
 *
 * **指定は要る。** 無いと libaribcaption は 1440x1080 (PROFILE_A) とみなすので、
 * 1920x1080 の放送では字幕だけ横に伸びる。受け側は映像の枠に合わせて伸ばすだけ
 * なので、放送が 1440x1080 でもここを 1920x1080 にしておけば辻褄が合う
 * (どちらも表示は 16:9)。
 */
export const CANVAS = { width: 1920, height: 1080 };

/** 字幕に使う字。録画と同じものを使う (見た目を揃えるため) */
const FONTS = 'Rounded M+ 1m for ARIB';

/** 記録に残す価値のある行。**それ以外は入り口の説明なので捨てる** */
export const TROUBLE = /error|Error|failed|Failed|Cannot|Unable|No such|Invalid data/;

/**
 * 字幕を絵で受け取るための、**入口の指定**。
 *
 * 映像と同じ ffmpeg なので入口は1つ。ここは復号のしかたの話で、
 * 映像には何も影響しない。
 *
 * - `-sub_type bitmap` … 文字ではなく絵で受け取る。描くのは libaribcaption
 * - `-canvas_size` … 上の説明。無いと 1440x1080 とみなされる
 */
export function captionInput(): string[] {
    return ['-sub_type', 'bitmap', '-canvas_size', `${CANVAS.width}x${CANVAS.height}`, '-font', FONTS];
}

/**
 * 字幕の出口。**映像とは別の口 (`pipe:3`) に出す。**
 *
 * - `null` … **何もしないフィルタ。** 字幕をフィルタに通すこと自体が目的で
 *   (それで sub2video が働く)、通す先は何でもよい。ここが `showinfo` だった
 *   頃は、その行と PNG を組にしていて**ずれていた** (上の説明)
 * - `-fps_mode passthrough` … 出てきた枚をそのまま出す。詰め直させない
 * - `-c:v png` … PNG まで ffmpeg に組ませる (上の説明)
 * - `matroska` … **時刻をコマと一緒に運ぶ器**。塊の上限を最小にして、
 *   1枚ごとに書き出させる (溜められるとそのぶん遅れる)
 *
 * @param from ffmpeg に渡す局の指定 (`0:p:<局>` か `0`)
 * @param track その局の中で何本目の字幕を出すか。**言語が複数ある放送**では
 *   2本以上乗っている (`TrackList`)
 */
export function captionOutput(from: string, track: number): string[] {
    return [
        '-filter_complex',
        `[${from}:s:${track}]null[s]`,
        '-map',
        '[s]',
        '-fps_mode',
        'passthrough',
        '-c:v',
        'png',
        '-pix_fmt',
        'rgba',
        '-cluster_time_limit',
        '1',
        '-cluster_size_limit',
        '1',
        '-flush_packets',
        '1',
        '-f',
        'matroska',
        'pipe:3',
    ];
}

/**
 * 字幕がその放送に無いときに ffmpeg が言うこと。
 *
 * 字幕を持たない局はある (ショッピングやサブチャンネル)。そこに
 * `[0:p:X:s:0]` を頼むと、ffmpeg は**組み立ての時点で降りる** — つまり
 * **映像も出ない**。そうと分かったら字幕なしで焼き直す (`Session.run`)。
 *
 * 実機で出させた2通り (どちらも `matches no streams` を含む):
 *
 *     Stream specifier ':s:0' in filtergraph description [0:s:0]null[s] matches no streams.
 *     Error binding filtergraph inputs/outputs: Invalid argument
 *
 * **組み立ての失敗は字幕側にしか無い。** 映像は `-vf` で通していて、
 * `-filter_complex` を使うのは字幕だけ
 */
export const NO_SUBTITLE = /matches no streams|Error binding filtergraph/;

/** 字幕1枚 */
export interface Caption {
    /** いつ出すか (ミリ秒)。**映像の mp4 と同じ物差し** (stream.md §5.4) */
    at: number;
    /** パレットではない RGBA の PNG。画面まるごとの大きさ */
    data: Uint8Array;
}

/** ffmpeg が入口の見出しに書く行 */
const PROGRAM = /^\s*Program (\d+)/;
const STREAM = /^\s*Stream #0:(\d+)\[0x[0-9a-f]+\](?:\((\w+)\))?: (\w+):/;

/**
 * ffmpeg の入口の見出しから、その局の字幕ストリームを拾う。
 *
 * **字幕が1枚も来ていなくても、あることは分かる。** 届いてから画面に
 * 切り替えを出していた頃は、**間隔の空く番組を開くとボタンが出なかった**
 * (実機の「みんなの手話」。番組表には [字] と出ているのに出ない)。
 *
 * ついでに**何本あるか**も分かる。言語が複数ある放送はここで2本になる。
 */
export class TrackList {
    private inProgram = false;
    private readonly found: CaptionTrack[] = [];

    /** @param program 放送が名乗っている番号。0以下なら最初に見つけた1本 */
    constructor(private readonly program: number) {}

    /** 1行食わせる。**中身が増えたら true** */
    feed(line: string): boolean {
        const program = line.match(PROGRAM);
        if (program !== null) {
            this.inProgram = Number(program[1]) === this.program;
            return false;
        }
        const stream = line.match(STREAM);
        if (stream === null || stream[3] !== 'Subtitle') return false;
        // 局を名指ししないときは、最初に見つけた1本だけ
        if (this.program > 0 ? !this.inProgram : this.found.length > 0) return false;

        const lang = stream[2] ?? null;
        const index = this.found.length;
        this.found.push({ index, lang, label: label(index, lang) });
        return true;
    }

    get tracks(): CaptionTrack[] {
        return this.found;
    }
}

/** ISO 639-2 のうち字幕で出てくるもの。`arib.ts` の表と揃えてある */
const LANGUAGE: Record<string, string> = {
    jpn: '日本語',
    eng: '英語',
    kor: '韓国語',
    zho: '中国語',
    spa: 'スペイン語',
    por: 'ポルトガル語',
    fra: 'フランス語',
    deu: 'ドイツ語',
};

function label(index: number, lang: string | null): string {
    const head = index === 0 ? '字幕' : `字幕${index + 1}`;
    if (lang === null) return head;
    return `${head} (${LANGUAGE[lang] ?? lang})`;
}

/** 90kHz。取り決めの時刻はこの刻み (stream.md §5.3) */
const CLOCK = 90;

/**
 * 送る形にする。**頭に置き場所を付ける** (stream.md §5.3)。
 *
 *     [1:種別][8:時刻 (90kHz)][2:x][2:y][2:w][2:h][PNG...]
 *
 * いまは画面まるごとを送るので x,y は 0 だが、**あとで切り抜くようにしても
 * 受け側を変えずに済む**ように持たせてある。
 *
 * **時刻は映像と同じ物差し** — 映像と同じ ffmpeg が付けたもの (上の説明)。
 * 受け側はこれを再生位置と突き合わせて、その瞬間に出す。
 *
 * **消すための別の種別は使わない。** 全部透明な絵を重ねれば消えるので、
 * 空かどうかを見分ける必要そのものが無い (上の説明)
 */
export function frame(caption: Caption): { kind: number; pts: bigint; data: Uint8Array } {
    const out = new Uint8Array(8 + caption.data.length);
    const view = new DataView(out.buffer);
    view.setUint16(0, 0);
    view.setUint16(2, 0);
    view.setUint16(4, CANVAS.width);
    view.setUint16(6, CANVAS.height);
    out.set(caption.data, 8);
    return {
        kind: CHANNEL.subtitle,
        // 負にはならないが、丸めで -0 が出ると符号なしに詰められない
        pts: BigInt(Math.max(0, Math.round(caption.at * CLOCK))),
        data: out,
    };
}
