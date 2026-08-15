import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pad } from '$lib/format';
import { config } from './config';
import { sanitizeFileName } from './title';

export interface LibraryNameInput {
    id: number;
    series: string;
    subtitle: string;
    start_at: number;
    /** いま置いてある場所。焼き直しのとき、自分自身を「衝突」と読まないために要る */
    library_path?: string | null;
    /** もう一方のコーデックの置き場所。これも「自分自身」なので衝突と読まない */
    alt_path?: string | null;
}

/**
 * 保存先での相対パスを組む。`シリーズ名/シリーズ名 - YYYY-MM-DD - HHMM 副題{ext}`。
 *
 * シリーズ名のフォルダにまとめるのは**ディスク上で見やすくするため**。
 * 隣にはサムネ (`-poster.jpg`) を録画ごとに置く (metadata.ts)。
 * 昔は Jellyfin 流の `Season 年/` + Sxx Exx 扱いだったが、日本の放送番組は
 * TMDB/TVDB に載らず話数も付かない/リセットされるものが多く、意味を成さなかった。
 *
 * 日時はコンテナの TZ (Asia/Tokyo) のローカル時刻。放送日で並ぶのが期待値なので UTC にはしない。
 */
function libraryRelPath(rec: LibraryNameInput, ext: string): string {
    const d = new Date(rec.start_at);
    const series = sanitizeFileName(rec.series);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}${pad(d.getMinutes())}`;

    // 同一シリーズが同じ分に2本並ぶことはまず無い (万一衝突したら libraryPath が録画IDで分ける)
    const subtitle = rec.subtitle === '' ? '' : ` ${sanitizeFileName(rec.subtitle)}`;
    const base = `${series} - ${date} - ${time}${subtitle}`;

    return join(series, `${base}${ext}`);
}

/**
 * 絶対パス版。**別の録画のファイルと衝突したら**録画IDを足して避ける。
 *
 * **自分がいま置いてあるファイルは衝突ではない。** 見ずに `existsSync` だけで
 * 決めていた頃は、焼き直すたびに名前が入れ替わっていた:
 *
 * ```text
 * 1回目  番組 - 2026-08-03 - 2230.mkv       (空いているので素の名前)
 * 2回目  番組 - 2026-08-03 - 2230 [39].mkv  (1回目のものを「衝突」と読む)
 * 3回目  番組 - 2026-08-03 - 2230.mkv       (2回目が別名なので素の名前が空く)
 * ```
 *
 * 置き換えたあとに古いほうを消すので中身は無事だが、**焼き直すたびに
 * ファイル名が変わる**ので、プレイヤー側の見え方が毎回崩れる。
 */
export function libraryPath(rec: LibraryNameInput, ext: string): string {
    const rel = libraryRelPath(rec, ext);
    const abs = join(config.libraryDir, rel);
    // 自分がいま置いてある2本 (主・もう一方) は衝突ではない
    if (!existsSync(abs) || abs === rec.library_path || abs === rec.alt_path) return abs;
    return join(config.libraryDir, libraryRelPath(rec, ` [${rec.id}]${ext}`));
}

/**
 * コーデックごとの置き場所。
 *
 * どちらも Matroska (`.mkv`) — mp4 は放送どおりに描いた字幕 (PGS) を持てない
 * ため、両方 mkv で揃える。**H.264 のほうは名前に印を付ける** (`[H264]`)。
 * 同じフォルダに2本並ぶので、名前が違わないと衝突するのと、テレビで
 * どちらを選べばよいか名前で分かるようにするため。
 */
export function encodedPath(rec: LibraryNameInput, codec: 'av1' | 'h264'): string {
    return libraryPath(rec, codec === 'h264' ? ' [H264].mkv' : '.mkv');
}

/**
 * この録画が取りうる保存先の候補すべて。
 *
 * コーデック (素 = AV1 / `[H264]`) と、衝突回避の `[録画ID]` の有無で最大4通り。
 * 焼き直す前に、DBの `library_path`/`alt_path` が指していない**はぐれファイル**まで
 * 含めて片付けるために使う。命名規則が `[録画ID]` 付きに変わる前の素名 AV1 などは
 * どちらの列にも載らないので残り続け、`libraryPath` が毎回それを「衝突」と読んで
 * `[録画ID]` を剥がれなくしていた (`encodedPath` が素名を取れない)。
 */
export function libraryFamily(rec: LibraryNameInput): string[] {
    const exts = ['.mkv', ` [${rec.id}].mkv`, ' [H264].mkv', ` [${rec.id}] [H264].mkv`];
    return exts.map((ext) => join(config.libraryDir, libraryRelPath(rec, ext)));
}

/** 生TSの置き場。保存先と違い人が見るものではないので平置きでよい */
export function recordedPath(rec: LibraryNameInput, ext = '.m2ts'): string {
    const d = new Date(rec.start_at);
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return join(config.recordedDir, `${sanitizeFileName(rec.series)}-${stamp}-${rec.id}${ext}`);
}
