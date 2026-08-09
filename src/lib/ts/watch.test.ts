import { describe, expect, test } from 'bun:test';
import {
    chapterAt,
    DOUBLE_TAP,
    nextChapterAt,
    parseChapters,
    prevChapterAt,
    resumePoint,
    SKIP,
    tap,
    zoneOf,
} from './watch';

describe('押された場所', () => {
    test('左右の端と真ん中を分ける', () => {
        expect(zoneOf(10, 1000)).toBe('left');
        expect(zoneOf(500, 1000)).toBe('center');
        expect(zoneOf(990, 1000)).toBe('right');
    });

    /**
     * **真ん中を広く取る。** 3分割にすると、絵の中央付近を押したつもりが
     * 送りになる。左右それぞれ3割にして中央に4割残す
     */
    test('真ん中は広めに残す', () => {
        expect(zoneOf(350, 1000)).toBe('center');
        expect(zoneOf(650, 1000)).toBe('center');
        expect(zoneOf(299, 1000)).toBe('left');
        expect(zoneOf(701, 1000)).toBe('right');
    });

    test('幅が分からないときは真ん中扱い', () => {
        expect(zoneOf(0, 0)).toBe('center');
    });
});

describe('押したときに何をするか', () => {
    /**
     * **1回目はその場で効かせる。** 2回目を待ってから決めると、押してから
     * 止まるまでに間合いのぶん遅れる
     */
    test('マウスは1回で再生・一時停止', () => {
        const { action } = tap(null, 1000, 'center', false);
        expect(action).toEqual({ kind: 'play' });
    });

    test('指は1回で操作列の出し入れ', () => {
        const { action } = tap(null, 1000, 'center', true);
        expect(action).toEqual({ kind: 'controls' });
    });

    test('左端を素早く2回で 10秒 戻る', () => {
        const first = tap(null, 1000, 'left', true);
        const { action } = tap(first.next, 1000 + DOUBLE_TAP - 1, 'left', true);
        expect(action).toEqual({ kind: 'seek', by: -SKIP, undo: false });
    });

    test('右端を素早く2回で 10秒 送る', () => {
        const first = tap(null, 1000, 'right', true);
        const { action } = tap(first.next, 1100, 'right', true);
        expect(action).toEqual({ kind: 'seek', by: SKIP, undo: false });
    });

    /**
     * マウスの1回目は再生を切り替えてしまっているので、2回目でそれを戻す。
     * 戻さないと「送ったら止まった」になる
     */
    test('マウスの2回目は、1回目の再生切り替えを打ち消す', () => {
        const first = tap(null, 1000, 'right', false);
        expect(first.action).toEqual({ kind: 'play' });
        const { action } = tap(first.next, 1100, 'right', false);
        expect(action).toEqual({ kind: 'seek', by: SKIP, undo: true });
    });

    test('間合いを過ぎたら2回目にしない', () => {
        const first = tap(null, 1000, 'left', true);
        const { action } = tap(first.next, 1000 + DOUBLE_TAP, 'left', true);
        expect(action).toEqual({ kind: 'controls' });
    });

    test('違う端なら2回目にしない', () => {
        const first = tap(null, 1000, 'left', true);
        const { action } = tap(first.next, 1100, 'right', true);
        expect(action).toEqual({ kind: 'controls' });
    });

    test('真ん中は何回押しても送りにならない', () => {
        const first = tap(null, 1000, 'center', true);
        const { action } = tap(first.next, 1100, 'center', true);
        expect(action).toEqual({ kind: 'controls' });
    });

    /** 30秒 戻したいときに3回押せる */
    test('続けて押せばそのぶん重なる', () => {
        let state = tap(null, 1000, 'left', true).next;
        const seconds: number[] = [];
        for (let i = 1; i <= 3; i++) {
            const step = tap(state, 1000 + i * 100, 'left', true);
            if (step.action.kind === 'seek') seconds.push(step.action.by);
            state = step.next;
        }
        expect(seconds).toEqual([-SKIP, -SKIP, -SKIP]);
    });
});

const CHAPTERS = [
    { start: 0, end: 60, title: '本編' },
    { start: 60, end: 120, title: 'CM' },
    { start: 120, end: 300, title: '本編' },
];

describe('チャプター送り', () => {
    test('次はいまより後ろの最初の頭', () => {
        expect(nextChapterAt(CHAPTERS, 10)).toBe(60);
        expect(nextChapterAt(CHAPTERS, 60)).toBe(120);
    });

    test('最後のチャプターに居るなら次は無い', () => {
        expect(nextChapterAt(CHAPTERS, 200)).toBeNull();
    });

    /** 曲送りと同じ癖。押し間違えたときに1つ前まで飛ばない */
    test('戻すと、まずいま観ているものの頭へ', () => {
        expect(prevChapterAt(CHAPTERS, 100)).toBe(60);
    });

    test('頭のすぐ後ろなら1つ前へ', () => {
        expect(prevChapterAt(CHAPTERS, 62)).toBe(0);
    });

    test('1本目の頭に居るなら戻り先は無い', () => {
        expect(prevChapterAt(CHAPTERS, 1)).toBeNull();
    });

    test('チャプターが無ければどちらも無い', () => {
        expect(nextChapterAt([], 10)).toBeNull();
        expect(prevChapterAt([], 10)).toBeNull();
    });

    test('いま観ているものが分かる', () => {
        expect(chapterAt(CHAPTERS, 70)?.title).toBe('CM');
        expect(chapterAt(CHAPTERS, 0)?.title).toBe('本編');
        // 最後のチャプターより後ろ (端数で行き過ぎたとき)
        expect(chapterAt(CHAPTERS, 400)).toBeNull();
    });
});

describe('ffprobe のチャプターを読む', () => {
    /** 実物の形 (`-show_chapters -print_format json`) */
    const REAL = JSON.stringify({
        chapters: [
            {
                id: 0,
                time_base: '1/1000',
                start: 0,
                start_time: '0.000000',
                end: 60000,
                end_time: '60.000000',
                tags: { title: '本編' },
            },
            {
                id: 1,
                time_base: '1/1000',
                start: 60000,
                start_time: '60.000000',
                end: 120000,
                end_time: '120.000000',
                tags: { title: 'CM' },
            },
        ],
    });

    test('頭・終わり・名前を取り出す', () => {
        expect(parseChapters(REAL)).toEqual([
            { start: 0, end: 60, title: '本編' },
            { start: 60, end: 120, title: 'CM' },
        ]);
    });

    /** CMを切って焼いたものにはチャプターが無い */
    test('1つも無ければ空', () => {
        expect(parseChapters(JSON.stringify({ chapters: [] }))).toEqual([]);
    });

    test('読めなければ空。落とさない', () => {
        expect(parseChapters('')).toEqual([]);
        expect(parseChapters('{')).toEqual([]);
        expect(parseChapters(JSON.stringify({ streams: [] }))).toEqual([]);
    });

    test('長さの無いものと壊れた行は捨てる', () => {
        const broken = JSON.stringify({
            chapters: [
                { start_time: '10.0', end_time: '10.0', tags: { title: '長さ0' } },
                { start_time: 'x', end_time: '5', tags: { title: '読めない' } },
                { start_time: '0', end_time: '5' },
            ],
        });
        expect(parseChapters(broken)).toEqual([{ start: 0, end: 5, title: '—' }]);
    });

    test('順に並べ直す', () => {
        const shuffled = JSON.stringify({
            chapters: [
                { start_time: '60', end_time: '120', tags: { title: 'CM' } },
                { start_time: '0', end_time: '60', tags: { title: '本編' } },
            ],
        });
        expect(parseChapters(shuffled).map((c) => c.start)).toEqual([0, 60]);
    });
});

describe('続きから観る', () => {
    test('途中で止めたところは覚える', () => {
        expect(resumePoint(600, 1800)).toBe(600);
    });

    /** 覚えると、次に開いたときエンドロールから始まる */
    test('末尾まで観たものは覚えない', () => {
        expect(resumePoint(1790, 1800)).toBeNull();
        expect(resumePoint(1770, 1800)).toBe(1770);
    });

    /** 「続きがある」と見えるぶんだけ紛らわしい */
    test('頭のすぐそばも覚えない', () => {
        expect(resumePoint(5, 1800)).toBeNull();
        expect(resumePoint(20, 1800)).toBe(20);
    });

    test('尺が分からなければ末尾の判断はしない', () => {
        expect(resumePoint(600, 0)).toBe(600);
    });
});
