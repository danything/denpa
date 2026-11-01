import { expect, test } from "bun:test";

/**
 * 入口がいちばん先に読む `hold-signals.ts`。この場のプロセスの合図に手を入れるので、別のプロセスで読む
 */
test("起動の途中に来た合図を覚えるだけで、落ちない", async () => {
  const script = `
    await import(${JSON.stringify(`${import.meta.dir}/hold-signals.ts`)});
    process.kill(process.pid, "SIGTERM");
    process.kill(process.pid, "SIGINT");
    await Bun.sleep(200);
    console.log("held=" + globalThis.__denpaHeldSignal);
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  // 先に来たほうを覚える
  expect(out).toContain("held=SIGTERM");
  expect(out).toContain("起動の途中で SIGTERM を受けました");
});
