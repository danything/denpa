/**
 * **実況のコメントの取得先。** CSP の `connect-src` (`vite.config.ts`) と同じ定数をここ 1 か所に置く。
 *
 * - NX-Jikkyo (tsukumijima さんが運営する非公式のコメントサーバ。公式のニコニコ実況のコメントも取り込んでいる):
 *   ライブは端末が WebSocket で直接繋ぐ。局の勢いの一覧 (REST) は CORS を許していないので、サーバが中継する
 *   (`server/jikkyo-ranking.ts`)
 * - ニコニコ実況 過去ログ API (同じく tsukumijima さん): 録画のコメントを端末が直接取得する (CORS は `*`)
 *
 * 宛先はホストまで書く (`wss:` や `https:` だけにすると、どこへでも繋げるようになる)
 */

/** NX-Jikkyo の WebSocket のオリジン */
export const NX_JIKKYO_WS = "wss://nx-jikkyo.tsukumijima.net";
/** NX-Jikkyo の REST のオリジン (サーバだけが使う) */
export const NX_JIKKYO_API = "https://nx-jikkyo.tsukumijima.net";
/** ニコニコ実況 過去ログ API のオリジン */
export const KAKOLOG_API = "https://jikkyo.tsukumijima.net";

/** 視聴の WebSocket。ここで `room` を受け取り、コメントの WebSocket の URL はそれに従う (こちらで組まない) */
export function watchUrl(channel: string): string {
  return `${NX_JIKKYO_WS}/api/v1/channels/${channel}/ws/watch`;
}

/** 過去ログ。時刻は unix 秒。`endtime` は今より後にできず、1 回に 3 日まで */
export function kakologUrl(channel: string, from: number, to: number): string {
  return `${KAKOLOG_API}/api/kakolog/${channel}?starttime=${from}&endtime=${to}&format=json`;
}

/** 全チャンネルの今の勢い (サーバの中継だけが読む) */
export const NX_JIKKYO_CHANNELS = `${NX_JIKKYO_API}/api/v1/channels`;
