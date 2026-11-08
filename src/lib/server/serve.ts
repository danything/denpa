import { recordingSize, recordingStream } from "./recording-io";

/**
 * 録画のファイルをそのまま返す。Range に対応する。
 *
 * プレイヤーは Range でシークする。対応していないと、
 * プレイヤーによっては全部落とし終わるまで早送りできない。
 */
export function serveFile(
  path: string,
  contentType: string,
  request: Request,
): Response {
  const size = recordingSize(path);
  if (size === null) return new Response("not found", { status: 404 });

  const base: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
  };
  if (request.method === "HEAD") {
    return new Response(null, {
      headers: { ...base, "Content-Length": String(size) },
    });
  }

  // `to` は Range と同じく末尾を含む
  const stream = (from?: number, to?: number) =>
    from === undefined || to === undefined
      ? recordingStream(path)
      : recordingStream(path, from, to + 1);

  const unsatisfiable = () =>
    new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  const range = request.headers.get("range");
  const match =
    range === null ? null : /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (match === null) {
    return new Response(stream(), {
      headers: { ...base, "Content-Length": String(size) },
    });
  }

  // bytes=100-  も  bytes=-500 (末尾から)  も来る
  const [, fromRaw, toRaw] = match;
  let from: number;
  let to: number;
  if (fromRaw === "") {
    const suffix = Number(toRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return unsatisfiable();
    from = Math.max(0, size - suffix);
    to = size - 1;
  } else {
    from = Number(fromRaw);
    to = toRaw === "" ? size - 1 : Math.min(Number(toRaw), size - 1);
  }
  if (!Number.isFinite(from) || from >= size || to < from)
    return unsatisfiable();

  return new Response(stream(from, to), {
    status: 206,
    headers: {
      ...base,
      "Content-Length": String(to - from + 1),
      "Content-Range": `bytes ${from}-${to}/${size}`,
    },
  });
}

/** ファイルの ETag (大きさと更新時刻)。中身を読まずに「変わったか」だけを見る */
export function fileEtag(stat: { size: number; mtimeMs: number }): string {
  return `"${stat.size.toString(36)}-${Math.trunc(stat.mtimeMs).toString(36)}"`;
}

/**
 * `If-None-Match` がこの ETag に当たるか。前段の proxy が弱い形式 (`W/"…"`) にしたり、
 * いくつも並べたりしても当たりにする
 */
export function etagMatches(request: Request, tag: string): boolean {
  return (request.headers.get("if-none-match") ?? "")
    .split(",")
    .some((t) => t.trim().replace(/^W\//, "") === tag);
}
