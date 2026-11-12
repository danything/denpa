import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentScene, agentScenes } from "../../../tests/fake/tuner-scenes";

/**
 * **選局の振り分け** (`tuner.openChannel` の `route`) と、カードで決まる送り先 (有料の局・契約を確かめる先・後から復号させる先)。
 * 偽のエージェントを 2 台立て、本物と同じく HTTPS で組んで送る。
 * 偽のエージェントは、選ぶ順の約束 (docs/agent.md「選ぶ順の約束」の 2・3) どおりにチューナーを選ぶだけの作り物 (`FakePool`)。
 * どのエージェントに送るかは denpa が決め、エージェントの中のチューナーはエージェントが決める
 */
const { config } = await import("./config");
const dir = mkdtempSync(join(tmpdir(), "denpa-routing-"));
config.dataDir = dir;
config.dbPath = join(dir, "denpa.db");
config.rawDir = join(dir, "raw");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { createIdentity } = await import("./agent-identity");
const { fakeAgentUrl, serveFakeAgent } = await import("./fake-agent");
const { listAgents } = await import("./agents");
const { getTuners, openChannel, openWhenFree, TunerBusyError, tunerSnapshot } =
  await import("./tuner");
const { forgetAgentCard } = await import("./agent-cards");
const { checkContracts, getContractRows, testDecode } =
  await import("./contracts");
const { orm } = await import("./db");
const { placeServices } = await import("./fake-channels");
const { cardContracts, programs, services } = await import("./schema");
const { descramble, forgetRawProbe, probeRaw } = await import("./scramble");

/** `/denpa/card` の答え。カードも `CARD_URL` も無い */
const NO_CARD = {
  ok: false,
  message: "カードリーダーがありません",
  source: "local",
  readers: [],
};

/** `/denpa/card` の答え。カード `id` を手元に挿している */
function localCard(id: string) {
  return {
    ok: true,
    message: "",
    source: "local",
    readers: [
      { name: "reader", card: true, ids: [id], active: true, tuners: [] },
    ],
  };
}

/** `/denpa/card` の答え。`CARD_URL` でカード `id` から鍵を貰っている */
function remoteCard(id: string) {
  return {
    ok: true,
    message: "",
    source: "remote",
    remote: "http://192.168.1.10:25253",
    ids: [id],
    tuners: [],
    readers: [],
  };
}

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

/** 1 台の偽のエージェント。`/denpa/tuners`・`/denpa/stream` と、カード・置き場の確かめ・復号の受け答えだけをする */
class FakePool {
  readonly tuners: FakeTuner[];
  /** `/denpa/card` の答え。既定はカードも `CARD_URL` も無い */
  card: object = NO_CARD;
  /** `/denpa/card` を訊かれた回数 */
  cardAsked = 0;
  /** 契約の問い合わせ (`/denpa/card/confirm`) の返り値と、受けた回数 */
  code = 0x0800;
  confirms = 0;
  /** 置き場の見え方 (`/denpa/raw/probe`)。`same` は見える、`missing` は見えない、`old` は API の無い古いエージェント */
  raw: "same" | "missing" | "old" = "same";
  /** `/denpa/raw/probe` と `/denpa/decode` を受けた回数 */
  probes = 0;
  decodes = 0;
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

  private async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/denpa/card") {
      this.cardAsked++;
      return Response.json(this.card);
    }
    if (url.pathname === "/denpa/card/confirm") {
      this.confirms++;
      return Response.json({ ok: true, code: this.code });
    }
    if (url.pathname === "/denpa/raw/probe") return this.probe(request);
    if (url.pathname === "/denpa/decode") {
      this.decodes++;
      return Response.json(
        { ok: false, error: "偽のエージェントは復号しない" },
        { status: 500 },
      );
    }
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

  /** 本物 (RawProbe.cs) と同じく、置き場の中身の SHA-256 を返す。置き場は denpa と同じ `config.rawDir` */
  private async probe(request: Request): Promise<Response> {
    this.probes++;
    // 古いエージェントは知らない API に、ほかの知らない API と同じ答えを返す (エージェントの `MapFallback`)
    if (this.raw === "old")
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    const { path } = (await request.json()) as { path: string };
    const full = join(config.rawDir, path);
    if (this.raw === "missing" || !existsSync(full))
      return Response.json(
        { error: `${full} が見つかりません` },
        { status: 404 },
      );
    return Response.json({
      sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
    });
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
  forgetAgentCard();
  forgetRawProbe();
  orm().delete(cardContracts).run();
  orm().delete(programs).run();
  orm().delete(services).run();
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
  /** 復号して使う局 (`openChannel` の `keyed`) */
  keyed: number | null = null,
) {
  const aborter = new AbortController();
  const got = await openChannel(
    type,
    places,
    aborter.signal,
    use as `rec ${number}`,
    priority,
    [],
    null,
    null,
    null,
    keyed,
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

/** カードの番号 (16 桁) */
const CARD_X = "0000111122223333";
const CARD_Y = "4444555566667777";

/** 有料の局 (`services.id`)。契約の行を入れる局 */
const PAID = 501;
/** 無料の局。契約の行は無い */
const FREE = 502;

/** カード `card` で、局 `service` を契約中 (`subscribed`) か未契約 (`unsubscribed`) とカードが答えたことにする */
function contract(
  card: string,
  service: number,
  state: "subscribed" | "unsubscribed",
): void {
  orm()
    .insert(cardContracts)
    .values({
      card_id: card,
      service_id: service,
      state,
      code: state === "subscribed" ? 0x0800 : 0x0000,
      checked_at: Date.now(),
    })
    .run();
}

/** 地上波のチューナーが 1 つの偽のエージェント。`card` は `/denpa/card` の答え */
function pool(card: object = NO_CARD): FakePool {
  const made = new FakePool([{ name: "gr", types: ["GR"], rank: 0 }]);
  made.card = card;
  return made;
}

/** 両方のエージェントの、同じ名前のチャンネル */
function both(a: number, b: number, channel = "T16") {
  return [
    { agent: a, channel },
    { agent: b, channel },
  ];
}

describe("復号して使う局は、カードで振り分ける", () => {
  test("カードも CARD_URL も無いエージェントには録画を入れない。番組表の取得には使う", async () => {
    const [a, b] = startAgents(pool(), pool(localCard(CARD_X)));
    expect((await record("GR", both(a!, b!), "rec 1", 10, FREE)).agent).toBe(
      b!,
    );
    // 鍵の要らない選局 (`keyed` を渡さない) は今までどおり並びの先頭
    expect((await record("GR", both(a!, b!, "T21"), "epg GR")).agent).toBe(a!);
  });

  test("CARD_URL で鍵を貰うエージェントは、カードを挿したエージェントと同じに扱う", async () => {
    const [a, b] = startAgents(
      pool(remoteCard(CARD_X)),
      pool(localCard(CARD_X)),
    );
    contract(CARD_X, PAID, "subscribed");
    expect((await record("GR", both(a!, b!), "rec 1", 10, PAID)).agent).toBe(
      a!,
    );
    // 塞がっていれば、同じカードのもう片方に入る
    expect(
      (await record("GR", both(a!, b!, "T21"), "rec 2", 10, PAID)).agent,
    ).toBe(b!);
  });

  test("有料の局は、契約中と確かめたカードのエージェントに入れる。無料の局は並びの先頭", async () => {
    const [a, b] = startAgents(
      pool(localCard(CARD_X)),
      pool(localCard(CARD_Y)),
    );
    contract(CARD_X, PAID, "unsubscribed");
    contract(CARD_Y, PAID, "subscribed");
    expect((await record("GR", both(a!, b!), "rec 1", 10, PAID)).agent).toBe(
      b!,
    );
    expect(
      (await record("GR", both(a!, b!, "T21"), "rec 2", 10, FREE)).agent,
    ).toBe(a!);
  });

  test("契約中のカードのエージェントが塞がっていれば、ほかのカードのエージェントには入れず空き待ちにする", async () => {
    const [a, b] = startAgents(
      pool(localCard(CARD_X)),
      pool(localCard(CARD_Y)),
    );
    contract(CARD_Y, PAID, "subscribed");
    await record("GR", [{ agent: b!, channel: "T27" }], "rec 1", 10);
    const result = await record("GR", both(a!, b!), "rec 2", 10, PAID).catch(
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(TunerBusyError);
    expect(pools[0]!.holder("rec 2")).toBeUndefined();
  });

  test("契約を確かめていないカードは、未契約と確かめたカードより先", async () => {
    const [a, b] = startAgents(
      pool(localCard(CARD_X)),
      pool(localCard(CARD_Y)),
    );
    contract(CARD_X, PAID, "unsubscribed");
    expect((await record("GR", both(a!, b!), "rec 1", 10, PAID)).agent).toBe(
      b!,
    );
  });

  test("未契約と確かめたカードでも、カードの無いエージェントより先", async () => {
    const [a, b] = startAgents(pool(), pool(localCard(CARD_X)));
    contract(CARD_X, PAID, "unsubscribed");
    expect((await record("GR", both(a!, b!), "rec 1", 10, PAID)).agent).toBe(
      b!,
    );
  });

  test("どのエージェントもカードで復号できなければ絞らない (今までどおり並びの先頭)", async () => {
    const [a, b] = startAgents(pool(), pool());
    expect((await record("GR", both(a!, b!), "rec 1", 10, PAID)).agent).toBe(
      a!,
    );
  });

  test("カードは控えを使い回し、捨てたら訊き直す (カードの通知・繋がり直したとき)", async () => {
    const [a, b] = startAgents(
      new FakePool([
        { name: "gr0", types: ["GR"], rank: 0 },
        { name: "gr1", types: ["GR"], rank: 0 },
      ]),
      pool(localCard(CARD_X)),
    );
    pools[0]!.card = localCard(CARD_X);
    await record("GR", both(a!, b!), "rec 1", 10, FREE);
    await record("GR", both(a!, b!, "T21"), "rec 2", 10, FREE);
    expect(pools.map((p) => p.cardAsked)).toEqual([1, 1]);
    forgetAgentCard(b!);
    await record("GR", both(a!, b!, "T22"), "rec 3", 10, FREE);
    expect(pools.map((p) => p.cardAsked)).toEqual([1, 2]);
  });

  test("局を受けられるエージェントが 1 台なら、カードを訊かずに送る (1 台のときの動きは変えない)", async () => {
    const [a] = startAgents(pool());
    await record("GR", [{ agent: a!, channel: "T16" }], "rec 1", 10, PAID);
    expect(pools[0]!.cardAsked).toBe(0);
  });
});

/** 局 `id` (地上波) の行を入れ、エージェント `agents` の T16 に置く。有料の番組を流していることにする */
function paidService(id: number, ...agents: number[]): void {
  orm()
    .insert(services)
    .values({
      id,
      service_id: id,
      network_id: 4,
      name: `有料の局 ${id}`,
      type: "GR",
      updated_at: Date.now(),
    })
    .run();
  orm()
    .insert(programs)
    .values({
      id: id * 1000 + 1,
      service_id: id,
      network_id: 4,
      event_id: 1,
      start_at: Date.now() - 60_000,
      end_at: Date.now() + 3600_000,
      name: "有料の番組",
      is_free: false,
      contract_verification: "AQIDBAU=",
      updated_at: Date.now(),
    })
    .run();
  for (const agent of agents) placeServices([{ id, channel: "T16" }], agent);
}

describe("契約を確かめる先", () => {
  test("カードごとに、そのカードを手元に持つエージェントに問い合わせる", async () => {
    const [a, b] = startAgents(
      pool(remoteCard(CARD_X)),
      pool(localCard(CARD_X)),
    );
    paidService(PAID, a!, b!);
    const rows = await checkContracts();
    expect(rows.map((row) => [row.cardId, row.status])).toEqual([
      [CARD_X, "subscribed"],
    ]);
    expect([pools[0]!.confirms, pools[1]!.confirms > 0]).toEqual([0, true]);
  });

  test("カードが 2 枚なら、それぞれのカードの契約を書く", async () => {
    const [a, b] = startAgents(
      pool(localCard(CARD_X)),
      pool(localCard(CARD_Y)),
    );
    pools[1]!.code = 0x0000;
    paidService(PAID, a!, b!);
    // 返すのは並びの先頭のエージェントのカード (設定のダイアログに出すカード)
    expect((await checkContracts()).map((row) => row.cardId)).toEqual([CARD_X]);
    expect(getContractRows(CARD_X).map((row) => row.status)).toEqual([
      "subscribed",
    ]);
    expect(getContractRows(CARD_Y).map((row) => row.status)).toEqual([
      "unsubscribed",
    ]);
  });

  test("手元に持つエージェントを登録していなければ、鍵を貰うエージェントに問い合わせる", async () => {
    const [a, b] = startAgents(pool(), pool(remoteCard(CARD_X)));
    paidService(PAID, a!, b!);
    await checkContracts();
    expect([pools[0]!.confirms, pools[1]!.confirms > 0]).toEqual([0, true]);
  });

  test("復号を確かめる選局は、そのカードで復号するエージェントにだけ送る", async () => {
    const [a, b] = startAgents(pool(localCard(CARD_X)), pool());
    paidService(PAID, a!, b!);
    // 先頭のエージェントのチューナーは録画が使っている。カードの無いほうが空いていても、そちらでは確かめない
    await record("GR", [{ agent: a!, channel: "T27" }], "rec 1", 10);
    const result = await testDecode(PAID);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("空きがありません");
    expect(pools[1]!.holder("live test-decode")).toBeUndefined();
  });
});

describe("後から復号させる先", () => {
  /** 置き場に掛かったままの TS を置く */
  async function scrambled(): Promise<{ input: string; output: string }> {
    const input = join(config.rawDir, "rec.m2ts");
    await Bun.write(input, new Uint8Array(188));
    return { input, output: `${input}.decoded.m2ts` };
  }

  test("カードの準備ができていて、置き場が見えるエージェントに送る。確かめた結果は控える", async () => {
    startAgents(pool(localCard(CARD_X)), pool(remoteCard(CARD_X)));
    pools[0]!.raw = "missing";
    const { input, output } = await scrambled();
    await descramble(input, output);
    expect(pools.map((p) => p.decodes)).toEqual([0, 1]);
    await descramble(input, output);
    expect(pools.map((p) => p.probes)).toEqual([1, 1]);
    // 確かめたファイルは消す
    expect(readdirSync(join(config.rawDir, ".denpa"))).toEqual([]);
  });

  test("同時に何本復号させても、確かめるファイルを取り違えない", async () => {
    startAgents(pool(localCard(CARD_X)), pool(localCard(CARD_X)));
    pools[0]!.raw = "missing";
    const { input, output } = await scrambled();
    await Promise.all([1, 2, 3].map(() => descramble(input, output)));
    expect(pools.map((p) => p.decodes)).toEqual([0, 3]);
    expect(readdirSync(join(config.rawDir, ".denpa"))).toEqual([]);
  });

  test("カードの無いエージェントには、置き場が見えても送らない。どこにも見えなければカードのある先頭", async () => {
    startAgents(pool(), pool(localCard(CARD_X)));
    pools[1]!.raw = "missing";
    const { input, output } = await scrambled();
    await descramble(input, output);
    expect(pools.map((p) => p.decodes)).toEqual([0, 1]);
  });

  test("置き場を確かめられない (古い) エージェントは、見えないと分かったエージェントより先", async () => {
    startAgents(pool(localCard(CARD_X)), pool(localCard(CARD_X)));
    pools[0]!.raw = "missing";
    pools[1]!.raw = "old";
    const { input, output } = await scrambled();
    await descramble(input, output);
    expect(pools.map((p) => p.decodes)).toEqual([0, 1]);
  });

  test("API の無い古いエージェント (知らない API への 404) は確かめられない。ファイルが無い 404 は見えない", async () => {
    startAgents(pool(localCard(CARD_X)), pool(localCard(CARD_X)));
    pools[0]!.raw = "missing";
    pools[1]!.raw = "old";
    const [missing, old] = listAgents();
    expect(await probeRaw(missing!)).toBe(false);
    expect(await probeRaw(old!)).toBeNull();
  });

  test("エージェントが 1 台なら、確かめずにそこへ送る (1 台のときの動きは変えない)", async () => {
    startAgents(pool(localCard(CARD_X)));
    const { input, output } = await scrambled();
    await descramble(input, output);
    expect([pools[0]!.probes, pools[0]!.decodes]).toEqual([0, 1]);
  });
});
