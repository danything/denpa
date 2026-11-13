/**
 * 端末に 1 年覚える cookie を書く。読むのはサーバ (開いたときの画面をそれで組む)。
 * `path` は接頭辞込みで渡す (`resolve(...)`)。`/live` と決め打ちすると、前段の接頭辞の下では読む画面に届かない
 */
export function writeCookie(name: string, value: string, path: string): void {
  document.cookie = `${name}=${value}; path=${path}; max-age=31536000; samesite=lax`;
}
