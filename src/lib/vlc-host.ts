/**
 * テレビの VLC (リモートアクセス) のホスト表記を1つの形に整える。
 *
 * 設定の一覧 (server/vlc.ts) と、録画詳細の出先用IP入力 (routes/+page.svelte) の
 * **両方が同じ整え方を通る**ためにここに置く (サーバ専用にしない)。別々に
 * 整えていた頃、入力側だけ `http://` を剥がし忘れて、貼り付けた居場所が
 * `http://http://…` になって黙って失敗していた。
 *
 * `http://` 付きで貼っても剥がし、後ろに `/` から先が付いていても落とし、
 * ポートを略したら VLC の既定 8080 を補う。読める形にならなければ '' を返す
 * (呼び出し側が飛ばす)。
 */
export function normalizeVlcHost(raw: string): string {
    const host = raw
        .trim()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '');
    // ホスト名が無い (':8080' だけ等) 崩れは読めない扱い
    if (host.split(':')[0] === '') return '';
    return host.includes(':') ? host : `${host}:8080`;
}
