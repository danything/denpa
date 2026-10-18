import { genreName } from './arib';
import { SERVICE_TYPE_LABEL } from './format';
import { parseSearchFields, type SearchField } from './search';

/**
 * **ルールの条件を1行で** (ルールの一覧の「条件」の列)。
 * 探す所 ・ 局 ・ ジャンル ・ 同じ回は1度 ・ 除外、の順。キーワードは名前の列に出ているので書かない
 */

const FIELD: Record<SearchField, string> = { name: '番組名', description: '概要', extended: '詳細' };

export interface Summarized {
    search_fields: string;
    service_ids: number[] | null;
    service_types: string[] | null;
    genres: string[] | null;
    dedupe: boolean;
    ignore_keyword: string;
}

/** 局の名前を引く。無ければ ID のまま */
export function conditionSummary(rule: Summarized, serviceName: (id: number) => string | undefined): string {
    const parts = [
        parseSearchFields(rule.search_fields)
            .map((field) => FIELD[field])
            .join('・'),
    ];
    const stations = [
        ...(rule.service_types ?? []).map((type) => SERVICE_TYPE_LABEL[type] ?? type),
        ...(rule.service_ids ?? []).map((id) => serviceName(id) ?? String(id)),
    ];
    parts.push(
        stations.length === 0
            ? '全局'
            : stations.length <= 2
              ? stations.join('・')
              : `${stations.slice(0, 2).join('・')} ほか ${stations.length - 2} 局`,
    );
    if (rule.genres !== null && rule.genres.length > 0) parts.push(rule.genres.map(genreName).join('・'));
    if (rule.dedupe) parts.push('同じ回は1度');
    if (rule.ignore_keyword.trim() !== '') parts.push(`除外: ${rule.ignore_keyword.trim()}`);
    return parts.join(' ・ ');
}

/**
 * 次の放送の日時。今日と明日は言葉で、それより先は月/日 (ルールの一覧の「次の放送」)。
 * 日付の切れ目は端末の時計 (画面で使う)
 */
export function upcomingLabel(at: number, now: number): string {
    const day = (ms: number) => {
        const d = new Date(ms);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    };
    const d = new Date(at);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const days = Math.round((day(at) - day(now)) / (24 * 60 * 60 * 1000));
    if (days === 0) return `今日 ${hm}`;
    if (days === 1) return `明日 ${hm}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
