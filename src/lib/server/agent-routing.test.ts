import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentScene, agentScenes } from "../../../tests/fake/tuner-scenes";

/**
 * **選局の振り分け** (`tuner.openChannel` の `route`)。偽のエージェントを 2 台立て、本物と同じく HTTPS で組んで選局を送る。
 * 偽のエージェントは、選ぶ順の約束 (docs/agent.md「選ぶ順の約束」の 2・3) どおりにチューナーを選ぶだけの作り物 (`FakePool`)。
 * どのエージェントに送るかは denpa が決め、エージェントの中のチューナーはエージェントが決める
 */
const { config } = await import("./config");
const dir = mkdtempSync(join(tmpdir(), "denpa-routing-"));
config.dataDir = dir;
config.dbPath = join(dir, "denpa.db");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { createIdentity } = await import("./agent-identity");
const { fakeAgentUrl, serveFakeAgent } = await import("./fake-agent");
const { listAgents } = await import("./agents");
const { getTuners, openChannel, openWhenFree, TunerBusyError, tunerSnapshot } =
  await import("./tuner");

interface FakeUser {
  use: string;
  priority: number;
  /** 取り上げられたときに、その選局のストリームを閉じる */
  kick: () => void;
}

interface FakeTuner {
  name: string;
  types: string[];
  rank: number;
  channel: { type: string; channel: string } | null;
  users: FakeUser[];
}

/** 1 台の偽のエージェント。`/denpa/tuners` と `/denpa/stream` だけを答える */
class FakePool {
  readonly tuners: FakeTuner[];
  /** `/denpa/tuners` を訊かれた回数 */
  asked = 0;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly identity = createIdentity("denpa-agent");

  constructor(tuners: { name: string; types: string[]; rank: number }[]) {
    this.tuners = tuners.map((t) => ({ ...t, channel: null, users: [] }));
  }

  start(): string {
    this.server = serveFakeAgent(
      (request) => this.fetch(request),
      this.identity,
    );
    return fakeAgentUrl(this.server.port!);
  }

  /** 落とす。繋ごうとしても断られる */
  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  /** 利用者 `use` がいるチューナー */
  holder(use: string): FakeTuner | undefined {
    return this.tuners.find((t) => t.users.some((u) => u.use === use));
  }

  private fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname === "/denpa/tuners") {
      this.asked++;
      return Response.json({
        detected: false,
        tuners: this.tuners.map((t, index) => ({
          index,
          name: t.name,
          types: t.types,
          disabled: false,
          rank: t.rank,
          device: null,
          pin: t.name,
          lnb: null,
          channel: t.channel,
          users: t.users.map(({ use, priority }) => ({ use, priority })),
          error: null,
          signal: null,
        })),
      });
    }
    if (url.pathname === "/denpa/stream") return this.open(url);
    return new Response("not found", { status: 404 });
  }

  /** 約束の 3 (同じチャンネルを同じか高い優先度の利用者が読んでいれば共有) と 2 (使ってよいチューナーのうち順位のいちばん前) */
  private open(url: URL): Response {
    const type = url.searchParams.get("type")!;
    const channel = url.searchParams.get("channel")!;
    const use = url.searchParams.get("use")!;
    const priority = Number(url.searchParams.get("priority"));
    const after = url.searchParams.getAll("after");
    const reading = (t: FakeTuner) =>
      t.channel?.type === type && t.channel.channel === channel;
    let tuner = this.tuners.find(
      (t) =>
        reading(t) &&
        t.users.some((u) => !after.includes(u.use) && u.priority >= priority),
    );
    if (tuner === undefined) {
      tuner = this.tuners
        .filter(
          (t) =>
            t.types.includes(type) &&
            t.users.every(
              (u) => after.includes(u.use) || u.priority < priority,
            ),
        )
        .sort((a, b) => a.rank - b.rank)[0];
      if (tuner === undefined)
        return Response.json({ error: "空きがありません" }, { status: 409 });
      for (const user of tuner.users) user.kick();
      tuner.users = [];
      tuner.channel = { type, channel };
    }
    const on = tuner;
    let close = () => {};
    const user: FakeUser = { use, priority, kick: () => close() };
    on.users.push(user);
    const leave = () => {
      on.users = on.users.filter((u) => u !== user);
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(188).fill(0x47, 0, 1));
        close = () => {
          leave();
          try {
            controller.close();
          } catch {
            // もう閉じている
          }
        };
      },
      cancel: leave,
    });
    return new Response(body, { headers: { "Content-Type": "video/MP2T" } });
  }
}

/** 立てた偽のエージェント。テストごとに落とす */
let pools: FakePool[] = [];
/** 開いた選局。テストごとに閉じる */
let opened: { aborter: AbortController; stream: ReadableStream<Uint8Array> }[] =
  [];

afterEach(async () => {
  for (const o of opened) {
    o.aborter.abort();
    await o.stream.cancel().catch(() => {});
  }
  opened = [];
  for (const pool of pools) pool.stop();
  pools = [];
});

/** 偽のエージェントを並びの順に立て、`TUNER_AGENT_URL` に書く。返すのはエージェントの行の ID */
function startAgents(...list: FakePool[]): number[] {
  pools = list;
  config.agentUrl = list.map((pool) => pool.start()).join(",");
  return listAgents().map((agent) => agent.id);
}

/** 録画として開く。送った所を返す。開けなければ送出する */
async function record(
  type: string,
  places: { agent: number; channel: string }[],
  use: string,
  priority = 10,
) {
  const aborter = new AbortController();
  const got = await openChannel(
    type,
    places,
    aborter.signal,
    use as `rec ${number}`,
    priority,
  );
  opened.push({ aborter, stream: got.stream });
  return got.place;
}

/** 場面を偽のエージェント 2 台に送る。予約の割り振り (`conflict.test.ts`) と同じ場面 */
async function play(scene: AgentScene): Promise<void> {
  const ids = startAgents(
    ...scene.agents.map((agent) => new FakePool(agent.tuners)),
  );
  /** 場面の名前 → 開いた選局と利用者の名乗り */
  const streams = new Map<
    string,
    {
      aborter: AbortController;
      stream: ReadableStream<Uint8Array>;
      use: string;
    }
  >();
  for (const [i, step] of scene.steps.entries()) {
    if ("close" in step) {
      const entry = streams.get(step.close)!;
      entry.aborter.abort();
      await entry.stream.cancel().catch(() => {});
      // 偽のエージェントが利用者を外すまで待つ (本物も、切れたのに気付くのは少し後)
      while (pools.some((pool) => pool.holder(entry.use) !== undefined))
        await Bun.sleep(10);
      continue;
    }
    const places = scene.agents.flatMap((agent, n) => {
      const channel = agent.channels[step.ts];
      return channel === undefined ? [] : [{ agent: ids[n]!, channel }];
    });
    const use = `rec ${i}` as const;
    const aborter = new AbortController();
    const result = await openChannel(
      step.type,
      places,
      aborter.signal,
      use,
      step.priority,
    ).catch((error: unknown) => error);
    if (step.at === null) {
      expect([step.open, result instanceof TunerBusyError]).toEqual([
        step.open,
        true,
      ]);
      continue;
    }
    if (result instanceof Error) throw result;
    const got = result as Awaited<ReturnType<typeof openChannel>>;
    streams.set(step.open, { aborter, stream: got.stream, use });
    opened.push({ aborter, stream: got.stream });
    const n = scene.agents.findIndex((agent) => agent.name === step.at!.agent);
    expect([step.open, got.place.agent, pools[n]!.holder(use)?.rank]).toEqual([
      step.open,
      ids[n],
      step.at.rank,
    ]);
  }
}

describe("エージェントが 2 台のときの場面", () => {
  for (const scene of agentScenes) {
    test(scene.name, () => play(scene));
  }
});

describe("選局の振り分け", () => {
  test("片方が塞がっていれば、もう片方に入る", async () => {
    const [a, b] = startAgents(
      new FakePool([{ name: "gr", types: ["GR"], rank: 0 }]),
      new FakePool([{ name: "gr", types: ["GR"], rank: 0 }]),
    );
    const t16 = [
      { agent: a!, channel: "T16" },
      { agent: b!, channel: "T16" },
    ];
    const t21 = [
      { agent: a!, channel: "T21" },
      { agent: b!, channel: "T21" },
    ];
    expect((await record("GR", t16, "rec 1")).agent).toBe(a!);
    expect((await record("GR", t21, "rec 2")).agent).toBe(b!);
  });

  test("受けられる種別が違えば、受けられるほうに入る", async () => {
    const [a, b] = startAgents(
      new FakePool([{ name: "gr", types: ["GR"], rank: 0 }]),
      new FakePool([{ name: "bs", types: ["BS", "CS"], rank: 0 }]),
    );
    // 控えには両方にある (放送の一覧から作った BS) が、居間のエージェントには BS を受けるチューナーが無い
    const bs = [
      { agent: a!, channel: "BS11:18000" },
      { agent: b!, channel: "BS11:18000" },
    ];
    expect((await record("BS", bs, "rec 1")).agent).toBe(b!);
  });

  test("同じ TS を同時に 2 本開いても、送ってから一覧に出るまでの選局を数えて、別々のエージェントに入れる", async () => {
    const [a, b] = startAgents(
      new FakePool([{ name: "gr", types: ["GR"], rank: 0 }]),
      new FakePool([{ name: "gr", types: ["GR"], rank: 0 }]),
    );
    const both = (channel: string) => [
      { agent: a!, channel },
      { agent: b!, channel },
    ];
    const got = await Promise.all([
      record("GR", both("T16"), "rec 1"),
      record("GR", both("T21"), "rec 2"),
    ]);
    expect(got.map((place) => place.agent).sort()).toEqual([a!, b!].sort());
  });

  test("共有は同じエージェントの同じチャンネルでだけ。ほかのエージェントで同じ TS を読んでいても、そこへは送らない", async () => {
    const [a, b] = startAgents(
      new FakePool([
        { name: "gr0", types: ["GR"], rank: 0 },
        { name: "gr1", types: ["GR"], rank: 0 },
      ]),
      new FakePool([{ name: "gr", types: ["GR"], rank: 0 }]),
    );
    // 書斎だけが受けられる TS を録っている。居間は同じ TS を別のチャンネル (T27) で受ける
    await record("GR", [{ agent: b!, channel: "T27" }], "rec 1");
    const place = await record(
      "GR",
      [
        { agent: a!, channel: "T16" },
        { agent: b!, channel: "T27" },
      ],
      "live GR/T16",
      9,
    );
    // 書斎の選局を共有する (同じエージェントの同じチャンネル)
    expect(place).toEqual({ agent: b!, channel: "T27" });
    expect(pools[1]!.holder("live GR/T16")?.users).toHaveLength(2);
    // 居間のチャンネルしか渡さなければ、居間で新しく選局する
    const own = await record("GR", [{ agent: a!, channel: "T16" }], "rec 2");
    expect(own).toEqual({ agent: a!, channel: "T16" });
    expect(pools[0]!.holder("rec 2")?.users).toHaveLength(1);
  });

  test("片方が落ちても、もう片方で録画とライブが続く", async () => {
    const [a, b] = startAgents(
      new FakePool([{ name: "gr", types: ["GR"], rank: 0 }]),
      new FakePool([{ name: "gr", types: ["GR"], rank: 0 }]),
    );
    const t16 = [
      { agent: a!, channel: "T16" },
      { agent: b!, channel: "T16" },
    ];
    expect((await record("GR", t16, "rec 1")).agent).toBe(a!);
    // 一覧を一度返してから落ちる (予約の割り振りは最後に返した一覧で数える)
    await getTuners();
    pools[0]!.stop();
    // 録画の取り直しは新しい 1 回の選局。落ちたエージェントには送らない
    expect((await record("GR", t16, "rec 1")).agent).toBe(b!);
    const aborter = new AbortController();
    const live = await openWhenFree(
      "GR",
      t16,
      aborter.signal,
      "live GR/T16",
      9,
      () => false,
      "ts",
    );
    opened.push({ aborter, stream: live.stream });
    // 録画の選局を共有する
    expect(live.place.agent).toBe(b!);
    // 返すエージェントのものだけを数える。割り振りは落ちたエージェントを最後に返した一覧で数える
    expect(new Set((await getTuners()).map((t) => t.agent))).toEqual(
      new Set([b!]),
    );
    expect(new Set((await tunerSnapshot())?.map((t) => t.agent))).toEqual(
      new Set([a!, b!]),
    );
  });

  test("局を受けられるエージェントが 1 台だけなら、一覧を訊かずにそこへ送る (1 台のときの動きは変えない)", async () => {
    const [a] = startAgents(
      new FakePool([{ name: "gr", types: ["GR"], rank: 0 }]),
    );
    await record("GR", [{ agent: a!, channel: "T16" }], "rec 1");
    expect(pools[0]!.asked).toBe(0);
  });
});
