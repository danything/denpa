import { json } from "@sveltejs/kit";
import { and, desc, eq, isNotNull, ne, or } from "drizzle-orm";

import { audioTracks, parseAudios } from "#lib/arib.js";
import { encodedCodec } from "#lib/encoded-codec.js";
import { logoUnusable } from "#lib/format.js";
import { orm } from "#lib/server/db.js";
import { encodedFiles } from "#lib/server/library.js";
import { rulerOf } from "#lib/server/playback.js";
import { recordings } from "#lib/server/schema.js";
import { displayTitle } from "#lib/server/title.js";
import { recordedTransport, tsPathOf } from "#lib/source.js";
import { fromTsTime } from "#lib/ts/watch.js";

/**
 * **観られる録画の一覧** (画面の外のもの向けの API。docs/api.md)。新しい順。
 *
 * **録画中のものも入れる** (`recording: true`)。画面の一覧と同じく、エンコードする前・録っている最中は
 * 元の TS を追っかけ再生で観る (`chase` のエンドポイント。`GET api/recordings/<id>/chase`)。
 * `cmReliable` は CM 飛ばしを観はじめに入れてよいか (画面の `skipCmAtStart` と同じ決め方。
 * ロゴでの判定に失敗した録画は無音だけで当てていて外れやすいので、false)。
 *
 * `files` は出せるものを全部、コーデック付きで並べる。どれを開くかは呼ぶ側が決める
 * (AV1 → H.265 → H.264 の順でデコードできる最初のもの、MPEG-2 をハードでデコードできる端末なら元の TS)。
 * 並びは主 → H.265 → H.264 → 元の TS で、エンコード済みは小さくなる順 (`ENCODED_ORDER`) と同じ。URL は denpa のルートからの相対。
 * `audios` は放送の音声の構成で、追っかけ (`chase?audio=<id>`) で選ぶもの。
 * `?limit=` と `?offset=` で区切れる (既定は全部)
 */
export function GET({ url }) {
  const limit = Number(url.searchParams.get("limit") ?? NaN);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const query = orm()
    .select({
      id: recordings.id,
      name: recordings.name,
      serviceId: recordings.service_id,
      serviceName: recordings.service_name,
      startAt: recordings.start_at,
      endAt: recordings.end_at,
      durationMs: recordings.duration_ms,
      resumeMs: recordings.resume_ms,
      cmKept: recordings.cm_kept,
      encodeSkip: recordings.encode_skip,
      watchedAt: recordings.watched_at,
      library: recordings.library_path,
      hevc: recordings.hevc_path,
      alt: recordings.alt_path,
      ts: recordings.ts_path,
      state: recordings.state,
      cmNote: recordings.cm_note,
      audio_type: recordings.audio_type,
      audios: recordings.audios,
    })
    .from(recordings)
    .where(
      and(
        ne(recordings.state, "deleted"),
        // 録り終えたもの (エンコードしたか元の TS がある) と、いま録っていて元の TS が伸びているもの
        or(
          and(
            isNotNull(recordings.finished_at),
            or(
              isNotNull(recordings.library_path),
              isNotNull(recordings.ts_path),
            ),
          ),
          and(eq(recordings.state, "recording"), isNotNull(recordings.ts_path)),
        ),
      ),
    )
    .orderBy(desc(recordings.start_at))
    .limit(Number.isInteger(limit) && limit > 0 ? limit : -1)
    .offset(Number.isInteger(offset) && offset > 0 ? offset : 0);

  return json(
    query.all().map((row) => {
      const file = (source: string) =>
        `api/recordings/${row.id}/file?source=${source}`;
      // エンコード済み (Matroska) は置き場に在るものだけ出す (`encodedFiles`。観る画面と同じ判定)。
      // 続きの位置の物差しも同じ結果で決める (行ごとに stat し直さない)
      const encoded = encodedFiles({
        library_path: row.library,
        hevc_path: row.hevc,
        alt_path: row.alt,
      });
      /*
       * 元の TS は、エンコードしない録画なら置き場の TS (`tsPathOf`)。4K の局の元の録画 (`.mmts`。TLV) は
       * アプリがそのまま読めないので並べない。観るのは `playback` の `auto` から
       */
      const ts = tsPathOf({ ts_path: row.ts, library_path: row.library });
      const files = [
        ...encoded.map(({ source, path }) => ({
          source,
          codec: encodedCodec(path),
          url: file(source),
        })),
        ...(ts === null || recordedTransport(ts) === "tlv"
          ? []
          : [{ source: "ts" as const, codec: "mpeg2", url: file("ts") }]),
      ];
      return {
        id: row.id,
        title: displayTitle(row.name),
        name: row.name,
        serviceId: row.serviceId,
        serviceName: row.serviceName,
        startAt: row.startAt,
        endAt: row.endAt,
        durationMs: row.durationMs,
        // 続きから観る位置 (画面と同じ。`POST api/recordings/<id>/resume` で書く)。観終えた・未視聴なら null。
        // 覚えているのは元の TS の物差しなので、観る画面と同じ物差し (エンコードしたものがあればそれ) に直す
        resumeMs:
          row.resumeMs === null
            ? null
            : Math.round(
                fromTsTime(
                  row.resumeMs / 1000,
                  rulerOf(
                    {
                      library_path: row.library,
                      hevc_path: row.hevc,
                      alt_path: row.alt,
                      cm_kept: row.cmKept,
                      encode_skip: row.encodeSkip,
                    },
                    encoded[0]?.source ?? "ts",
                  ),
                ) * 1000,
              ),
        // 末尾まで観た時刻 (ms)。まだなら null。null かつ resumeMs も null なら未視聴 (画面の印と同じ)
        watchedAt: row.watchedAt,
        recording: row.state === "recording",
        // 元の TS がある間 (録画中・エンコードする前・「エンコードしない」録画) は追っかけで観られる
        chase: ts === null ? null : `api/recordings/${row.id}/chase`,
        cmReliable: !logoUnusable(row.cmNote),
        poster: `api/recordings/${row.id}/poster`,
        files,
        audio: `api/recordings/${row.id}/file?audio=only`,
        // 放送の音声の構成 (画面の追っかけと同じ一覧)。`chase?audio=<id>` で選ぶ
        audios: audioTracks(parseAudios(row)),
      };
    }),
  );
}
