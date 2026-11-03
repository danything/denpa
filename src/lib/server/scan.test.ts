import { describe, expect, test } from "bun:test";

import { EpgReader } from "@danything/arib/eit";
import {
  eitSection,
  nitSection,
  packetize,
  sdtSection,
} from "@danything/arib/synth";

import { channelEntry, channelsFor, readServices } from "./scan";

/**
 * 総当たりそのもの (`Scanner`) はここでは試さない。**エージェントに選局を
 * 任せる形**になったので、相手がいないと動かない。通しで見ているのは
 * `tests/e2e/16-scan.spec.ts` で、本物の総当たりが偽の放送に当たっている。
 */

/** NIT と SDT だけの TS。チューナーが吐くものの代わり */
function stream(
  services: [number, number, string?][],
  half = false,
): Uint8Array {
  return Uint8Array.from([
    // 頭に無関係なパケットを混ぜておく。すぐには揃わない状況にするため
    ...packetize(0x0100, sdtSection(0x0408, 0x0004, services)),
    ...(half
      ? []
      : [
          ...packetize(
            0x0010,
            nitSection(0x7fe0, 6, [[0x0408, 0x0004, [[1024, 0x01]]]]),
          ),
        ]),
    ...packetize(0x0011, sdtSection(0x0408, 0x0004, services), 3),
  ]);
}

/** バイト列をそのまま返すリーダー。選局の代わり */
function fromBytes(
  data: Uint8Array,
  keepOpen = false,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      if (!keepOpen) controller.close();
    },
  });
}

describe("選局するチャンネル", () => {
  test("地上波は 13〜62ch", () => {
    const channels = channelsFor("GR");
    expect(channels[0]).toBe("T13");
    expect(channels.at(-1)).toBe("T62");
    expect(channels).toHaveLength(50);
  });

  test("CATV は UHF に続けて C13〜C63", () => {
    const catv = channelsFor("CATV");
    expect(catv.slice(0, 50)).toEqual(channelsFor("GR"));
    expect(catv.slice(50)).toEqual(
      Array.from({ length: 51 }, (_, i) => `C${13 + i}`),
    );
  });
});

describe("チャンネル定義の組み立て", () => {
  test("見つけたサービスを局名ごと並べる", () => {
    const entry = channelEntry("GR", "T27", [
      {
        serviceId: 1032,
        serviceType: 1,
        name: "TOKYO MX2",
        networkId: 32391,
        transportStreamId: 23608,
        remoteControlKeyId: 9,
      },
      {
        serviceId: 1024,
        serviceType: 1,
        name: "TOKYO MX1",
        networkId: 32391,
        transportStreamId: 23608,
        remoteControlKeyId: 9,
      },
    ]);
    expect(entry).toEqual({
      type: "GR",
      channel: "T27",
      networkId: 32391,
      transportStreamId: 23608,
      remoteControlKeyId: 9,
      services: [
        { serviceId: 1024, serviceType: 1, name: "TOKYO MX1" },
        { serviceId: 1032, serviceType: 1, name: "TOKYO MX2" },
      ],
    });
  });
});

describe("1チャンネルの読み取り", () => {
  test("局を探しているあいだに流れてきた番組表も取得する", async () => {
    const epg = new EpgReader();
    const eit = eitSection({
      tableId: 0x50,
      serviceId: 1024,
      transportStreamId: 0x0408,
      originalNetworkId: 0x7fe0,
      events: [
        {
          eventId: 1,
          startAt: Date.now() + 3600_000,
          duration: 1800_000,
          name: "集めた番組",
        },
      ],
    });
    const data = Uint8Array.from([
      ...packetize(0x0012, eit),
      ...stream([[1024, 0x01, "TOKYO MX1"]]),
    ]);
    const { error } = await readServices(fromBytes(data), 5000, undefined, epg);
    expect(error).toBeNull();
    expect(epg.all().map((e) => e.name)).toEqual(["集めた番組"]);
  });

  test("流れてきた TS からサービスを読む", async () => {
    const { services, error } = await readServices(
      fromBytes(
        stream([
          [1024, 0x01, "TOKYO MX1"],
          [1025, 0x01],
        ]),
      ),
      5000,
    );
    expect(error).toBeNull();
    expect(services?.map((s) => s.serviceId)).toEqual([1024, 1025]);
    expect(services?.[0]?.name).toBe("TOKYO MX1");
    expect(services?.[0]?.remoteControlKeyId).toBe(6);
  });

  test("何も出てこなければ受信できていない", async () => {
    const { services, error } = await readServices(
      fromBytes(new Uint8Array(0)),
      500,
    );
    expect(services).toBeNull();
    expect(error).toBe("受信できませんでした");
  });

  test("片方しか来なければ諦める", async () => {
    // SDT だけ。どのネットワークのものか分からないので設定には書けない
    const { services, error, signal } = await readServices(
      fromBytes(stream([[1024, 0x01]], true), true),
      500,
    );
    expect(services).toBeNull();
    // 「受信できませんでした」で片付けない。電波は来ているので疑うところが違う
    expect(signal).toBe(true);
    expect(error).toBe("NIT を受信できませんでした");
  });

  test("失敗した理由を持ち帰る", async () => {
    // 選局が落ちた理由 (「デバイスが使用中」など) を捨てると原因が分からない
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("Cannot open device"));
      },
    });
    const { error, signal } = await readServices(failing, 5000);
    expect(signal).toBe(false);
    expect(error).toContain("Cannot open device");
  });

  test("揃った時点で打ち切る", async () => {
    // ある局で毎回30秒待っていたら総当たりが終わらない。**閉じないリーダー**で試す
    const started = Bun.nanoseconds();
    const { error } = await readServices(
      fromBytes(stream([[1024, 0x01]]), true),
      30_000,
    );
    expect(error).toBeNull();
    expect((Bun.nanoseconds() - started) / 1e9).toBeLessThan(10);
  });

  test("読み終えたら、走査の打ち切りの見張りを外す", async () => {
    // 合図は走査全体で1つ。局ごとに足したまま残すと、総当たりで100を超えて積もる
    const { signal } = new AbortController();
    const listening = new Set<unknown>();
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => {
      listening.add(args[1]);
      add(...args);
    }) as typeof add;
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      listening.delete(args[1]);
      remove(...args);
    }) as typeof remove;
    for (let i = 0; i < 3; i++)
      await readServices(fromBytes(stream([[1024, 0x01]])), 5000, signal);
    expect(listening.size).toBe(0);
  });
});
