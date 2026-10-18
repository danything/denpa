import { json } from '@sveltejs/kit';
import { searchPrograms, searchRecordings, searchReservations, searchRules } from '#lib/server/search.js';

/** 節ごとに返す数の既定と上限。打つそばから出すぶんなので少しでよい */
const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 10;

/**
 * **打つそばから出す検索** (ヘッダーの欄の候補。`SearchField`)。結果の画面 (`/search?q=`) と同じ読み方で、
 * 節ごとに先頭の数件と、その先にもあるか (`more`) だけを返す。件数は数えない (`count(*)` も読まない)。
 *
 * 行は候補に出すぶんだけの形にする (詳細や操作は結果の画面で)。録画の観る先・予約の追っかけ再生の先は
 * denpa の根からの相対 (`watch/12`) で返す (ほかの API と同じ)
 */
export function GET({ url }) {
    const q = (url.searchParams.get('q') ?? '').trim();
    const asked = Number(url.searchParams.get('limit'));
    const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_LIMIT) : DEFAULT_LIMIT;
    const options = { limit };

    const programs = searchPrograms(q, options);
    const recordings = searchRecordings(q, options);
    const reservations = searchReservations(q, options);
    const rules = searchRules(q, options);

    return json({
        q,
        programs: {
            more: programs.more,
            rows: programs.rows.map((p) => ({
                id: p.id,
                name: p.name,
                service_name: p.service_name,
                start_at: p.start_at,
                end_at: p.end_at,
                reservation_state: p.reservation_state,
            })),
        },
        recordings: {
            more: recordings.more,
            rows: recordings.rows.map((r) => ({
                id: r.id,
                name: r.name,
                service_name: r.service_name,
                start_at: r.start_at,
                state: r.state,
                // 観られるものだけ。録っている最中は追っかけ再生
                watch:
                    !r.has_file || r.state === 'failed'
                        ? null
                        : r.finished_at === null
                          ? `chase/${r.id}`
                          : `watch/${r.id}`,
            })),
        },
        reservations: {
            more: reservations.more,
            rows: reservations.rows.map((r) => ({
                id: r.id,
                program_id: r.program_id,
                name: r.name,
                service_name: r.service_name,
                start_at: r.start_at,
                end_at: r.end_at,
                state: r.state,
                chase: r.recording_id === null ? null : `chase/${r.recording_id}`,
            })),
        },
        rules: {
            more: rules.more,
            rows: rules.rows.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })),
        },
    });
}
