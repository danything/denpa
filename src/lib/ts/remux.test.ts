import { describe, expect, test } from 'bun:test';
import { aheadOf, covers, type MediaAbility, type MediaFile, pickPlayback, remuxType } from './remux';

const h264: MediaFile = {
    source: 'encoded',
    video: 'avc1.640028',
    audio: 'opus',
    audios: ['主音声', '副音声'],
    duration: 1800,
};
const av1: MediaFile = { ...h264, video: 'av01.0.08M.08' };

/** 答えを表で持つブラウザ。載っていない形は読めない */
function browser(play: string[], mse: string[]): MediaAbility {
    return { play: (type) => play.includes(type), mse: (type) => mse.includes(type) };
}

/** iPhone の Safari (iOS 17.1+)。Matroska は WebM としてしか読まず、WebM の H.264 は断る */
const iphone = browser(
    ['video/webm; codecs="av01.0.08M.08,opus"'],
    ['video/mp4; codecs="avc1.640028,mp4a.40.2"', 'video/mp4; codecs="av01.0.08M.08,mp4a.40.2"'],
);

describe('どれを、どう観るか (pickPlayback)', () => {
    test('Matroska のまま読めるブラウザ (Chrome) はそのまま', () => {
        const chrome = browser(['video/x-matroska; codecs="avc1.640028,opus"'], []);
        expect(pickPlayback([h264], chrome)).toEqual({ way: 'direct', source: 'encoded' });
    });

    test('iPhone の H.264 は詰め替える。尺と音声の名前も渡す', () => {
        expect(pickPlayback([h264], iphone)).toEqual({
            way: 'remux',
            source: 'encoded',
            codecs: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
            audios: ['主音声', '副音声'],
            duration: 1800,
        });
    });

    test('iPhone でも AV1 は WebM として読めるのでそのまま', () => {
        expect(pickPlayback([av1], iphone)).toEqual({ way: 'direct', source: 'encoded' });
    });

    test('両方焼いた録画で AV1 を解けない端末は、H.264 (alt) を詰め替える', () => {
        const old = browser([], ['video/mp4; codecs="avc1.640028,mp4a.40.2"']);
        expect(pickPlayback([av1, { ...h264, source: 'alt' }], old)).toMatchObject({
            way: 'remux',
            source: 'alt',
        });
    });

    test('MSE の器が無い端末 (iOS 16 以前) はそのまま渡す (読めなければ落とす口が出る)', () => {
        expect(pickPlayback([h264], browser([], []))).toEqual({ way: 'direct', source: 'encoded' });
    });

    test('中身を聞けなかった・尺が分からないものは詰め替えない', () => {
        expect(pickPlayback([], iphone)).toEqual({ way: 'direct', source: 'encoded' });
        expect(pickPlayback([{ ...h264, video: null }], iphone)).toEqual({
            way: 'direct',
            source: 'encoded',
        });
        expect(pickPlayback([{ ...h264, duration: null }], iphone)).toEqual({
            way: 'direct',
            source: 'encoded',
        });
    });

    test('音声の無い入れ物は映像だけの codecs', () => {
        expect(remuxType({ video: 'avc1.640028', audios: [] })).toBe('video/mp4; codecs="avc1.640028"');
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

    test('読んでいる流れの少し先までは待つ。外れたら頼み直す', () => {
        // 100秒から頼んで 160秒まで来ている。10秒送りの 170秒は待てば届く
        expect(covers(ranges, 170, 100, 15)).toBe(true);
        expect(covers(ranges, 200, 100, 15)).toBe(false);
        // 戻った先は届かない
        expect(covers(ranges, 50, 100, 15)).toBe(false);
        // 読み終えたあと (読んでいない) は溜まっているぶんだけ
        expect(covers(ranges, 170, null, 15)).toBe(false);
    });

    test('頼んだ直後でまだ何も無くても、頼んだ位置なら待つ', () => {
        expect(covers([], 300, 300, 15)).toBe(true);
        expect(covers([], 400, 300, 15)).toBe(false);
    });
});
