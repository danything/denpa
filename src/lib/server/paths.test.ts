import { describe, expect, test } from 'bun:test';
import { publicBase, relative } from './paths';

describe('relative', () => {
    test('いまの深さだけ上がってから行き先へ', () => {
        expect(relative(new URL('http://h/rules'), '/rules')).toBe('./rules');
        expect(relative(new URL('http://h/watch/12'), '/')).toBe('../');
        expect(relative(new URL('http://h/login/callback?code=x'), '/guide?type=BS')).toBe(
            '../guide?type=BS',
        );
        expect(relative(new URL('http://h/'), '/login?to=%2F')).toBe('./login?to=%2F');
    });
});

describe('publicBase', () => {
    test('前段が付けた接頭辞を頭に付ける', () => {
        const url = new URL('http://denpa.local:3000/api/x');
        expect(publicBase(url, new Headers())).toBe('http://denpa.local:3000');
        expect(publicBase(url, new Headers({ 'x-forwarded-prefix': '/denpa/' }))).toBe(
            'http://denpa.local:3000/denpa',
        );
        expect(publicBase(url, new Headers({ 'x-ingress-path': '/api/hassio_ingress/abc' }))).toBe(
            'http://denpa.local:3000/api/hassio_ingress/abc',
        );
    });
    test('/ で始まらないものは使わない (Host を差し替える口にしない)', () => {
        expect(
            publicBase(new URL('http://h/'), new Headers({ 'x-forwarded-prefix': '//evil.example' })),
        ).toBe('http://h');
    });
});
