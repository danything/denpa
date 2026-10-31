import { afterEach, describe, expect, test } from "bun:test";

import type { ResponseMessage } from "@danything/arib/bml-protocol";

import {
  type Bml,
  type BmlOptions,
  createBml,
  MAX_QUEUE,
  MAX_TIMERS,
  type Service,
} from "./engine";
import { sampleMng } from "./mng.fixture";
import { type Plane, planeArea } from "./plane";
import type { ImageSource } from "./render";

/*
 * エンジンを丸ごと動かす。描く先はブラウザではないので、何でも受け取る小さな偽の DOM に描かせる
 * (中身は見ない。確かめるのはエンジンがページの手を放すか)
 */

type Loose = Record<PropertyKey, unknown>;

function fakeNode(): unknown {
  const store: Loose = {};
  const self: unknown = new Proxy(() => {}, {
    get(_, key) {
      if (key in store) return store[key];
      if (key === Symbol.toPrimitive) return () => "";
      if (key === Symbol.iterator) return function* () {};
      if (key === "then") return undefined;
      store[key] = fakeNode();
      return store[key];
    },
    set(_, key, value) {
      store[key] = value;
      return true;
    },
    apply: () => fakeNode(),
  });
  return self;
}

const globals = globalThis as unknown as Loose;
globals["ShadowRoot"] ??= class {};

const media = (type: string, subtype: string) => ({
  type,
  originalType: type,
  subtype,
  originalSubtype: subtype,
  parameters: [],
});

/** 入口 (/40/0000) に文書と添えるファイルを置いて、届いたことにする */
function carousel(
  files: [string, string, string][],
  version = 1,
): ResponseMessage[] {
  return [
    {
      type: "pmt",
      components: [{ pid: 0x140, componentId: 0x40, streamType: 0x0d }],
    },
    {
      type: "moduleListUpdated",
      componentId: 0x40,
      modules: [{ id: 0, version, size: 1 }],
      dataEventId: 1,
    },
    {
      type: "moduleDownloaded",
      componentId: 0x40,
      moduleId: 0,
      version,
      dataEventId: 1,
      files: files.map(([name, type, body]) => {
        const [major = "text", minor = "plain"] = type.split("/");
        return {
          contentLocation: name,
          contentType: media(major, minor),
          dataBase64: Buffer.from(body, "latin1").toString("base64"),
        };
      }),
    },
  ];
}

function startup(body: string, script = ""): [string, string, string] {
  return bmlFile("startup.bml", body, script);
}

const opened: Bml[] = [];
afterEach(() => {
  for (const bml of opened.splice(0)) bml.destroy();
});

function open(options: Partial<BmlOptions> = {}): { bml: Bml; logs: string[] } {
  const logs: string[] = [];
  const bml = createBml({
    root: { attachShadow: () => fakeNode() } as unknown as HTMLElement,
    fonts: { round: "a", boldRound: "a", square: "a" },
    ip: {
      connected: () => false,
      transmit: async () => ({
        resultCode: 0,
        status: "",
        body: new Uint8Array(),
      }),
      confirm: async () => null,
      get: async () => null,
    },
    store: { get: () => null, set: () => {} },
    clock: () => Date.UTC(2026, 9, 12, 3),
    log: (message) => logs.push(message),
    ...options,
  });
  opened.push(bml);
  return { bml, logs };
}

/** エンジンの中 (Engine の非公開のもの)。外から覗くのはテストだけ */
const inside = (bml: Bml) =>
  bml as unknown as {
    ureg: string[];
    resources: { fetch: (...args: unknown[]) => Promise<unknown> };
    image: (url: string, type: string) => ImageSource | null;
  };

/**
 * `until` が真になるまで待ちながら、ページの手が空かなかった最も長い間 (ms) を計る。
 * 0ms のタイマーを回し続け、その間隔の最大を見る (エンジンが握っている間はタイマーが来ない)
 */
async function watch(
  until: () => boolean,
  limit = 10_000,
): Promise<{ longest: number; done: boolean }> {
  let longest = 0;
  let last = performance.now();
  const started = last;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (until()) return { longest, done: true };
    if (now - started > limit) return { longest, done: false };
  }
}

describe("エンジンはページを固めない", () => {
  test("モジュールに無い画像を指す object で、描き直しと取得を繰り返さない", async () => {
    const { bml } = open();
    const resources = inside(bml).resources;
    // 直す前は、描く → 無いので取得する → すぐ「無い」と返る → 描き直す… がマイクロタスクで
    // 回り続けてページが固まった。数えて、多すぎたら止める (テストが固まらないように)
    let fetches = 0;
    const fetch = resources.fetch.bind(resources);
    resources.fetch = (...args) => {
      if (++fetches > 1000) throw new Error("取得しすぎ");
      return fetch(...args);
    };
    for (const message of carousel([
      startup(
        '<object type="image/jpeg" data="missing.jpg" style="left:0px;top:0px;width:100px;height:50px"/>',
        'function start() { browser.Ureg[1] = "ready"; }',
      ),
    ]))
      bml.feed(message);
    const { done } = await watch(() => inside(bml).ureg[1] === "ready");
    expect(done).toBe(true);
    await watch(() => false, 300);
    expect(bml.path).toBe("/40/0000/startup.bml");
    expect(fetches).toBeLessThan(10);
  });

  test("すぐ返る待ち (届いているファイルの BinaryTable) をくり返すスクリプトでも、手を放す", async () => {
    const { bml } = open();
    // 届いているファイルの BinaryTable はすぐ返る。直す前は、待ち → 続き → 待ち… が
    // マイクロタスクでつながり、ループが終わるまで一度も手を放さなかった
    const script = `function start() {
            var n = 0;
            for (var i = 0; i < 100000; i++) {
                var t = new BinaryTable("table.bin", "0,U:1B");
                if (t != null) n += t.nrow;
            }
            browser.Ureg[1] = "done:" + n;
        }`;
    for (const message of carousel([
      startup("", script),
      ["table.bin", "application/octet-stream", "\x01\x02\x03"],
    ]))
      bml.feed(message);
    const { longest, done } = await watch(
      () => inside(bml).ureg[1]?.startsWith("done") === true,
      60_000,
    );
    expect(done).toBe(true);
    expect(inside(bml).ureg[1]).toBe("done:300000");
    expect(longest).toBeLessThan(100);
  }, 70_000);

  test("長いループでも 1 回に握るのは区切りの長さほど", async () => {
    const { bml } = open();
    const script = `function start() {
            var s = 0;
            for (var i = 0; i < 2000000; i++) s += i % 7;
            browser.Ureg[1] = "done:" + s;
        }`;
    for (const message of carousel([startup("", script)])) bml.feed(message);
    const { longest, done } = await watch(
      () => inside(bml).ureg[1]?.startsWith("done") === true,
      60_000,
    );
    expect(done).toBe(true);
    expect(longest).toBeLessThan(100);
  }, 70_000);

  test("受け手が自分を呼び直し続ける (lockModuleOnMemory の通知で押さえ直す) と、手を放しながら回る", async () => {
    const { bml } = open();
    // 押さえ直すと、届いているモジュールはすぐ通知が来る。直す前は、通知 → 受け手 →
    // 押さえ直す → 通知… がマイクロタスクで回り続けた
    const script = `var n = 0;
            function start() { browser.lockModuleOnMemory("/40/0000"); }
            function locked() {
                n++;
                browser.Ureg[1] = "" + n;
                if (n >= 20000) return;
                browser.unlockModuleOnMemory("/40/0000");
                browser.lockModuleOnMemory("/40/0000");
            }`;
    for (const message of carousel([
      startup(
        '<bevent><beitem id="b" type="ModuleLocked" module_ref="/40/0000" subscribe="subscribe" onoccur="locked();"/></bevent>',
        script,
      ),
    ]))
      bml.feed(message);
    const { longest, done } = await watch(
      () => Number(inside(bml).ureg[1]) >= 20000,
      20_000,
    );
    expect(done).toBe(true);
    expect(longest).toBeLessThan(100);
  }, 30_000);

  test("setInterval の受け手が間隔より重くても、待ちに重ねて積まない", async () => {
    const { bml } = open();
    // 1ms ごとに、1 回に区切りを何度もまたぐ受け手。直す前は動いている間の刻みが全部積まれ、
    // 止めた後も積んだ分が動き続けた
    const script = `var n = 0, id;
            function start() { id = browser.setInterval("tick();", 1, 0); }
            function tick() {
                n++;
                browser.Ureg[1] = "" + n;
                if (n >= 5) browser.clearTimer(id);
                var s = 0;
                for (var i = 0; i < 300000; i++) s += i;
            }`;
    for (const message of carousel([startup("", script)])) bml.feed(message);
    const { done } = await watch(
      () => Number(inside(bml).ureg[1]) >= 5,
      20_000,
    );
    expect(done).toBe(true);
    await watch(() => false, 500);
    expect(Number(inside(bml).ureg[1])).toBeLessThanOrEqual(6);
  }, 30_000);

  test("手が空かないまま続く文書は止めて知らせる", async () => {
    const { bml, logs } = open({ budget: { window: 100 } });
    // 終わらないループ。命令の数の上限に届く前に、手が空かない時間の上限で止まる
    for (const message of carousel([
      startup("", "function start() { for (;;) {} }"),
    ]))
      bml.feed(message);
    const { longest, done } = await watch(
      () => bml.path === null && logs.length > 0,
      20_000,
    );
    expect(done).toBe(true);
    expect(longest).toBeLessThan(100);
    expect(logs.some((line) => line.includes("止めました"))).toBe(true);
    // 止めた文書を勝手に出し直さない
    for (const message of carousel([startup("", "function start() {}")], 2))
      bml.feed(message);
    await watch(() => false, 200);
    expect(bml.path).toBeNull();
  }, 30_000);
});

describe("文書のスクリプト", () => {
  test("空の p の firstChild.data に書いても止まらず、後に続く処理まで動く", async () => {
    const { bml, logs } = open();
    // 2026-10-12 本番 (NHK 総合の録画) で、空の p に日時・局名を書くところで「null の data に
    // 書けません」と止まり、後に続くメニューと天気の表が出なかった形 (字は ASCII。偽のカルーセルは latin1 で詰める)
    const script = `function start() {
            document.getElementById("date").firstChild.data = "10/12 18:01";
            document.getElementById("area").firstChild.data = "Chiba";
            document.getElementById("blank").firstChild.data = "Typhoon";
            browser.Ureg[1] = document.getElementById("date").firstChild.data + "|" +
                document.getElementById("area").firstChild.data + "|" +
                document.getElementById("blank").firstChild.data;
        }`;
    for (const message of carousel([
      startup(
        '<p id="date" style="left:0px;top:0px;width:200px;height:30px"></p><p id="area"/><p id="blank">\n  \n</p>',
        script,
      ),
    ]))
      bml.feed(message);
    const { done } = await watch(() => inside(bml).ureg[1] !== "");
    expect(done).toBe(true);
    expect(inside(bml).ureg[1]).toBe("10/12 18:01|Chiba|Typhoon");
    expect(logs.filter((line) => line.includes("スクリプトの誤り"))).toEqual(
      [],
    );
  });
});

/** 今の局 (programInfo) */
const PROGRAM: ResponseMessage = {
  type: "programInfo",
  originalNetworkId: 0x7fe1,
  transportStreamId: 0x7fe1,
  serviceId: 0x400,
  eventId: 0x1234,
  eventName: "x",
  startTimeUnixMillis: Date.UTC(2026, 9, 12, 2),
  durationSeconds: 3600,
  indefiniteDuration: false,
  networkId: 0x7fe1,
};

/** 文書を 1 つ足す (入口と同じモジュール) */
function bmlFile(
  name: string,
  body: string,
  script = "",
  style = "resolution:960x540",
): [string, string, string] {
  return [
    name,
    "text/X-arib-bml",
    `<?xml version="1.0" encoding="EUC-JP"?>
<bml><head><title>t</title><script><![CDATA[${script}]]></script></head>
<body style="${style}" onload="start();">${body}</body></bml>`,
  ];
}

const feedAll = (bml: Bml, messages: ResponseMessage[]): void => {
  for (const message of messages) bml.feed(message);
};

describe("setInterval", () => {
  test("引数つきの呼び出し (f(3);) も式として刻みごとに動かす", async () => {
    const { bml, logs } = open();
    const script = `var seen = "";
            function start() { browser.setInterval("add(3); add(4);", 5, 2); }
            function add(n) { seen += n; browser.Ureg[1] = seen; }`;
    feedAll(bml, carousel([startup("", script)]));
    const { done } = await watch(() => inside(bml).ureg[1] === "3434");
    expect(done).toBe(true);
    await watch(() => false, 100);
    // 回数 2 で止まる
    expect(inside(bml).ureg[1]).toBe("3434");
    expect(logs).toEqual([]);
  });

  test("回数を変数で渡しても、その回数だけ動く (放送大学の書き方)", async () => {
    const { bml } = open();
    const script = `var n = 0, times = 3;
            function start() { browser.setInterval("timeManager();", 5, times); }
            function timeManager() { n++; browser.Ureg[1] = "" + n; }`;
    feedAll(bml, carousel([startup("", script)]));
    const { done } = await watch(() => inside(bml).ureg[1] === "3");
    expect(done).toBe(true);
    await watch(() => false, 100);
    expect(inside(bml).ureg[1]).toBe("3");
  });

  test("読めない式は NaN を返して知らせる", async () => {
    const { bml, logs } = open();
    feedAll(
      bml,
      carousel([
        startup(
          "",
          'function start() { browser.Ureg[1] = "" + browser.setInterval("f(;", 5, 1); }',
        ),
      ]),
    );
    const { done } = await watch(() => inside(bml).ureg[1] !== "");
    expect(done).toBe(true);
    expect(inside(bml).ureg[1]).toBe("NaN");
    expect(
      logs.some((line) => line.includes("setInterval の式が読めません")),
    ).toBe(true);
  });

  test("前後や中に空白のある呼ぶだけの形 ( f ( ) ; ) も呼ぶ", async () => {
    const { bml, logs } = open();
    const script = `var n = 0;
            function start() { browser.setInterval("  tick ( ) ;  ", 5, 2); }
            function tick() { n++; browser.Ureg[1] = "" + n; }`;
    feedAll(bml, carousel([startup("", script)]));
    const { done } = await watch(() => inside(bml).ureg[1] === "2");
    expect(done).toBe(true);
    expect(logs).toEqual([]);
  });

  test("空白を長く並べた式でも固まらない (正規表現が空白で行きつ戻りつしない)", async () => {
    const { bml, logs } = open();
    const script = `function start() {
              var s = " ";
              for (var i = 0; i < 17; i++) s = s + s;
              browser.Ureg[1] = "" + browser.setInterval("f()" + s + "x", 5, 1);
            }`;
    const started = performance.now();
    feedAll(bml, carousel([startup("", script)]));
    const { done } = await watch(() => inside(bml).ureg[1] !== "");
    expect(done).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(inside(bml).ureg[1]).toBe("NaN");
    expect(
      logs.some((line) => line.includes("setInterval の式が読めません")),
    ).toBe(true);
  });
});

describe("文書の名前", () => {
  test("問い合わせつきの launchDocument: ファイルは問い合わせを外して引き、文書からは名前ごと読める", async () => {
    const { bml, logs } = open();
    feedAll(
      bml,
      carousel([
        startup(
          "",
          'function start() { browser.launchDocument("next.bml" + "?tsid=" + "7fe1", "cut"); }',
        ),
        bmlFile(
          "next.bml",
          "",
          "function start() { browser.Ureg[1] = browser.getActiveDocument(); }",
        ),
      ]),
    );
    const { done } = await watch(() => inside(bml).ureg[1] !== "");
    expect(done).toBe(true);
    expect(inside(bml).ureg[1]).toBe("/40/0000/next.bml?tsid=7fe1");
    expect(bml.path).toBe("/40/0000/next.bml?tsid=7fe1");
    expect(logs).toEqual([]);
  });

  test("規格に無い名前 (bml://) は今の文書のまま失敗を返して知らせる", async () => {
    const { bml, logs } = open();
    const script = `function start() {
            var r = browser.launchDocument("bml://menu.bml", "cut");
            browser.Ureg[1] = "" + r;
        }`;
    feedAll(bml, carousel([startup("", script)]));
    const { done } = await watch(() => inside(bml).ureg[1] !== "");
    expect(done).toBe(true);
    expect(inside(bml).ureg[1]).toBe("NaN");
    expect(bml.path).toBe("/40/0000/startup.bml");
    expect(
      logs.some(
        (line) =>
          line.includes("規格に無いスキーム") &&
          line.includes("bml://menu.bml"),
      ),
    ).toBe(true);
  });
});

describe("移れない文書へ移ろうとしても閉じない", () => {
  test("DII に載っていてまだ届いていないモジュールへは、届くのを待って移る", async () => {
    const { bml } = open();
    const [pmt, , entry] = carousel([
      startup(
        "",
        'function start() { browser.launchDocument("/40/0001/next.bml", "cut"); }',
      ),
    ]);
    const list: ResponseMessage = {
      type: "moduleListUpdated",
      componentId: 0x40,
      modules: [
        { id: 0, version: 1, size: 1 },
        { id: 1, version: 1, size: 1 },
      ],
      dataEventId: 1,
    };
    feedAll(bml, [PROGRAM, pmt!, list, entry!]);
    const [, , next] = carousel([
      bmlFile(
        "next.bml",
        "",
        "function start() { browser.Ureg[1] = browser.getActiveDocument(); }",
      ),
    ]);
    await watch(() => bml.path === "/40/0000/startup.bml");
    // 入口の launchDocument が先に走り、モジュールを待っているところへ届ける
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bml.path).toBe("/40/0000/startup.bml");
    bml.feed({
      ...(next as Extract<ResponseMessage, { type: "moduleDownloaded" }>),
      moduleId: 1,
    });
    const { done } = await watch(() => inside(bml).ureg[1] !== "");
    expect(done).toBe(true);
    expect(inside(bml).ureg[1]).toBe("/40/0001/next.bml");
  });

  /**
   * 入口は invisible のまま次の文書へ渡し、次の文書が出てくる (NHK と同じ形)。入口から出直すと
   * 入口の invisible で隠れ、データ放送が閉じたように見える
   */
  function hiddenEntry(target: string): [string, string, string][] {
    return [
      [
        "startup.bml",
        "text/X-arib-bml",
        `<?xml version="1.0" encoding="EUC-JP"?>
<bml><head><title>t</title><script><![CDATA[function start() { browser.launchDocument("menu.bml", "cut"); }]]></script></head>
<body style="resolution:960x540" invisible="invisible" onload="start();"></body></bml>`,
      ],
      bmlFile(
        "menu.bml",
        "",
        `function start() {
                    var r = browser.launchDocument("${target}", "cut");
                    browser.Ureg[1] = "" + r;
                    browser.Ureg[2] = browser.getActiveDocument();
                }`,
      ),
    ];
  }

  for (const [what, target, message] of [
    [
      "双方向がオフで通信の文書 (https://)",
      "https://www.example.com/a.bml",
      "双方向がオフ",
    ],
    [
      "双方向がオフで通信の文書 (http://)",
      "http://www.example.com/a.bml",
      "双方向がオフ",
    ],
    [
      "別の局の文書 (arib-dc://)",
      "arib-dc://7fe1.7fe1.0401/40/0000/a.bml",
      "移れる文書の名前ではない",
    ],
    ["DII に無いモジュール", "/40/0005/a.bml", "モジュールが放送に無い"],
    ["PMT に無い部品", "/50/0000/a.bml", "モジュールが放送に無い"],
    ["ftp の文書", "ftp://www.example.com/a.bml", "移れる文書の名前ではない"],
  ] as const) {
    test(`${what}: 失敗 (NaN) を返し、今の文書のまま続きを動かす`, async () => {
      const visible: boolean[] = [];
      const { bml, logs } = open({ onVisible: (on) => visible.push(on) });
      feedAll(bml, [PROGRAM, ...carousel(hiddenEntry(target))]);
      const { done } = await watch(() => inside(bml).ureg[2] !== "");
      expect(done).toBe(true);
      expect(inside(bml).ureg[1]).toBe("NaN");
      expect(inside(bml).ureg[2]).toBe("/40/0000/menu.bml");
      // 少し待っても入口へ出直さない (出ている文書のまま)
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(bml.path).toBe("/40/0000/menu.bml");
      expect(visible.at(-1)).toBe(true);
      expect(
        logs.some((line) => line.includes(message) && line.includes(target)),
      ).toBe(true);
    });
  }

  /** 双方向をオンにして、決めた URL に決めたものを返す中継 (取りに来た URL を控える) */
  function relay(
    pages: Record<string, { status?: number; type: string; body: string }>,
  ) {
    const asked: string[] = [];
    const ip = {
      connected: () => true,
      transmit: async () => ({
        resultCode: 0,
        status: "",
        body: new Uint8Array(),
      }),
      confirm: async () => null,
      get: async (uri: string) => {
        asked.push(uri);
        const page = pages[uri];
        if (page === undefined) return null;
        return {
          status: page.status ?? 200,
          contentType: page.type,
          body: Uint8Array.from(Buffer.from(page.body, "latin1")),
        };
      },
    };
    return { ip, asked };
  }

  for (const [what, page] of [
    ["中継が断った", undefined],
    [
      "相手が 404",
      { status: 404, type: "text/X-arib-bml", body: "<bml></bml>" },
    ],
    [
      "BML でない (案内の HTML)",
      { type: "text/html", body: "<html><body>x</body></html>" },
    ],
  ] as const) {
    test(`双方向がオンで通信の文書が取れない (${what}): 失敗 (NaN) を返し、今の文書のまま`, async () => {
      const target = "https://www.example.com/a.bml";
      const { ip, asked } = relay(page === undefined ? {} : { [target]: page });
      const visible: boolean[] = [];
      const { bml } = open({ ip, onVisible: (on) => visible.push(on) });
      feedAll(bml, [PROGRAM, ...carousel(hiddenEntry(target))]);
      const { done } = await watch(() => inside(bml).ureg[2] !== "");
      expect(done).toBe(true);
      expect(asked).toEqual([target]);
      expect(inside(bml).ureg[1]).toBe("NaN");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(bml.path).toBe("/40/0000/menu.bml");
      expect(visible.at(-1)).toBe(true);
    });
  }
});

describe("通信の文書", () => {
  test("https の文書へ移り、中の相対の名前は文書の URL から取る。arib-dc:// で放送へ戻れる", async () => {
    const remote = bmlFile(
      "x",
      "",
      `function start() {
                browser.Ureg[1] = browser.getActiveDocument() + "|" + fromScript;
                browser.launchDocument("arib-dc://-1.-1.-1/40/0000/back.bml", "cut");
            }`,
    )[2].replace("<head>", '<head><script src="lib/app.js"></script>');
    const asked: string[] = [];
    const pages: Record<string, { type: string; body: string }> = {
      "https://www.example.com/d/menu.bml?x=1": {
        type: "text/X-arib-bml; charset=EUC-JP",
        body: remote,
      },
      "https://www.example.com/d/lib/app.js": {
        type: "text/plain",
        body: 'var fromScript = "js";',
      },
    };
    const { bml } = open({
      ip: {
        connected: () => true,
        transmit: async () => ({
          resultCode: 0,
          status: "",
          body: new Uint8Array(),
        }),
        confirm: async () => null,
        get: async (uri) => {
          asked.push(uri);
          const page = pages[uri];
          return page === undefined
            ? null
            : {
                status: 200,
                contentType: page.type,
                body: Uint8Array.from(Buffer.from(page.body, "latin1")),
              };
        },
      },
    });
    feedAll(bml, [
      PROGRAM,
      ...carousel([
        startup(
          "",
          'function start() { var r = browser.launchDocument("https://www.example.com/d/menu.bml?x=1#top", "cut"); browser.Ureg[3] = "" + r; }',
        ),
        bmlFile(
          "back.bml",
          "",
          "function start() { browser.Ureg[2] = browser.getActiveDocument(); }",
        ),
      ]),
    ]);
    const { done } = await watch(() => inside(bml).ureg[2] !== "");
    expect(done).toBe(true);
    expect(inside(bml).ureg[1]).toBe(
      "https://www.example.com/d/menu.bml?x=1|js",
    );
    expect(inside(bml).ureg[2]).toBe("/40/0000/back.bml");
    // 移ったので、入口の launchDocument の後は動いていない
    expect(inside(bml).ureg[3]).toBe("");
    expect(asked).toEqual([
      "https://www.example.com/d/menu.bml?x=1",
      "https://www.example.com/d/lib/app.js",
    ]);
  });
});

describe("lockModuleOnMemoryEx", () => {
  test("0x40・0x50・0x60 のほか (0x61 など) は NaN を返して知らせる", async () => {
    const { bml, logs } = open();
    const script = `function start() {
            browser.Ureg[1] = browser.lockModuleOnMemoryEx("/61/0000") + "," + browser.lockModuleOnMemoryEx("/40/0000");
        }`;
    feedAll(bml, carousel([startup("", script)]));
    const { done } = await watch(() => inside(bml).ureg[1] !== "");
    expect(done).toBe(true);
    expect(inside(bml).ureg[1]).toBe("NaN,1");
    expect(logs.some((line) => line.includes("/61/0000"))).toBe(true);
  });
});

/**
 * 常に受信している端末 (`DataBroadcast` の `receive`)。**開く前から入口を裏で動かすのは、自動起動の
 * 指定 (`auto_start_flag`) がある入口だけ**。開いたら (`open`) 始め、閉じたら (`reset`) 入口へ戻す
 */
describe("開く前の入口", () => {
  /** 入口の部品に自動起動の指定を付けた PMT に差し替える (`undefined` は記述子の無いもの) */
  function entry(auto: boolean | undefined): ResponseMessage[] {
    const [, ...rest] = carousel([startup("")]);
    return [
      {
        type: "pmt",
        components: [
          {
            pid: 0x140,
            componentId: 0x40,
            streamType: 0x0d,
            ...(auto === undefined
              ? {}
              : {
                  bxmlInfo: {
                    transmissionFormat: 0,
                    entryPointFlag: true,
                    entryPointInfo: {
                      autoStartFlag: auto,
                      documentResolution: 3,
                      useXML: false,
                      defaultVersionFlag: true,
                      independentFlag: true,
                      styleForTVFlag: false,
                      bmlMajorVersion: 1,
                      bmlMinorVersion: 0,
                    },
                  },
                }),
          },
        ],
      },
      ...rest,
    ];
  }
  const ENTRY_PATH = "/40/0000/startup.bml";

  test("自動起動の指定がある入口は、開く前から始める", async () => {
    const { bml } = open({ opened: () => false });
    feedAll(bml, [PROGRAM, ...entry(true)]);
    const { done } = await watch(() => bml.path === ENTRY_PATH);
    expect(done).toBe(true);
  });

  test("入口のモジュールが PMT より先に揃っても、PMT が来て指定が分かったら始める", async () => {
    const { bml } = open({ opened: () => false });
    const [pmt, ...rest] = entry(true);
    feedAll(bml, [PROGRAM, ...rest]);
    await watch(() => false, 50);
    expect(bml.path).toBeNull();
    feedAll(bml, [pmt!]);
    const { done } = await watch(() => bml.path === ENTRY_PATH);
    expect(done).toBe(true);
  });

  test("指定が無い入口は、開くまで始めない。開いたら始める", async () => {
    for (const auto of [false, undefined]) {
      let opened = false;
      const { bml } = open({ opened: () => opened });
      feedAll(bml, [PROGRAM, ...entry(auto)]);
      await watch(() => false, 50);
      expect(bml.path).toBeNull();
      opened = true;
      bml.open();
      const { done } = await watch(() => bml.path === ENTRY_PATH);
      expect(done).toBe(true);
    }
  });

  test("開いているものとして作ったエンジン (`opened` が無い) は、指定が無くても始める", async () => {
    const { bml } = open();
    feedAll(bml, [PROGRAM, ...entry(false)]);
    const { done } = await watch(() => bml.path === ENTRY_PATH);
    expect(done).toBe(true);
  });

  test("閉じたら入口から出直す。指定が無い入口は、閉じたら止めたまま", async () => {
    // 入口を読むたびに Ureg に1字足す (Ureg は局が替わらなければ残る)
    const counted = startup(
      "",
      'function start() { browser.Ureg[3] = browser.Ureg[3] + "s"; }',
    );
    let opened = true;
    const first = open({ opened: () => opened }).bml;
    feedAll(first, [
      PROGRAM,
      ...entry(true).slice(0, 1),
      ...carousel([counted]).slice(1),
    ]);
    expect((await watch(() => inside(first).ureg[3] === "s")).done).toBe(true);
    opened = false;
    first.reset();
    expect((await watch(() => inside(first).ureg[3] === "ss")).done).toBe(true);
    expect(first.path).toBe(ENTRY_PATH);

    let shown = true;
    const second = open({ opened: () => shown }).bml;
    feedAll(second, [PROGRAM, ...entry(false)]);
    expect((await watch(() => second.path === ENTRY_PATH)).done).toBe(true);
    shown = false;
    second.reset();
    await watch(() => false, 50);
    expect(second.path).toBeNull();
  });
});

describe("epgTune", () => {
  const script = `function start() {
        var r = browser.epgTune(target);
        browser.Ureg[1] = "after:" + r;
    }`;

  test("別の局は呼び手に任せ、受けられたら文書を閉じる (後のスクリプトは動かない)", async () => {
    const asked: Service[] = [];
    const { bml } = open({
      onTune: (service) => {
        asked.push(service);
        return true;
      },
    });
    feedAll(bml, [
      PROGRAM,
      ...carousel([
        startup("", `var target = "arib://7FE7.-1.0428"; ${script}`),
      ]),
    ]);
    const { done } = await watch(() => asked.length > 0 && bml.path === null);
    expect(done).toBe(true);
    expect(asked).toEqual([
      {
        originalNetworkId: 0x7fe7,
        transportStreamId: 0x7fe1,
        serviceId: 0x428,
      },
    ]);
    await watch(() => false, 50);
    expect(inside(bml).ureg[1]).toBe("");
    // 局が変わるまでに前の局のモジュールが届き直しても、入口から出直して選局をリクエストし直さない
    feedAll(
      bml,
      carousel(
        [startup("", `var target = "arib://7FE7.-1.0428"; ${script}`)],
        2,
      ),
    );
    await watch(() => false, 100);
    expect(asked.length).toBe(1);
    expect(bml.path).toBeNull();
  });

  test("呼び手が断る・呼び手がいない (録画) なら NaN を返して続ける", async () => {
    for (const onTune of [() => false, undefined]) {
      const { bml, logs } = open(onTune === undefined ? {} : { onTune });
      // BinaryTable の行から引いた値と同じ、ただの文字列
      feedAll(bml, [
        PROGRAM,
        ...carousel([
          startup("", `var target = "arib://7fe7.7fe7.428"; ${script}`),
        ]),
      ]);
      const { done } = await watch(() => inside(bml).ureg[1] !== "");
      expect(done).toBe(true);
      expect(inside(bml).ureg[1]).toBe("after:NaN");
      expect(bml.path).toBe("/40/0000/startup.bml");
      expect(logs.some((line) => line.includes("選局できません"))).toBe(true);
    }
  });

  test("今の局 (arib://-1.-1.-1) は呼び手に任せず入口から出直す", async () => {
    const asked: Service[] = [];
    const { bml } = open({ onTune: (service) => asked.push(service) > 0 });
    const restart = `var target = "arib://-1.-1.-1";
            function start() {
                browser.Ureg[2] = browser.Ureg[2] + "s";
                if (browser.Ureg[2] == "s") browser.epgTune(target);
            }`;
    feedAll(bml, [PROGRAM, ...carousel([startup("", restart)])]);
    // Ureg は局が替わらないので残る。2 回目の入口で止まる
    const { done } = await watch(
      () => inside(bml).ureg[2]?.endsWith("ss") === true,
    );
    expect(done).toBe(true);
    expect(asked).toEqual([]);
    expect(bml.path).toBe("/40/0000/startup.bml");
  });

  test("今の局が分からないまま -1 で書かれたら NaN", async () => {
    const { bml, logs } = open({ onTune: () => true });
    feedAll(
      bml,
      carousel([startup("", `var target = "arib://-1.-1.-1"; ${script}`)]),
    );
    const { done } = await watch(() => inside(bml).ureg[1] !== "");
    expect(done).toBe(true);
    expect(inside(bml).ureg[1]).toBe("after:NaN");
    expect(logs.some((line) => line.includes("今の局が分からない"))).toBe(true);
  });
});

describe("面の大きさと縦横比", () => {
  test("720x480 の 4v3 は 4:3、16v9 と 960x540 は 16:9 で知らせる", async () => {
    for (const [style, want] of [
      [
        "resolution:720x480;display-aspect-ratio:4v3",
        { width: 720, height: 480, aspect: "4:3" },
      ],
      ["resolution:720x480", { width: 720, height: 480, aspect: "16:9" }],
      [
        "resolution:960x540;display-aspect-ratio:4v3",
        { width: 960, height: 540, aspect: "16:9" },
      ],
    ] as const) {
      const planes: Plane[] = [];
      const { bml } = open({ onLoad: (plane) => planes.push(plane) });
      feedAll(
        bml,
        carousel([bmlFile("startup.bml", "", "function start() {}", style)]),
      );
      const { done } = await watch(() => planes.length > 0);
      expect(done).toBe(true);
      expect(planes[0]).toEqual(want);
    }
  });

  test("4:3 の面は高さを合わせて左右の真ん中、16:9 は枠いっぱい", () => {
    const box = { width: 1600, height: 900 };
    expect(planeArea(box, { aspect: "4:3" })).toEqual({
      left: 200,
      top: 0,
      width: 1200,
      height: 900,
    });
    expect(planeArea(box, { aspect: "16:9" })).toEqual({
      left: 0,
      top: 0,
      width: 1600,
      height: 900,
    });
    // 縦に長い枠では幅を合わせて上下の真ん中
    expect(planeArea({ width: 400, height: 900 }, { aspect: "4:3" })).toEqual({
      left: 0,
      top: 300,
      width: 400,
      height: 300,
    });
  });
});

describe("MNG", () => {
  test("コマを CLUT の色の PNG にして渡し、回し終えたら pause と最後のコマを書く", async () => {
    const { bml } = open();
    // 2 コマ・くり返し 1 回 (TERM 無し)
    const data = Buffer.from(sampleMng()).toString("latin1");
    feedAll(
      bml,
      carousel([
        startup(
          '<object id="o" type="image/X-arib-mng" data="a.mng" streamstatus="play" style="left:0px;top:0px;width:64px;height:32px"/>',
          'function start() { browser.Ureg[1] = "ready"; }',
        ),
        ["a.mng", "image/X-arib-mng", data],
      ]),
    );
    const { done } = await watch(() => inside(bml).ureg[1] === "ready");
    expect(done).toBe(true);
    const source = inside(bml).image("a.mng", "image/x-arib-mng");
    expect(source?.animation?.frames.length).toBe(2);
    expect(source?.animation?.iterations).toBe(1);
    expect(source?.url).toBe(source?.animation?.frames[0]?.url ?? "");
    // 同じ文書のうちは作り直さない
    expect(inside(bml).image("a.mng", "image/x-arib-mng")).toBe(source);
  });
});

describe("ライブのように流し続けても、持つものと握る時間が一定に収まる", () => {
  /** 入口の部品のモジュール 1 つ */
  const moduleOf = (
    id: number,
    version: number,
    files: [string, string, string][],
  ): ResponseMessage => ({
    type: "moduleDownloaded",
    componentId: 0x40,
    moduleId: id,
    version,
    dataEventId: 1,
    files: files.map(([name, type, body]) => {
      const [major = "text", minor = "plain"] = type.split("/");
      return {
        contentLocation: name,
        contentType: media(major, minor),
        dataBase64: Buffer.from(body, "latin1").toString("base64"),
      };
    }),
  });
  const diiOf = (modules: [number, number][]): ResponseMessage => ({
    type: "moduleListUpdated",
    componentId: 0x40,
    modules: modules.map(([id, version]) => ({ id, version, size: 1 })),
    dataEventId: 1,
  });
  const eventOf = (id: number, version: number): ResponseMessage => ({
    type: "esEventUpdated",
    componentId: 0x40,
    dataEventId: 1,
    events: [
      {
        type: "immediateEvent",
        eventMessageGroupId: 0,
        timeMode: 0,
        eventMessageType: 0,
        eventMessageId: (id << 8) | version,
        privateDataByte: [0x41, 0x42],
      },
    ],
  });
  const PMT: ResponseMessage = {
    type: "pmt",
    components: [{ pid: 0x140, componentId: 0x40, streamType: 0x0d }],
  };

  /** 作った blob: の URL のうち、まだ返していないものを数える */
  function countUrls(): { live: () => number; restore: () => void } {
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    const made = new Set<string>();
    URL.createObjectURL = (
      object: Parameters<typeof URL.createObjectURL>[0],
    ) => {
      const url = create.call(URL, object);
      made.add(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      made.delete(url);
      revoke.call(URL, url);
    };
    return {
      live: () => made.size,
      restore: () => {
        URL.createObjectURL = create;
        URL.revokeObjectURL = revoke;
      },
    };
  }

  /** エンジンの中で、長く流すと増えうるもの */
  const engine = (bml: Bml) =>
    bml as unknown as {
      ureg: string[];
      queue: unknown[];
      timers: Map<number, unknown>;
      missingImages: Set<string>;
      reported: Set<string>;
      halted: boolean;
      resources: { cache: Map<string, unknown>; pending: unknown[] };
    };

  test("バージョンの更新・イベントメッセージ・TOT を何千回流しても、増え続けない", async () => {
    const urls = countUrls();
    try {
      // 見張りで止めずに、持つものだけを見る (流す速さはライブの何百倍)。時計はライブと同じ TOT
      const { bml, logs } = open({ clock: () => null, budget: { ratio: 1 } });
      // 本番の局の書き方に寄せる: 1 回きりのタイマーを受け手のたびに作り直す (chkRen)、
      // バージョンが上がったら押さえ直して字を書き換える、イベントのたびに消さないタイマーを足す (後始末し忘れ)
      const script = `var n = 0, m = 0;
                function start() { browser.setInterval("chk();", 1, 1); browser.Ureg[1] = "ready"; }
                function chk() { browser.setInterval("chk();", 1, 1); }
                function updated() {
                    n++;
                    browser.lockModuleOnMemory("/40/0001");
                    document.getElementById("t").firstChild.data = "u" + n;
                    browser.Ureg[2] = "" + n;
                }
                function locked() { browser.unlockModuleOnMemory("/40/0001"); }
                function fired() { m++; browser.Ureg[3] = "" + m; browser.setInterval("leak();", 100000, 0); }
                function leak() {}`;
      const body = `<object type="image/jpeg" data="/40/0001/img.jpg" style="left:0px;top:0px;width:100px;height:50px"/>
                <p id="t" style="left:0px;top:60px;width:200px;height:30px"></p>
                <bevent>
                <beitem id="u" type="ModuleUpdated" module_ref="/40/0001" subscribe="subscribe" onoccur="updated();"/>
                <beitem id="l" type="ModuleLocked" module_ref="/40/0001" subscribe="subscribe" onoccur="locked();"/>
                <beitem id="e" type="EventMessageFired" subscribe="subscribe" onoccur="fired();"/>
                </bevent>`;
      feedAll(bml, [
        PMT,
        diiOf([
          [0, 1],
          [1, 0],
        ]),
        moduleOf(0, 1, [startup(body, script)]),
        moduleOf(1, 0, [["img.jpg", "image/jpeg", "jpeg0"]]),
      ]);
      const { done } = await watch(() => engine(bml).ureg[1] === "ready");
      expect(done).toBe(true);

      let longest = 0;
      let last = performance.now();
      for (let round = 1; round <= 3000; round++) {
        const version = round & 0xff;
        feedAll(bml, [
          diiOf([
            [0, 1],
            [1, version],
          ]),
          moduleOf(1, version, [["img.jpg", "image/jpeg", `jpeg${round}`]]),
          eventOf(round % 200, version),
          // ライブは同じセクションが何度も来る
          eventOf(round % 200, version),
          {
            type: "currentTime",
            timeUnixMillis: Date.UTC(2026, 9, 12, 3) + round * 1000,
          },
        ]);
        if (round % 10 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          const now = performance.now();
          longest = Math.max(longest, now - last);
          last = now;
        }
      }
      await watch(() => false, 300);
      const inner = engine(bml);
      // ストリームは届いている (受け手が動いた)
      expect(Number(inner.ureg[2])).toBeGreaterThan(10);
      expect(Number(inner.ureg[3])).toBeGreaterThan(10);
      expect(inner.halted).toBe(false);
      expect(bml.path).toBe("/40/0000/startup.bml");
      // 持つものは一定
      expect(inner.queue.length).toBeLessThanOrEqual(MAX_QUEUE);
      expect(inner.timers.size).toBeLessThanOrEqual(MAX_TIMERS);
      expect(inner.resources.cache.size).toBeLessThanOrEqual(2);
      expect(inner.resources.pending.length).toBeLessThanOrEqual(1);
      expect(inner.missingImages.size).toBeLessThanOrEqual(1);
      expect(inner.reported.size).toBeLessThan(10);
      // 画像の URL は今のバージョンのぶんだけ (バージョンが上がるたびに返す)
      expect(urls.live()).toBeLessThanOrEqual(2);
      expect(logs.some((line) => line.includes("タイマーが"))).toBe(true);
      // 手が空かなかった間は短いまま (流し込む側の 10 回ぶんを含めて)
      expect(longest).toBeLessThan(200);
    } finally {
      urls.restore();
    }
  }, 120_000);

  test("受け手が届かないモジュールを待って止まっている間に来たイベントは、上限を超えたら捨てる", async () => {
    const { bml, logs } = open();
    // モジュール 2 は DII にあるが届かない。BinaryTable で待ったまま、次の受け手が動けない
    const script = `function start() {
                browser.Ureg[1] = "waiting";
                var t = new BinaryTable("/40/0002/x.bin", "0,U:1B");
                browser.Ureg[1] = "never";
            }
            function fired() {}`;
    const body =
      '<bevent><beitem id="e" type="EventMessageFired" subscribe="subscribe" onoccur="fired();"/></bevent>';
    feedAll(bml, [
      PMT,
      diiOf([
        [0, 1],
        [2, 1],
      ]),
      moduleOf(0, 1, [startup(body, script)]),
    ]);
    const { done } = await watch(() => engine(bml).ureg[1] === "waiting");
    expect(done).toBe(true);
    for (let i = 0; i < 4000; i++) bml.feed(eventOf(i % 250, (i >> 4) & 0xff));
    await watch(() => false, 100);
    expect(engine(bml).ureg[1]).toBe("waiting");
    expect(engine(bml).queue.length).toBeLessThanOrEqual(MAX_QUEUE);
    expect(
      logs.filter((line) => line.includes("溢れた分を捨てます")).length,
    ).toBe(1);
  });
});
