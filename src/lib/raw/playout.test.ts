import { describe, expect, test } from 'bun:test';
import { DRY, LEAD, Playout, SLACK, SLACK_FOR } from './playout';

/** AAC の1コマ (1024 標本 @48kHz) = 1920 (90kHz) = 21.3ms */
const D = 1920;
const chunk = (n: number) => ({ pts: 90_000 + n * D, duration: D, n });

describe('Playout', () => {
    test('貯まるまで鳴らさない。貯まったら放送の今から target 手前で始める', () => {
        const playout = new Playout<ReturnType<typeof chunk>>(0.2);
        // 0.2秒 = 9.4コマ。9コマでは足りない
        for (let n = 0; n < 9; n++) expect(playout.push(chunk(n), 0)).toBeNull();
        expect(playout.tick(0).kind).toBe('none');
        expect(playout.position(0)).toBeNull();

        for (let n = 9; n < 20; n++) playout.push(chunk(n), 0);
        const started = playout.tick(10);
        expect(started.kind).toBe('start');
        if (started.kind !== 'start') return;
        const newest = 90_000 + 20 * D;
        // 鳴らし始めは新しい端の 0.2秒手前。そこより古いコマは予約しない
        expect(playout.position(10 + LEAD)).toBeCloseTo(newest - 0.2 * 90_000, 5);
        expect(started.schedule.every((s) => s.chunk.pts + D > newest - 0.2 * 90_000)).toBe(true);
        // 途中から鳴らすコマは頭を飛ばす
        expect(started.schedule[0]!.offset).toBeGreaterThan(0);
    });

    test('鳴らしている間に届いたものは、時刻どおりに並べる', () => {
        const playout = new Playout<ReturnType<typeof chunk>>(0.1);
        for (let n = 0; n < 10; n++) playout.push(chunk(n), 0);
        const started = playout.tick(0);
        if (started.kind !== 'start') throw new Error('始まらない');
        const next = playout.push(chunk(10), 0.01);
        const last = started.schedule.at(-1)!;
        // 前のコマの終わりにぴったり続く (隙間も重なりも無い)
        expect(next?.when).toBeCloseTo(last.when + D / 90_000, 9);
    });

    test('使い切ったら止まって、貯め直す', () => {
        const playout = new Playout<ReturnType<typeof chunk>>(0.1);
        for (let n = 0; n < 10; n++) playout.push(chunk(n), 0);
        playout.tick(0);
        // 何も届かないまま 0.3 秒たつ
        const stalled = playout.tick(0.3);
        expect(stalled.kind).toBe('stall');
        expect(playout.playing).toBe(false);
        expect(DRY).toBeLessThan(0.1);
    });

    test('溜まりすぎが続いたら放送の今へ跳ぶ。一瞬では跳ばない', () => {
        const playout = new Playout<ReturnType<typeof chunk>>(0.1);
        for (let n = 0; n < 10; n++) playout.push(chunk(n), 0);
        playout.tick(0);
        // 一度に 5 秒ぶん届く (裏から戻ったタブ)
        for (let n = 10; n < 260; n++) playout.push(chunk(n), 0.01);
        expect(playout.tick(0.02).kind).toBe('none');
        const jumped = playout.tick(0.02 + SLACK_FOR);
        expect(jumped.kind).toBe('jump');
        expect(playout.lead(0.02 + SLACK_FOR + LEAD)).toBeLessThan(0.1 + SLACK);
    });

    test('止めている間は鳴らし始めず、溜め込みもしない', () => {
        const playout = new Playout<ReturnType<typeof chunk>>(0.1);
        playout.hold();
        for (let n = 0; n < 500; n++) playout.push(chunk(n), 0);
        expect(playout.tick(1).kind).toBe('none');
        expect(playout.lead(1)).toBeLessThanOrEqual(0.1 + SLACK + 0.03);
        playout.resume();
        expect(playout.tick(1).kind).toBe('start');
    });

    test('時計を替えても、鳴っている位置は動かさない', () => {
        const playout = new Playout<ReturnType<typeof chunk>>(0.1);
        for (let n = 0; n < 10; n++) playout.push(chunk(n), 0);
        playout.tick(0);
        const here = playout.position(0.06) as number;
        playout.rebase(here, 500);
        expect(playout.position(500 + LEAD)).toBeCloseTo(here, 5);
    });
});

describe('Playout (追っかけ: 放送の今を追わない)', () => {
    test('溜まりすぎても跳ばない', () => {
        const playout = new Playout<ReturnType<typeof chunk>>(0.1);
        playout.follow = true;
        for (let n = 0; n < 10; n++) playout.push(chunk(n), 0);
        playout.tick(0);
        // 倍速で送り込まれて 5 秒ぶん溜まる
        for (let n = 10; n < 260; n++) playout.push(chunk(n), 0.01);
        expect(playout.tick(0.02).kind).toBe('none');
        expect(playout.tick(0.02 + SLACK_FOR).kind).toBe('none');
        expect(playout.lead(0.02 + SLACK_FOR)).toBeGreaterThan(0.1 + SLACK);
    });

    test('止めて再開は、止めた所から。止めている間に届いたぶんも捨てない', () => {
        const playout = new Playout<ReturnType<typeof chunk>>(0.1);
        playout.follow = true;
        for (let n = 0; n < 100; n++) playout.push(chunk(n), 0);
        const started = playout.tick(0);
        if (started.kind !== 'start') throw new Error('始まらない');
        // 追っかけは頭 (いちばん古いもの) から鳴らす
        expect(playout.position(LEAD)).toBeCloseTo(90_000, 5);
        const here = playout.position(0.5) as number;
        playout.hold(0.5);
        for (let n = 100; n < 600; n++) playout.push(chunk(n), 1);
        expect(playout.tick(5).kind).toBe('none');
        playout.resume();
        const resumed = playout.tick(5);
        expect(resumed.kind).toBe('start');
        expect(playout.position(5 + LEAD)).toBeCloseTo(here, 5);
        expect(playout.lead(5 + LEAD)).toBeGreaterThan(10);
    });
});
