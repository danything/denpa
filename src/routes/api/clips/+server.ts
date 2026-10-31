import { error, json } from "@sveltejs/kit";

import { CLIP_BYTES_MOST, parseClipQuery } from "#lib/clips.js";
import {
  ClipError,
  DELETE_MOST,
  deleteClips,
  findClips,
  liveScene,
  readClipForm,
  recordingScene,
  saveClip,
  type Scene,
} from "#lib/server/clips.js";
import { emit } from "#lib/server/events.js";
import { recordingOr404 } from "#lib/server/recording.js";
import { parseFileSource } from "#lib/source.js";

/**
 * 切り抜きを探す。新しい順に 60 件ずつ (`?before=` で続き)。条件は `#lib/clips.ts` の `ClipQuery`
 */
export function GET({ url }) {
  return json(findClips(parseClipQuery(url.searchParams)));
}

/** URL の数。無い・読めないなら null */
function number(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 1枚を受けて置く。本文は2つの形のどちらか:
 *
 * - **multipart/form-data** … `frame` (映像。PNG・JPEG・WebP) と、出していた重ね `captions` (字幕)・`comments` (実況のコメント)。
 *   重ねは映像と同じ縦横の透明な PNG で、送ったものはあとから出し入れできる (`PATCH /api/clips/<id>`)
 * - **画像そのもの** (PNG・JPEG・WebP) … 重ねは無し (出し入れできない)
 *
 * どこで撮ったかは URL で:
 *
 * - `place=watch|chase` … `recording` (録画ID)・`at` (位置の秒。観ているものの物差し)・`source` (`ts` / `encoded` / `hevc` / `alt`)
 * - `place=live` … `service` (局の内部ID)・`aired` (映していたコマの放送時刻。unix ms。無ければ受け取った時刻)
 * - `captions` … 出していた字幕の文字 (任意)
 *
 * 番組の情報はサーバが引く (`server/clips.ts`)。返事は 201 と `Clip`。本文が大きすぎれば 413、画像でなければ 415
 */
export async function POST({ url, request }) {
  const length = Number(request.headers.get("content-length"));
  // 読む前に断れるものは断る (本文の上限より小さい所で切る)
  if (Number.isFinite(length) && length > CLIP_BYTES_MOST)
    error(413, "画像が大きすぎます");
  const place = url.searchParams.get("place");
  let scene: Scene;
  try {
    if (place === "watch" || place === "chase") {
      const recording = recordingOr404(url.searchParams.get("recording") ?? "");
      const at = number(url, "at");
      if (at === null || at < 0) error(400, "位置が不正です");
      const raw = url.searchParams.get("source");
      const source = raw === null ? null : parseFileSource(raw);
      if (raw !== null && source === null) error(400, "source が不正です");
      scene = recordingScene(recording, place, at, source);
    } else if (place === "live") {
      const service = number(url, "service");
      if (service === null) error(400, "局が不正です");
      const aired = number(url, "aired");
      // 端末の時計は信じすぎない。1日より離れていれば受け取った時刻にする
      const at =
        aired !== null && Math.abs(aired - Date.now()) < 24 * 60 * 60_000
          ? aired
          : Date.now();
      scene = liveScene(service, at);
    } else {
      error(400, "place が不正です");
    }

    const multipart = (request.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("multipart/form-data");
    const parts = multipart
      ? await readClipForm(
          await request.formData().catch(() => {
            throw new ClipError(400, "本文を読めませんでした");
          }),
        )
      : { frame: new Uint8Array(await request.arrayBuffer()) };
    const clip = await saveClip(
      parts,
      scene,
      url.searchParams.get("captions") ?? "",
    );
    emit("clips");
    return json(clip, { status: 201 });
  } catch (thrown) {
    if (thrown instanceof ClipError) error(thrown.status, thrown.message);
    throw thrown;
  }
}

/** まとめて消す (`?ids=1,2,3`)。消せた数を返す。もう無いものは数えない */
export function DELETE({ url }) {
  const ids = (url.searchParams.get("ids") ?? "")
    .split(",")
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0) error(400, "消す切り抜きを指定してください");
  if (ids.length > DELETE_MOST)
    error(400, `一度に消せるのは ${DELETE_MOST} 枚までです`);
  const deleted = deleteClips(ids);
  if (deleted > 0) emit("clips");
  return json({ deleted });
}
