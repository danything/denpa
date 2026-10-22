import { describe, expect, test } from 'bun:test';
import { rewriteLocation } from './location';

describe('rewriteLocation', () => {
    test('location の名前・頭・オリジンの読み出しを、差し込みの __hcLocation から読ませる', () => {
        // NHK のアプリはこの形で次に開く住所を組み立てる
        const code = 'url:"https://".concat(window.location.hostname.split(".")[0],".nhk.jp/hc-ssl/1.txt")';
        expect(rewriteLocation(code)).toBe(
            'url:"https://".concat((self.__hcLocation||location).hostname.split(".")[0],".nhk.jp/hc-ssl/1.txt")',
        );
        expect(rewriteLocation('a=location.host;b=document.location.origin')).toBe(
            'a=(self.__hcLocation||location).host;b=(self.__hcLocation||location).origin',
        );
    });

    test('移動 (href に入れる・replace) も差し込みを通す', () => {
        expect(rewriteLocation('window.location.href="a";location.replace(b)')).toBe(
            '(self.__hcLocation||location).href="a";(self.__hcLocation||location).replace(b)',
        );
    });

    test('ほかの物の location には触らない', () => {
        const code = 'x.location.hostname;locationHost;a.location.href';
        expect(rewriteLocation(code)).toBe(code);
    });
});
