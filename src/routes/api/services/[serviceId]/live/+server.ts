import { error } from "@sveltejs/kit";

import { askedTrack } from "#lib/arib.js";
import { liveStream } from "#lib/server/live.js";
import { askedFormat, liveAudioOnly } from "#lib/server/viewing.js";
import {
  BUSY,
  CODEC_HEADER,
  NO_FORMAT,
  RUNG_HEADER,
} from "#lib/ts/playback.js";

/**
 * **ライブを HTTP で流す** (画面の外のもの向けの API。docs/api.md)。
 *
 * 画面と同じエンコード方式の fragmented MP4 を流し続ける。既定は H.264 / AAC (Cast・テレビ・
 * いちばん広く再生できる)。`?codec=av1` で AV1 / Opus、`?codec=hevc` で H.265 / AAC (ライブのエンコーダが GPU のときだけ。
 * 出せなければ H.264)、`?codec=raw` でエンコードせずに 1 局に絞っただけの、変換しない TS (MPEG-2。テレビのアプリ向け)。
 * `?codec=auto` は端末が再生できる形式 (`?playable=`) からサーバが「自動」の順で選ぶ (`viewing.askedFormat`)。選べなければ 406。
 * どれも中身の形式を `X-Denpa-Codec` で返す。
 * `?audio=only` で音声だけ (AAC の fMP4。画面の無いスピーカーへの Cast 向け。録画の API と同じ書き方)。
 * `?audio=<音声ID>` (`now.audios` の `id`。`0:sub` など) でエンコードする音声を選ぶ。知らないものは主音声、変換しないときは効かない。
 * `?rung=1〜3` で回線に合わせて画質を下げる (`#lib/rungs.ts`)。コーデックは `?playable=` (`,` 区切り) からサーバが選ぶ
 * (`live.rungCodec`)。同じ段を誰も観ていなければその場で変換する本数の枠を使い、埋まっていれば 503。
 * `?audio=only` に段を付けると、音声のビットレートだけを下げる (`viewing.liveAudioOnly`。枠は使わない)。
 * 画面の視聴者と同じチューナーの取り合いに加わり、閉じれば抜ける (live.ts の liveStream)
 */
export function GET({ params, url }) {
  const serviceId = Number(params.serviceId);
  if (!Number.isInteger(serviceId)) error(400, "局 ID が不正です");
  const asked = liveAudioOnly(url) ?? askedFormat(url, "live");
  if (asked === null) error(406, NO_FORMAT);
  const { codec, rung } = asked;
  const stream = liveStream(
    serviceId,
    codec,
    askedTrack(url.searchParams.get("audio")),
    rung,
  );
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
      [CODEC_HEADER]: codec,
      ...(codec === "raw" ? {} : { [RUNG_HEADER]: String(rung) }),
    },
  });
}
