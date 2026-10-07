import { json } from '@sveltejs/kit';
import { and, desc, eq, isNotNull, ne, or } from 'drizzle-orm';
import { audioTracks, parseAudios } from '#lib/arib.js';
import { logoUnusable } from '#lib/format.js';
import { orm } from '#lib/server/db.js';
import { encodedCodec } from '#lib/server/library.js';
import { recordings } from '#lib/server/schema.js';
import { displayTitle } from '#lib/server/title.js';

/**
 * **観られる録画の一覧** (画面の外のもの向けの口。docs/api.md)。新しい順。
 *
 * **録画中のものも入れる** (`recording: true`)。画面の一覧と同じく、焼く前・録っている最中は
 * 生TSを追っかけ再生で観る (`chase` の口。`GET api/recordings/<id>/chase`)。
 * `cmReliable` は CM 飛ばしを観はじめに入れてよいか (画面の `skipCmAtStart` と同じ決め方。
 * ロゴでの判定に失敗した録画は無音だけで当てていて外れやすいので、false)。
 *
 * `files` は出せるものを全部、コーデック付きで並べる。どれを開くかは呼ぶ側が決める
 * (Cast なら H.264、新しいテレビなら AV1、録画ソフトなら生TS)。URL は denpa の根からの相対。
 * `audios` は放送の音声の構成で、追っかけ (`chase?audio=<id>`) で選ぶもの。
 * `?limit=` と `?offset=` で区切れる (既定は全部)
 */
export function GET({ url }) {
    const limit = Number(url.searchParams.get('limit') ?? NaN);
    const offset = Number(url.searchParams.get('offset') ?? 0);
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
            watchedAt: recordings.watched_at,
            library: recordings.library_path,
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
                ne(recordings.state, 'deleted'),
                // 録り終えたもの (焼いたか生TSがある) と、いま録っていて生TSが伸びているもの
                or(
                    and(
                        isNotNull(recordings.finished_at),
                        or(isNotNull(recordings.library_path), isNotNull(recordings.ts_path)),
                    ),
                    and(eq(recordings.state, 'recording'), isNotNull(recordings.ts_path)),
                ),
            ),
        )
        .orderBy(desc(recordings.start_at))
        .limit(Number.isInteger(limit) && limit > 0 ? limit : -1)
        .offset(Number.isInteger(offset) && offset > 0 ? offset : 0);

    return json(
        query.all().map((row) => {
            const file = (source: string) => `api/recordings/${row.id}/file?source=${source}`;
            const files = [
                ...(row.library === null
                    ? []
                    : [{ source: 'encoded', codec: encodedCodec(row.library), url: file('encoded') }]),
                ...(row.alt === null
                    ? []
                    : [{ source: 'alt', codec: encodedCodec(row.alt), url: file('alt') }]),
                ...(row.ts === null ? [] : [{ source: 'ts', codec: 'mpeg2', url: file('ts') }]),
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
                // 続きから観る位置 (画面と同じ。`POST api/recordings/<id>/resume` で書く)。観終えた・未視聴なら null
                resumeMs: row.resumeMs,
                // 末尾まで観た時刻 (ms)。まだなら null。null かつ resumeMs も null なら未視聴 (画面の印と同じ)
                watchedAt: row.watchedAt,
                recording: row.state === 'recording',
                // 生TSがある間 (録画中・焼く前) は追っかけで観られる
                chase: row.ts === null ? null : `api/recordings/${row.id}/chase`,
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
