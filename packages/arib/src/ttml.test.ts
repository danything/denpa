import { describe, expect, test } from "bun:test";

import { CLOCK } from "./mmt-media.js";
import { ttmlPages } from "./ttml.js";

/** B62 の字幕の文書に似せたもの (1920x1080、下の領域に中央寄せで 2 行) */
const DOCUMENT = `<?xml version="1.0" encoding="UTF-8"?>
<tt xml:lang="ja" xmlns="http://www.w3.org/ns/ttml"
    xmlns:tts="http://www.w3.org/ns/ttml#styling"
    xmlns:ttp="http://www.w3.org/ns/ttml#parameter"
    ttp:timeBase="media" tts:extent="1920px 1080px">
  <head>
    <styling>
      <style xml:id="base" tts:fontSize="60px" tts:color="white" tts:textOutline="black 3px"/>
      <style xml:id="yellow" style="base" tts:color="#ffff00"/>
    </styling>
    <layout>
      <region xml:id="bottom" tts:origin="160px 840px" tts:extent="1600px 180px"
              tts:textAlign="center" tts:displayAlign="after"/>
    </layout>
  </head>
  <body>
    <div>
      <p begin="00:00:00.500" end="00:00:02.000" region="bottom" style="base">
        <span>ＡＢ</span><br/>
        <span style="yellow">Hi &amp; 字</span>
      </p>
      <p begin="1s" dur="3s" region="bottom" style="base" tts:lineHeight="90px">
        <span tts:ruby="container"><span tts:ruby="base">漢字</span><span tts:ruby="text">かんじ</span></span>
      </p>
    </div>
  </body>
</tt>`;

const START = 1_000_000;

describe("ttmlPages", () => {
  const pages = ttmlPages(DOCUMENT, START);

  test("段落の出る・消える時刻ごとに 1 枚。最初は文書の始まりの空の 1 枚", () => {
    expect(pages.map((p) => (p.at - START) / CLOCK)).toEqual([0, 0.5, 1, 2, 4]);
    expect(pages.map((p) => p.page.runs.length > 0)).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
    for (const { page } of pages) {
      expect(page.plane).toEqual([1920, 1080]);
      expect(page.duration).toBeNull();
    }
  });

  test("文字・色・縁取り・位置", () => {
    const runs = pages[1]!.page.runs;
    expect(runs.map((r) => r.text)).toEqual(["ＡＢ", "Hi & ", "字"]);
    const [first, half, wide] = runs;
    expect(first).toMatchObject({
      size: 60,
      w: 60,
      h: 72,
      fg: "#ffffffff",
      stroke: "#000000ff",
    });
    // 半角は区画の幅が半分
    expect(half).toMatchObject({ w: 30, fg: "#ffff00ff" });
    expect(wide).toMatchObject({ w: 60, fg: "#ffff00ff" });
    // 2 行 (72 ずつ) を領域 (840〜1020) の下に寄せ、1 行目は 120 の幅を領域の中央に
    expect(first!.y).toBe(1020 - 144);
    expect(first!.x).toBe(160 + (1600 - 120) / 2);
    expect(half!.y).toBe(1020 - 72);
  });

  test("ルビは親字の上に半分の大きさで置く", () => {
    const runs = pages[3]!.page.runs;
    const base = runs.find((r) => r.text === "漢字")!;
    const ruby = runs.filter((r) => r.ruby === true);
    expect(ruby.map((r) => r.text).join("")).toBe("かんじ");
    expect(ruby[0]!.size).toBe(30);
    expect(ruby[0]!.y).toBe(base.y - 30);
    // 親字 120 の幅の中央に、ルビ 90 の幅
    expect(ruby[0]!.x).toBe(base.x + 15);
  });

  test("読めない文書は何も返さない", () => {
    expect(ttmlPages("<tt><p>", START)).toEqual([]);
    expect(ttmlPages("not xml", START)).toEqual([]);
  });
});
