/**
 * 偽の放送。**実チューナー無しで「電波」を作る。**
 *
 * ここが持つのは組み立てだけで、誰に配るかは知らない。使う先が2つあるため。
 *
 * - `tests/fake/tune.ts` … 選局コマンドの代わり。**本物のエージェント**に食わせる
 * - `tests/fake/agent.ts` … 偽エージェント。denpa の E2E で使う
 *
 * 番組も局名もJSONでは配らない。EIT と SDT を組み立てて電波に乗せる
 * (`packages/arib/src/synth.ts`)。こうしておかないと、denpa 側の解析が通っているか
 * どうかをテストで確かめられない。
 */

import { CLOCK } from "@danything/arib/pes";
import {
  aitSection,
  aitSignallingDescriptor,
  copyControlDescriptor,
  ddbSection,
  diiSection,
  eitSection,
  logoModule,
  nitSection,
  packetize,
  patSection,
  pmtSection,
  programMap,
  sdtSection,
  type SynthEvent,
  withCrc,
} from "@danything/arib/synth";
import {
  AUDIO_TICKS,
  FRAME_TICKS,
  mpeg2Frame,
  packetizePes,
  pes,
  silentAac,
} from "@danything/arib/synth-av";

import { docsColor, docsLogo, docsProgram } from "./docs";
import { type FakeService, SERVICES } from "./services";

/** スクリーンショットを撮るための作り物の放送 (`tests/fake/docs.ts`)。番組とロゴもそちらに差し替える */
const DOCS = process.env["FAKE_PROFILE"] === "docs";

/**
 * 放送に乗るのと同じ形式のロゴ (実機の地上波から取得した 48x24)。
 *
 * 8bit のパレット PNG だが、**色の表 (PLTE/tRNS) が入っていない。** ARIB では
 * 色が決め打ちなので送らない決まりで、受け取った側が入れて初めて画像になる。
 * ここを普通の PNG にしてしまうと、その入れ直しが抜けていても気づけない
 */
const LOGO_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAADAAAAAYCAMAAACLI47uAAAAo0lEQVR42r2SSwrDMAxE49UcSbOwwPc/VUcJLYXa8WRTIYwNevqMfLSHdvwfCGQgMlsm0YktkEAXAIAERuyBTCi3zqK4ByoxO1oOXQPcz1Ael58vT6XgbzM3AAfK6AJSBzX7lJgAofC4BPYAFTj71/bCArSHtrYp0HV2TWFXKGCl07IlkmkCn6HdCl+yekCVGOfiXKCxguuTu8D784Un6709Bl72jh+i3qzvNQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/**
 * 大きいほうのロゴ (logo_type 0x05 = 64x36)。こちらは作り物の市松模様。
 *
 * **寸法は本物どおりにする。** denpa は置いてある PNG の寸法からロゴの種類を見分ける
 * (`logoTypeOfPng`)。48x24 を 0x05 と名乗って流していた頃は、「まだ小さいものしか
 * 持っていない」と見られて地上波の定期チェックがいつまでも閉じなかった。
 * 色の表が入っていないのは上と同じ
 */
const LOGO_PNG_LARGE = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAkCAMAAAAO0sygAAAANElEQVR42mNgpBAwDBMDOIAAJsABBcTyh4sB5GiEsUcNGD4GjOaFUQNG88KoAcOoeqcEAAAsSR5xqyZZeQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/** 番組表を埋める長さ。1日より少し長く (30時間) とる。局ごとの尺に応じて増やす */
const DAY = 30 * 60 * 60 * 1000;

const TITLES = [
  "テスト番組A",
  "テスト番組B 「初回放送」",
  "テストアニメ #12 決戦",
  "ニュース",
  "テスト番組C",
];

/**
 * テストから切り替えるつまみ。
 *
 * 偽エージェントは自分の中に持てばいいが、選局コマンドは**別プロセス**なので
 * ファイル越しに渡す (`FAKE_CONTROL`)。持ち方が違うだけで中身は同じ。
 */
export interface Knobs {
  /** カードが読めていない状態。掛かったままの TS を流す */
  scrambled: boolean;
  /** 放送の延長。EIT[p/f] の尺にこれを足す */
  extendedMs: number;
  /** EIT[p/f] を流さない。延長に追従できない局の見え方を確かめる */
  noPresentFollowing: boolean;
  /**
   * **番組表 (EIT) でコピー禁止と言う局** (service_id)。その局の全番組に、コピー禁止の
   * デジタルコピー制御記述子を載せる。予約の時点で「録画しない」になるのを確かめる。
   * 局を絞るのは、同じワーカーのほかの試験が使う局 (MX・BS) を巻き込まないため
   */
  eitCopyNever: number[];
  /**
   * **PMT でコピー禁止と言う。** 番組表は言わないまま、流れているものだけが禁止になる
   * (番組表が古い・無いときの備えを確かめる。録り始めてから保存を止める)
   */
  pmtCopyNever: boolean;
  /**
   * **選局した直後に表 (PAT・PMT) を流さない。** 次に流れてくる 1 秒後まで、どの PID が局のものか分からない。
   * 本物の電波は PAT・PMT を 100ms ごとに流すので、選局したては映像と音声が先に届く (`ServiceFilter` が取っておく)
   */
  tablesLate: boolean;
}

export const DEFAULT_KNOBS: Knobs = {
  scrambled: false,
  extendedMs: 0,
  noPresentFollowing: false,
  eitCopyNever: [],
  pmtCopyNever: false,
  tablesLate: false,
};

/** その局の番組。つまみ (`eitCopyNever`) に入っている局なら、コピー禁止の印を付ける */
const programsWith = (service: FakeService, knobs: Knobs): SynthEvent[] =>
  knobs.eitCopyNever.includes(service.serviceId)
    ? programsFor(service).map((event) => ({ ...event, copyControl: 0b11 }))
    : programsFor(service);

/** 1枠の本数。E2E では短くして「数秒後に始まる番組」を作る */
const SLOTS = Number(process.env["FAKE_SLOTS"] ?? 60);

/** 局のロゴ。スクリーンショットを撮るときは局ごとに作った作り物、テストは上の2枚 */
const logoOf = (service: FakeService, large: boolean): Uint8Array =>
  DOCS
    ? docsLogo(service, large ? 64 : 48, large ? 36 : 24)
    : large
      ? LOGO_PNG_LARGE
      : LOGO_PNG;

function programsFor(service: FakeService): SynthEvent[] {
  const slotMs = service.slotMs;
  /*
   * 番組表(4時〜翌4時)が埋まるだけの本数を出す。短い尺の局は本数で稼ぐと多すぎるので上限を切る。
   *
   * 番組を出さない局もある (`noPrograms`)。**その局の番組表がまだ集まっていない状態**は
   * 本物でも普通に起きる。ロゴの中継まわりを見るためだけに置いてある局にまで
   * 番組を生やすと、他のテストが数えている本数がずれる
   */
  const count =
    service.noPrograms === true
      ? 0
      : DOCS
        ? Math.ceil((2 * DAY) / slotMs)
        : Math.max(SLOTS, Math.min(600, Math.ceil(DAY / slotMs)));
  // 作れる本数で覆える幅。尺が短い局は本数の上限で頭打ちになる
  const span = Math.min(DAY, count * slotMs);
  /*
   * 少し過去から始める。全部を過去にすると予約できる番組が1つも無くなる。
   * スクリーンショットを撮るときは前後 30 時間ずつ — いつ撮っても、その日の番組表 (4時〜翌4時) が頭から埋まる
   */
  const base =
    Math.floor((Date.now() - (DOCS ? DAY : span / 3)) / slotMs) * slotMs;
  const programs: SynthEvent[] = [];
  for (let i = 0; i < count; i++) {
    const startAt = base + i * slotMs;
    const slot = startAt / slotMs;
    programs.push({
      // 枠番号から決めるので取得のたびにIDが変わらない
      eventId: slot % 65536,
      startAt,
      duration: slotMs,
      isFree: true,
      name: `${TITLES[(slot + service.serviceId) % TITLES.length]}`,
      description: `${service.name} のテスト番組 (slot ${slot})`,
      // 詳細は見出し付き。番組名にも概要にも出てこない語を入れておく
      // (ルールの「当てる範囲」を切り替えたときの違いを見るため)
      extended: {
        出演者: "ゲスト太郎 山田花子",
        番組内容: `${service.name} の詳細`,
      },
      /*
       * **同じ分類を2つ入れておく。** 本物の放送がそうなっている —
       * 実機の NHK の高校野球中継が `[スポーツ, 拡張, 拡張]` で、0xE (拡張) は
       * 分類ではなく局が自分で決めた符号を載せる枠なので、同じものが並ぶ。
       *
       * 1つずつしか入れていなかった頃は、**同じラベルが2つ並ぶと画面が落ちる**のに
       * 気付けなかった (詳細が開かなくなる。実機で1番組だけ開かなかった)
       */
      genres: [
        [7, 0],
        [14, 0],
        [14, 0],
      ],
      /*
       * **音声を2本にしておく。** 本物にもよくある構成で (解説放送・二重音声)、
       * どちらも `component_type=3` の日本語なので、**符号だけでは
       * 「ステレオ (日本語)」が2つ並ぶ**。見分けが付くのは放送が付けた
       * 名前だけ — 実機の日テレ「金曜ロードショー[解]」がまさにこれで、
       * 番組表の詳細に同じラベルが2つ出ていた
       */
      audios: [
        { type: 3, text: "主音声ステレオ" },
        { type: 3, text: "解説ステレオ", main: false },
      ],
      video: [0x01, 0xb1],
      ...(DOCS ? docsProgram(service, slot) : {}),
    });
  }
  return programs;
}

/** その物理チャンネルに入っている局 */
export function on(type: string, channel: string): FakeService[] {
  return SERVICES.filter((s) => s.type === type && s.channel === channel);
}

const serviceOf = (service: FakeService) => ({
  serviceId: service.serviceId,
  serviceType: service.serviceType,
  name: service.name,
});

const channelOf = (service: FakeService) => ({
  type: service.type,
  channel: service.channel,
  networkId: service.networkId,
  transportStreamId: service.networkId,
  remoteControlKeyId: service.type === "GR" ? (service.remoteKey ?? 9) : null,
  services: [serviceOf(service)],
});

/** 物理チャンネルの一覧。本物はスキャンの結果 (channels.json) */
export function channels() {
  const map = new Map<string, ReturnType<typeof channelOf>>();
  for (const service of SERVICES) {
    const key = `${service.type}:${service.channel}`;
    const found = map.get(key);
    if (found === undefined) map.set(key, channelOf(service));
    else found.services.push(serviceOf(service));
  }
  return [...map.values()];
}

/**
 * 番組表をセクションに割る。
 *
 * 1セクションは 4093 バイトまでなので、10 番組ずつに切る。
 * **セグメント (8セクション) の切れ目まで面倒を見る** — denpa は
 * `segment_last_section_number` を見て「もう来ない番号」を判断するので、
 * ここが嘘だと永久に揃わない。`tableId` は自局が 0x50、ほかの TS の局 (EIT[schedule other]) が 0x60
 */
function scheduleSections(
  service: FakeService,
  events: SynthEvent[],
  tableId = 0x50,
): Uint8Array[] {
  const groups: SynthEvent[][] = [];
  for (let at = 0; at < events.length; at += 10)
    groups.push(events.slice(at, at + 10));
  if (groups.length === 0) groups.push([]);

  const last = groups.length - 1;
  return groups.map((chunk, index) =>
    eitSection({
      tableId,
      serviceId: service.serviceId,
      transportStreamId: service.networkId,
      originalNetworkId: service.networkId,
      sectionNumber: index,
      lastSectionNumber: last,
      // このセグメントで実際に使っている最後の番号
      segmentLastSectionNumber: Math.min((index & ~7) + 7, last),
      lastTableId: tableId,
      events: chunk,
    }),
  );
}

/** いま流れている番組。EIT[p/f] に載せる */
function present(events: SynthEvent[]): SynthEvent | undefined {
  const at = Date.now();
  return events.find(
    (event) => event.startAt <= at && at < event.startAt + event.duration,
  );
}

/**
 * 中身のパケットを並べる。
 *
 * 本物である必要はないが、ヘッダだけは本物らしくしておく。
 * 全部を 0x47 で埋めると 4バイト目の上位2ビットが立ち、denpa の
 * スクランブル判定が「掛かっている」と誤って読む。
 */
function payload(pid: number, count: number, scrambled: boolean): Uint8Array {
  const buffer = new Uint8Array(188 * count);
  for (let i = 0; i < count; i++) {
    const at = i * 188;
    buffer[at] = 0x47;
    buffer[at + 1] = (pid >> 8) & 0x1f;
    buffer[at + 2] = pid & 0xff;
    // 上位2ビットが transport_scrambling_control、下位が adaptation/continuity
    buffer[at + 3] = scrambled ? 0x90 : 0x10;
    buffer.fill(0xff, at + 4, at + 188);
  }
  return buffer;
}

/** 局ごとの PID。実機と同じで、局ごとに別の値が振られている */
const pidsOf = (index: number) => ({
  pmt: 0x1000 + index * 0x10,
  video: 0x1001 + index * 0x10,
  audio: 0x1002 + index * 0x10,
  /** Hybridcast の在り処 (AIT)。載せている局だけ使う */
  ait: 0x1003 + index * 0x10,
});

/**
 * ロゴのカルーセル (衛星)。**地上波とは伝送方式が違う。**
 *
 * CDT には載らず、データカルーセル (DSM-CC) で流れてくる。PAT →
 * エンジニアリングサービス (929) の PMT → component_tag 0x79 の ES →
 * DII → DDB と辿らないと取得できないので、そこまで作る。本物と同じ道筋にして
 * おかないと、テストだけ通って現物では永久に集まらない。
 *
 * **PAT と PMT は `tables()` のほうに載せる。** 中継にあるかどうかは PAT を
 * 見た時点で決まる (denpa は外れの中継をそこで見切る) ので、あとから別の PAT を
 * 流すと「無いと分かったのにあとから出てくる」ことになる
 */
const ENGINEERING = { service: 929, pmt: 0x1f0, es: 0x1f1 };

function carouselPackets(services: FakeService[]): Uint8Array {
  /*
   * テストは1枚を全局で使い回す。スクリーンショットを撮るときは局ごとに別の画像 (番組表に並ぶので見分けが付くように)
   */
  const module = logoModule(
    0x05,
    DOCS
      ? services.map((s) => ({
          logoId: s.serviceId % 512,
          services: [[s.networkId, s.serviceId] as [number, number]],
          data: logoOf(s, true),
        }))
      : [
          {
            logoId: services[0]!.serviceId % 512,
            services: services.map(
              (s) => [s.networkId, s.serviceId] as [number, number],
            ),
            data: LOGO_PNG_LARGE,
          },
        ],
  );
  return Uint8Array.from([
    ...packetize(
      ENGINEERING.es,
      diiSection(0x1234, 4066, {
        moduleId: 1,
        moduleSize: module.length,
        moduleVersion: 1,
        name: "LOGO-05",
      }),
    ),
    ...packetize(ENGINEERING.es, ddbSection(0x1234, 1, 1, 0, module)),
  ]);
}

/** 局ロゴ (地上波)。CDT に実体、SDT にどの局のものかが分かれて流れてくる */
function logoPackets(service: FakeService): Uint8Array {
  const be = (value: number) => [(value >> 8) & 0xff, value & 0xff];
  const logoId = service.serviceId % 512;

  /*
   * **小さいもの (0x00) を先に、大きいもの (0x05) をあとに流す。** 本物の局も6種類を
   * 順に流していて、どれが先に来るかは運。最初に来た1つで閉じていた頃は、実機の
   * 地上波26局が小さいロゴのまま並んでいた
   */
  const cdt = (logoType: number, data: Uint8Array) =>
    withCrc([
      0xc8,
      0x00,
      0x00,
      ...be(service.networkId),
      0xc1,
      0x00,
      0x00,
      ...be(service.networkId),
      0x01,
      ...be(0xf000),
      logoType,
      ...be(logoId),
      ...be(1),
      ...be(data.length),
      ...data,
    ]);
  const sdt = withCrc([
    0x42,
    0x00,
    0x00,
    ...be(1),
    0xc1,
    0x00,
    0x00,
    ...be(service.networkId),
    0xff,
    ...be(service.serviceId),
    0xfc,
    ...be(0x8000 | 9),
    0xcf,
    0x07,
    0x01,
    ...be(logoId),
    ...be(1),
    ...be(service.networkId),
  ]);
  const small = packetize(0x0029, cdt(0x00, logoOf(service, false)));
  // 同じ PID の続きなので、連続性カウンタは前のぶんの続きから
  const large = packetize(
    0x0029,
    cdt(0x05, logoOf(service, true)),
    small.length / 188,
  );
  return Uint8Array.from([...small, ...packetize(0x0011, sdt, 5), ...large]);
}

/**
 * 物理チャンネル1つぶんの表 (PAT / PMT / SDT / NIT)。選局したら真っ先に流れてくる。
 *
 * **NIT も出す。** チャンネルスキャンは NIT と SDT が**両方**揃って初めて
 * 「受信できた」とみなす (`packages/arib/src/psi.ts` の `ServiceReader`)。偽エージェントは
 * スキャンの結果を作り物で返していたので要らなかったが、本物のエージェントに
 * 食わせるならこれが無いとどのチャンネルも見つからない。
 */
function tables(services: FakeService[], knobs: Knobs): Uint8Array {
  /*
   * ロゴを積んでいる中継にはエンジニアリングサービス (929) がある。
   * **PAT に載せるかどうかがそのまま「当たり外れ」になる** — denpa は
   * ここを見て、外れの中継を1秒ほどで見切る
   */
  const carousel = services.some((service) => service.carousel === true);
  const programs: [number, number][] = services.map((s, i) => [
    s.serviceId,
    pidsOf(i).pmt,
  ]);
  if (carousel) programs.push([ENGINEERING.service, ENGINEERING.pmt]);

  const parts: number[] = [...packetize(0x0000, patSection(programs))];
  if (carousel) {
    parts.push(
      ...packetize(
        ENGINEERING.pmt,
        pmtSection(ENGINEERING.service, ENGINEERING.es, 0x79),
      ),
    );
  }
  for (const [index, service] of services.entries()) {
    const pids = pidsOf(index);
    const streams: ([number, number] | [number, number, number[]])[] = [
      [0x02, pids.video],
      [0x0f, pids.audio],
      // **印が付いた ES があって初めて AIT を読みに行く** (`packages/arib/src/ait.ts`)
      ...(service.hybridcast === undefined
        ? []
        : ([[0x0d, pids.ait, aitSignallingDescriptor()]] as [
            number,
            number,
            number[],
          ][])),
    ];
    // コピー禁止は番組ぜんたいの記述子に載せる (本物もここ)
    const programInfo = knobs.pmtCopyNever ? copyControlDescriptor(0b11) : [];
    const pmt = programMap(
      service.serviceId,
      pids.video,
      streams,
      undefined,
      programInfo,
    );
    parts.push(...packetize(pids.pmt, pmt));
    if (service.hybridcast !== undefined) {
      parts.push(
        ...packetize(
          pids.ait,
          aitSection([
            {
              organisationId: service.networkId,
              applicationId: 1,
              name: service.hybridcast.name,
              base: service.hybridcast.base,
              path: service.hybridcast.path,
            },
          ]),
        ),
      );
    }
  }

  const first = services[0]!;
  parts.push(
    ...packetize(
      0x0011,
      sdtSection(
        first.networkId,
        first.networkId,
        services.map(
          (s) =>
            [s.serviceId, s.serviceType, s.name] as [number, number, string],
        ),
      ),
    ),
  );
  parts.push(
    ...packetize(
      0x0010,
      nitSection(
        first.networkId,
        first.type === "GR" ? (first.remoteKey ?? 9) : null,
        [
          [
            first.networkId,
            first.networkId,
            services.map((s) => [s.serviceId, s.serviceType]),
          ],
        ],
      ),
    ),
  );
  return Uint8Array.from(parts);
}

/**
 * 番組表 (EIT[schedule])。開いたら1回で全部流す。
 *
 * **衛星は、同じネットワークのほかの TS の局のぶんも流す** (EIT[schedule other])。本物の BS・CS は
 * どの中継にもネットワーク全局ぶんの番組表 (基本) が流れていて、denpa の全局読み
 * (`epg-collect.firstSweeps` / `networkSweeps`) はどの中継を開いてもそれで埋まる前提でいる
 */
function schedule(services: FakeService[], knobs: Knobs): Uint8Array {
  const parts: number[] = [];
  const push = (service: FakeService, tableId: number) => {
    const events = programsWith(service, knobs);
    for (const section of scheduleSections(service, events, tableId)) {
      parts.push(...packetize(0x0012, section));
    }
  };
  for (const service of services) push(service, 0x50);
  const here = services.filter((s) => s.type !== "GR");
  for (const service of SERVICES) {
    const sameNetwork = here.some(
      (s) => s.type === service.type && s.networkId === service.networkId,
    );
    if (sameNetwork && !services.includes(service)) push(service, 0x60);
  }
  return Uint8Array.from(parts);
}

/**
 * EIT[p/f]。いま流れている番組 (section 0) と次の番組 (section 1)。延長はここに乗る。
 *
 * **延びたら、次の番組はそのぶん繰り下げて短くする** (終わりは動かさない)。本物でも
 * ニュースが詰められる形はよくある。終わりを動かさないので、延長を戻せば番組表は
 * 元の並びに戻る (ライブが写した p/f が、その次の番組まで消してしまわない)
 */
function nowOnAir(services: FakeService[], knobs: Knobs): Uint8Array {
  if (knobs.noPresentFollowing) return new Uint8Array(0);
  const parts: number[] = [];
  for (const service of services) {
    const events = programsWith(service, knobs);
    const current = present(events);
    if (current === undefined) continue;
    const section = (sectionNumber: number, event: SynthEvent) =>
      packetize(
        0x0012,
        eitSection({
          tableId: 0x4e,
          serviceId: service.serviceId,
          transportStreamId: service.networkId,
          originalNetworkId: service.networkId,
          sectionNumber,
          lastSectionNumber: 1,
          events: [event],
        }),
      );
    const extended = {
      ...current,
      duration: current.duration + knobs.extendedMs,
      runningStatus: 4,
    };
    parts.push(...section(0, extended));
    const next = events[events.indexOf(current) + 1];
    if (next !== undefined && next.duration > knobs.extendedMs) {
      const startAt = next.startAt + knobs.extendedMs;
      const duration = next.duration - knobs.extendedMs;
      parts.push(
        ...section(1, { ...next, startAt, duration, runningStatus: 1 }),
      );
    }
  }
  return Uint8Array.from(parts);
}

/** 送り出す間隔。本物の放送は途切れないので、細かく刻んで流し続ける */
const TICK = 100;

/**
 * **動くものを映す偽の放送** (`FAKE_MOTION=1`)。止まった地の上を、真ん中と上の端で四角が横切る
 * (マクロブロック 2x2。真ん中は右へ、上の端は左へ、1 秒で端から端まで)。アンビエントモードが、映像の中の
 * 動きでちらつかないかを見るためのもの
 */
const MOTION = process.env["FAKE_MOTION"] === "1";
function motionColor(
  col: number,
  row: number,
  n: number,
): [number, number, number] {
  const x = Math.floor(n / 2);
  if (row >= 4 && row < 6 && col >= x && col < x + 2) return [200, 90, 210];
  if (row === 0 && col >= 14 - x && col < 16 - x) return [170, 40, 120];
  return [70, 150, 110];
}

/**
 * 映像と音声。**本当にデコードできる MPEG-2 と AAC を流す** (`packages/arib/src/synth-av.ts`)。
 *
 * エンコードする経路の E2E では ffmpeg も偽物なので中身は何でもよかったが、ライブを変換せずに送る経路は
 * **ブラウザが自分でデコードして映像を出す** (docs/stream.md#放送そのままmpeg-2を送る)。そこを試すにはデコードできるものが要る。
 * コマは 30 枚を使い回す (1秒で一巡りする縞)。
 *
 * **PTS は PCR より 0.4 秒先にする。** 本物の放送もそう作ってある (受信機は PTS まで
 * 待って映す。stream.md#貯まりより小さく出ることはある)
 */
const FRAMES = Array.from({ length: 30 }, (_, n) =>
  MOTION
    ? mpeg2Frame(n, motionColor)
    : DOCS
      ? mpeg2Frame(n, docsColor)
      : mpeg2Frame(n),
);
const SILENCE = silentAac();
const PTS_AHEAD = 0.4 * CLOCK;

interface AvState {
  startedAt: number;
  /** 最初の PTS。局ごとにずらす (実機もばらばら) */
  base: number;
  frames: number;
  audio: number;
  videoCounter: number;
  audioCounter: number;
}

function avPackets(index: number, state: AvState): Uint8Array {
  const pids = pidsOf(index);
  const elapsed = ((performance.now() - state.startedAt) / 1000) * CLOCK;
  const parts: Uint8Array[] = [];
  while (state.frames * FRAME_TICKS <= elapsed) {
    const at = state.frames * FRAME_TICKS;
    const out = packetizePes(
      pids.video,
      pes(
        0xe0,
        state.base + at + PTS_AHEAD,
        FRAMES[state.frames % FRAMES.length]!,
      ),
      state.videoCounter,
      state.base + at,
    );
    state.videoCounter = out.counter;
    parts.push(out.packets);
    state.frames++;
  }
  while (state.audio * AUDIO_TICKS <= elapsed) {
    const at = state.audio * AUDIO_TICKS;
    const out = packetizePes(
      pids.audio,
      pes(0xc0, state.base + at + PTS_AHEAD, SILENCE),
      state.audioCounter,
    );
    state.audioCounter = out.counter;
    parts.push(out.packets);
    state.audio++;
  }
  const joined = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/**
 * 選局した状態を作る。**物理チャンネル丸ごと**しか無い。
 *
 * 局を選り分けるのも番組表を読むのも denpa の仕事なので、1本の TS に
 * その中継の局を全部乗せる。`knobs` は都度読む — 別プロセスから
 * ファイル越しに変えられることがあるため。
 */
export function broadcast(
  services: FakeService[],
  knobs: () => Knobs,
  send: (data: Uint8Array) => void,
): () => void {
  const carousel = services.filter(
    (service) => service.type !== "GR" && service.carousel === true,
  );
  const logo = Uint8Array.from([
    ...services
      .filter((service) => service.type === "GR")
      .flatMap((s) => [...logoPackets(s)]),
    ...(carousel.length > 0 ? [...carouselPackets(carousel)] : []),
  ]);

  // 選局した直後に表と番組表を流す。本物も数百 ms で PAT が来る
  if (!knobs().tablesLate) send(tables(services, knobs()));
  send(schedule(services, knobs()));
  send(nowOnAir(services, knobs()));

  let ticks = 0;
  const av: AvState[] = services.map((_, index) => ({
    startedAt: performance.now(),
    base: 900_000 * (index + 1),
    frames: 0,
    audio: 0,
    videoCounter: 0,
    audioCounter: 0,
  }));
  const timer = setInterval(() => {
    ticks++;
    const now = knobs();
    // 実際の放送波と同じで、ロゴは時々しか流れてこない
    if (ticks % 5 === 0) send(logo);
    // 表と p/f は繰り返し流れてくる。途中から読んでも辻褄が合うように
    if (ticks % 10 === 0) {
      send(tables(services, now));
      send(nowOnAir(services, now));
    }
    /*
     * 映像と音声。局ごとに別のPIDで流す (選り分けを試すため)。**スクランブルが掛かって
     * いる状態は、復号できない中身のまま流す** — 掛かっていれば本物も復号できない
     */
    for (let index = 0; index < services.length; index++) {
      send(
        now.scrambled
          ? payload(pidsOf(index).video, 10, true)
          : avPackets(index, av[index]!),
      );
    }
  }, TICK);

  return () => clearInterval(timer);
}
