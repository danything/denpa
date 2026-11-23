import type { CaptionPage, CaptionRun } from "@danything/arib/caption-text";

/**
 * **字幕の 1 枚を文字にする** (探すため)。切り抜きに添える文字 (`POST /api/clips` の `captions`) と、
 * 録画の字幕で探すときに見せる文字に使う。画面とサーバの両方から読む。
 *
 * 字の並びを上から行ごとにつなぎ、行の間に空白を 1 つ入れる。ルビと外字の代わりの「〓」は落とす
 */
export function captionWords(page: CaptionPage | null): string {
  if (page === null) return "";
  const lines = new Map<number, CaptionRun[]>();
  for (const run of page.runs) {
    if (run.ruby === true || run.drcs !== undefined) continue;
    const line = lines.get(run.y) ?? [];
    line.push(run);
    lines.set(run.y, line);
  }
  return [...lines.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, runs]) =>
      runs
        .sort((a, b) => a.x - b.x)
        .map((run) => run.text)
        .join("")
        .trim(),
    )
    .filter(Boolean)
    .join(" ");
}
