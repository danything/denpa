import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
} from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { and, eq, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { joinBytes } from '../ts/bytes';
import { coherence, decodeModel } from '../ts/logo-detect';
import { pngChunk } from '../ts/logo-palette';
import { config } from './config';
import { orm } from './db';
import { CURRENT_SERVICES } from './epg';
import { services } from './schema';

/**
 * CM検出のために覚えた局ロゴ (`own-logo-<幅>x<高さ>.bin`。`logo-own.ts`) の置き場と、その中身。
 *
 * **これは放送波から拾う局ロゴ (PNG) とは別物。** あちら (`server/logo.ts`) は番組表に
 * 出すための絵で、こちらは「画面のどこにロゴが出ているか」を録画から覚えたもの。
 */

/**
 * 覚えたロゴの置き場。**局ごとに分ける。** 「この絵は違う」で丸ごと捨てられるように
 */
export function logoRepo(serviceId: number): string {
    return join(config.cmLogoDir, String(serviceId));
}

/** 覚えたもののファイル名 (`logo-own.modelFile`)。コマの大きさごとに1つ */
const MODEL = /^own-logo-\d+x\d+\.bin$/;

/** その局の覚えたもの。読めなければ空 (置き場がまだ無い = 1本も焼いていない) */
function models(serviceId: number): string[] {
    try {
        return readdirSync(logoRepo(serviceId)).filter((name) => MODEL.test(name));
    } catch {
        return [];
    }
}

/**
 * その局の覚えたロゴを捨てる。次にその局の録画を焼くときに一から覚える
 */
export function forgetLogoData(serviceId: number): void {
    rmSync(logoRepo(serviceId), { recursive: true, force: true });
}

export interface LearnedLogo {
    /** 覚えている枠。**記録されているコマの座標** (地上波のHDなら 1440×1080 の中) */
    x: number;
    y: number;
    width: number;
    height: number;
    /**
     * 線の向きの揃い方を明るさにした白黒の PNG (縁が白)。原寸なので、出すときは拡大する。
     *
     * **いちばん揃うところが白になるように伸ばしてある。** ロゴの縁の揃い方は
     * 「ロゴが出ていたコマの割合」(実機で 0.5〜0.6) までしか上がらないので、
     * 1 を白にすると灰色にしかならない。知りたいのは形のほう
     */
    png: Uint8Array;
    /**
     * いつ書いたか (ファイルの更新時刻)。当てるたびに育てて書き直すので、最後に当てた時刻に近い。
     *
     * **これが無いと画面が嘘に見える。** 詳細に出ているロゴは*いまの*もので、
     * 隣に出ている「CM判定に失敗」は*そのとき*の記録
     */
    learnedAt: number;
}

/**
 * いちばん最後に書いたもの。コマの大きさが違うもの (SD と HD) を両方持っていれば、
 * 最後に焼いた録画のほう
 */
function newest(serviceId: number): { path: string; at: number } | null {
    const dir = logoRepo(serviceId);
    let found: { path: string; at: number } | null = null;
    for (const name of models(serviceId)) {
        const path = join(dir, name);
        try {
            const at = statSync(path).mtimeMs;
            if (found === null || at > found.at) found = { path, at };
        } catch {
            // 消えた。他のものを見る
        }
    }
    return found;
}

/** 覚えたものを最後に書いた時刻。覚えていなければ `null` */
export function learnedAt(serviceId: number): number | null {
    return newest(serviceId)?.at ?? null;
}

/** いま覚えているロゴを絵にする (`newest`) */
export function readLearnedLogo(serviceId: number): LearnedLogo | null {
    const latest = newest(serviceId);
    if (latest === null) return null;

    let bytes: Uint8Array;
    try {
        bytes = readFileSync(latest.path);
    } catch {
        return null;
    }
    const model = decodeModel(bytes);
    if (model === null) return null;

    const { width, height } = model.orientation;
    const r = coherence(model.orientation);
    let top = 0;
    for (const value of r) top = Math.max(top, value);
    const gray = new Uint8Array(width * height);
    if (top > 0) for (const [i, value] of r.entries()) gray[i] = Math.round((value / top) * 255);

    return { ...model.rect, learnedAt: latest.at, png: encodeGray(gray, width, height) };
}

/** 8bit グレースケールの PNG。出すのは1枚だけなので、素直に組む */
function encodeGray(gray: Uint8Array, width: number, height: number): Uint8Array {
    const raw = new Uint8Array(height * (1 + width));
    for (let row = 0; row < height; row++) {
        // 各行の頭にフィルタの種類 (0 = なし)
        raw.set(gray.subarray(row * width, (row + 1) * width), row * (1 + width) + 1);
    }
    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    ihdr[8] = 8; // ビット深度
    ihdr[9] = 0; // 白黒
    const parts = [
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
        pngChunk('IEND', new Uint8Array(0)),
    ];
    return joinBytes(parts);
}

/** その局のロゴを覚えているか。**中身が1つでもあれば覚えている** */
export function learned(serviceId: number): boolean {
    return models(serviceId).length > 0;
}

/**
 * 同じ絵を映している局を1つにまとめる。**局名で束ねる。**
 *
 * 放送局はサブチャンネルの枠を常時流していて、マルチ編成をしていない間は
 * 本チャンネルと同じ絵が出ている。SDT の局名も同じなので、実機では
 *
 * ```
 * TOKYO MX1   23608 / 23609          フジテレビ   1056 / 1057 / 1058
 * テレビ朝日  1064 / 1065 / 1066     BS-TBS       161 / 162 / 163
 * ```
 *
 * のように並んでいた。**同じ絵なのでロゴは1つ覚えれば足りる。** 束ねずに
 * 並べていた頃は、画面に「TOKYO MX1」が2つ並んでいた。
 *
 * 代表は**もう覚えている局を優先**する。無ければ先頭 (呼ぶ側の並び順)。
 *
 * ネットワークもそろえて見る。局名だけで束ねると、たまたま同名の別系列を
 * 1つにしてしまう
 */
export function stations<T extends { id: number; network_id: number; name: string }>(rows: T[]): T[] {
    const groups = new Map<string, T>();
    for (const row of rows) {
        const key = `${row.network_id}:${row.name}`;
        const chosen = groups.get(key);
        if (chosen === undefined || (!learned(chosen.id) && learned(row.id))) groups.set(key, row);
    }
    return [...groups.values()];
}

/** 同じ絵を映している他の局。覚えたロゴを分け合うのに使う */
export function siblings(serviceId: number): number[] {
    const me = alias(services, 'me');
    const other = alias(services, 'other');
    return orm()
        .select({ id: other.id })
        .from(me)
        .innerJoin(other, and(eq(other.network_id, me.network_id), eq(other.name, me.name)))
        .where(and(eq(me.id, serviceId), ne(other.id, serviceId)))
        .all()
        .map((row) => row.id);
}

/**
 * 覚えたロゴを、同じ絵を映している局にも配る (`copyModel`)。
 *
 * 束ねて1局ぶんしか画面に出さないので (`stations`)、そのままだとサブチャンネルの枠で
 * 録れた番組が一から覚え直すことになる。中身は同じなので写せば足りる。
 */
export function share(serviceId: number, file: string, replace: boolean): void {
    copyModel(logoRepo(serviceId), siblings(serviceId).map(logoRepo), file, replace);
}

/**
 * 覚えたもの1つ (`file`) を、他の局の入れ物へ写す。
 *
 * **向こうが同じ大きさのものを持っていれば、ふだんは写さない** (自分で育てたほうが確か)。
 * 覚え直した (`replace`。局がロゴを替えた) ときだけは上書きする — 同じ絵なので向こうの型も
 * 古く、残すと向こうは古い型で当てて外すか、覚え直しに1本ぶん余計にかかる。
 * 書きかけを読まれないよう、隣に写してから差し替える (`logo-own.save` と同じ)
 */
export function copyModel(from: string, to: string[], file: string, replace: boolean): void {
    for (const dir of to) {
        if (!replace && existsSync(join(dir, file))) continue;
        const temp = join(dir, `${file}.${process.pid}-share.tmp`);
        try {
            mkdirSync(dir, { recursive: true });
            copyFileSync(join(from, file), temp);
            renameSync(temp, join(dir, file));
        } catch (error) {
            rmSync(temp, { force: true });
            // 写せなくても、その局はエンコードのときに覚えられる
            console.warn(`[cm] 覚えたロゴを ${dir} へ写せませんでした: ${error}`);
        }
    }
}

/**
 * 画面に出す数。覚えている局と、まだの局。
 *
 * **束ねて数える** (`stations`)。サブチャンネルの枠まで別に数えていた頃は、
 * 下に並ぶ一覧 (こちらも束ねてある) と数が合わなかった
 */
export function stats(): { have: number; total: number } {
    const current = stations(
        orm()
            .select({ id: services.id, network_id: services.network_id, name: services.name })
            .from(services)
            .where(and(sql.raw(CURRENT_SERVICES), eq(services.service_type, 1)))
            .all(),
    );
    return { have: current.filter((service) => learned(service.id)).length, total: current.length };
}
