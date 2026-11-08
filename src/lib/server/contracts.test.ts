import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACKET, SYNC } from "@danything/arib/psi";
import {
  packetize,
  patSection,
  programMap,
  stream,
} from "@danything/arib/synth";

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
  contractStatus,
  groupByChannel,
  testDecodeUnverified,
  fromMjd,
  getContractRows,
  DECODE_VALID_MS,
  isCodeSubscribed,
  noteStillScrambled,
  paidAllowed,
  testDecode,
  toMjd,
} = await import("./contracts");
const { fakeAgentUrl, ONE_CARD, serveFakeAgent } = await import("./fake-agent");

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

/**
 * 局 `serviceId` を含む物理チャンネルの TS (`testDecode` が局だけに絞って数える)。
 * PAT・PMT のあとに、その局の映像のパケットを `count` 個と、同じ中継器の別の局 (9999) のパケットを同じ数だけ交互に並べる
 */
function channelStream(
  serviceId: number,
  count: number,
  own: "clear" | "scrambled",
  other: "clear" | "scrambled" = "clear",
): Uint8Array<ArrayBuffer> {
  const media = (pid: number, scrambled: boolean, counter: number) => {
    const packet = new Uint8Array(PACKET).fill(0xff);
    packet[0] = SYNC;
    packet[1] = pid >> 8;
    packet[2] = pid & 0xff;
    // ペイロードあり。スクランブルなら transport_scrambling_control = 10
    packet[3] = (scrambled ? 0x90 : 0x10) | (counter & 0x0f);
    return packet;
  };
  const parts = [
    packetize(
      0x0000,
      patSection([
        [serviceId, 0x0101],
        [9999, 0x0201],
      ]),
    ),
    packetize(0x0101, programMap(serviceId, 0x0111, [[0x02, 0x0111]])),
    packetize(0x0201, programMap(9999, 0x0211, [[0x02, 0x0211]])),
  ];
  for (let i = 0; i < count; i++) {
    parts.push(media(0x0111, own === "scrambled", i));
    parts.push(media(0x0211, other === "scrambled", i));
  }
  // Response に渡せるよう、ArrayBuffer を持つ形に写す
  return new Uint8Array(stream(...parts));
}

/** 確かめる時刻に、その局で有料の番組 (`isFree` なら無料の番組) を流していることにする */
function airing(serviceId: number, isFree = false): void {
  orm()
    .insert(programs)
    .values({
      id: serviceId * 1000 + 1,
      service_id: serviceId,
      network_id: 4,
      event_id: 1,
      start_at: Date.now() - 60_000,
      end_at: Date.now() + 3600_000,
      name: isFree ? "無料の時間帯" : "有料の番組",
      is_free: isFree,
      updated_at: Date.now(),
    })
    .run();
}

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
        return Response.json(ONE_CARD);
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

  test("1 週間以内に期限が来る局は、今日はまだ観られるので契約中のまま。期限の日を覚える", async () => {
    const nowMjd = toMjd();
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json(ONE_CARD);
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
      expect(results[0]?.state).toBe("subscribed");
      // 2 日後まで観られる = 3 日後の 0 時 (JST) に切れる
      expect(results[0]?.validUntil).toBe(fromMjd(nowMjd + 3));
    } finally {
      server.stop();
    }
  });
});

describe("契約の更新 (EMM) のあとの確かめ直し", () => {
  test("カードの答えが替わったら、確かめ直したあとに状態と期限が替わる", async () => {
    const { recheckContracts } = await import("./scheduler");
    const nowMjd = toMjd();
    // 初めは 5 日前に切れている。カードが更新を受け入れたあとは、2 日後まで観られる
    let lastDay = nowMjd - 5;
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json(ONE_CARD);
      }
      if (url.pathname === "/denpa/card/confirm") {
        const body = (await req.json()) as { date: number };
        return Response.json({
          ok: true,
          code: body.date <= lastDay ? 0x0800 : 0,
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    orm()
      .insert(services)
      .values({
        id: 107,
        service_id: 107,
        network_id: 4,
        name: "更新した局",
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
        name: "更新後の番組",
        is_free: false,
        contract_verification: "BwgJ",
        updated_at: Date.now(),
      })
      .run();

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      await recheckContracts();
      const before = getContractRows("0000111122223333");
      expect(before[0]?.state).toBe("expired");
      expect(before[0]?.validUntil).toBe(fromMjd(nowMjd - 4));

      lastDay = nowMjd + 2;
      await recheckContracts();
      const after = getContractRows("0000111122223333");
      expect(after).toHaveLength(1);
      expect(after[0]?.state).toBe("subscribed");
      expect(after[0]?.validUntil).toBe(fromMjd(nowMjd + 3));
    } finally {
      server.stop();
    }
  });
});

describe("testDecode", () => {
  test("スクランブルが解除されているストリームで decodeOk: true", async () => {
    // その局のパケットは復号できている。同じ中継器の別の局は掛かったまま (数えない)
    const buf = channelStream(103, 100, "clear", "scrambled");

    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json(ONE_CARD);
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
    airing(103);

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

  test("カードが期限切れと答えた局は、復号できても期限切れのまま (カードの答えを信じる)", async () => {
    const buf = channelStream(107, 100, "clear");
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") return Response.json(ONE_CARD);
      if (url.pathname === "/denpa/stream") return new Response(buf);
      return new Response("Not Found", { status: 404 });
    });
    orm()
      .insert(services)
      .values({
        id: 107,
        service_id: 107,
        network_id: 4,
        name: "期限切れの局",
        type: "BS",
        channel: "BS13",
        updated_at: Date.now(),
      })
      .run();
    airing(107);
    orm()
      .insert(cardContracts)
      .values({
        card_id: "0000111122223333",
        service_id: 107,
        state: "expired",
        code: 0,
        checked_at: Date.now(),
      })
      .run();
    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const res = await testDecode(107);
      expect(res.decodeOk).toBe(true);
      const row = getContractRows("0000111122223333")[0];
      expect(row?.state).toBe("expired");
      expect(row?.decodeOk).toBe(true);
      expect(paidAllowed()(107)).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("スクランブルが残存しているストリームで decodeOk: false", async () => {
    // その局のパケットは掛かったまま。同じ中継器の無料の局が掛かっていなくても、復号できたことにしない
    const buf = channelStream(104, 100, "scrambled", "clear");

    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json(ONE_CARD);
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
    airing(104);

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
        return Response.json(ONE_CARD);
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
    // その局のパケットが 50 個に届かない (PAT・PMT を足しても)
    const buf = channelStream(105, 10, "clear");

    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json(ONE_CARD);
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
    airing(105);

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const res = await testDecode(105);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("十分なパケットを受信できませんでした");
    } finally {
      server.stop();
    }
  });

  test("いま無料の番組を流している局は、確かめずに断る (契約中と取り違えない)", async () => {
    orm()
      .insert(services)
      .values({
        id: 106,
        service_id: 106,
        network_id: 4,
        name: "無料の時間帯の局",
        type: "BS",
        channel: "BS11",
        updated_at: Date.now(),
      })
      .run();
    airing(106, true);
    const server = serveFakeAgent(async (req) =>
      new URL(req.url).pathname === "/denpa/card"
        ? Response.json(ONE_CARD)
        : new Response("Not Found", { status: 404 }),
    );
    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const res = await testDecode(106);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("無料の番組");
      expect(getContractRows("0000111122223333")).toEqual([]);
    } finally {
      server.stop();
    }
  });
});

describe("ダイアログに出す契約の状態", () => {
  const now = Date.now();
  const fresh = now - 60_000;
  const stale = now - DECODE_VALID_MS - 60_000;
  test("カードが答えた局はその答え、答えの無い局は新しい復号の結果で決める", () => {
    const rows: Parameters<typeof contractStatus>[0][] = [
        { state: "subscribed", code: 0x0800, decodeOk: null, decodedAt: null },
        { state: "expired", code: 0, decodeOk: true, decodedAt: fresh },
        { state: "unsubscribed", code: 0, decodeOk: null, decodedAt: null },
        { state: "subscribed", code: null, decodeOk: true, decodedAt: fresh },
        // 31 日を過ぎた復号の結果は、確かめていないのと同じ
        { state: "subscribed", code: null, decodeOk: true, decodedAt: stale },
        // 番組表に 0xCB が無く、復号も試していない (`checkContracts` が未契約で書く)
        { state: "unsubscribed", code: null, decodeOk: null, decodedAt: null },
        // 復号を試して掛かったままだった
        { state: "unsubscribed", code: null, decodeOk: false, decodedAt: null },
    ];
    expect(rows.map((row) => contractStatus(row, now))).toEqual([
      "subscribed",
      "expired",
      "unsubscribed",
      "subscribed",
      "unverified",
      "unverified",
      "unsubscribed",
    ]);
  });

  test("行がまだ無い有料の局も、確かめていない局として一覧に出す", () => {
    for (const id of [1, 2])
      orm()
        .insert(services)
        .values({
          id,
          service_id: id,
          network_id: 7,
          name: `CS${id}`,
          type: "CS",
          channel: `CS${id * 2}`,
          updated_at: Date.now(),
        })
        .run();
    airing(1);
    airing(2, true);
    const rows = getContractRows("0000111122223333");
    expect(rows.map((row) => [row.serviceId, row.status])).toEqual([
      [1, "unverified"],
    ]);
  });
});

describe("確かめていない局の復号をまとめて確かめる (testDecodeUnverified)", () => {
  test("同じ物理チャンネルの局は 1 つの組にまとめる。組と局の並びは渡した順", () => {
    expect(
      groupByChannel([
        { id: 1, type: "CS", channel: "CS2" },
        { id: 2, type: "BS", channel: "BS01_0" },
        { id: 3, type: "CS", channel: "CS2" },
        { id: 4, type: "CS", channel: "CS4" },
        { id: 5, type: "BS", channel: "BS01_0" },
      ]).map((group) => group.map((target) => target.id)),
    ).toEqual([[1, 3], [2, 5], [4]]);
    expect(groupByChannel([])).toEqual([]);
  });

  test("チャンネルごとに 1 回だけ選局し、その中の確かめていない局をまとめて確かめる", async () => {
    // BS05 には局 103 (復号できる) と局 9999 (掛かったまま)、BS07 には局 104 (掛かったまま)
    const streams: string[] = [];
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") return Response.json(ONE_CARD);
      if (url.pathname === "/denpa/stream") {
        const channel = url.searchParams.get("channel") ?? "";
        streams.push(channel);
        return new Response(
          channel === "BS05"
            ? channelStream(103, 100, "clear", "scrambled")
            : channelStream(104, 100, "scrambled"),
        );
      }
      return new Response("Not Found", { status: 404 });
    });
    const service = (id: number, arib: number, channel: string) =>
      orm()
        .insert(services)
        .values({
          id,
          service_id: arib,
          network_id: 4,
          name: `局${id}`,
          type: "BS",
          channel,
          updated_at: Date.now(),
        })
        .run();
    service(1, 103, "BS05");
    service(2, 9999, "BS05");
    service(3, 104, "BS07");
    service(4, 105, "BS09");
    service(5, 106, "BS11");
    for (const id of [1, 2, 3, 5]) airing(id);
    // 4 はいま無料の番組を流している。5 はカードが答えた (確かめていない局ではない)
    airing(4, true);
    orm()
      .insert(programs)
      .values({
        id: 4002,
        service_id: 4,
        network_id: 4,
        event_id: 2,
        start_at: Date.now() + 3600_000,
        end_at: Date.now() + 7200_000,
        name: "あとの有料の番組",
        is_free: false,
        updated_at: Date.now(),
      })
      .run();
    orm()
      .insert(cardContracts)
      .values({
        card_id: "0000111122223333",
        service_id: 5,
        state: "subscribed",
        code: 0x0800,
        checked_at: Date.now(),
      })
      .run();

    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      const res = await testDecodeUnverified();
      if (!res.ok) throw new Error(res.error);
      expect([...streams].sort()).toEqual(["BS05", "BS07"]);
      expect(res.results.get(1)).toEqual({ ok: true, decodeOk: true });
      expect(res.results.get(2)).toEqual({ ok: true, decodeOk: false });
      expect(res.results.get(3)).toEqual({ ok: true, decodeOk: false });
      expect(res.results.get(4)?.ok).toBe(false);
      expect(res.results.has(5)).toBe(false);
      const status = new Map(
        getContractRows("0000111122223333").map((row) => [
          row.serviceId,
          row.status,
        ]),
      );
      expect([1, 2, 3, 4, 5].map((id) => status.get(id))).toEqual([
        "subscribed",
        "unsubscribed",
        "unsubscribed",
        "unverified",
        "subscribed",
      ]);
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
        return Response.json(ONE_CARD);
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
        return Response.json(ONE_CARD);
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
      // 5 日前まで観られた = 4 日前の 0 時 (JST) に切れた
      expect(results[0]?.validUntil).toBe(fromMjd(nowMjd - 4));
    } finally {
      server.stop();
    }
  });

  test("エージェントが500エラーを返した際に未契約に上書きせず例外を投げる", async () => {
    const server = serveFakeAgent(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/denpa/card") {
        return Response.json(ONE_CARD);
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
      // DB に誤って未契約が保存されていない (行が無いので、確かめていない局として出る)
      const rows = getContractRows("0000111122223333");
      expect(rows.map((row) => [row.status, row.checkedAt])).toEqual([
        ["unverified", null],
      ]);
    } finally {
      server.stop();
    }
  });
});

describe("有料放送を録ってよい局 (paidAllowed)", () => {
  const card = "0000111122223333";
  const row = (
    serviceId: number,
    fields: Partial<typeof cardContracts.$inferInsert>,
  ) =>
    orm()
      .insert(cardContracts)
      .values({
        card_id: card,
        service_id: serviceId,
        state: "subscribed",
        checked_at: Date.now(),
        ...fields,
      })
      .run();

  test("カードが答えた契約は日数に関わらず録る。復号テストで確かめた契約は 31 日まで", () => {
    const now = Date.now();
    row(1, { code: 0x0800 });
    row(2, {
      code: null,
      decode_ok: true,
      decoded_at: now - DECODE_VALID_MS + 60_000,
    });
    row(3, {
      code: null,
      decode_ok: true,
      decoded_at: now - DECODE_VALID_MS - 60_000,
    });
    row(4, { state: "unsubscribed", code: 0 });
    const ok = paidAllowed(now);
    expect([1, 2, 3, 4, 5].map(ok)).toEqual([true, true, false, false, false]);
  });

  test("録画が掛かったまま終わったら、カードに聞けない局だけ未契約に下げる", () => {
    for (const id of [1, 2])
      orm()
        .insert(services)
        .values({
          id,
          service_id: id,
          network_id: 7,
          name: `CS${id}`,
          type: "CS",
          channel: `CS${id * 2}`,
          updated_at: Date.now(),
        })
        .run();
    row(1, { code: 0x0800 });
    row(2, { code: null, decode_ok: true, decoded_at: Date.now() });
    noteStillScrambled(1);
    noteStillScrambled(2);
    const rows = new Map(getContractRows(card).map((r) => [r.serviceId, r]));
    expect(rows.get(1)?.state).toBe("subscribed");
    expect(rows.get(2)?.state).toBe("unsubscribed");
    expect(rows.get(2)?.decodeOk).toBe(false);
    expect(paidAllowed()(2)).toBe(false);
  });
});
