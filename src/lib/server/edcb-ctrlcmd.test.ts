import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";

import {
  type FakeRecInfo,
  type FakeReserve,
  type FakeRule,
  MX,
  startFakeEdcb,
  writeAutoAdd,
  Writer,
  writeRecInfo,
  writeReserve,
} from "../../../tests/fake/edcb";
import {
  BrokenReply,
  EdcbClient,
  parseTarget,
  readAutoAdd,
  Reader,
  readRecInfo,
  readReserve,
  RESPONSE_LIMIT,
  timing,
} from "./edcb-ctrlcmd";

/**
 * EpgTimerSrv の CtrlCmd を読む (`edcb-ctrlcmd.ts`)。
 *
 * バイト列は EDCB の `CtrlCmdUtil.cpp` の書き方どおりに、偽サーバの書き出し (`tests/fake/edcb.ts` の `Writer`) で作る。
 * 番組名と局名は作り物
 */
const START = Date.UTC(2026, 8, 1, 12, 0, 0);
const fake = await startFakeEdcb();

const rule: FakeRule = {
  id: 12,
  andKey: "^!{999}テスト番組",
  notKey: "再放送",
  titleOnly: false,
  contents: [
    [7, 0, 0, 0],
    [0xff, 0xff, 0, 0],
  ],
  dates: [
    {
      startDay: 1,
      startHour: 20,
      startMinute: 0,
      endDay: 1,
      endHour: 21,
      endMinute: 30,
    },
  ],
  services: [MX, { networkId: 4, transportStreamId: 0x4010, serviceId: 101 }],
  recMode: 5,
  aimai: true,
  freeCA: 1,
  chkRecEnd: true,
};

const reserve: FakeReserve = {
  id: 3,
  title: "テスト番組 #1",
  startAt: START,
  durationSecond: 1800,
  service: MX,
  stationName: "ＴＯＫＹＯ　ＭＸ１",
  eventId: 1001,
  comment: "EPG自動予約(テスト)",
  recMode: 4,
};

const recInfo: FakeRecInfo = {
  id: 9,
  title: "テスト番組 #0",
  startAt: START - 60_000,
  durationSecond: 1860,
  service: MX,
  serviceName: "ＴＯＫＹＯ　ＭＸ１",
  eventId: 1000,
  recStatus: 4,
  epgStartAt: START,
};

const reader = (write: (w: Writer) => void) => {
  const w = new Writer();
  write(w);
  return Reader.of(w.bytes());
};

describe("宛先", () => {
  test("host:port を読む。ポートを省けば 4510、IPv6 は角かっこで", () => {
    expect(parseTarget(" 192.168.1.10:4510 ")).toEqual({
      host: "192.168.1.10",
      port: 4510,
      label: "192.168.1.10:4510",
    });
    expect(parseTarget("edcb")).toMatchObject({ host: "edcb", port: 4510 });
    expect(parseTarget("[::1]:4600")).toEqual({
      host: "::1",
      port: 4600,
      label: "[::1]:4600",
    });
  });

  test("読めないものは理由を投げる", () => {
    expect(() => parseTarget("tcp://192.168.1.10:4510")).toThrow("host:port");
    expect(() => parseTarget("::1")).toThrow("host:port");
    expect(() => parseTarget("edcb:0")).toThrow("1〜65535");
    expect(() => parseTarget("edcb:70000")).toThrow("1〜65535");
  });
});

describe("値を読む", () => {
  test("文字列は UTF-16LE + NUL。サロゲートペアも空も読む", () => {
    const r = reader((w) => w.string("𠮷野家のテスト").string(""));
    expect(r.string()).toBe("𠮷野家のテスト");
    expect(r.string()).toBe("");
    expect(r.remaining()).toBe(0);
  });

  test("SYSTEMTIME は日本時間の壁時計。年 0 は null、ミリ秒は捨てる", () => {
    const r = reader((w) =>
      w
        .u16(2026)
        .u16(10)
        .u16(0)
        .u16(25)
        .u16(21)
        .u16(0)
        .u16(5)
        .u16(500)
        .time(null),
    );
    expect(r.time()).toBe(Date.UTC(2026, 9, 25, 12, 0, 5));
    expect(r.time()).toBeNull();
  });

  test("構造体は読み終えたら長さの終わりまで飛ばす", () => {
    const r = reader((w) =>
      w.struct((s) => s.u32(7).raw(new Uint8Array(5))).u16(9),
    );
    expect(r.struct((s) => s.u32())).toBe(7);
    expect(r.u16()).toBe(9);
  });

  test("長さが残りより長い・件数が長さに入りきらないものは壊れているとして止める", () => {
    // 構造体の長さ 100 なのに中身は 4 バイト
    expect(() =>
      reader((w) => w.u32(100).u32(1)).struct((s) => s.u32()),
    ).toThrow(BrokenReply);
    // 文字列の長さが残りより長い
    expect(() => reader((w) => w.u32(40).u16(0x41)).string()).toThrow(
      BrokenReply,
    );
    // 長さ 8 (中身なし) で件数 100 万
    expect(() =>
      reader((w) => w.u32(8).u32(1_000_000)).array((s) => s.u32(), 4),
    ).toThrow(BrokenReply);
    // 構造体の中で終わりを越えて読まない
    expect(() =>
      reader((w) => w.struct((s) => s.u16(1)).u32(5)).struct((s) => s.u32()),
    ).toThrow(BrokenReply);
  });
});

describe("構造体を読む", () => {
  test("EPG_AUTO_ADD_DATA (ver 5)", () => {
    const parsed = readAutoAdd(
      reader((w) => writeAutoAdd(w, rule, 5)),
      5,
    );
    expect(parsed).toEqual({
      id: 12,
      andKey: "^!{999}テスト番組",
      notKey: "再放送",
      regExp: false,
      titleOnly: false,
      // ファイルと同じ値 (符号付き)
      contents: [0x07000000, -65536],
      dates: [
        {
          startDay: 1,
          startHour: 20,
          startMinute: 0,
          endDay: 1,
          endHour: 21,
          endMinute: 30,
        },
      ],
      services: [
        MX,
        { networkId: 4, transportStreamId: 0x4010, serviceId: 101 },
      ],
      recMode: 5,
      aimai: true,
      notContent: false,
      notDate: false,
      freeCA: 1,
      chkRecEnd: true,
    });
  });

  test("後ろに知らない欄が増えた ver 6 も同じに読める", () => {
    const r = reader((w) => {
      writeAutoAdd(w, rule, 6, 7);
      writeAutoAdd(w, { ...rule, id: 13 }, 6, 7);
    });
    expect(readAutoAdd(r, 6)).toEqual(
      readAutoAdd(
        reader((w) => writeAutoAdd(w, rule, 5)),
        5,
      ),
    );
    expect(readAutoAdd(r, 6).id).toBe(13);
  });

  test("ver 2 には chkRecEnd が無い", () => {
    expect(
      readAutoAdd(
        reader((w) => writeAutoAdd(w, rule, 2)),
        2,
      ),
    ).toMatchObject({ id: 12, chkRecEnd: false, recMode: 5 });
  });

  test("RESERVE_DATA", () => {
    for (const ver of [4, 5])
      expect(readReserve(reader((w) => writeReserve(w, reserve, ver)))).toEqual(
        {
          startAt: START,
          duration: 1800_000,
          title: "テスト番組 #1",
          networkId: MX.networkId,
          serviceId: MX.serviceId,
          eventId: 1001,
          recMode: 4,
          comment: "EPG自動予約(テスト)",
        },
      );
  });

  test("REC_FILE_INFO (ver 4 の protectFlag は飛ばす)", () => {
    for (const ver of [2, 4])
      expect(readRecInfo(reader((w) => writeRecInfo(w, recInfo, ver)))).toEqual(
        {
          title: "テスト番組 #0",
          startAt: START - 60_000,
          duration: 1860_000,
          serviceName: "ＴＯＫＹＯ　ＭＸ１",
          networkId: MX.networkId,
          transportStreamId: MX.transportStreamId,
          serviceId: MX.serviceId,
          recStatus: 4,
          epgStartAt: START,
        },
      );
  });
});

describe("EpgTimerSrv に繋ぐ", () => {
  const saved = { ...timing };
  const warnings: string[] = [];
  const client = () => {
    warnings.length = 0;
    return new EdcbClient(parseTarget(fake.target), (m) => warnings.push(m));
  };

  beforeEach(() => {
    fake.setMode({});
    fake.commands.length = 0;
    Object.assign(timing, saved, { idle: 300, busyWait: 10 });
  });
  afterAll(async () => {
    Object.assign(timing, saved);
    await fake.stop();
  });

  test("3 つの一覧を、それぞれ 1 接続 1 コマンドで読む", async () => {
    const c = client();
    expect(await c.recInfos()).toHaveLength(1);
    expect((await c.autoAdds()).map((r) => r.id)).toEqual([1, 2]);
    expect(await c.reserves()).toHaveLength(1);
    expect(fake.commands).toEqual([2020, 2131, 2011]);
    expect(warnings).toEqual([]);
  });

  test("ver が違えば 1 回だけ警告して読む (古い 4・新しい 6)", async () => {
    for (const ver of [4, 6]) {
      fake.setMode({ ver, extra: ver > 5 ? 3 : 0 });
      const c = client();
      expect(await c.recInfos()).toHaveLength(1);
      expect((await c.autoAdds()).map((r) => r.id)).toEqual([1, 2]);
      expect(await c.reserves()).toHaveLength(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`バージョンが ${ver} です`);
    }
  });

  test("受けてすぐ切られたら、アクセス制御を見るよう言う", async () => {
    fake.setMode({ deny: true });
    await expect(client().autoAdds()).rejects.toThrow(
      "アクセス制御 (TCPAccessControlList) に denpa の IP",
    );
  });

  test("断られたら、ネットワーク接続の許可とポートを見るよう言う", async () => {
    const closed = createServer();
    const port = await new Promise<number>((resolve) =>
      closed.listen(0, "127.0.0.1", () => {
        const address = closed.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      }),
    );
    await new Promise((resolve) => closed.close(resolve));
    const c = new EdcbClient(parseTarget(`127.0.0.1:${port}`), () => {});
    await expect(c.autoAdds()).rejects.toThrow("接続を拒否されました");
  });

  test("黙ったままなら、無通信の時間で切る", async () => {
    fake.setMode({ silent: true });
    await expect(client().autoAdds()).rejects.toThrow("応答がありません");
  });

  test("上限を超える長さは読む前に断る。足りないまま切られたら途中で切れたと言う", async () => {
    fake.setMode({ claimSize: RESPONSE_LIMIT + 1 });
    await expect(client().autoAdds()).rejects.toThrow("応答が大きすぎます");
    fake.setMode({ claimSize: 1_000_000 });
    await expect(client().autoAdds()).rejects.toThrow("途中で切れました");
  });

  test("BUSY は待って送り直し、続くならそう言う", async () => {
    fake.setMode({ busy: 2 });
    expect(await client().autoAdds()).toHaveLength(2);
    expect(fake.commands).toEqual([2131, 2131, 2131]);
    fake.setMode({ busy: 10 });
    await expect(client().autoAdds()).rejects.toThrow("忙しい");
  });

  test("成功でない結果は、コマンドの名前と番号つきで止める", async () => {
    fake.setMode({ result: 0 });
    await expect(client().reserves()).rejects.toThrow(
      "ENUM_RESERVE2 (2011) を断りました (結果 0)",
    );
    fake.setMode({ result: 203 });
    await expect(client().reserves()).rejects.toThrow("対応していません");
  });
});
