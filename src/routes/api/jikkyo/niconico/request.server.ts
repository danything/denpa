import { error, type RequestEvent } from "@sveltejs/kit";

import { settings } from "#lib/server/settings.js";

/** 実況のチャンネルの ID (`jk1` など。`#lib/jikkyo/channels.ts`) */
const CHANNEL = /^jk\d{1,4}$/;

/**
 * 公式の実況へのリクエストの本文を読む。世帯の設定 (連携の「実況」) がオフなら 403。
 * **JSON だけ受ける** (415)。信頼するネットワークの人は Cookie ではなく接続元で通るので、よそのサイトのフォームから
 * 書き込ませないため (JSON の送信はよそのサイトからだとプリフライトで止まる)
 */
export async function readBody(
  event: RequestEvent,
): Promise<{ channel: string } & Record<string, unknown>> {
  if (!settings().jikkyo) error(403, "実況はオフです");
  if (
    !event.request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    error(415, "JSON で送ってください");
  const body = (await event.request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const channel = body?.["channel"];
  if (typeof channel !== "string" || !CHANNEL.test(channel))
    error(400, "channel が違います");
  return { ...body, channel };
}
