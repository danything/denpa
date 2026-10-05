import { describe, expect, test } from 'bun:test';
import { type Situation, step, storedBackground } from './background';

const base: Situation = { allowed: false, hidden: true, pip: false, paused: false, held: false };

describe('バックグラウンド再生', () => {
    test('既定は切。入れたことのある端末だけ入', () => {
        expect(storedBackground(null)).toBe(false);
        expect(storedBackground('0')).toBe(false);
        expect(storedBackground('1')).toBe(true);
    });

    test('切なら、裏に回った時点で止める', () => {
        expect(step(base)).toBe('pause');
    });

    test('入なら、裏でも止めない', () => {
        expect(step({ ...base, allowed: true })).toBeNull();
    });

    test('押して開いた小窓を出している間は止めない。閉じたらそこで止める', () => {
        expect(step({ ...base, pip: true })).toBeNull();
        expect(step({ ...base, pip: false })).toBe('pause');
    });

    test('自分で止めてから裏に回ったものは触らない。戻っても再開しない', () => {
        expect(step({ ...base, paused: true })).toBeNull();
        expect(step({ ...base, hidden: false, paused: true })).toBeNull();
    });

    test('こちらが止めたものだけ、戻ってきたら再開する', () => {
        expect(step({ ...base, hidden: false, paused: true, held: true })).toBe('resume');
        // 裏にいる間に (ロック画面などから) 再開されていれば、そのまま
        expect(step({ ...base, hidden: false, paused: false, held: true })).toBeNull();
        // 止めたあとの裏での揺れ (小窓の出入りなど) で二度止めない
        expect(step({ ...base, paused: true, held: true })).toBeNull();
    });

    test('見えている間は何もしない', () => {
        expect(step({ ...base, hidden: false })).toBeNull();
    });
});
