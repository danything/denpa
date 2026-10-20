/**
 * 番組表の骨組みの形 (`GuideSkeleton.svelte` と `guide/+page.svelte` のマスのところ)。
 *
 * 高さは**番組の尺のつもり**でばらけさせる。全部同じ高さだと表ではなくただの縞に見えた。
 * 乱数ではなく決め打ちなのは、描き直すたびに形が変わるとそれ自体が動いて見えるため
 */
const PATTERNS = [
    [3, 1.5, 4.5, 2, 3, 2.5, 4, 1.5, 3, 2],
    [1.5, 5, 2, 3.5, 2, 3, 1.5, 4, 2.5, 2],
    [4, 2, 2.5, 4, 1.5, 3, 2, 3.5, 2.5, 2],
    [2, 3, 6, 1.5, 2.5, 2, 4, 1.5, 3, 1.5],
    [5, 1.5, 2, 3, 2.5, 4, 1.5, 3, 2, 2.5],
    [1.5, 4, 3, 2, 3.5, 2.5, 2, 4, 2.5, 2],
    [3.5, 2.5, 1.5, 5, 2, 3, 2, 2.5, 3, 2],
    [2, 6, 2.5, 1.5, 3, 2, 3.5, 2, 2.5, 2],
];

/** 広い画面を埋めるのに足りる列の数 (局の数が分からないとき。`GuideSkeleton`) */
export const SKELETON_COLUMNS = 16;

/** 桝と桝の間 (本物のマスの上下の余白 `.cell` の 0.125rem × 2) */
const GAP = 0.25;

/**
 * その列の桝の形。**桝を 1 つずつ置かず、列 1 枚を切り抜く** (`mask-image`)。
 * 決め打ちの並びを縦に繰り返すので、どれだけ高くても下の端まで埋まる
 */
export function skeletonMask(column: number): string {
    const heights = PATTERNS[column % PATTERNS.length] ?? [];
    let at = 0;
    const stops: string[] = [];
    for (const height of heights) {
        stops.push(
            `#000 ${at}rem ${at + height - GAP}rem`,
            `transparent ${at + height - GAP}rem ${at + height}rem`,
        );
        at += height;
    }
    return `repeating-linear-gradient(to bottom, ${stops.join(', ')})`;
}
