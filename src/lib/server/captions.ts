/**
 * 字幕 (ライブ・録画)。**映像と同じ ffmpeg から放送の字幕をそのまま受け取り、denpa がデコードして
 * 「字の配置」にして配る** ([caption-text.ts](../caption-text.ts))。描くのは受け側。
 *
 *     エージェント (MPEG-TS) → ffmpeg ┬→ fMP4 (映像・音声)              → WebSocket → MSE
 *                                     └→ mkv  (字幕そのまま S_ARIBSUB)  → デコードする (ts/b24caption.ts)
 *                                                                        → WebSocket (0x22 JSON) → canvas
 *
 * 放送に画像は流れてこない — 乗っているのは文字と「どこに・どの大きさで・何色で」という
 * 指定で、テレビはそれを見て毎回自分で描いている。**置き場所を決めるところまではサーバで、
 * 描くのは受け側で。** 画面の画素で描けるので全画面でも字が粗くならず、
 * 配る量は数百バイト/枚、サーバは画像を描かない (実測は docs/stream.md#字幕)。
 *
 * ## 映像と同じ ffmpeg で受ける。**それが時刻を揃える唯一の方法**
 *
 * ffmpeg は入口で時刻を 0 に寄せ直すが、その寄せ幅は**プロセスごとに違う** —
 * 別々に起こした2本はエンコードを始めたときのキーフレームが 0〜0.5秒 ずれる (仕掛けを5通り作って
 * -60〜+450ms とばらけた)。`-copyts` で放送の絶対時刻を保っても、**mp4 のマルチプレクサが
 * その時刻を 0 に詰め直す**ので、受け側から見た 0 がどの放送時刻かは外から知りようがない。
 * 1本にすれば入口の寄せが1回だけになって両方の出口に効く (実機で 1ms 以内で一致)。
 *
 * 字幕は**デコードせずに写す** (`-c:s copy`)。ffmpeg に字幕のデコーダは要らない。
 *
 * ## 時刻は字幕と一緒に運ばせる
 *
 * Matroska で受ける ([ts/mkv.ts](../ts/mkv.ts)) と時刻がコマそのものに付いてくる。
 * ffmpeg の Matroska は ARIB の字幕を `S_ARIBSUB` としてそのまま入れられる。
 */

import { LANGUAGE } from '#lib/arib.js';
import {
    CAPTION_TEXT_VERSION,
    type CaptionLanguage,
    type CaptionLanguagePages,
    type CaptionPage,
    type CaptionPages,
} from '#lib/caption-text.js';
import { type CaptionTrack, CHANNEL, type Notice } from '#lib/live.js';
import { B24CaptionDecoder, isManagement } from '#lib/ts/b24caption.js';
import { type MkvFrame, MkvSplitter } from '#lib/ts/mkv.js';
import { CLOCK } from '#lib/ts/pes.js';

/** 失敗を言っている行。**それ以外は入り口の説明なので捨てる** */
const TROUBLE = /error|Error|failed|Failed|Cannot|Unable|No such|Invalid data/;

/**
 * 放送の欠けにいちいち言われるぶん。**残さない。**
 *
 * 電波の欠けは日常的にあり、デコーダはそのたびに「直した」「捨てた」を喋る
 * (選べる字幕を入口の見出しから読み取るためにログは info まで開けてある)。
 * 弱い局では毎秒何行も出て、**本当の失敗がその中に埋もれる**。
 *
 * 消すのは「1パケットぶんの取りこぼし」だけ。組み立てやエンコーダの失敗
 * (`Error opening output`, `Error binding filtergraph`) は残る
 */
const NOISE = /concealing|Error submitting packet to decoder|Decode error rate|Last message repeated/;

/** その行を記録に残すか */
export function worthLogging(line: string): boolean {
    return TROUBLE.test(line) && !NOISE.test(line);
}

/**
 * 字幕を**デコードせずに写す**出口。映像とは別の出口 (`pipe:3`) に出す。
 *
 * - `-c:s copy` … 字幕の PES の中身をそのまま (`S_ARIBSUB`)。デコードするのは denpa (`CaptionText`)
 * - `matroska` … **時刻をコマと一緒に運ぶコンテナ**。塊の上限を最小にして、
 *   1枚ごとに書き出させる (溜められるとそのぶん遅れる)
 *
 * @param from ffmpeg に渡す局の指定 (`0:p:<局>` か `0`)
 * @param track その局の中で何本目の字幕を出すか。**言語が複数ある放送**では
 *   2本以上乗っている (`TrackList`)
 */
export function captionOutput(from: string, track: number): string[] {
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
 * **放送そのままで送る経路の字幕** (docs/stream.md#放送そのままmpeg-2を送る)。映像はエンコードしないので、ffmpeg には字幕だけを
 * 写させる。
 *
 * エンコードの経路で「同じ ffmpeg に両方エンコードさせる」のは、ffmpeg が入口で時刻を 0 に寄せ、その
 * 寄せ幅がプロセスごとに違うからだった (上の説明)。放送そのままの経路では**寄せない** (`-copyts`) —
 * 受け側が合わせる相手は放送の PTS そのもの (ブラウザが自分で PES から読む) なので、
 * 字幕も放送の PTS のまま出せば突き合わせられる。mp4 のマルチプレクサが時刻を 0 に詰め直す
 * 問題は、字幕の出口 (Matroska) には無い。実機の録画で、出てきた字幕の時刻が元の TS の
 * 字幕 PES の PTS と 1ms 単位で一致した (71759.734333 → 71759.734)。
 *
 * **`-copyts` を外すと合わない。** 映像を出さない ffmpeg は寄せ幅を入口の `start:` とは
 * 違う値にし (同じ録画で 0.3〜0.7秒ずれた)、それを外から知る方法が無い。
 *
 * 映像をデコードしない (字幕の ES だけを読む) ので、エンコードする ffmpeg と違って CPU はほとんど使わない
 * (字幕もデコードせずに写すだけ)
 *
 * @param program ffmpeg に名指しさせる局の番号 (0以下なら最初の局)
 * @param track その局の中で何本目の字幕か
 */
export function rawCaptionArgs(program: number, track: number): string[] {
    const from = programSpec(program);
    return [
        '-hide_banner',
        '-nostats',
        '-fflags',
        'nobuffer',
        '-probesize',
        '100000',
        '-copyts',
        '-i',
        'pipe:0',
        ...captionOutput(from, track),
    ];
}

/**
 * 字幕がその放送に無いときに ffmpeg が言うこと。
 *
 * 字幕を持たない局はある (ショッピングやサブチャンネル)。そこに
 * `0:p:X:s:0` を要求すると、ffmpeg は**組み立ての時点で降りる** — つまり
 * **映像も出ない**。そうと分かったら字幕なしで再エンコードする (`Session.run`)。
 *
 * ffmpeg は `Stream map '' matches no streams.` と言う
 */
export const NO_SUBTITLE = /matches no streams/;

/** ffmpeg が入口の見出しに書く行 */
const PROGRAM = /^\s*Program (\d+)/;
const STREAM = /^\s*Stream #0:(\d+)\[0x[0-9a-f]+\](?:\((\w+)\))?: (\w+):/;

/**
 * ffmpeg の入口の見出しから、その局の字幕ストリームを読み取る。
 *
 * **字幕が1枚も来ていなくても、あることは分かる** (字幕の間隔が空く番組でも切り替えを出せる)。
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

/** 文字の配置の1枚と、出す時刻 (ミリ秒。コンテナのコマの時刻そのまま) と、第何言語か */
export interface CaptionShown {
    at: number;
    page: CaptionPage;
    /** 第何言語か (1〜8)。たいていは 1 */
    language: number;
}

/**
 * 写してきた字幕 (`S_ARIBSUB` のコマ) をデコードして、文字の配置にする。**字幕のストリーム1本に1つ** —
 * 書式や位置は字幕文を跨いで続くので、ffmpeg を起こし直したら作り直す。
 *
 * **載っている言語は全部読む。** 字幕のストリーム1本に最大8言語が入っていて (データグループの番号)、
 * 言語ごとに書式も位置も別に続くので、言語ごとにデコーダを1つずつ持つ。第2言語から後ろは
 * 字幕管理データに出てきてから作り、最後の字幕管理データを先に食わせる (書式と外字を揃える)。
 * どの言語を誰に出すかは使う側 (ライブは視聴者ごとに `Viewer.language`) が決める
 */
export class CaptionText {
    private readonly decoders = new Map<number, B24CaptionDecoder>([[1, new B24CaptionDecoder(1)]]);
    /** 最後に来た字幕管理データ。あとから作るデコーダに先に食わせる */
    private management: Uint8Array | null = null;
    /** 読めなかったと言ったか。**1回だけ言う** (壊れた放送は続けて壊れていることが多い) */
    private told = false;
    /** 載っている言語。変わったら `languagesChanged` が立つ */
    languages: CaptionLanguage[] = [];
    /** 前の `feed` で言語の顔ぶれが変わったか */
    languagesChanged = false;

    /**
     * 出すもの (言語ごとに0か1枚)。字幕管理データ・送り直し・待ちだけのコマは何も出さない。
     * **読めないコマは捨てて続ける** — 投げると、受けている側 (ライブの字幕 API) ごと止まる
     */
    feed(frame: MkvFrame): CaptionShown[] {
        const out: CaptionShown[] = [];
        this.languagesChanged = false;
        if (isManagement(frame.data)) this.management = frame.data;
        for (const [language, decoder] of this.decoders) {
            const page = this.decode(decoder, frame.data);
            if (page !== null) out.push({ at: frame.at, page, language });
        }
        // 言語の顔ぶれは字幕管理データでしか変わらない
        const listed = this.decoders.get(1)?.languages ?? [];
        if (
            isManagement(frame.data) &&
            listed.map((l) => `${l.index}:${l.code}`).join() !==
                this.languages.map((l) => `${l.index}:${l.code}`).join()
        ) {
            this.languages = listed;
            this.languagesChanged = true;
            for (const { index } of listed) {
                if (this.decoders.has(index)) continue;
                const decoder = new B24CaptionDecoder(index);
                if (this.management !== null) this.decode(decoder, this.management);
                this.decoders.set(index, decoder);
            }
        }
        return out;
    }

    private decode(decoder: B24CaptionDecoder, data: Uint8Array): CaptionPage | null {
        try {
            return decoder.decode(data);
        } catch (error) {
            if (!this.told) console.warn(`[captions] 字幕を1コマ読めませんでした: ${String(error)}`);
            this.told = true;
            return null;
        }
    }
}

/**
 * 送る形式にする。**中身は JSON** (`CaptionPage`)、頭の時刻は映像と同じ物差し (90kHz。stream.md#websocket-プロトコル)。
 * 前の1枚を丸ごと置き換えるので、消すのも同じ種別 (`runs` が空) で送る
 */
export function textFrame(shown: Pick<CaptionShown, 'at' | 'page'>): {
    kind: number;
    pts: bigint;
    data: Uint8Array;
} {
    return {
        kind: CHANNEL.captionText,
        pts: BigInt(Math.max(0, Math.round((shown.at * CLOCK) / 1000))),
        data: new TextEncoder().encode(JSON.stringify(shown.page)),
    };
}

/**
 * **アプリ向けの字幕 API** (`GET /api/services/<id>/captions`・`GET /api/recordings/<id>/captions`。
 * docs/api.md) の1フレーム。WebSocket の1フレーム (stream.md#websocket-プロトコル) の頭に、後ろの長さを足しただけ:
 *
 *     [4:後ろの長さ (BE)][1:種別][8:時刻 (90kHz, BE)][中身...]
 *
 * **WebSocket と同じバイトにしたのは、受け側の読み方を1つにするため。** 字幕 (`0x22`) も
 * 通知 (`0x40`) も JSON のまま。
 *
 * **長さを付けるのは、HTTP には区切りが無いから。** WebSocket はフレームの区切りを運んでくれるが、
 * チャンク転送のチャンクの区切りは受け側 (HttpURLConnection など) から見えない。
 * Server-Sent Events より、行に割って読む手間が要らないぶん軽い
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

/** 読まれないまま溜まってよい量 (バイト)。超えたら閉じる (受け側はリクエストし直す) */
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

/** アプリ向けの字幕 API に流し込む側 (`captionFeed`) */
export interface CaptionOut {
    /** WebSocket と同じ形式で1フレーム渡す。**字幕 (文字の配置) と、選べる字幕の通知だけ通す** */
    send(kind: number, pts: bigint, payload: Uint8Array): void;
    /** 終わり (録画を読み切った・セッションが畳まれた) */
    close(): void;
    /** 読まれずに溜まっているか (`CAPTION_FEED_HOLD`)。作る側が待てるなら待つ */
    backedUp(): boolean;
}

/**
 * アプリ向けの字幕 API を作る。中身を作る側 (`open`) は、閉じるときの後始末を返す。
 *
 * 通すのは字幕 (文字の配置 `0x22`) と、選べる字幕の通知 (`0x40` の `captions`) だけ。
 * `error` / `ended` の通知が来たら閉じる。ほかの通知・データ放送・映像は捨てる
 * (映像は同じ URL の隣のエンドポイント — ライブの `live` や追っかけの `chase` — で受け取っている)
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
                // 読まない相手に積み続けない。閉じれば受け側はリクエストし直す
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
                        } else if (kind !== CHANNEL.captionText) {
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

/**
 * エンコードしたもの (mkv) から抜いた字幕のトラックをデコードする。**入っているのが ARIB の字幕 (`S_ARIBSUB`) の
 * ときだけ** — 前にエンコードした録画は画像 (PGS) が入っていることがあり、それはもう読まない
 * (字幕なしとして扱う。元のTSが残っていれば再エンコードすると ARIB の字幕が入る)
 *
 * @param data ffmpeg に `-map 0:s:0 -c:s copy -f matroska` で抜かせたもの
 * @returns ARIB の字幕でなければ null
 */
export function pagesFromMkv(data: Uint8Array): CaptionPages | null {
    const splitter = new MkvSplitter();
    const frames = splitter.feed(data);
    if (splitter.codecs[0] !== 'S_ARIBSUB') return null;
    const text = new CaptionText();
    const byLanguage = new Map<number, CaptionPages['pages']>([[1, []]]);
    // 録画の途中で言語の顔ぶれが変わることがある (番組の境目)。出てきた言語は全部残す
    const seen = new Map<number, CaptionLanguage>();
    for (const frame of frames) {
        const shownAll = text.feed(frame);
        for (const l of text.languages) if (!seen.has(l.index)) seen.set(l.index, l);
        for (const shown of shownAll) {
            const list = byLanguage.get(shown.language) ?? [];
            byLanguage.set(shown.language, list);
            list.push({ at: shown.at / 1000, page: shown.page });
        }
    }
    // 第1言語は今までどおり `pages`。第2言語から後ろは載っているときだけ `others` に (版は上げない)
    const first = seen.get(1);
    const others: CaptionLanguagePages[] = [...seen.values()]
        .sort((a, b) => a.index - b.index)
        .filter((l) => l.index !== 1)
        .map((l) => ({ ...l, pages: byLanguage.get(l.index) ?? [] }));
    return {
        v: CAPTION_TEXT_VERSION,
        pages: byLanguage.get(1) ?? [],
        ...(first === undefined ? {} : { language: first }),
        ...(others.length === 0 ? {} : { others }),
    };
}
