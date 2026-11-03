/**
 * エージェントの適合テスト。**本物のエージェントを起こして、HTTP の API に直接当てる。**
 *
 * denpa の E2E は偽エージェント (`tests/fake/agent.ts`) を相手にしているので、
 * 本物の取り合いも総当たりも 1 行も通らない。ここがその穴を塞ぐ。
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
 *
 * 普通のポートは HTTPS だけで、組んだ denpa しか通さない (docs/agent.md「denpa とは TLS で組む」)。
 * ここでも denpa と同じく、自分の証明書を作って `POST /denpa/pair` で組んでから当てる。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SYNC } from "@danything/arib/psi";

import { channels } from "../tests/fake/broadcast";
import { scenes } from "../tests/fake/tuner-scenes";

/** `/denpa/channels` の 1 件。ここで見るのは種別とチャンネル名だけ */
type ChannelEntry = { type: string; channel: string };

/** 既定はビルドしたもの。`bun run test:conformance` ならビルドするところからやる */
const AGENT_CMD = (process.env.AGENT_CMD ?? "agent/publish/denpa-agent").split(
  " ",
);
const PORT = Number(process.env.AGENT_TEST_PORT ?? 40881);
/** 鍵を配るポート (CARD_SHARE_PORT)。普通の API とは別 (agent/Denpa.Agent/CardShareServer.cs) */
const SHARE_PORT = PORT + 3;
const SHARE_BASE = `http://127.0.0.1:${SHARE_PORT}`;
const ROOT = resolve(import.meta.dir, "..");

/**
 * 地上波のチューナーは**1 台だけ**にしてある。
 *
 * 偽の放送にある地上波は T16 と T21 の 2 つしかないので、チューナーが 2 台あると
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

/** 組むときの合言葉。本番でも denpa とエージェントに同じ値を渡す (`AGENT_PAIR_TOKEN`) */
const TOKEN = "conformance-token";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 指紋: 証明書の DER の SHA-256 を小文字の 16 進で */
const fingerprint = (pem: string) =>
  createHash("sha256")
    .update(
      Buffer.from(
        pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""),
        "base64",
      ),
    )
    .digest("hex");

/** 組むときの proof (agent/Denpa.Agent/AgentTls.cs の Proof) */
const proof = (
  token: string,
  role: "client" | "agent",
  agent: string,
  client: string,
) =>
  createHmac("sha256", token)
    .update(`denpa-pair/${role}\n${agent}\n${client}`)
    .digest("base64url");

/** denpa の代わりの鍵と自己署名の証明書 */
interface Identity {
  key: string;
  cert: string;
  fingerprint: string;
}

/**
 * denpa が作るものに近づける: basicConstraints も EKU も付けない (openssl の既定の設定を読ませない)。
 * エージェントは TLS の段ではどの証明書も受けるので、拡張が無くても繋がることをここで見る
 */
function identity(name: string): Identity {
  const dir = mkdtempSync(join(tmpdir(), "denpa-client-"));
  try {
    writeFileSync(
      join(dir, "openssl.cnf"),
      "[req]\ndistinguished_name = dn\n[dn]\n",
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-config",
        join(dir, "openssl.cnf"),
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "2",
        "-subj",
        `/CN=${name}`,
      ],
      { stdio: "ignore" },
    );
    const cert = readFileSync(join(dir, "cert.pem"), "utf8");
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert,
      fingerprint: fingerprint(cert),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 起こしたエージェント。証明書は tls/agent.crt から読む (denpa はこれを ca にする) */
interface Agent {
  base: string;
  tlsDir: string;
  ca: string;
  fingerprint: string;
}

/** 組んだ denpa の代わり。どのエージェントともこれで組む */
const denpa = identity("denpa-conformance");

/**
 * エージェントに当てる。`as` の証明書で繋ぐ (null なら出さない)。
 * 証明書そのものを ca にするので名前は見ない (denpa と同じ)
 */
function call(
  agent: Agent,
  path: string,
  init: RequestInit = {},
  as: Identity | null = denpa,
) {
  return fetch(`${agent.base}${path}`, {
    ...init,
    tls: {
      ca: agent.ca,
      ...(as === null ? {} : { cert: as.cert, key: as.key }),
      checkServerIdentity: () => undefined,
    },
  });
}

/**
 * 組む。`client` は名乗る指紋 (既定は `as` のもの)。**接続は使い回さない** —
 * 別の証明書で張った接続に乗ると、エージェントが見る相手が変わってしまう
 */
function pair(
  agent: Agent,
  as: Identity = denpa,
  token = TOKEN,
  client = as.fingerprint,
) {
  return call(
    agent,
    "/denpa/pair",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client,
        proof: proof(token, "client", agent.fingerprint, client),
      }),
      keepalive: false,
    },
    as,
  );
}

/** 起こしたエージェントが証明書を作って待ち受けるまで待ち、denpa の代わりで組む */
async function ready(
  port: number,
  tlsDir: string,
  child: Bun.Subprocess,
  token: string | null = TOKEN,
  ms = 30_000,
): Promise<Agent> {
  const until = Date.now() + ms;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`:${port} のエージェントが起動直後に落ちました`);
    try {
      const ca = readFileSync(join(tlsDir, "agent.crt"), "utf8");
      const agent = {
        base: `https://127.0.0.1:${port}`,
        tlsDir,
        ca,
        fingerprint: fingerprint(ca),
      };
      const given =
        token ?? readFileSync(join(tlsDir, "pair-token"), "utf8").trim();
      if ((await pair(agent, denpa, given)).ok) return agent;
    } catch {
      // まだ証明書が無い・待ち受けていない
    }
    if (Date.now() > until)
      throw new Error(`:${port} のエージェントが応答しません`);
    await sleep(100);
  }
}

let work: string;
let agent: Bun.Subprocess;
let main: Agent;
let log = "";

const paths = () => ({
  tuners: join(work, "tuners.json"),
  channels: join(work, "channels.json"),
  recorded: join(work, "recorded"),
  tls: join(work, "tls"),
});

const get = (path: string, signal?: AbortSignal) =>
  call(main, path, { signal });
const request = (method: string, path: string, body?: unknown) =>
  call(main, path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
const post = (path: string, body?: unknown) => request("POST", path, body);

interface TunerStatus {
  name: string;
  types: string[];
  disabled: boolean;
  /** 選ぶ順。小さいほど先に使う (docs/agent.md「選ぶ順の約束」)。無効なチューナーは null */
  rank: number | null;
  device: string | null;
  /** 名指しで選ぶときの目印 (stream の tuner)。デバイス、無ければ名前 */
  pin: string;
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
      // 番組を作る本数。総当たりの 1 チャンネルあたりを軽くする
      FAKE_SLOTS: "4",
      // 鍵も配る。カードは無いので、配る API は理由を付けて 503 を返す
      CARD_SHARE_PORT: String(SHARE_PORT),
      // リリースのイメージが足す 1 層と同じ (`/denpa/about` のバージョン。About.cs)
      DENPA_VERSION: "v9.8.7",
      AGENT_PAIR_TOKEN: TOKEN,
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

  try {
    main = await ready(PORT, paths().tls, agent);
  } catch (error) {
    throw new Error(`${(error as Error).message}:\n${log}`);
  }
});

/**
 * 次のテストへ持ち越さない。
 *
 * 読むのをやめても、それが**エージェントに届くのは少しあと**になる (HTTP を
 * 1 枚挟んでいるため)。確保したままの状態で次のテストが始まると、取り合いの
 * 前提が崩れて何を見ているのか分からなくなる。
 *
 * 使っているチャンネル自体は残ってよい — 誰も読まなくなってから 5 秒は
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

/*
 * **組んだ denpa しか通さない** (docs/agent.md「denpa とは TLS で組む」)。ブラウザはクライアント証明書を
 * 出さないので TLS の段で落ち、証明書を出しても組んでいなければ 403。組むには合言葉が要る
 */
describe("denpa と組む", () => {
  const error = async (res: Response) =>
    ((await res.json()) as { error: string }).error;

  test("クライアント証明書を出さない相手は TLS の段で落とす。平文の HTTP も受けない", async () => {
    await expect(
      call(main, "/denpa/tuners", { keepalive: false }, null),
    ).rejects.toThrow();
    const plain = await fetch(`http://127.0.0.1:${PORT}/denpa/tuners`, {
      keepalive: false,
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    expect(plain?.status ?? 0).not.toBe(200);
  });

  test("組んでいない証明書には、組む API のほかは 403", async () => {
    const stranger = identity("stranger");
    for (const [method, path] of [
      ["GET", "/denpa/tuners"],
      ["GET", "/denpa/card"],
      ["GET", "/denpa/logs"],
      ["GET", "/denpa/stream?type=GR&channel=T16"],
      ["GET", "/denpa/nope"],
      ["GET", "/denpa/pair"],
      ["PUT", "/denpa/tuners"],
    ]) {
      const res = await call(
        main,
        path,
        { method, body: method === "PUT" ? "{}" : undefined, keepalive: false },
        stranger,
      );
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
      const body = (await res.json()) as { error: string; paired: boolean };
      // denpa は paired: false を見て組み直す (src/lib/server/agent-client.ts)
      expect(body.paired).toBe(false);
      expect(body.error).toContain("#pair=");
    }
    expect(readFileSync(join(paths().tls, "clients"), "utf8")).not.toContain(
      stranger.fingerprint,
    );
  });

  test("合言葉が違えば組めない", async () => {
    const stranger = identity("stranger");
    const res = await pair(main, stranger, "wrong-token");
    expect(res.status).toBe(403);
    expect(await error(res)).toBe("合言葉が違います");
    expect(
      (await call(main, "/denpa/tuners", { keepalive: false }, stranger))
        .status,
    ).toBe(403);
  });

  test("名乗った指紋が繋いだ証明書と違えば組めない", async () => {
    // 組んだ denpa の指紋を名乗っても、その証明書の鍵を持っていなければ通らない
    const stranger = identity("stranger");
    const res = await pair(main, stranger, TOKEN, denpa.fingerprint);
    expect(res.status).toBe(403);
    expect(await error(res)).toBe("証明書が名乗りと違います");
  });

  test("合言葉から作った proof なら組めて、エージェントも合言葉を知っていると返す", async () => {
    const newcomer = identity("newcomer");
    const res = await pair(main, newcomer);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { proof: string }).proof).toBe(
      proof(TOKEN, "agent", main.fingerprint, newcomer.fingerprint),
    );
    expect(
      (await call(main, "/denpa/tuners", { keepalive: false }, newcomer))
        .status,
    ).toBe(200);
    // 組み直しても重ねて書かない
    expect((await pair(main, newcomer)).status).toBe(200);
    const lines = readFileSync(join(paths().tls, "clients"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines.sort()).toEqual(
      [denpa.fingerprint, newcomer.fingerprint].sort(),
    );
    expect(log).toContain(
      `denpa (${newcomer.fingerprint.slice(0, 16)}) と組みました`,
    );
  });

  test("組む URL は組む前の起動のときだけ標準出力に出し、/denpa/logs には載せない", async () => {
    expect(log).toContain(`denpa と組むときの URL: https://`);
    expect(log).toContain(`:${PORT}#pair=${TOKEN}`);
    expect(await (await get("/denpa/logs")).text()).not.toContain(TOKEN);
  });

  /*
   * インストーラが動いているエージェントの様子を見る入口。自分の証明書 (agent.key) で繋ぐので組まなくてよい
   * (agent.key を読めるのはその機械の管理者だけ)
   */
  test("--status は自分の証明書で繋いで /denpa/tuners をそのまま出す。繋がらなければ 1", async () => {
    const env = {
      ...process.env,
      TUNERS_FILE: paths().tuners,
      CHANNELS_FILE: paths().channels,
    };
    const ok = Bun.spawnSync([...AGENT_CMD, "--status"], {
      cwd: ROOT,
      env: { ...env, AGENT_PORT: String(PORT) },
    });
    expect(ok.exitCode).toBe(0);
    const body = JSON.parse(ok.stdout.toString()) as { tuners: TunerStatus[] };
    expect(Array.isArray(body.tuners)).toBe(true);

    // 誰も待ち受けていないポート
    const down = Bun.spawnSync([...AGENT_CMD, "--status"], {
      cwd: ROOT,
      env: { ...env, AGENT_PORT: String(PORT + 6) },
    });
    expect(down.exitCode).toBe(1);
    expect(down.stdout.toString()).toBe("");
    expect(down.stderr.toString().length).toBeGreaterThan(0);
  });

  test("合言葉を渡さなければ tls/pair-token に作り、--pair で同じ URL を出す。鍵は作り直さない", async () => {
    const room = mkdtempSync(join(tmpdir(), "denpa-agent-pair-"));
    try {
      const env = {
        ...process.env,
        TUNERS_FILE: join(room, "tuners.json"),
        CHANNELS_FILE: join(room, "channels.json"),
        AGENT_PORT: "1234",
      };
      delete env.AGENT_PAIR_TOKEN;
      const printed = () =>
        Bun.spawnSync([...AGENT_CMD, "--pair"], {
          cwd: ROOT,
          env,
        }).stdout.toString();
      const first = printed();
      const token = readFileSync(
        join(room, "tls", "pair-token"),
        "utf8",
      ).trim();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first).toMatch(
        new RegExp(`^https://[^/:]+:1234#pair=${token}\\n$`),
      );
      const cert = readFileSync(join(room, "tls", "agent.crt"), "utf8");
      if (process.platform !== "win32") {
        expect(statSync(join(room, "tls", "pair-token")).mode & 0o777).toBe(
          0o600,
        );
        expect(statSync(join(room, "tls", "agent.key")).mode & 0o777).toBe(
          0o600,
        );
      }
      expect(printed()).toBe(first);

      // 起こしても同じ証明書のまま、ファイルの合言葉で組める
      const { agent: other, stop } = await spawnAgent(
        PORT + 2,
        { AGENT_PAIR_TOKEN: "" },
        { room, token: null },
      );
      try {
        expect(other.ca).toBe(cert);
      } finally {
        await stop();
      }
    } finally {
      rmSync(room, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("チューナー", () => {
  test("繋いである機材をそのまま出す", async () => {
    const status = await tuners();
    expect(status.map((t) => t.name)).toEqual(["gr0", "bs0", "bs1", "off0"]);
    expect(status[0].types).toEqual(["GR"]);
    expect(status[3].disabled).toBe(true);
    expect(status.every((t) => t.users.length === 0)).toBe(true);
  });

  test("選局すると素の TS が流れてくる。何も包まない", async () => {
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
    // 188 バイト区切りの頭は必ず 0x47。ここが崩れていたら誰も読めない
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

  /** 同じ物理チャンネルなら選局は 1 本で足りる */
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
   * ものが終わった」こと**。HTTP を 1 枚挟むと、送っている途中の
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
   * **1 バイトも送っていないうちに落ちたなら、まだ理由を返せる。**
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
    // GR で使えるのは gr0 だけ。off0 は無効なので、2 つ目は断られる
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

    const stream = await open("type=BS&channel=BS11:18000&use=epg&priority=3");
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
      "BS03:16432",
      "BS11:18000",
      "CS02:24608",
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
      "BS03:16432",
      "BS11:18000",
    ]);
    // 控えのファイルにも書いてある
    expect(readFileSync(paths().channels, "utf8")).toContain("あたらしい局");
  });

  test("1 件も無い差し替えは断る。今まで録れていた局を消さない", async () => {
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

/**
 * 別のエージェントを起こして組み、`/denpa/card` を読む。止めるのは呼んだ側 (`stop`)。
 * `room` を渡せばその置き場で起こす (片付けはしない)。`token` が null なら tls/pair-token の合言葉で組む
 */
async function spawnAgent(
  port: number,
  env: Record<string, string>,
  { room: given, token = TOKEN }: { room?: string; token?: string | null } = {},
) {
  const room = given ?? mkdtempSync(join(tmpdir(), "denpa-agent-card-"));
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
      AGENT_PAIR_TOKEN: TOKEN,
      ...env,
    },
    stdout: "pipe",
    stderr: "ignore",
  });
  const stop = async () => {
    other.kill("SIGKILL");
    await other.exited;
    if (given === undefined) rmSync(room, { recursive: true, force: true });
  };
  try {
    const agent = await ready(port, join(room, "tls"), other, token, 10_000);
    const card = (await (
      await call(agent, "/denpa/card")
    ).json()) as CardStatus;
    return { card, agent, other, stop };
  } catch (error) {
    await stop();
    throw error;
  }
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
    // 使うカードは 1 枚だけ
    expect(
      card.readers.filter((reader) => reader.active).length,
    ).toBeLessThanOrEqual(1);
  });

  test("鍵を配る API は専用のポートにだけある", async () => {
    // 普通の API のポートには無い
    expect((await get("/denpa/card/init")).status).toBe(404);
    expect((await post("/denpa/card/ecm", {})).status).toBe(404);

    // 専用のポート。**平文の HTTP のまま** (LAN の中だけで配る。docs/agent.md)。カードが無いので、理由を付けて 503
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
     * CARD_URL を立てたもう 1 つを起こし、こちら (カードの無いエージェント) の
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
  test("掛かったままの TS は、復号できるか理由が返るかのどちらか", async () => {
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
   * **選ぶ順はエージェントが決めて、`rank` で見せる。** 地上波も衛星も受ける 1 台
   * (PX-MLT など) は、先に並んでいても地上波専用より後。兼用の 1 台を地上波で塞ぐと
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
 * ここが既定 (30 秒) のままだった頃は、Pod を入れ替えるだけで TS が切れ、
 * 始まって 10 秒の 30 分番組が丸ごと失敗した (実機)。denpa 側は録画が終わるまで
 * 待つ作りなので、流しているこちらが先に消えると意味が無い。
 *
 * **別のエージェントを 1 つ立てて試す。** 上の一式を止めてしまうと、
 * 残りのテストが相手を失う。
 */
describe("止まれと言われたとき", () => {
  const PORT2 = PORT + 1;
  /** いま立てているほう (`spawnOther`) */
  let second: Agent;

  /** 別のエージェントを立てて、組むまで待つ。`stop` で必ず片付ける */
  async function spawnOther() {
    const { agent, other, stop } = await spawnAgent(PORT2, {
      FAKE_SLOTS: "4",
      // 本番は 6 時間。テストなので短くするが、待つ流れは同じ
      SHUTDOWN_WAIT: "30000",
    });
    second = agent;
    return { other, stop };
  }

  /** 開いて最初の塊まで読む。`abort` で接続ごと切る */
  async function openOn(path: string) {
    const aborter = new AbortController();
    const res = await call(second, path, { signal: aborter.signal });
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
        "/denpa/stream?type=BS&channel=BS11:18000&use=rec%202&priority=10",
      );
      const live = await openOn(
        "/denpa/stream?type=BS&channel=BS03:16432&use=live&priority=5",
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
   * 待ち受けだけ閉じて待っていた。そのぶん入れ替えの隙間が伸び、実機では録画の頭が約 35 秒欠けた
   */
  test("録画が無ければ、通知や番組表の選局が開いていてもすぐ落ちる", async () => {
    const { other, stop } = await spawnOther();
    try {
      const aborter = new AbortController();
      const events = await call(second, "/denpa/events", {
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

/**
 * デバッグ用の名指し。**ファイルの最後に置く** — 名指しで使ったチューナーに選局が余韻で残るので、
 * 前提が崩れる (空いているチューナーが使われていない、など) テストが後ろにあると巻き込む。
 */
describe("チューナーの名指し", () => {
  // 前の描画で定義を書き換えていても、顔ぶれ (gr0 / bs0 / bs1 / off0) をそろえてから始める
  beforeAll(async () => {
    const put = await request("PUT", "/denpa/tuners", {
      tuners: [
        { name: "gr0", types: ["GR"] },
        { name: "bs0", types: ["BS", "CS"] },
        { name: "bs1", types: ["BS", "CS"] },
        { name: "off0", types: ["GR"], disabled: true },
      ],
    });
    expect(put.status).toBe(200);
  });

  test("tuner を指定すると、順位が後ろでもそのチューナーで選局する", async () => {
    const status = await tuners();
    expect(status.map((t) => t.pin)).toEqual(["gr0", "bs0", "bs1", "off0"]);
    const stream = await open(
      "type=BS&channel=BS11:18000&use=pin%201&priority=5&tuner=bs1",
    );
    expect(stream.status).toBe(200);
    await stream.reader?.read();

    const after = await tuners();
    expect(after[1].users).toEqual([]);
    expect(after[2].users.map((u) => u.use)).toEqual(["pin 1"]);
    stream.close();
  });

  test("tuner を指定しても、同じチャンネルをほかのチューナーが読んでいれば共有せず、指定のチューナーで選局する", async () => {
    const a = await open(
      "type=BS&channel=BS11:18000&use=pin%202&priority=5&tuner=bs0",
    );
    await a.reader?.read();
    const b = await open(
      "type=BS&channel=BS11:18000&use=pin%203&priority=5&tuner=bs1",
    );
    expect(b.status).toBe(200);
    await b.reader?.read();

    const status = await tuners();
    expect(status[1].users.map((u) => u.use)).toEqual(["pin 2"]);
    expect(status[2].users.map((u) => u.use)).toEqual(["pin 3"]);
    a.close();
    b.close();
  });

  test("tuner が無い・無効・その種別を受けられないときは 400 で理由を返す", async () => {
    for (const tuner of ["none", "off0", "gr0"]) {
      const res = await open(
        `type=BS&channel=BS11:18000&use=pin%204&priority=5&tuner=${tuner}`,
      );
      expect(res.status).toBe(400);
    }
  });

  test("指定のチューナーを同じか優先度の高い相手が使っていれば、空きがあっても 409 で断る", async () => {
    const holder = await open(
      "type=BS&channel=BS11:18000&use=rec%209&priority=10&tuner=bs1",
    );
    await holder.reader?.read();
    const res = await open(
      "type=BS&channel=BS03:16432&use=pin%205&priority=5&tuner=bs1",
    );
    expect(res.status).toBe(409);
    // 空いている bs0 には振り替えない
    expect((await tuners())[1].users).toEqual([]);
    holder.close();
  });

  test("同じチューナーを名指しして同じチャンネルを見る 2 台目は、優先度が低くても選局を共有する", async () => {
    const a = await open(
      "type=BS&channel=BS11:18000&use=pin%206&priority=10&tuner=bs1",
    );
    await a.reader?.read();
    const b = await open(
      "type=BS&channel=BS11:18000&use=pin%207&priority=5&tuner=bs1",
    );
    expect(b.status).toBe(200);
    await b.reader?.read();

    const status = await tuners();
    expect(status[2].users.map((u) => u.use)).toEqual(["pin 6", "pin 7"]);
    a.close();
    b.close();
  });
});

describe("定義の書き換えと選局", () => {
  const FOUR = [
    { name: "gr0", types: ["GR"] },
    { name: "bs0", types: ["BS", "CS"] },
    { name: "bs1", types: ["BS", "CS"] },
    { name: "off0", types: ["GR"], disabled: true },
  ];

  test("名前を変えずに無効にしたチューナーの選局は畳み、利用者を残さない", async () => {
    expect(
      (await request("PUT", "/denpa/tuners", { tuners: FOUR })).status,
    ).toBe(200);
    const stream = await open("type=GR&channel=T22&use=epg%20T22&priority=3");
    await stream.reader?.read();
    expect((await tuners())[0].users.map((u) => u.use)).toEqual(["epg T22"]);

    const off = FOUR.map((t) =>
      t.name === "gr0" ? { ...t, disabled: true } : t,
    );
    expect(
      (await request("PUT", "/denpa/tuners", { tuners: off })).status,
    ).toBe(200);
    // 畳まれたので読めなくなる。読めなくなること自体が合図
    const ended = await Promise.race([
      drain(stream.reader as ReadableStreamDefaultReader),
      sleep(5000).then(() => null),
    ]);
    expect(ended).not.toBeNull();
    const status = await tuners();
    expect(status[0].users).toEqual([]);
    expect(status[0].channel).toBeNull();

    expect(
      (await request("PUT", "/denpa/tuners", { tuners: FOUR })).status,
    ).toBe(200);
  });
});
