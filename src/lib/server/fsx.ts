import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

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
 * ファイルを消した後に空になったフォルダ (シリーズ) を消す。
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

/** いまのファイルの大きさ。無ければ null (消された・まだ書き始めていない) */
export function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** `path` が `root` そのものか、その下か。名前の先頭が同じだけの隣のフォルダ (`/media/raw2`) は外 */
export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/**
 * **元の TS から作る作業ファイルの名前の元** (`<これ>.decoded.m2ts`・`<これ>.remux.mp4`・`<これ>.<ジョブ>.chapters.txt`)。
 * 置き場 (`RAW_DIR`・`ENCODED_DIR`) の中の TS は今までどおりその隣に作る。**置き場の外の TS (取り込んだもの。`ts-import.ts`) は
 * `RAW_DIR/.import/` の下に作り、ユーザーのフォルダには書かない。** 名前はパスのハッシュと元の名前で、同じ TS なら同じ名前になる
 * (落ちたあとの後始末が同じ名前を消せる)。取り残されたものは置き場の片付け (`files.sweepLeftovers`) が見る
 */
export function scratchBase(input: string): string {
  if (within(config.rawDir, input) || within(config.encodedDir, input))
    return input;
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 16);
  return join(config.rawDir, ".import", `${hash}-${basename(input)}`);
}
