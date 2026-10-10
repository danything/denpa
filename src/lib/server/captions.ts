/**
 * ライブ視聴の字幕。**映像と同じ ffmpeg から放送の字幕をそのまま受け取り、denpa が解いて
 * 「字の配置」にして配る** ([caption-text.ts](../caption-text.ts))。描くのは受け側。
 *
 *     エージェント (MPEG-TS) → ffmpeg ┬→ fMP4 (映像・音声)              → WebSocket → MSE
 *                                     └→ mkv  (字幕そのまま S_ARIBSUB)  → 解く (ts/b24caption.ts)
 *                                                                        → WebSocket (0x22 JSON) → canvas
 *
 * 放送に絵は流れてこない — 乗っているのは文字と「どこに・どの大きさで・何色で」という
 * 指定で、テレビはそれを見て毎回自分で描いている。以前はその描画を libaribcaption に
 * させて (`-sub_type bitmap`) PNG を配っていたが、**置き場所を決めるところまではサーバで、
 * 描くのは受け側で**に分けた。画面の画素で描けるので全画面でも字が粗くならず、
 * 配る量は数百バイト/枚、サーバは絵を描かない (実測は docs/stream.md §5.2)。
 * 置き場所の計算は libaribcaption の解き手をそのまま写したので、絵と同じ所に出る。
 *
 * ## 映像と同じ ffmpeg で受ける。**それが時刻を揃える唯一の道だった**
 *
 * ffmpeg は入口で時刻を 0 に寄せ直すが、その寄せ幅は**プロセスごとに違う** —
 * 別々に起こした2本は焼き始めの鍵フレームが 0〜0.5秒 ずれる (装置を5通り作って
 * -60〜+450ms とばらけた)。`-copyts` で放送の絶対時刻を保っても、**mp4 の多重化器が
 * その時刻を 0 に詰め直す**ので、受け側から見た 0 がどの放送時刻かは外から知りようがない。
 * 1本にすれば入口の寄せが1回だけになって両方の出口に効く (実機で 1ms 以内で一致)。
 *
 * 字幕は**解かずに写す** (`-c:s copy`)。時刻は絵にしていた頃と同じものが付く — 同じ
 * ffmpeg に絵と写しの両方を出させて突き合わせると、実機の録画で全部の字幕が同じ時刻
 * (0.838 / 2.840 / 7.811 …) だった。
 *
 * ## 時刻は字幕と一緒に運ばせる
 *
 * 並べただけでは時刻が乗らない (以前 `showinfo` の行と PNG を組にしていて**数が合わず
 * ずれた**)。Matroska で受ける ([ts/mkv.ts](../ts/mkv.ts)) と時刻がコマそのものに付いてくる。
 * ffmpeg の Matroska は ARIB の字幕を `S_ARIBSUB` としてそのまま入れられる。
 *
 * ## 絵の道 (テレビのアプリ向け。第3段階で外す)
 *
 * テレビのアプリ (denpa-tv) はまだ絵 (PNG) で受け取っている (`captionFeed`)。そのための
 * `captionInput` / `captionOutput` / `frame` と、字幕だけを描かせる `rawCaptionArgs` の
 * `png` は、アプリが文字の配置を描けるようになるまで残す。
 */

import { LANGUAGE } from '#lib/arib.js';
import { CAPTION_TEXT_VERSION, type CaptionPage, type CaptionPages } from '#lib/caption-text.js';
import { type CaptionTrack, CHANNEL, type Notice } from '#lib/live.js';
import { B24CaptionDecoder } from '#lib/ts/b24caption.js';
import { type MkvFrame, MkvSplitter } from '#lib/ts/mkv.js';

/**
 * 字幕を描く画面の大きさ。
 *
 * **指定は要る。** 無いと libaribcaption は 1440x1080 (PROFILE_A) とみなすので、
 * 1920x1080 の放送では字幕だけ横に伸びる。受け側は映像の枠に合わせて伸ばすだけ
 * なので、放送が 1440x1080 でもここを 1920x1080 にしておけば辻褄が合う
 * (どちらも表示は 16:9)。
 */
export const CANVAS = { width: 1920, height: 1080 };

/** 字幕に使う字 (ライブの絵の字幕)。 */
export const SUBTITLE_FONTS = 'Denpa Font';

/** 失敗を言っている行。**それ以外は入り口の説明なので捨てる** */
const TROUBLE = /error|Error|failed|Failed|Cannot|Unable|No such|Invalid data/;

/**
 * 放送の欠けにいちいち言われるぶん。**残さない。**
 *
 * 電波の欠けは日常的にあり、復号器はそのたびに「直した」「捨てた」を喋る。
 * `-loglevel error` で黙らせていた頃は見えなかったが、**選べる字幕を入口の
 * 見出しから拾うために info まで開けた**ので、そのまま流れてくるようになった。
 * 実機の弱い局では毎秒何行も出て、**本当の失敗がその中に埋もれる**。
 *
 * 消すのは「1パケットぶんの取りこぼし」だけ。組み立てや符号器の失敗
 * (`Error opening output`, `Error binding filtergraph`) は残る
 */
const NOISE = /concealing|Error submitting packet to decoder|Decode error rate|Last message repeated/;

/** その行を記録に残すか */
export function worthLogging(line: string): boolean {
    return TROUBLE.test(line) && !NOISE.test(line);
}

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
    return [
        '-sub_type',
        'bitmap',
        '-canvas_size',
        `${CANVAS.width}x${CANVAS.height}`,
        '-font',
        SUBTITLE_FONTS,
    ];
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
 * 字幕を**解かずに写す**出口。映像とは別の口 (`pipe:3`) に出す。
 *
 * - `-c:s copy` … 字幕の PES の中身をそのまま (`S_ARIBSUB`)。解くのは denpa (`CaptionText`)
 * - `matroska` … **時刻をコマと一緒に運ぶ器**。塊の上限を最小にして、
 *   1枚ごとに書き出させる (溜められるとそのぶん遅れる)
 *
 * @param from ffmpeg に渡す局の指定 (`0:p:<局>` か `0`)
 * @param track その局の中で何本目の字幕を出すか。**言語が複数ある放送**では
 *   2本以上乗っている (`TrackList`)
 */
export function textCaptionOutput(from: string, track: number): string[] {
    return [
        '-map',
        `${from}:s:${track}`,
        '-c:s',
        'copy',
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

/** ffmpeg に名指しさせる入力。局の番号が分からなければ (0以下) 入力そのもの */
export function programSpec(program: number): string {
    return Number.isFinite(program) && program > 0 ? `0:p:${program}` : '0';
}

/**
 * **生で送る道の字幕** (docs/stream.md §5.5)。映像は焼かないので、ffmpeg には字幕だけを
 * 写させる (`text`。ブラウザ向け) か、描かせる (`png`。テレビのアプリ向け。第3段階で外す)。
 *
 * 焼く道で「同じ ffmpeg に両方焼かせる」のは、ffmpeg が入口で時刻を 0 に寄せ、その
 * 寄せ幅がプロセスごとに違うからだった (上の説明)。生の道では**寄せない** (`-copyts`) —
 * 受け側が合わせる相手は放送の PTS そのもの (ブラウザが自分で PES から読む) なので、
 * 字幕も放送の PTS のまま出せば突き合わせられる。mp4 の多重化器が時刻を 0 に詰め直す
 * 問題は、字幕の出口 (Matroska) には無い。実機の録画で、出てきた字幕の時刻が元の TS の
 * 字幕 PES の PTS と 1ms 単位で一致した (71759.734333 → 71759.734)。
 *
 * **`-copyts` を外すと合わない。** 映像を出さない ffmpeg は寄せ幅を入口の `start:` とは
 * 違う値にし (同じ録画で 0.3〜0.7秒ずれた)、それを外から知る方法が無い。
 *
 * 映像を解かない (字幕の ES だけを読む) ので、焼く ffmpeg と違って CPU はほとんど使わない
 * (写すだけの `text` なら字幕も解かない)
 *
 * @param program ffmpeg に名指しさせる局の番号 (0以下なら最初の局)
 * @param track その局の中で何本目の字幕か
 */
export function rawCaptionArgs(program: number, track: number, form: CaptionForm = 'text'): string[] {
    const from = programSpec(program);
    return [
        '-hide_banner',
        '-nostats',
        '-fflags',
        'nobuffer',
        '-probesize',
        '100000',
        '-copyts',
        ...(form === 'png' ? captionInput() : []),
        '-i',
        'pipe:0',
        ...(form === 'png' ? captionOutput(from, track) : textCaptionOutput(from, track)),
    ];
}

/** 字幕をどの形で受け取るか。`text` は文字の配置 (0x22)、`png` は絵 (0x20。テレビのアプリ向け) */
export type CaptionForm = 'text' | 'png';

/**
 * 字幕がその放送に無いときに ffmpeg が言うこと。
 *
 * 字幕を持たない局はある (ショッピングやサブチャンネル)。そこに
 * `0:p:X:s:0` を頼むと、ffmpeg は**組み立ての時点で降りる** — つまり
 * **映像も出ない**。そうと分かったら字幕なしで焼き直す (`Session.run`)。
 *
 * 写す出口 (`-map`) なら `Stream map '' matches no streams.`、絵の出口 (`-filter_complex`) なら
 * `Stream specifier ':s:0' in filtergraph description [0:s:0]null[s] matches no streams.` と
 * `Error binding filtergraph inputs/outputs` が出る
 */
export const NO_SUBTITLE = /matches no streams|Error binding filtergraph/;

/**
 * 字幕1枚。**器から出てきたコマそのもの** ([ts/mkv.ts](../ts/mkv.ts))。
 *
 * `at` は出す時刻 (ミリ秒。**映像の mp4 と同じ物差し** — stream.md §5.4)、
 * `data` はパレットではない RGBA の PNG で、画面まるごとの大きさ
 */
export type Caption = MkvFrame;

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

/** 文字の配置の1枚と、出す時刻 (ミリ秒。器のコマの時刻そのまま) */
export interface CaptionShown {
    at: number;
    page: CaptionPage;
}

/**
 * 写してきた字幕 (`S_ARIBSUB` のコマ) を解いて、文字の配置にする。**字幕の流れ1本に1つ** —
 * 書式や位置は字幕文を跨いで続くので、ffmpeg を起こし直したら作り直す
 */
export class CaptionText {
    private readonly decoder = new B24CaptionDecoder();
    /** 読めなかったと言ったか。**1回だけ言う** (壊れた放送は続けて壊れていることが多い) */
    private told = false;

    /**
     * 出すものが無いコマ (字幕管理データ・送り直し・待ちだけ) なら null。
     * **読めないコマは捨てて続ける** — 投げると、受けている側 (ライブの字幕の口) ごと止まる
     */
    feed(frame: MkvFrame): CaptionShown | null {
        try {
            const page = this.decoder.decode(frame.data);
            return page === null ? null : { at: frame.at, page };
        } catch (error) {
            if (!this.told) console.warn(`[captions] 字幕を1コマ読めませんでした: ${String(error)}`);
            this.told = true;
            return null;
        }
    }
}

/**
 * 送る形にする。**中身は JSON** (`CaptionPage`)、頭の時刻は絵と同じ物差し (90kHz)。
 * 前の1枚を丸ごと置き換えるので、消すのも同じ種別 (`runs` が空) で送る
 */
export function textFrame(shown: CaptionShown): { kind: number; pts: bigint; data: Uint8Array } {
    return {
        kind: CHANNEL.captionText,
        pts: BigInt(Math.max(0, Math.round(shown.at * CLOCK))),
        data: new TextEncoder().encode(JSON.stringify(shown.page)),
    };
}

/**
 * **アプリ向けの字幕の口** (`GET /api/services/<id>/captions`・`GET /api/recordings/<id>/captions`。
 * docs/api.md) の1こま。WebSocket の1こま (stream.md §5.3) の頭に、後ろの長さを足しただけ:
 *
 *     [4:後ろの長さ (BE)][1:種別][8:時刻 (90kHz, BE)][中身...]
 *
 * **WebSocket と同じバイトにしたのは、受け側の読み方を1つにするため。** 字幕の絵 (`0x20`) は
 * 中身の頭に置き場所が付いたまま、知らせ (`0x40`) は JSON のまま。
 *
 * **長さを付けるのは、HTTP には区切りが無いから。** WebSocket はこまの区切りを運んでくれるが、
 * チャンク転送のチャンクの区切りは受け側 (HttpURLConnection など) から見えない。
 * Server-Sent Events にしなかったのは、PNG を base64 にすると 1/3 太り、行に割って読む手間も要るため
 */
export function appFrame(kind: number, pts: bigint, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(4 + 1 + 8 + payload.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, 1 + 8 + payload.length);
    view.setUint8(4, kind);
    view.setBigUint64(5, pts);
    out.set(payload, 13);
    return out;
}

/** 読まれないまま溜まってよい量 (バイト)。超えたら閉じる (受け側は頼み直す) */
export const CAPTION_FEED_BACKLOG = 8 * 1024 * 1024;

/**
 * 読まれないまま溜まったら、作る側に**待ってもらう**量 (バイト)。録画の字幕は録画を読む速さで
 * 作れるので、受け側が先読みを止めたら (アプリは持つ枚数に上限がある) 録画を読むのも止める
 * (`CaptionOut.backedUp`)。閉じる量より必ず小さくする
 */
export const CAPTION_FEED_HOLD = 1024 * 1024;

/**
 * 何も届かなくても送る間 (ms)。**字幕の無い時間は数分続く**ので、黙っていると前段
 * (nginx の既定は 60 秒) や受け側の読みの時間切れに切られる
 */
const CAPTION_PING_MS = 20_000;

const PING = new TextEncoder().encode(JSON.stringify({ type: 'ping' }));

/** アプリ向けの字幕の口に流し込む側 (`captionFeed`) */
export interface CaptionOut {
    /** WebSocket と同じ形で1こま渡す。**字幕 (絵か文字の配置) と、選べる字幕の知らせだけ通す** */
    send(kind: number, pts: bigint, payload: Uint8Array): void;
    /** 終わり (録画を読み切った・セッションが畳まれた) */
    close(): void;
    /** 読まれずに溜まっているか (`CAPTION_FEED_HOLD`)。作る側が待てるなら待つ */
    backedUp(): boolean;
}

/**
 * アプリ向けの字幕の口を作る。中身を作る側 (`open`) は、閉じるときの後始末を返す。
 *
 * 通すのは字幕 (絵 `0x20` か文字の配置 `0x22`。頼まれた形のほう) と、選べる字幕の知らせ (`0x40` の `captions`) だけ。
 * `error` / `ended` の知らせが来たら閉じる。ほかの知らせ・データ放送・映像は捨てる
 * (映像は同じ URL の隣の口 — ライブの `live` や追っかけの `chase` — で受け取っている)
 */
export function captionFeed(open: (out: CaptionOut) => () => void): ReadableStream<Uint8Array> {
    let closed = false;
    let detach: (() => void) | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = () => {
        closed = true;
        clearInterval(timer);
        const leave = detach;
        detach = null;
        leave?.();
    };
    return new ReadableStream<Uint8Array>(
        {
            start(controller) {
                // 読まない相手に積み続けない。閉じれば受け側は頼み直す
                const push = (kind: number, pts: bigint, payload: Uint8Array) => {
                    if ((controller.desiredSize ?? 0) < -CAPTION_FEED_BACKLOG) return out.close();
                    controller.enqueue(appFrame(kind, pts, payload));
                };
                const out: CaptionOut = {
                    send(kind, pts, payload) {
                        if (closed) return;
                        if (kind === CHANNEL.control) {
                            const notice = JSON.parse(new TextDecoder().decode(payload)) as Notice;
                            if (notice.type === 'error' || notice.type === 'ended') return out.close();
                            if (notice.type !== 'captions') return;
                        } else if (kind !== CHANNEL.subtitle && kind !== CHANNEL.captionText) {
                            return;
                        }
                        push(kind, pts, payload);
                    },
                    close() {
                        if (closed) return;
                        finish();
                        controller.close();
                    },
                    backedUp: () => (controller.desiredSize ?? 0) < -CAPTION_FEED_HOLD,
                };
                timer = setInterval(() => {
                    if (!closed) push(CHANNEL.control, 0n, PING);
                }, CAPTION_PING_MS);
                const leave = open(out);
                // 作っている最中に閉じた (セッションがもう畳まれていた) ら、すぐ後始末する
                if (closed) leave();
                else detach = leave;
            },
            cancel() {
                if (!closed) finish();
            },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: 256 * 1024 }),
    );
}

/** アプリ向けの字幕の口の `?format=`。`text` なら文字の配置、それ以外 (省いたとき) は絵 */
export function captionForm(url: URL): CaptionForm {
    return url.searchParams.get('format') === 'text' ? 'text' : 'png';
}

/**
 * 焼いたもの (mkv) から抜いた字幕の軌道を解く。**入っているのが ARIB の字幕 (`S_ARIBSUB`) の
 * ときだけ** — 前に焼いた録画は絵 (PGS) が入っていて、そちらは観る画面が自分で解く (`pgs.ts`)
 *
 * @param data ffmpeg に `-map 0:s:0 -c:s copy -f matroska` で抜かせたもの
 * @returns ARIB の字幕でなければ null
 */
export function pagesFromMkv(data: Uint8Array): CaptionPages | null {
    const splitter = new MkvSplitter();
    const frames = splitter.feed(data);
    if (splitter.codecs[0] !== 'S_ARIBSUB') return null;
    const text = new CaptionText();
    const pages: CaptionPages['pages'] = [];
    for (const frame of frames) {
        const shown = text.feed(frame);
        if (shown !== null) pages.push({ at: shown.at / 1000, page: shown.page });
    }
    return { v: CAPTION_TEXT_VERSION, pages };
}
