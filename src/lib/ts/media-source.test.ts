import { describe, expect, test } from 'bun:test';
import { type MediaSourceClass, pickMediaSource } from './media-source';

// 中身は見ない。どれが選ばれたかだけ (同じものかどうか) を見る
const fake = (): MediaSourceClass =>
    Object.assign(() => {}, { isTypeSupported: () => true }) as unknown as MediaSourceClass;

describe('pickMediaSource', () => {
    test('MediaSource があればそちら', () => {
        const MediaSource = fake();
        const ManagedMediaSource = fake();
        expect(pickMediaSource({ MediaSource, ManagedMediaSource })).toEqual({
            Source: MediaSource,
            managed: false,
        });
    });

    test('ManagedMediaSource しか無ければ (iPhone の Safari) そちらで、managed と言う', () => {
        const ManagedMediaSource = fake();
        expect(pickMediaSource({ ManagedMediaSource })).toEqual({
            Source: ManagedMediaSource,
            managed: true,
        });
    });

    test('どちらも無ければ null', () => {
        expect(pickMediaSource({})).toBeNull();
    });
});
