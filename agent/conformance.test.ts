/**
 * エージェントの適合テスト。**本物のエージェントを起こして、HTTP の API に直接当てる。**
 *
 * denpa の E2E は偽エージェント (`tests/fake/agent.ts`) を相手にしているので、
 * 本物の取り合いも総当たりも1行も通らない。ここがその穴を塞ぐ。
 *
 * **API に当てているので、中身が何語で書かれていても走る。** bun の実装から .NET に
 * 書き直したときも、`AGENT_CMD` を差し替えて同じものを通した — それが
 * 「今までと同じように動く」の定義 ([agent.md](../docs/agent.md))。
 *
 *     bun run test:conformance
 *
 * **`bun run test:unit` には入れていない。** あちらはビルドした実行ファイルが
 * 要らないもの (`src` の下) だけで、こちらは先に `dotnet publish` が要る。
 * 混ぜていた頃は、ビルドする前の CI がここで ENOENT を出して落ちていた。
 *
 * チューナーの代わりは `tests/fake/tune.ts` (`FAKE_TUNE`)。エージェントから見れば
 * 「起こすと TS を流し続ける子プロセス」で、取り合いと配り方はそのまま通る。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SYNC } from "@danything/arib/psi";

import { channels } from "../tests/fake/broadcast";
import { scenes } from "../tests/fake/tuner-scenes";

/** `/denpa/channels` の1件。ここで見るのは種別とチャンネル名だけ */
type ChannelEntry = { type: string; channel: string };

/** 既定はビルドしたもの。`bun run test:conformance` ならビルドするところからやる */
const AGENT_CMD = (process.env.AGENT_CMD ?? "agent/publish/denpa-agent").split(
  " ",
);
const PORT = Number(process.env.AGENT_TEST_PORT ?? 40881);
const BASE = `http://127.0.0.1:${PORT}`;
/** 鍵を配るポート (CARD_SHARE_PORT)。普通の API とは別 (agent/Denpa.Agent/CardShareServer.cs) */
const SHARE_PORT = PORT + 3;
const SHARE_BASE = `http://127.0.0.1:${SHARE_PORT}`;
const ROOT = resolve(import.meta.dir, "..");

/**
 * 地上波のチューナーは**1台だけ**にしてある。
 *
 * 偽の放送にある地上波は T16 と T21 の2つしかないので、チューナーが2台あると
 * 「空きが無い」も「優先度の低い相手に譲らせる」も作れない。総当たりが少し遅くなるだけで
 * 済むほうを取る。
 *
 * 選局は `FAKE_TUNE` で偽物に差し替える (エージェントが `<種別> <チャンネル>` を足して起こす)。
 * 設定ファイルにも画面にもコマンドを書く場所は無く、環境変数からだけ入る。
 */
const TUNE = `bun ${ROOT}/tests/fake/tune.ts`;
const TUNERS = JSON.stringify(
  {
    tuners: [
      { name: "gr0", types: ["GR"] },
      { name: "bs0", types: ["BS", "CS"] },
      { name: "bs1", types: ["BS", "CS"] },
      { name: "off0", types: ["GR"], disabled: true },
    ],
  },
  null,
  4,
);

let work: string;
let agent: Bun.Subprocess;
let log = "";

const paths = () => ({
  tuners: join(work, "tuners.json"),
  channels: join(work, "channels.json"),
  recorded: join(work, "recorded"),
});

const get = (path: string, signal?: AbortSignal) =>
  fetch(`${BASE}${path}`, { signal });
const request = (method: string, path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
const post = (path: string, body?: unknown) => request("POST", path, body);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface TunerStatus {
  name: string;
  types: string[];
  disabled: boolean;
  /** 選ぶ順。小さいほど先に使う (docs/agent.md「選ぶ順の約束」)。無効なチューナーは null */
  rank: number | null;
  device: string | null;
  lnb: string | null;
  channel: { type: string; channel: string } | null;
  users: { use: string; priority: number }[];
}

async function tuners(): Promise<TunerStatus[]> {
  const body = (await (await get("/denpa/tuners")).json()) as {
    tuners: TunerStatus[];
  };
  return body.tuners;
}

interface Opened {
  status: number;
  reader?: ReadableStreamDefaultReader;
  /**
   * 読むのをやめる。**接続ごと切る。**
   *
   * `reader.cancel()` だけだと HTTP の接続は開いたままで、エージェントには
   * 「離した」が届かない (確保したままになる)。本物の denpa も
   * `AbortController` で切っている
   */
  close: () => void;
}

/** 開けたものは全部覚えておく。テストが途中で落ちても後片付けできるように */
const opened = new Set<() => void>();

async function open(query: string): Promise<Opened> {
  const aborter = new AbortController();
  const close = () => {
    opened.delete(close);
    aborter.abort();
  };
  opened.add(close);
  const res = await get(`/denpa/stream?${query}`, aborter.signal);
  if (!res.ok || res.body === null) {
    close();
    return { status: res.status, close };
  }
  return { status: res.status, reader: res.body.getReader(), close };
}

/** 読み終わるまで待つ。チューナーを取り上げられたときは error が入る */
async function drain(
  reader: ReadableStreamDefaultReader,
): Promise<{ bytes: number; error: string | null }> {
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes, error: null };
      bytes += (value as Uint8Array).byteLength;
    }
  } catch (error) {
    return { bytes, error: String(error) };
  }
}

beforeAll(async () => {
  /*
   * ビルドしていないだけなら、そうと言う。素の ENOENT は spawn の行しか出さず、
   * 「何をビルドすればいいのか」がどこにも書かれていない
   */
  if (AGENT_CMD[0].includes("/") && !existsSync(resolve(ROOT, AGENT_CMD[0]))) {
    throw new Error(
      `エージェントが ${AGENT_CMD[0]} にありません。` +
        "`bun run test:conformance` でビルドしてから走らせてください",
    );
  }

  work = mkdtempSync(join(tmpdir(), "denpa-agent-"));
  mkdirSync(paths().recorded, { recursive: true });
  writeFileSync(paths().tuners, TUNERS);
  writeFileSync(paths().channels, JSON.stringify(channels(), null, 4));

  agent = Bun.spawn(AGENT_CMD, {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENT_PORT: String(PORT),
      TUNERS_FILE: paths().tuners,
      CHANNELS_FILE: paths().channels,
      RAW_DIR: paths().recorded,
      FAKE_TUNE: TUNE,
      // 番組を作る本数。総当たりの1チャンネルあたりを軽くする
      FAKE_SLOTS: "4",
      // 鍵も配る。カードは無いので、配る API は理由を付けて 503 を返す
      CARD_SHARE_PORT: String(SHARE_PORT),
      // リリースのイメージが足す 1 層と同じ (`/denpa/about` のバージョン。About.cs)
      DENPA_VERSION: "v9.8.7",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  void (async () => {
    for await (const chunk of agent.stdout as ReadableStream<Uint8Array>) {
      log += new TextDecoder().decode(chunk);
    }
  })();
  void (async () => {
    for await (const chunk of agent.stderr as ReadableStream<Uint8Array>) {
      log += new TextDecoder().decode(chunk);
    }
  })();

  const until = Date.now() + 30_000;
  for (;;) {
    if (agent.exitCode !== null)
      throw new Error(`エージェントが起動直後に落ちました:\n${log}`);
    try {
      if ((await get("/denpa/tuners")).ok) break;
    } catch {
      // まだ待ち受けていない
    }
    if (Date.now() > until)
      throw new Error(`エージェントが応答しません:\n${log}`);
    await sleep(200);
  }
});

/**
 * 次のテストへ持ち越さない。
 *
 * 読むのをやめても、それが**エージェントに届くのは少しあと**になる (HTTP を
 * 1枚挟んでいるため)。確保したままの状態で次のテストが始まると、取り合いの
 * 前提が崩れて何を見ているのか分からなくなる。
 *
 * 使っているチャンネル自体は残ってよい — 誰も読まなくなってから5秒は
 * わざと離さない作りで、次に開く人はその選局を共有するのが正しい。
 */
afterEach(async () => {
  // 途中で落ちたテストの開きっぱなしも畳む
  for (const close of [...opened]) close();

  const until = Date.now() + 10_000;
  for (;;) {
    if (agent.exitCode !== null)
      throw new Error(`エージェントが落ちました:\n${log}`);
    const status = await tuners();
    if (status.every((tuner) => tuner.users.length === 0)) return;
    if (Date.now() > until) {
      throw new Error(
        `利用者が残っています: ${JSON.stringify(status.map((t) => t.users))}`,
      );
    }
    await sleep(50);
  }
}, 20_000);

afterAll(async () => {
  agent?.kill();
  await agent?.exited;
  rmSync(work, { recursive: true, force: true });
});

describe("チューナー", () => {
  test("繋いである機材をそのまま出す", async () => {
    const status = await tuners();
    expect(status.map((t) => t.name)).toEqual(["gr0", "bs0", "bs1", "off0"]);
    expect(status[0].types).toEqual(["GR"]);
    expect(status[3].disabled).toBe(true);
    expect(status.every((t) => t.users.length === 0)).toBe(true);
  });

  test("選局すると素のTSが流れてくる。何も包まない", async () => {
    const aborter = new AbortController();
    const res = await get(
      "/denpa/stream?type=GR&channel=T16&use=test&priority=1",
      aborter.signal,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/MP2T");

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    const chunk = value as Uint8Array;
    // 188バイト区切りの頭は必ず 0x47。ここが崩れていたら誰も読めない
    expect(chunk[0]).toBe(SYNC);
    expect(chunk.byteLength % 188).toBe(0);
    aborter.abort();
  });

  test("type と channel が無ければ 400", async () => {
    expect((await get("/denpa/stream?type=GR")).status).toBe(400);
  });

  test("用途と優先度がそのまま見える", async () => {
    const stream = await open("type=GR&channel=T16&use=rec%2012&priority=10");
    await stream.reader?.read();

    const gr = (await tuners())[0];
    expect(gr.channel).toEqual({ type: "GR", channel: "T16" });
    expect(gr.users).toEqual([{ use: "rec 12", priority: 10 }]);
    stream.close();
  });

  /** 同じ物理チャンネルなら選局は1本で足りる */
  test("同じチャンネルなら選局を共有する。チューナーは増えない", async () => {
    const a = await open("type=GR&channel=T21&use=rec%201&priority=10");
    const b = await open("type=GR&channel=T21&use=epg%20T21&priority=3");
    await a.reader?.read();
    await b.reader?.read();

    const status = await tuners();
    expect(status[0].users.map((u) => u.use)).toEqual(["rec 1", "epg T21"]);
    // 空いているチューナーは使われていない
    expect(status[1].channel).toBeNull();

    a.close();
    b.close();
  });

  /**
   * **チューナーを取り上げられた側は、そこで読めなくなる。**
   *
   * ここで大事なのは「エラーとして伝わること」ではなく **「勝手には終わらない
   * ものが終わった」こと**。HTTP を1枚挟むと、送っている途中の
   * ReadableStream を `error()` にしても向こうには**正常終了として届く**
   * (Bun は残りの chunk を打ち切って畳むだけで、接続を壊さない)。
   *
   * なので API の約束はこうする — **選局は利用者が切るまで終わらない。**
   * 向こうから終わったなら、それは失敗である。読む側 (denpa) は EOF を
   * 「録り終えた」と読んではいけない。この約束なら .NET でも成り立つ
   */
  test("空きが無ければ優先度の低い相手に譲らせる。譲った側はそこで読めなくなる", async () => {
    const weak = await open("type=GR&channel=T16&use=logo&priority=1");
    await weak.reader?.read();
    const ended = drain(weak.reader as ReadableStreamDefaultReader);

    const strong = await open("type=GR&channel=T21&use=rec%201&priority=10");
    await strong.reader?.read();
    expect((await tuners())[0].channel).toEqual({ type: "GR", channel: "T21" });

    // 読めなくなること自体が合図。理由が付いていればなお良い
    const result = await Promise.race([ended, sleep(5000).then(() => null)]);
    expect(result).not.toBeNull();

    strong.close();
  });

  /**
   * **1バイトも送っていないうちに落ちたなら、まだ理由を返せる。**
   *
   * 落ちた回をどれも接続を壊して知らせていた頃は、状態行すら送る前に
   * 落ちても接続だけ切れていて、呼んだ側に届くのは
   * `socket connection was closed unexpectedly` だけだった。実機で
   * 番組表集めが同じ数チャンネルを毎周落とし続けていたが、
   * **電波なのか取り損ねなのか設定なのかが記録から分からなかった。**
   *
   * 送り始めたあとは今まで通り壊す (上のテスト) — 途中まで書いた本文を
   * きれいに閉じると「録り終えた」ように届いてしまうため。
   */
  test("送る前に選局が落ちたら、理由を付けて 500 で返す", async () => {
    // 偽の放送に無いチャンネル。選局コマンドがすぐ 1 で終わる
    const res = await get(
      "/denpa/stream?type=GR&channel=T99&use=epg%20T99&priority=3",
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "").toContain("no signal");
  });

  test("自分より優先度の高い相手しかいなければ 409 で断る", async () => {
    const strong = await open("type=GR&channel=T16&use=rec%201&priority=10");
    await strong.reader?.read();

    const weak = await open("type=GR&channel=T21&use=epg&priority=3");
    expect(weak.status).toBe(409);

    strong.close();
  });

  test("無効にしたチューナーは使わない", async () => {
    // GR で使えるのは gr0 だけ。off0 は無効なので、2つ目は断られる
    const a = await open("type=GR&channel=T16&use=a&priority=5");
    await a.reader?.read();
    expect((await open("type=GR&channel=T21&use=b&priority=5")).status).toBe(
      409,
    );
    expect((await tuners())[3].channel).toBeNull();
    a.close();
  });
});

describe("通知 (SSE)", () => {
  /**
   * **繋いだ時点で応答が返る。** 何も起きていなくてもヘッダは先に送る — 最初の
   * 通知まで黙っていると、denpa の fetch は応答待ちのまま 5 分で切られ、
   * 静かな時間帯に「チューナーに繋がりません」が鳴る (実機で 1 時間おきに鳴った)
   */
  test("何も起きていなくても、繋いだ時点で応答が返る", async () => {
    const aborter = new AbortController();
    const timer = setTimeout(() => aborter.abort(), 3000);
    const res = await get("/denpa/events", aborter.signal);
    clearTimeout(timer);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    aborter.abort();
  });

  test("チューナーが動くと tuners が飛ぶ", async () => {
    const aborter = new AbortController();
    const res = await get("/denpa/events", aborter.signal);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();

    const stream = await open("type=BS&channel=BS11_0&use=epg&priority=3");
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value as Uint8Array)).toContain(
      "event: tuners",
    );

    stream.close();
    aborter.abort();
  }, 20_000);
});

describe("チャンネル", () => {
  test("スキャンの結果をそのまま返す", async () => {
    const found = (await (
      await get("/denpa/channels")
    ).json()) as ChannelEntry[];
    expect(found.map((c) => c.channel).sort()).toEqual([
      "BS03_0",
      "BS11_0",
      "T16",
      "T21",
    ]);
  });

  /**
   * **中身を作るのは denpa。** 総当たりの選局はエージェントに任せるが、
   * NIT も SDT も解析しないので「何があったか」は分からない。ここは
   * 預かって配るだけ ([agent.md](../docs/agent.md))
   */
  test("預かったチャンネルを、探した種別だけ差し替える", async () => {
    const put = await request("PUT", "/denpa/channels", {
      scanned: ["GR"],
      channels: [
        {
          type: "GR",
          channel: "T25",
          networkId: 32391,
          transportStreamId: 32391,
          remoteControlKeyId: 9,
          services: [{ serviceId: 1, serviceType: 1, name: "あたらしい局" }],
        },
      ],
    });
    expect(put.status).toBe(200);

    const found = (await (
      await get("/denpa/channels")
    ).json()) as ChannelEntry[];
    expect(found.filter((c) => c.type === "GR").map((c) => c.channel)).toEqual([
      "T25",
    ]);
    // 地上波だけ差し替えたので、衛星はそのまま残っている
    expect(found.filter((c) => c.type === "BS").map((c) => c.channel)).toEqual([
      "BS03_0",
      "BS11_0",
    ]);
    // 控えのファイルにも書いてある
    expect(readFileSync(paths().channels, "utf8")).toContain("あたらしい局");
  });

  test("1件も無い差し替えは断る。今まで録れていた局を消さない", async () => {
    const before = readFileSync(paths().channels, "utf8");
    const put = await request("PUT", "/denpa/channels", {
      scanned: ["GR"],
      channels: [],
    });
    expect(put.status).toBe(400);
    expect(readFileSync(paths().channels, "utf8")).toBe(before);
  });
});

/** `/denpa/logs` の形式 (agent/Denpa.Agent/Json.cs の LogRing) */
type LogLines = { lines: { at: number; text: string }[] };

describe("診断", () => {
  test("直近のログを古い順に返す。頭の [agent] は付けない", async () => {
    const res = await get("/denpa/logs");
    expect(res.status).toBe(200);
    const { lines } = (await res.json()) as LogLines;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(2000);
    for (const line of lines) {
      expect(typeof line.at).toBe("number");
      expect(typeof line.text).toBe("string");
      expect(line.text.startsWith("[agent]")).toBe(false);
    }
    const at = lines.map((line) => line.at);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // すぐ前のチャンネルの差し替えが残っている
    expect(
      lines.some((line) => line.text.includes("チャンネルを保存しました")),
    ).toBe(true);
  });

  test("自分のバージョン・OS・arch を返す。CCID ドライバは macOS だけ", async () => {
    const res = await get("/denpa/about");
    expect(res.status).toBe(200);
    const about = (await res.json()) as Record<string, unknown>;
    // 組むときにバージョンを入れていない実行ファイルは DENPA_VERSION で知る
    expect(about["version"]).toBe("v9.8.7");
    expect(about["os"]).toBe(
      process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : "linux",
    );
    expect(about["arch"]).toBe(process.arch === "arm64" ? "arm64" : "x64");
    expect(typeof about["runtime"]).toBe("string");
    expect((about["runtime"] as string).length).toBeGreaterThan(0);
    if (process.platform === "darwin")
      expect(["apple", "ifd-ccid"]).toContain(about["ccidDriver"] as string);
    else expect(about["ccidDriver"]).toBeNull();
  });
});

/** `/denpa/card` の形式 (agent/Denpa.Agent/Card.cs、読むのは src/lib/server/scramble.ts) */
type CardReader = {
  name: string;
  card: boolean;
  ids: string[];
  active: boolean;
  tuners: string[];
  error?: string;
};
type CardStatus = {
  ok: boolean;
  message: string;
  source: "local" | "remote";
  remote?: string;
  ids?: string[];
  tuners?: string[];
  readers: CardReader[];
};

function expectReader(reader: CardReader) {
  expect(typeof reader.name).toBe("string");
  expect(typeof reader.card).toBe("boolean");
  expect(typeof reader.active).toBe("boolean");
  for (const id of reader.ids) expect(id).toMatch(/^\d{16}$/);
  expect(Array.isArray(reader.tuners)).toBe(true);
  if (reader.error !== undefined) expect(typeof reader.error).toBe("string");
}

/** 別のエージェントを起こして、`/denpa/card` が答えるまで待つ。止めるのは呼んだ側 (`stop`) */
async function spawnAgent(port: number, env: Record<string, string>) {
  const room = mkdtempSync(join(tmpdir(), "denpa-agent-card-"));
  writeFileSync(join(room, "tuners.json"), TUNERS);
  writeFileSync(
    join(room, "channels.json"),
    JSON.stringify(channels(), null, 4),
  );
  const other = Bun.spawn(AGENT_CMD, {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENT_PORT: String(port),
      TUNERS_FILE: join(room, "tuners.json"),
      CHANNELS_FILE: join(room, "channels.json"),
      RAW_DIR: join(room, "recorded"),
      FAKE_TUNE: TUNE,
      ...env,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const stop = async () => {
    other.kill("SIGKILL");
    await other.exited;
    rmSync(room, { recursive: true, force: true });
  };
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/denpa/card`);
      if (res.ok) return { card: (await res.json()) as CardStatus, stop };
    } catch {
      // まだ待ち受けていない
    }
    await sleep(100);
  }
  await stop();
  throw new Error(`:${port} のエージェントが応答しません`);
}

describe("カードとスクランブルの復号", () => {
  test("カードリーダーの様子を返す", async () => {
    const card = (await (await get("/denpa/card")).json()) as CardStatus;
    // 手元にリーダーは無い。**それでも答えは返る**ことが大事
    expect(typeof card.ok).toBe("boolean");
    expect(typeof card.message).toBe("string");
    expect(card.source).toBe("local");
    expect(Array.isArray(card.readers)).toBe(true);
    // 読めていないときは理由を言う。読めているなら一言は空 (名前と番号は表に出る)
    if (!card.ok) expect(card.message.length).toBeGreaterThan(0);
    for (const reader of card.readers) expectReader(reader);
    // 使うカードは1枚だけ
    expect(
      card.readers.filter((reader) => reader.active).length,
    ).toBeLessThanOrEqual(1);
  });

  test("鍵を配る API は専用のポートにだけある", async () => {
    // 普通の API のポートには無い
    expect((await get("/denpa/card/init")).status).toBe(404);
    expect((await post("/denpa/card/ecm", {})).status).toBe(404);

    // 専用のポート。カードが無いので、理由を付けて 503
    const init = await fetch(`${SHARE_BASE}/denpa/card/init`);
    expect(init.status).toBe(503);
    expect(
      ((await init.json()) as { error: string }).error.length,
    ).toBeGreaterThan(0);
    const empty = await fetch(`${SHARE_BASE}/denpa/card/ecm`, {
      method: "POST",
      body: new Uint8Array(),
    });
    expect(empty.status).toBe(400);
    // IPv6 のループバックからも受ける (IPv4 とは別に待ち受けている)
    expect(
      (await fetch(`http://[::1]:${SHARE_PORT}/denpa/card/init`)).status,
    ).toBe(503);

    // 専用のポートでは、普通の API は答えない
    expect((await fetch(`${SHARE_BASE}/denpa/tuners`)).status).toBe(404);
    expect((await fetch(`${SHARE_BASE}/denpa/card`)).status).toBe(404);
  });

  test("鍵を配る相手から貰うときは、その相手を返す", async () => {
    /*
     * CARD_URL を立てたもう1つを起こし、こちら (カードの無いエージェント) の
     * 鍵を配るポートを配り役にする。貰えなくても**形式は同じ**で、手元のリーダーは並べない
     */
    const { card, stop } = await spawnAgent(PORT + 2, { CARD_URL: SHARE_BASE });
    try {
      expect(card.source).toBe("remote");
      expect(card.remote).toBe(SHARE_BASE);
      expect(typeof card.ok).toBe("boolean");
      expect(Array.isArray(card.ids)).toBe(true);
      expect(Array.isArray(card.tuners)).toBe(true);
      expect(card.readers).toEqual([]);
      // 配る側にカードが無い。何が起きたかを画面に出す
      if (!card.ok) expect(card.message).toContain("鍵を配る拠点");
    } finally {
      await stop();
    }
  }, 30_000);

  test("鍵を配る範囲の外には 403 で断り、受け取る側は理由を出す", async () => {
    /*
     * ループバックを範囲から外した配り役を起こす。ここから繋ぐと範囲の外になる。
     * それを CARD_URL にした受け取り役の画面には、断られた理由が出る
     */
    const sharePort = PORT + 4;
    const sharer = await spawnAgent(PORT + 2, {
      CARD_SHARE_PORT: String(sharePort),
      CARD_SHARE_NETWORKS: "10.0.0.0/8",
    });
    try {
      const refused = await fetch(
        `http://127.0.0.1:${sharePort}/denpa/card/init`,
      );
      expect(refused.status).toBe(403);
      const { error } = (await refused.json()) as { error: string };
      expect(error).toContain("127.0.0.1");
      expect(error).toContain("CARD_SHARE_NETWORKS");
      expect(
        (await fetch(`http://[::1]:${sharePort}/denpa/card/init`)).status,
      ).toBe(403);

      const receiver = await spawnAgent(PORT + 5, {
        CARD_URL: `http://127.0.0.1:${sharePort}`,
      });
      try {
        expect(receiver.card.ok).toBe(false);
        expect(receiver.card.message).toContain("鍵を配る拠点に断られました");
        expect(receiver.card.message).toContain("CARD_SHARE_NETWORKS");
      } finally {
        await receiver.stop();
      }
    } finally {
      await sharer.stop();
    }
  }, 30_000);

  test("往復時間の上限を付けても、近い相手には配る", async () => {
    // 往復時間は受けた接続のソケットから OS に聞く。読めなければ 403 になるので、ここで届いていることを見る
    const sharePort = PORT + 4;
    const { stop } = await spawnAgent(PORT + 2, {
      CARD_SHARE_PORT: String(sharePort),
      CARD_SHARE_MAX_RTT: "50",
    });
    try {
      expect(
        (await fetch(`http://127.0.0.1:${sharePort}/denpa/card/init`)).status,
      ).toBe(503);
    } finally {
      await stop();
    }
  }, 30_000);

  test.each<[string, string]>([
    // 書き間違い
    ["CARD_SHARE_NETWORKS", "lan"],
    // LAN の外 (グローバルアドレス・CGNAT・全部) は、読めても書けない
    ["CARD_SHARE_NETWORKS", "0.0.0.0/0"],
    ["CARD_SHARE_NETWORKS", "100.64.0.0/10"],
    ["CARD_SHARE_NETWORKS", "192.168.1.0/24,203.0.113.0/24"],
    // TTL は 8 まで
    ["CARD_TTL", "9"],
  ])(
    "読めない設定や広すぎる設定なら起動しない (%s=%s)",
    async (name, value) => {
      // 書き間違えた範囲を黙って既定に戻さない
      const room = mkdtempSync(join(tmpdir(), "denpa-agent-bad-"));
      try {
        const bad = Bun.spawn(AGENT_CMD, {
          cwd: ROOT,
          env: {
            ...process.env,
            AGENT_PORT: String(PORT + 2),
            TUNERS_FILE: join(room, "tuners.json"),
            CHANNELS_FILE: join(room, "channels.json"),
            RAW_DIR: join(room, "recorded"),
            CARD_SHARE_PORT: String(PORT + 4),
            [name]: value,
          },
          stdout: "pipe",
          stderr: "ignore",
        });
        expect(await bad.exited).not.toBe(0);
        expect(await new Response(bad.stdout).text()).toContain(name);
      } finally {
        rmSync(room, { recursive: true, force: true });
      }
    },
    30_000,
  );

  /*
   * **本文を読む API は JSON と名乗ったものしか受けない** (docs/agent.md「エージェントは認証を持たない」)。
   * text/plain はブラウザが下調べなしに送れるので、外のサイトから書き込めてしまう
   */
  test("JSON と名乗らない本文は 415 で断る", async () => {
    for (const [method, path] of [
      ["POST", "/denpa/decode"],
      ["PUT", "/denpa/tuners"],
      ["PUT", "/denpa/channels"],
    ]) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { "Content-Type": "text/plain" },
        // 通ってしまっても何も書き換えない本文 (受けていれば 400 か 500)
        body: "{}",
      });
      expect(res.status).toBe(415);
    }
  });

  test("復号の書き出し先がもうあれば上書きしない", async () => {
    writeFileSync(join(paths().recorded, "keep-in.ts"), new Uint8Array(188));
    writeFileSync(join(paths().recorded, "keep-out.ts"), "録画");
    const res = await post("/denpa/decode", {
      input: "keep-in.ts",
      output: "keep-out.ts",
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain(
      "もうあります",
    );
    expect(readFileSync(join(paths().recorded, "keep-out.ts"), "utf8")).toBe(
      "録画",
    );
  });

  test("置き場の外は復号に回さない", async () => {
    const res = await post("/denpa/decode", {
      input: "../../etc/passwd",
      output: "x.ts",
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain(
      "保存先の外",
    );
  });

  /*
   * **カードが無ければ復号できない。** ここにリーダーは無いので、確かめるのは
   * 「復号できたか」ではなく **黙って壊れないこと** — 復号できなければ理由が返り、
   * 復号できたなら掛かっていない TS が出る。
   *
   * 復号するのもカードを扱うのもエージェントの中なので、外から偽物を差し込めない
   * (`recisdb` を起こしていた頃はそこを差し替えて試せた)。復号のしかたそのものは
   * 単体テスト (B25Tests / BCasTests) で、実際に復号できることは実機で確かめる (docs/agent.md)。
   */
  test("掛かったままのTSは、復号できるか理由が返るかのどちらか", async () => {
    const packet = new Uint8Array(188 * 2);
    for (let i = 0; i < 2; i++) {
      packet[i * 188] = SYNC;
      packet[i * 188 + 3] = 0x90; // scrambling_control が立っている
    }
    writeFileSync(join(paths().recorded, "in.ts"), packet);

    const res = await post("/denpa/decode", {
      input: "in.ts",
      output: "out.ts",
    });
    const body = (await res.json()) as { ok: boolean; error: string };
    if (res.status === 200) {
      expect(body.ok).toBe(true);
      expect(readFileSync(join(paths().recorded, "out.ts"))[3] & 0xc0).toBe(0);
    } else {
      expect(body.ok).toBe(false);
      expect(body.error.length).toBeGreaterThan(0);
    }
  });
});

/**
 * `Host` を指定して当てる。fetch は `Host` を URL から作るので、ソケットに手で書く。
 * `host` が null なら `Host` を付けない HTTP/1.0。状態コードと本文を返す
 */
function rawGet(
  path: string,
  host: string | null,
  port = PORT,
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        host === null
          ? `GET ${path} HTTP/1.0\r\n\r\n`
          : `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
      );
    });
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("error", fail);
    socket.on("end", () => {
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(text)?.[1] ?? 0);
      done({ status, body: text.slice(text.indexOf("\r\n\r\n") + 4) });
    });
  });
}

/*
 * **知らない名前で呼ばれたら答えない** (docs/agent.md「エージェントは認証を持たない」)。
 * 悪いサイトが自分の名前を 127.0.0.1 に向け直しても、ブラウザが付ける `Host` はそのサイトの名前のまま
 */
describe("呼ばれる名前", () => {
  test("denpa が繋いでくる名前なら答える", async () => {
    for (const host of [
      `tuner-agent:${PORT}`,
      `tuner-agent.denpa.svc.cluster.local:${PORT}`,
      `host.docker.internal:${PORT}`,
      `127.0.0.1:${PORT}`,
      `[::1]:${PORT}`,
      `172.29.80.1:${PORT}`,
      `my-mac.local:${PORT}`,
    ]) {
      expect({
        host,
        status: (await rawGet("/denpa/tuners", host)).status,
      }).toEqual({ host, status: 200 });
    }
  });

  test("知らない名前・名前の無い呼び出しには 403 で断り、足す先をログに出す", async () => {
    for (const path of [
      "/denpa/card",
      "/denpa/logs",
      "/denpa/tuners",
      "/denpa/stream?type=GR&channel=T16",
    ]) {
      const res = await rawGet(path, `evil.example:${PORT}`);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
      expect(res.body).toContain("AGENT_ALLOWED_HOSTS");
    }
    expect((await rawGet("/denpa/tuners", null)).status).toBe(403);
    expect(log).toContain("evil.example");
    expect(log).toContain("AGENT_ALLOWED_HOSTS");
  });

  test("AGENT_ALLOWED_HOSTS に書いた名前なら答える", async () => {
    const port = PORT + 2;
    const { stop } = await spawnAgent(port, {
      AGENT_ALLOWED_HOSTS: "tuner.example.com,.tail1234.ts.net",
    });
    try {
      expect(
        (await rawGet("/denpa/tuners", "tuner.example.com", port)).status,
      ).toBe(200);
      expect(
        (await rawGet("/denpa/tuners", "agent.tail1234.ts.net", port)).status,
      ).toBe(200);
      expect((await rawGet("/denpa/tuners", "evil.example", port)).status).toBe(
        403,
      );
    } finally {
      await stop();
    }
  }, 30_000);
});

test("知らないエンドポイントは 404", async () => {
  expect((await get("/denpa/nope")).status).toBe(404);
});

/*
 * **後ろのほうに置く。** 定義を書き換えると、前のテストが当てにしている
 * 顔ぶれ (gr0 / bs0 / bs1) が消える。
 */
describe("機材の定義", () => {
  /**
   * **画面から書き換えられる。** 受け取るのはデバイスと種別と LNB だけで、
   * 選局コマンドは持たない — 自由な文字列を受けると
   * 「denpa に入れた人がチューナー側で好きなコマンドを走らせられる」
   * ことになる (しかもあちらは privileged)
   */
  test("定義を書き換えられる。選局コマンドは受け取らない", async () => {
    const put = await request("PUT", "/denpa/tuners", {
      tuners: [
        {
          name: "new0",
          types: ["GR"],
          device: "/dev/dvb/adapter9/frontend0",
          lnb: "15v",
          disabled: true,
          command: "rm -rf /",
        },
      ],
    });
    expect(put.status).toBe(200);

    const status = await tuners();
    expect(status.map((t) => t.name)).toEqual(["new0"]);
    expect(status[0].device).toBe("/dev/dvb/adapter9/frontend0");
    expect(status[0].lnb).toBe("15v");
    expect(status[0].disabled).toBe(true);
    // 画面から渡ってきたコマンドは捨てる
    expect(status[0]).not.toHaveProperty("command");
    expect(readFileSync(paths().tuners, "utf8")).not.toContain("rm -rf");
  });

  /**
   * **選ぶ順はエージェントが決めて、`rank` で見せる。** 地上波も衛星も受ける1台
   * (PX-MLT など) は、先に並んでいても地上波専用より後。兼用の1台を地上波で塞ぐと
   * 衛星が録れなくなる。受けられる種別がまったく同じチューナーは同じ順位、無効なチューナーは null。
   *
   * 決まりの中身はエージェントのもの。denpa は順位を読むだけで、自分では決めない
   * (docs/agent.md「選ぶ順の約束」)
   */
  test("選ぶ順を rank で返す", async () => {
    const put = await request("PUT", "/denpa/tuners", {
      tuners: [
        { name: "mlt0", types: ["GR", "BS", "CS"] },
        { name: "gr0", types: ["GR"] },
        { name: "bs0", types: ["BS", "CS"] },
        { name: "gr1", types: ["GR"] },
        { name: "off0", types: ["GR"], disabled: true },
      ],
    });
    expect(put.status).toBe(200);
    const status = await tuners();
    expect(status.map((t) => [t.name, t.rank])).toEqual([
      ["mlt0", 2],
      ["gr0", 0],
      ["bs0", 1],
      ["gr1", 0],
      ["off0", null],
    ]);
  });

  /**
   * **denpa と同じ場面を通す** (`tests/fake/tuner-scenes.ts`)。denpa は、エージェントが
   * この順どおりに確保する前提で予約を割り振る (src/lib/server/conflict.ts)。ここで落ちたら、
   * 約束 (docs/agent.md「選ぶ順の約束」) を破っているか、場面の期待が古い
   */
  for (const scene of scenes) {
    test(`選ぶ順の約束: ${scene.name}`, async () => {
      const put = await request("PUT", "/denpa/tuners", {
        tuners: scene.tuners.map(({ name, types }) => ({ name, types })),
      });
      expect(put.status).toBe(200);
      const ranks = new Map((await tuners()).map((t) => [t.name, t.rank]));
      // 場面が前提にしている順位で返しているか。違えば、下の答えも当てにならない
      expect(scene.tuners.map((t) => ranks.get(t.name))).toEqual(
        scene.tuners.map((t) => t.rank),
      );

      // 利用者の名乗りは場面ごとに変える。前の場面の利用者を取り違えないように
      const use = (name: string) => `scene${scenes.indexOf(scene)} ${name}`;
      const gone = async (name: string) => {
        while (
          (await tuners()).some((t) => t.users.some((u) => u.use === use(name)))
        )
          await sleep(50);
      };
      const streams = new Map<string, Opened>();
      for (const step of scene.steps) {
        if ("close" in step) {
          streams.get(step.close)?.close();
          // 利用者が抜けるのを待つ (選局は余韻で残る)
          await gone(step.close);
          continue;
        }
        const query = new URLSearchParams({
          type: step.type,
          channel: step.channel,
          use: use(step.open),
          priority: String(step.priority),
        });
        for (const name of step.after ?? []) query.append("after", use(name));
        const opened = await open(query.toString());
        if (step.rank === null) {
          expect(opened.status).toBe(409);
          continue;
        }
        expect(opened.status).toBe(200);
        await opened.reader?.read();
        streams.set(step.open, opened);
        const on = (await tuners()).find((t) =>
          t.users.some((u) => u.use === use(step.open)),
        );
        expect([
          step.open,
          on === undefined ? undefined : ranks.get(on.name),
        ]).toEqual([step.open, step.rank]);
        // 引き継いだ相手は、取り上げられたのではなく正常に終わっている (利用者が切るまで終わらない約束の例外)
        for (const name of step.ended ?? []) {
          const reader = streams.get(name)?.reader;
          expect(reader).toBeDefined();
          expect(
            (await drain(reader as ReadableStreamDefaultReader)).error,
          ).toBeNull();
          await gone(name);
        }
        // 選ばれなかったチューナーの利用者には触らない。まだ読めている
        for (const name of step.kept ?? []) {
          expect(
            (await tuners()).some((t) =>
              t.users.some((u) => u.use === use(name)),
            ),
          ).toBe(true);
          const read = await streams.get(name)?.reader?.read();
          expect(read?.done).toBe(false);
        }
      }
      // 次の場面へ持ち越さない。同じ名前のチューナーは定義を書き換えても選局が残る
      for (const [name, stream] of streams) {
        stream.close();
        await gone(name);
      }
    });
  }

  test("名前の無い定義は断る", async () => {
    const res = await request("PUT", "/denpa/tuners", {
      tuners: [{ types: ["GR"] }],
    });
    expect(res.status).toBe(400);
  });
});

/**
 * **止められても、録画 (`use=rec`) の選局が終わるまで畳まない。** ライブ視聴などほかの利用者は待たない
 *
 * ここが既定 (30秒) のままだった頃は、Pod を入れ替えるだけで TS が切れ、
 * 始まって10秒の30分番組が丸ごと失敗した (実機)。denpa 側は録画が終わるまで
 * 待つ作りなので、流しているこちらが先に消えると意味が無い。
 *
 * **別のエージェントを1つ立てて試す。** 上の一式を止めてしまうと、
 * 残りのテストが相手を失う。
 */
describe("止まれと言われたとき", () => {
  const PORT2 = PORT + 1;
  const BASE2 = `http://127.0.0.1:${PORT2}`;

  /** 別のエージェントを立てて、聞き始めるまで待つ。`stop` で必ず片付ける */
  async function spawnOther() {
    const room = mkdtempSync(join(tmpdir(), "denpa-agent-stop-"));
    writeFileSync(join(room, "tuners.json"), TUNERS);
    writeFileSync(
      join(room, "channels.json"),
      JSON.stringify(channels(), null, 4),
    );

    const other = Bun.spawn(AGENT_CMD, {
      cwd: ROOT,
      env: {
        ...process.env,
        AGENT_PORT: String(PORT2),
        TUNERS_FILE: join(room, "tuners.json"),
        CHANNELS_FILE: join(room, "channels.json"),
        RAW_DIR: join(room, "recorded"),
        FAKE_TUNE: TUNE,
        FAKE_SLOTS: "4",
        // 本番は6時間。テストなので短くするが、待つ流れは同じ
        SHUTDOWN_WAIT: "30000",
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${BASE2}/denpa/tuners`)).ok) break;
      } catch {
        // まだ聞いていない
      }
      await sleep(100);
    }

    const stop = async () => {
      other.kill("SIGKILL");
      await other.exited;
      rmSync(room, { recursive: true, force: true });
    };
    return { other, stop };
  }

  /** 開いて最初の塊まで読む。`abort` で接続ごと切る */
  async function openOn(path: string) {
    const aborter = new AbortController();
    const res = await fetch(`${BASE2}${path}`, { signal: aborter.signal });
    expect(res.ok).toBe(true);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    return { reader, abort: () => aborter.abort() };
  }

  /** `ms` のうちに落ちたか */
  const exitsWithin = async (other: Bun.Subprocess, ms: number) => {
    await Promise.race([other.exited, sleep(ms)]);
    return other.exitCode !== null;
  };

  test("録画の選局が開いている間は生きていて、離すと落ちる", async () => {
    const { other, stop } = await spawnOther();
    try {
      const rec = await openOn(
        "/denpa/stream?type=GR&channel=T16&use=rec&priority=10",
      );

      other.kill("SIGTERM");

      // **使っている間は落ちない。** ついでに、切られずに読み続けられること
      await sleep(1500);
      expect(other.exitCode).toBeNull();
      const still = await rec.reader.read();
      expect(still.done).toBe(false);

      // 離せばそこで畳む
      rec.abort();
      expect(await exitsWithin(other, 15_000)).toBe(true);
    } finally {
      await stop();
    }
  }, 60_000);

  /*
   * **止まる途中に来た選局も受ける** (Program.cs の Drain)。断っていた頃は、入れ替えの最中に始まる
   * 録画の頭が欠けた。Recreate なので新しい Pod はこちらが終わるまで立たず、断っても誰も録れない。
   * ライブは受けるが、それを理由には待たない
   */
  test("止まる途中に来た録画の選局は受けて、録り終えるまで居座る", async () => {
    const { other, stop } = await spawnOther();
    try {
      const first = await openOn(
        "/denpa/stream?type=GR&channel=T16&use=rec%201&priority=10",
      );

      other.kill("SIGTERM");
      await sleep(500);

      const second = await openOn(
        "/denpa/stream?type=BS&channel=BS11_0&use=rec%202&priority=10",
      );
      const live = await openOn(
        "/denpa/stream?type=BS&channel=BS03_0&use=live&priority=5",
      );

      // 前の録画を離しても、あとから来た録画が残っているので落ちない
      first.abort();
      await sleep(2500);
      expect(other.exitCode).toBeNull();
      expect((await second.reader.read()).done).toBe(false);

      // 録画が終われば、ライブが開いていても待たずに畳む (ライブは一緒に切れる)
      second.abort();
      expect(await exitsWithin(other, 10_000)).toBe(true);
      // 残りを読み切れば終わる (接続ごと壊れて終わってもよい)。流れ続けることはない
      try {
        while (!(await live.reader.read()).done);
      } catch {
        // 壊れて終わった
      }
    } finally {
      await stop();
    }
  }, 60_000);

  /*
   * **録画が無ければすぐ落ちる。** 通知を開きっぱなしにされると、Kestrel が 30 秒 (既定の ShutdownTimeout)
   * 受け口だけ閉じて待っていた。そのぶん入れ替えの隙間が伸び、実機では録画の頭が約 35 秒欠けた
   */
  test("録画が無ければ、通知や番組表の選局が開いていてもすぐ落ちる", async () => {
    const { other, stop } = await spawnOther();
    try {
      const aborter = new AbortController();
      const events = await fetch(`${BASE2}/denpa/events`, {
        signal: aborter.signal,
      });
      expect(events.ok).toBe(true);
      const epg = await openOn(
        "/denpa/stream?type=GR&channel=T21&use=epg&priority=3",
      );

      other.kill("SIGTERM");
      // 30 秒より十分短く。偽の選局を畳む間だけ待つ
      expect(await exitsWithin(other, 10_000)).toBe(true);

      aborter.abort();
      epg.abort();
    } finally {
      await stop();
    }
  }, 60_000);
});
