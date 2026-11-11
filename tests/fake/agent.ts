/**
 * 偽チューナーエージェント。denpa の E2E で、実チューナー無しに全体を動かす。
 *
 * **電波の組み立ては `broadcast.ts` に置いてある。** 同じものを本物の
 * エージェントにも渡しているため (`tune.ts`)。こちらが受け持つのは
 * 「denpa から見た API」だけで、取り合いもスキャンも本物らしく見えるだけの作り物。
 *
 * エージェント自身のふるまい (取り合い・止め方・スキャンの総当たり) は
 * ここでは試せない。それは `agent/conformance.test.ts` が本物に当てている。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { answerPairing, fakeAgentTls } from "../../src/lib/server/fake-agent";
import {
  broadcast,
  broadcastTlv,
  channels,
  DEFAULT_KNOBS,
  type Knobs,
  on,
  tsmfStreams,
} from "./broadcast";
import type { FakeService } from "./services";

/**
 * ポートは 2 つ。denpa が繋ぐのは TLS のほう (本物と同じく HTTPS で、合言葉で組む。`FAKE_AGENT_TLS_PORT`、既定は +1)。
 * 平文のほう (`FAKE_AGENT_PORT`) はテストが `/__control/...` を呼び、API の中身を確かめるため
 */
const PORT = Number(process.env["FAKE_AGENT_PORT"] ?? 25252);
const TLS_PORT = Number(process.env["FAKE_AGENT_TLS_PORT"] ?? PORT + 1);
/** denpa の元の TS の置き場。本物では同じものをエージェント側にも見せてある */
const RECORDED = resolve(process.env["RAW_DIR"] ?? "/media/raw");

/** テストから切り替えるつまみ。本物では `tune.ts` がファイル越しに読む */
const knobs: Knobs = {
  ...DEFAULT_KNOBS,
  scrambled: process.env["FAKE_SCRAMBLED"] === "1",
};
/** チューナーが塞がっている状態。取り合いの見え方を確かめる */
let busyTuners = false;
/**
 * 塞がっているチューナーの受信の状態と C/N と強度 (`GET /denpa/tuners` の `signal`。`POST /__control/signal` で変える)。
 * 本物は C/N が変わっても通知 (`tuners`) を出さないので、変えても出さない。画面は 5 秒ごとに読み直して追う
 */
type FakeSignal = {
  locked: boolean;
  cn: number | null;
  unit: "dB" | "raw";
  atTune: boolean;
  strengthDbm: number | null;
} | null;
const SIGNALS: Record<string, FakeSignal> = {
  // PIX-DT295 の地上波で実機に出た値のあたり
  raw: {
    locked: true,
    cn: 2748,
    unit: "raw",
    atTune: false,
    strengthDbm: null,
  },
  db: {
    locked: true,
    cn: 25.3,
    unit: "dB",
    atTune: false,
    strengthDbm: null,
  },
  strength: {
    locked: true,
    cn: 25.3,
    unit: "dB",
    atTune: false,
    strengthDbm: -35,
  },
  tune: {
    locked: true,
    cn: 18.2,
    unit: "dB",
    atTune: true,
    strengthDbm: null,
  },
  unlocked: {
    locked: false,
    cn: null,
    unit: "dB",
    atTune: false,
    strengthDbm: null,
  },
};
let busySignal: FakeSignal = SIGNALS["raw"] ?? null;
/** 挿さっているカードリーダー。どちらにもカードが入っている */
const CARD_READERS = [
  { name: "Fake Card Reader (usb 1-1)", ids: ["0000000000000000"] },
  { name: "Spare Card Reader (usb 1-2)", ids: ["0000000000000001"] },
];
/** 使わない設定のカードリーダー (`PUT /denpa/card/readers`) */
let cardsOff = new Set<string>();

/**
 * エージェントのログ (`GET /denpa/logs`)。本物と同じ形 (`{"lines":[{"at","text"}]}`。新しいほうから 2000 行まで、古い順)。
 * 中身は伏せる処理を確かめるための作り物で、カードの番号・IP アドレス・ホスト名と、伏せない番組名を混ぜてある。
 * `off` は答えを返せないエージェント (500)、`many` は URL の上限を確かめる長いログ。
 *
 * **伏せるものを含む行は、読まれた時点で出たばかりのエラーにしておく。** Issue の URL に入るログは
 * 警告とエラーを先に、それぞれ新しいほうから選ぶ (`#lib/issue-report.ts`)。同じワーカーで先に流れたテストが
 * サーバのログに警告を積んでいく (CS の番組表を集められない、など) ので、起動したときのふつうの行だと
 * URL から押し出され、伏せたかどうかを確かめられなかった
 */
let logsMode: "normal" | "off" | "many" = "normal";
const STARTED_AT = Date.now();

function agentLogLines(): { at: number; text: string }[] {
  if (logsMode === "many") {
    return Array.from({ length: 2000 }, (_, i) => ({
      at: STARTED_AT + i * 1000,
      text:
        i % 50 === 0
          ? `[agent] 偽チューナー${i}: 選局できません (信号がありません) 長い説明の行 ${"あ".repeat(60)}`
          : `[agent] 偽チューナー${i}: 受信中 ${"い".repeat(60)}`,
    }));
  }
  const now = Date.now();
  return [
    {
      at: STARTED_AT,
      text: "[agent] listening on :25252 (tuners: /config/tuners.json / channels: /config/channels.json)",
    },
    {
      at: now - 3,
      text: "[agent] カードとのやり取りに失敗しました。繋ぎ直します (Fake Card Reader (usb 1-1): カード 0123456789012345 が応えません)",
    },
    {
      at: now - 2,
      text: "[agent] 鍵を http://card-host.lan:40773 から受け取れません (相手: 192.168.10.20 に繋がりません)",
    },
    {
      at: now - 1,
      text: "[agent] GR T16 (rec 1 でんぱニュース): 選局できません (信号がありません)",
    },
  ];
}

/**
 * エージェント自身のこと (`GET /denpa/about`)。本物と同じ形 (agent/Denpa.Agent/About.cs)。
 * バージョンは本物のイメージと同じく `DENPA_VERSION` から (tests/stack.ts が denpa と同じものを渡す)。
 * `off` は答えを返せないエージェント (500)、`mac` は macOS のエージェントで、バージョンが denpa と違う
 */
let aboutMode: "normal" | "off" | "mac" = "normal";

function agentAbout() {
  if (aboutMode === "mac") {
    return {
      version: "v0.9.0",
      os: "macos",
      arch: "arm64",
      runtime: "Darwin 25.0.0 Darwin Kernel Version 25.0.0",
      ccidDriver: "apple",
    };
  }
  return {
    version: process.env["DENPA_VERSION"] ?? "dev",
    os: "linux",
    arch: "x64",
    runtime: "Linux 6.12.0-fake #1 SMP",
    ccidDriver: null,
  };
}

/**
 * 偽のスクランブルの復号。本物の復号はせず、4 バイト目の
 * transport_scrambling_control を落とすだけ。
 *
 * 本物と同じく、渡されるのは元の TS の置き場からの相対パス。
 */
function unscramble(
  input: string,
  output: string,
): { ok: boolean; error: string } {
  const from = resolve(RECORDED, input);
  const to = resolve(RECORDED, output);
  if (!from.startsWith(`${RECORDED}/`) || !to.startsWith(`${RECORDED}/`)) {
    return {
      ok: false,
      error: "元の TS の保存先の外にあるファイルは復号できません",
    };
  }
  if (!existsSync(from))
    return { ok: false, error: `${from} が見つかりません` };

  const buffer = readFileSync(from);
  for (let i = 0; i + 188 <= buffer.length; i += 188) buffer[i + 3]! &= 0x3f;
  writeFileSync(to, buffer);
  return { ok: true, error: "" };
}

/** 4K の局 (TLV) の搬送波か */
const isTlv = (services: FakeService[]) =>
  services.some((service) => service.transport === "tlv");

function fakeStream(
  signal: AbortSignal,
  services: FakeService[],
): ReadableStream<Uint8Array> {
  // 4K の局 (TLV) は TLV のバイト列を流す (本物は分割 TLV を組み立てたもの)。1 つの搬送波に TS と TLV は混ざらない
  const play = isTlv(services) ? broadcastTlv : broadcast;
  return new ReadableStream({
    start(controller) {
      const stop = play(
        services,
        () => knobs,
        (data) => {
          try {
            controller.enqueue(data);
          } catch {
            // 既に閉じている
          }
        },
      );
      signal.addEventListener("abort", () => {
        stop();
        try {
          controller.close();
        } catch {
          // 既に閉じていれば何もしない
        }
      });
    },
  });
}

interface FakeChannel {
  type: string;
  channel: string;
}

/** 種別の並び。知らない種別は後ろ (本物の `Config.TypeOrder`) */
const TYPE_ORDER: Record<string, number> = {
  GR: 0,
  BS: 1,
  CS: 2,
  CATV: 3,
  SKY: 4,
};

/** 本物が channels.json に書く順 (種別ごと、その中はチャンネルの文字の順。`Config.SaveChannels`) */
function sortChannels<T extends FakeChannel>(list: T[]): T[] {
  const order = (entry: FakeChannel) => TYPE_ORDER[entry.type] ?? 9;
  return list.sort((a, b) => {
    const byType = order(a) - order(b);
    if (byType !== 0) return byType;
    if (a.channel === b.channel) return 0;
    return a.channel < b.channel ? -1 : 1;
  });
}

/** 預かっているチャンネル。本物では channels.json (CATV と SKY はスキャンしたときだけ入る。`broadcast.channels`) */
const initialChannels = () => sortChannels(channels());
let saved = initialChannels();

/** チューナー。既定は全部空きにしておく */
interface FakeTuner {
  index: number;
  name: string;
  types: string[];
  disabled: boolean;
  device: string | null;
  lnb: string | null;
}

/** 挿してある機材 (本物の自動検出 `DeviceProbe.Detect` に当たるもの)。偶数が衛星、奇数が地上波 */
const plugged = (): FakeTuner[] =>
  [0, 1, 2, 3].map((index) => ({
    index,
    name: `adapter${index}`,
    types: index % 2 === 0 ? ["BS", "CS"] : ["GR"],
    disabled: false,
    device: `/dev/dvb/adapter${index}/frontend0`,
    lnb: null,
  }));

/** 始めは定義を書いてある状態にしておく (中身は挿してあるものと同じ) */
let TUNERS: FakeTuner[] = plugged();
/** 定義が無いので自分で見つけた機材を使っているか (`GET /denpa/tuners` の `detected`) */
let detected = false;

interface Lease {
  type: string;
  channel: string;
  users: { use: string; priority: number }[];
}

/** いま開いている選局。本物のプールに当たるもの */
const leases = new Map<number, Lease>();

/**
 * **開かれた記録。** 誰が、どの優先度 (`priority`) で取りに来たか。
 *
 * 使っている最中の見た目は一瞬で消える (偽エージェントは本物より速い) ので、
 * 「その優先度で取得した」ことを試験から確かめるには記録が要る
 * (`16-scan.spec.ts`)。溜め続けないよう直近だけ持つ
 */
const opens: {
  use: string;
  priority: number;
  type: string;
  channel: string;
}[] = [];
const OPENS_KEEP = 200;

function tunerStatus() {
  return TUNERS.map((plain) => {
    // 選ぶ順は定義の順 (下の `pick` は前から空きを取る)。無効なチューナーは使わないので null。
    // 名指しの目印はデバイス、無ければ名前 (本物の `TunerPool.PinKey`)
    const tuner = {
      ...plain,
      rank: plain.disabled ? null : plain.index,
      pin: plain.device ?? plain.name,
      /*
       * 機材が受けられる種別は、挿してある機材の種別。挿していないデバイスは分からない (本物の `DeviceProbe.Receivable`)。
       * `it930x:` の受信機は、挿していなくても地上波・衛星・ケーブル・SKY を受けられると返す (本物の `It930x.Types`)
       */
      receivable: plain.device?.startsWith("it930x:")
        ? ["GR", "BS", "CS", "CATV", "SKY"]
        : (plugged().find((one) => one.device === plain.device)?.types ?? null),
    };
    /*
     * 塞がっているのは**衛星のチューナー**にしてある。地上波を塞ぐと、
     * 同時に走っている局ロゴのテストが「地上波の空きが無い」で
     * 始められなくなる (偽エージェントは spec をまたいで共有)
     */
    if (busyTuners && tuner.index === 0) {
      return {
        ...tuner,
        channel: { type: "BS", channel: "BS11:18000" },
        users: [
          { use: "rec 1", priority: 10 },
          { use: "epg BS11:18000", priority: 3 },
        ],
        error: null,
        signal: busySignal,
      };
    }
    const lease = leases.get(tuner.index);
    return {
      ...tuner,
      channel:
        lease === undefined
          ? null
          : { type: lease.type, channel: lease.channel },
      users: lease?.users ?? [],
      error: null,
      // 偽の選局は機材を持たないので測れない (本物の偽の選局 `FAKE_TUNE` と同じ)
      signal: null,
    };
  });
}

/** 利用者ごとの止める関数。取り上げるときと引き継ぐときに、こちらからストリームを閉じる */
const kicks = new WeakMap<object, AbortController>();

/** 選局を空ける。そこにいた利用者のストリームを閉じる */
function vacate(index: number): void {
  const lease = leases.get(index);
  if (lease === undefined) return;
  leases.delete(index);
  for (const user of lease.users) kicks.get(user)?.abort();
}

/**
 * どのチューナーに載せるか (docs/agent.md「選ぶ順の約束」。`rank` は定義の順にしてある)。
 * 前から見て、受けられて次のどれかに当たる最初のチューナーを使う。
 *
 * - 空いているチューナー
 * - 引き継ぐ利用者 (`after`) しかいないチューナー。その利用者は正常に終わらせる
 * - 同じチャンネルを優先度の低い利用者しか読んでいないチューナー。選局し直さずに共有する (`join`)
 *
 * **空きが無ければ、自分より優先度の低い利用者しかいないチューナーを取り上げて使う** (約束の 2)。ライブが録画に
 * チューナーを取り上げられる場面 (`34-live-yield.spec.ts`) を作るため。本物は空きがあっても順の前のチューナーを取り上げるが、
 * ここでは**空きが無いときだけ**にしてある。偽エージェントは spec をまたいで共有で、空きがあるのに
 * 取り上げると、裏で回っている番組表の取得やロゴの取得の見え方まで変わる
 */
function pick(
  type: string,
  channel: string,
  priority: number,
  after: ReadonlySet<string>,
): { index: number; join: boolean } | null {
  // 無効なチューナーは使わない (`rank` が null のチューナー。本物の `TunerPool.Pick` も外す)
  const usable = TUNERS.filter(
    (tuner) =>
      !tuner.disabled &&
      tuner.types.includes(type) &&
      !(busyTuners && tuner.index === 0),
  );
  for (const tuner of usable) {
    const lease = leases.get(tuner.index);
    if (lease === undefined) return { index: tuner.index, join: false };
    const staying = lease.users.filter((u) => !after.has(u.use));
    if (staying.length === 0) {
      vacate(tuner.index);
      return { index: tuner.index, join: false };
    }
    if (
      lease.type === type &&
      lease.channel === channel &&
      staying.every((u) => u.priority < priority)
    ) {
      return { index: tuner.index, join: true };
    }
  }
  for (const tuner of usable) {
    const lease = leases.get(tuner.index);
    if (
      lease === undefined ||
      !lease.users.every((u) => after.has(u.use) || u.priority < priority)
    )
      continue;
    vacate(tuner.index);
    return { index: tuner.index, join: false };
  }
  return null;
}

/*
 * 起きたことを知らせるエンドポイント (SSE)。本物では `/denpa/events`。
 * denpa はこれを読んでチューナーの画面を更新し、局が入れ替わったら取り込み直す (`agent-events.ts`)
 */
const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();

function emit(name: string, data: unknown = {}): void {
  const chunk = new TextEncoder().encode(
    `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
  );
  for (const listener of listeners) {
    try {
      listener.enqueue(chunk);
    } catch {
      // 既に閉じている購読者。次の cancel で片付く
    }
  }
}

function eventStream(): Response {
  let self: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      self = controller;
      listeners.add(controller);
    },
    cancel() {
      listeners.delete(self);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function openStream(url: URL, signal: AbortSignal): Response {
  const type = url.searchParams.get("type") ?? "";
  const channel = url.searchParams.get("channel") ?? "";
  const use = url.searchParams.get("use") ?? "不明";
  const priority = Number(url.searchParams.get("priority") ?? 0);
  const after = new Set(url.searchParams.getAll("after"));
  if (type === "" || channel === "")
    return json({ error: "type と channel が必要です" }, 400);
  const services = on(type, channel);

  // 優先度が自分と同じか高い利用者が同じチャンネルを読んでいれば選局を共有 (約束の 3)。無ければ選ぶ
  let index = [...leases.entries()].find(
    ([, lease]) =>
      lease.type === type &&
      lease.channel === channel &&
      lease.users.some((u) => !after.has(u.use) && u.priority >= priority),
  )?.[0];
  if (index === undefined) {
    const picked = pick(type, channel, priority, after);
    if (picked === null)
      return json({ error: `${type} のチューナーに空きがありません` }, 409);
    index = picked.index;
    /*
     * **放送の無いチャンネルは、チューナーを取ってから選局に落ちる** (本物と同じ順)。1 バイトも送る前なので、
     * 理由を付けて 500 で返す (docs/agent.md「選局は、利用者が切るまで終わらない」)。
     * 空けたチューナー (取り上げた・引き継いだ相手) は戻らない。選局が無いまま空きになる
     */
    if (services.length === 0) {
      emit("tuners");
      const name = TUNERS[index]?.name ?? `adapter${index}`;
      return json(
        {
          error: `${name}: 同期しませんでした (電波が来ていないか、その周波数に放送がありません)`,
        },
        500,
      );
    }
    if (!picked.join) leases.set(index, { type, channel, users: [] });
  }
  const lease = leases.get(index) as Lease;
  const user = { use, priority };
  const kick = new AbortController();
  kicks.set(user, kick);
  lease.users.push(user);
  opens.push({ use, priority, type, channel });
  if (opens.length > OPENS_KEEP) opens.shift();
  emit("tuners");

  const at = index;
  // リクエストした側が閉じたときと、取り上げられた・引き継がれたとき
  const ended = AbortSignal.any([signal, kick.signal]);
  ended.addEventListener("abort", () => {
    lease.users = lease.users.filter((u) => u !== user);
    // 取り上げられた・引き継がれたあとのチューナーは別の選局が使っている。そちらは消さない
    if (lease.users.length === 0 && leases.get(at) === lease) leases.delete(at);
    emit("tuners");
  });

  // TSMF で束ねた搬送波は、束ねた TS の数をヘッダーで返す (本物の `Sink.TsmfStreamsHeader`)。TLV は Content-Type で言う (本物の `StreamFormat`)
  const streams = tsmfStreams(type, channel);
  return new Response(fakeStream(ended, services), {
    headers: {
      "Content-Type": isTlv(services) ? "application/x-arib-tlv" : "video/MP2T",
      ...(streams === null ? {} : { "X-Denpa-Tsmf-Streams": String(streams) }),
    },
  });
}

const options: Bun.ServeOptions = {
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  fetch(request) {
    const url = new URL(request.url);

    // --- テスト用のエンドポイント -------------------------------------------------
    if (url.pathname === "/__control/logs" && request.method === "POST") {
      const mode = url.searchParams.get("mode");
      logsMode = mode === "off" || mode === "many" ? mode : "normal";
      return json({ mode: logsMode });
    }
    if (url.pathname === "/__control/about" && request.method === "POST") {
      const mode = url.searchParams.get("mode");
      aboutMode = mode === "off" || mode === "mac" ? mode : "normal";
      return json({ mode: aboutMode });
    }
    if (url.pathname === "/__control/tuners" && request.method === "POST") {
      busyTuners = url.searchParams.get("busy") === "1";
      emit("tuners");
      return json({ busy: busyTuners });
    }
    // 預かっているチャンネルを始めの顔ぶれに戻す。スキャンで足した SKY を、後のファイルに残さないため
    if (url.pathname === "/__control/channels" && request.method === "POST") {
      saved = initialChannels();
      emit("channels");
      return json(saved);
    }
    if (url.pathname === "/__control/signal" && request.method === "POST") {
      busySignal = SIGNALS[url.searchParams.get("value") ?? ""] ?? null;
      return json({ signal: busySignal });
    }
    /*
     * 放送の延長。ここを動かすと EIT[p/f] の終了時刻が後ろへ動く。
     * 本物では野球が延びたときに放送局が書き換えるところ
     */
    if (url.pathname === "/__control/extend" && request.method === "POST") {
      knobs.extendedMs = Number(url.searchParams.get("ms") ?? 0);
      return json({ ok: true, extendedMs: knobs.extendedMs });
    }
    /* EIT[p/f] を止める。延長に追従できない局の見え方を確かめる */
    if (url.pathname === "/__control/onair" && request.method === "POST") {
      knobs.noPresentFollowing = url.searchParams.get("silent") === "1";
      return json({ ok: true, noPresentFollowing: knobs.noPresentFollowing });
    }
    if (url.pathname === "/__control/listeners")
      return json({ listeners: listeners.size });
    /* 取りに来た記録。**使っている一瞬を待たずに確かめるため** */
    if (url.pathname === "/__control/opens") return json({ opens });
    /*
     * **繋ぎを壊す。Pod を入れ替えたのと同じ形。**
     *
     * 接続ごと落として、その場で立て直す。読んでいる側には
     * `The socket connection was closed unexpectedly` が飛ぶ。本物で
     * エージェントの Pod が入れ替わったときと同じ壊れ方。
     *
     * **ストリームを `controller.error()` で壊すのでは足りない。** それだと
     * 利用者には EOF として届き (実測)、denpa は前から取り直せていた。
     * 直したかったのは例外で切れたほうなので、本当に接続を壊す。
     *
     * この応答を返しきってから壊す (返す前に壊すと、リクエストした側が結果を
     * 受け取れない)
     */
    if (url.pathname === "/__control/cut" && request.method === "POST") {
      setTimeout(() => {
        server.stop(true);
        server = Bun.serve(options);
        secure.stop(true);
        secure = Bun.serve(secureOptions);
      }, 50);
      return json({ cut: true });
    }
    if (url.pathname === "/__control/scrambled" && request.method === "POST") {
      knobs.scrambled = url.searchParams.get("on") === "1";
      return json({ scrambled: knobs.scrambled });
    }
    // カードは読めているが局の契約が無い (`Knobs.unentitled`)
    if (url.pathname === "/__control/unentitled" && request.method === "POST") {
      knobs.unentitled = url.searchParams.get("on") === "1";
      return json({ unentitled: knobs.unentitled });
    }
    // 選局した直後に表を流さない (`Knobs.tablesLate`)
    if (
      url.pathname === "/__control/tables-late" &&
      request.method === "POST"
    ) {
      knobs.tablesLate = url.searchParams.get("on") === "1";
      return json({ tablesLate: knobs.tablesLate });
    }
    // PMT に字幕の ES を載せるか (`Knobs.captions`)
    if (url.pathname === "/__control/captions" && request.method === "POST") {
      knobs.captions = url.searchParams.get("on") === "1";
      return json({ captions: knobs.captions });
    }
    /*
     * コピー禁止。番組表で禁止と言う局 (`eit` に service_id をカンマ区切り。空なら無し) と、
     * 流れているもの (`pmt=1`) を別々に切り替える
     */
    if (url.pathname === "/__control/copy-never" && request.method === "POST") {
      knobs.eitCopyNever = (url.searchParams.get("eit") ?? "")
        .split(",")
        .filter(Boolean)
        .map(Number);
      knobs.pmtCopyNever = url.searchParams.get("pmt") === "1";
      return json({ eit: knobs.eitCopyNever, pmt: knobs.pmtCopyNever });
    }

    // --- 本物と同じエンドポイント -------------------------------------------------
    if (url.pathname === "/denpa/stream")
      return openStream(url, request.signal);
    if (url.pathname === "/denpa/events") return eventStream();
    if (url.pathname === "/denpa/tuners" && request.method === "GET") {
      return json({ tuners: tunerStatus(), detected });
    }
    if (url.pathname === "/denpa/tuners" && request.method === "PUT") {
      return request.json().then((body: { tuners?: unknown }) => {
        if (!Array.isArray(body.tuners))
          return json({ error: "tuners が必要です" }, 400);
        const list = body.tuners as Partial<FakeTuner>[];
        if (list.some((t) => typeof t?.name !== "string" || t.name === "")) {
          return json({ error: "name の無いチューナーがあります" }, 400);
        }
        // **空なら定義を消す = 自動検出に戻す** (本物の `Config.SaveTuners`)
        detected = list.length === 0;
        TUNERS = detected
          ? plugged()
          : list.map((tuner, index) => ({
              index,
              name: tuner.name as string,
              types: tuner.types ?? [],
              disabled: tuner.disabled === true,
              device: tuner.device ?? null,
              lnb: tuner.lnb ?? null,
            }));
        leases.clear();
        emit("tuners");
        return json({ tuners: tunerStatus(), detected });
      });
    }
    if (url.pathname === "/denpa/channels" && request.method === "GET")
      return json(saved);
    if (url.pathname === "/denpa/channels" && request.method === "PUT") {
      // 中身を作るのは denpa。こちらは預かって配るだけ。断り方と並べ方は本物と同じ
      return request
        .json()
        .then((body: { channels?: unknown; scanned?: unknown }) => {
          if (
            !Array.isArray(body.channels) ||
            !Array.isArray(body.scanned) ||
            body.scanned.length === 0
          ) {
            return json({ error: "channels と scanned が必要です" }, 400);
          }
          // 1 件も無いまま上書きすると、今まで録れていた局まで消える
          if (body.channels.length === 0)
            return json({ error: "チャンネルが 1 件もありません" }, 400);
          const scanned = body.scanned as string[];
          saved = sortChannels([
            ...saved.filter((c) => !scanned.includes(c.type)),
            ...(body.channels as typeof saved),
          ]);
          emit("channels");
          return json(saved);
        });
    }
    if (url.pathname === "/denpa/channels" && request.method === "DELETE") {
      // 1 つの種別を全部消す (本物は agent/Denpa.Agent/Program.cs。設定の画面の「局を削除」から)
      const type = url.searchParams.get("type") ?? "";
      if (type === "") return json({ error: "type が必要です" }, 400);
      saved = saved.filter((c) => c.type !== type);
      emit("channels");
      return json(saved);
    }

    // 使わないカードリーダーを入れ替える (本物は agent/Denpa.Agent/CardChoice.cs)
    if (url.pathname === "/denpa/card/readers" && request.method === "PUT") {
      return request.json().then((body: { disabled: string[] }) => {
        cardsOff = new Set(body.disabled);
        return json({ disabled: [...cardsOff].sort() });
      });
    }
    if (url.pathname === "/denpa/card") {
      /*
       * 本物と同じ形 (agent/Denpa.Agent/Card.cs)。**予備のリーダーも 1 つ置く。**
       * 使うのは 1 枚だけで、チューナーが並ぶのは使用中の行だけ、を画面で確かめる。
       * 使わない設定のリーダーは開かずに後ろへ並べ、使うのは残りの先頭
       */
      if (knobs.scrambled) {
        return json({
          ok: false,
          message: "カードリーダーが見つかりません",
          source: "local",
          readers: [],
        });
      }
      const on = CARD_READERS.filter((reader) => !cardsOff.has(reader.name));
      const off = CARD_READERS.filter((reader) => cardsOff.has(reader.name));
      return json({
        ok: on.length > 0,
        message:
          on.length > 0
            ? ""
            : "使うカードリーダーがありません。カードリーダーをオンにしてください",
        source: "local",
        readers: [
          ...on.map((reader, at) => ({
            ...reader,
            card: true,
            active: at === 0,
            tuners: at === 0 ? ["Fake-T1"] : [],
            disabled: false,
          })),
          ...off.map((reader) => ({
            name: reader.name,
            card: false,
            ids: [],
            active: false,
            tuners: [],
            disabled: true,
          })),
        ],
      });
    }
    if (url.pathname === "/denpa/card/confirm" && request.method === "POST") {
      return request
        .json()
        .then((body: { verification?: string; date?: number }) => {
          if (!body.verification || body.date === undefined) {
            return json({ error: "verification と date が必要です" }, 400);
          }
          return json({ ok: true, code: 0x0800 });
        });
    }
    if (url.pathname === "/denpa/logs" && request.method === "GET") {
      if (logsMode === "off") return new Response("failed", { status: 500 });
      return json({ lines: agentLogLines() });
    }
    if (url.pathname === "/denpa/about" && request.method === "GET") {
      if (aboutMode === "off") return new Response("failed", { status: 500 });
      return json(agentAbout());
    }
    if (url.pathname === "/denpa/decode" && request.method === "POST") {
      return request
        .json()
        .then((body: { input: string; output: string }) =>
          json(unscramble(body.input, body.output)),
        );
    }
    return new Response("not found", { status: 404 });
  },
};

let server = Bun.serve(options);

/** denpa が繋ぐほう。組む受け答え (`POST /denpa/pair`) を前に挟むだけで、中身は平文のほうと同じ */
const secureOptions: Bun.ServeOptions = {
  ...options,
  port: TLS_PORT,
  tls: fakeAgentTls(),
  async fetch(request, srv) {
    return (
      (await answerPairing(request)) ?? options.fetch.call(srv, request, srv)
    );
  },
};
let secure = Bun.serve(secureOptions);

console.log(`fake tuner agent listening on :${PORT} (TLS :${TLS_PORT})`);
