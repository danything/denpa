/**
 * 保存先を「1録画 = 1本の映画」の新しい形へ移す。**起動時に1回、要るものだけ。**
 *
 * 昔は Jellyfin 流の日付ベースの TV エピソード扱いで、`シリーズ/Season 年/…` に
 * 置き、`.nfo` は `<episodedetails>`、サムネは `-thumb.jpg` だった。想定プレイヤーの
 * Nova ではこの形が弱く、番組情報もサムネも出なかった (episodedetails は全話
 * S00E00 送り・個別ポスターを読まない、`-thumb.jpg` はどの命名にも当てはまらない)。
 *
 * 新しい形は `シリーズ/… .mkv` (Season フォルダをやめる) + `<movie>` NFO +
 * `-poster.jpg`。ここは既にある録画を**その形へ移し替える**だけ — 命名そのものは
 * [library.ts](library.ts)、NFO は [metadata.ts](metadata.ts) が持つ。
 *
 * **移すのは DB が指す本体 (`library_path`/`alt_path`) と、その付き添い。** ついでに、
 * 命名規則が変わる前に取り残された同じ録画の**はぐれ**も、旧フォルダから片付ける
 * (これが焼き直しのたびに `[録画ID]` を強制していた張本人)。空になった旧フォルダは畳む。
 */

import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { Recording } from '../types';
import { config } from './config';
import { database, now, queryAll, queryOne } from './db';
import { moveFile, pruneEmptyDirs, removeIfExists } from './fsx';
import { encodedPath, libraryFamily } from './library';
import { movieNfo, sidecarPaths } from './metadata';

function stripExt(path: string): string {
    return path.slice(0, path.length - extname(path).length);
}

/** 置き場の名前 (`… [H264].mkv`) からコーデックを見分ける。主は AV1、`[H264]` は H.264 */
function codecOf(path: string): 'av1' | 'h264' {
    return / \[H264\]\.mkv$/i.test(path) ? 'h264' : 'av1';
}

/** 旧・新どちらの命名でも当てはまる付き添いを消す (動画のパスを土台に) */
function removeSidecarsOf(videoPath: string): void {
    const base = stripExt(videoPath);
    for (const suffix of ['.nfo', '-poster.jpg', '-thumb.jpg', '.bml.jsonl', '.ja.ass']) {
        removeIfExists(`${base}${suffix}`);
    }
}

/**
 * 本体1本 (主) を新しい置き場へ移し、付き添いも連れていく。
 * データ放送ログは移し、旧サムネ (`-thumb.jpg`) は新ポスター (`-poster.jpg`) に化かす。
 * NFO は形が変わった (`<movie>`) ので、旧いのは捨てて書き直す。
 */
function movePrimary(rec: Recording, from: string, to: string): void {
    if (existsSync(from)) moveFile(from, to);

    const oldBase = stripExt(from);
    const dst = sidecarPaths(to);
    if (existsSync(`${oldBase}.bml.jsonl`)) moveFile(`${oldBase}.bml.jsonl`, dst.dataBroadcast);
    if (existsSync(`${oldBase}-thumb.jpg`)) moveFile(`${oldBase}-thumb.jpg`, dst.thumbnail);
    // 旧 NFO (episodedetails) と、昔置いていた字幕の写しは捨てる
    removeIfExists(`${oldBase}.nfo`);
    removeIfExists(`${oldBase}.ja.ass`);
    if (config.writeNfo) writeFileSync(dst.nfo, movieNfo(rec, basename(dst.thumbnail)));
}

/**
 * 旧フォルダに取り残された、同じ録画のはぐれファイルを片付ける。
 * **他の録画が現に使っている置き場所は消さない** (DBで確認) — 万一の同名衝突の巻き添えを避ける。
 */
function sweepOldStrays(rec: Recording, oldDir: string, moved: ReadonlySet<string>): void {
    if (!existsSync(oldDir)) return;
    const base = basename(libraryFamily(rec)[0], '.mkv');
    const variants = [
        `${base}.mkv`,
        `${base} [${rec.id}].mkv`,
        `${base} [H264].mkv`,
        `${base} [${rec.id}] [H264].mkv`,
    ];
    for (const name of variants) {
        const stray = join(oldDir, name);
        if (moved.has(stray) || !existsSync(stray)) continue;
        const claimed = queryOne<{ id: number }>(
            'SELECT id FROM recordings WHERE (library_path = ? OR alt_path = ?) AND id != ?',
            stray,
            stray,
            rec.id,
        );
        if (claimed !== undefined) continue;
        removeIfExists(stray);
        removeSidecarsOf(stray);
    }
}

/**
 * もう一方 (H.264) の隣にも NFO とポスターを置く。無ければ補う (付けたら true)。
 *
 * 映画型の Nova は動画1本ごとに `{名前}.nfo` / `{名前}-poster.jpg` を読む。付けないと、
 * AV1 を再生できない端末で観る H.264 が「情報なしの裸ファイル」になる。ポスターは
 * 主から複製する (同じ絵)。
 */
function ensureAltSidecars(rec: Recording, altPath: string | null, primaryPath: string): boolean {
    if (altPath === null || !config.writeNfo) return false;
    let added = false;
    const altNfo = sidecarPaths(altPath).nfo;
    if (!existsSync(altNfo)) {
        writeFileSync(altNfo, movieNfo(rec, basename(sidecarPaths(altPath).thumbnail)));
        added = true;
    }
    const altPoster = sidecarPaths(altPath).thumbnail;
    const primaryPoster = sidecarPaths(primaryPath).thumbnail;
    if (!existsSync(altPoster) && existsSync(primaryPoster)) {
        copyFileSync(primaryPoster, altPoster);
        added = true;
    }
    return added;
}

/** 1録画ぶんを整える。'moved'=映画型へ移した / 'sidecar'=もう一方に情報を補った / 'none'=変化なし */
function relayoutOne(rec: Recording): 'moved' | 'sidecar' | 'none' {
    const primary = rec.library_path;
    if (primary === null) return 'none';

    const newPrimary = encodedPath(rec, codecOf(primary));
    const newAlt = rec.alt_path === null ? null : encodedPath(rec, codecOf(rec.alt_path));

    // 既に映画型。もう一方のサイドカーだけ、無ければ補う
    if (newPrimary === primary && newAlt === rec.alt_path) {
        return ensureAltSidecars(rec, rec.alt_path, primary) ? 'sidecar' : 'none';
    }

    const oldPrimaryDir = dirname(primary);
    movePrimary(rec, primary, newPrimary);
    if (rec.alt_path !== null && newAlt !== null && rec.alt_path !== newAlt) {
        if (existsSync(rec.alt_path)) moveFile(rec.alt_path, newAlt);
    }
    // もう一方 (H.264) の隣にも同じ NFO とポスターを置く
    ensureAltSidecars(rec, newAlt, newPrimary);

    sweepOldStrays(rec, oldPrimaryDir, new Set([newPrimary, newAlt].filter((p): p is string => p !== null)));
    // 旧シリーズフォルダ直下の tvshow.nfo はもう使わない
    removeIfExists(join(dirname(oldPrimaryDir), 'tvshow.nfo'));
    pruneEmptyDirs(primary);

    database()
        .prepare('UPDATE recordings SET library_path = ?, alt_path = ?, updated_at = ? WHERE id = ?')
        .run(newPrimary, newAlt, now(), rec.id);
    return 'moved';
}

/** 起動時に1回。旧レイアウトを映画型へ移し、もう一方のコーデックにも番組情報を揃える */
export function relayoutLibrary(): void {
    const recordings = queryAll<Recording>(
        'SELECT * FROM recordings WHERE library_path IS NOT NULL AND deleted_at IS NULL',
    );
    let moved = 0;
    let sidecar = 0;
    for (const rec of recordings) {
        try {
            const result = relayoutOne(rec);
            if (result === 'moved') moved += 1;
            else if (result === 'sidecar') sidecar += 1;
        } catch (error) {
            console.error(`[relayout] 録画 ${rec.id} の移し替えに失敗しました: ${error}`);
        }
    }
    if (moved > 0) console.log(`[relayout] 保存先を映画型へ移しました: ${moved} 件`);
    if (sidecar > 0) console.log(`[relayout] もう一方のコーデックに番組情報を補いました: ${sidecar} 件`);
}
