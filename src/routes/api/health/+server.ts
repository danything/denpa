import { json } from '@sveltejs/kit';
import { count } from 'drizzle-orm';
import { orm } from '$lib/server/db';
import { activeRecordingIds } from '$lib/server/recorder';
import { services } from '$lib/server/schema';

/**
 * compose の healthcheck と E2E の起動待ちに使う。DBまで触って初めて ok を返す。
 *
 * 録画の本数も返す。入れ替えていいかどうかを外から見たいことがあるため
 * (待つこと自体はアプリ側でやっている。runtime.ts の drain)。
 */
export function GET() {
    const row = orm().select({ n: count() }).from(services).get();
    return json({ ok: true, services: row?.n ?? 0, recording: activeRecordingIds().length });
}
