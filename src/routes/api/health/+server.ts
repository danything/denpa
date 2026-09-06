import { json } from '@sveltejs/kit';
import { count } from 'drizzle-orm';
import { config } from '$lib/server/config';
import { orm } from '$lib/server/db';
import { activeRecordingIds } from '$lib/server/recorder';
import { services } from '$lib/server/schema';
import { updateAvailable } from '$lib/server/update';

/**
 * compose の healthcheck と E2E の起動待ちに使う。DBまで触って初めて ok を返す。
 *
 * 録画の本数も返す。入れ替えていいかどうかを外から見たいことがあるため
 * (待つこと自体はアプリ側でやっている。runtime.ts の drain)。
 * 動いているコミットも返す (`DENPA_COMMIT`。手元では `dev`) — 何が動いているかを外から確かめるため
 */
export function GET() {
    const row = orm().select({ n: count() }).from(services).get();
    return json({
        ok: true,
        commit: config.commit,
        // 新しい版が出ていれば、その札と場所 (update.ts)。無ければ null
        update: updateAvailable(),
        services: row?.n ?? 0,
        recording: activeRecordingIds().length,
    });
}
