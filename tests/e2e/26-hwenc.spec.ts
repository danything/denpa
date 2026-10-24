import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import {
  expect,
  goto,
  reserveSoon,
  setRecording,
  syncEpg,
  test,
  waitWatchable,
} from "./helpers";

/**
 * GPU でエンコードする (server/hwenc.ts)。
 *
 * **GPU は偽物** — `stack.hwDir` に `renderD128` のような名前でファイルを置くと
 * denpa にはデバイスとして見え、偽 ffmpeg は渡されたデバイスが在るのを見て QSV / VA-API の
 * 試しのエンコードを通す。消せば、エンコードしようとした GPU の方式が本物と同じく初期化で落ちる
 * (次の方式・ソフトウェアへ倒れるのを試せる)
 */

/**
 * エンコードするときに偽 ffmpeg へ渡された引数、1回ぶんずつ。**書き途中の名前 (`.encoding`) へ
 * 出しているものだけ** — サムネイルなど、同じ経路を通る他の呼び出しは省く。
 *
 * **この録画のぶんだけ。** 入力は元のTS (`…-<録画の番号>.m2ts`)。
 * 同じワーカーの前のテストが残した予約が録れてエンコードされると、そのぶんまで混ざっていた (CI)。
 * 名前の尻で合わせる — エンコードしたものにチャプターを書き足すとき (`-c copy`) の `<元のTS>.chapters.txt` に当たらないように
 */
function encodeRuns(file: string, recordingId: string | null): string[][] {
  if (!existsSync(file)) return [];
  const mine = new RegExp(`-${recordingId}\\.m2ts$`);
  return readFileSync(file, "utf8")
    .split("---\n")
    .filter((run) => run.trim() !== "")
    .map((run) => run.split("\n"))
    .filter((run) => run.some((a) => a.endsWith(".encoding")))
    .filter((run) => run.some((a, i) => run[i - 1] === "-i" && mine.test(a)));
}

/** 1回ぶんの引数から「どのデバイスを、何でエンコードしたか」。ソフトウェアならデバイスは無し */
function wayOf(run: string[]): string {
  const encoder =
    run.find(
      (a) => /_(qsv|vaapi)$/.test(a) || a === "libx264" || a === "libsvtav1",
    ) ?? "?";
  const device = run.find(
    (a) => a.startsWith("qsv=") || a.startsWith("vaapi="),
  );
  const port = device
    ?.split(/child_device=|va:/)
    .at(-1)
    ?.split("/")
    .at(-1);
  return port === undefined ? encoder : `${port}:${encoder}`;
}

const GPUS = ["renderD128", "renderD129"];

test.describe("GPU でエンコードする", () => {
  const clearGpus = (dir: string) => {
    for (const name of readdirSync(dir))
      rmSync(`${dir}/${name}`, { force: true });
  };
  test.afterAll(async ({ stack, request }) => {
    clearGpus(stack.hwDir);
    await setRecording(request);
    // 次に GPU を見る人が「無い」から始められるように
    await request.post("/settings/recording?/probeHw", { form: {} });
  });

  test("見つかった GPU は自動で使い、コーデックごとにエンコーダを選べる", async ({
    page,
    stack,
  }) => {
    clearGpus(stack.hwDir);
    await goto(page, "/settings/recording");
    // GPU が無ければ、エンコーダを選ぶ欄も無い
    await page.getByTestId("hw-probe").click();
    await expect(page.getByTestId("hw-status")).toContainText(
      "GPU が見つかりません",
    );
    await expect(page.getByTestId("hw-device")).toHaveCount(0);
    await expect(page.getByTestId("hw-av1")).toHaveCount(0);

    // 2枚挿した → 確かめ直すと、デバイスが2つ。どちらも両方のコーデックを使えるので「順番に使う」
    for (const gpu of GPUS) writeFileSync(`${stack.hwDir}/${gpu}`, "1");
    await page.getByTestId("hw-probe").click();
    await expect(page.getByTestId("hw-status")).toContainText(
      "デバイスが 2 個見つかり、2 個で GPU エンコードできます",
    );
    await expect(page.getByTestId("hw-device")).toHaveCount(2);
    await expect(page.getByTestId("hw-av1")).toHaveValue("every");
    await expect(page.getByTestId("hw-h264")).toHaveValue("every");

    // デバイスごとに割り振る: AV1 は 128、H.264 は 129 (どちらも QSV/VA-API 両方)
    // 変えたらその場で保存する (保存のボタンは無い)。最後の保存が終わるのを待ってから読み直す
    const [d128, d129] = GPUS.map((gpu) => `${stack.hwDir}/${gpu}`);
    await page.getByTestId("hw-av1").selectOption(d128 as string);
    await page.getByTestId("hw-h264").selectOption(d129 as string);
    await expect(page.getByTestId("saved-result")).toBeVisible();
    await goto(page, "/settings/recording");
    await expect(page.getByTestId("hw-av1")).toHaveValue(d128 as string);
    await expect(page.getByTestId("hw-h264")).toHaveValue(d129 as string);
  });

  test("割り振ったデバイスでエンコードし、落ちたら次の方式へ倒れる", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);
    // 上の割り振りのまま (128 = AV1、129 = H.264)
    for (const gpu of GPUS) writeFileSync(`${stack.hwDir}/${gpu}`, "1");
    await request.post("/settings/recording?/probeHw", { form: {} });
    rmSync(stack.encodeArgsFile, { force: true });
    await setRecording(request, { codecs: ["av1", "h264"] });

    let programId = await reserveSoon(page, request, "BS");
    let row = page.locator(
      `[data-testid="recording-row"][data-program-id="${programId}"]`,
    );
    await waitWatchable(page, row);
    let recordingId = await row.getAttribute("data-recording-id");
    // AV1 は 128 の QSV、H.264 は 129 の QSV (どちらも先頭の方式で通る)
    expect(encodeRuns(stack.encodeArgsFile, recordingId).map(wayOf)).toEqual([
      "renderD128:av1_qsv",
      "renderD129:h264_qsv",
    ]);

    /*
     * **GPU が途中で駄目になっても録画は失敗にならない。** 129 を抜いてから
     * (確かめ直さずに) H.264 をエンコードさせると、129 の方式が初期化で落ちて、
     * ソフトウェアで再エンコードされる。試す順は 方式ごとに 2回 (頭を捨てる分) → 次。
     * 128 は H.264 を外してあるので、そちらへは行かない
     */
    rmSync(`${stack.hwDir}/renderD129`, { force: true });
    rmSync(stack.encodeArgsFile, { force: true });
    await setRecording(request, { codecs: ["h264"] });
    programId = await reserveSoon(page, request, "BS", 1);
    row = page.locator(
      `[data-testid="recording-row"][data-program-id="${programId}"]`,
    );
    await waitWatchable(page, row);
    recordingId = await row.getAttribute("data-recording-id");
    expect(encodeRuns(stack.encodeArgsFile, recordingId).map(wayOf)).toEqual([
      "renderD129:h264_qsv",
      "renderD129:h264_qsv",
      "renderD129:h264_vaapi",
      "renderD129:h264_vaapi",
      "libx264",
    ]);
  });
});
