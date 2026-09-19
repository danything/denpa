import { describe, expect, test } from 'bun:test';
import { xspf } from './playlist';

/**
 * テレビの VLC に「続きから」を伝える 1 枚。VLC の `/play` に位置を渡す口が
 * 無いので、ファイルの代わりにこれを渡す
 */
describe('続きから始める XSPF', () => {
    test('位置は vlc:option の start-time に秒で入る', () => {
        const xml = xspf({
            title: '番組',
            location:
                'https://denpa.example/api/recordings/12/file/%E7%95%AA%E7%B5%84.mkv?token=abc&source=alt',
            startSeconds: 1830.7,
        });
        expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
        expect(xml).toContain('xmlns:vlc="http://www.videolan.org/vlc/playlist/ns/0/"');
        // 端数は捨てる。VLC は整数秒で読む
        expect(xml).toContain('<vlc:option>start-time=1830</vlc:option>');
        // クエリの & は XML では &amp; でないと読めない (VLC のパーサは黙って落とす)
        expect(xml).toContain('?token=abc&amp;source=alt</location>');
        expect(xml).toContain('<title>番組</title>');
    });

    test('頭から (0) のときは start-time を付けない', () => {
        const xml = xspf({ title: 't', location: 'https://x/f', startSeconds: 0 });
        expect(xml).not.toContain('start-time');
        expect(xml).not.toContain('<extension');
    });

    test('番組名の記号は壊さずに通す', () => {
        const xml = xspf({ title: 'A & B <第1話> "始"', location: 'https://x/f', startSeconds: 5 });
        expect(xml).toContain('<title>A &amp; B &lt;第1話&gt; &quot;始&quot;</title>');
    });
});
