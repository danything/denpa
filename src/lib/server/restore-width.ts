/**
 * **録画の番組名・概要を放送のとおりの幅に戻す。** 番組名を半角に寄せて取り込んでいた頃の録画の後始末。
 *
 * 番組表はいま放送のとおり持つ (「Ｖｅｎｕｅ１０１」。`ts/aribtext.ts`) が、それより前は
 * 取り込むときに半角へ寄せていた (「Venue101」)。録画は録り始めたときの番組表を写すので、
 * 寄せた字のまま残っている。**生TSが残っていれば、そこに流れていた EIT を読み直せば元の字が分かる。**
 * 生TSしか元は無い — 番組表の行は放送が終われば取り込み直されず (24時間で消える)、録画の横に置く
 * データ放送の控えも、寄せたあとの DB から書いたもの。生TSが消えた録画は寄せたまま残す。
 *
 * - **字は変えず、幅だけ戻す。** 読み直した字を半角に寄せて今の値と同じときだけ書く (外字の書き方の
 *   違い「[新]」と「🈟」も揃えて比べ、放送の字にする)。録ったあとに番組表が書き換わっていた
 *   (副題が入った等) なら、その欄は触らない
 * - 作品名・副題は戻した番組名から同じ所を切り出す (`widthOf`)。切り出し方を変える前に録ったものも、
 *   字は今の値のまま
 * - **保存先の名前 (`library_path`) と生TSの置き場は動かさない。** どちらも半角に寄せた名前で、
 *   名前を作る `sanitizeFileName` も半角に寄せるので、戻したあとも食い違わない
 * - 局名は局のほうを直すときに一緒に直る (`epg.widenServices`)
 * - **見た録画は覚えておく** (`settings` の `widthRestoredThrough` = 録画ID)。戻せなかったものも
 *   二度は読まない。番組表が取り込み直されるまでの間 (チャンネルごとに最大6時間) に録り始めたものも
 *   寄せた字を写すので、起動時だけでなく定期的に回して拾う。もう全角が入っている録画は読まずに済ませる
 */
import { open } from 'node:fs/promises';
import { asc, eq, gt } from 'drizzle-orm';
import { foldForSearch, toHalfWidth } from '../fold';
import { type EitEvent, EpgReader } from '../ts/eit';
import { now, orm } from './db';
import { emit } from './events';
import { recordings, services, settings } from './schema';

/** 済んだ録画ID を覚えておく鍵 */
const MARK = 'widthRestoredThrough';

/**
 * 生TSの頭から読む上限。EIT の現在/次 (p/f) は数秒おきに流れるので、頭の数十秒で足りる。
 * BS の 1秒はおよそ 3MB
 */
const READ_LIMIT = 96 * 1024 * 1024;
const CHUNK = 1024 * 1024;

/** 録画が持っている、幅を戻す欄 */
export interface StoredText {
    name: string;
    series: string;
    subtitle: string;
    description: string;
    extended: Record<string, string> | null;
}

/** 放送 (か番組表) から読み直したもの */
export interface BroadcastText {
    name: string;
    description: string;
    extended: Record<string, string> | null;
}

/**
 * 比べる形。幅と、外字の書き方だけを揃える — 外字を文字列に開いていた頃 (「[新]」) に録ったものは、
 * 放送を読み直すと規格の字 (「🈟」) で返ってくる (`fold.ts`)
 */
function same(text: string): string {
    return foldForSearch(toHalfWidth(text));
}

/** 寄せて同じなら元の字 (`original`)。違えば null */
function sameButWidth(stored: string, original: string): string | null {
    return same(stored) === same(original) ? original : null;
}

/**
 * `stored` を `original` から同じ所を切り出して戻す。`toHalfWidth` は1文字を1文字に写すので、
 * 寄せた写しで見つけた位置で元を切れる。見つからなければ null
 */
export function widthOf(stored: string, original: string): string | null {
    if (stored === '') return null;
    const at = toHalfWidth(original).indexOf(toHalfWidth(stored));
    return at < 0 ? null : original.slice(at, at + stored.length);
}

/** 詳細。見出しも本文も、全部が寄せて同じときだけ読み直したほうにする */
function extendedWidth(
    stored: Record<string, string> | null,
    original: Record<string, string> | null,
): Record<string, string> | null {
    if (stored === null || original === null) return null;
    const entries = Object.entries(stored);
    const fresh = Object.entries(original);
    if (entries.length !== fresh.length) return null;
    const byKey = new Map(fresh.map(([heading, body]) => [same(heading), [heading, body] as const]));
    const out: Record<string, string> = {};
    for (const [heading, body] of entries) {
        const found = byKey.get(same(heading));
        if (found === undefined || same(found[1]) !== same(body)) return null;
        out[found[0]] = found[1];
    }
    return out;
}

/**
 * 戻す欄だけを返す。変わるものが無ければ null。
 * 作品名・副題は戻した番組名から切り出すので、番組名が戻せないときは触らない
 */
export function restoredText(stored: StoredText, original: BroadcastText): Partial<StoredText> | null {
    const patch: Partial<StoredText> = {};
    const name = sameButWidth(stored.name, original.name);
    if (name !== null && name !== stored.name) {
        patch.name = name;
        const series = widthOf(stored.series, name);
        if (series !== null && series !== stored.series) patch.series = series;
        const subtitle = widthOf(stored.subtitle, name);
        if (subtitle !== null && subtitle !== stored.subtitle) patch.subtitle = subtitle;
    }
    const description = sameButWidth(stored.description, original.description);
    if (description !== null && description !== stored.description) patch.description = description;
    const extended = extendedWidth(stored.extended, original.extended);
    if (extended !== null && JSON.stringify(extended) !== JSON.stringify(stored.extended)) {
        patch.extended = extended;
    }
    return Object.keys(patch).length === 0 ? null : patch;
}

/**
 * もう放送のとおりの幅で入っているか (題名か概要に全角の英数・記号・空白が1字でもある)。
 * 寄せていたのは題名と概要だけなので、詳細は見ない (漢字の集合の全角はもとから残っている)
 */
function alreadyWide(stored: StoredText): boolean {
    return [stored.name, stored.description].some((text) => toHalfWidth(text) !== text);
}

/**
 * 生TSに流れていた EIT から、その番組の題名・概要・詳細を読む。読めなければ null。
 *
 * 録画は番組の少し前から回すので、頭では「次」として来ていることが多い。どちらでも event_id で拾う
 */
export async function readBroadcastText(
    path: string,
    serviceId: number,
    eventId: number,
    wantExtended: boolean,
): Promise<BroadcastText | null> {
    let file: Awaited<ReturnType<typeof open>>;
    try {
        file = await open(path, 'r');
    } catch {
        return null;
    }
    const epg = new EpgReader();
    let event: EitEvent | null = null;
    try {
        const buffer = Buffer.alloc(CHUNK);
        for (let offset = 0; offset < READ_LIMIT; ) {
            const { bytesRead } = await file.read(buffer, 0, CHUNK, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
            epg.feed(buffer.subarray(0, bytesRead));
            for (const changed of epg.takeChanged()) {
                if (changed.serviceId === serviceId && changed.eventId === eventId) event = changed;
            }
            if (
                event !== null &&
                event.name !== '' &&
                (!wantExtended || Object.keys(event.extended).length > 0)
            ) {
                break;
            }
        }
    } finally {
        await file.close();
    }
    if (event === null || event.name === '') return null;
    return {
        name: event.name,
        description: event.description,
        extended: Object.keys(event.extended).length === 0 ? null : event.extended,
    };
}

function mark(): number {
    const row = orm().select({ value: settings.value }).from(settings).where(eq(settings.key, MARK)).get();
    return row === undefined ? 0 : Number(row.value) || 0;
}

function saveMark(id: number): void {
    orm()
        .insert(settings)
        .values({ key: MARK, value: String(id), updated_at: now() })
        .onConflictDoUpdate({ target: settings.key, set: { value: String(id), updated_at: now() } })
        .run();
}

/** 1回ぶんの結果。ログに出す */
export interface RestoreResult {
    /** 見た録画 */
    seen: number;
    /** 生TSから戻した */
    restored: number;
    /** もう放送のとおりだった (取り込み直された番組表から録ったもの) */
    already: number;
    /** 生TSが無い・EIT が読めない・字が違っていた */
    missed: number;
}

/** 走っているか。生TSを読むので数分かかることがあり、次の周期と重ねない */
let running = false;

/**
 * まだ見ていない録画 (ID が覚えた所より後ろ) を見て回る。**録画中のものの手前で止める** —
 * 生TSが書き終わってから次の回で見る。前の回が走っていれば何もしない
 */
export async function restoreWidths(): Promise<RestoreResult> {
    if (running) return { seen: 0, restored: 0, already: 0, missed: 0 };
    running = true;
    try {
        return await walk();
    } finally {
        running = false;
    }
}

async function walk(): Promise<RestoreResult> {
    const result: RestoreResult = { seen: 0, restored: 0, already: 0, missed: 0 };
    const rows = orm()
        .select({
            id: recordings.id,
            program_id: recordings.program_id,
            service_id: recordings.service_id,
            name: recordings.name,
            series: recordings.series,
            subtitle: recordings.subtitle,
            description: recordings.description,
            extended: recordings.extended,
            ts_path: recordings.ts_path,
            finished_at: recordings.finished_at,
        })
        .from(recordings)
        .where(gt(recordings.id, mark()))
        .orderBy(asc(recordings.id))
        .all();

    for (const row of rows) {
        if (row.finished_at === null) break;
        result.seen++;
        if (alreadyWide(row)) result.already++;
        else if (await restoreOne(row)) result.restored++;
        else result.missed++;
        saveMark(row.id);
    }

    if (result.restored > 0) emit('recordings');
    return result;
}

/** 1本戻す。戻せたら true */
async function restoreOne(
    row: StoredText & { id: number; program_id: number | null; service_id: number; ts_path: string | null },
): Promise<boolean> {
    // 取り込んだ録画 (負の番組ID) は放送から録っていない
    if (row.ts_path === null || row.program_id === null || row.program_id < 0) return false;
    const service = orm()
        .select({ service_id: services.service_id })
        .from(services)
        .where(eq(services.id, row.service_id))
        .get();
    // 局の行が無くても、局の内部ID の下5桁が ARIB のサービスID (`tuner.serviceKey`)
    const serviceId = service?.service_id ?? row.service_id % 100000;
    const read = await readBroadcastText(
        row.ts_path,
        serviceId,
        row.program_id % 100000,
        row.extended !== null,
    );
    const patch = read === null ? null : restoredText(row, read);
    if (patch === null) return false;
    orm()
        .update(recordings)
        .set({ ...patch, updated_at: now() })
        .where(eq(recordings.id, row.id))
        .run();
    return true;
}
