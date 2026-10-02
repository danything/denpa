import { json } from '@sveltejs/kit';
import { and, desc, isNotNull, ne, or } from 'drizzle-orm';
import { orm } from '#lib/server/db.js';
import { encodedCodec } from '#lib/server/library.js';
import { recordings } from '#lib/server/schema.js';
import { displayTitle } from '#lib/server/title.js';

/**
 * **観られる録画の一覧** (画面の外のもの向けの口。docs/api.md)。新しい順。
 *
 * `files` は出せるものを全部、コーデック付きで並べる。どれを開くかは呼ぶ側が決める
 * (Cast なら H.264、新しいテレビなら AV1、録画ソフトなら生TS)。URL は denpa の根からの相対。
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
            library: recordings.library_path,
            alt: recordings.alt_path,
            ts: recordings.ts_path,
        })
        .from(recordings)
        .where(
            and(
                isNotNull(recordings.finished_at),
                ne(recordings.state, 'deleted'),
                or(isNotNull(recordings.library_path), isNotNull(recordings.ts_path)),
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
                poster: `api/recordings/${row.id}/poster`,
                files,
                audio: `api/recordings/${row.id}/file?audio=only`,
            };
        }),
    );
}
