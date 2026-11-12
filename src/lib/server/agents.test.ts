import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { asc } from "drizzle-orm";

import {
  agentHostnames,
  agentSecrets,
  parseAgentUrls,
  primaryAgent,
  rememberAgentCert,
  syncEnvAgents,
} from "./agents";
import { config } from "./config";
import { orm } from "./db";
import { agents } from "./schema";

const realAgent = config.agentUrl;
const realDb = config.dbPath;
const dir = mkdtempSync(`${tmpdir()}/agents-`);
config.dbPath = `${dir}/denpa.db`;
afterAll(() => {
  config.agentUrl = realAgent;
  config.dbPath = realDb;
  rmSync(dir, { recursive: true, force: true });
});

const rows = () =>
  orm()
    .select({
      origin: agents.origin,
      name: agents.name,
      cert: agents.cert,
      position: agents.position,
      from_env: agents.from_env,
    })
    .from(agents)
    .orderBy(asc(agents.position))
    .all();

describe("parseAgentUrls", () => {
  test("カンマで区切って何台でも読み、空の項目と前後の空白は飛ばす", () => {
    expect(
      parseAgentUrls(" https://a:25252#pair=x , ,https://b:25252/ "),
    ).toEqual([
      { origin: "https://a:25252", pair: "x" },
      { origin: "https://b:25252", pair: null },
    ]);
  });

  test("空なら 1 台も無い", () => {
    expect(parseAgentUrls("")).toEqual([]);
  });

  test("同じ URL を 2 回書いたら、前のものだけを使う", () => {
    expect(
      parseAgentUrls("https://a:1#pair=x,https://a:1#pair=y").map(
        (t) => t.pair,
      ),
    ).toEqual(["x"]);
  });

  test("1 つでも読めなければ誤り", () => {
    expect(() => parseAgentUrls("https://a:1,http://b:2")).toThrow("https://");
  });
});

describe("agentSecrets・agentHostnames", () => {
  test("全部の項目の合言葉とホスト名を返す。読めない項目があっても、ほかの合言葉は伏せる", () => {
    config.agentUrl = "https://a:1#pair=one,http://b:2#pair=two";
    expect(agentSecrets()).toEqual(["one", "two"]);
    expect(agentHostnames()).toEqual(["a"]);
  });
});

describe("syncEnvAgents", () => {
  test("書いた順に行を足し、名前はホスト名", () => {
    config.agentUrl = "https://a:1#pair=x,https://b:2#pair=y";
    syncEnvAgents();
    expect(rows()).toEqual([
      {
        origin: "https://a:1",
        name: "a",
        cert: null,
        position: 0,
        from_env: true,
      },
      {
        origin: "https://b:2",
        name: "b",
        cert: null,
        position: 1,
        from_env: true,
      },
    ]);
    expect(primaryAgent()).toMatchObject({ origin: "https://a:1", pair: "x" });
  });

  test("同じ URL の行は残して保存した証明書を引き継ぎ、並びは書いた順に直す。合言葉は DB に持たない", () => {
    config.agentUrl = "https://a:1#pair=x,https://b:2#pair=y";
    syncEnvAgents();
    const b = orm()
      .select()
      .from(agents)
      .all()
      .find((r) => r.origin === "https://b:2")!;
    rememberAgentCert(b.id, "CERT-B", "fp-b");
    config.agentUrl = "https://b:2#pair=z,https://a:1#pair=x";
    syncEnvAgents();
    expect(rows().map((r) => [r.origin, r.position, r.cert])).toEqual([
      ["https://b:2", 0, "CERT-B"],
      ["https://a:1", 1, null],
    ]);
    expect(primaryAgent()).toMatchObject({ origin: "https://b:2", pair: "z" });
    expect(JSON.stringify(orm().select().from(agents).all())).not.toContain(
      '"z"',
    );
  });

  test("環境変数から消したエージェントは行も消す", () => {
    config.agentUrl = "https://a:1#pair=x";
    syncEnvAgents();
    expect(rows().map((r) => r.origin)).toEqual(["https://a:1"]);
    config.agentUrl = "";
    syncEnvAgents();
    expect(rows()).toEqual([]);
    expect(() => primaryAgent()).toThrow("エージェントがありません");
  });

  test("読めない書き方なら行を変えない (保存した証明書を消さない)", () => {
    config.agentUrl = "https://a:1#pair=x";
    syncEnvAgents();
    config.agentUrl = "https://a:1#pair=x,http://b:2";
    expect(() => syncEnvAgents()).toThrow("https://");
    expect(rows().map((r) => r.origin)).toEqual(["https://a:1"]);
  });

  test("画面から登録したものは消さず、環境変数のものの後ろに並べる", () => {
    config.agentUrl = "https://a:1#pair=x";
    syncEnvAgents();
    orm()
      .insert(agents)
      .values({
        name: "書斎",
        origin: "https://c:3",
        from_env: false,
        position: 0,
        added_at: 0,
      })
      .run();
    config.agentUrl = "https://a:1#pair=x,https://b:2#pair=y";
    syncEnvAgents();
    expect(rows().map((r) => [r.origin, r.position])).toEqual([
      ["https://a:1", 0],
      ["https://b:2", 1],
      ["https://c:3", 2],
    ]);
    config.agentUrl = "";
    syncEnvAgents();
    expect(rows().map((r) => [r.origin, r.position])).toEqual([
      ["https://c:3", 0],
    ]);
  });

  test("同じ証明書を別の行に保存しない (同じエージェントを別の URL で 2 回書いたとき)", () => {
    config.agentUrl = "https://a:1#pair=x,https://a2:1#pair=x";
    syncEnvAgents();
    const [first, second] = orm()
      .select()
      .from(agents)
      .orderBy(asc(agents.position))
      .all();
    rememberAgentCert(first!.id, "CERT", "fp-same");
    expect(() => rememberAgentCert(second!.id, "CERT", "fp-same")).toThrow(
      "https://a:1",
    );
  });
});
