import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { TEST_ROOT } from "../stack";

/**
 * **起動の途中に来た SIGTERM を捨てない** (`src/lib/server/hold-signals.ts`)。
 *
 * コンテナの中の denpa は PID 1 で、受け手のいない合図はカーネルが捨てる。アプリが引き取る前に
 * Pod の入れ替えが始まると SIGTERM が消え、6時間 (`terminationGracePeriodSeconds`) 降りなかった。
 * ここでは PID 1 にならないので、取っておかなければ既定どおり合図で殺される。
 * **アプリが受けて自分で降りた (終了コード 0・受けた記録あり) ことを見る。**
 *
 * 合図を送る時機は、入口 (`server.js`) が `build/index.js` を読む直前に出す `ADDRESS_HEADER` の
 * 知らせで計る。そこはもう取っておく側がいて、アプリはまだ引き取っていない。
 *
 * 普段のスタックは要らないので、helpers の `test` (スタックを立てる) は使わない
 */
// oxlint-disable-next-line no-empty-pattern -- Playwright は分割代入でないと受け付けない
test("起動の途中に SIGTERM を受けても、起動を終えてから降りる", async ({}, info) => {
  const root = `${TEST_ROOT}/boot-signal-${info.workerIndex}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const proc = spawn("bun", ["./server.js"], {
    env: {
      ...process.env,
      TZ: "Asia/Tokyo",
      HOST: "127.0.0.1",
      // 待ち受けまで行くことがあるので、ほかの起動と重ならない番号にしておく (範囲の +8)
      PORT: String(4173 + info.workerIndex * 10 + 8),
      DENPA_DB: `${root}/denpa.db`,
      RAW_DIR: `${root}/raw`,
      ENCODED_DIR: `${root}/encoded`,
      DENPA_AUTOSTART: "0",
      ADDRESS_HEADER: "x-forwarded-for",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  let sent = false;
  const keep = (chunk: Buffer) => {
    log += chunk.toString();
    if (!sent && log.includes("ADDRESS_HEADER=")) {
      sent = true;
      proc.kill("SIGTERM");
    }
  };
  proc.stdout.on("data", keep);
  proc.stderr.on("data", keep);

  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
  try {
    const { code, signal } = await exited;
    expect(sent, log).toBe(true);
    // 合図で殺されていない。アプリが受け、録画が無いのですぐ降りた
    expect({ code, signal }, log).toEqual({ code: 0, signal: null });
    expect(log).toContain("[boot] SIGTERM を受けました (録画 0 件)");
  } finally {
    clearTimeout(timer);
  }
});
