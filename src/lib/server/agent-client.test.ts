import { afterAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  agentFetch,
  agentSecrets,
  createIdentity,
  pairProof,
  parseAgentUrl,
} from "./agent-client";
import { config } from "./config";
import {
  FAKE_AGENT_PAIR,
  fakeAgentIdentity,
  fakeAgentUrl,
  serveFakeAgent,
} from "./fake-agent";

const realAgent = config.agentUrl;
const realData = config.dataDir;
const dir = mkdtempSync(`${tmpdir()}/agent-client-`);
config.dataDir = dir;
afterAll(() => {
  config.agentUrl = realAgent;
  config.dataDir = realData;
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

describe("agentFetch", () => {
  test("初めは合言葉で組み、相手の証明書を覚えてから呼ぶ", async () => {
    const server = serveFakeAgent(() => Response.json({ ok: true }));
    try {
      config.agentUrl = fakeAgentUrl(server.port!);
      const res = await agentFetch("/denpa/tuners");
      expect(await res.json()).toEqual({ ok: true });
      expect(readFileSync(`${dir}/tls/agent.crt`, "utf8")).toBe(
        fakeAgentIdentity().cert,
      );
      expect(existsSync(`${dir}/tls/denpa.key`)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("合言葉が違えば組まない", async () => {
    rmSync(`${dir}/tls/agent.crt`, { force: true });
    const server = serveFakeAgent(() => Response.json({ ok: true }));
    try {
      config.agentUrl = `https://127.0.0.1:${server.port}#pair=wrong`;
      await expect(agentFetch("/denpa/tuners")).rejects.toThrow(
        "合言葉が違います",
      );
      expect(existsSync(`${dir}/tls/agent.crt`)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("合言葉を知らない相手 (証しを返せない) は覚えない", async () => {
    const liar = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { key: fakeAgentIdentity().key, cert: fakeAgentIdentity().cert },
      fetch: () => Response.json({ proof: "made-up" }),
    });
    try {
      config.agentUrl = `https://127.0.0.1:${liar.port}#pair=${FAKE_AGENT_PAIR}`;
      await expect(agentFetch("/denpa/tuners")).rejects.toThrow(
        "合言葉を知りません",
      );
      expect(existsSync(`${dir}/tls/agent.crt`)).toBe(false);
    } finally {
      liar.stop(true);
    }
  });

  test("覚えた証明書と違う相手なら、組み直してから呼ぶ", async () => {
    const other = createIdentity("denpa-agent");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(`${dir}/tls`, { recursive: true });
    writeFileSync(`${dir}/tls/agent.crt`, other.cert);
    const server = serveFakeAgent(() => Response.json({ ok: true }));
    try {
      config.agentUrl = fakeAgentUrl(server.port!);
      const res = await agentFetch("/denpa/tuners");
      expect(res.status).toBe(200);
      expect(readFileSync(`${dir}/tls/agent.crt`, "utf8")).toBe(
        fakeAgentIdentity().cert,
      );
    } finally {
      server.stop(true);
    }
  });

  test("組んでいないのに合言葉も無ければ、付け方を言う", async () => {
    rmSync(`${dir}/tls/agent.crt`, { force: true });
    config.agentUrl = "https://127.0.0.1:9";
    await expect(agentFetch("/denpa/tuners")).rejects.toThrow("#pair=");
  });
});
