/**
 * 録画・番組表・ライブの上に出す、チャンネルのお知らせの 1 行 (`ChannelNotice.svelte`)。
 * BS・CS のチャンネルを書き換えた (`lineup-follow.ts`) ほうを先に、地上波の知らせ (`ground-watch.ts`) をあとに出す
 */
import type { ChannelNotice } from "#lib/channel-notice.js";

import { groundNotice } from "./ground-watch";
import { lineupNotice } from "./lineup-follow";

export function channelAlert(): {
  kind: Extract<ChannelNotice, "changed" | "ground">;
  text: string;
} | null {
  const changed = lineupNotice();
  if (changed !== null) return { kind: "changed", text: changed };
  const ground = groundNotice();
  return ground === null ? null : { kind: "ground", text: ground };
}
