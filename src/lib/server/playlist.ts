/**
 * 続きの位置から始めさせるための XSPF (VLC が読むプレイリスト)。
 *
 * テレビの VLC の `/play?path=<URL>` には**開始位置を渡す口が無い**。ファイルの
 * URL を直に渡すかぎり頭から始まる。XSPF なら 1 曲ごとに VLC 独自のオプション
 * (`vlc:option`) を添えられ、`start-time=<秒>` で途中から始められる — 渡すものを
 * ファイルからこの 1 枚に替えるだけで、VLC 側の設定は要らない。
 *
 * **中身は取りに来た瞬間に作る** (`playlist/[name]/+server.ts`)。位置を URL に
 * 焼き込まないので、テレビの履歴に残った同じ URL を開き直しても、そのときの
 * 続きから始まる。
 *
 * 見出しは `<title>` に入れる。ファイルの URL のときは尻の区切りが見出しになる
 * (share/+server.ts) が、プレイリストの中の 1 曲はプレイリストの題が使われる
 */
export function xspf(track: { title: string; location: string; startSeconds: number }): string {
    const start = Math.max(0, Math.floor(track.startSeconds));
    // 0 のときは付けない。付けても頭からだが、VLC のバージョンによる読み違いの種を減らす
    const option =
        start === 0
            ? ''
            : `
      <extension application="http://www.videolan.org/vlc/playlist/0">
        <vlc:option>start-time=${start}</vlc:option>
      </extension>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<playlist version="1" xmlns="http://xspf.org/ns/0/" xmlns:vlc="http://www.videolan.org/vlc/playlist/ns/0/">
  <trackList>
    <track>
      <location>${escapeXml(track.location)}</location>
      <title>${escapeXml(track.title)}</title>${option}
    </track>
  </trackList>
</playlist>
`;
}

/** XML の中身に置けない 5 文字。番組名にも URL (`&` で繋いだクエリ) にも出る */
function escapeXml(text: string): string {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}
