import { describe, expect, test } from 'bun:test';
import { decodeHtml, frameMessage, prepareApp, receiverKey, type ShimInit, storageKey } from './app';

const INIT: ShimInit = {
    url: 'https://hc.example.jp/app/index.html',
    organisationId: 0x10,
    applicationId: 1,
    storage: { a: '</script><script>alert(1)</script>' },
    state: { program: null, serviceName: '', captions: true },
};

describe('prepareApp', () => {
    test('<head> の直後に <base> と差し込みを入れる (doctype は先頭のまま)', () => {
        const html = prepareApp(
            '<!DOCTYPE html><html><head><title>t</title></head><body>x</body></html>',
            INIT,
        );
        expect(
            html.startsWith(
                '<!DOCTYPE html><html><head><base href="https://hc.example.jp/app/index.html"><script>(',
            ),
        ).toBe(true);
        expect(html.indexOf('<title>')).toBeGreaterThan(html.indexOf('</script>'));
    });

    test('アプリ自身の <base> は、アプリの URL から解決したものを先に置く', () => {
        const html = prepareApp('<html><head><base href="../common/"></head></html>', INIT);
        expect(html).toContain('<base href="https://hc.example.jp/common/">');
    });

    test('記憶の中身で差し込みの script が切れない', () => {
        const html = prepareApp('<head></head>', INIT);
        // 差し込みの </script> は最後の 1 つだけ
        expect(html.match(/<\/script>/g)).toHaveLength(1);
    });

    test('head も html も無ければ頭に入れる', () => {
        expect(prepareApp('<p>x</p>', INIT).startsWith('<base ')).toBe(true);
    });
});

test('decodeHtml は content-type、無ければ meta の charset で読む', () => {
    const sjis = Uint8Array.of(0x82, 0xa0); // 「あ」
    expect(decodeHtml(sjis, 'text/html; charset=Shift_JIS')).toBe('あ');
    const meta = new Uint8Array([...new TextEncoder().encode('<meta charset="shift_jis">'), 0x82, 0xa0]);
    expect(decodeHtml(meta, 'text/html').endsWith('あ')).toBe(true);
    expect(decodeHtml(new TextEncoder().encode('あ'), 'text/html')).toBe('あ');
});

test('frameMessage は形の合わないものを捨てる', () => {
    expect(frameMessage({ type: 'close' })).toBeNull();
    expect(frameMessage({ hc: 1, type: 'close' })).toEqual({ type: 'close' });
    expect(frameMessage({ hc: 1, type: 'fetch', id: 'x', url: 'a', method: 'GET' })).toBeNull();
    expect(frameMessage({ hc: 1, type: 'tune', onid: 1, sid: 2 })).toEqual({
        type: 'tune',
        onid: 1,
        tsid: null,
        sid: 2,
    });
    expect(frameMessage({ hc: 1, type: 'store', items: { a: 'b', c: 1 } })).toEqual({
        type: 'store',
        items: { a: 'b' },
    });
    expect(frameMessage({ hc: 1, type: 'unknown' })).toBeNull();
    expect(frameMessage({ hc: 1, type: 'video', place: 'other' })).toBeNull();
    expect(frameMessage({ hc: 1, type: 'video', place: { left: 'x', top: 1, width: 2, height: 3 } })).toEqual(
        {
            type: 'video',
            place: { left: 0, top: 1, width: 2, height: 3 },
        },
    );
    expect(frameMessage({ hc: 1, type: 'fetch', id: 1, url: 'a', method: 'GET', body: 'x' })).toMatchObject({
        body: null,
    });
});

test('receiverKey: 色ボタンは 403〜406、戻ると d は閉じる', () => {
    expect(receiverKey(22)).toEqual({ key: 'r', code: 403 });
    expect(receiverKey(21)).toEqual({ key: 'b', code: 406 });
    expect(receiverKey(18)).toEqual({ key: 'Enter', code: 13 });
    expect(receiverKey(7)).toEqual({ key: '2', code: 50 });
    expect(receiverKey(19)).toBeNull();
    expect(receiverKey(20)).toBeNull();
});

test('記憶の置き場はアプリごと', () => {
    expect(storageKey(0x10, 1)).toBe('denpa_hybridcast_10_1');
    expect(storageKey(0x10, 2)).not.toBe(storageKey(0x10, 1));
});
