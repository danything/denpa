import { describe, expect, test } from 'bun:test';
import { channelNotice } from './channel-notice';

describe('channelNotice', () => {
    test('どの種別にも局が無ければ出す', () => {
        expect(channelNotice({})).toBe('all');
        expect(channelNotice({ GR: 0, BS: 0, CS: 0 })).toBe('all');
    });

    test('衛星だけの家では出さない (地上波が無くても)', () => {
        expect(channelNotice({ GR: 0, BS: 12, CS: 0 })).toBeNull();
        expect(channelNotice({ CS: 3 })).toBeNull();
    });

    test('地上波だけでも出さない', () => {
        expect(channelNotice({ GR: 8, BS: 0, CS: 0 })).toBeNull();
    });
});
