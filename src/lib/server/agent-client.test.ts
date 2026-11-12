import { afterAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { agentFetch } from "./agent-client";
import { createIdentity, pairProof } from "./agent-identity";
import {
  agentCert,
  agentSecrets,
  parseAgentUrl,
  primaryAgent,
  rememberAgentCert,
} from "./agents";
import { config } from "./config";
import {
  FAKE_AGENT_PAIR,
  fakeAgentIdentity,
  fakeAgentUrl,
  serveFakeAgent,
} from "./fake-agent";

const realAgent = config.agentUrl;
const realData = config.dataDir;
const realDb = config.dbPath;
const dir = mkdtempSync(`${tmpdir()}/agent-client-`);
config.dataDir = dir;
config.dbPath = `${dir}/denpa.db`;
afterAll(() => {
  config.agentUrl = realAgent;
  config.dataDir = realData;
  config.dbPath = realDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("parseAgentUrl", () => {
  test("合言葉は # の後ろから取り、送る先には含めない", () => {
    expect(parseAgentUrl("https://tuner-agent:25252/#pair=abc")).toEqual({
      origin: "https://tuner-agent:25252",
      pair: "abc",
    });
    expect(parseAgentUrl("https://10.0.0.4:25252")).toEqual({
      origin: "https://10.0.0.4:25252",
      pair: null,
    });
  });

  test("http:// は誤り (平文では繋がない)", () => {
    expect(() => parseAgentUrl("http://tuner-agent:25252")).toThrow("https://");
  });

  test("ホストが空なら、合言葉を出さずに誤りにする (アドレスを取れなかったインストールの起動スクリプト)", () => {
    expect(() => parseAgentUrl("https://:25252#pair=abc")).toThrow("ホスト");
    expect(() => parseAgentUrl("https://:25252#pair=abc")).not.toThrow("abc");
  });

  test("合言葉は伏せる値に入る", () => {
    config.agentUrl = "https://a:1#pair=secret-token";
    expect(agentSecrets()).toEqual(["secret-token"]);
  });
});

describe("自己署名の証明書", () => {
  test("X.509 として読め、自分の鍵で署名が確かめられる", () => {
    const identity = createIdentity("denpa");
    const cert = new X509Certificate(identity.cert);
    expect(cert.subject).toBe("CN=denpa");
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.fingerprint256.replaceAll(":", "").toLowerCase()).toBe(
      identity.fingerprint,
    );
    expect(new Date(cert.validTo).getFullYear()).toBeGreaterThan(
      new Date().getFullYear() + 90,
    );
  });

  test("何度作ってもシリアル番号が DER の整数として正しい (先頭が 0 にならない)", () => {
    // 乱数の先頭のバイトが 0 だと 128 回に 1 回ほど壊れた証明書になっていた。多めに作って確かめる
    for (let i = 0; i < 400; i++) {
      const cert = new X509Certificate(createIdentity("denpa").cert);
      expect(cert.serialNumber.slice(0, 2)).not.toBe("00");
    }
  });
});

describe("pairProof", () => {
  test("決まった入力で決まった値 (エージェントの AgentTls と同じ式)", () => {
    expect(pairProof("token", "client", "aa", "bb")).toBe(
      new Bun.CryptoHasher("sha256", "token")
        .update("denpa-pair/client\naa\nbb")
        .digest("base64url"),
    );
    expect(pairProof("token", "agent", "aa", "bb")).not.toBe(
      pairProof("token", "client", "aa", "bb"),
    );
  });
});

/** 今のエージェントの行に保存した証明書 */
const savedCert = () => agentCert(primaryAgent().id);

describe("agentFetch", () => {
  test("初めは合言葉で組み、相手の証明書を DB の行に保存してから呼ぶ", async () => {
    const server = serveFakeAgent(() => Response.json({ ok: true }));
    try {
      config.agentUrl = fakeAgentUrl(server.port!);
      const res = await agentFetch("/denpa/tuners");
      expect(await res.json()).toEqual({ ok: true });
      expect(savedCert()).toBe(fakeAgentIdentity().cert);
      expect(existsSync(`${dir}/tls/denpa.key`)).toBe(true);
      expect(existsSync(`${dir}/tls/agent.crt`)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("合言葉が違えば組まない", async () => {
    const server = serveFakeAgent(() => Response.json({ ok: true }));
    try {
      config.agentUrl = `https://127.0.0.1:${server.port}#pair=wrong`;
      await expect(agentFetch("/denpa/tuners")).rejects.toThrow(
        "合言葉が違います",
      );
      expect(savedCert()).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("合言葉の違う相手 (証しを返せない) は保存しない", async () => {
    const liar = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { key: fakeAgentIdentity().key, cert: fakeAgentIdentity().cert },
      fetch: () => Response.json({ proof: "made-up" }),
    });
    try {
      config.agentUrl = `https://127.0.0.1:${liar.port}#pair=${FAKE_AGENT_PAIR}`;
      await expect(agentFetch("/denpa/tuners")).rejects.toThrow(
        "合言葉が違います",
      );
      expect(savedCert()).toBeNull();
    } finally {
      liar.stop(true);
    }
  });

  test("保存した証明書と違う相手なら、組み直してから呼ぶ", async () => {
    const other = createIdentity("denpa-agent");
    const server = serveFakeAgent(() => Response.json({ ok: true }));
    try {
      config.agentUrl = fakeAgentUrl(server.port!);
      rememberAgentCert(primaryAgent().id, other.cert, other.fingerprint);
      const res = await agentFetch("/denpa/tuners");
      expect(res.status).toBe(200);
      expect(savedCert()).toBe(fakeAgentIdentity().cert);
    } finally {
      server.stop(true);
    }
  });

  test("エージェントに組んでいないと断られたら (paired: false)、組み直してから呼ぶ", async () => {
    let forgotten = true;
    const server = serveFakeAgent(() => {
      if (forgotten) {
        // エージェントの clients から消されたとき。1 度目は断られる
        forgotten = false;
        return Response.json(
          { error: "この denpa とはまだ組んでいません", paired: false },
          { status: 403 },
        );
      }
      return Response.json({ ok: true });
    });
    try {
      config.agentUrl = fakeAgentUrl(server.port!);
      // 一度組んで証明書を保存してある
      const { cert, fingerprint } = fakeAgentIdentity();
      rememberAgentCert(primaryAgent().id, cert, fingerprint);
      const res = await agentFetch("/denpa/tuners");
      expect(await res.json()).toEqual({ ok: true });
      expect(forgotten).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("ほかの 403 は組み直さずにそのまま返す", async () => {
    let calls = 0;
    const server = serveFakeAgent(() => {
      calls += 1;
      return Response.json({ error: "置き場の外です" }, { status: 403 });
    });
    try {
      config.agentUrl = fakeAgentUrl(server.port!);
      const res = await agentFetch("/denpa/decode");
      expect(res.status).toBe(403);
      expect(calls).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("組んでいないのに合言葉も無ければ、付け方を言う", async () => {
    config.agentUrl = "https://127.0.0.1:9";
    await expect(agentFetch("/denpa/tuners")).rejects.toThrow("#pair=");
  });

  test("TUNER_AGENT_URL が空なら、書き方を言う", async () => {
    config.agentUrl = "";
    await expect(agentFetch("/denpa/tuners")).rejects.toThrow(
      "エージェントがありません",
    );
  });

  test("書き方の誤りは、呼んだときに返す", async () => {
    config.agentUrl = "http://tuner-agent:25252";
    await expect(agentFetch("/denpa/tuners")).rejects.toThrow("https://");
  });
});
