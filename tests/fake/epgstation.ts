/**
 * 偽の EPGStation (v2・v3)。
 *
 * denpa の引き継ぎ (`src/lib/server/epgstation-api.ts`) が呼ぶ API だけを、本物と同じ形で返す:
 * `/api/version`・`/api/channels`・`/api/rules`・`/api/reserves`・`/api/recorded` (ページ送り付き) と、
 * `/api/videos/<id>` (Range・416・HEAD)。番組名や中身はすべて作り物。
 *
 * 単体テストは {@link startFakeEpgstation} をその場で立て、e2e はこのファイルを直に走らせる
 * (`FAKE_EPGSTATION_PORT`)。振る舞いは `POST /__control/mode` で変える (v2/v3 の切り替え、
 * 途中で切る・Range を無視する・長さを偽る)
 */

/** 振る舞いを変えるつまみ。テストから途中で変える */
export interface FakeMode {
  /** `/api/version` が返すもの。`2.10.0` (v2)・`3.0.0-beta4` (v3)・`1.7.6` (v1) など */
  version: string;
  /** ファイルを送るとき、この長さを送ったところで接続を切る (null なら切らない) */
  cutAt: number | null;
  /** 切るのは最初の何回か。0 なら切らない (取り直しが通るかを見る) */
  cutTimes: number;
  /** Range を無視していつも頭から全部送る (Range を落とすプロキシの代わり) */
  ignoreRange: boolean;
  /** 送る中身をこれだけ短くする (`/recorded` の size とは食い違う)。ヘッダも短いほうに合わせる */
  shortBy: number;
  /** このミリ秒だけ黙ってからヘッダを返す (止まったときの取り直し・中断を見る) */
  stallMs: number;
  /** 黙るのは最初の何回か */
  stallTimes: number;
  /** 付けると Basic 認証を求める (`user:pass`) */
  basic: string | null;
  /** ルールの形を崩す (形が違っても続くかを見る) */
  drift: boolean;
  /** ルールを足して、ページ送りが要る数にする */
  extraRules: number;
  /** ルールの一覧で offset を無視して、いつも頭のページを返す */
  ignoreOffset: boolean;
}

export const DEFAULT_MODE: FakeMode = {
  version: "3.0.0-beta4",
  cutAt: null,
  cutTimes: 0,
  ignoreRange: false,
  shortBy: 0,
  stallMs: 0,
  stallTimes: 0,
  basic: null,
  drift: false,
  extraRules: 0,
  ignoreOffset: false,
};

/** denpa の偽の放送にある局 (TOKYO MX。`tests/fake/services.ts`) */
export const KNOWN_CHANNEL = 3239123608;
/** denpa の知らない局。名前は `/channels` から写す */
export const UNKNOWN_CHANNEL = 3273601024;

const START = Date.UTC(2026, 8, 1, 12, 0, 0);
const MINUTE = 60_000;

/** 送るファイル。中身は ID と位置から決まるバイト列 ({@link byteAt}) */
export const VIDEO_FILES = {
  /** 録画 1 のエンコード済み */
  11: { size: 96 * 1024, filename: "引き継ぎテスト #1.mp4" },
  /** 録画 1 の元のTS (エンコード済みがあるので取らない) */
  12: { size: 128 * 1024, filename: "引き継ぎテスト #1.m2ts" },
  /** 録画 2 の元のTS */
  21: { size: 160 * 1024, filename: "引き継ぎテスト #2.m2ts" },
} as const;

export function byteAt(fileId: number, index: number): number {
  return (index * 31 + fileId * 7) & 0xff;
}

export function videoContent(
  fileId: number,
  size: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = byteAt(fileId, i);
  return out;
}

function rules(mode: FakeMode): unknown[] {
  const v3 = mode.version.startsWith("3");
  const list: unknown[] = [
    {
      id: 1,
      isTimeSpecification: false,
      searchOption: {
        // 無効の印 (他のテストに予約を立てない)。取り込んでも無効のまま
        keyword: "引き継ぎテスト",
        ignoreKeyword: "再放送",
        name: true,
        description: true,
        extended: false,
        GR: true,
        BS: false,
        CS: false,
        SKY: false,
        genres: [{ genre: 7 }, { genre: 7, subGenre: 0 }],
        times: [{ start: 19, range: 2, week: 32 }],
        channelIds: [KNOWN_CHANNEL, UNKNOWN_CHANNEL],
      },
      reserveOption: {
        enable: false,
        allowEndLack: true,
        avoidDuplicate: true,
      },
    },
    {
      id: 2,
      isTimeSpecification: false,
      searchOption: {
        keyword: "テスト.*",
        keyRegExp: true,
        name: true,
        GR: true,
      },
      reserveOption: {
        enable: false,
        allowEndLack: true,
        avoidDuplicate: false,
      },
    },
    {
      id: 3,
      isTimeSpecification: true,
      searchOption: {
        channelIds: [KNOWN_CHANNEL],
        times: [{ start: 3600, range: 1800, week: 2 }],
      },
      reserveOption: {
        enable: false,
        allowEndLack: true,
        avoidDuplicate: false,
      },
    },
    {
      id: 4,
      isTimeSpecification: false,
      searchOption: {
        keyword: "高画質テスト",
        name: true,
        BS: true,
        ...(v3 ? { BS4K: true } : {}),
        keyCS: true,
        isFree: true,
      },
      reserveOption: {
        enable: false,
        allowEndLack: true,
        avoidDuplicate: false,
      },
    },
  ];
  for (let i = 0; i < mode.extraRules; i++) {
    list.push({
      id: 100 + i,
      isTimeSpecification: false,
      searchOption: { keyword: `まとめて ${i}`, name: true, GR: true },
      reserveOption: {
        enable: false,
        allowEndLack: true,
        avoidDuplicate: false,
      },
    });
  }
  if (mode.drift) {
    // 形の崩れたもの: 真偽が数で来る・searchOption が無い・id が無い
    list.push({
      id: 5,
      isTimeSpecification: 0,
      searchOption: { keyword: "形違いテスト", name: 1, GR: 1 },
      reserveOption: { enable: 0, avoidDuplicate: 0 },
    });
    list.push({ id: 6, isTimeSpecification: false, reserveOption: {} });
    list.push({ isTimeSpecification: false, searchOption: { keyword: "x" } });
  }
  return list;
}

function reserves(): unknown[] {
  const base = {
    isConflict: false,
    isOverlap: false,
    allowEndLack: true,
    isDeleteOriginalAfterEncode: false,
    channelId: KNOWN_CHANNEL,
  };
  return [
    // 手で入れた予約。番組は denpa の番組表に無い
    {
      ...base,
      id: 1,
      programId: 323912360800001,
      isSkip: false,
      isTimeSpecified: false,
      startAt: Date.now() + 60 * MINUTE,
      endAt: Date.now() + 90 * MINUTE,
      name: "手で入れた予約テスト",
    },
    // ルールが立てた予約 (触らない)
    {
      ...base,
      id: 2,
      ruleId: 1,
      programId: 323912360800002,
      isSkip: false,
      isTimeSpecified: false,
      startAt: Date.now() + 60 * MINUTE,
      endAt: Date.now() + 90 * MINUTE,
      name: "ルールの予約テスト",
    },
    // 除外の印
    {
      ...base,
      id: 3,
      programId: 323912360800003,
      isSkip: true,
      isTimeSpecified: false,
      startAt: Date.now() + 60 * MINUTE,
      endAt: Date.now() + 90 * MINUTE,
      name: "除外テスト",
    },
  ];
}

function video(id: keyof typeof VIDEO_FILES, type: "ts" | "encoded") {
  const file = VIDEO_FILES[id];
  return {
    id,
    name: type === "ts" ? "TS" : "H.264",
    filename: file.filename,
    type,
    size: file.size,
  };
}

function recorded(): unknown[] {
  const at = (n: number) => ({
    startAt: START + n * 30 * MINUTE,
    endAt: START + (n + 1) * 30 * MINUTE,
  });
  const base = { isProtected: false, isEncoding: false, isRecording: false };
  return [
    {
      ...base,
      id: 1,
      ruleId: 1,
      channelId: KNOWN_CHANNEL,
      ...at(0),
      name: "引き継ぎテスト #1",
      description: "1話の説明",
      rawExtended: { 出演者: "作り物の人" },
      videoFiles: [video(12, "ts"), video(11, "encoded")],
    },
    {
      ...base,
      id: 2,
      channelId: UNKNOWN_CHANNEL,
      ...at(1),
      name: "引き継ぎテスト #2",
      videoFiles: [video(21, "ts")],
    },
    {
      ...base,
      id: 3,
      ruleId: 1,
      channelId: KNOWN_CHANNEL,
      ...at(2),
      name: "録画中テスト",
      isRecording: true,
      videoFiles: [],
    },
    // ファイルの無い録画 (消されたなど)
    {
      ...base,
      id: 4,
      channelId: KNOWN_CHANNEL,
      ...at(3),
      name: "ファイル無しテスト",
      videoFiles: [],
    },
    // 一覧にはあるが、ファイルを取りに行くと 404
    {
      ...base,
      id: 5,
      channelId: KNOWN_CHANNEL,
      ...at(4),
      name: "消えたファイルテスト",
      videoFiles: [
        {
          id: 51,
          name: "TS",
          filename: "消えた.m2ts",
          type: "ts",
          size: 1024,
        },
      ],
    },
  ];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** `offset`・`limit` で切る。省略時の limit は本物と同じ 24 */
function page<T>(
  list: T[],
  url: URL,
  ignoreOffset = false,
): { items: T[]; total: number } {
  const offset = ignoreOffset ? 0 : Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 24);
  return { items: list.slice(offset, offset + limit), total: list.length };
}

export interface FakeEpgstation {
  url: string;
  mode: FakeMode;
  /** 受けたファイルのリクエスト (Range ヘッダ。無ければ null) */
  videoRequests: { id: number; range: string | null; method: string }[];
  /** 受けた一覧のリクエスト (パスとクエリ) */
  listRequests: string[];
  /** 受けた Authorization ヘッダ */
  authorizations: (string | null)[];
  /** 振る舞いを変える。切った・黙った回数も数え直す */
  setMode: (mode: Partial<FakeMode>) => void;
  stop: () => Promise<void>;
}

/** 立てる。`port` が 0 なら空いているものを使う */
export function startFakeEpgstation(
  port = 0,
  mode: Partial<FakeMode> = {},
): FakeEpgstation {
  const state: FakeEpgstation = {
    url: "",
    mode: { ...DEFAULT_MODE, ...mode },
    videoRequests: [],
    listRequests: [],
    authorizations: [],
    setMode: (next) => {
      state.mode = { ...DEFAULT_MODE, ...next };
      cuts = 0;
      stalls = 0;
    },
    stop: async () => {},
  };
  let cuts = 0;
  let stalls = 0;

  async function serveVideo(request: Request, id: number): Promise<Response> {
    const range = request.headers.get("range");
    state.videoRequests.push({ id, range, method: request.method });
    const file = (VIDEO_FILES as Record<number, { size: number }>)[id];
    if (file === undefined) return new Response("not found", { status: 404 });
    const { mode: m } = state;
    const total = file.size - m.shortBy;
    const content = videoContent(id, total);

    let start = 0;
    let status = 200;
    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Content-Type": "video/mp2t",
    };
    const matched = /^bytes=(\d+)-$/.exec(range ?? "");
    if (matched !== null && !m.ignoreRange) {
      start = Number(matched[1]);
      if (start >= total) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${total}` },
        });
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${total - 1}/${total}`;
    }
    headers["Content-Length"] = String(total - start);
    if (request.method === "HEAD")
      return new Response(null, { status, headers });

    if (m.stallMs > 0 && stalls < m.stallTimes) {
      stalls++;
      await Bun.sleep(m.stallMs);
    }
    const body = content.subarray(start);
    const cut =
      m.cutAt !== null &&
      cuts < m.cutTimes &&
      m.cutAt > start &&
      m.cutAt - start < body.length
        ? m.cutAt - start
        : null;
    if (cut === null) return new Response(body, { status, headers });
    cuts++;
    // 途中まで送って接続ごと落とす
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(body.subarray(0, cut));
        await Bun.sleep(20);
        // 宣言した長さより手前で閉じる (Content-Length に届かないまま接続が終わる)
        controller.close();
      },
    });
    return new Response(stream, { status, headers });
  }

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/sub/, "");

      if (path === "/__control/mode" && request.method === "POST") {
        state.setMode((await request.json()) as Partial<FakeMode>);
        return json({ ok: true });
      }
      if (path === "/__control/state") return json(state);

      state.authorizations.push(request.headers.get("authorization"));
      if (
        state.mode.basic !== null &&
        request.headers.get("authorization") !==
          `Basic ${btoa(state.mode.basic)}`
      ) {
        return new Response("unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="epgstation"' },
        });
      }

      if (path === "/api/version") return json({ version: state.mode.version });
      if (path === "/api/channels") {
        return json([
          {
            id: KNOWN_CHANNEL,
            serviceId: 23608,
            networkId: 32391,
            name: "ＴＯＫＹＯ　ＭＸ１",
            halfWidthName: "TOKYO MX1",
            hasLogoData: false,
            channelType: "GR",
            channel: "16",
          },
          {
            id: UNKNOWN_CHANNEL,
            serviceId: 1024,
            networkId: 32736,
            name: "どこかのテレビ",
            halfWidthName: "どこかのテレビ",
            hasLogoData: false,
            channelType: "GR",
            channel: "27",
          },
        ]);
      }
      if (path === "/api/rules") {
        state.listRequests.push(`${path}${url.search}`);
        const { items, total } = page(
          rules(state.mode),
          url,
          state.mode.ignoreOffset,
        );
        return json({ rules: items, total });
      }
      if (path === "/api/reserves") {
        state.listRequests.push(`${path}${url.search}`);
        const { items, total } = page(reserves(), url);
        return json({ reserves: items, total });
      }
      if (path === "/api/recorded") {
        state.listRequests.push(`${path}${url.search}`);
        const { items, total } = page(recorded(), url);
        return json({ records: items, total });
      }
      const videoMatch = /^\/api\/videos\/(\d+)$/.exec(path);
      if (videoMatch !== null)
        return serveVideo(request, Number(videoMatch[1]));
      return new Response("not found", { status: 404 });
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  state.stop = () => server.stop(true);
  return state;
}

if (import.meta.main) {
  const port = Number(process.env["FAKE_EPGSTATION_PORT"] ?? 8888);
  startFakeEpgstation(port);
  console.log(`fake epgstation listening on :${port}`);
}
