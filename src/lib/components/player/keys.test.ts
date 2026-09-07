/**
 * 再生画面のキー操作。**観る画面と追っかけで同じ割り当て**にするための共通部品。
 *
 * DOM は要らないので、押されたことだけを作って渡す。
 */

import { describe, expect, test } from 'bun:test';
import { playerKeys } from './keys';

/** 押す。`preventDefault` を呼んだか (= 取ったか) を返す */
function press(
    handler: (event: KeyboardEvent) => void,
    key: string,
    event: Record<string, unknown> = {},
): boolean {
    let took = false;
    handler({
        key,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        isComposing: false,
        target: { closest: () => null },
        preventDefault: () => {
            took = true;
        },
        ...event,
    } as unknown as KeyboardEvent);
    return took;
}

/** 全部の口を持つ画面 (観る画面・追っかけ)。押されたものを名前で溜める */
function harness() {
    const done: string[] = [];
    const handler = playerKeys({
        togglePlay: () => done.push('play'),
        seekBy: (seconds) => done.push(`seek ${seconds}`),
        toggleCaptions: () => done.push('captions'),
        snapshot: () => done.push('shot'),
        toggleFull: () => done.push('full'),
        stepSpeed: (direction) => done.push(`speed ${direction}`),
        toggleMute: () => done.push('mute'),
    });
    return { done, press: (key: string, event: Record<string, unknown> = {}) => press(handler, key, event) };
}

describe('再生画面のキー', () => {
    test('空白と k で再生/一時停止、左右で 10秒', () => {
        const { done, press } = harness();
        expect(press(' ')).toBe(true);
        press('k');
        press('ArrowLeft');
        press('ArrowRight');
        expect(done).toEqual(['play', 'play', 'seek -10', 'seek 10']);
    });

    test('字幕・切り抜き・全画面・速さ・消音', () => {
        const { done, press } = harness();
        for (const key of ['c', 's', 'f', '>', '<', 'm']) press(key);
        expect(done).toEqual(['captions', 'shot', 'full', 'speed 1', 'speed -1', 'mute']);
    });

    /*
     * **修飾キー付きは取らない。** Ctrl+C (コピー) を `c` (字幕) として横取りして
     * いた頃は、観ながら番組名や URL を写せなかった。Shift だけは通す
     * (`<` `>` は Shift 込みで打つ)
     */
    test('修飾キー付きと変換中は取らない。Shift だけは通す', () => {
        const { done, press } = harness();
        expect(press('c', { ctrlKey: true })).toBe(false);
        expect(press('f', { metaKey: true })).toBe(false);
        expect(press('s', { altKey: true })).toBe(false);
        expect(press(' ', { isComposing: true })).toBe(false);
        expect(done).toEqual([]);

        expect(press('>', { shiftKey: true })).toBe(true);
        expect(done).toEqual(['speed 1']);
    });

    /** 入力欄やボタンの上では取らない — 空白でボタンを押せなくなる */
    test('入力欄・ボタン・リンクの上では取らない', () => {
        const { done, press } = harness();
        expect(press(' ', { target: { closest: () => ({}) } })).toBe(false);
        expect(done).toEqual([]);
    });

    /** 知らないキーと、その画面が持っていない口は素通し */
    test('割り当ての無いキーは何もしない', () => {
        const done: string[] = [];
        // 再生と送りだけを持つ画面 (字幕も速さも無い)
        const handler = playerKeys({
            togglePlay: () => done.push('play'),
            seekBy: (seconds) => done.push(`seek ${seconds}`),
        });
        expect(press(handler, 'c')).toBe(false);
        expect(press(handler, '>')).toBe(false);
        expect(press(handler, 'q')).toBe(false);
        expect(done).toEqual([]);
        expect(press(handler, ' ')).toBe(true);
        expect(done).toEqual(['play']);
    });
});
