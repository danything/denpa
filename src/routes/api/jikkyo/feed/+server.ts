import { json } from "@sveltejs/kit";

import { jikkyoLive } from "#lib/server/jikkyo-live.js";
import { niconicoLive } from "#lib/server/niconico-live.js";

import { readBody } from "../niconico/request.server";

function cursor(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * **ライブの実況のコメント** (denpa-hub から局ごとに 1 本で受けたもの。docs/api.md)。
 * 本文は `{"channel":"jk1","after":<前に受けた番号>,"epoch":"<前に受けた印>"}`。初めて (`after` が無い・`epoch` が違う) ならすぐ直近 15 分を返し、
 * そうでなければ続きが来るか 20 秒たつまで返事を待つ (`server/jikkyo-live.ts`)。
 *
 * ニコニコと連携している世帯のライブは `"official":{"after":…,"epoch":"…"}` も載せる。公式のコメント (`server/niconico-live.ts` の `feed`) も
 * 同じ返事の `official` に入れる (端末から denpa のサーバへのロングポーリングを 1 本にするため)。どちらかに続きが来たら、両方の今を返す。
 * 世帯の設定がオフなら 403
 */
export async function POST(event) {
  const body = await readBody(event);
  const official = body["official"];
  const stop = new AbortController();
  const signal = AbortSignal.any([event.request.signal, stop.signal]);
  const hub = jikkyoLive.feed(
    body.channel,
    cursor(body["after"]),
    typeof body["epoch"] === "string" ? body["epoch"] : null,
    signal,
  );
  if (official === null || typeof official !== "object") return json(await hub);
  const o = official as Record<string, unknown>;
  const niconico = niconicoLive.feed(
    body.channel,
    cursor(o["after"]),
    typeof o["epoch"] === "string" ? o["epoch"] : null,
    signal,
  );
  // 先に返したほうに合わせて、もう一方も待つのをやめる (止めると、その時の中身ですぐ返る)
  await Promise.race([hub, niconico]);
  stop.abort();
  const [h, n] = await Promise.all([hub, niconico]);
  return json({ ...h, official: n });
}
