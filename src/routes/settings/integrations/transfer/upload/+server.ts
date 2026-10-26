import { json } from "@sveltejs/kit";

import {
  appendUpload,
  beginUpload,
  CHUNK_LIMIT,
} from "#lib/server/transfer.js";

import { failure, migrating, refuse } from "../guard.server";

/** **送り始める。** 名前・大きさ・更新時刻を言う。同じファイルを送りかけていれば続きの位置が返る */
export async function POST(event) {
  const refused = refuse(event) ?? migrating();
  if (refused !== null) return refused;
  try {
    const body = (await event.request.json()) as Record<string, unknown>;
    return json(
      beginUpload({
        name: String(body["name"] ?? ""),
        size: Number(body["size"]),
        lastModified: Number(body["lastModified"]),
      }),
    );
  } catch (error) {
    return failure(error);
  }
}

/**
 * **続きを送る** (`?offset=<n>`、本文は `application/octet-stream`)。位置が合わなければ 409 と今の位置を返すので、
 * 画面はそこから送り直す
 */
export async function PUT(event) {
  const refused = refuse(event);
  if (refused !== null) return refused;
  const offset = Number(event.url.searchParams.get("offset"));
  if (!Number.isSafeInteger(offset) || offset < 0)
    return json({ message: "送る位置が読めません" }, { status: 400 });
  const length = Number(event.request.headers.get("content-length") ?? 0);
  if (length > CHUNK_LIMIT)
    return json({ message: "1 回に送る量が多すぎます" }, { status: 413 });
  try {
    const chunk = new Uint8Array(await event.request.arrayBuffer());
    return json(appendUpload(offset, chunk));
  } catch (error) {
    return failure(error);
  }
}
