import { describe, expect, test } from 'bun:test';
import {
    aheadOf,
    canvasChoices,
    canvasTranscodes,
    codecChoices,
    covers,
    type MediaAbility,
    type PlaybackInfo,
    pickCanvas,
    pickOffer,
    streamForAudio,
    transcodes,
} from './playback';

/** 答えを表で持つブラウザ。載っていない形式は読めない */
function browser(play: string[], mse: string[]): MediaAbility {
    return { play: (type) => play.includes(type), mse: (type) => mse.includes(type) };
}

const H264_MP4 = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
const H264_LIVE = 'video/mp4; codecs="avc1.640029,mp4a.40.2"';
const AV1_MP4 = 'video/mp4; codecs="av01.0.08M.08,opus"';

/** H.264 だけエンコードした録画 (サーバの `playbackPlan` が返す形式) */
const h264Only: PlaybackInfo = {
    duration: 1800,
    axis: 'encoded',
    audios: [{ id: '0', label: '主音声' }],
    offers: [
        { codec: 'h264', way: 'file', source: 'encoded', codecs: 'avc1.640028,opus' },
        { codec: 'h264', way: 'stream', codecs: 'avc1.640028,mp4a.40.2' },
        { codec: 'av1', way: 'stream', codecs: 'av01.0.08M.08,opus' },
    ],
};

/** AV1 だけエンコードした録画 */
const av1Only: PlaybackInfo = {
    ...h264Only,
    offers: [
        { codec: 'av1', way: 'file', source: 'encoded', codecs: 'av01.0.08M.08,opus' },
        { codec: 'h264', way: 'stream', codecs: 'avc1.640029,mp4a.40.2' },
        { codec: 'av1', way: 'stream', codecs: 'av01.0.08M.08,opus' },
    ],
};

/** 元の TS だけ */
const tsOnly: PlaybackInfo = {
    duration: 1800,
    axis: 'ts',
    audios: [{ id: '0:both', label: '音声' }],
    offers: [
        { codec: 'h264', way: 'stream', codecs: 'avc1.640029,mp4a.40.2' },
        { codec: 'av1', way: 'stream', codecs: 'av01.0.08M.08,opus' },
        { codec: 'mpeg2', way: 'raw' },
    ],
};

const chrome = browser(
    ['video/x-matroska; codecs="avc1.640028,opus"', 'video/x-matroska; codecs="av01.0.08M.08,opus"'],
    [H264_MP4, H264_LIVE, AV1_MP4],
);
/** iPhone の Safari (iOS 17.1+)。Matroska は WebM としてしか読まず、WebM の H.264 は断る */
const iphone = browser(['video/webm; codecs="av01.0.08M.08,opus"'], [H264_MP4, H264_LIVE]);

describe('どれで観るか (pickOffer)', () => {
    test('そのまま読めるファイルがあれば、それ', () => {
        expect(pickOffer(h264Only, chrome)).toEqual({ way: 'file', codec: 'h264', source: 'encoded' });
    });

    test('iPhone の H.264 は詰め替え (サーバは軽い) を変換より先に', () => {
        expect(pickOffer(h264Only, iphone)).toEqual({ way: 'stream', codec: 'h264', type: H264_MP4 });
    });

    test('元の TS だけの録画は変換。H.264 を先に', () => {
        expect(pickOffer(tsOnly, chrome)).toEqual({ way: 'stream', codec: 'h264', type: H264_LIVE });
        // H.264 を持たない Chromium は AV1
        expect(pickOffer(tsOnly, browser([], [AV1_MP4]))).toEqual({
            way: 'stream',
            codec: 'av1',
            type: AV1_MP4,
        });
    });

    test('選んだコーデックがあれば、それを観られる方法で。AV1 の録画で H.264 を選ぶと変換', () => {
        expect(pickOffer(av1Only, chrome, 'h264')).toEqual({ way: 'stream', codec: 'h264', type: H264_LIVE });
        expect(transcodes(av1Only, { way: 'stream', codec: 'h264', type: H264_LIVE })).toBe(true);
        expect(transcodes(h264Only, { way: 'stream', codec: 'h264', type: H264_MP4 })).toBe(false);
        // 選んだものを観られなければ自動と同じ
        expect(pickOffer(av1Only, iphone, 'av1')).toEqual({ way: 'file', codec: 'av1', source: 'encoded' });
        expect(
            pickOffer(h264Only, browser(['video/x-matroska; codecs="avc1.640028,opus"'], []), 'av1'),
        ).toEqual({
            way: 'file',
            codec: 'h264',
            source: 'encoded',
        });
    });

    test('中身が分からないファイルは、ほかが無ければそのまま渡す。何も無ければ null', () => {
        const unknown: PlaybackInfo = {
            ...h264Only,
            offers: [{ codec: 'av1', way: 'file', source: 'encoded' }],
        };
        expect(pickOffer(unknown, chrome)).toEqual({ way: 'file', codec: 'av1', source: 'encoded' });
        expect(pickOffer(tsOnly, browser([], []))).toBeNull();
    });
});

describe('音声を選ぶために流すほうへ移る (streamForAudio)', () => {
    test('同じコーデックの詰め替えを先に', () => {
        expect(streamForAudio(av1Only, chrome, 'av1')).toEqual({
            way: 'stream',
            codec: 'av1',
            type: AV1_MP4,
        });
        expect(streamForAudio(h264Only, chrome, 'h264')).toEqual({
            way: 'stream',
            codec: 'h264',
            type: H264_MP4,
        });
    });

    test('同じコーデックを MSE が受け取れなければ、受け取れる変換', () => {
        expect(streamForAudio(av1Only, browser([], [H264_LIVE]), 'av1')).toEqual({
            way: 'stream',
            codec: 'h264',
            type: H264_LIVE,
        });
    });

    test('MSE が何も受け取れなければ null', () => {
        expect(streamForAudio(av1Only, browser([], []), 'av1')).toBeNull();
    });
});

describe('コーデックのメニュー (codecChoices)', () => {
    test('この端末で観られる方法があるものだけ', () => {
        expect(codecChoices(av1Only, chrome)).toEqual(['h264', 'av1']);
        expect(codecChoices(av1Only, iphone)).toEqual(['h264', 'av1']);
        expect(codecChoices(tsOnly, browser([], [AV1_MP4]))).toEqual(['av1']);
    });
});

describe('溜まり方 (aheadOf / covers)', () => {
    const ranges = [[100, 160]] as const;

    test('区間の中なら先に溜まっている長さ、外なら 0', () => {
        expect(aheadOf(ranges, 120)).toBe(40);
        expect(aheadOf(ranges, 170)).toBe(0);
        expect(aheadOf(ranges, 50)).toBe(0);
    });

    test('区間の頭のわずかな手前 (音声と映像の頭のずれ) は中と見る', () => {
        expect(aheadOf(ranges, 99.8)).toBeCloseTo(60.2);
    });

    test('読んでいるストリームの少し先までは待つ。外れたらリクエストし直す', () => {
        // 100秒からリクエストして 160秒まで来ている。10秒送りの 170秒は待てば届く
        expect(covers(ranges, 170, 100, 15)).toBe(true);
        expect(covers(ranges, 200, 100, 15)).toBe(false);
        // 戻った先は届かない
        expect(covers(ranges, 50, 100, 15)).toBe(false);
        // 読み終えたあと (読んでいない) は溜まっているぶんだけ
        expect(covers(ranges, 170, null, 15)).toBe(false);
    });

    test('リクエストした直後でまだ何も無くても、リクエストした位置なら待つ', () => {
        expect(covers([], 300, 300, 15)).toBe(true);
        expect(covers([], 400, 300, 15)).toBe(false);
    });
});

describe('互換モード (canvasChoices / pickCanvas)', () => {
    /** 元の TS も残っている AV1 の録画 */
    const withTs: PlaybackInfo = { ...av1Only, offers: [...av1Only.offers, { codec: 'mpeg2', way: 'raw' }] };
    const all = { h264: true, av1: true, mpeg2: true };

    test('流せるものを並べ、描けないものは押せなくする。ファイルそのままは使わない', () => {
        expect(canvasChoices(withTs, { ...all, h264: false })).toEqual([
            { codec: 'h264', drawable: false },
            { codec: 'av1', drawable: true },
            { codec: 'mpeg2', drawable: true },
        ]);
        expect(canvasChoices(av1Only, all).map((item) => item.codec)).toEqual(['h264', 'av1']);
    });

    test('自動は、エンコード済みと同じ形式 (詰め替え) → 変換 (H.264 → AV1) → MPEG-2', () => {
        expect(pickCanvas(withTs, all)).toBe('av1');
        expect(pickCanvas(h264Only, all)).toBe('h264');
        expect(pickCanvas(withTs, { ...all, av1: false })).toBe('h264');
        expect(pickCanvas(withTs, { h264: false, av1: false, mpeg2: true })).toBe('mpeg2');
        expect(pickCanvas(av1Only, { h264: false, av1: false, mpeg2: true })).toBeNull();
    });

    test('選んだものが描ければそれ。描けなければ自動と同じ。諦めた形式は避ける', () => {
        expect(pickCanvas(withTs, all, 'mpeg2')).toBe('mpeg2');
        expect(pickCanvas(withTs, all, 'h264')).toBe('h264');
        expect(pickCanvas(withTs, { ...all, h264: false }, 'h264')).toBe('av1');
        expect(pickCanvas(withTs, all, 'auto', ['av1'])).toBe('h264');
    });

    test('変換させるか (混んでいると断られる)', () => {
        expect(canvasTranscodes(withTs, 'av1')).toBe(false);
        expect(canvasTranscodes(withTs, 'h264')).toBe(true);
        expect(canvasTranscodes(withTs, 'mpeg2')).toBe(false);
    });
});
