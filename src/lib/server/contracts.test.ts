import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACKET, SYNC } from "@danything/arib/psi";

const { config } = await import("./config");
const realAgent = config.agentUrl;
const realData = config.dataDir;
const realDb = config.dbPath;

const testDir = mkdtempSync(join(tmpdir(), "denpa-contracts-"));
config.dataDir = testDir;
config.dbPath = join(testDir, "denpa.db");

const { orm } = await import("./db");
const { cardContracts, programs, services } = await import("./schema");
const {
  checkContracts,
  confirmCardContract,
  fromMjd,
  getContractRows,
  getContractWarning,
  getContractWarningsByService,
  isCodeSubscribed,
  testDecode,
  toMjd,
} = await import("./contracts");
const { fakeAgentUrl, serveFakeAgent } = await import("./fake-agent");

afterAll(() => {
  config.agentUrl = realAgent;
  config.dataDir = realData;
  config.dbPath = realDb;
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  orm().delete(cardContracts).run();
  orm().delete(programs).run();
  orm().delete(services).run();
});

describe("MJD 計算とビットフラグ判定", () => {
  test("1970-01-01 JST 00:00:00 の MJD は 40587", () => {
    // 1970-01-01 00:00:00 JST = 1969-12-31 15:00:00 UTC
    const date = new Date(Date.UTC(1969, 11, 31, 15, 0, 0));
    expect(toMjd(date)).toBe(40587);
  });

  test("MJD 相互変換の可逆性", () => {
    const originalMjd = 60000;
    const dateMs = fromMjd(originalMjd);
    expect(toMjd(new Date(dateMs))).toBe(originalMjd);
  });

  test("isCodeSubscribed は月額TierまたはPPVのビットを判定する", () => {
    expect(isCodeSubscribed(0x0800)).toBe(true); // 月額Tier
    expect(isCodeSubscribed(0x0400)).toBe(true); // 前払いPPV
    expect(isCodeSubscribed(0x0200)).toBe(true); // 後払いPPV
    expect(isCodeSubscribed(0x0800 | 0x0001)).toBe(true);
    expect(isCodeSubscribed(0x8901)).toBe(false); // 契約の答えではない値
    expect(isCodeSubscribed(0x0000)).toBe(false);
    expect(isCodeSubscribed(0x0100)).toBe(false);
  });
});

describe("confirmCardContract", () => {
  test("エージェントが 200 OK のとき返り値コードを返す", async () => {
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card/confirm") {
        return Response.json({ ok: true, code: 0x0800 });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const res = await confirmCardContract("dGVzdA==", 60000);
      expect(res.ok).toBe(true);
      expect(res.code).toBe(0x0800);
    } finally {
      server.stop();
    }
  });

  test("エージェントがエラー応答のときは ok: false を返す", async () => {
    const server = serveFakeAgent(async () => {
      return new Response("internal error", { status: 500 });
    });

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const res = await confirmCardContract("dGVzdA==", 60000);
      expect(res.ok).toBe(false);
      expect(res.code).toBe(0);
      expect(res.error).toContain("500");
    } finally {
      server.stop();
    }
  });
});

describe("checkContracts", () => {
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
      await expect(checkContracts()).rejects.toThrow(
        "カードリーダーがありません",
      );
    } finally {
      server.stop();
    }
  });

  test("有料番組の契約確認を行い card_contracts を更新する", async () => {
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json({
          ok: true,
          message: "",
          source: "local",
          readers: [
            {
              name: "CardReader",
              card: true,
              ids: ["0000111122223333"],
              active: true,
              tuners: [],
            },
          ],
        });
      }
      if (url.pathname === "/denpa/card/confirm") {
        return Response.json({ ok: true, code: 0x0800 });
      }
      return new Response("Not Found", { status: 404 });
    });

    // テスト用のサービスと有料番組を登録
    orm()
      .insert(services)
      .values({
        id: 101,
        service_id: 101,
        network_id: 4,
        name: "有料シネマ",
        type: "BS",
        channel: "BS01",
        updated_at: Date.now(),
      })
      .run();

    orm()
      .insert(programs)
      .values({
        id: 201,
        service_id: 101,
        network_id: 4,
        event_id: 1,
        start_at: Date.now(),
        end_at: Date.now() + 3600_000,
        name: "映画サンプル",
        is_free: false,
        contract_verification: "AQIDBAU=",
        updated_at: Date.now(),
      })
      .run();

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const results = await checkContracts();
      expect(results).toHaveLength(1);
      expect(results[0]?.serviceName).toBe("有料シネマ");
      expect(results[0]?.state).toBe("subscribed");
      expect(results[0]?.code).toBe(0x0800);

      const dbRows = getContractRows("0000111122223333");
      expect(dbRows).toHaveLength(1);
      expect(dbRows[0]?.state).toBe("subscribed");
    } finally {
      server.stop();
    }
  });

  test("1週間後が無効な局は expired と判定される", async () => {
    const nowMjd = toMjd();
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json({
          ok: true,
          message: "",
          source: "local",
          readers: [
            {
              name: "CardReader",
              card: true,
              ids: ["0000111122223333"],
              active: true,
              tuners: [],
            },
          ],
        });
      }
      if (url.pathname === "/denpa/card/confirm") {
        const body = (await req.json()) as { date: number };
        // 今日から2日後までは有効、3日後以降は無効
        const isSub = body.date <= nowMjd + 2;
        return Response.json({ ok: true, code: isSub ? 0x0800 : 0 });
      }
      return new Response("Not Found", { status: 404 });
    });

    orm()
      .insert(services)
      .values({
        id: 102,
        service_id: 102,
        network_id: 4,
        name: "まもなく期限切れ局",
        type: "BS",
        channel: "BS03",
        updated_at: Date.now(),
      })
      .run();

    orm()
      .insert(programs)
      .values({
        id: 202,
        service_id: 102,
        network_id: 4,
        event_id: 2,
        start_at: Date.now(),
        end_at: Date.now() + 3600_000,
        name: "特別ライブ",
        is_free: false,
        contract_verification: "BQYHCAk=",
        updated_at: Date.now(),
      })
      .run();

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const results = await checkContracts();
      expect(results).toHaveLength(1);
      expect(results[0]?.state).toBe("expired");
      expect(results[0]?.validUntil).toBeDefined();
    } finally {
      server.stop();
    }
  });
});

describe("testDecode", () => {
  test("スクランブルが解除されているストリームで decodeOk: true", async () => {
    // 正常パケット (transport_scrambling_control = 00)
    const packets = 100;
    const buf = new Uint8Array(PACKET * packets);
    for (let i = 0; i < packets; i++) {
      buf[i * PACKET] = SYNC;
      buf[i * PACKET + 3] = 0x10; // scrambling = 00
    }

    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json({
          ok: true,
          message: "",
          source: "local",
          readers: [
            {
              name: "CardReader",
              card: true,
              ids: ["0000111122223333"],
              active: true,
              tuners: [],
            },
          ],
        });
      }
      if (url.pathname === "/denpa/stream") {
        return new Response(buf, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    orm()
      .insert(services)
      .values({
        id: 103,
        service_id: 103,
        network_id: 4,
        name: "テスト局",
        type: "BS",
        channel: "BS05",
        updated_at: Date.now(),
      })
      .run();

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const res = await testDecode(103);
      if (!res.ok) console.log("testDecode failed:", res);
      expect(res.ok).toBe(true);
      expect(res.decodeOk).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("スクランブルが残存しているストリームで decodeOk: false", async () => {
    // スクランブルパケット (transport_scrambling_control = 10)
    const packets = 100;
    const buf = new Uint8Array(PACKET * packets);
    for (let i = 0; i < packets; i++) {
      buf[i * PACKET] = SYNC;
      buf[i * PACKET + 3] = 0x90; // scrambling = 10 (0x80)
    }

    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json({
          ok: true,
          message: "",
          source: "local",
          readers: [
            {
              name: "CardReader",
              card: true,
              ids: ["0000111122223333"],
              active: true,
              tuners: [],
            },
          ],
        });
      }
      if (url.pathname === "/denpa/stream") {
        return new Response(buf, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    orm()
      .insert(services)
      .values({
        id: 104,
        service_id: 104,
        network_id: 4,
        name: "暗号局",
        type: "BS",
        channel: "BS07",
        updated_at: Date.now(),
      })
      .run();

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const res = await testDecode(104);
      expect(res.ok).toBe(true);
      expect(res.decodeOk).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("存在しない serviceId はエラーを返す", async () => {
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json({
          ok: true,
          message: "",
          source: "local",
          readers: [
            {
              name: "CardReader",
              card: true,
              ids: ["0000111122223333"],
              active: true,
              tuners: [],
            },
          ],
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const res = await testDecode(99999);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("サービスが見つかりません");
    } finally {
      server.stop();
    }
  });

  test("受信パケットが50未満のときはエラーを返す", async () => {
    const packets = 10; // 50未満
    const buf = new Uint8Array(PACKET * packets);
    for (let i = 0; i < packets; i++) {
      buf[i * PACKET] = SYNC;
      buf[i * PACKET + 3] = 0x10;
    }

    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json({
          ok: true,
          message: "",
          source: "local",
          readers: [
            {
              name: "CardReader",
              card: true,
              ids: ["0000111122223333"],
              active: true,
              tuners: [],
            },
          ],
        });
      }
      if (url.pathname === "/denpa/stream") {
        return new Response(buf, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    orm()
      .insert(services)
      .values({
        id: 105,
        service_id: 105,
        network_id: 4,
        name: "微小パケット局",
        type: "BS",
        channel: "BS09",
        updated_at: Date.now(),
      })
      .run();

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const res = await testDecode(105);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("十分なパケットを受信できませんでした");
    } finally {
      server.stop();
    }
  });
});

describe("checkContracts エッジケース・異常系", () => {
  test("有料番組が0件のときは空配列を返す", async () => {
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json({
          ok: true,
          message: "",
          source: "local",
          readers: [
            {
              name: "CardReader",
              card: true,
              ids: ["0000111122223333"],
              active: true,
              tuners: [],
            },
          ],
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const res = await checkContracts();
      expect(res).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("過去30日前に有効だった局は expired と判定され期限日が求まる", async () => {
    const nowMjd = toMjd();
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json({
          ok: true,
          message: "",
          source: "local",
          readers: [
            {
              name: "CardReader",
              card: true,
              ids: ["0000111122223333"],
              active: true,
              tuners: [],
            },
          ],
        });
      }
      if (url.pathname === "/denpa/card/confirm") {
        const body = (await req.json()) as { date: number };
        // 5日前に切れた局 (nowMjd - 5 まで有効、-4以降は無効)
        const isSub = body.date <= nowMjd - 5;
        return Response.json({ ok: true, code: isSub ? 0x0800 : 0 });
      }
      return new Response("Not Found", { status: 404 });
    });

    orm()
      .insert(services)
      .values({
        id: 106,
        service_id: 106,
        network_id: 4,
        name: "過去失効局",
        type: "BS",
        channel: "BS11",
        updated_at: Date.now(),
      })
      .run();

    orm()
      .insert(programs)
      .values({
        id: 206,
        service_id: 106,
        network_id: 4,
        event_id: 6,
        start_at: Date.now(),
        end_at: Date.now() + 3600_000,
        name: "過去番組",
        is_free: false,
        contract_verification: "CQE=",
        updated_at: Date.now(),
      })
      .run();

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const results = await checkContracts();
      expect(results).toHaveLength(1);
      expect(results[0]?.state).toBe("expired");
      expect(results[0]?.validUntil).toBeDefined();
    } finally {
      server.stop();
    }
  });

  test("エージェントが500エラーを返した際に未契約に上書きせず例外を投げる", async () => {
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json({
          ok: true,
          message: "",
          source: "local",
          readers: [
            {
              name: "CardReader",
              card: true,
              ids: ["0000111122223333"],
              active: true,
              tuners: [],
            },
          ],
        });
      }
      if (url.pathname === "/denpa/card/confirm") {
        return new Response("card hardware error", { status: 500 });
      }
      return new Response("Not Found", { status: 404 });
    });

    orm()
      .insert(services)
      .values({
        id: 107,
        service_id: 107,
        network_id: 4,
        name: "エラー局",
        type: "BS",
        channel: "BS13",
        updated_at: Date.now(),
      })
      .run();

    orm()
      .insert(programs)
      .values({
        id: 207,
        service_id: 107,
        network_id: 4,
        event_id: 7,
        start_at: Date.now(),
        end_at: Date.now() + 3600_000,
        name: "エラー番組",
        is_free: false,
        contract_verification: "DAE=",
        updated_at: Date.now(),
      })
      .run();

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      await expect(checkContracts()).rejects.toThrow(
        "問い合わせに失敗しました",
      );
      // DB に誤って unsubsribed が保存されていないことを検証
      const rows = getContractRows("0000111122223333");
      expect(rows).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  describe("getContractWarning / getContractWarningsByService", () => {
    test("無料番組なら局の状態に関わらず null を返す", () => {
      orm()
        .insert(cardContracts)
        .values({
          card_id: "0000111122223333",
          service_id: 101,
          state: "expired",
          checked_at: Date.now(),
        })
        .run();

      expect(getContractWarning(101, true)).toBeNull();
    });

    test("有料番組で期限切れ局は 'expired'、未契約局は 'unsubscribed' を返す", () => {
      orm()
        .insert(cardContracts)
        .values({
          card_id: "0000111122223333",
          service_id: 101,
          state: "expired",
          checked_at: Date.now(),
        })
        .run();

      orm()
        .insert(cardContracts)
        .values({
          card_id: "0000111122223333",
          service_id: 102,
          state: "unsubscribed",
          checked_at: Date.now(),
        })
        .run();

      orm()
        .insert(cardContracts)
        .values({
          card_id: "0000111122223333",
          service_id: 103,
          state: "subscribed",
          checked_at: Date.now(),
        })
        .run();

      expect(getContractWarning(101, false)).toBe("expired");
      expect(getContractWarning(102, false)).toBe("unsubscribed");
      expect(getContractWarning(103, false)).toBeNull();
      expect(getContractWarning(999, false)).toBeNull();

      const map = getContractWarningsByService();
      expect(map.get(101)).toBe("expired");
      expect(map.get(102)).toBe("unsubscribed");
      expect(map.has(103)).toBe(false);
    });

    test("複数カードがある場合、契約中があれば警告なし、なければ expired 優先", () => {
      orm()
        .insert(cardContracts)
        .values({
          card_id: "card_a",
          service_id: 201,
          state: "unsubscribed",
          checked_at: Date.now(),
        })
        .run();
      orm()
        .insert(cardContracts)
        .values({
          card_id: "card_b",
          service_id: 201,
          state: "subscribed",
          checked_at: Date.now(),
        })
        .run();

      orm()
        .insert(cardContracts)
        .values({
          card_id: "card_a",
          service_id: 202,
          state: "unsubscribed",
          checked_at: Date.now(),
        })
        .run();
      orm()
        .insert(cardContracts)
        .values({
          card_id: "card_b",
          service_id: 202,
          state: "expired",
          checked_at: Date.now(),
        })
        .run();

      expect(getContractWarning(201, false)).toBeNull();
      expect(getContractWarning(202, false)).toBe("expired");
    });
  });

  test("contract_verification が null の局 (CS月額局など) も抽出され、復号テスト成功時に subscribed に更新される", async () => {
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json({
          ok: true,
          message: "",
          source: "local",
          readers: [
            {
              name: "CardReader",
              card: true,
              ids: ["0000111122223333"],
              active: true,
              tuners: [],
            },
          ],
        });
      }
      if (url.pathname.startsWith("/denpa/stream")) {
        const packet = Buffer.alloc(188);
        packet[0] = 0x47;
        packet[3] = 0x10;
        const body = Buffer.concat(Array(100).fill(packet));
        return new Response(body, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      orm()
        .insert(services)
        .values({
          id: 108,
          network_id: 6,
          service_id: 311,
          type: "CS",
          channel: "CS16:28928",
          name: "アニメシアターX",
          remote_control_key: 1,
          updated_at: Date.now(),
        })
        .run();
      orm()
        .insert(programs)
        .values({
          id: 208,
          service_id: 108,
          network_id: 6,
          event_id: 8,
          start_at: Date.now(),
          end_at: Date.now() + 3600_000,
          name: "CS有料アニメ番組",
          is_free: false,
          contract_verification: null,
          updated_at: Date.now(),
        })
        .run();

      const rows = await checkContracts();
      const atx = rows.find((r) => r.serviceId === 108);
      expect(atx).toBeDefined();
      expect(atx?.state).toBe("unsubscribed");
      expect(atx?.code).toBeNull();
      expect(atx?.validUntil).toBeNull();
      expect(atx?.decodeOk).toBeNull();

      const decodeResult = await testDecode(108);
      expect(decodeResult.ok).toBe(true);
      expect(decodeResult.decodeOk).toBe(true);

      const updatedRows = getContractRows("0000111122223333");
      const updatedAtx = updatedRows.find((r) => r.serviceId === 108);
      expect(updatedAtx?.state).toBe("subscribed");
      expect(updatedAtx?.decodeOk).toBe(true);

      const recheckRows = await checkContracts();
      const recheckAtx = recheckRows.find((r) => r.serviceId === 108);
      expect(recheckAtx?.state).toBe("subscribed");
      expect(recheckAtx?.decodeOk).toBe(true);
    } finally {
      server.stop();
    }
  });
});
