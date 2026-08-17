import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    renameSync,
    rmdirSync,
    rmSync,
    unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { config } from './config';

/**
 * 生TSと保存先は別PVCなので rename が EXDEV で失敗する。
 * その場合だけコピー+削除にフォールバックする。
 */
export function moveFile(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    try {
        renameSync(from, to);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        copyFileSync(from, to);
        unlinkSync(from);
    }
}

export function removeIfExists(path: string | null | undefined): boolean {
    if (path == null || path === '') return false;
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
}

/**
 * `<input><接尾辞>…` の形で始まるものを、同じフォルダから全部消す。
 * 本数の決まらない作業ファイル (CMの区間 `.part0.ts` `.part1.ts`…、
 * jls の索引 `.jls…` `.dtvi…`) の片付け用。置き場ごと無ければ何もしない
 */
export function removeByPrefix(input: string, suffixes: readonly string[]): void {
    const dir = dirname(input);
    const heads = suffixes.map((suffix) => `${basename(input)}${suffix}`);
    try {
        for (const name of readdirSync(dir)) {
            if (heads.some((head) => name.startsWith(head))) rmSync(join(dir, name), { force: true });
        }
    } catch {
        // 置き場ごと消えていることもある。片付けで録画を止めない
    }
}

/**
 * ファイルを消した後に空になったシリーズ/シーズンのフォルダを畳む。
 * 残しておくと、フォルダを辿るプレイヤーに中身の無いシリーズが並び続けるため。
 * libraryDir 自身より上には絶対に遡らない。
 */
export function pruneEmptyDirs(path: string): void {
    let dir = dirname(path);
    while (dir.startsWith(config.libraryDir) && dir !== config.libraryDir) {
        try {
            rmdirSync(dir);
        } catch {
            // 空でなければここで止まる。それが正常な終了条件
            return;
        }
        dir = dirname(dir);
    }
}
