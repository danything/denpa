import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { orm } from '$lib/server/db';
import { CURRENT_SERVICES, SERVICE_ORDER, SERVICE_TYPE_ORDER } from '$lib/server/epg';
import { services } from '$lib/server/schema';

/**
 * **局の一覧** (画面の外のもの向けの口。docs/api.md)。並びはテレビと同じ
 * (種別 → リモコン番号 → サービスID)。ライブは `live` の URL をそのまま開けばよい
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
    return json(
        rows.map((row) => ({
            id: row.id,
            type: row.type,
            name: row.name,
            remoteControlKey: row.remoteControlKey,
            logo: row.hasLogo ? `api/services/${row.id}/logo` : null,
            live: `api/services/${row.id}/live`,
        })),
    );
}
