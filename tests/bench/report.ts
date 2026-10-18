/**
 * **測ったものを表にする** (`analyse.ts` の数え方)。ふだんの Chrome で測ったもの (`out/chrome.jsonl`。
 * 1 行に測った中身そのまま) も、Playwright の結果 (`out/decoded-most.jsonl`。数えた後) も読む。
 *
 *     bun tests/bench/report.ts tests/bench/out/chrome.jsonl
 */

import { readFileSync } from 'node:fs';
import { analyse, type Measured, type Path, type Result, summarize } from './analyse';

interface Raw {
    path: Path;
    value: number;
    load: string;
    run: number;
    measured: Measured & { ua?: string };
}

const lines = readFileSync(process.argv[2] ?? 'tests/bench/out/chrome.jsonl', 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Raw | Result);
const results = lines.map((line) => {
    if (!('measured' in line)) return line;
    const expected = line.path === 'mpeg2' ? 'ts-mpeg2' : 'fmp4';
    const result = analyse(
        line.path,
        line.value,
        line.load,
        line.run,
        line.measured,
        line.measured.input === expected,
    );
    console.log(JSON.stringify(result));
    return result;
});
const ua = lines.find((line): line is Raw => 'measured' in line)?.measured.ua;
if (ua !== undefined) console.log(ua);
console.log(summarize(results));
