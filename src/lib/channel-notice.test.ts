import { describe, expect, test } from 'bun:test';
import { channelNotice } from './channel-notice';

describe('channelNotice', () => {
    test('どの種別にも局が無ければ all', () => {
        expect(channelNotice({})).toBe('all');
        expect(channelNotice({ GR: 0, BS: 0, CS: 0 })).toBe('all');
    });

    test('地上波だけ無ければ gr', () => {
        expect(channelNotice({ GR: 0, BS: 12, CS: 0 })).toBe('gr');
        expect(channelNotice({ CS: 3 })).toBe('gr');
    });

    test('地上波があれば出さない (衛星が無くても)', () => {
        expect(channelNotice({ GR: 8, BS: 0, CS: 0 })).toBeNull();
    });
});
