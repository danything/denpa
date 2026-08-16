/**
 * `/file` と同じもの。尻の `[name]` は**読み捨てる** — 再生リンクに番組名を
 * 乗せるためだけの段 (`share/+server.ts`)。テレビの VLC は URL の最後の区切りを
 * 見出しにするので、ここに番組名が来ていれば画面に番組名が出る。
 * 資格は `?token=` (hooks + share.ts) で、この段の中身は見ない
 */
export { GET, HEAD } from '../+server';
