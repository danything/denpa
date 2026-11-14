import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  encodeRuns,
  type EncodeSpan,
  encodeSpans,
  expect,
  goto,
  recordOne,
  reserveSoon,
  setRecording,
  syncEpg,
  test,
  upcoming,
  waitRowState,
  waitWatchable,
} from "./helpers";

/**
 * 録画をエンコードしたあと、CM の位置をチャプターとして書き足すところを確認する。
 * 録画からエンコードして保存先に入るまでの通しと、エンコードしないときは `03-recording`
 * (1 本で CI の組の時間を押し上げていたので分けた)
 */

test.describe("CM のチャプター", () => {
  test("CM はチャプターにするだけで切らない。字幕も残る", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);

    await goto(page, "/guide?type=BS");
    const cells = await upcoming(page);
    const target = cells[0]!;
    const res = await request.post("/guide?/reserve", {
      form: { programId: target.programId, options: "1", encode: "on" },
    });
    expect(res.ok()).toBeTruthy();

    const recordingRow = `[data-testid="recording-row"][data-program-id="${target.programId}"]`;
    await waitRowState(page, "/", page.locator(recordingRow), "視聴可能");

    await goto(page, "/");
    const recording = page.locator(recordingRow);
    expect(await recording.getAttribute("data-cm-ranges")).toContain("300");

    const videoPath = (await recording.getAttribute("data-library-path")) ?? "";
    expect(videoPath).toContain(".mkv");
    // チャプターを書き足すための作業ファイル (エンコードしたものの隣) は片付いていること
    expect(
      readdirSync(dirname(videoPath)).filter((name) =>
        /\.(post|chapters\.txt)$/.test(name),
      ),
    ).toEqual([]);

    /*
     * **1 回だけエンコードし、キーフレームは指さない** (CM で切らないので境目に置かなくてよい)。
     * 字幕はそのまま写す。チャプターはエンコードしたあとに `-c copy` で書き足す
     */
    const id = (await recording.getAttribute("data-recording-id")) ?? "";
    const mine = new RegExp(`-${id}\\.m2ts$`);
    const runs = existsSync(stack.encodeArgsFile)
      ? readFileSync(stack.encodeArgsFile, "utf8")
          .split("---\n")
          .map((run) => run.split("\n"))
          .filter((run) => run.some((a) => a.endsWith(".encoding")))
          .filter((run) =>
            run.some((a, i) => run[i - 1] === "-i" && mine.test(a)),
          )
      : [];
    expect(runs).toHaveLength(1);
    expect(runs[0]).not.toContain("-force_key_frames:v");
    expect(runs[0]).toContain("-c:s");
    expect(chapterRewrites(stack.encodeArgsFile, [videoPath])).toEqual([true]);
  });
});

test.describe("コーデックを両方エンコードする", () => {
  test.afterEach(async ({ request, stack }) => {
    rmSync(stack.encodeTogetherFile, { force: true });
    await setRecording(request);
  });

  /*
   * **両方選ぶと 1 本の録画が 2 ファイルになる。** 古いテレビは AV1 をデコードできない
   * ので H.264 も置いておくと、同じ録画をどちらの端末でも観られる。主は AV1
   * (`library_path`)、もう一方は H.264 (`alt_path`)。どちらも同じフォルダに
   * 並ぶので、H.264 のほうは名前に印を付けて分ける ([H264])。
   */
  test("AV1 と H.264 の 2 本ができて、どちらも観られる", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);
    await setRecording(request, { codecs: ["av1", "h264"] });
    // 偽 ffmpeg は 2 本そろって始まるまで終えない。2 本目の起動が遅れても重なりを時刻の差で見落とさない
    writeFileSync(stack.encodeTogetherFile, "2");

    const programId = await reserveSoon(page, request, "BS");
    const row = page.locator(
      `[data-testid="recording-row"][data-program-id="${programId}"]`,
    );
    await waitWatchable(page, row);

    // 主は AV1 (素の .mkv)、もう一方は H.264 ([H264] 付き)。実体も 2 本ある
    const av1 = (await row.getAttribute("data-library-path")) ?? "";
    const alt = (await row.getAttribute("data-alt-path")) ?? "";
    expect(av1).toMatch(/\.mkv$/);
    expect(av1).not.toContain("[H264]");
    expect(alt).toContain("[H264].mkv");
    expect(existsSync(av1)).toBe(true);
    expect(existsSync(alt)).toBe(true);

    // どちらのコーデックにもサムネイルが付く (消したとき残ったほうへ主を
    // 譲れるように、H.264 側へも写してある)
    for (const video of [av1, alt]) {
      expect(existsSync(`${video.replace(/\.mkv$/, "")}-poster.jpg`)).toBe(
        true,
      );
    }

    /*
     * **両方のぶんが行に出る。** 主 (AV1) だけ出していた頃は、画面の数字と
     * 置き場が実際に使っている量が食い違っていた (H.264 のほうが大きいことも
     * ある)。「H.264 …」が括弧の中に添う
     */
    await expect(row).toContainText(/\(H\.264 [\d.]+ ?[KMGT]?B/);

    // アプリ向けの一覧には両方のコーデックが並ぶ (古いテレビは H.264 を選んで観る)
    const id = Number(await row.getAttribute("data-recording-id"));
    const list = (await (await request.get("/api/recordings")).json()) as {
      id: number;
      files: { source: string; codec: string }[];
    }[];
    expect(list.find((item) => item.id === id)?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "encoded", codec: "av1" }),
        expect.objectContaining({ source: "alt", codec: "h264" }),
      ]),
    );

    /*
     * **2 本を同時にエンコードする** (コーデックごとに ffmpeg を 1 本ずつ。`encode-slots.ts`)。
     * 2 本のエンコードしていた間が重なっていること
     */
    const spans = encodeSpans(stack.encodeSpansFile, String(id));
    expect(
      spans.map((s) => s.output.replace(/^.*\.(\w+)\.encoding$/, "$1")),
    ).toEqual(expect.arrayContaining(["av1", "h264"]));
    expect(spans).toHaveLength(2);
    const [a, b] = spans as [EncodeSpan, EncodeSpan];
    expect(Math.max(a.start, b.start)).toBeLessThan(
      Math.min(a.end ?? 0, b.end ?? 0),
    );

    /*
     * **CM のチャプターは、どちらにもエンコードしたあとに書き足す** (`-c copy`)。
     * 境目は 1 本目をエンコードし終えてから決まるので、エンコードするときには入れない
     */
    expect(await row.getAttribute("data-cm-ranges")).toContain("300");
    expect(chapterRewrites(stack.encodeArgsFile, [av1, alt])).toEqual([
      true,
      true,
    ]);
  });
});

/** それぞれの置き場所の作業ファイル (`<置き場所>.<ジョブ>.<コーデック>.encoding`) に、チャプターを `-c copy` で書き足したか */
function chapterRewrites(file: string, placed: string[]): boolean[] {
  const runs = encodeRuns(file).filter(
    (run) => run.includes("-map_chapters") && run.includes("copy"),
  );
  return placed.map((path) =>
    runs.some((run) =>
      run.some(
        (a, i) =>
          run[i - 1] === "-i" &&
          a.startsWith(`${path}.`) &&
          a.endsWith(".encoding"),
      ),
    ),
  );
}

test.describe("CM 検出のやり直し", () => {
  test.afterEach(async ({ request }) => {
    await setRecording(request);
  });

  /*
   * **CM 検出だけやり直す** (詳細の「その他…」)。再エンコードせずに CM を探し直して、エンコードしたもののチャプターを
   * 書き直す (`encoder.runCmJob`)。
   * 元の TS はエンコードし終えると消える設定 (既定) なので、エンコードしたものから読む
   */
  test("CM 検出だけやり直せる (再エンコードしない)", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    const { id, libraryPath } = await recordOne(page, request);
    const row = page.locator(
      `[data-testid="recording-row"][data-recording-id="${id}"]`,
    );
    expect(await row.getAttribute("data-cm-ranges")).toContain("300");
    /** 置いてあるもの (`libraryPath`) そのものに、チャプターを `-c copy` で書き直した回数 */
    const rewrote = (run: string[]) =>
      run.includes("-map_chapters") &&
      run.some((a, i) => run[i - 1] === "-i" && a === libraryPath);
    const rewrites = () =>
      encodeRuns(stack.encodeArgsFile).filter(rewrote).length;
    expect(rewrites()).toBe(0);

    await goto(page, "/");
    await row.getByTestId("detail-button").click();
    const detail = page.getByTestId("program-detail");
    await detail.getByTestId("detail-more").click();
    await detail.getByTestId("cm-redo-button").click();

    // エンコードするジョブと同じ待ち行列に並ぶ。終わればチャプターを書き直し、置き場所は変わらない (再エンコードしていない)
    await expect.poll(rewrites, { timeout: 60_000, intervals: [500] }).toBe(1);
    await waitWatchable(page, row);
    expect(await row.getAttribute("data-cm-ranges")).toContain("300");
    expect(await row.getAttribute("data-library-path")).toBe(libraryPath);
  });
});
