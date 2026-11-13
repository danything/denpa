import { error } from "@sveltejs/kit";
import { eq } from "drizzle-orm";

import { askedTrack } from "#lib/arib.js";
import { parseId } from "#lib/id.js";
import { broadcastCodec } from "#lib/live-choice.js";
import { orm } from "#lib/server/db.js";
import { liveServed, liveStream } from "#lib/server/live.js";
import { services } from "#lib/server/schema.js";
import { TLV_TYPE } from "#lib/server/tuner.js";
import {
  askedFormat,
  liveAudioOnly,
  parseFormats,
} from "#lib/server/viewing.js";
import {
  BUSY,
  CODEC_HEADER,
  NO_FORMAT,
  RUNG_HEADER,
} from "#lib/ts/playback.js";
import { undecodableReason } from "#lib/types.js";

/**
 * **ライブを HTTP で流す** (画面の外のもの向けの API。docs/api.md)。
 *
 * 画面と同じエンコード方式の fragmented MP4 を流し続ける。既定は H.264 / AAC (Cast・テレビ・
 * いちばん広く再生できる)。`?codec=av1` で AV1 / Opus、`?codec=hevc` で H.265 / AAC (ライブのエンコーダが GPU のときだけ。
 * 出せなければ H.264)、`?codec=raw` でエンコードせずに 1 局に絞っただけの、変換しない TS (MPEG-2。テレビのアプリ向け)。
 * 4K の局 (`services.transport` が `tlv`) は、`?codec=hevc` が放送の HEVC と AAC をエンコードせずに詰め替えた fMP4 (GPU は要らない)、
 * `?codec=raw` が 1 局に絞った TLV (`application/x-arib-tlv`)。`?codec=auto` は `raw` を候補にしない (`viewing.autoFormat`)。
 * `?codec=auto` は端末が再生できる形式 (`?playable=`) からサーバが「自動」の順で選ぶ (`viewing.askedFormat`)。選べなければ 406。
 * どれも中身の形式を `X-Denpa-Codec` で返す。
 * `?audio=only` で音声だけ (AAC の fMP4。画面の無いスピーカーへの Cast 向け。録画の API と同じ書き方)。
 * `?audio=<音声ID>` (`now.audios` の `id`。`0:sub` など) でエンコードする音声を選ぶ。知らないものは主音声、変換しないときは効かない。
 * `?rung=1〜3` で回線に合わせて画質を下げる (`#lib/rungs.ts`)。コーデックは `?playable=` (`,` 区切り) からサーバが選ぶ
 * (`live.rungCodec`)。同じ段を誰も観ていなければその場で変換する本数の枠を使い、埋まっていれば 503。
 * `?audio=only` に段を付けると、音声のビットレートだけを下げる (`viewing.liveAudioOnly`。枠は使わない)。
 * 画面の視聴者と同じチューナーの取り合いに加わり、閉じれば抜ける (live.ts の liveStream)。
 * 復号できない局 (`services.decodable`。スカパー！プレミアムと、B-CAS 以外の方式でスクランブルされたケーブルの局と、ACAS でスクランブルされたケーブルの 4K の局) は 409 で断る
 */
export async function GET({ params, url }) {
  const serviceId = parseId(params.serviceId);
  if (serviceId === null) error(400, "局 ID が不正です");
  // 復号できない局は選局せずに断る。流してもスクランブルされたままで映らない
  const row = orm()
    .select({
      type: services.type,
      transport: services.transport,
      decodable: services.decodable,
    })
    .from(services)
    .where(eq(services.id, serviceId))
    .get();
  if (row !== undefined && !row.decodable)
    error(409, undecodableReason(row.type, row.transport));
  const transport = row?.transport ?? "ts";
  const asked =
    liveAudioOnly(url) ??
    askedFormat(url, "live", {}, broadcastCodec(transport));
  if (asked === null) error(406, NO_FORMAT);
  const { codec, rung } = asked;
  // 再生できると言った形式。TS で送る 4K の局の放送のままを、HEVC の詰め替えにするかエンコードするかに使う (`live.servedFormat`)
  const playable = url.searchParams.has("playable")
    ? parseFormats(url.searchParams.get("playable"))
    : null;
  const stream = liveStream(
    serviceId,
    codec,
    askedTrack(url.searchParams.get("audio")),
    rung,
    playable,
  );
  if (stream === null) error(404, "局がありません");
  if (stream === "busy") error(503, BUSY);
  // 実際に流す形式。TS で送る 4K の局の放送のままは、PMT を読んでから替わる (`live.liveServed`)
  const served = await liveServed(stream);
  const format = served === null ? codec : served.raw ? "raw" : served.codec;
  return new Response(stream, {
    headers: {
      "Content-Type":
        format === "raw"
          ? transport === "tlv"
            ? TLV_TYPE
            : "video/mp2t"
          : format === "audio"
            ? "audio/mp4"
            : "video/mp4",
      "Cache-Control": "no-store",
      [CODEC_HEADER]: format,
      ...(format === "raw" ? {} : { [RUNG_HEADER]: String(rung) }),
    },
  });
}
