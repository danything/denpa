/** **測ったものを数える** (`decoded-most.bench.ts`・`report.ts`。どちらも同じ数え方で) */

export type Path = 'mpeg2' | 'av1' | 'h264';
export type Load = 'idle' | 'busy';

/** `probe.js` の `__bench.measure` が返すもの */
export interface Measured {
    draws: [number, number, number][];
    held: number[];
    liveMax: number;
    outstandingMax: number;
    decMax: number;
    pushMs: number[];
    /** worker の刻みが来た回数 (古い結果には無い) */
    ticks?: number;
    wasm: number;
    vsyncs: number[];
    input: string | null;
}

export interface Result {
    path: Path;
    value: number;
    load: string;
    run: number;
    /** 最後まで同じ方式で描いていた (諦めてほかへ移っていない) */
    ok: boolean;
    /** 画面の切り替わりの間隔 (ms。中央値) */
    vsyncMs: number;
    /** 何を並べて数えたか (`raf` … 画面の切り替わりごと / `draws` … 描いた回ごと。rAF が間引かれているとき) */
    basis: 'raf' | 'draws';
    /** worker の刻み (毎秒)。ふつうは 200 前後 (4ms ごと)。**大きく少なければ、ブラウザが刻みを間引いている** */
    tickHz: number;
    /** 出したコマの数 (毎秒) と、一度も出なかったコマの数。MPEG-2 はフィールドを 1 つと数える */
    shownPerSec: number;
    drops: number;
    /** 50ms 以上変わらなかった回と、いちばん長く変わらなかった間 (ms) */
    stalls: number;
    freeze: number;
    /** 描いた時点で持っていたフレームの枚数 (中央値・最大) */
    heldMedian: number;
    heldMax: number;
    /** MPEG-2: デコーダの順番待ちの最大。fMP4: 閉じていない VideoFrame + decodeQueueSize の最大 */
    peak: number;
    /** MPEG-2: WASM のメモリ (MB) */
    wasmMB: number;
    /** MPEG-2: 1 PES をデコードする時間 (ms。p50 / p95) */
    decodeP50: number;
    decodeP95: number;
}

const quantile = (values: number[], q: number) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
const round = (value: number) => Math.round(value * 10) / 10;
/** 1 コマの長さ (ms)。MPEG-2 はフィールド、fMP4 は 59.94p のコマ */
const PICTURE = 1001 / 60;
/** これだけ映像が変わらなければ止まったと数える (ms。3 コマぶん) */
const STALL = 50;

/** 画面の切り替わりごとに出ていたコマを並べて数える。**画面の速さ (60Hz・144Hz) によらない数え方** */
export function analyse(
    path: Path,
    value: number,
    load: string,
    run: number,
    m: Measured,
    ok: boolean,
): Result {
    const draws = m.draws.filter(([, pts]) => pts >= 0);
    const base = draws[0]?.[1] ?? 0;
    const id = ([, pts, field]: [number, number, number]) =>
        path === 'mpeg2'
            ? 2 * Math.round((pts - base) / 3003) + (field === 1 ? 1 : 0)
            : Math.round((pts - base) / (PICTURE * 1000));
    const gaps = m.vsyncs.slice(1).map((v, i) => v - m.vsyncs[i]!);
    /*
     * **画面の rAF が間引かれているときは、描いた回をそのまま並べる。** 窓が隠れている Chrome は rAF を
     * 毎秒 1〜2 回に落とす。fMP4 の経路は音の時計で描くので、描いた回だけでも落ち・止まりは数えられる
     */
    const basis: 'raf' | 'draws' = gaps.length > 0 && quantile(gaps, 0.5) < 40 ? 'raf' : 'draws';
    const seen: { at: number; id: number }[] = [];
    if (basis === 'draws') {
        for (const draw of draws) seen.push({ at: draw[0], id: id(draw) });
    } else {
        let at = 0;
        for (const vsync of m.vsyncs) {
            while (at < draws.length && draws[at]![0] < vsync) at++;
            if (at > 0) seen.push({ at: vsync, id: id(draws[at - 1]!) });
        }
    }
    let drops = 0;
    let stalls = 0;
    let freeze = 0;
    let changed = seen[0]?.at ?? 0;
    const shown = new Set<number>();
    for (let i = 0; i < seen.length; i++) {
        shown.add(seen[i]!.id);
        if (i === 0) continue;
        const step = seen[i]!.id - seen[i - 1]!.id;
        if (step > 1) drops += step - 1;
        if (step !== 0) {
            const held = seen[i]!.at - changed;
            if (held >= STALL) stalls++;
            freeze = Math.max(freeze, held);
            changed = seen[i]!.at;
        }
    }
    const span = ((seen.at(-1)?.at ?? 0) - (seen[0]?.at ?? 0)) / 1000;
    return {
        path,
        value,
        load,
        run,
        ok,
        vsyncMs: round(quantile(gaps, 0.5)),
        basis,
        tickHz: Math.round(
            (m.ticks ?? 0) / Math.max(1, ((m.vsyncs.at(-1) ?? 0) - (m.vsyncs[0] ?? 0)) / 1000),
        ),
        shownPerSec: round(shown.size / Math.max(1, span)),
        drops,
        stalls,
        freeze: round(freeze),
        heldMedian: quantile(m.held, 0.5),
        heldMax: Math.max(0, ...m.held),
        peak: path === 'mpeg2' ? m.decMax : m.outstandingMax,
        wasmMB: round(m.wasm / 1024 / 1024),
        decodeP50: round(quantile(m.pushMs, 0.5)),
        decodeP95: round(quantile(m.pushMs, 0.95)),
    };
}

export function summarize(results: Result[]): string {
    const lines = [
        '| 経路 | 負荷 | 値 | 回 | 出したコマ/秒 | 毎秒 50 コマ未満の回 | 落ち | 止まり (50ms+) | 止まった最長 (ms) | 持った枚数 (中央値/最大) | 持ち数の最大 | WASM (MB) | 失敗 |',
        '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ];
    const mean = (values: number[]) => round(values.reduce((s, v) => s + v, 0) / Math.max(1, values.length));
    const values = [...new Set(results.map((r) => r.value))].sort((a, b) => a - b);
    for (const key of new Set(results.map((r) => `${r.path}\t${r.load}`))) {
        const [path, load] = key.split('\t');
        for (const value of values) {
            const rows = results.filter((r) => r.path === path && r.load === load && r.value === value);
            if (rows.length === 0) continue;
            const good = rows.filter((r) => r.ok);
            const cells = [
                path,
                load,
                value,
                rows.length,
                mean(good.map((r) => r.shownPerSec)),
                good.filter((r) => r.shownPerSec < 50).length,
                mean(good.map((r) => r.drops)),
                mean(good.map((r) => r.stalls)),
                mean(good.map((r) => r.freeze)),
                `${mean(good.map((r) => r.heldMedian))}/${Math.max(0, ...good.map((r) => r.heldMax))}`,
                Math.max(0, ...good.map((r) => r.peak)),
                Math.max(0, ...good.map((r) => r.wasmMB)),
                rows.length - good.length,
            ];
            lines.push(`| ${cells.join(' | ')} |`);
        }
    }
    return lines.join('\n');
}
