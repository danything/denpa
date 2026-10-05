import { json } from '@sveltejs/kit';
import { and, gt, inArray, lte, sql } from 'drizzle-orm';
import { audioTracks, parseAudios } from '#lib/arib.js';
import { orm } from '#lib/server/db.js';
import { CURRENT_SERVICES, SERVICE_ORDER, SERVICE_TYPE_ORDER } from '#lib/server/epg.js';
import { programs, services } from '#lib/server/schema.js';

/**
 * **局の一覧** (画面の外のもの向けの口。docs/api.md)。並びはテレビと同じ
 * (種別 → リモコン番号 → サービスID)。ライブは `live` の URL をそのまま開けばよい。
 * `now` はいま放送中の番組 (番組表に無ければ null)。テレビのアプリがライブの列に出す。
 * `now.audios` はその番組で選べる音声 (画面のライブと同じ一覧。`live?audio=<id>` で選ぶ)
 */
export function GET() {
    const rows = orm()
        .select({
            id: services.id,
            type: services.type,
            name: services.name,
            remoteControlKey: services.remote_control_key,
            hasLogo: services.has_logo,
        })
        .from(services)
        .where(sql.raw(CURRENT_SERVICES))
        .orderBy(sql.raw(SERVICE_TYPE_ORDER), sql.raw(SERVICE_ORDER))
        .all();
    const at = Date.now();
    const airing = new Map(
        orm()
            .select({
                serviceId: programs.service_id,
                name: programs.name,
                startAt: programs.start_at,
                endAt: programs.end_at,
                audio_type: programs.audio_type,
                audios: programs.audios,
            })
            .from(programs)
            .where(
                and(
                    inArray(
                        programs.service_id,
                        rows.map((row) => row.id),
                    ),
                    lte(programs.start_at, at),
                    gt(programs.end_at, at),
                ),
            )
            .all()
            .map((p) => [
                p.serviceId,
                { title: p.name, startAt: p.startAt, endAt: p.endAt, audios: audioTracks(parseAudios(p)) },
            ]),
    );
    return json(
        rows.map((row) => ({
            id: row.id,
            type: row.type,
            name: row.name,
            remoteControlKey: row.remoteControlKey,
            logo: row.hasLogo ? `api/services/${row.id}/logo` : null,
            live: `api/services/${row.id}/live`,
            now: airing.get(row.id) ?? null,
        })),
    );
}
