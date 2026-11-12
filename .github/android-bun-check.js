// Android のアプリの子プロセスの bun が、denpa を動かすのに要ることをできるかを試す (.github/android-app-smoke.sh)。
// smoke がアプリの置き場 (DENPA_HOME/smoke/) に置き、debug の APK にだけ入る受け口 (DebugReceiver の RUN_BUN) が、
// 常駐サービスと同じ起動の仕方 (アプリの子プロセス、環境変数は DENPA_HOME・FFMPEG・FFPROBE など) で bun に渡す。結果を JSON で標準出力に出す。
// 試すのは、JIT、名前を引けるか、/proc から読むもの、子プロセスの起動、TZ を渡したときの時刻、bun:sqlite、ffmpeg・ffprobe の起動。失敗は止めずに error に入れる
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

/** `-version` の最初の行。起動できなければ投げる */
function version(path) {
  if (path === undefined) throw new Error("環境変数がありません");
  const child = Bun.spawnSync([path, "-hide_banner", "-version"]);
  if (child.exitCode !== 0)
    throw new Error(`終了コード ${child.exitCode}: ${child.stderr.toString()}`);
  return { path, line: child.stdout.toString().split("\n")[0] };
}

for (let i = 0; i < 5000; i++) hot(1000);
const data = join(process.env.DENPA_HOME, "smoke", "data");
const result = {
  version: Bun.version,
  platform: process.platform,
  arch: process.arch,
  execPath: process.execPath,
  jit: { dfgCompiles: numberOfDFGCompiles(hot) },
  dns: {
    localhost: await attempt(() => lookup("localhost")),
    external: await attempt(() => lookup("github.com")),
  },
  fetch: await attempt(
    async () => (await fetch("https://github.com/", { method: "HEAD" })).status,
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
    return { exitCode: child.exitCode, stdout: child.stdout.toString().trim() };
  }),
  // denpa は TZ (denpa.env の既定は Asia/Tokyo) のローカル時刻で日付を決める。Android には /usr/share/zoneinfo が無いので、bun が TZ を解けるかを見る
  tz: await attempt(() => {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        "console.log(JSON.stringify({ offset: new Date(0).getTimezoneOffset(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone, local: new Date(0).toString() }))",
      ],
      { env: { ...process.env, TZ: "Asia/Tokyo" } },
    );
    return JSON.parse(child.stdout.toString());
  }),
  // 常駐サービスが FFMPEG・FFPROBE で渡す、APK の ffmpeg・ffprobe (libffmpeg.so・libffprobe.so)
  ffmpeg: await attempt(() => version(process.env.FFMPEG)),
  ffprobe: await attempt(() => version(process.env.FFPROBE)),
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
console.log(JSON.stringify(result));
