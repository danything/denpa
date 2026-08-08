import { describe, expect, test } from 'bun:test';
import { CHANNEL } from '$lib/live';
import { CANVAS, captionInput, captionOutput, frame, NO_SUBTITLE, TrackList } from './captions';

/**
 * PNG 1枚ぶん。**かたまりの形まで真似る** — 切れ目を `IEND` で見つけるので、
 * 署名だけの偽物では確かめられない。
 *
 *     [8バイトの署名][4:長さ][4:種別][中身][4:CRC] … [0][IEND][CRC]
 */
const png = (fill: number, body = 8) => {
    const out = new Uint8Array(8 + 12 + body + 12);
    out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(out.buffer);
    // IDAT のつもりのかたまり1つ
    view.setUint32(8, body);
    out.set([0x49, 0x44, 0x41, 0x54], 12);
    out.fill(fill, 16, 16 + body);
    // IEND
    view.setUint32(8 + 12 + body, 0);
    out.set([0x49, 0x45, 0x4e, 0x44], 8 + 12 + body + 4);
    return out;
};

describe('字幕の取り出し方', () => {
    /*
     * **`-canvas_size` が要る。** 無いと libaribcaption は 1440x1080 (PROFILE_A)
     * とみなすので、1920x1080 の放送では字幕だけ横に伸びる
     */
    test('画面の大きさを渡す', () => {
        const args = captionInput();
        expect(args[args.indexOf('-canvas_size') + 1]).toBe(`${CANVAS.width}x${CANVAS.height}`);
        expect(args[args.indexOf('-sub_type') + 1]).toBe('bitmap');
    });

    /*
     * **PNG まで ffmpeg に組ませる。** 実機で同じ TS 30秒ぶんを通した実測:
     * 生の RGBA 1.94秒 (406MB) / PNG 1.05秒 (1.76MB) / 256色 PNG 4.30秒 (0.94MB)。
     * 生のほうが遅いのは書く量が桁違いだから
     */
    test('絵は PNG で受け取る', () => {
        const args = captionOutput('0:p:1024', 0);
        expect(args[args.indexOf('-c:v') + 1]).toBe('png');
        expect(args).not.toContain('rawvideo');
    });

    /*
     * **時刻を運べる器で受ける。**
     *
     * 生の PNG を並べただけ (`image2pipe`) では時刻が乗らない。別の口
     * (`showinfo`) に喋らせて来た順に組にしていた頃は**数が合わずにずれた** —
     * 実機の日テレで70秒測ると PNG 77枚に対し showinfo 79行。一度ずれると
     * 戻らず、字幕が遅れて出て消えるのも遅れる
     */
    test('時刻はコマと一緒に運ばせる', () => {
        const args = captionOutput('0:p:1024', 0);
        expect(args[args.indexOf('-f') + 1]).toBe('matroska');
        expect(args).not.toContain('image2pipe');
        expect(args).not.toContain('showinfo');
    });

    /** **映像とは別の口へ出す。** 同じ ffmpeg なので、口を分けるしかない */
    test('映像とは別の口へ出す', () => {
        expect(captionOutput('0:p:1024', 0)).toContain('pipe:3');
    });

    /** 溜められるとそのぶん遅れる。塊の上限を最小にして1枚ずつ書かせる */
    test('溜めさせない', () => {
        const args = captionOutput('0:p:1024', 0);
        expect(args[args.indexOf('-cluster_time_limit') + 1]).toBe('1');
        expect(args[args.indexOf('-flush_packets') + 1]).toBe('1');
    });

    /** 局を名指しする。1本の物理チャンネルに複数の局が乗っている (映像と同じ) */
    test('選んだ局の字幕を採る', () => {
        expect(captionOutput('0:p:1032', 0).join(' ')).toContain('[0:p:1032:s:0]null');
    });

    test('局が分からなければ最初に見つけた字幕', () => {
        expect(captionOutput('0', 0).join(' ')).toContain('[0:s:0]null');
    });

    /** **言語が複数ある放送**では2本目を選べる */
    test('何本目かを選べる', () => {
        expect(captionOutput('0:p:1024', 1).join(' ')).toContain('[0:p:1024:s:1]null');
    });

    /** 出てきた枚をそのまま出す。詰め直させると時刻がずれる */
    test('コマ数を揃え直させない', () => {
        const args = captionOutput('0:p:1024', 0);
        expect(args[args.indexOf('-fps_mode') + 1]).toBe('passthrough');
    });
});

/**
 * **字幕を持たない放送は普通にある** (ショッピングやサブチャンネル)。
 *
 * そこに字幕を頼むと ffmpeg は組み立ての時点で降りる — **映像も出ない**。
 * そうと分かったら字幕なしで焼き直すので、その言い分を見分けられること
 */
describe('字幕が無いと分かる', () => {
    /** 実機で出させたものそのまま */
    test('ffmpeg の言い分から見分ける', () => {
        expect(
            NO_SUBTITLE.test(
                "[fc#0 @ 0x1] Stream specifier ':s:0' in filtergraph description [0:s:0]null[s] matches no streams.",
            ),
        ).toBe(true);
        expect(NO_SUBTITLE.test('Error binding filtergraph inputs/outputs: Invalid argument')).toBe(true);
        expect(
            NO_SUBTITLE.test('[fc#0 @ 0x1] No program with ID 1024 exists, stream specifier can never match'),
        ).toBe(false);
    });

    test('よくある行では立たない', () => {
        expect(NO_SUBTITLE.test('[mpeg2video @ 0x1] Invalid frame dimensions 0x0.')).toBe(false);
        expect(NO_SUBTITLE.test('  Stream #0:2[0x130]: Subtitle: arib_caption')).toBe(false);
    });
});

/**
 * **放送が字幕を持っているかは、1枚も来ていなくても分かる。**
 *
 * ffmpeg が入口で読んだストリーム一覧に出ている。届いてから画面に切り替えを
 * 出していた頃は、間隔の空く番組を開くとボタンが出なかった (実機の
 * 「みんなの手話」。番組表には [字] と出ているのに)。
 */
describe('TrackList', () => {
    /** 実機の T26 (Eテレ) がそのまま出したもの */
    const etv = [
        '  Program 1032 ',
        '  Stream #0:0[0x100]: Video: mpeg2video (Main), 1440x1080, 29.97 fps',
        '  Stream #0:1[0x110]: Audio: aac (LC), 48000 Hz, stereo',
        '  Stream #0:2[0x130]: Subtitle: arib_caption (libaribcaption) (Profile A), 1920x1080',
        '  Stream #0:3[0x138]: Data: bin_data',
        '  Program 1033 ',
        '  Stream #0:4[0x101]: Video: mpeg2video (Main), 1440x1080, 29.97 fps',
        '  Stream #0:5[0x131]: Subtitle: arib_caption (libaribcaption) (Profile A), 1920x1080',
    ];

    test('選んだ局の字幕だけ数える', () => {
        const list = new TrackList(1032);
        for (const line of etv) list.feed(line);
        expect(list.tracks).toHaveLength(1);
        expect(list.tracks[0]).toMatchObject({ index: 0, label: '字幕' });
    });

    /** ほかの局の字幕を数えると、選べないものが一覧に並ぶ */
    test('別の局の字幕は数えない', () => {
        const list = new TrackList(1033);
        for (const line of etv) list.feed(line);
        expect(list.tracks).toHaveLength(1);
    });

    /** **言語が複数ある放送はたまにある。** そのときは2本以上になる */
    test('言語が複数あれば、その数だけ出す', () => {
        const list = new TrackList(1024);
        for (const line of [
            '  Program 1024 ',
            '  Stream #0:1[0x110](jpn): Audio: aac (LC), 48000 Hz, stereo',
            '  Stream #0:2[0x130](jpn): Subtitle: arib_caption (Profile A), 1920x1080',
            '  Stream #0:3[0x131](eng): Subtitle: arib_caption (Profile A), 1920x1080',
        ]) {
            list.feed(line);
        }
        expect(list.tracks.map((t) => t.label)).toEqual(['字幕 (日本語)', '字幕2 (英語)']);
        expect(list.tracks.map((t) => t.index)).toEqual([0, 1]);
    });

    test('字幕を持たない局では空', () => {
        const list = new TrackList(1416);
        for (const line of etv) list.feed(line);
        expect(list.tracks).toHaveLength(0);
    });

    /** 増えたときだけ true。毎行で知らせると画面が無駄に描き直される */
    test('増えたときだけ知らせる', () => {
        const list = new TrackList(1032);
        expect(list.feed('  Program 1032 ')).toBe(false);
        expect(list.feed('  Stream #0:0[0x100]: Video: mpeg2video (Main)')).toBe(false);
        expect(list.feed('  Stream #0:2[0x130]: Subtitle: arib_caption (Profile A)')).toBe(true);
    });
});

/**
 * 送る形。頭に置き場所を付ける (stream.md §5.3)。いまは画面まるごとを送るので
 * x,y は 0 だが、**あとで切り抜くようにしても受け側を変えずに済む**。
 */
describe('frame', () => {
    test('絵は種別 0x20 で、頭に置き場所が付く', () => {
        const data = png(0x11);
        const out = frame({ at: 0, data });
        expect(out.kind).toBe(CHANNEL.subtitle);
        const view = new DataView(out.data.buffer, out.data.byteOffset);
        expect([view.getUint16(0), view.getUint16(2), view.getUint16(4), view.getUint16(6)]).toEqual([
            0,
            0,
            CANVAS.width,
            CANVAS.height,
        ]);
        expect(out.data.subarray(8)).toEqual(data);
    });

    /*
     * **いつ出すかを添える。** 映像と同じ ffmpeg が付けた mp4 の物差しなので、
     * 受け側は再生位置と直に比べられる。
     *
     * 添えずに「届いた時点の再生位置」に置いていた頃は、焼く手間のぶん字幕の
     * ほうが先に届くぶんだけ早く出ていた。その量を測って足し引きしようとして
     * 3回外している (docs/stream.md §5.4) — 別々の ffmpeg では測れなかった
     */
    test('いつ出すかを 90kHz で添える', () => {
        expect(frame({ at: 0, data: png(0x11) }).pts).toBe(0n);
        // 1.5 秒 = 135000
        expect(frame({ at: 1500, data: png(0x11) }).pts).toBe(135_000n);
        expect(frame({ at: 1500.4, data: png(0x11) }).pts).toBe(135_036n);
    });
});
