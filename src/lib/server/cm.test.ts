import { describe, expect, test } from 'bun:test';
import { logoUnusable } from '../format';
import {
    chapterMetadata,
    cmRatio,
    fields,
    firstFrameTime,
    invertRanges,
    leadIn,
    liveAudioIndexes,
    longestRange,
    parseFrameRate,
    parseRatio,
    shiftRanges,
    tooMuchCm,
    widenKeep,
} from './cm';

describe('区間の裏返し', () => {
    test('CMを渡すと残す区間になる', () => {
        expect(invertRanges([{ start: 300, end: 360 }], 1800)).toEqual([
            { start: 0, end: 300 },
            { start: 360, end: 1800 },
        ]);
    });

    test('先頭がCMなら本編は1区間だけ', () => {
        expect(invertRanges([{ start: 0, end: 60 }], 600)).toEqual([{ start: 60, end: 600 }]);
    });

    test('並んでいなくても同じ答えになる', () => {
        expect(
            invertRanges(
                [
                    { start: 160, end: 600 },
                    { start: 0, end: 100 },
                ],
                600,
            ),
        ).toEqual([{ start: 100, end: 160 }]);
    });
});

/**
 * エンコードは頭 (音声だけの区間) を捨てて 0 秒から始めるので、チャプターの
 * 時刻も同じだけ詰める。そのままだと自動スキップが毎回そのぶんCMを見せていた
 */
describe('チャプターの時刻を頭出しに合わせる', () => {
    test('捨てたぶんだけ前へ詰める', () => {
        expect(shiftRanges([{ start: 300, end: 360 }], 0.9)).toEqual([{ start: 299.1, end: 359.1 }]);
    });

    test('0 より前には行かない (頭がCMの録画)', () => {
        expect(shiftRanges([{ start: 0.2, end: 60 }], 0.9)).toEqual([{ start: 0, end: 59.1 }]);
    });

    test('詰めた結果ほとんど残らない区間は落とす', () => {
        expect(shiftRanges([{ start: 0, end: 1 }], 0.9)).toEqual([]);
    });

    test('捨てるものが無ければそのまま', () => {
        const cm = [{ start: 10, end: 20 }];
        expect(shiftRanges(cm, 0)).toBe(cm);
    });
});

/**
 * コマ数の実測は一番長い本編区間で行う。最初の区間はアバン+OPに当たりやすく、
 * OPの動きで60コマに誤判定していた (本番の実測)
 */
describe('一番長い区間を選ぶ', () => {
    test('アバン+OPの短い先頭区間ではなく本編を選ぶ', () => {
        expect(
            longestRange([
                { start: 7, end: 198 }, // アバン+OP (191秒)
                { start: 388, end: 1088 }, // 本編A (700秒)
                { start: 1178, end: 1420 }, // 本編B (242秒)
            ]),
        ).toEqual({ start: 388, end: 1088 });
    });

    test('区間が無ければ null', () => {
        expect(longestRange([])).toBeNull();
    });
});

/**
 * 切り出しはキーフレーム単位なので、判定どおりの位置から始めると本編の頭が
 * 1 GOP ぶん削れる。実機で「本編の頭が一瞬欠ける」形で出ていた
 */
describe('残す区間の頭を戻す', () => {
    test('頭だけ戻す。尻はそのまま', () => {
        expect(widenKeep([{ start: 100, end: 200 }], 0.8)).toEqual([{ start: 99.2, end: 200 }]);
    });

    test('0 より前には戻さない', () => {
        expect(widenKeep([{ start: 0.3, end: 60 }], 0.8)).toEqual([{ start: 0, end: 60 }]);
    });

    test('前の区間に食い込まない', () => {
        // 戻した先が前の区間の中なら、そこで止める (同じところを2回書き出さない)
        const keep = [
            { start: 0, end: 100 },
            { start: 100.5, end: 200 },
        ];

        expect(widenKeep(keep, 0.8)).toEqual([{ start: 0, end: 200 }]);
    });

    test('離れている区間は1つにまとめない', () => {
        const keep = [
            { start: 0, end: 100 },
            { start: 130, end: 200 },
        ];

        expect(widenKeep(keep, 0.8)).toEqual([
            { start: 0, end: 100 },
            { start: 129.2, end: 200 },
        ]);
    });
});

/*
 * **頭出しは「実際に復号できた1コマ目」で測る。**
 *
 * stream の `start_time` は最初のパケットの時刻で、そこから何コマかは
 * 参照先が録れておらず捨てられる。実機ではその差が 0.567 秒 (17コマ = 半GOP) で、
 * そのぶんだけ字幕が早く出ていた。
 */
describe('最初に復号できたコマ', () => {
    const output = [
        'best_effort_timestamp_time=6116.439489',
        'best_effort_timestamp_time=6116.472856',
        'best_effort_timestamp_time=6116.506222',
    ].join('\n');

    test('先頭の1件を読む', () => {
        expect(firstFrameTime(output)).toBeCloseTo(6116.439489, 6);
    });

    test('1件も無ければ NaN (呼ぶ側がパケットの時刻で代用する)', () => {
        expect(firstFrameTime('')).toBeNaN();
        expect(firstFrameTime('best_effort_timestamp_time=N/A')).toBeNaN();
    });

    test('他の行が混ざっていても拾える', () => {
        // ffprobe は復号できないコマについて警告を吐くことがある
        expect(firstFrameTime(`[mpeg2video] Invalid frame dimensions 0x0.\n${output}`)).toBeCloseTo(
            6116.439489,
            6,
        );
    });
});

/**
 * TS の時刻は**放送の時刻そのもの** (PTS) で、頭からの秒数ではない。実機では
 * 62170 のような値が入る。引き算を忘れるとその値がそのまま頭捨ての長さになり、
 * 17時間ぶん読み飛ばして中身の無いものが焼き上がる
 */
describe('頭から捨てる長さの上限', () => {
    test('入れ物の始まりから数える', () => {
        expect(leadIn(62170.583, 62169.916)).toBeCloseTo(0.667, 3);
    });

    test('数秒を超えるずれは信じない', () => {
        // 引き算を忘れたときの値。そのまま渡すと出来上がりが壊れる
        expect(leadIn(62170.583, 0)).toBe(0);
        expect(leadIn(62170.583, Number.NaN)).toBe(0);
    });

    test('映像のほうが先なら 0', () => {
        expect(leadIn(10, 10.5)).toBe(0);
        expect(leadIn(Number.NaN, 0)).toBe(0);
    });
});

describe('画素の横長さ', () => {
    test('比を数にする', () => {
        expect(parseRatio('4:3')).toBeCloseTo(4 / 3, 6);
        expect(parseRatio('1:1')).toBe(1);
    });

    test('読めなければ 1 (正方形)', () => {
        // ffmpeg は分からないとき 0:1 や N/A を返す。0 を掛けると幅が消える
        expect(parseRatio('0:1')).toBe(1);
        expect(parseRatio('N/A')).toBe(1);
        expect(parseRatio(undefined)).toBe(1);
    });
});

describe('chapterMetadata', () => {
    test('本編とCMが時刻順のチャプターになる', () => {
        const meta = chapterMetadata([{ start: 300, end: 360 }], 600);
        expect(meta.startsWith(';FFMETADATA1')).toBe(true);
        expect(meta).toContain('START=0');
        expect(meta).toContain('END=300000');
        expect(meta).toContain('title=CM');
        expect(meta).toContain('title=本編');
        // 本編 → CM → 本編 の3チャプター
        expect(meta.match(/\[CHAPTER\]/g)).toHaveLength(3);
    });
});

describe('ffprobe の読み取り', () => {
    /**
     * 実機の TOKYO MX の生TS。MX1 と MX2 が同じTSに乗っているので
     * `-select_streams v:0` を付けても番組の数だけ並ぶ。
     * 並び順も**頼んだ順ではない** (avg_frame_rate,width,height と頼んで幅から来る)
     */
    const MX = [
        'width=1440',
        'height=1080',
        'avg_frame_rate=30000/1001',
        '',
        'width=1440',
        'height=1080',
        'avg_frame_rate=30000/1001',
    ].join('\n');

    test('位置ではなく鍵で読む。頼んだ順では返ってこない', () => {
        /*
         * ここを位置で受けていた頃は 1440 をフレームレートとして採り、
         * 30分アニメの本編4万2千コマが29秒に潰れて「番組の98%がCM」になっていた。
         * その前は丸ごと split('/') していて 30000 を採り、1.4秒 =「100%がCM」。
         * どちらも jls の結果が毎回捨てられて無音検出に落ちていた (録画34・35・38)
         */
        const stream = fields(MX);
        expect(parseFrameRate(stream.get('avg_frame_rate'))).toBeCloseTo(29.97, 2);
        expect(Number(stream.get('width'))).toBe(1440);
        expect(Number(stream.get('height'))).toBe(1080);
    });

    test('同じ鍵が並んだら最初のものを採る', () => {
        expect(fields('duration=10\nduration=999').get('duration')).toBe('10');
    });

    test('読めなければ NaN。呼ぶ側が既定に落とす', () => {
        expect(parseFrameRate('N/A')).toBeNaN();
        expect(parseFrameRate('0/0')).toBeNaN();
        expect(parseFrameRate('')).toBeNaN();
        expect(parseFrameRate(undefined)).toBeNaN();
    });

    test('分母のない書き方も読む', () => {
        expect(parseFrameRate('25')).toBe(25);
    });
});

describe('CM判定が多すぎないか', () => {
    test('番組の半分以上がCMになったら信じない', () => {
        /*
         * 実機で起きたやつ。ロゴを覚えたての回で「頭の2秒だけ本編」になり、
         * 30分アニメが丸ごとCM扱いになっていた (join_logo_scp の頃)
         */
        const whole = invertRanges([{ start: 0, end: 2 }], 1802);
        expect(cmRatio(whole, 1802)).toBe(100);
        expect(tooMuchCm(whole, 1802)).toBe(true);

        // まともな結果 (CM 3 か所で 10%) は通す
        const normal = [
            { start: 0, end: 10 },
            { start: 600, end: 660 },
            { start: 1700, end: 1802 },
        ];
        expect(tooMuchCm(normal, 1802)).toBe(false);
        expect(cmRatio(normal, 1802)).toBe(10);
    });
});

describe('ロゴで判定できなかったと扱うか', () => {
    test('CM検出の覚え書きから決める。別の印は持たない', () => {
        /*
         * 実機に残っていた文言。印を別に持っていた頃は、後から条件を広げても
         * 既に録ってある分には効かなかった
         */
        expect(
            logoUnusable('無音 8 箇所 (ロゴは使えず: ロゴ判定が失敗: ロゴの在り処が割り出せませんでした)'),
        ).toBe(true);
        expect(
            logoUnusable('無音 30 箇所 (ロゴは使えず: 番組の 100% がCMという結果だったので捨てました)'),
        ).toBe(true);
        // ロゴで判定できている。ここで出すと、直しようのないものまで拾う
        expect(logoUnusable('ロゴ')).toBe(false);
        expect(logoUnusable('無音 8 箇所')).toBe(false);
        expect(logoUnusable(null)).toBe(false);
    });
});

/**
 * 録画の尻に次の番組の副音声が入ると、探りの間に中身の来ない音声が1本増える。
 * 実機の ffprobe の出力 (programs と streams の両方に同じものが並ぶ) をそのまま使う
 */
describe('中身のある音声だけを拾う', () => {
    test('channels が 0 の音声は外す', () => {
        const json =
            '{"programs":[{"streams":[{"channels":2},{"channels":0}]},{"streams":[]}],"streams":[{"channels":2},{"channels":0}]}';
        expect(liveAudioIndexes(json)).toEqual([0]);
    });

    test('多重音声はどちらも拾う', () => {
        expect(liveAudioIndexes('{"streams":[{"channels":2},{"channels":2}]}')).toEqual([0, 1]);
    });

    test('音声が無い・channels が出てこないときは空', () => {
        expect(liveAudioIndexes('{"streams":[]}')).toEqual([]);
        expect(liveAudioIndexes('{}')).toEqual([]);
        expect(liveAudioIndexes('{"streams":[{}]}')).toEqual([]);
    });
});
