/**
 * ヘッダーの印に出すチャンネルのお知らせ (`ChannelAlert.svelte`。スマホの形は設定の入口の印)。どの画面にも渡す (`routes/+layout.server.ts`)。
 * BS・CS のチャンネルを書き換えた (`lineup-follow.ts`) ほうを先に、地上波のお知らせ (`ground-watch.ts`) をあとに出す
 */
import type { ChannelAlertKind } from "#lib/channel-notice.js";

import { groundNotice } from "./ground-watch";
import { lineupNotice } from "./lineup-follow";

export function channelAlert(): {
  kind: ChannelAlertKind;
  text: string;
} | null {
  const changed = lineupNotice();
  if (changed !== null) return { kind: "changed", text: changed };
  const ground = groundNotice();
  return ground === null ? null : { kind: "ground", text: ground };
}
