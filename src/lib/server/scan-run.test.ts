import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Agent } from "./agents";
import type { AgentChannel, AgentTuner } from "./tuner";

/**
 * **総当たり (`Scanner`) の数え方と、ロックしなかったチャンネルの扱い。** エージェントの代わりに `./tuner` の
 * チューナーの一覧・今の控え・選局を差し替え、`start` から回して進み具合 (`scanState`) を見る。
 * 偽の放送を通した総当たりは `tests/e2e/16-scan.spec.ts` にある。DB は一時ファイルへ
 */
const dir = mkdtempSync(join(tmpdir(), "denpa-scan-run-"));
const { config } = await import("./config");
config.dbPath = join(dir, "denpa.db");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const AGENT: Agent = {
  id: 1,
  name: "agent",
  origin: "https://agent.invalid",
  pair: null,
};

/** 偽のエージェントのチューナー 1 台。受ける種別だけを変える */
function tuner(types: AgentTuner["types"]): AgentTuner {
  return {
    index: 0,
    name: "tuner",
    types,
    disabled: false,
    rank: 0,
    device: null,
    pin: "0",
    lnb: null,
    channel: null,
    users: [],
    error: null,
    signal: null,
    agent: AGENT.id,
  };
}

/** そのまま閉じるストリーム。`bytes` が空なら選局できても何も来なかった */
function closed(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** 偽のエージェントが返すもの。テストごとに入れ替える */
const fake: {
  tuners: AgentTuner[];
  previous: AgentChannel[];
  open: (
    channel: string,
    attempt: number,
  ) => { stream: ReadableStream<Uint8Array>; transport: "ts" | "tlv" };
} = {
  tuners: [],
  previous: [],
  open: () => {
    throw new Error("ロックしませんでした");
  },
};
/** チャンネルごとの選局の回数 */
const attempts = new Map<string, number>();

const actualTuner = await import("./tuner");
mock.module("./tuner", () => ({
  ...actualTuner,
  tunerList: async () => ({ tuners: fake.tuners, detected: false }),
  getChannels: async () => fake.previous,
  putChannels: async (found: AgentChannel[]) => found,
  openChannel: async (
    _type: string,
    places: readonly { channel: string }[],
  ) => {
    const channel = places[0]!.channel;
    const attempt = (attempts.get(channel) ?? 0) + 1;
    attempts.set(channel, attempt);
    const opened = fake.open(channel, attempt);
    return {
      ...opened,
      tsmfStreams: 1,
      place: { agent: AGENT.id, channel },
    };
  },
}));
const actualAgents = await import("./agents");
mock.module("./agents", () => ({
  ...actualAgents,
  listAgents: () => [AGENT],
}));

const { TunerUnusableError } = actualTuner;
const { scanState, start, stop } = await import("./scan");

/** 進み具合が `check` を満たすまで待つ */
async function until(
  check: (state: ReturnType<typeof scanState>) => boolean,
  ms = 10_000,
): Promise<ReturnType<typeof scanState>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const state = scanState();
    if (check(state)) return state;
    if (Date.now() > deadline)
      throw new Error(`待ちきれませんでした: ${state.log.at(-1)}`);
    await Bun.sleep(20);
  }
}

/** TS の null パケット 1 つ。電波は来たが、局の表が無い */
const NULL_PACKET = Uint8Array.from({ length: 188 }, (_, i) =>
  i === 0 ? 0x47 : i === 1 ? 0x1f : i === 2 ? 0xff : i === 3 ? 0x10 : 0xff,
);

describe("回し直しの列", () => {
  test("回し直しで選局できるチューナーが無くなっても、進み具合を二重に数えない", async () => {
    attempts.clear();
    fake.tuners = [tuner(["GR"])];
    fake.previous = [];
    // T13 は電波が来るのに局の表が揃わず、回し直しの列に入る。回し直すと、エージェントが電源を入れ直すまで使えないと返す
    fake.open = (channel, attempt) => {
      if (channel !== "T13") throw new Error("ロックしませんでした");
      if (attempt === 1)
        return { stream: closed(NULL_PACKET), transport: "ts" };
      throw new TunerUnusableError("503", "電源を入れ直してください");
    };
    expect(start({ types: ["GR"] }).started).toBe(true);
    const state = await until((state) => state.state !== "running");
    expect(attempts.get("T13")).toBe(2);
    expect(state.log).toContain(
      "GR: 選局できるチューナーがありません。電源を入れ直してください",
    );
    expect(state.total).toBe(50);
    expect(state.scanned).toBe(state.total);
    expect(state.agents[0]?.scanned).toBe(50);
  });
});

describe("ケーブルの 4K の局 (TLV)", () => {
  test("選局できても何も来なければロックしなかったと数え、前の控えにあるチャンネルとして試し直す", async () => {
    attempts.clear();
    fake.tuners = [tuner(["CATV"])];
    // 前のスキャンで QC28 に 4K の局を見つけていた
    fake.previous = [
      {
        type: "CATV",
        channel: "QC28",
        networkId: 0x000b,
        transportStreamId: 0x0001,
        remoteControlKeyId: null,
        transport: "tlv",
        services: [
          {
            serviceId: 0x0065,
            serviceType: 0x01,
            name: "BS4K",
            partialReception: false,
          },
        ],
      },
    ];
    fake.open = (channel) => {
      if (channel !== "QC28") throw new Error("ロックしませんでした");
      return { stream: closed(new Uint8Array(0)), transport: "tlv" };
    };
    expect(start({ types: ["CATV"] }).started).toBe(true);
    const state = await until(
      (state) =>
        state.state !== "running" ||
        state.log.some((line) => line.includes("もう一度試します")),
    );
    expect(attempts.get("QC28")).toBe(1);
    expect(state.log).toContain(
      "CATV: NIT か前のスキャンにあるのにロックしなかった 1 チャンネルを、10 秒後にもう一度試します",
    );
    // 試し直しを待たずに終える。中断したスキャンは控えを書き換えない
    expect(stop().stopped).toBe(true);
    expect((await until((state) => state.state !== "running")).state).toBe(
      "canceled",
    );
  });
});
