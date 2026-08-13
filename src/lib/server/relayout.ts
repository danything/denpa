/**
 * 保存先をいまの形へ整える。**起動時に1回、要るものだけ。**
 *
 * 昔は Jellyfin 流の日付ベースの TV エピソード扱いで、`シリーズ/Season 年/…` に
 * 置き、`.nfo` は `<episodedetails>`、サムネは `-thumb.jpg` だった。いまの形は
 * `シリーズ/… .mkv` (Season フォルダをやめる) + `-poster.jpg` — 命名そのものは
 * [library.ts](library.ts)、サイドカーは [metadata.ts](metadata.ts) が持つ。
 *
 * **`.nfo` はもう書かないので、置いてあるものは片付ける。** WebDAV 経由の
 * プレイヤー (Nova) に読ませるためのものだったが、その道ごとやめた
 * (手元のプレイヤーには URL を渡して再生させる)。
 *
 * **移すのは DB が指す本体 (`library_path`/`alt_path`) と、その付き添い。** ついでに、
 * 命名規則が変わる前に取り残された同じ録画の**はぐれ**も、旧フォルダから片付ける
 * (これが焼き直しのたびに `[録画ID]` を強制していた張本人)。空になった旧フォルダは畳む。
 */

import { copyFileSync, existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { Recording } from '../types';
import { database, now, queryAll, queryOne } from './db';
import { moveFile, pruneEmptyDirs, removeIfExists } from './fsx';
import { encodedPath, libraryFamily } from './library';
import { sidecarPaths } from './metadata';

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
 * NFO はもう書かないので、旧いのは捨てるだけ。
 */
function movePrimary(from: string, to: string): void {
    if (existsSync(from)) moveFile(from, to);

    const oldBase = stripExt(from);
    const dst = sidecarPaths(to);
    if (existsSync(`${oldBase}.bml.jsonl`)) moveFile(`${oldBase}.bml.jsonl`, dst.dataBroadcast);
    if (existsSync(`${oldBase}-thumb.jpg`)) moveFile(`${oldBase}-thumb.jpg`, dst.thumbnail);
    // 旧 NFO と、昔置いていた字幕の写しは捨てる
    removeIfExists(`${oldBase}.nfo`);
    removeIfExists(`${oldBase}.ja.ass`);
}

/** 書かなくなった `.nfo` が残っていれば片付ける (消したら true) */
function sweepNfo(videoPath: string): boolean {
    const { nfo } = sidecarPaths(videoPath);
    if (!existsSync(nfo)) return false;
    removeIfExists(nfo);
    return true;
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
 * もう一方 (H.264) の隣にもポスターを置く。無ければ主から複製する (付けたら true)。
 * 主 (AV1) を消すと残ったほうが主に繰り上がるので、そのときも画面のサムネが途切れない。
 */
function ensureAltSidecars(altPath: string | null, primaryPath: string): boolean {
    if (altPath === null) return false;
    const altPoster = sidecarPaths(altPath).thumbnail;
    const primaryPoster = sidecarPaths(primaryPath).thumbnail;
    if (!existsSync(altPoster) && existsSync(primaryPoster)) {
        copyFileSync(primaryPoster, altPoster);
        return true;
    }
    return false;
}

/** 1録画ぶんを整える。'moved'=新しい形へ移した / 'sidecar'=.nfoを片付けた・ポスターを補った / 'none'=変化なし */
function relayoutOne(rec: Recording): 'moved' | 'sidecar' | 'none' {
    const primary = rec.library_path;
    if (primary === null) return 'none';

    const newPrimary = encodedPath(rec, codecOf(primary));
    const newAlt = rec.alt_path === null ? null : encodedPath(rec, codecOf(rec.alt_path));

    // 既に新しい形。書かなくなった .nfo を片付け、もう一方のポスターも無ければ補う
    if (newPrimary === primary && newAlt === rec.alt_path) {
        let touched = sweepNfo(primary);
        if (rec.alt_path !== null && sweepNfo(rec.alt_path)) touched = true;
        if (ensureAltSidecars(rec.alt_path, primary)) touched = true;
        return touched ? 'sidecar' : 'none';
    }

    const oldPrimaryDir = dirname(primary);
    movePrimary(primary, newPrimary);
    if (rec.alt_path !== null && newAlt !== null && rec.alt_path !== newAlt) {
        if (existsSync(rec.alt_path)) moveFile(rec.alt_path, newAlt);
    }
    // もう一方 (H.264) の隣にもポスターを置く
    ensureAltSidecars(newAlt, newPrimary);

    sweepOldStrays(rec, oldPrimaryDir, new Set([newPrimary, newAlt].filter((p): p is string => p !== null)));
    // 旧シリーズフォルダ直下の tvshow.nfo はもう使わない
    removeIfExists(join(dirname(oldPrimaryDir), 'tvshow.nfo'));
    pruneEmptyDirs(primary);

    database()
        .prepare('UPDATE recordings SET library_path = ?, alt_path = ?, updated_at = ? WHERE id = ?')
        .run(newPrimary, newAlt, now(), rec.id);
    return 'moved';
}

/** 起動時に1回。旧レイアウトをいまの形へ移し、書かなくなった .nfo を片付ける */
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
    if (moved > 0) console.log(`[relayout] 保存先を新しい形へ移しました: ${moved} 件`);
    if (sidecar > 0)
        console.log(`[relayout] 付き添いを整えました (.nfo 片付け・ポスター補い): ${sidecar} 件`);
}
