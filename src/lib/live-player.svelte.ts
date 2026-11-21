/**
 * **ライブと追っかけのプレイヤーの入口。** 出どころ (Feed) に WebSocket の `LiveFeed` を選び、再生の核 (`player/core.svelte.ts`) を組み立てる。
 * 時間の軸 (Clock) は核が持ち替える (ライブは `LiveClock`、追っかけは `openChase` で `ChaseClock`)。
 * 1 つのプレイヤーが、録画に譲るとライブから追っかけに移る (`giveWay`) ので、Clock を入口では決めない
 */

import { playbackCore, type PlaybackOptions } from "#lib/player/core.svelte.js";
import { LiveFeed } from "#lib/player/feed-live.js";

interface LivePlayerOptions extends PlaybackOptions {
  /**
   * 最初に繋ぐときのチケット (`server/tickets.ts`)。ライブのページを組むときにサーバが配る。**1 回だけ使う** (`LiveFeed.takePageTicket`)。
   * 追っかけは渡さない (`/api/live/ticket` で取る)
   */
  ticket?: string | null;
}

export function livePlayer(options: LivePlayerOptions = {}) {
  return playbackCore({ ...options, feed: new LiveFeed(options.ticket) });
}
