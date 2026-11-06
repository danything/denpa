import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CA_SYSTEM_BCAS,
  PID_CAT,
  TABLE_CAT,
  TABLE_EMM_S,
  withCrc,
} from "@danything/arib/psi";
import { packetize } from "@danything/arib/synth";

import { config } from "./config";
import { isEmmSuccess, processEmmStream, receiveEmm, sendCardEmm } from "./emm";
import { fakeAgentUrl, serveFakeAgent } from "./fake-agent";

const realAgent = config.agentUrl;
const realData = config.dataDir;
const realDb = config.dbPath;

const testDir = mkdtempSync(join(tmpdir(), "denpa-emm-"));
config.dataDir = testDir;
config.dbPath = join(testDir, "denpa.db");

afterAll(() => {
  config.agentUrl = realAgent;
  config.dataDir = realData;
  config.dbPath = realDb;
  rmSync(testDir, { recursive: true, force: true });
});

describe("EMM 判定と API 呼び出し", () => {
  test("isEmmSuccess は 0x2100 で true を返す", () => {
    expect(isEmmSuccess(0x2100)).toBe(true);
    expect(isEmmSuccess(0x0800)).toBe(false);
    expect(isEmmSuccess(0x0000)).toBe(false);
  });

  test("sendCardEmm はエージェントに EMM を送信し返り値コードを返す", async () => {
    let receivedEmm: string | null = null;
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card/emm" && req.method === "POST") {
        const body = (await req.json()) as { emm?: string };
        receivedEmm = body.emm ?? null;
        return Response.json({ ok: true, code: 0x2100 });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const samplePayload = Uint8Array.from([0x01, 0x02, 0x03, 0x04]);

      const result = await sendCardEmm(samplePayload);
      expect(result.ok).toBe(true);
      expect(result.code).toBe(0x2100);
      expect(receivedEmm!).toBe(Buffer.from(samplePayload).toString("base64"));
    } finally {
      server.stop();
    }
  });

  test("sendCardEmm はエージェントがエラー応答のときに ok: false を返す", async () => {
    const server = serveFakeAgent(async () => {
      return new Response("internal error", { status: 500 });
    });

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const result = await sendCardEmm(Uint8Array.from([0x01]));
      expect(result.ok).toBe(false);
      expect(result.code).toBe(0);
      expect(result.error).toContain("500");
    } finally {
      server.stop();
    }
  });
});

describe("processEmmStream パイプライン", () => {
  function makeCat(caPid: number): Uint8Array {
    const desc = [
      0x09,
      0x04,
      (CA_SYSTEM_BCAS >> 8) & 0xff,
      CA_SYSTEM_BCAS & 0xff,
      0xe0 | ((caPid >> 8) & 0x1f),
      caPid & 0xff,
    ];
    return withCrc([
      TABLE_CAT,
      0xb0,
      0x00,
      0xff,
      0xff,
      0xc1,
      0x00,
      0x00,
      ...desc,
    ]);
  }

  function makeEmmSection(
    cardIdBytes: number[],
    updateNo = 0x0100,
  ): Uint8Array {
    const infoLength = 6;
    const infoData = [
      0x00,
      0x01,
      (updateNo >> 8) & 0xff,
      updateNo & 0xff,
      0xd6,
      0xd8,
    ];
    const emmElement = [...cardIdBytes, infoLength, ...infoData];

    return withCrc([
      TABLE_EMM_S,
      0xb0,
      0x00,
      0x00,
      0x00,
      0xc1,
      0x00,
      0x00,
      ...emmElement,
    ]);
  }

  test("ストリームから対象カードの EMM を抽出してカードを更新する", async () => {
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card/emm" && req.method === "POST") {
        return Response.json({ ok: true, code: 0x2100 });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);

      const targetCardId = 0x123456789012n;
      const targetCardBytes = [0x12, 0x34, 0x56, 0x78, 0x90, 0x12];
      const otherCardBytes = [0x99, 0x88, 0x77, 0x66, 0x55, 0x44];

      // CAT (PID 0x0001) -> EMM PID 0x0200
      const catBytes = packetize(PID_CAT, makeCat(0x0200));

      // EMM-S (PID 0x0200) に自分宛てと他人宛てを含める
      const targetEmmBytes = packetize(
        0x0200,
        makeEmmSection(targetCardBytes, 0x1001),
      );
      const otherEmmBytes = packetize(
        0x0200,
        makeEmmSection(otherCardBytes, 0x1002),
      );

      const fullTs = Uint8Array.from([
        ...catBytes,
        ...otherEmmBytes,
        ...targetEmmBytes,
      ]);

      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(fullTs);
          controller.close();
        },
      });

      const receivedMessages: bigint[] = [];
      const stats = await processEmmStream(
        readable,
        targetCardId,
        undefined,
        (msg, res) => {
          receivedMessages.push(msg.cardId);
          expect(res.ok).toBe(true);
        },
      );

      expect(stats.processed).toBe(1);
      expect(stats.success).toBe(1);
      expect(stats.errors).toBe(0);
      expect(receivedMessages).toEqual([targetCardId]);
    } finally {
      server.stop();
    }
  });
});

describe("processEmmStream 時間切れ", () => {
  test("受信の時間切れで読み取りが中断されても、例外にせず集計を返す", async () => {
    const controller = new AbortController();
    const readable = new ReadableStream<Uint8Array>({
      start(stream) {
        controller.signal.addEventListener("abort", () =>
          stream.error(new DOMException("aborted", "AbortError")),
        );
      },
    });
    setTimeout(() => controller.abort(), 20);
    const stats = await processEmmStream(readable, 1n, controller.signal);
    expect(stats).toEqual({ processed: 0, success: 0, errors: 0, emmPids: [] });
  });

  test("時間切れでないエラーはそのまま投げる", async () => {
    const readable = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.error(new Error("切れました"));
      },
    });
    await expect(processEmmStream(readable, 1n)).rejects.toThrow("切れました");
  });
});

describe("receiveEmm 異常系", () => {
  test("カード未認識時は例外を投げる", async () => {
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json({
          ok: false,
          message: "カードリーダーがありません",
          source: "local",
          readers: [],
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      await expect(receiveEmm()).rejects.toThrow("カードリーダーがありません");
    } finally {
      server.stop();
    }
  });
});
