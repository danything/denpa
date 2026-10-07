import { statfsSync } from 'node:fs';
import { and, desc, gte, isNotNull, isNull, or } from 'drizzle-orm';
import { size } from '../format';
import { fileSize } from './chase';
import { config } from './config';
import { orm } from './db';
import { activeEncodeJobId, recordings } from './schema';
import { notify } from './webhook';

/**
 * ディスクの残量を見張る。**録画が全部失敗して初めて気付く、を防ぐ。**
 *
 * 保存先が埋まると、始まる録画が片っ端から書けずに失敗する。埋まってからでは
 * 遅いので、残量が閾値を下回ったところで一度だけ知らせる。照合と同じ周期で回す
 * (`runtime.ts`)。
 *
 * **境目をまたいだ一度だけ鳴らす。** 毎周期ごとに鳴らすと、空けるまで数分おきに
 * 通知が飛び続ける。下回った置き場を覚えておいて、戻ったら忘れる (次に下回れば
 * また鳴る)。録画の外側の話なので、録画を止めたり消したりは一切しない — 見張って
 * 教えるだけ。
 */

/** いま「残りわずか」を知らせ済みの置き場。またぐたびに1回だけ鳴らすための覚え */
const warned = new Set<string>();

/** その置き場の空きバイト数。読めなければ null (統計が取れない環境もある) */
function freeBytes(dir: string): number | null {
    try {
        const stat = statfsSync(dir);
        return stat.bsize * stat.bavail;
    } catch {
        return null;
    }
}

/** 監視する置き場。生TSの作業領域とエンコード済みの保存先 */
function watched(): string[] {
    // 同じパーティションに載っていることもあるので重複は畳む
    return [...new Set([config.rawDir, config.encodedDir])];
}

export function checkDisk(): void {
    if (config.diskLowThreshold <= 0) return;

    for (const dir of watched()) {
        const free = freeBytes(dir);
        if (free === null) continue;

        if (free < config.diskLowThreshold) {
            // すでに知らせてある置き場は、空けるまで黙る
            if (warned.has(dir)) continue;
            warned.add(dir);
            console.warn(`[disk] 残量わずか: ${dir} (残り ${size(free)})`);
            notify({
                event: 'disk.low',
                text: `ディスクの残りがわずかです: ${dir} (残り ${size(free)} / 閾値 ${size(config.diskLowThreshold)})`,
            });
        } else if (warned.has(dir)) {
            // 閾値より上へ戻った。覚えを消して、次に下回ればまた鳴らす
            warned.delete(dir);
            console.log(`[disk] 残量が戻りました: ${dir} (残り ${size(free)})`);
        }
    }
}

/**
 * 録画の見出しに出す**空きと、あと何時間録れるかの目安** (issue #505)。読めなければ null。
 *
 * 空きは置き場のうち**いちばん少ないもの**。生TS (`rawDir`) は録っている間に書かれ、
 * 焼いたもの (`encodedDir`) はその後に残る。録れなくなるのはどちらかが先に埋まったときで、
 * たいていは同じパーティションに載っている。
 *
 * 時間は空き ÷ **最近の録画が1時間あたりに置いていった量**。焼いたもの・残した生TS・
 * H.264 の控えを全部足す (設定で残すものが変わっても、実際に残った量で決まる)。
 * 置き場が分かれているときも両方の量を少ないほうの空きで割るので、短めに出る —
 * 目安なので、外れるなら少なく見積もるほうにしておく。焼く前の録画は生TSの大きさしか
 * 持たず、焼くと縮むので数えない。本数が足りなければ時間は出さない (null)
 */
export function capacity(): { free: number; hours: number | null } | null {
    const frees = watched()
        .map(freeBytes)
        .filter((free) => free !== null);
    if (frees.length === 0) return null;
    const free = Math.min(...frees);

    const rows = orm()
        .select({
            duration: recordings.duration_ms,
            size: recordings.ts_size,
            ts: recordings.ts_path,
            library: recordings.library_path,
            alt: recordings.alt_path,
        })
        .from(recordings)
        .where(
            and(
                isNotNull(recordings.finished_at),
                isNull(recordings.deleted_at),
                gte(recordings.duration_ms, SAMPLE_MIN_MS),
                or(isNotNull(recordings.library_path), isNull(activeEncodeJobId(recordings.id))),
            ),
        )
        .orderBy(desc(recordings.finished_at))
        .limit(SAMPLES)
        .all();
    if (rows.length < SAMPLES_MIN) return { free, hours: null };

    let bytes = 0;
    let ms = 0;
    for (const row of rows) {
        // `ts_size` はいま配っているもの (焼いていれば焼いたもの) の大きさ。残した生TSと控えは別に量る
        bytes += row.size;
        if (row.library !== null && row.ts !== null) bytes += fileSize(row.ts) ?? 0;
        if (row.alt !== null) bytes += fileSize(row.alt) ?? 0;
        ms += row.duration ?? 0;
    }
    const perHour = bytes / (ms / 3_600_000);
    return { free, hours: perHour > 0 ? free / perHour : null };
}

/** 目安に使う録画の本数。新しいものから。設定を変えたらすぐ追いつくように多くは見ない */
const SAMPLES = 20;
/** これより少なければ時間は出さない。1本だけだと、その番組の画の細かさに引きずられる */
const SAMPLES_MIN = 3;
/** 短すぎる録画は量りに入れない (途中で止めたもの等。頭の固定分で1時間あたりが膨らむ) */
const SAMPLE_MIN_MS = 5 * 60_000;
