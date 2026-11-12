// debug の APK にだけ入る、bun の確かめ用のサーバ (.github/android-app-smoke.sh)。3 段目で denpa 本体が入る所 (assets の server/app/server.js) に置く。
// 常駐サービスが denpa 本体と同じ起動の仕方 (アプリの子プロセス、作業ディレクトリはこのファイルの置き場、環境変数の PORT) で bun に渡す。
// GET /check は、denpa を動かすのに要ることを bun の中から試し、結果を JSON で返す。
// 試すのは、JIT、名前を引けるか、/proc から読むもの、子プロセスの起動、bun:sqlite、置き場への書き込み。失敗は止めずに error に入れる
import { numberOfDFGCompiles } from "bun:jsc";
import { Database } from "bun:sqlite";
import { lookup } from "node:dns/promises";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

async function attempt(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// DFG で組まれるまで回す関数。JIT が使えなければ、何回呼んでも 0 のまま
function hot(n) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum = (sum + i * 7) % 1000003;
  return sum;
}

async function check() {
  for (let i = 0; i < 5000; i++) hot(1000);
  const data = join(process.env.DENPA_HOME, "data");
  return {
    version: Bun.version,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    cwd: process.cwd(),
    jit: { dfgCompiles: numberOfDFGCompiles(hot) },
    dns: {
      localhost: await attempt(() => lookup("localhost")),
      external: await attempt(() => lookup("github.com")),
    },
    fetch: await attempt(
      async () =>
        (await fetch("https://github.com/", { method: "HEAD" })).status,
    ),
    proc: {
      stat: await attempt(
        () => readFileSync("/proc/self/stat", "utf8").split(" ").length,
      ),
      openFiles: await attempt(() =>
        readFileSync("/proc/self/limits", "utf8")
          .match(/^Max open files\s+(\S+)\s+(\S+)/m)
          ?.slice(1),
      ),
      cpus: await attempt(() => os.cpus().length),
      totalmem: await attempt(() => os.totalmem()),
      loadavg: await attempt(() => os.loadavg()),
      uptime: await attempt(() => os.uptime()),
      rss: await attempt(() => process.memoryUsage().rss),
      interfaces: await attempt(() => Object.keys(os.networkInterfaces())),
      root: await attempt(() => readdirSync("/").length),
    },
    spawn: await attempt(() => {
      const child = Bun.spawnSync([process.execPath, "--version"]);
      return {
        exitCode: child.exitCode,
        stdout: child.stdout.toString().trim(),
      };
    }),
    sqlite: await attempt(() => {
      mkdirSync(data, { recursive: true });
      const db = new Database(join(data, "check.db"));
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("CREATE TABLE IF NOT EXISTS t (n INTEGER)");
      db.prepare("INSERT INTO t (n) VALUES (?)").run(1);
      const count = db.prepare("SELECT count(*) AS c FROM t").get().c;
      db.close();
      return count;
    }),
  };
}

const server = Bun.serve({
  // 確かめは adb forward から読むので、端末の外には出さない
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/check") return Response.json(await check());
    return new Response("denpa の bun の確かめ用のサーバです\n");
  },
});
console.log(`bun ${Bun.version} が ${server.port} 番で待ち受けています`);
