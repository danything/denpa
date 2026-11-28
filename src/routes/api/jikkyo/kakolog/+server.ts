import { error, json } from "@sveltejs/kit";

import { hubFetch } from "#lib/server/jikkyo-hub.js";
import { settings } from "#lib/server/settings.js";

/** 実況のチャンネルの ID (`jk1` など) */
const CHANNEL = /^jk\d{1,4}$/;
/** 1 回に取ってよい長さ (過去ログ API の決まり) */
const MAX_SPAN = 3 * 24 * 60 * 60_000;

/**
 * **録画の実況のコメント** (過去ログ。docs/api.md)。`?channel=jk1&from=<unix ms>&to=<unix ms>` (3 日まで) を denpa-hub にそのまま渡し、
 * 返事 `{"comments":[…],"complete":bool}` をそのまま返す。hub に届かなければ 503。世帯の設定がオフなら 403
 */
export async function GET({ url }) {
  if (!settings().jikkyo) error(403, "実況はオフです");
  const channel = url.searchParams.get("channel") ?? "";
  const from = Number(url.searchParams.get("from"));
  const to = Number(url.searchParams.get("to"));
  if (
    !CHANNEL.test(channel) ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    from >= to ||
    to - from > MAX_SPAN
  )
    error(400, "区間が違います");
  let res: Response;
  try {
    res = await hubFetch(
      `/jikkyo/channels/${channel}/kakolog?from=${from}&to=${to}`,
      { headers: { Accept: "application/json" } },
    );
  } catch {
    error(503, "いまは過去ログを読めません");
  }
  if (!res.ok) error(503, "いまは過去ログを読めません");
  return json(await res.json());
}
