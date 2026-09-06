import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { orm } from '$lib/server/db';
import { programs, services } from '$lib/server/schema';
import type { ProgramDetail } from '$lib/types';

/**
 * 番組の詳細。予約一覧・録画一覧の行から開くときに使う。
 *
 * 一覧に最初から詰めて返すと、出演者やあらすじが 300 件ぶん載って重くなる。
 * 開いた1件だけ取りに来てもらう。
 *
 * EPG は古い番組を消していくので、録画からは引けないことがある。
 * その場合は 404 を返し、画面は録画が持っている分だけを出す。
 */
export function GET({ params }) {
    const id = Number(params.id);
    if (!Number.isFinite(id)) error(400, '番組IDが不正です');

    const program: ProgramDetail | undefined = orm()
        .select({
            name: programs.name,
            description: programs.description,
            extended: programs.extended,
            genre_detail: programs.genre_detail,
            audios: programs.audios,
            video_type: programs.video_type,
            video_resolution: programs.video_resolution,
            is_free: programs.is_free,
            start_at: programs.start_at,
            end_at: programs.end_at,
            service_name: services.name,
        })
        .from(programs)
        .innerJoin(services, eq(services.id, programs.service_id))
        .where(eq(programs.id, id))
        .get();
    if (program === undefined) error(404, '番組が見つかりません');

    return json(program);
}
