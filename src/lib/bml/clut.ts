/**
 * 色の表 (CLUT)。BML の色は番号で指す (`color-index: 7`)。
 *
 * 既定の表 (STD-B24 第二分冊 付属3 表5-7) は規則で作れる:
 * 0〜7 が原色、8 が透明、9〜15 が半分の明るさ、16〜64 が残りの組み合わせ (R・G・B を
 * 00/55/aa/ff から選び、上の 2 つで出たものを除いた順)、65〜127 が 0〜63 (8 を除く) の
 * 半透明。文書は `clut: url(...)` で 17〜223 番を差し替える (付属3 5.1.7 表5-8)。
 */

export type Rgba = [r: number, g: number, b: number, a: number];

function build(): Rgba[] {
    const table: Rgba[] = [];
    const full = (v: number): number => (v ? 0xff : 0);
    for (let i = 0; i < 8; i++) table.push([full(i & 1), full(i & 2), full(i & 4), 0xff]);
    table.push([0, 0, 0, 0]);
    for (let i = 1; i < 8; i++) table.push([i & 1 ? 0xaa : 0, i & 2 ? 0xaa : 0, i & 4 ? 0xaa : 0, 0xff]);
    const levels = [0, 0x55, 0xaa, 0xff];
    for (const r of levels) {
        for (const g of levels) {
            for (const b of levels) {
                const rgb = [r, g, b];
                if (rgb.every((v) => v === 0 || v === 0xff) || rgb.every((v) => v === 0 || v === 0xaa))
                    continue;
                table.push([r, g, b, 0xff]);
            }
        }
    }
    const opaque = table.filter((_, i) => i !== 8).slice(0, 63);
    for (const [r, g, b] of opaque) table.push([r, g, b, 0x80]);
    while (table.length < 256) table.push([0, 0, 0, 0xff]);
    return table;
}

export const DEFAULT_CLUT: readonly Rgba[] = build();

/** CLUT ファイルを読む (YCbCr、8 ビット、start_end のみ運用)。読めなければ既定の表 */
export function readClut(data: Uint8Array): Rgba[] {
    const table = DEFAULT_CLUT.map((c) => [...c] as Rgba);
    if (data.length < 3) return table;
    const head = data[0]!;
    const rgb = (head & 0x80) !== 0;
    const depth = (head >> 5) & 3;
    const region = (head & 0x10) !== 0;
    const startEnd = (head & 0x08) !== 0;
    if (!startEnd || depth !== 1) return table;
    let at = region ? 9 : 1;
    const start = data[at++] ?? 0;
    const end = data[at++] ?? 0;
    for (let i = start; i <= end && i < 256 && at + 3 < data.length + 1; i++) {
        const [a0, a1, a2, alpha] = [data[at], data[at + 1], data[at + 2], data[at + 3]];
        if (alpha === undefined) break;
        at += 4;
        if (rgb) {
            table[i] = [a0!, a1!, a2!, alpha];
            continue;
        }
        const y = a0! - 16;
        const cb = a1! - 128;
        const cr = a2! - 128;
        const clamp = (v: number): number => Math.max(0, Math.min(255, Math.floor(v)));
        table[i] = [
            clamp(y * 1.16438 + 1.79274 * cr),
            clamp(y * 1.16438 - 0.213249 * cb - 0.532909 * cr),
            clamp(y * 1.16438 + 2.1124 * cb),
            alpha,
        ];
    }
    return table;
}

/** CSS の色 */
export function cssColor(color: Rgba | undefined): string {
    if (color === undefined) return 'transparent';
    const [r, g, b, a] = color;
    return a === 0xff ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${(a / 255).toFixed(3)})`;
}
