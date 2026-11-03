import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

/**
 * エンコードキューの毒ジョブ対策。
 *
 * プロセスごと落とすジョブは running→queued へ戻り続け、同時実行 1・id 順だと
 * 毎回先頭に来てキューを塞ぐ。取り出した回数 (attempts) が上限を超えたら、動かさずに
 * failed にして後ろを進めることを確かめる。
 *
 * DB の置き場は一時ファイルへ。環境変数ではなく設定そのものを書き換える
 * (config は読み込み時に 1 度だけ環境変数を読むため。files.test.ts と同じ理由)。
 *
 * 録画には元の TS を持たせない。上限未満のジョブは取り出されて runJob へ進むが、元にできる
 * ファイルが無いので ffmpeg を起動する前に failed になる。テストで本物の
 * エンコードを起動しないためでもある
 */
const { config } = await import("./config");
config.dbPath = join(mkdtempSync(join(tmpdir(), "denpa-encpump-")), "denpa.db");
config.encodeMaxAttempts = 5;

const { orm } = await import("./db");
const { encodeJobs, recordings } = await import("./schema");
const { cancel, isCanceling, pump } = await import("./encoder");

const now = Date.now();

function reset(): void {
  orm().delete(recordings).run();
  orm().delete(encodeJobs).run();
  orm()
    .insert(recordings)
    .values({
      id: 1,
      service_id: 1,
      name: "毒番組",
      start_at: now,
      end_at: now,
      created_at: now,
      updated_at: now,
    })
    .run();
}

function seedJob(attempts: number): number {
  return orm()
    .insert(encodeJobs)
    .values({ recording_id: 1, state: "queued", attempts, created_at: now })
    .returning({ id: encodeJobs.id })
    .get()!.id;
}

function job(jobId: number): { state: string; attempts: number } {
  return orm()
    .select({ state: encodeJobs.state, attempts: encodeJobs.attempts })
    .from(encodeJobs)
    .where(eq(encodeJobs.id, jobId))
    .get()!;
}

test("上限を超えたジョブは取り出さずに failed にする", () => {
  reset();
  const jobId = seedJob(config.encodeMaxAttempts); // ちょうど上限 (>=)
  pump();
  const after = job(jobId);
  expect(after.state).toBe("failed");
  // 取り出していないので attempts は増えない (増えていれば動かしている)
  expect(after.attempts).toBe(config.encodeMaxAttempts);
});

test("上限未満のジョブは普通に取り出す (attempts が増える)", () => {
  reset();
  const jobId = seedJob(config.encodeMaxAttempts - 1);
  pump();
  // 取り出すと attempts+1。上限の分岐で切り捨てていないことを確かめる
  expect(job(jobId).attempts).toBe(config.encodeMaxAttempts);
});

/*
 * **中止は畳み終わってから返す。**
 *
 * 中止を伝えるだけで返していた頃は、押した直後の読み直しが ffmpeg の終了より前に届くので、
 * 同じ「エンコード中 60.9%」がそのまま出た。行が変わるのは畳み終わりの通知
 * (SSE) が来たときで、その接続が切れている端末ではリロードするまで変わらない
 */
test("待機中のジョブの中止は、その場で canceled になる", async () => {
  reset();
  const jobId = seedJob(0);
  await cancel(jobId);
  expect(job(jobId).state).toBe("canceled");
  // pump の finally を通らないので、中止の印もその場で外れる (残るとボタンが回り続ける)
  expect(isCanceling(jobId)).toBe(false);
});

test("動き出したジョブの中止は、畳み終わってから返る", async () => {
  reset();
  const jobId = seedJob(0);
  pump(); // 取り出して動き出す (この録画には元の TS が無いので、すぐ畳まれる)
  const at = Date.now();
  await cancel(jobId);
  // 返ってきた時点で終わっているので、押した直後の読み直しが今の状態を読める
  expect(job(jobId).state).not.toBe("running");
  // 上限 (CANCEL_WAIT_MS) まで待ったのではなく、畳み終わりを受け取って返っている
  expect(Date.now() - at).toBeLessThan(1_000);
});
