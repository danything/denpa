import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";

import { config } from "./config";

/**
 * 元の TS と保存先は別の PVC なので rename が EXDEV で失敗する。
 * そのときだけコピーと削除にフォールバックする。
 */
export function moveFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

export function removeIfExists(path: string | null | undefined): void {
  if (path == null || path === "" || !existsSync(path)) return;
  unlinkSync(path);
}

/**
 * ファイルを消した後に空になったフォルダ (シリーズ) を畳む。
 * encodedDir 自身より上には絶対に遡らない。encodedDir の外 (名前の先頭が同じだけの隣のフォルダも) には触らない
 */
export function pruneEmptyDirs(path: string): void {
  const inside = (dir: string) => {
    const rel = relative(config.encodedDir, dir);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  let dir = dirname(path);
  while (inside(dir)) {
    try {
      rmdirSync(dir);
    } catch {
      // 空でなければここで止まる。それが正常な終了条件
      return;
    }
    dir = dirname(dir);
  }
}
