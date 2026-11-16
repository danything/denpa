import { rmSync, writeFileSync } from "node:fs";

import { expect, goto, recordOne, setRecording, test } from "./helpers";
import {
  paceWaits,
  playMuted,
  streamOnly,
  streamRequests,
} from "./watch-stream";

/**
 * **その場の変換が実時間の 1.2 倍でしか出せなくても、回線が太ければ画質を下げない** (`adapt.ts` の `rate`・`server/pace.ts` の `wait`)。
 * 届く速さはエンコードで頭打ちになり、受け取りの速さ × 0.7 は段 0 の目安 (10.5 Mbit/s) に届かない。サーバが ffmpeg を
 * 待っていた割合から、回線は空いていたと読む。回線が細いときに下げるところは `39-watch-adapt-relay`。
 *
 * エンコードしない録画 (元の TS) を、MPEG-2 を出さずに (`streamOnly`) 段 0 の変換で観る。偽 ffmpeg は作り置きの fMP4 を
 * 実時間の 1.2 倍の頃合いで、6 Mbit/s に膨らませて出す (`stack.streamPaceFile`)。測るのは本物のサーバと本物のブラウザ
 */

test.describe("観る画面で、エンコードが遅いその場の変換", () => {
  test.beforeAll(async ({ request, stack }) => {
    await setRecording(request, { codecs: [] });
    writeFileSync(stack.liveFmp4File, "");
    writeFileSync(stack.streamPaceFile, "1.2 6000");
  });
  test.afterAll(async ({ request, stack }) => {
    rmSync(stack.liveFmp4File, { force: true });
    rmSync(stack.streamPaceFile, { force: true });
    await setRecording(request, {});
  });

  test("エンコードが実時間の 1.2 倍で頭打ちでも、回線が太ければ下げない", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const { id } = await recordOne(page, request);
    await streamOnly(page, id);
    const asked = streamRequests(page);
    const waits = paceWaits(page);

    await goto(page, `/watch/${id}`);
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]!.searchParams.get("rung")).toBeNull();
    await playMuted(page);
    const video = page.getByTestId("watch-video");
    const where = (): Promise<number> =>
      video.evaluate((v) => (v as HTMLVideoElement).currentTime);
    /*
     * 下げるなら、立ち上がりの 3 秒と、速さが足りない状態の 10 秒を過ぎたところ (直す前は 17 秒目に段 1 へ下げた)。
     * その先まで観る
     */
    await expect.poll(where, { timeout: 60_000 }).toBeGreaterThan(25);
    expect(asked).toHaveLength(1);
    await expect(page.getByTestId("watch-adapt")).toHaveCount(0);
    // サーバは ffmpeg の出力を待っていた (送るのは待たされていない)
    expect(Math.max(...waits)).toBeGreaterThan(0.5);
  });
});
