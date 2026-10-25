import { createServer, type Socket } from "node:net";

/**
 * 偽の EpgTimerSrv (EDCB)。
 *
 * denpa の引き継ぎ (`src/lib/server/edcb-ctrlcmd.ts`) が送るコマンド (`ENUM_RESERVE2` 2011・
 * `ENUM_RECINFO_BASIC2` 2020・`ENUM_AUTO_ADD2` 2131) だけを、EDCB の `CtrlCmdUtil.cpp` と同じ並びで書いて返す
 * (1 接続 1 コマンド、返したら切る)。番組名や局名はすべて作り物。
 *
 * 単体テストは {@link startFakeEdcb} をその場で立て、e2e はこのファイルを直に走らせる (`FAKE_EDCB_PORT`)。
 * 振る舞いは {@link FakeEdcbMode} で変える (e2e は `FAKE_EDCB_CONTROL_PORT` の `POST /__control/mode`)
 */

/** 振る舞いを変えるつまみ。テストから途中で変える */
export interface FakeEdcbMode {
  /** 応答の ver。null なら頼まれた ver (2 未満は 2。本物と同じ) */
  ver: number | null;
  /** 一覧の1件ずつの構造体の後ろに、知らない欄としてこのバイト数を足す (新しい EDCB の代わり) */
  extra: number;
  /** 受けてすぐ何も返さずに切る (アクセス制御から外れた IP の扱い) */
  deny: boolean;
  /** 受けて黙ったままにする */
  silent: boolean;
  /** 最初の何回かは BUSY (208) を返す */
  busy: number;
  /** 結果をこれにする (null なら 1 = 成功) */
  result: number | null;
  /** 応答の頭の長さをこれに偽る (null なら本当の長さ)。本文は本当の長さだけ送って切る */
  claimSize: number | null;
}

export const DEFAULT_EDCB_MODE: FakeEdcbMode = {
  ver: null,
  extra: 0,
  deny: false,
  silent: false,
  busy: 0,
  result: null,
  claimSize: null,
};

const JST = 9 * 60 * 60 * 1000;

/** CtrlCmd の並びを書く (リトルエンディアン)。偽サーバと単体テストが、文書どおりのバイト列を作るのに使う */
export class Writer {
  private chunks: Uint8Array[] = [];
  length = 0;

  private push(bytes: Uint8Array): this {
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
    return this;
  }

  private number(bytes: number, write: (view: DataView) => void): this {
    const buffer = new Uint8Array(bytes);
    write(new DataView(buffer.buffer));
    return this.push(buffer);
  }

  u8(value: number): this {
    return this.number(1, (v) => v.setUint8(0, value));
  }
  u16(value: number): this {
    return this.number(2, (v) => v.setUint16(0, value, true));
  }
  u32(value: number): this {
    return this.number(4, (v) => v.setUint32(0, value >>> 0, true));
  }
  i32(value: number): this {
    return this.number(4, (v) => v.setInt32(0, value, true));
  }
  /** LONGLONG を上と下の DWORD で */
  u64(high: number, low: number): this {
    return this.u32(low).u32(high);
  }
  bool(value: boolean): this {
    return this.u32(value ? 1 : 0);
  }
  raw(bytes: Uint8Array): this {
    return this.push(bytes);
  }

  /** `DWORD 長さ (長さの欄 + NUL まで)` + UTF-16LE + NUL */
  string(text: string): this {
    const units = new Uint8Array((text.length + 1) * 2);
    const view = new DataView(units.buffer);
    for (let i = 0; i < text.length; i++)
      view.setUint16(i * 2, text.charCodeAt(i), true);
    return this.u32(4 + units.byteLength).push(units);
  }

  /** `SYSTEMTIME`。日本時間の壁時計。null は全部 0 */
  time(at: number | null): this {
    if (at === null) return this.raw(new Uint8Array(16));
    const d = new Date(at + JST);
    return this.u16(d.getUTCFullYear())
      .u16(d.getUTCMonth() + 1)
      .u16(d.getUTCDay())
      .u16(d.getUTCDate())
      .u16(d.getUTCHours())
      .u16(d.getUTCMinutes())
      .u16(d.getUTCSeconds())
      .u16(d.getUTCMilliseconds());
  }

  /** 頭に `DWORD 全体の長さ` を付けた構造体 */
  struct(write: (w: Writer) => void): this {
    const inner = new Writer();
    write(inner);
    return this.u32(4 + inner.length).raw(inner.bytes());
  }

  /** `DWORD 全体の長さ` + `DWORD 件数` の配列 */
  array<T>(items: readonly T[], write: (w: Writer, item: T) => void): this {
    const inner = new Writer();
    for (const item of items) write(inner, item);
    return this.u32(8 + inner.length)
      .u32(items.length)
      .raw(inner.bytes());
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }
}

/** 局 (ONID・TSID・SID) */
export interface FakeService {
  networkId: number;
  transportStreamId: number;
  serviceId: number;
}

/** ルール (`EPG_AUTO_ADD_DATA`) の中身 */
export interface FakeRule {
  id: number;
  andKey: string;
  notKey?: string;
  regExp?: boolean;
  titleOnly?: boolean;
  /** `[大分類, 中分類, ユーザー1, ユーザー2]` */
  contents?: [number, number, number, number][];
  dates?: {
    startDay: number;
    startHour: number;
    startMinute: number;
    endDay: number;
    endHour: number;
    endMinute: number;
  }[];
  services: FakeService[];
  recMode?: number;
  aimai?: boolean;
  notContent?: boolean;
  notDate?: boolean;
  freeCA?: number;
  chkRecEnd?: boolean;
}

/** 予約 (`RESERVE_DATA`) の中身 */
export interface FakeReserve {
  id: number;
  title: string;
  startAt: number;
  durationSecond: number;
  service: FakeService;
  stationName: string;
  eventId: number;
  comment?: string;
  recMode?: number;
}

/** 録画済み (`REC_FILE_INFO`) の中身 */
export interface FakeRecInfo {
  id: number;
  title: string;
  startAt: number;
  durationSecond: number;
  service: FakeService;
  serviceName: string;
  eventId: number;
  recStatus?: number;
  /** 予約したときの番組の開始。省けば startAt */
  epgStartAt?: number | null;
}

export interface FakeEdcbData {
  autoAdd: FakeRule[];
  reserve: FakeReserve[];
  recInfo: FakeRecInfo[];
}

/** 知らない欄の代わり */
function extraBytes(w: Writer, extra: number): void {
  if (extra > 0) w.raw(new Uint8Array(extra).fill(0xee));
}

/** `REC_SETTING_DATA`。denpa が読むのは録画モードだけだが、並びは本物どおり書く */
export function writeRecSetting(w: Writer, recMode: number, ver: number): void {
  w.struct((s) => {
    s.u8(recMode)
      .u8(2) // priority
      .u8(1) // tuijyuuFlag
      .u32(0) // serviceMode
      .u8(0) // pittariFlag
      .string("") // batFilePath
      // recFolderList (`REC_FILE_SET_INFO` = recFolder・writePlugIn・recNamePlugIn)
      .array(["D:\\rec"], (item, folder) =>
        item.struct((f) =>
          f
            .string(folder)
            .string("Write_Default.dll")
            .string("RecName_Macro.dll?$Title$.ts"),
        ),
      )
      .u8(0) // suspendMode
      .u8(0) // rebootFlag
      .u8(0) // useMargineFlag
      .i32(5) // startMargine
      .i32(2) // endMargine
      .u8(0) // continueRecFlag
      .u8(0) // partialRecFlag
      .u32(0); // tunerID
    if (ver >= 2) s.array([] as string[], () => {}); // partialRecFolder
  });
}

export function writeAutoAdd(
  w: Writer,
  rule: FakeRule,
  ver: number,
  extra = 0,
): void {
  w.struct((r) => {
    r.u32(rule.id);
    r.struct((k) => {
      k.string(rule.andKey)
        .string(rule.notKey ?? "")
        .bool(rule.regExp ?? false)
        .bool(rule.titleOnly ?? true)
        .array(rule.contents ?? [], (item, [n1, n2, u1, u2]) =>
          item.struct((c) => c.u8(n1).u8(n2).u8(u1).u8(u2)),
        )
        .array(rule.dates ?? [], (item, d) =>
          item.struct((s) =>
            s
              .u8(d.startDay)
              .u16(d.startHour)
              .u16(d.startMinute)
              .u8(d.endDay)
              .u16(d.endHour)
              .u16(d.endMinute),
          ),
        )
        .array(rule.services, (item, s) =>
          item.u64(
            s.networkId,
            ((s.transportStreamId << 16) | s.serviceId) >>> 0,
          ),
        )
        .array([] as number[], () => {}) // videoList
        .array([] as number[], () => {}) // audioList
        .u8(rule.aimai ? 1 : 0)
        .u8(rule.notContent ? 1 : 0)
        .u8(rule.notDate ? 1 : 0)
        .u8(rule.freeCA ?? 0);
      if (ver >= 3) k.u8(rule.chkRecEnd ? 1 : 0).u16(6); // chkRecEnd・chkRecDay
      extraBytes(k, extra);
    });
    writeRecSetting(r, rule.recMode ?? 1, ver);
    if (ver >= 5) r.u32(0); // addCount
    extraBytes(r, extra);
  });
}

export function writeReserve(
  w: Writer,
  reserve: FakeReserve,
  ver: number,
  extra = 0,
): void {
  w.struct((r) => {
    r.string(reserve.title)
      .time(reserve.startAt)
      .u32(reserve.durationSecond)
      .string(reserve.stationName)
      .u16(reserve.service.networkId)
      .u16(reserve.service.transportStreamId)
      .u16(reserve.service.serviceId)
      .u16(reserve.eventId)
      .string(reserve.comment ?? "")
      .u32(reserve.id)
      .u8(0) // recWaitFlag
      .u8(0) // overlapMode
      .string("") // recFilePath
      .time(reserve.startAt); // startTimeEpg
    writeRecSetting(r, reserve.recMode ?? 1, ver);
    r.u32(0); // reserveStatus
    if (ver >= 5)
      r.array(["D:\\rec\\テスト.ts"], (item, name) => item.string(name)).u32(0);
    extraBytes(r, extra);
  });
}

export function writeRecInfo(
  w: Writer,
  info: FakeRecInfo,
  ver: number,
  extra = 0,
): void {
  w.struct((r) => {
    r.u32(info.id)
      .string(`D:\\rec\\${info.title}.ts`)
      .string(info.title)
      .time(info.startAt)
      .u32(info.durationSecond)
      .string(info.serviceName)
      .u16(info.service.networkId)
      .u16(info.service.transportStreamId)
      .u16(info.service.serviceId)
      .u16(info.eventId)
      .u64(0, 0) // drops
      .u64(0, 0) // scrambles
      .u32(info.recStatus ?? 1)
      .time(info.epgStartAt === undefined ? info.startAt : info.epgStartAt)
      .string("録画終了") // comment
      .string("") // programInfo (BASIC なので空)
      .string(""); // errInfo
    if (ver >= 4) r.u8(0); // protectFlag
    extraBytes(r, extra);
  });
}

/** 一覧のコマンドの本文 (`WORD ver` + 配列) */
export function listBody(
  command: number,
  data: FakeEdcbData,
  ver: number,
  extra = 0,
): Uint8Array | null {
  const w = new Writer().u16(ver);
  if (command === 2131)
    w.array(data.autoAdd, (item, rule) => writeAutoAdd(item, rule, ver, extra));
  else if (command === 2011)
    w.array(data.reserve, (item, row) => writeReserve(item, row, ver, extra));
  else if (command === 2020)
    w.array(data.recInfo, (item, row) => writeRecInfo(item, row, ver, extra));
  else return null;
  return w.bytes();
}

/** denpa の偽の放送にある局 (TOKYO MX。`tests/fake/services.ts`)。TSID は denpa では使わない */
export const MX: FakeService = {
  networkId: 32391,
  transportStreamId: 32752,
  serviceId: 23608,
};

const START = Date.UTC(2026, 8, 1, 12, 0, 0);

/** e2e で返すもの。1つ目のルールは無効の印付き (予約を立ててほかのテストを乱さない)、2つ目は正規表現なので飛ぶ */
export const DEFAULT_EDCB_DATA: FakeEdcbData = {
  autoAdd: [
    { id: 1, andKey: "^!{999}引き継ぎテスト", services: [MX] },
    { id: 2, andKey: "テスト.*", regExp: true, services: [MX] },
  ],
  reserve: [
    {
      id: 1,
      title: "引き継ぎテスト #2",
      startAt: START + 7 * 86400_000,
      durationSecond: 1800,
      service: MX,
      stationName: "ＴＯＫＹＯ　ＭＸ１",
      eventId: 1002,
      comment: "EPG自動予約(引き継ぎテスト)",
    },
  ],
  recInfo: [
    {
      id: 1,
      title: "引き継ぎテスト #1",
      startAt: START,
      durationSecond: 1800,
      service: MX,
      serviceName: "ＴＯＫＹＯ　ＭＸ１",
      eventId: 1001,
    },
  ],
};

export interface FakeEdcb {
  port: number;
  /** `127.0.0.1:<port>` */
  target: string;
  mode: FakeEdcbMode;
  data: FakeEdcbData;
  /** 受けたコマンド (順に) */
  commands: number[];
  setMode(mode: Partial<FakeEdcbMode>): void;
  setData(data: Partial<FakeEdcbData>): void;
  stop(): Promise<void>;
}

/** 立てる。port 0 なら空いているポート */
export function startFakeEdcb(port = 0): Promise<FakeEdcb> {
  const sockets = new Set<Socket>();
  let busyLeft = 0;
  const state: FakeEdcb = {
    port: 0,
    target: "",
    mode: { ...DEFAULT_EDCB_MODE },
    data: structuredClone(DEFAULT_EDCB_DATA),
    commands: [],
    setMode(mode) {
      state.mode = { ...DEFAULT_EDCB_MODE, ...mode };
      busyLeft = state.mode.busy;
    },
    setData(data) {
      state.data = { ...state.data, ...data };
    },
    stop: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (state.mode.deny) {
      socket.destroy();
      return;
    }
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength < 8) return;
      const size = buffer.readUInt32LE(4);
      if (buffer.byteLength < 8 + size) return;
      const command = buffer.readUInt32LE(0);
      const requested = size >= 2 ? buffer.readUInt16LE(8) : 0;
      state.commands.push(command);
      if (state.mode.silent) return;

      const m = state.mode;
      let result = m.result ?? 1;
      let body: Uint8Array = new Uint8Array(0);
      if (busyLeft > 0) {
        busyLeft--;
        result = 208;
      } else if (result === 1) {
        const listed = listBody(
          command,
          state.data,
          m.ver ?? Math.max(2, requested),
          m.extra,
        );
        if (listed === null) result = 203;
        else body = listed;
      }
      const head = Buffer.alloc(8);
      head.writeUInt32LE(result, 0);
      head.writeUInt32LE(m.claimSize ?? body.byteLength, 4);
      socket.end(Buffer.concat([head, body]));
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      state.port = typeof address === "object" && address ? address.port : port;
      state.target = `127.0.0.1:${state.port}`;
      resolve(state);
    });
  });
}

if (import.meta.main) {
  const port = Number(process.env["FAKE_EDCB_PORT"] ?? 4510);
  const controlPort = Number(process.env["FAKE_EDCB_CONTROL_PORT"] ?? 4511);
  const fake = await startFakeEdcb(port);
  // 振る舞いを変えるエンドポイントは HTTP で別のポートに置く (CtrlCmd のポートには HTTP を混ぜられない)
  Bun.serve({
    port: controlPort,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/__control/mode" && request.method === "POST") {
        fake.setMode((await request.json()) as Partial<FakeEdcbMode>);
        return Response.json({ ok: true });
      }
      if (path === "/__control/state")
        return Response.json({ mode: fake.mode, commands: fake.commands });
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`fake edcb listening on :${port} (control :${controlPort})`);
}
