/*
 * ../docs/*.md と ../README.md を Starlight の文書として書き出す (`bun run dev` / `build` の前に走る)。
 *
 * docs 側は GitHub で読める形のまま持ち、frontmatter も足さない。ここで足すもの・直すもの:
 *   - frontmatter: title (先頭の H1。本文からは外す)・description (最初の段落)・editUrl・lastUpdated。
 *     src/data/pages.ts で上書きできる
 *   - リンク: 公開する docs はサイト内へ、それ以外 (../src など) は GitHub へ
 *   - 画像: docs/images を src/assets/docs に写し、Astro の画像の最適化が効く相対パスにする。
 *     README の <img> も Markdown の画像に直す。動く画像 (AVIF) は Astro (sharp) が読めないので、
 *     public/images に写して <img> で出す
 *   - GitHub の注意書き (`> [!NOTE]` など) は Starlight の aside (`:::note` など) に
 *   - 放送の映像が映る画像には、偽の放送だという添え書き
 *
 * README はページにせず、トップ (src/pages/index.astro) が読む節ごとの Markdown に切り出す
 * (src/generated/readme/*.md と top.json。どの節を出すかは src/data/pages.ts の topSections)。
 *
 * 書き出す先 (src/content/docs・src/assets/docs・public/images・src/generated) は毎回作り直し、git には入れない
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";

import {
  docNames,
  docsDir,
  repoDir,
  siteDir,
  slugOf,
} from "../src/data/docs.ts";
import {
  base,
  overrides,
  repoUrl,
  siteUrl,
  topEntrances,
  topSections,
  videoImageNote,
  videoImages,
} from "../src/data/pages.ts";

const outDocs = join(siteDir, "src/content/docs");
const outImages = join(siteDir, "src/assets/docs");
/** 動く画像 (AVIF) の置き場。Astro の画像の最適化を通さない */
const outAnimImages = join(siteDir, "public/images");
const outGenerated = join(siteDir, "src/generated");
const outReadme = join(outGenerated, "readme");

const published = new Set(docNames());

interface Source {
  /** pages.ts のキー (docs のファイル名 / README) */
  name: string;
  /** リポジトリの中のパス (docs/install.md) */
  path: string;
}

const readme: Source = { name: "README", path: "README.md" };
const sources: Source[] = [...published].map((name) => ({
  name,
  path: `docs/${name}.md`,
}));
const readmeText = readSource(readme.path);
const readmeSections = sectionsOf(readmeText.split("\n"));

// 先頭の H1 の見出しの id。H1 は本文から外して Starlight のページの見出し (id は `_top`) になるので、
// そこへのリンクは付け替える
const h1Anchors = new Map(
  [readme, ...sources].map((s) => {
    const h1 = findH1(readSource(s.path).split("\n"));
    return [s.path, h1 ? slugify(h1.title) : undefined] as const;
  }),
);

rmSync(outDocs, { recursive: true, force: true });
rmSync(outImages, { recursive: true, force: true });
rmSync(outAnimImages, { recursive: true, force: true });
rmSync(outGenerated, { recursive: true, force: true });
mkdirSync(outDocs, { recursive: true });
mkdirSync(outGenerated, { recursive: true });
copyImages();

// トップに出す README の節の id。README へのリンクのうち、これ以外の節へのものは GitHub の README へ
const topAnchors = new Set(
  topSections
    .filter((t) => findSection(t.heading) !== undefined)
    .map((t) => slugify(t.heading)),
);

let gitWarned = false;
/** 書き出したページの title と description (トップの入口のカードが使う) */
const pageMeta = new Map<string, { title: string; description: string }>();
for (const source of sources) {
  const text = readSource(source.path);
  const outFile = join(outDocs, `${slugOf(source.name)}.md`);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, convert(text, source, outFile));
}
writeFileSync(
  join(outGenerated, "usage.json"),
  `${JSON.stringify(usageNotice(), null, 4)}\n`,
);
writeFileSync(
  join(outGenerated, "top.json"),
  `${JSON.stringify(top(), null, 4)}\n`,
);
console.log(
  `import-docs: ${sources.length} ページと、トップに出す README の節を書き出しました`,
);

function readSource(path: string): string {
  return readFileSync(join(repoDir, path), "utf8").replaceAll("\r\n", "\n");
}

/** 先頭の H1 (最初のコードの囲みより前にあるもの) */
function findH1(lines: string[]): { index: number; title: string } | undefined {
  for (const [index, line] of lines.entries()) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) return undefined;
    if (/^# \S/.test(line)) return { index, title: line.slice(2).trim() };
  }
  return undefined;
}

function copyImages(): void {
  const from = join(docsDir, "images");
  if (!existsSync(from)) return;
  mkdirSync(outImages, { recursive: true });
  mkdirSync(outAnimImages, { recursive: true });
  for (const f of readdirSync(from)) {
    if (statSync(join(from, f)).isFile())
      copyFileSync(
        join(from, f),
        join(f.endsWith(".avif") ? outAnimImages : outImages, f),
      );
  }
}

/**
 * 動く画像 (AVIF) の Markdown の画像を <img> にする。Astro の画像の最適化を通さないので、
 * 大きさ (読み込む前に場所を空けておく) と後から読む指定はここで付ける
 */
function animImages(text: string): string {
  return text.replace(
    new RegExp(`!\\[([^\\]]*)\\]\\((${base}images/([^)\\s]+\\.avif))\\)`, "g"),
    (_, alt: string, src: string, file: string) => {
      const { width, height } = avifSize(join(outAnimImages, file));
      return `<img src="${src}" alt="${alt.replaceAll('"', "&quot;")}" width="${width}" height="${height}" loading="lazy" decoding="async">`;
    },
  );
}

/** AVIF の幅と高さ (ispe の箱。version・flags の 4 バイトのあとに幅と高さ) */
function avifSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  const at = buf.indexOf("ispe");
  if (at < 0) throw new Error(`import-docs: ${file} の大きさが読めません`);
  return { width: buf.readUInt32BE(at + 8), height: buf.readUInt32BE(at + 12) };
}

function convert(text: string, source: Source, outFile: string): string {
  const override = overrides[source.name] ?? {};
  const lines = text.split("\n");

  // 先頭の H1 を title にして、本文から外す (Starlight がページの見出しとして出す)
  let title = source.name;
  const h1 = findH1(lines);
  if (h1) {
    title = h1.title;
    lines.splice(h1.index, lines[h1.index + 1] === "" ? 2 : 1);
  }
  let body = lines.join("\n");
  body = convertReadmeHtml(body);
  body = convertAlerts(body);
  body = rewriteLinks(body, source.path, outFile);
  body = animImages(body);
  body = addVideoNotes(body);

  const description = override.description ?? describe(body);
  pageMeta.set(source.name, { title: override.title ?? title, description });
  const front: string[] = [`title: ${JSON.stringify(override.title ?? title)}`];
  if (description) front.push(`description: ${JSON.stringify(description)}`);
  front.push(
    `editUrl: ${JSON.stringify(`${repoUrl}/edit/main/${source.path}`)}`,
  );
  const updated = lastCommit(source.path);
  // 引用符を付けない (YAML の日時として読ませ、Date で渡す)
  if (updated) front.push(`lastUpdated: ${updated}`);
  return `---\n${front.join("\n")}\n---\n\n${body.trimStart()}`;
}

/** README の一部を、サイトで読める形に直す (画像・リンク・注意書き・添え書き) */
function convertReadmePart(text: string, outFile: string): string {
  let body = convertReadmeHtml(text);
  body = convertAlerts(body);
  body = rewriteLinks(body, readme.path, outFile);
  body = animImages(body);
  body = linkIssueNumbers(body);
  return addVideoNotes(body).trim();
}

/**
 * 本文の `#188` を、その番号の Issue・PR・Discussion へのリンクにする (GitHub の README では
 * ひとりでにリンクになるが、サイトでは字のままになる。issues/<番号> は PR や Discussion にも飛ぶ)。
 * リンクの字の中 (`[Discussion #760](…)`)・URL の中・コードの中は触らない
 */
function linkIssueNumbers(text: string): string {
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (!fence) fence = f[1]!;
        else if (line.trim().startsWith(fence)) fence = undefined;
        return line;
      }
      if (fence) return line;
      // `…` の中は奇数番目に来る
      return line
        .split("`")
        .map((part, i) =>
          i % 2
            ? part
            : part.replace(
                /(?<![\w/#[])#(\d+)(?![\w\]])/g,
                (_, n: string) => `[#${n}](${repoUrl}/issues/${n})`,
              ),
        )
        .join("`");
    })
    .join("\n");
}

/** 見出しごとの中身 (下の段の見出しも含む)。コードの囲みの中の `#` (シェルのコメント) は見出しにしない */
function sectionsOf(lines: string[]): { heading: string; body: string }[] {
  const heads: { level: number; heading: string; index: number }[] = [];
  let fence: string | undefined;
  for (const [index, line] of lines.entries()) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1]!;
      else if (line.trim().startsWith(fence)) fence = undefined;
      continue;
    }
    const m = fence ? null : /^(#{1,6}) (.+)$/.exec(line);
    if (m) heads.push({ level: m[1]!.length, heading: m[2]!.trim(), index });
  }
  return heads.map((h, k) => {
    const end =
      heads.slice(k + 1).find((n) => n.level <= h.level)?.index ?? lines.length;
    return {
      heading: h.heading,
      body: lines
        .slice(h.index + 1, end)
        .join("\n")
        .trim(),
    };
  });
}

/** README の節の中身 (見出しの行は除く)。無ければ undefined */
function findSection(heading: string): string | undefined {
  return readmeSections.find((s) => s.heading === heading)?.body;
}

/**
 * トップ (src/pages/index.astro) が読むもの。README の冒頭 (H1 の下から最初の `##` まで) と
 * topSections の節を src/generated/readme/*.md に書き、節の見出し・ページの説明・入口のカードを返す
 * (top.json)。節や文書が無くなっていたら、そこは出さない (節は warn も出す)
 */
function top() {
  mkdirSync(outReadme, { recursive: true });
  const write = (key: string, text: string) => {
    const outFile = join(outReadme, `${key}.md`);
    const converted = convertReadmePart(text, outFile);
    writeFileSync(outFile, `${converted}\n`);
    return converted;
  };
  const lines = readmeText.split("\n");
  const from = (findH1(lines)?.index ?? -1) + 1;
  const next = lines.findIndex((l, i) => i >= from && l.startsWith("## "));
  // サイトそのものへの案内 (GitHub で読む人向けの 1 行) はトップには出さない
  const intro = write(
    "intro",
    lines
      .slice(from, next < 0 ? undefined : next)
      .filter((l) => !l.includes(`](${siteUrl})`))
      .join("\n"),
  );

  const sections = topSections.flatMap((t) => {
    const body = findSection(t.heading);
    if (body === undefined) {
      console.warn(
        `import-docs: README に「${t.heading}」の節が無いので、トップには出しません`,
      );
      return [];
    }
    write(t.key, body);
    return [
      {
        key: t.key,
        id: slugify(t.heading),
        heading: t.label ?? t.heading,
        end: t.end ?? false,
      },
    ];
  });

  const page = (name: string) => {
    const meta = pageMeta.get(name);
    return meta && { ...meta, href: `${base}${slugOf(name)}/` };
  };
  const entrances = topEntrances.flatMap((e) => {
    const main = page(e.doc);
    if (!main) return [];
    const more = (e.more ?? []).flatMap((n) => {
      const p = page(n);
      return p ? [{ title: p.title, href: p.href }] : [];
    });
    return [
      { label: e.label, href: main.href, description: main.description, more },
    ];
  });

  return { description: describe(intro), sections, entrances };
}

/** git の最後のコミットの日時。git が無い所 (手元のコンテナなど) では付けない */
function lastCommit(path: string): string | undefined {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", path], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    if (!gitWarned)
      console.warn("import-docs: git が読めないので、最終更新日は付けません");
    gitWarned = true;
    return undefined;
  }
}

/** 囲み (```) の外の行にだけ fn を当てる。囲みの中のコードはそのまま */
function mapOutsideFences(text: string, fn: (line: string) => string): string {
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const m = /^\s*(`{3,}|~{3,})/.exec(line);
      if (m) {
        if (!fence) fence = m[1]![0]!.repeat(m[1]!.length);
        else if (line.trim().startsWith(fence)) fence = undefined;
        return line;
      }
      return fence ? line : fn(line);
    })
    .join("\n");
}

/** 行の中の `code` の外側にだけ fn を当てる */
function mapOutsideCode(line: string, fn: (part: string) => string): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

function rewriteLinks(text: string, fromPath: string, outFile: string): string {
  const resolve = (target: string) => resolveTarget(target, fromPath, outFile);
  return mapOutsideFences(text, (line) =>
    mapOutsideCode(line, (part) =>
      part
        .replace(
          /\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
          (_, t: string, rest: string) => `](${resolve(t)}${rest})`,
        )
        .replace(
          /\b(href|src)="([^"]+)"/g,
          (_, a: string, t: string) => `${a}="${resolve(t)}"`,
        ),
    ),
  );
}

/** H1 への #… はページの頭 (同じページなら #_top、ほかのページなら # を付けない) */
function isH1Anchor(path: string, hash: string): boolean {
  const anchor = h1Anchors.get(path);
  return !!anchor && decodeURIComponent(hash.slice(1)) === anchor;
}

function resolveTarget(
  target: string,
  fromPath: string,
  outFile: string,
): string {
  if (target.startsWith("#"))
    return isH1Anchor(fromPath, target) ? "#_top" : target;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//"))
    return target;
  const at = target.indexOf("#");
  const path = at >= 0 ? target.slice(0, at) : target;
  let hash = at >= 0 ? target.slice(at) : "";
  const isDirLink = path.endsWith("/");
  const repoPath = posix
    .normalize(posix.join(posix.dirname(fromPath), decodeURI(path)))
    .replace(/\/$/, "");
  if (repoPath.startsWith("..")) return target;
  if (isH1Anchor(repoPath, hash)) hash = "";

  if (repoPath === "README.md") {
    // トップに出していない節は GitHub の README で読む
    if (!hash || topAnchors.has(decodeURIComponent(hash.slice(1))))
      return `${base}${hash}`;
    return `${repoUrl}/blob/main/README.md${hash}`;
  }
  const doc = /^docs\/([^/]+)\.md$/.exec(repoPath);
  if (doc && published.has(doc[1]!)) {
    const slug = slugOf(doc[1]!);
    return `${base}${slug ? `${slug}/` : ""}${hash}`;
  }
  if (repoPath.startsWith("docs/images/") && repoPath.endsWith(".avif"))
    return `${base}images/${posix.basename(repoPath)}`;
  if (repoPath.startsWith("docs/images/")) {
    const rel = posix.relative(
      toPosix(dirname(outFile)),
      toPosix(join(outImages, posix.basename(repoPath))),
    );
    return rel.startsWith(".") ? rel : `./${rel}`;
  }
  const full = join(repoDir, repoPath);
  const isDir = isDirLink || (existsSync(full) && statSync(full).isDirectory());
  return `${repoUrl}/${isDir ? "tree" : "blob"}/main/${repoPath}${hash}`;
}

/** GitHub の注意書きを Starlight の aside (`:::note` …) に直す。コードの囲みの中は触らない */
function convertAlerts(text: string): string {
  // GitHub の注意書きの種類と、それに当てる Starlight の aside
  const alertTypes: Record<string, string> = {
    NOTE: "note",
    TIP: "tip",
    // 「取り返しがつかない」のような、読み飛ばすと困るもの。素直に注意の枠にする
    IMPORTANT: "caution",
    WARNING: "caution",
    CAUTION: "danger",
  };
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1]!;
      else if (line.trim().startsWith(fence)) fence = undefined;
    }
    const m = fence
      ? null
      : /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const inner: string[] = [];
    while (i + 1 < lines.length && lines[i + 1]!.startsWith(">")) {
      i++;
      inner.push(lines[i]!.replace(/^> ?/, ""));
    }
    out.push(`:::${alertTypes[m[1]!]}`, ...inner, ":::");
  }
  return out.join("\n");
}

function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-z-]+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

/**
 * README の生の HTML の画像を Markdown に直す (HTML のままだと Astro の画像の最適化が効かない)。
 * 真ん中に置いた 1 枚は画像に、画像を並べた表は `.shots` の並びにする
 */
function convertReadmeHtml(text: string): string {
  const image = (tag: string) => {
    const a = attrs(tag);
    return `![${a["alt"] ?? ""}](${a["src"] ?? ""})`;
  };
  let out = text.replace(
    /<p[^>]*>\s*(<img [^>]*>)\s*<\/p>/g,
    (_, img: string) => image(img),
  );
  out = out.replace(/<table>([\s\S]*?)<\/table>/g, (whole, inner: string) => {
    const cells = [...inner.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
      (m) => m[1]!,
    );
    if (!cells.length || !cells.every((c) => c.includes("<img"))) return whole;
    const items = cells.map((cell) => {
      const img = /<img [^>]*>/.exec(cell)![0];
      const link = /<a href="([^"]+)"/.exec(cell)?.[1];
      const caption = cell
        .replace(/<a [^>]*>|<\/a>|<img [^>]*>|<br\s*\/?>|<\/?sub>/g, "")
        .replace(/<\/?b>/g, "**")
        .trim();
      const shot = link ? `[${image(img)}](${link})` : image(img);
      return caption ? `${shot}\n${caption}` : shot;
    });
    return `<div class="shots">\n\n${items.join("\n\n")}\n\n</div>`;
  });
  // 上の形に当てはまらなかった <img> も、画像だけは Markdown にする
  return out.replace(
    /<img [^>]*src="(?:\.\/)?docs\/images\/[^"]*"[^>]*>/g,
    (img) => {
      console.warn(
        `import-docs: README の <img> を形を崩して画像にしました: ${img}`,
      );
      return image(img);
    },
  );
}

/**
 * 放送の映像が映る画像の下に、偽の放送だという添え書きを付ける。
 * 並べた画像 (`.shots`) は 1 つずつではなく、並びの下に 1 回だけ。すぐ上 (数段落の中) に付けたばかりなら重ねない
 */
function addVideoNotes(text: string): string {
  const note = `<p class="video-note">${videoImageNote}</p>`;
  const hasVideo = (block: string) =>
    videoImages.some(
      (f) =>
        block.includes(`/assets/docs/${f})`) ||
        block.includes(`/assets/docs/${f}"`) ||
        block.includes(`${base}images/${f}"`),
    );
  // 空行ちょうどで割り、同じ形でつなぎ直す (コードの囲みの中の、続いた空行を潰さない)
  const blocks = text.split("\n\n");
  const out: string[] = [];
  let lastNote = -Infinity;
  const pushNote = () => {
    if (out.length - lastNote > 4) {
      out.push(note);
      lastNote = out.length;
    }
  };
  let inShots = false;
  let shotsVideo = false;
  for (const block of blocks) {
    out.push(block);
    if (block.trimStart().startsWith('<div class="shots">')) {
      inShots = true;
      shotsVideo = false;
      continue;
    }
    if (inShots) {
      if (block.trim() === "</div>") {
        inShots = false;
        if (shotsVideo) pushNote();
      } else if (hasVideo(block)) shotsVideo = true;
      continue;
    }
    if (/^!\[|^\[!\[|^<img /.test(block.trim()) && hasVideo(block)) pushNote();
  }
  return out.join("\n\n");
}

/** 最初の段落を平文にして、120 字ほどに */
function describe(body: string): string {
  const blocks = body.split(/\n{2,}/).map((b) => b.trim());
  const para = blocks.find(
    (b) => b && !/^(#|<|!\[|\[!\[|```|~~~|\||- |\* |\d+\. |>|:::)/.test(b),
  );
  if (!para) return "";
  const plain = para
    .split("\n")
    .map((l) => l.trim())
    .reduce(
      (acc, l) =>
        !acc
          ? l
          : /[\x21-\x7e]$/.test(acc) && /^[\x21-\x7e]/.test(l)
            ? `${acc} ${l}`
            : acc + l,
      "",
    )
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    // 閉じていないタグの切れ端も残さない
    .replace(/[<>]/g, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= 120) return plain;
  const cut = plain.lastIndexOf("。", 120);
  return cut >= 60 ? plain.slice(0, cut + 1) : `${plain.slice(0, 119)}…`;
}

/**
 * 全ページの下に出す「使ってよい範囲」の要約。文は README の節の最初の段落から取り、二重に書かない。
 * 節が無くなっていたら出さない (warn だけ)
 */
function usageNotice(): {
  summary: string;
  anchor: string;
  discussion?: { label: string; url: string };
} | null {
  const heading = "使ってよい範囲";
  const section = findSection(heading);
  if (section === undefined) {
    console.warn(
      `import-docs: README に「${heading}」の節が無いので、ページの下の要約は出しません`,
    );
    return null;
  }
  const summary = section
    .trim()
    .split(/\n{2,}/)[0]!
    .split("\n")
    .map((l) => l.trim())
    .join("");
  const link =
    /\[([^\]]+)\]\((https:\/\/github\.com\/[^)]+\/discussions\/\d+)\)/.exec(
      section,
    );
  return {
    summary,
    anchor: `${base}#${heading}`,
    ...(link ? { discussion: { label: link[1]!, url: link[2]! } } : {}),
  };
}

/**
 * 見出しの id。GitHub (github-slugger) と同じ作り方: 小文字にし、字・数字・`-`・`_`・空白のほかを消して、
 * 空白を `-` にする。Astro が付ける見出しの id も同じ
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replaceAll(" ", "-");
}
