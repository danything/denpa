/**
 * シークバー (`SeekBar.svelte`) の溝に敷く塗り。DOM を触らない。
 *
 * **溝そのものの background に描く。** 溝の上に要素を重ねると、溝が入力欄の中の
 * どの高さに来るかはブラウザの作り次第で、塗りが溝からずれうる。溝の background なら
 * 必ず溝に載る。
 *
 * 色の意味は denpa-tv の `ProgressLine` (ControlBar.kt) と同じ: **CM は琥珀**
 * (`#FFB300` を 80%)、本編は溝のまま、観たぶんは主の色で上から塗る。帯の地は
 * いつも黒い舞台 (`PlayerStage`) なので、ダーク・ライトのどちらでも琥珀は溝・主の色と分かれる
 */

/** CM の塗り。denpa-tv と同じ値 */
export const CM_COLOR = 'rgb(255 179 0 / 0.8)';
/** 切れ目の目盛り */
const TICK_COLOR = 'rgb(255 255 255 / 0.7)';

/**
 * 溝の中での位置 (CSS の長さ)。`ratio` は 0〜1。
 *
 * **つまみの往復ぶんを引く。** つまみ (1rem) は端で枠から出ないよう内側を動くので、
 * 素の百分率で置くと**つまみとずれる** — 実機では、まだ来ていない CM の印が再生位置の
 * 左に出ていた。両端だけは溝の端まで伸ばす (頭の CM の左に塗り残しが出ないように)
 */
export function trackAt(ratio: number): string {
    if (!(ratio > 0)) return '0%';
    if (ratio >= 1) return '100%';
    return `calc(0.5rem + ${Math.round(ratio * 10000) / 10000} * (100% - 1rem))`;
}

/**
 * CM の区間と目盛りを、溝に敷く background の層にする。無いほうは `none`。
 *
 * - `cm` は観たぶんの塗りの**下** (観たところは主の色で隠れる。denpa-tv と同じ)
 * - `ticks` は観たぶんの塗りの**上** (観たところでも切れ目が見える。前の目盛りと同じ)
 *
 * 区間は重ならず、並んでいること (`cmSpans` の出すもの)。比は 4 桁で丸める
 * (1時間で 0.4 秒。溝の 1px より細かい)
 */
export function trackLayers(
    spans: { start: number; end: number }[],
    marks: number[],
    min: number,
    max: number,
): { cm: string; ticks: string } {
    const span = max - min;
    if (!(span > 0)) return { cm: 'none', ticks: 'none' };
    const ratio = (at: number) => Math.min(1, Math.max(0, (at - min) / span));

    let ticks = 'none';
    const marked = [...marks].sort((a, b) => a - b).filter((at) => at > min && at < max);
    if (marked.length > 0) {
        const stops = marked.flatMap((at) => {
            const x = trackAt(ratio(at));
            const after = `calc(${x} + 1px)`;
            return [
                `transparent ${x}`,
                `${TICK_COLOR} ${x}`,
                `${TICK_COLOR} ${after}`,
                `transparent ${after}`,
            ];
        });
        ticks = `linear-gradient(to right, ${stops.join(', ')})`;
    }

    let cm = 'none';
    const painted = spans.filter((s) => s.end > s.start && s.end > min && s.start < max);
    if (painted.length > 0) {
        const stops = painted.flatMap((s) => {
            const from = trackAt(ratio(s.start));
            const to = trackAt(ratio(s.end));
            return [`transparent ${from}`, `${CM_COLOR} ${from}`, `${CM_COLOR} ${to}`, `transparent ${to}`];
        });
        cm = `linear-gradient(to right, ${stops.join(', ')})`;
    }
    return { cm, ticks };
}
