// denpa-aio の入口。本体とチューナーエージェントを起こし、両方の面倒を見る。
//
// - 止めるとき (SIGTERM) は両方に渡し、両方が録画の終わりを待って畳むのを待つ
//   (stop_grace_period はそれに合わせて長くしておく。compose.prod.yml と同じ)
// - どちらかが落ちたら、もう片方も畳んでコンテナごと終わる。片方だけ生きていても
//   録れないので、起こし直しは restart に任せる
//
// - 組むときの合言葉 (docs/agent.md) を用意して、エージェントには AGENT_PAIR_TOKEN、
//   denpa には TUNER_AGENT_URL の #pair= で渡す
//
// **シェルで書かない。** 本体のイメージの土台は distroless でシェルが無いので、
// イメージに入っている bun で回す (.github/aio.Dockerfile)

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";

/**
 * 合言葉。渡されていればそれ (`-e AGENT_PAIR_TOKEN=…`)、無ければエージェントが自分で作るのと同じ所
 * (`TUNERS_FILE` の隣の `tls/pair-token`。既定は `/config/tls/pair-token`) から読み、そこにも無ければ作る。
 * **一度作ったら変えない** (置き場は `/config` のボリュームなので、作り直したコンテナでも同じ)
 */
function pairToken(): string {
  const given = process.env.AGENT_PAIR_TOKEN?.trim();
  if (given) return given;
  const file = join(
    dirname(process.env.TUNERS_FILE || "/config/tuners.json"),
    "tls",
    "pair-token",
  );
  try {
    const kept = readFileSync(file, "utf8").trim();
    if (kept) return kept;
  } catch {
    // 無ければ作る
  }
  const token = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

const token = pairToken();
// 自分で #pair= まで書いた TUNER_AGENT_URL (別のエージェントを指すなど) には足さない
const agentUrl = process.env.TUNER_AGENT_URL || "https://127.0.0.1:25252";
const io = { stdin: "inherit", stdout: "inherit", stderr: "inherit" } as const;
const agent = Bun.spawn(["/usr/local/bin/denpa-agent"], {
  ...io,
  env: { ...process.env, AGENT_PAIR_TOKEN: token },
});
const denpa = Bun.spawn([process.execPath, "/app/server.js"], {
  ...io,
  cwd: "/app",
  env: {
    ...process.env,
    TUNER_AGENT_URL: agentUrl.includes("#")
      ? agentUrl
      : `${agentUrl}#pair=${token}`,
  },
});
const children = [agent, denpa];

let stopping = false;
const stop = () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  }
};
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
    stop();
  });
}

const first = await Promise.race(
  children.map((child) => child.exited.then(() => child)),
);
stop();
await Promise.all(children.map((child) => child.exited));
// 止めるよう言われたなら 0。自分から落ちたなら、落ちたほうの終了コードを返す
// (シグナルで落ちたときは、シェルと同じく 128 + 番号)
const code =
  first.exitCode ??
  128 + (first.signalCode === null ? 0 : constants.signals[first.signalCode]);
process.exit(stopping ? 0 : code);
