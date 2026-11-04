import { error } from "@sveltejs/kit";

import { askedTrack } from "#lib/arib.js";
import { parseRung } from "#lib/rungs.js";
import { liveStream, parsePlayable, rungCodec } from "#lib/server/live.js";
import { BUSY, CODEC_HEADER, RUNG_HEADER } from "#lib/ts/playback.js";

/**
 * **ライブを HTTP で流す** (画面の外のもの向けの API。docs/api.md)。
 *
 * 画面と同じエンコード方式の fragmented MP4 を流し続ける。既定は H.264 / AAC (Cast・テレビ・
 * いちばん広く再生できる)。`?codec=av1` で AV1 / Opus、`?codec=raw` でエンコードせずに
 * 1 局に絞っただけの、変換しない TS (MPEG-2。テレビのアプリ向け。Content-Type で分かる)。
 * `?audio=only` で音声だけ (AAC の fMP4。画面の無いスピーカーへの Cast 向け。録画の API と同じ書き方)。
 * `?audio=<音声ID>` (`now.audios` の `id`。`0:sub` など) でエンコードする音声を選ぶ。知らないものは主音声、変換しないときは効かない。
 * `?rung=1〜3` で回線に合わせて画質を下げる (`#lib/rungs.ts`)。コーデックは `?playable=` (`,` 区切り) からサーバが選び、
 * `X-Denpa-Codec` で返す (`live.rungCodec`)。同じ段を誰も観ていなければその場で変換する本数の枠を使い、埋まっていれば 503。
 * 画面の視聴者と同じチューナーの取り合いに加わり、閉じれば抜ける (live.ts の liveStream)
 */
export function GET({ params, url }) {
  const serviceId = Number(params.serviceId);
  if (!Number.isInteger(serviceId)) error(400, "局 ID が不正です");
  const asked = url.searchParams.get("codec");
  const audio = url.searchParams.get("audio");
  const plain =
    audio === "only"
      ? "audio"
      : asked === "av1" || asked === "raw"
        ? asked
        : "h264";
  const rung =
    plain === "raw" || plain === "audio"
      ? 0
      : parseRung(url.searchParams.get("rung"));
  const codec =
    rung === 0 || plain === "raw" || plain === "audio"
      ? plain
      : rungCodec(parsePlayable(url.searchParams.get("playable"), plain), true);
  const stream = liveStream(serviceId, codec, askedTrack(audio), rung);
  if (stream === null) error(404, "局がありません");
  if (stream === "busy") error(503, BUSY);
  return new Response(stream, {
    headers: {
      "Content-Type":
        codec === "raw"
          ? "video/mp2t"
          : codec === "audio"
            ? "audio/mp4"
            : "video/mp4",
      "Cache-Control": "no-store",
      ...(codec === "raw"
        ? {}
        : { [CODEC_HEADER]: codec, [RUNG_HEADER]: String(rung) }),
    },
  });
}
