import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  addAgent,
  AgentAdminError,
  agentEntries,
  agentState,
  followAgent,
  forgetFollowTries,
  moveAgent,
  removeAgent,
  renameAgent,
  unregistered,
} from "./agent-admin";
import { createIdentity, fingerprint, pemToDer } from "./agent-identity";
import { adoptName } from "./agent-name";
import { agentCert, listAgents } from "./agents";
import { config } from "./config";
import { orm } from "./db";
import {
  FAKE_AGENT_PAIR,
  fakeAgentIdentity,
  fakeAgentUrl,
  serveFakeAgent,
} from "./fake-agent";
import { agents } from "./schema";

const realAgent = config.agentUrl;
const realData = config.dataDir;
const realDb = config.dbPath;
const realRaw = config.rawDir;
const dir = mkdtempSync(`${tmpdir()}/agent-admin-`);
config.dataDir = dir;
config.dbPath = `${dir}/denpa.db`;
config.rawDir = `${dir}/raw`;
afterAll(() => {
  config.agentUrl = realAgent;
  config.dataDir = realData;
  config.dbPath = realDb;
  config.rawDir = realRaw;
  rmSync(dir, { recursive: true, force: true });
});

/** 呼ばれた API (メソッドとパス) */
let calls: string[] = [];

/** 名前を返す偽のエージェント。`DELETE /denpa/pair` は組む受け答え (`answerPairing`) が 204 で返す */
function serve(name: string | null, own = fakeAgentIdentity()) {
  return serveFakeAgent((request) => {
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}`);
    if (url.pathname === "/denpa/about")
      return Response.json(
        name === null ? { version: "dev" } : { name, version: "dev" },
      );
    if (url.pathname === "/denpa/tuners")
      return Response.json({ tuners: [], detected: false });
    return new Response("not found", { status: 404 });
  }, own);
}

beforeEach(() => {
  config.agentUrl = "";
  orm().delete(agents).run();
  calls = [];
});

describe("addAgent", () => {
  test("登録用の URL で組み、証明書を新しい行に保存して、名前を /denpa/about から付ける", async () => {
    const server = serve("書斎");
    try {
      const agent = await addAgent(fakeAgentUrl(server.port!));
      expect(agent.name).toBe("書斎");
      expect(agentCert(agent.id)).toBe(fakeAgentIdentity().cert);
      // 合言葉は持たない (組み直しは URL を貼り直す)
      expect(listAgents()).toEqual([
        {
          id: agent.id,
          name: "書斎",
          origin: `https://127.0.0.1:${server.port}`,
          pair: null,
        },
      ]);
      expect(agentEntries()[0]?.fromEnv).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("名前を返さない古いエージェントはホスト名にする", async () => {
    const server = serve(null);
    try {
      const agent = await addAgent(fakeAgentUrl(server.port!));
      expect(agent.name).toBe("127.0.0.1");
    } finally {
      server.stop(true);
    }
  });

  test("形が違う・合言葉が無い・合言葉が違う・繋がらないなら、何をすればよいかを言って断る", async () => {
    await expect(addAgent("http://a:25252#pair=x")).rejects.toThrow(
      "https://ホスト:ポート#pair=… の形で貼ってください",
    );
    await expect(addAgent("https://127.0.0.1:9")).rejects.toThrow(
      "合言葉 (#pair=…) が入っていません",
    );
    await expect(addAgent("https://127.0.0.1:9#pair=x")).rejects.toThrow(
      "127.0.0.1:9 に繋がりません",
    );
    const server = serve("書斎");
    try {
      await expect(
        addAgent(`https://127.0.0.1:${server.port}#pair=wrong`),
      ).rejects.toThrow("合言葉が違います");
    } finally {
      server.stop(true);
    }
    expect(orm().select().from(agents).all()).toEqual([]);
  });

  test("同じエージェントは 2 度登録しない。環境変数で登録してあるならそう言う", async () => {
    const server = serve("書斎");
    try {
      await addAgent(fakeAgentUrl(server.port!));
      await expect(addAgent(fakeAgentUrl(server.port!))).rejects.toThrow(
        "このエージェントはもう登録してあります (書斎)",
      );

      orm().delete(agents).run();
      config.agentUrl = fakeAgentUrl(server.port!);
      listAgents();
      await expect(addAgent(fakeAgentUrl(server.port!))).rejects.toThrow(
        "環境変数 (TUNER_AGENT_URL) で登録してあります",
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("環境変数のエージェントの名前 (adoptName)", () => {
  test("ホスト名のままなら名乗る名前にし、画面で変えた名前は変えない", async () => {
    const server = serve("書斎");
    try {
      config.agentUrl = fakeAgentUrl(server.port!);
      const [env] = listAgents();
      expect(await adoptName(env!)).toBe(true);
      expect(listAgents()[0]?.name).toBe("書斎");
      renameAgent(env!.id, "居間");
      expect(await adoptName(env!)).toBe(false);
      expect(listAgents()[0]?.name).toBe("居間");
    } finally {
      server.stop(true);
    }
  });
});

describe("renameAgent・moveAgent・removeAgent", () => {
  test("名前は空にできず、環境変数のエージェントでも変えられる", async () => {
    const server = serve("書斎");
    try {
      config.agentUrl = fakeAgentUrl(server.port!);
      const [env] = listAgents();
      renameAgent(env!.id, "  居間  ");
      expect(listAgents()[0]?.name).toBe("居間");
      expect(() => renameAgent(env!.id, " ")).toThrow(AgentAdminError);
    } finally {
      server.stop(true);
    }
  });

  test("環境変数のエージェントは、画面から消したり宛先を変えたりしない", async () => {
    config.agentUrl = "https://127.0.0.1:9#pair=x";
    const [env] = listAgents();
    await expect(removeAgent(env!.id)).rejects.toThrow(
      "環境変数から消すと外れます",
    );
    await expect(moveAgent(env!.id, "https://127.0.0.1:10")).rejects.toThrow(
      "環境変数で変えます",
    );
    expect(listAgents()).toHaveLength(1);
  });

  test("付け替え: 同じ証明書なら #pair= 無しで宛先だけ変え、違う証明書なら #pair= で組み直す", async () => {
    const old = serve("書斎");
    const moved = serve("書斎");
    const other = createIdentity("denpa-agent");
    const replaced = serve("書斎", other);
    try {
      const agent = await addAgent(fakeAgentUrl(old.port!));
      await moveAgent(agent.id, `https://127.0.0.1:${moved.port}`);
      expect(listAgents()[0]?.origin).toBe(`https://127.0.0.1:${moved.port}`);

      // 機材を入れ替えた: 合言葉が無ければ断り、あれば証明書を差し替える (名前は残す)
      await expect(
        moveAgent(agent.id, `https://127.0.0.1:${replaced.port}`),
      ).rejects.toThrow("証明書が変わりました");
      await moveAgent(
        agent.id,
        `https://127.0.0.1:${replaced.port}#pair=${FAKE_AGENT_PAIR}`,
      );
      expect(agentCert(agent.id)).toBe(other.cert);
      expect(listAgents()[0]?.name).toBe("書斎");
    } finally {
      old.stop(true);
      moved.stop(true);
      replaced.stop(true);
    }
  });

  test("削除: エージェントに DELETE /denpa/pair を送ってから行を消す。届かなくても行は消す", async () => {
    const server = serve("書斎");
    const agent = await addAgent(fakeAgentUrl(server.port!));
    expect(await removeAgent(agent.id)).toEqual({
      name: "書斎",
      reached: true,
    });
    expect(listAgents()).toEqual([]);

    const again = await addAgent(fakeAgentUrl(server.port!));
    server.stop(true);
    expect(await removeAgent(again.id)).toEqual({
      name: "書斎",
      reached: false,
    });
    expect(listAgents()).toEqual([]);
  });
});

describe("agentState", () => {
  test("台数・バージョンと、証明書が変わったことを返す", async () => {
    const server = serve("書斎");
    try {
      const agent = await addAgent(fakeAgentUrl(server.port!));
      const state = await agentState(agent, Promise.resolve([]), () => null);
      expect(state.tuners).toBe(0);
      expect(state.version).toBe("dev");
      expect(state.trouble).toBeNull();

      // 保存した証明書と違うものを置く (機材を入れ替えた)
      orm()
        .update(agents)
        .set({ cert: createIdentity("denpa-agent").cert })
        .run();
      const changed = await agentState(
        agent,
        Promise.reject(new Error("x")),
        () => null,
      );
      expect(changed.trouble).toBe("changed");
      expect(changed.tuners).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});

describe("followAgent (LAN で見つけたエージェントのアドレスを追う)", () => {
  const id = fingerprint(pemToDer(fakeAgentIdentity().cert)).slice(0, 16);

  beforeEach(() => forgetFollowTries());

  test("今の宛先で繋がらず、新しいアドレスで保存した証明書のまま繋がれば付け替える", async () => {
    const old = serve("書斎");
    const moved = serve("書斎");
    try {
      const agent = await addAgent(fakeAgentUrl(old.port!));
      old.stop(true);
      expect(
        await followAgent({ id, host: "127.0.0.1", port: moved.port! }),
      ).toBe(true);
      expect(listAgents()[0]?.origin).toBe(`https://127.0.0.1:${moved.port}`);
      expect(agentCert(agent.id)).toBe(fakeAgentIdentity().cert);
    } finally {
      moved.stop(true);
    }
  });

  test("今の宛先で繋がる・指紋が合わない・環境変数のものは付け替えない", async () => {
    const current = serve("書斎");
    const elsewhere = serve("書斎");
    try {
      await addAgent(fakeAgentUrl(current.port!));
      // 今の宛先で繋がる (名前で登録していて、まだ引ける)
      expect(
        await followAgent({ id, host: "127.0.0.1", port: elsewhere.port! }),
      ).toBe(false);
      expect(listAgents()[0]?.origin).toBe(`https://127.0.0.1:${current.port}`);

      // 指紋の合う行が無い
      forgetFollowTries();
      current.stop(true);
      expect(
        await followAgent({
          id: "0000000000000000",
          host: "127.0.0.1",
          port: elsewhere.port!,
        }),
      ).toBe(false);

      // 環境変数のものは環境変数が持ち主
      orm().delete(agents).run();
      config.agentUrl = fakeAgentUrl(9);
      listAgents();
      const cert = fakeAgentIdentity().cert;
      orm()
        .update(agents)
        .set({ cert, fingerprint: fingerprint(pemToDer(cert)) })
        .run();
      expect(
        await followAgent({ id, host: "127.0.0.1", port: elsewhere.port! }),
      ).toBe(false);
      expect(listAgents()[0]?.origin).toBe("https://127.0.0.1:9");
    } finally {
      current.stop(true);
      elsewhere.stop(true);
    }
  });

  test("新しいアドレスで別の証明書が答えたら付け替えない (偽の答え)", async () => {
    const old = serve("書斎");
    const impostor = serve("書斎", createIdentity("denpa-agent"));
    try {
      const port = old.port!;
      await addAgent(fakeAgentUrl(port));
      old.stop(true);
      expect(
        await followAgent({ id, host: "127.0.0.1", port: impostor.port! }),
      ).toBe(false);
      expect(listAgents()[0]?.origin).toBe(`https://127.0.0.1:${port}`);
      // 続けては試さない (偽の答えが続いても、繋ぎに行くのは 5 分に 1 回)
      calls = [];
      await followAgent({ id, host: "127.0.0.1", port: impostor.port! });
      expect(calls).toEqual([]);
    } finally {
      impostor.stop(true);
    }
  });

  test("候補には、どの行の指紋とも合わないものだけを残す", async () => {
    const server = serve("書斎");
    try {
      await addAgent(fakeAgentUrl(server.port!));
      expect(unregistered([{ id }, { id: "0123456789abcdef" }])).toEqual([
        { id: "0123456789abcdef" },
      ]);
    } finally {
      server.stop(true);
    }
  });
});
