import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TsQualityAnalyzer } from "./signal-quality";

const { config } = await import("./config");
const realAgent = config.agentUrl;
const realData = config.dataDir;
const realDb = config.dbPath;

const testDir = mkdtempSync(join(tmpdir(), "denpa-signal-quality-"));
config.dataDir = testDir;
config.dbPath = join(testDir, "denpa.db");

afterAll(() => {
  config.agentUrl = realAgent;
  config.dataDir = realData;
  config.dbPath = realDb;
  rmSync(testDir, { recursive: true, force: true });
});

describe("TsQualityAnalyzer", () => {
  /** 188 バイトのダミー TS パケットを生成 */
  function createPacket(options: {
    sync?: number;
    tei?: boolean;
    pid?: number;
    cc?: number;
  }): Uint8Array {
    const packet = new Uint8Array(188);
    packet[0] = options.sync ?? 0x47;
    const pid = options.pid ?? 0x100;
    packet[1] = ((options.tei ? 1 : 0) << 7) | ((pid >> 8) & 0x1f);
    packet[2] = pid & 0xff;
    // adaptation_field_control = 0x01 (ペイロードのみ), CC
    packet[3] = 0x10 | ((options.cc ?? 0) & 0x0f);
    return packet;
  }

  test("正常な TS パケットの連続でドロップ・エラー 0 の excellent となる", () => {
    const analyzer = new TsQualityAnalyzer();
    const chunk = new Uint8Array(188 * 200);

    for (let i = 0; i < 200; i++) {
      const pkt = createPacket({ pid: 0x100, cc: i & 0x0f });
      chunk.set(pkt, i * 188);
    }

    analyzer.feed(chunk);
    const m = analyzer.metrics(1000);

    expect(m.totalPackets).toBe(200);
    expect(m.errorPackets).toBe(0);
    expect(m.dropPackets).toBe(0);
    expect(m.errorRate).toBe(0);
    expect(m.dropRate).toBe(0);
    expect(m.quality).toBe("excellent");
    expect(m.qualityLabel).toContain("受信良好");
    expect(m.bitrateMbps).toBeGreaterThan(0);
  });

  test("TEI (Transport Error Indicator) が立ったパケットでエラーを検知する", () => {
    const analyzer = new TsQualityAnalyzer();
    const chunk = new Uint8Array(188 * 200);

    for (let i = 0; i < 200; i++) {
      // 10 パケットに 1 回エラー
      const tei = i % 10 === 0;
      const pkt = createPacket({ pid: 0x100, cc: i & 0x0f, tei });
      chunk.set(pkt, i * 188);
    }

    analyzer.feed(chunk);
    const m = analyzer.metrics(1000);

    expect(m.totalPackets).toBe(200);
    expect(m.errorPackets).toBe(20);
    expect(m.errorRate).toBeCloseTo(0.1, 2);
    expect(m.quality).toBe("bad");
  });

  test("Continuity Counter (CC) の飛びでパケットドロップを検知する", () => {
    const analyzer = new TsQualityAnalyzer();
    const chunk = new Uint8Array(188 * 200);

    let cc = 0;
    for (let i = 0; i < 200; i++) {
      if (i === 50) {
        // CC を 3 つ飛ばす (CC: 0 -> 4)
        cc = (cc + 4) & 0x0f;
      } else {
        cc = (cc + 1) & 0x0f;
      }
      const pkt = createPacket({ pid: 0x100, cc });
      chunk.set(pkt, i * 188);
    }

    analyzer.feed(chunk);
    const m = analyzer.metrics(1000);

    expect(m.totalPackets).toBe(200);
    expect(m.dropPackets).toBe(3);
    expect(m.quality).toBe("poor");
    expect(m.qualityLabel).toContain("注意");
  });

  test("パケット数が少ない場合は none と判定する", () => {
    const analyzer = new TsQualityAnalyzer();
    const chunk = new Uint8Array(188 * 10);

    for (let i = 0; i < 10; i++) {
      chunk.set(createPacket({ pid: 0x100, cc: i & 0x0f }), i * 188);
    }

    analyzer.feed(chunk);
    const m = analyzer.metrics(1000);

    expect(m.totalPackets).toBe(10);
    expect(m.quality).toBe("none");
    expect(m.qualityLabel).toContain("電波なし");
  });

  test("measureChannelSignal: ストリームを受信して電波測定結果を返す", async () => {
    const { fakeAgentUrl, serveFakeAgent } = await import("./fake-agent");
    const { measureChannelSignal } = await import("./signal-quality");

    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/stream") {
        const chunk = new Uint8Array(188 * 100);
        for (let i = 0; i < 100; i++) {
          chunk.set(createPacket({ pid: 0x100, cc: i & 0x0f }), i * 188);
        }
        return new Response(chunk, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const res = await measureChannelSignal("GR", "27", 300);

      expect(res.ok).toBe(true);
      expect(res.channel).toBe("27");
      expect(res.type).toBe("GR");
      expect(res.totalPackets).toBe(100);
      expect(res.errorPackets).toBe(0);
      expect(res.dropPackets).toBe(0);
      expect(res.quality).toBe("excellent");
    } finally {
      server.stop();
    }
  });

  test("measureChannelSignal: エージェント選局エラー時にエラー結果を返す", async () => {
    const { fakeAgentUrl, serveFakeAgent } = await import("./fake-agent");
    const { measureChannelSignal } = await import("./signal-quality");

    const server = serveFakeAgent(async () => {
      return new Response("Tuner busy", { status: 409 });
    });

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const res = await measureChannelSignal("GR", "28", 200);

      expect(res.ok).toBe(false);
      expect(res.quality).toBe("none");
      expect(res.error).toBeDefined();
    } finally {
      server.stop();
    }
  });
});
