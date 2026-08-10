/**
 * 借りもの (`src/lib/vendor/web-bml`) を上流の最新に写し直す。
 *
 * **写す相手は「いま置いてあるファイル」と同じ顔ぶれ。** 上流のどれが要るかは
 * `BMLBrowser` から辿って決めたもので、それを毎回たどり直すと「今回は何が
 * 増えた/減った」が読めなくなる。顔ぶれを固定しておけば、**上流が依存を
 * 増やしたときは `bun run check` が「そんなファイルは無い」で落ちる** —
 * それが「人が見て決め直せ」という札になる
 * ([README](../src/lib/vendor/web-bml/README.md))。
 *
 * 手を入れるのは README に書いてある2つだけ:
 *
 * - `.ts` の1行目に `@ts-nocheck` と断り書きを足す
 * - `client/interpreter/js_interpreter.ts` は**写さない** (denpa の1行を残す)
 *
 * 走らせるのは GitHub Actions (`.github/workflows/vendor-web-bml.yml`)。
 * 手元でも `bun .github/vendor-web-bml.ts <写した先>` で動く
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** 借りものの置き場 (リポジトリの根から) */
const VENDOR = 'src/lib/vendor/web-bml';
/** 上流 */
const UPSTREAM = 'https://github.com/otya128/web-bml';
/** denpa が書いたもの。**上流から写さない** (そのファイルの頭に理由) */
const OURS = new Set(['client/interpreter/js_interpreter.ts']);
/** `.ts` の頭に足す断り書き。README の「手を入れているのは2つだけ」の1つめ */
const HEADER = [
    '// @ts-nocheck',
    '// 借りもの。中身は書き換えない ([README](../README.md))。denpa 側の型検査は効いたまま',
    '',
].join('\n');
/** README の版を書いてある行 */
const VERSION_ROW = /^\| 版 \| `([0-9a-f]{40})` \(([\d-]+)\) \|$/m;
/** README の分量を書いてある行 */
const AMOUNT_ROW = /^\| 持ってきたもの \| `BMLBrowser` から辿れるもの \*\*(\d+)ファイル・([\d.]+)MB\*\* \|$/m;

/** その下にあるファイルを、置き場からの相対で全部 */
function walk(root: string, at = ''): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(join(root, at))) {
        const path = at === '' ? entry : `${at}/${entry}`;
        if (statSync(join(root, path)).isDirectory()) out.push(...walk(root, path));
        else out.push(path);
    }
    return out.sort();
}

const clone = process.argv[2];
if (clone === undefined || !existsSync(clone)) {
    console.error('使い方: bun .github/vendor-web-bml.ts <上流を写した先>');
    process.exit(2);
}

const readme = readFileSync(join(VENDOR, 'README.md'), 'utf8');
const version = VERSION_ROW.exec(readme);
if (version === null) {
    console.error(`README の版の行が読めません (${VERSION_ROW})`);
    process.exit(2);
}
const [, was] = version;

const now = Bun.spawnSync(['git', '-C', clone, 'rev-parse', 'HEAD']).stdout.toString().trim();
if (now === was) {
    console.log(`変わっていません (${was.slice(0, 12)})`);
    await Bun.write(process.env.GITHUB_OUTPUT ?? '/dev/null', 'changed=false\n');
    process.exit(0);
}

/*
 * **いま置いてあるものと同じ顔ぶれを写す。**
 *
 * README と LICENSE は別扱い — 前者は denpa が書いたもの、後者は
 * 上流の根に置いてある
 */
const held = walk(VENDOR).filter((p) => p !== 'README.md');
const copied: string[] = [];
const gone: string[] = [];

for (const path of held) {
    if (OURS.has(path)) continue;
    const from = join(clone, path);
    if (!existsSync(from)) {
        // 上流が消したもの。**残さない** — 残すと「まだあるつもり」で読んでしまう
        rmSync(join(VENDOR, path));
        gone.push(path);
        continue;
    }
    const body = readFileSync(from, 'utf8');
    mkdirSync(dirname(join(VENDOR, path)), { recursive: true });
    writeFileSync(join(VENDOR, path), path.endsWith('.ts') ? HEADER + body : body);
    copied.push(path);
}

/*
 * 分量を数え直す。**上流から持ってきたぶんだけ** — README の行が
 * 「`BMLBrowser` から辿れるもの」と言っているので、denpa が書いた1行
 * (`OURS`) も denpa の README も入れない
 */
const files = walk(VENDOR).filter((p) => p !== 'README.md' && !OURS.has(p));
const bytes = files.reduce((sum, p) => sum + statSync(join(VENDOR, p)).size, 0);
const day = Bun.spawnSync(['git', '-C', clone, 'show', '-s', '--format=%cs', 'HEAD']).stdout.toString().trim();

writeFileSync(
    join(VENDOR, 'README.md'),
    readme
        .replace(VERSION_ROW, `| 版 | \`${now}\` (${day}) |`)
        .replace(
            AMOUNT_ROW,
            `| 持ってきたもの | \`BMLBrowser\` から辿れるもの **${files.length}ファイル・${(bytes / 1024 / 1024).toFixed(1)}MB** |`,
        ),
);

console.log(`${was.slice(0, 12)} → ${now.slice(0, 12)} (${day})`);
console.log(`写した ${copied.length} / 上流から消えた ${gone.length}`);
for (const path of gone) console.log(`  消えた: ${path}`);

const summary = [
    `changed=true`,
    `was=${was}`,
    `now=${now}`,
    `day=${day}`,
    `files=${files.length}`,
    `gone=${gone.join(' ')}`,
].join('\n');
await Bun.write(process.env.GITHUB_OUTPUT ?? '/dev/null', `${summary}\n`);

// 上流の差分を PR の説明に貼る。**何が変わったかは向こうの履歴が語る**
const log = Bun.spawnSync([
    'git',
    '-C',
    clone,
    'log',
    '--no-merges',
    '--format=- %s (%h)',
    `${was}..${now}`,
]);
const body = [
    `[${was.slice(0, 12)}...${now.slice(0, 12)}](${UPSTREAM}/compare/${was}...${now}) (${day})`,
    '',
    '## 上流の変更',
    '',
    log.stdout.toString().trim() || '(履歴を辿れませんでした)',
    '',
    gone.length === 0 ? '' : `## 上流から消えた\n\n${gone.map((p) => `- \`${p}\``).join('\n')}\n`,
    '## 見るところ',
    '',
    '- `bun run check` が落ちていたら、**上流が新しいファイルを要りはじめた**か、',
    `  \`ResponseMessage\` / \`BMLBrowserOptions\` の型が変わったかのどちらか。`,
    `  前者なら \`${relative('.', VENDOR)}\` に写し足す (README の「更新のしかた」)`,
    '- 通っていても、**実際の放送で d を押すところまでは人が見る**',
].join('\n');
writeFileSync('/tmp/vendor-web-bml-body.md', body);
