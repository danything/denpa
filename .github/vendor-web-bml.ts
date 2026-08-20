/**
 * 借りもの (`src/lib/vendor/web-bml`) を上流の最新に写し直す。
 *
 * **写す顔ぶれは、denpa が呼ぶ入口から `import` を辿って決めます** (`ROOTS`)。
 *
 * 前は「いま置いてあるファイル」を顔ぶれに固定していました。上流が依存を
 * 増やしたときに `bun run check` が「そんなファイルは無い」で落ち、それが
 * 「人が見て決め直せ」という札になる、という考えでした。**札の出し方が
 * ビルド失敗なのが良くなかった** — 2026-08 の追従で上流が4ファイル増やし
 * (`util/logger` ほか)、PR が丸ごと組めない状態で出ました。増えたことは
 * 分かっても、**中身を読む前に手を動かすことになる**。
 *
 * 辿って決めれば、同じ出来事は**PR の説明の「増えた」1行**になります。
 * 顔ぶれが機械的に決まることは確かめてあります — 固定していた 44 ファイルと、
 * 入口から辿った閉包は**完全に一致**しました。
 *
 * 手を入れるのは1つだけ: `.ts` の1行目に `@ts-nocheck` と断り書きを足す。
 * (`js_interpreter.ts` だけ denpa が書いていた時期がありますが、上流が
 * ファイルごと消したので、いまは写しが完全に機械的です)
 *
 * 走らせるのは GitHub Actions (`.github/workflows/vendor-web-bml.yml`)。
 * 手元でも `bun .github/vendor-web-bml.ts <写した先>` で動く
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 借りものの置き場 (リポジトリの根から) */
const VENDOR = 'src/lib/vendor/web-bml';
/** 上流 */
const UPSTREAM = 'https://github.com/otya128/web-bml';
/**
 * **辿りはじめる入口。** denpa が `$lib/vendor/web-bml/...` として直に呼ぶもの
 * だけを並べる。ここから `import` を辿った先が、写す顔ぶれになる
 */
const ROOTS = [
    'client/bml_browser.ts',
    'client/content.ts',
    'server/entity_parser.ts',
    'server/ws_api.ts',
];
/** 辿りでは出てこないが要るもの。上流の根に置いてある */
const EXTRA = ['LICENSE'];
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

/**
 * `import` の相手を実際のファイルに直す。**相対のものだけ見る** —
 * 外から引くもの (`crc-32` など) は package.json の仕事
 */
function resolveImport(root: string, from: string, spec: string): string | null {
    const at = join(dirname(from), spec).replaceAll('\\', '/');
    for (const candidate of [`${at}.ts`, `${at}.tsx`, `${at}/index.ts`]) {
        if (existsSync(join(root, candidate))) return candidate;
    }
    return null;
}

/**
 * 入口から `import` を辿って、要るファイルを全部集める。
 *
 * **`import()` と副作用だけの `import "…"` も辿ります** — 前者を落とすと
 * 遅延読み込みの先が欠け、組んだあとに初めて転ぶ。
 *
 * 型だけの `import type` も同じに辿ります。**型が欠けても検査は落ちる**ので、
 * 実体と分ける意味がない
 */
function reachable(root: string, roots: string[]): { files: string[]; missing: string[] } {
    const seen = new Set<string>();
    const missing: string[] = [];
    const stack = [...roots];
    // `from "…"` / `import("…")` / `import "…"` の3つ
    const IMPORTS = /from\s*["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)|import\s+["'](\.[^"']+)["']/g;
    while (stack.length > 0) {
        const path = stack.pop() as string;
        if (seen.has(path)) continue;
        if (!existsSync(join(root, path))) {
            missing.push(path);
            continue;
        }
        seen.add(path);
        const body = readFileSync(join(root, path), 'utf8');
        for (const found of body.matchAll(IMPORTS)) {
            const spec = found[1] ?? found[2] ?? found[3];
            const next = resolveImport(root, path, spec);
            if (next === null) missing.push(`${path} → ${spec}`);
            else stack.push(next);
        }
    }
    return { files: [...seen].sort(), missing };
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
 * **入口から辿って顔ぶれを決める** (`ROOTS`)。README は denpa が書いたものなので
 * 触らない
 */
const { files: wanted, missing } = reachable(clone, ROOTS);
if (missing.length > 0) {
    // 入口そのものが消えた・辿れない先がある。**黙って写すと木が壊れる**
    console.error('辿れない相手があります。上流の作りが変わったかもしれません:');
    for (const path of missing) console.error(`  ${path}`);
    process.exit(1);
}
if (wanted.length < ROOTS.length) {
    console.error(`辿れたのが ${wanted.length} ファイルしかありません。写すのをやめます`);
    process.exit(1);
}

const want = new Set([...wanted, ...EXTRA]);
const held = walk(VENDOR).filter((p) => p !== 'README.md');
const copied: string[] = [];
const gone: string[] = [];

// **要らなくなったものは残さない** — 残すと「まだあるつもり」で読んでしまう
for (const path of held) {
    if (want.has(path)) continue;
    rmSync(join(VENDOR, path));
    gone.push(path);
}

const added = [...want].filter((path) => !held.includes(path)).sort();

for (const path of [...want].sort()) {
    const body = readFileSync(join(clone, path), 'utf8');
    mkdirSync(dirname(join(VENDOR, path)), { recursive: true });
    writeFileSync(join(VENDOR, path), path.endsWith('.ts') ? HEADER + body : body);
    copied.push(path);
}

/*
 * 分量を数え直す。**上流から持ってきたぶんだけ** — README の行が
 * 「`BMLBrowser` から辿れるもの」と言っているので、denpa の README は入れない
 */
const files = walk(VENDOR).filter((p) => p !== 'README.md');
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
console.log(`写した ${copied.length} / 増えた ${added.length} / 要らなくなった ${gone.length}`);
for (const path of added) console.log(`  増えた: ${path}`);
for (const path of gone) console.log(`  要らなくなった: ${path}`);

const summary = [
    `changed=true`,
    `was=${was}`,
    `now=${now}`,
    `day=${day}`,
    `files=${files.length}`,
    `added=${added.join(' ')}`,
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
    added.length === 0
        ? ''
        : `## 増えた (上流が新しく要りはじめた)\n\n${added.map((p) => `- \`${p}\``).join('\n')}\n`,
    gone.length === 0
        ? ''
        : `## 要らなくなった\n\n${gone.map((p) => `- \`${p}\``).join('\n')}\n`,
    '## 見るところ',
    '',
    '- **増えた・要らなくなったファイルがあれば、それが上流の作りの変わり目**。',
    `  顔ぶれは入口 (\`${ROOTS.join('`, `')}\`) から \`import\` を辿って決めている`,
    '- `bun run check` が落ちていたら、**`ResponseMessage` / `BMLBrowserOptions` の',
    '  型が変わった**ということ。響く先は `ts/bml.ts` と `DataBroadcast.svelte`',
    '- 通っていても、**実際の放送で d を押すところまでは人が見る**',
].join('\n');
writeFileSync('/tmp/vendor-web-bml-body.md', body);
