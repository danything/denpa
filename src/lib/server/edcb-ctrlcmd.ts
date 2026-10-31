/**
 * EDCB の EpgTimerSrv に TCP (CtrlCmd。EpgTimerNW と同じもの) で繋いで、ルール・予約・録画済みの一覧を読む
 * (引き継ぎ用。写すのは `migrate-edcb.ts`)。決まりは EDCB の `CtrlCmdDef.h`・`CtrlCmdUtil.cpp`・`StructDef.h` に合わせてある:
 *
 * - **1 接続 1 コマンド。** 送るのは `DWORD コマンド` + `DWORD 長さ` + 本文、返るのは `DWORD 結果` + `DWORD 長さ` + 本文
 *   (どれもリトルエンディアン)。サーバは返したら切る
 * - 「2」の付くコマンドは本文の頭に `WORD ver` を送り、応答の頭にも `WORD ver` が付く。サーバはリクエストした ver で書く
 * - 構造体は頭に `DWORD 全体の長さ` (長さの欄を含む)、配列は `DWORD 全体の長さ` + `DWORD 件数`。**長さで飛ばせるので、
 *   後ろに知らない欄が増えても読める** ({@link Reader})
 * - 文字列は `DWORD 長さ` + UTF-16LE + NUL、時刻は `SYSTEMTIME` (WORD ×8) で日本時間の壁時計
 * - 認証は無い。EpgTimerSrv のアクセス制御 (`TCPAccessControlList`) から外れた IP は、受けてすぐ何も返さずに切られる
 *
 * ver は 5 (いまの `CMD_VER`) でリクエストする。違う ver が返ったら 1 回だけ警告して読めるところまで読む
 * (後ろの欄は長さで飛ばせる)。長さが合わない応答は壊れているので止める
 */
import { connect } from "node:net";

/** 待つ長さと応答の上限。試験は短くする */
export const timing = {
  /** 繋がるまで (EDCB の `CONNECT_TIMEOUT` と同じ) */
  connect: 15_000,
  /** 繋がってから何も来ない間 */
  idle: 30_000,
  /** BUSY (EPG の読み込み中など) が返ったとき、待ってから送り直す回数と間隔 */
  busyRetries: 3,
  busyWait: 2_000,
};

/** 応答の本文の上限。録画済みが 7 万件でおよそ 30 MB */
export const RESPONSE_LIMIT = 128 * 1024 * 1024;

/** リクエストする ver (`CMD_VER`) */
const CMD_VER = 5;

/** 使うコマンド (`CtrlCmdDef.h`) */
const COMMANDS = {
  ENUM_RESERVE2: 2011,
  ENUM_RECINFO_BASIC2: 2020,
  ENUM_AUTO_ADD2: 2131,
} as const;
type CommandName = keyof typeof COMMANDS;

/** 結果 (`ErrDef.h`) */
const RESULT = {
  SUCCESS: 1,
  NON_SUPPORT: 203,
  BUSY: 208,
} as const;

/** 宛先 */
interface EdcbTarget {
  host: string;
  port: number;
  /** 画面と記録に出す `host:port` (IPv6 は `[::1]:4510`) */
  label: string;
}

/** EpgTimerSrv の既定のポート */
const DEFAULT_PORT = 4510;

/**
 * 入力欄の `host:port` を読む。ポートを省けば 4510、IPv6 は `[::1]:4510`。
 * `tcp://` のような頭は付けない。読めなければ理由を投げる
 */
export function parseTarget(input: string): EdcbTarget {
  const text = input.trim();
  const usage = "宛先は host:port の形で入れてください (例: 192.168.1.10:4510)";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) throw new Error(usage);
  const match =
    /^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(text) ??
    /^([^\s:/[\]]+)(?::(\d+))?$/.exec(text);
  if (match === null) throw new Error(usage);
  const host = match[1]!;
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("ポートは 1〜65535 で入れてください");
  return {
    host,
    port,
    label: host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`,
  };
}

/** 応答の並びが壊れている (長さが合わない・件数が多すぎる) */
export class BrokenReply extends Error {}

const JST = 9 * 60 * 60 * 1000;
const utf16 = new TextDecoder("utf-16le");

/**
 * 応答を頭から読む。構造体と配列の中では、その終わりを越えて読まない
 * ({@link struct}・{@link array})。読み終えたら終わりまで飛ばすので、後ろに知らない欄があっても次が読める
 */
export class Reader {
  private pos: number;
  private end: number;

  constructor(
    private readonly view: DataView,
    pos = 0,
    end = view.byteLength,
  ) {
    this.pos = pos;
    this.end = end;
  }

  static of(bytes: Uint8Array): Reader {
    return new Reader(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
  }

  /** いまの構造体 (外なら全体) の残り */
  remaining(): number {
    return this.end - this.pos;
  }

  private need(bytes: number, what: string): void {
    if (this.remaining() < bytes)
      throw new BrokenReply(
        `${what}を読む途中で終わっています (残り ${this.remaining()} バイト)`,
      );
  }

  skip(bytes: number): void {
    this.need(bytes, "値");
    this.pos += bytes;
  }

  u8(): number {
    this.need(1, "BYTE");
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    this.need(2, "WORD");
    const value = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return value;
  }

  u32(): number {
    this.need(4, "DWORD");
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }

  /** BOOL は 4 バイト */
  bool(): boolean {
    return this.u32() !== 0;
  }

  /** 長さで区切られた中身の終わり。長さが残りより長ければ壊れている */
  private bounded(header: number, what: string): number {
    const size = this.u32();
    if (size < header || size - 4 > this.remaining())
      throw new BrokenReply(
        `${what}の長さ (${size}) が残り (${this.remaining() + 4}) と合いません`,
      );
    return this.pos + size - 4;
  }

  /** `DWORD 長さ (長さの欄 + NUL まで)` + UTF-16LE。NUL から後ろは捨てる */
  string(): string {
    const end = this.bounded(4, "文字列");
    const bytes = new Uint8Array(
      this.view.buffer,
      this.view.byteOffset + this.pos,
      (end - this.pos) & ~1,
    );
    this.pos = end;
    const text = utf16.decode(bytes);
    const nul = text.indexOf("\0");
    return nul < 0 ? text : text.slice(0, nul);
  }

  /**
   * `SYSTEMTIME` (年・月・曜日・日・時・分・秒・ミリ秒) を日本時間の壁時計として時刻に。年 0 (未設定) は null。
   * ミリ秒は捨てる (ファイルの時刻は秒までなので、前にファイルから取り込んだ回とキーをそろえる)
   */
  time(): number | null {
    const [year, month, , day, hour, minute, second] = Array.from(
      { length: 8 },
      () => this.u16(),
    ) as [number, number, number, number, number, number, number, number];
    if (year === 0 || month === 0 || day === 0) return null;
    return Date.UTC(year, month - 1, day, hour, minute, second) - JST;
  }

  /** 頭に長さを持つ構造体。読み終えたら長さの終わりまで飛ばす */
  struct<T>(read: (reader: Reader) => T): T {
    const end = this.bounded(4, "構造体");
    const outer = this.end;
    this.end = end;
    try {
      return read(this);
    } finally {
      this.end = outer;
      this.pos = end;
    }
  }

  /**
   * `DWORD 全体の長さ` + `DWORD 件数` の配列。`least` は1件の最小のバイト数で、
   * 件数がそれで割った数を超えたら壊れているとして止める (大きな配列を先に取らない)
   */
  array<T>(read: (reader: Reader) => T, least: number): T[] {
    const end = this.bounded(8, "配列");
    const count = this.u32();
    if (count > (end - this.pos) / least)
      throw new BrokenReply(
        `配列の件数 (${count}) が長さ (${end - this.pos} バイト) に入りきりません`,
      );
    const outer = this.end;
    this.end = end;
    try {
      return Array.from({ length: count }, () => read(this));
    } finally {
      this.end = outer;
      this.pos = end;
    }
  }
}

/** 1件の最小のバイト数 ({@link Reader.array}) */
const LEAST = { struct: 4, word: 2, longlong: 8 } as const;

/** 時間帯と曜日の1件 (`EPGDB_SEARCH_DATE_INFO`)。曜日は 0 = 日曜 */
export interface EdcbDate {
  startDay: number;
  startHour: number;
  startMinute: number;
  endDay: number;
  endHour: number;
  endMinute: number;
}

/** 局 (`serviceList` の `ONID << 32 | TSID << 16 | SID`) */
interface EdcbService {
  networkId: number;
  transportStreamId: number;
  serviceId: number;
}

/** ルール (`EPG_AUTO_ADD_DATA`。使う欄だけ) */
export interface EdcbRule {
  id: number;
  /** 頭に印 (`^!{999}` 無効・`C!{999}` 大小を区別・`D!{…}` 番組の長さ) が付く。サーバが付けて送る */
  andKey: string;
  notKey: string;
  regExp: boolean;
  titleOnly: boolean;
  /** ジャンル `(大分類 << 24) | (中分類 << 16) | (ユーザー1 << 8) | ユーザー2`。符号付き (`migrate-edcb.genreOf`) */
  contents: number[];
  dates: EdcbDate[];
  services: EdcbService[];
  /** 0〜3 は録る、4 は視聴、5〜9 は「無効」(当たっても録らない予約を作る) */
  recMode: number;
  /** あいまい検索 */
  aimai: boolean;
  /** ジャンルの条件を NOT にする */
  notContent: boolean;
  /** 時間帯の条件を NOT にする */
  notDate: boolean;
  /** 0 = どちらでも、1 = 無料だけ、2 = 有料だけ */
  freeCA: number;
  /** 録ったことのある番組名なら予約を無効にする (ver 3 から) */
  chkRecEnd: boolean;
}

/** 予約 (`RESERVE_DATA`。使う欄だけ) */
export interface EdcbReserve {
  startAt: number | null;
  /** ミリ秒 */
  duration: number;
  title: string;
  networkId: number;
  serviceId: number;
  /** 65535 は番組に結び付かない予約 (時刻だけで録る) */
  eventId: number;
  recMode: number;
  /** ルールが作った予約は `EPG自動予約` で始まる */
  comment: string;
}

/** 録画済みの1件 (`REC_FILE_INFO`。使う欄だけ) */
export interface EdcbRecInfo {
  title: string;
  startAt: number | null;
  /** ミリ秒 */
  duration: number;
  serviceName: string;
  networkId: number;
  transportStreamId: number;
  serviceId: number;
  recStatus: number;
  /** 予約したときの番組の開始 (EPG の開始) */
  epgStartAt: number | null;
}

/** 録画の設定 (`REC_SETTING_DATA`) は録画モード (頭の BYTE) だけ読んで、あとは長さで飛ばす */
function readRecMode(reader: Reader): number {
  return reader.struct((r) => r.u8());
}

/** `EPGDB_SEARCH_KEY_INFO` */
function readSearchKey(reader: Reader, ver: number) {
  return reader.struct((r) => {
    const andKey = r.string();
    const notKey = r.string();
    const regExp = r.bool();
    const titleOnly = r.bool();
    // `EPGDB_CONTENT_DATA` (大分類・中分類・ユーザー1・ユーザー2)
    const contents = r.array(
      (item) =>
        item.struct(
          (c) => (c.u8() << 24) | (c.u8() << 16) | (c.u8() << 8) | c.u8(),
        ),
      LEAST.struct,
    );
    const dates = r.array(
      (item) =>
        item.struct((d): EdcbDate => ({
          startDay: d.u8(),
          startHour: d.u16(),
          startMinute: d.u16(),
          endDay: d.u8(),
          endHour: d.u16(),
          endMinute: d.u16(),
        })),
      LEAST.struct,
    );
    const services = r.array((item): EdcbService => {
      const low = item.u32();
      const high = item.u32();
      return {
        networkId: high & 0xffff,
        transportStreamId: low >>> 16,
        serviceId: low & 0xffff,
      };
    }, LEAST.longlong);
    r.array((item) => item.u16(), LEAST.word); // videoList
    r.array((item) => item.u16(), LEAST.word); // audioList
    const aimai = r.u8() !== 0;
    const notContent = r.u8() !== 0;
    const notDate = r.u8() !== 0;
    const freeCA = r.u8();
    // ver 3 から。古いサーバが短く書いてきても止めない
    const chkRecEnd = ver >= 3 && r.remaining() >= 1 && r.u8() !== 0;
    return {
      andKey,
      notKey,
      regExp,
      titleOnly,
      contents,
      dates,
      services,
      aimai,
      notContent,
      notDate,
      freeCA,
      chkRecEnd,
    };
  });
}

/** `EPG_AUTO_ADD_DATA` = dataID・searchInfo・recSetting (ver 5 から addCount) */
export function readAutoAdd(reader: Reader, ver: number): EdcbRule {
  return reader.struct((r) => {
    const id = r.u32();
    const search = readSearchKey(r, ver);
    const recMode = readRecMode(r);
    return { id, ...search, recMode };
  });
}

/**
 * `RESERVE_DATA` = title・startTime・durationSecond・stationName・ONID・TSID・SID・eventID・comment・reserveID・
 * recWaitFlag・overlapMode・recFilePath・startTimeEpg・recSetting・reserveStatus (ver 5 から recFileNameList・param1)
 */
export function readReserve(reader: Reader): EdcbReserve {
  return reader.struct((r) => {
    const title = r.string();
    const startAt = r.time();
    const duration = r.u32() * 1000;
    r.string(); // stationName
    const networkId = r.u16();
    r.u16(); // TSID
    const serviceId = r.u16();
    const eventId = r.u16();
    const comment = r.string();
    r.u32(); // reserveID
    r.u8(); // recWaitFlag
    r.u8(); // overlapMode
    r.string(); // recFilePath
    r.time(); // startTimeEpg
    const recMode = readRecMode(r);
    return {
      startAt,
      duration,
      title,
      networkId,
      serviceId,
      eventId,
      recMode,
      comment,
    };
  });
}

/**
 * `REC_FILE_INFO` (BASIC なので programInfo・errInfo は空) = id・recFilePath・title・startTime・durationSecond・
 * serviceName・ONID・TSID・SID・eventID・drops・scrambles・recStatus・startTimeEpg・comment・programInfo・errInfo
 * (ver 4 から protectFlag)
 */
export function readRecInfo(reader: Reader): EdcbRecInfo {
  return reader.struct((r) => {
    r.u32(); // id
    r.string(); // recFilePath
    const title = r.string();
    const startAt = r.time();
    const duration = r.u32() * 1000;
    const serviceName = r.string();
    const networkId = r.u16();
    const transportStreamId = r.u16();
    const serviceId = r.u16();
    r.u16(); // eventID
    r.skip(16); // drops・scrambles (LONGLONG ×2)
    const recStatus = r.u32();
    const epgStartAt = r.time();
    return {
      title,
      startAt,
      duration,
      serviceName,
      networkId,
      transportStreamId,
      serviceId,
      recStatus,
      epgStartAt,
    };
  });
}

/** 繋がらない・切られた・壊れた・断られた。画面にそのまま出す */
class EdcbError extends Error {}

const seconds = (ms: number) => `${Math.round(ms / 1000)} 秒`;

/** 応答 (結果と本文) */
interface Reply {
  result: number;
  body: Uint8Array;
}

/**
 * 1 回繋いで 1 コマンド送り、応答を待つ。サーバは返したら切る。
 * 失敗の理由は、どこで止まったかで分ける (断られた・繋がらない・受けてすぐ切られた・途中で切れた・黙った・大きすぎる)
 */
function send(
  target: EdcbTarget,
  command: number,
  body: Uint8Array,
): Promise<Reply> {
  const where = `EpgTimerSrv (${target.label})`;
  return new Promise((resolve, reject) => {
    const socket = connect({ host: target.host, port: target.port });
    let connected = false;
    let settled = false;
    const chunks: Buffer[] = [];
    let received = 0;
    /** 本文の長さ。頭の 8 バイトが来るまでは null */
    let size: number | null = null;

    const finish = (error: Error | null, reply?: Reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      socket.destroy();
      if (error === null) resolve(reply!);
      else reject(error);
    };
    const connectTimer = setTimeout(
      () =>
        finish(
          new EdcbError(
            `${where} に ${seconds(timing.connect)}待っても繋がりません。宛先の IP と、Windows ファイアウォールで TCP ${target.port} の受信を許可しているか (プロファイルにパブリックを含めて) を確かめてください。wslc から繋ぐときの宛先は、Windows の「vEthernet (Default Switch)」の IP です`,
          ),
        ),
      timing.connect,
    );
    /** 受けたあと何も返さずに切られた。EpgTimerSrv はアクセス制御から外れた IP をこう扱う */
    const denied = () =>
      new EdcbError(
        `${where} は接続を受けましたが、何も返さずに切りました。EpgTimerSrv のアクセス制御 (TCPAccessControlList) に denpa の IP が入っていないと思われます。wslc から繋ぐなら +172.16.0.0/12 を足してください`,
      );

    socket.on("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      socket.setTimeout(timing.idle);
      const head = Buffer.alloc(8);
      head.writeUInt32LE(command, 0);
      head.writeUInt32LE(body.byteLength, 4);
      socket.write(Buffer.concat([head, body]));
    });
    socket.on("timeout", () =>
      finish(
        new EdcbError(`${where} から ${seconds(timing.idle)}応答がありません`),
      ),
    );
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.byteLength;
      if (size === null && received >= 8) {
        const head = Buffer.concat(chunks);
        size = head.readUInt32LE(4);
        if (size > RESPONSE_LIMIT) {
          finish(
            new EdcbError(
              `${where} の応答が大きすぎます (${(size / 1024 / 1024).toFixed(0)} MiB。上限は ${RESPONSE_LIMIT / 1024 / 1024} MiB)`,
            ),
          );
          return;
        }
      }
      if (size !== null && received >= 8 + size) {
        const all = Buffer.concat(chunks);
        finish(null, {
          result: all.readUInt32LE(0),
          body: new Uint8Array(all.subarray(8, 8 + size)),
        });
      }
    });
    /** 繋がったあとで、応答を読み終える前に切られた */
    const closed = () =>
      received === 0
        ? denied()
        : new EdcbError(
            `${where} の応答が途中で切れました (${received} / ${size === null ? "?" : 8 + size} バイト)`,
          );
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (connected) finish(closed());
      else if (error.code === "ECONNREFUSED")
        finish(
          new EdcbError(
            `${where} に繋がりません (接続を拒否されました)。EpgTimer の「ネットワーク接続を許可する」が入っているかと、ポートを確かめてください`,
          ),
        );
      else
        finish(
          new EdcbError(
            `${where} に繋がりません: ${error.code ?? error.message}`,
          ),
        );
    });
    socket.on("close", () =>
      finish(
        connected
          ? closed()
          : new EdcbError(`${where} に繋がりません (接続が閉じられました)`),
      ),
    );
  });
}

/**
 * EpgTimerSrv の一覧を読むもの。コマンドごとに繋ぎ直す。
 * `warn` は ver が違ったときの出し先 (1 回だけ)
 */
export class EdcbClient {
  private warned = false;

  constructor(
    readonly target: EdcbTarget,
    private readonly warn: (message: string) => void,
  ) {}

  /** 「2」の付く一覧のコマンドを送って、`WORD ver` + 配列を読む。BUSY なら待って送り直す */
  private async list<T>(
    name: CommandName,
    read: (reader: Reader, ver: number) => T,
  ): Promise<T[]> {
    const command = COMMANDS[name];
    const request = new Uint8Array(2);
    new DataView(request.buffer).setUint16(0, CMD_VER, true);
    let reply = await send(this.target, command, request);
    for (
      let retry = 0;
      reply.result === RESULT.BUSY && retry < timing.busyRetries;
      retry++
    ) {
      await new Promise((resolve) => setTimeout(resolve, timing.busyWait));
      reply = await send(this.target, command, request);
    }
    const label = `${name} (${command})`;
    if (reply.result === RESULT.BUSY)
      throw new EdcbError(
        `EpgTimerSrv が忙しいと返しました (${label})。EPG の読み込みなどが終わってから、もう一度実行してください`,
      );
    if (reply.result === RESULT.NON_SUPPORT)
      throw new EdcbError(
        `この EpgTimerSrv は ${label} に対応していません。EDCB を新しいバージョンにしてください`,
      );
    if (reply.result !== RESULT.SUCCESS)
      throw new EdcbError(
        `EpgTimerSrv が ${label} を断りました (結果 ${reply.result})`,
      );
    try {
      const reader = Reader.of(reply.body);
      const ver = reader.u16();
      if (ver !== CMD_VER && !this.warned) {
        this.warned = true;
        this.warn(
          `EpgTimerSrv の応答のバージョンが ${ver} です (denpa は ${CMD_VER} を前提にしています)。読めるところまで読んで続けます`,
        );
      }
      return reader.array((item) => read(item, ver), LEAST.struct);
    } catch (error) {
      if (!(error instanceof BrokenReply)) throw error;
      throw new EdcbError(
        `EpgTimerSrv の応答を読めません (${label}): ${error.message}`,
      );
    }
  }

  autoAdds(): Promise<EdcbRule[]> {
    return this.list("ENUM_AUTO_ADD2", readAutoAdd);
  }

  reserves(): Promise<EdcbReserve[]> {
    return this.list("ENUM_RESERVE2", readReserve);
  }

  recInfos(): Promise<EdcbRecInfo[]> {
    return this.list("ENUM_RECINFO_BASIC2", readRecInfo);
  }
}
