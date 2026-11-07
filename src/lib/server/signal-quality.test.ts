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
    hasPayload?: boolean;
    hasAdaptation?: boolean;
    discontinuity?: boolean;
  }): Uint8Array {
    const packet = new Uint8Array(188);
    packet[0] = options.sync ?? 0x47;
    const pid = options.pid ?? 0x100;
    packet[1] = ((options.tei ? 1 : 0) << 7) | ((pid >> 8) & 0x1f);
    packet[2] = pid & 0xff;

    const hasPayload = options.hasPayload ?? true;
    const hasAdaptation =
      options.hasAdaptation ?? options.discontinuity ?? false;
    const afc = (hasAdaptation ? 0x20 : 0x00) | (hasPayload ? 0x10 : 0x00);
    packet[3] = afc | ((options.cc ?? 0) & 0x0f);

    if (hasAdaptation) {
      packet[4] = 1; // afLen = 1
      packet[5] = options.discontinuity ? 0x80 : 0x00;
    }
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

  test("CC の跳躍でパケットドロップ (dropPackets > 0) を正確に検知する", () => {
    const analyzer = new TsQualityAnalyzer();
    const chunk = new Uint8Array(188 * 100);

    let offset = 0;
    // 1. 正常な CC: 0, 1, 2
    for (let cc = 0; cc <= 2; cc++) {
      chunk.set(createPacket({ pid: 0x100, cc }), offset);
      offset += 188;
    }
    // 2. CC を 2 から 5 にジャンプ (lost = 2 パケット)
    chunk.set(createPacket({ pid: 0x100, cc: 5 }), offset);
    offset += 188;
    // 3. 正常に 6, 7, ... 14, 15 と進める
    for (let cc = 6; cc <= 15; cc++) {
      chunk.set(createPacket({ pid: 0x100, cc }), offset);
      offset += 188;
    }
    // 4. ラップアラウンドで 15 から 3 にジャンプ (15 -> 0, 1, 2 が抜けて lost = 3 パケット)
    chunk.set(createPacket({ pid: 0x100, cc: 3 }), offset);
    offset += 188;
    // 残りを 4, 5, ... で埋める
    for (let i = offset / 188; i < 100; i++) {
      chunk.set(
        createPacket({ pid: 0x100, cc: (3 + (i - 15)) & 0x0f }),
        offset,
      );
      offset += 188;
    }

    analyzer.feed(chunk);
    const m = analyzer.metrics(1000);

    expect(m.totalPackets).toBe(100);
    expect(m.dropPackets).toBe(5); // 2 + 3 = 5 ドロップ
    expect(m.dropRate).toBeGreaterThan(0);
    expect(m.quality).toBe("poor"); // 4.76% ドロップ
  });

  test("TEI (Transport Error Indicator) が立ったパケットでエラーを検知し、CC 誤検知を誘発しない", () => {
    const analyzer = new TsQualityAnalyzer();
    const chunk = new Uint8Array(188 * 200);

    for (let i = 0; i < 200; i++) {
      const tei = i % 10 === 0;
      const cc = tei ? 0x05 : i & 0x0f;
      const pkt = createPacket({ pid: 0x100, cc, tei });
      chunk.set(pkt, i * 188);
    }

    analyzer.feed(chunk);
    const m = analyzer.metrics(1000);

    expect(m.totalPackets).toBe(200);
    expect(m.errorPackets).toBe(20);
    expect(m.dropPackets).toBe(0);
    expect(m.errorRate).toBeCloseTo(0.1, 2);
    expect(m.quality).toBe("bad");
  });

  test("AF-only (ペイロードなし) パケットで discontinuity_indicator が立った場合も後続パケットでドロップ誤検知しない", () => {
    const analyzer = new TsQualityAnalyzer();
    const chunk = new Uint8Array(188 * 30);

    let offset = 0;
    // 正常パケット (CC: 0, 1, 2)
    for (let cc = 0; cc <= 2; cc++) {
      chunk.set(createPacket({ pid: 0x100, cc }), offset);
      offset += 188;
    }
    // AF-only パケット (PCR 等。hasPayload: false, discontinuity: true)
    chunk.set(
      createPacket({
        pid: 0x100,
        cc: 2,
        hasPayload: false,
        hasAdaptation: true,
        discontinuity: true,
      }),
      offset,
    );
    offset += 188;
    // 後続のペイロードパケットで CC が 9 にジャンプしているが、不連続フラグによりリセットされているためドロップ 0
    for (let i = 0; i < 26; i++) {
      chunk.set(createPacket({ pid: 0x100, cc: (9 + i) & 0x0f }), offset);
      offset += 188;
    }

    analyzer.feed(chunk);
    const m = analyzer.metrics(1000);

    expect(m.totalPackets).toBe(30);
    expect(m.dropPackets).toBe(0);
  });

  test("NULL パケット (PID 0x1fff) は有効ビットレートから除外され CC 追跡されない", () => {
    const analyzer = new TsQualityAnalyzer();
    const chunk = new Uint8Array(188 * 100);

    // 50 個の通常パケット + 50 個の NULL パケット
    for (let i = 0; i < 50; i++) {
      chunk.set(createPacket({ pid: 0x100, cc: i & 0x0f }), i * 188);
    }
    for (let i = 50; i < 100; i++) {
      chunk.set(createPacket({ pid: 0x1fff, cc: i & 0x0f }), i * 188);
    }

    analyzer.feed(chunk);
    const m = analyzer.metrics(1000);

    expect(m.totalPackets).toBe(100);
    expect(m.dropPackets).toBe(0);
    expect(m.bitrateMbps).toBeCloseTo((100 * 188 * 8) / 1_000_000, 1);
    expect(m.effectiveBitrateMbps).toBeCloseTo((50 * 188 * 8) / 1_000_000, 1);
    expect(m.effectiveBitrateMbps).toBeLessThan(m.bitrateMbps);
  });

  test("複数 PID が混在したストリームで互いに干渉せず独立して CC を追跡する", () => {
    const analyzer = new TsQualityAnalyzer();
    const chunk = new Uint8Array(188 * 60);

    // PID 0x100 と PID 0x200 を交互に送信
    for (let i = 0; i < 30; i++) {
      chunk.set(createPacket({ pid: 0x100, cc: i & 0x0f }), i * 2 * 188);
      chunk.set(createPacket({ pid: 0x200, cc: i & 0x0f }), (i * 2 + 1) * 188);
    }

    analyzer.feed(chunk);
    const m = analyzer.metrics(1000);

    expect(m.totalPackets).toBe(60);
    expect(m.dropPackets).toBe(0);
    expect(m.errorPackets).toBe(0);
  });

  test("細切れチャンク (パケット境界跨ぎ) で届いても正確に復元・解析される", () => {
    const analyzer = new TsQualityAnalyzer();
    const full = new Uint8Array(188 * 30);
    for (let i = 0; i < 30; i++) {
      full.set(createPacket({ pid: 0x100, cc: i & 0x0f }), i * 188);
    }

    let at = 0;
    while (at < full.length) {
      const end = Math.min(at + 73, full.length);
      analyzer.feed(full.subarray(at, end));
      at = end;
    }

    const m = analyzer.metrics(1000);
    expect(m.totalPackets).toBe(30);
    expect(m.dropPackets).toBe(0);
    expect(m.errorPackets).toBe(0);
  });

  test("先頭にノイズ (非 0x47) が混ざっても 3 パケット連続同期で正しく捕捉する", () => {
    const analyzer = new TsQualityAnalyzer();
    const noise = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x47, 0x99]);
    const packets = new Uint8Array(188 * 20);
    for (let i = 0; i < 20; i++) {
      packets.set(createPacket({ pid: 0x100, cc: i & 0x0f }), i * 188);
    }

    const combined = new Uint8Array(noise.length + packets.length);
    combined.set(noise, 0);
    combined.set(packets, noise.length);

    analyzer.feed(combined);
    const m = analyzer.metrics(1000);

    expect(m.totalPackets).toBeGreaterThanOrEqual(17);
    expect(m.dropPackets).toBe(0);
    expect(m.errorPackets).toBe(0);
  });

  test("measureChannelSignal: ストリームを受信して電波測定結果を返す", async () => {
    const { fakeAgentUrl, serveFakeAgent } = await import("./fake-agent");
    const { measureChannelSignal } = await import("./signal-quality");

    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/tuners") {
        return Response.json({
          detected: true,
          tuners: [
            {
              index: 0,
              name: "PT3 ISDB-T (0)",
              types: ["GR"],
              disabled: false,
              rank: 0,
              device: "/dev/pt3video0",
              pin: "0",
              lnb: null,
              channel: { type: "GR", channel: "27" },
              users: [{ use: "scan quality 27", priority: 8 }],
              pid: 1234,
              error: null,
              signal: { locked: true, cn: 26.5, unit: "dB", atTune: false },
            },
          ],
        });
      }
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
      expect(res.tunerSignal).toBeDefined();
      expect(res.tunerSignal?.locked).toBe(true);
      expect(res.tunerSignal?.cn).toBe(26.5);
      expect(res.tunerSignal?.unit).toBe("dB");
    } finally {
      server.stop();
    }
  });

  test("measureChannelSignal: 外部 AbortSignal で即座に中断される", async () => {
    const { fakeAgentUrl, serveFakeAgent } = await import("./fake-agent");
    const { measureChannelSignal } = await import("./signal-quality");

    const aborter = new AbortController();
    let streamClosed = false;

    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/stream") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(createPacket({ pid: 0x100, cc: 0 }));
          },
          cancel() {
            streamClosed = true;
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      // 測定開始直後に abort
      setTimeout(() => aborter.abort(), 50);
      const res = await measureChannelSignal("GR", "27", 5000, aborter.signal);

      expect(res).toBeDefined();
      // 5000ms 指定だが abort されたため短時間で終了したことを検証
      expect(res.durationMs).toBeLessThan(1000);
      await new Promise((r) => setTimeout(r, 50));
      expect(streamClosed).toBe(true);
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

  test("channels.server.ts actions.measureSignal: バリデーションとエラーハンドリング", async () => {
    const { actions } =
      await import("../../routes/settings/reception/channels.server");

    // 1. パラメータ欠落
    const formEmpty = new FormData();
    const reqEmpty = new Request("http://localhost", {
      method: "POST",
      body: formEmpty,
    });
    const resEmpty = (await actions.measureSignal({
      request: reqEmpty,
    } as unknown as Parameters<typeof actions.measureSignal>[0])) as {
      status: number;
      data: { message: string };
    };
    expect(resEmpty.status).toBe(400);
    expect(resEmpty.data.message).toContain("チャンネルを指定してください");

    // 2. 未対応の放送種別
    const formInvalid = new FormData();
    formInvalid.set("type", "UNKNOWN");
    formInvalid.set("channel", "27");
    const reqInvalid = new Request("http://localhost", {
      method: "POST",
      body: formInvalid,
    });
    const resInvalid = (await actions.measureSignal({
      request: reqInvalid,
    } as unknown as Parameters<typeof actions.measureSignal>[0])) as {
      status: number;
      data: { message: string };
    };
    expect(resInvalid.status).toBe(400);
    expect(resInvalid.data.message).toContain("未対応の種別です");
  });
});
