/**
 * **ほかのソフトで録った TS の、先頭と末尾だけを読んで番組を決める材料を集める** (`ts-import.ts`)。
 *
 * 数千本・数 TB を下見するので、ファイルを丸ごとは読まない。先頭は PAT・PMT・SDT[actual]・EIT[p/f]・TDT/TOT がそろったところで止め
 * (`HEAD_MAX` まで)、末尾は最後の `TAIL_STEPS` だけ読む。開くのは読み取りだけで、書かない。
 *
 * 先頭と末尾は続いていないので、パケットの切り分けとセクションの組み立ては部分 ({@link Region}) ごとに持つ
 * (続いていないところでセクションをつなげない)。読んだ表 (PAT・PMT・SDT・EIT) は両方を合わせて使う。
 */

import { open } from "node:fs/promises";

import {
  type EitEvent,
  parseEit,
  parseTimeTable,
  PID_TIME,
} from "@danything/arib/eit";
import {
  packetPid,
  PacketStream,
  parsePat,
  PID_PAT,
  pmtPcrPid,
  pmtStreams,
  SdtReader,
  SectionAssembler,
  type ServiceTable,
} from "@danything/arib/psi";

import { PCR_WRAP, readPcr } from "../ts/clock";

/** EIT の PID と p/f[actual] の table_id (ARIB STD-B10) */
const PID_EIT = 0x0012;
const TABLE_PF_ACTUAL = 0x4e;
/** 映像の stream_type。MPEG-2・H.264・H.265 (と MPEG-1) */
const VIDEO_TYPES = new Set([0x01, 0x02, 0x1b, 0x24]);
/** SDT のサービス種別のデジタル TV */
const DIGITAL_TV = 0x01;

/** 先頭から読む上限。TOT は 5 秒おきに来るので、BS の 24 Mbps でも 15 MB ほどでそろう */
export const HEAD_MAX = 32 * 1024 * 1024;
/** 末尾から読む長さ。最後の時刻 (TDT/TOT) が無ければ次の長さで読み直す */
export const TAIL_STEPS = [4 * 1024 * 1024, 16 * 1024 * 1024];
/** 1 回の read の大きさ */
const CHUNK = 1024 * 1024;
/** スクランブルを見分けるのに要るパケットの数。これに満たなければ「掛かっていない」とみなす */
const SCRAMBLE_SAMPLE = 1000;

/** 番組の時刻を測るための、TDT/TOT の時刻とそのときの PCR (PID ごと) */
interface TimeMark {
  at: number;
  pcr: Map<number, number>;
}

/** PMT から読んだ 1 局ぶん */
interface ProgramMap {
  pcrPid: number | null;
  streams: { type: number; pid: number }[];
}

/** 続いて読んだ 1 つの部分 (先頭か末尾)。パケットの切り分けとセクションの組み立てはここで閉じる */
class Region {
  private readonly packets = new PacketStream();
  private readonly pat = new SectionAssembler(PID_PAT);
  private readonly pmts = new Map<number, SectionAssembler>();
  private readonly sdt = new SdtReader();
  private readonly eit = new SectionAssembler(PID_EIT);
  private readonly time = new SectionAssembler(PID_TIME, "syntax");
  /** PID ごとの最初と最後の PCR (秒) */
  readonly firstPcr = new Map<number, number>();
  readonly lastPcr = new Map<number, number>();
  firstTime: TimeMark | null = null;
  lastTime: TimeMark | null = null;
  /** 同期の取れたパケットを 1 つでも読めたか */
  synced = false;

  constructor(private readonly scan: TsScan) {}

  feed(chunk: Uint8Array): void {
    this.sdt.feed(chunk);
    const table = this.sdt.actual;
    if (table !== null) this.scan.sdt ??= table;
    for (const packet of this.packets.feed(chunk)) this.feedPacket(packet);
  }

  private feedPacket(packet: Uint8Array): void {
    this.synced = true;
    const pid = packetPid(packet);
    const pcr = readPcr(packet);
    if (Number.isFinite(pcr)) {
      if (!this.firstPcr.has(pid)) this.firstPcr.set(pid, pcr);
      this.lastPcr.set(pid, pcr);
    }
    // ペイロードのあるパケットのスクランブルを PID ごとに数える (どの局の ES かは最後に決める)
    if ((packet[3]! & 0x10) !== 0)
      this.scan.count(pid, (packet[3]! & 0xc0) !== 0);

    if (pid === PID_PAT) {
      for (const section of this.pat.feed(packet)) {
        const programs = parsePat(section);
        if (programs.size > 0) this.scan.programs ??= programs;
      }
      return;
    }
    if (pid === PID_TIME) {
      for (const section of this.time.feed(packet)) {
        const at = parseTimeTable(section);
        if (at === null) continue;
        const mark = { at, pcr: new Map(this.lastPcr) };
        this.firstTime ??= mark;
        this.lastTime = mark;
      }
      return;
    }
    if (pid === PID_EIT) {
      for (const section of this.eit.feed(packet)) {
        if (section[0] !== TABLE_PF_ACTUAL) continue;
        const parsed = parseEit(section);
        if (parsed === null || parsed.sectionNumber > 1) continue;
        for (const event of parsed.events) this.scan.addEvent(event);
      }
      return;
    }
    const programs = this.scan.programs;
    if (programs === null) return;
    for (const [program, pmtPid] of programs) {
      if (pmtPid !== pid || this.scan.maps.has(program)) continue;
      let assembler = this.pmts.get(pid);
      if (assembler === undefined) {
        assembler = new SectionAssembler(pid);
        this.pmts.set(pid, assembler);
      }
      for (const section of assembler.feed(packet)) {
        const streams = [...pmtStreams(section)].map(([type, esPid]) => ({
          type,
          pid: esPid,
        }));
        // 同じ PID に別の局の PMT が載ることがある。program_number で見分ける
        const number = (section[3]! << 8) | section[4]!;
        if (!this.scan.maps.has(number))
          this.scan.maps.set(number, { pcrPid: pmtPcrPid(section), streams });
      }
    }
  }
}

/** 先頭と末尾をまとめて読んだ結果。読むのは {@link readTsFacts} */
class TsScan {
  programs: Map<number, number> | null = null;
  readonly maps = new Map<number, ProgramMap>();
  sdt: ServiceTable | null = null;
  /** p/f[actual] の番組。局 (service_id) ごとに event_id で重ねない */
  readonly events = new Map<string, EitEvent>();
  private readonly scrambled = new Map<number, [number, number]>();

  count(pid: number, scrambled: boolean): void {
    const now = this.scrambled.get(pid) ?? [0, 0];
    now[0]++;
    if (scrambled) now[1]++;
    this.scrambled.set(pid, now);
  }

  addEvent(event: EitEvent): void {
    const key = `${event.serviceId}:${event.eventId}`;
    if (!this.events.has(key)) this.events.set(key, event);
  }

  /** 先頭で要るものがそろったか (ここで読むのをやめる) */
  headDone(head: Region): boolean {
    const programs = this.programs;
    return (
      programs !== null &&
      [...programs.keys()].every((program) => this.maps.has(program)) &&
      this.sdt !== null &&
      head.firstTime !== null &&
      [...this.events.values()].some((event) => programs.has(event.serviceId))
    );
  }

  /** 映像のある局か */
  hasVideo(program: number): boolean {
    return (this.maps.get(program)?.streams ?? []).some((stream) =>
      VIDEO_TYPES.has(stream.type),
    );
  }

  /** その局の ES の半分を超えてスクランブルが掛かっているか */
  isScrambled(program: number): boolean {
    let total = 0;
    let scrambled = 0;
    for (const stream of this.maps.get(program)?.streams ?? []) {
      const [t, s] = this.scrambled.get(stream.pid) ?? [0, 0];
      total += t;
      scrambled += s;
    }
    return total >= SCRAMBLE_SAMPLE && scrambled / total > 0.5;
  }
}

export interface TsFacts {
  /** 録ってある局の service_id (PAT の program_number) */
  program: number;
  /** SDT[actual] の original_network_id・transport_stream_id。読めなければ EIT から、それも無ければ null */
  networkId: number | null;
  transportStreamId: number | null;
  /** SDT の局名。読めなければ空 */
  serviceName: string;
  video: boolean;
  scrambled: boolean;
  /** 先頭 (再生位置 0) と末尾の放送時刻 (unix ms)。TDT/TOT が読めなければ null */
  headAt: number | null;
  tailAt: number | null;
  /** 最初の PCR から最後の PCR までの秒。読めなければ null */
  pcrSpan: number | null;
  /** その局の p/f の番組 (先頭のいまと次、末尾のいまと次) */
  events: EitEvent[];
}

/** PCR の差 (秒)。一周をまたいでいても前に進んだぶん */
function pcrDelta(from: number, to: number): number {
  return (((to - from) % PCR_WRAP) + PCR_WRAP) % PCR_WRAP;
}

/**
 * 読んだ部分から結果をまとめる。PAT が読めなければ TS ではないとして null。
 *
 * **局は PAT の 1 つめ。** 2 つ以上あれば、SDT でデジタル TV と名乗り映像を持つ最初のもの、無ければ映像を持つ最初のもの
 * (全部の局を残したまま録る設定のソフトもある。ワンセグやデータ放送の局より、主な局を選ぶ)
 */
function summarize(scan: TsScan, head: Region, tail: Region): TsFacts | null {
  const programs = scan.programs;
  if (programs === null || !head.synced) return null;
  const ids = [...programs.keys()];
  const typeOf = (id: number) =>
    scan.sdt?.services.find((service) => service.serviceId === id)?.serviceType;
  const program =
    ids.find((id) => typeOf(id) === DIGITAL_TV && scan.hasVideo(id)) ??
    ids.find((id) => scan.hasVideo(id)) ??
    ids[0]!;
  const pcrPid = scan.maps.get(program)?.pcrPid ?? null;
  const events = [...scan.events.values()].filter(
    (event) => event.serviceId === program,
  );
  const service = scan.sdt?.services.find((one) => one.serviceId === program);

  /*
   * 先頭の時刻 = 最初の TDT/TOT − そこまでに PCR が進んだぶん (`ts/ts-head.ts` と同じ測り方)、末尾の時刻 = 最後の TDT/TOT + そのあと PCR が進んだぶん。
   * PCR が読めなければ TDT/TOT の時刻のまま (5 秒ほど内側にずれる)
   */
  const since = (mark: TimeMark, pcr: number | undefined) => {
    const at = pcrPid === null ? undefined : mark.pcr.get(pcrPid);
    if (at === undefined || pcr === undefined) return 0;
    const delta = pcrDelta(Math.min(at, pcr), Math.max(at, pcr));
    // 一周や飛びを読み違えた大きな値は使わない
    return delta < 60 ? delta : 0;
  };
  const first = head.firstTime;
  const last = tail.lastTime ?? head.lastTime;
  const lastRegion = tail.lastTime === null ? head : tail;
  const headAt =
    first === null
      ? null
      : Math.round(
          first.at -
            since(
              first,
              pcrPid === null ? undefined : head.firstPcr.get(pcrPid),
            ) *
              1000,
        );
  const tailAt =
    last === null
      ? null
      : Math.round(
          last.at +
            since(
              last,
              pcrPid === null ? undefined : lastRegion.lastPcr.get(pcrPid),
            ) *
              1000,
        );
  const firstPcr = pcrPid === null ? undefined : head.firstPcr.get(pcrPid);
  const lastPcr =
    pcrPid === null
      ? undefined
      : (tail.lastPcr.get(pcrPid) ?? head.lastPcr.get(pcrPid));
  return {
    program,
    networkId:
      scan.sdt?.originalNetworkId ?? events[0]?.originalNetworkId ?? null,
    transportStreamId:
      scan.sdt?.transportStreamId ?? events[0]?.transportStreamId ?? null,
    serviceName: service?.name ?? "",
    video: scan.hasVideo(program),
    scrambled: scan.isScrambled(program),
    headAt,
    tailAt,
    pcrSpan:
      firstPcr === undefined || lastPcr === undefined
        ? null
        : pcrDelta(firstPcr, lastPcr),
    events,
  };
}

/** `from` から `length` バイトを `CHUNK` ずつ読んで渡す。`stop` が true を返したらやめる */
async function readRange(
  file: Awaited<ReturnType<typeof open>>,
  from: number,
  length: number,
  feed: (chunk: Uint8Array) => boolean,
): Promise<void> {
  const buffer = new Uint8Array(CHUNK);
  let at = from;
  const end = from + length;
  while (at < end) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(CHUNK, end - at),
      at,
    );
    if (bytesRead === 0) return;
    at += bytesRead;
    // 切り分けたパケットはこのバッファを指すので、次の read の前に渡し終える (`PacketStream`)
    if (feed(buffer.subarray(0, bytesRead))) return;
  }
}

/**
 * **TS の先頭と末尾を読む** (読み取りだけ)。TS として読めなければ null。
 * 先頭が `HEAD_MAX` と末尾の窓に収まる小さいファイルは、先頭だけで丸ごと読む
 */
export async function readTsFacts(
  path: string,
  size: number,
): Promise<TsFacts | null> {
  const file = await open(path, "r");
  try {
    const scan = new TsScan();
    const head = new Region(scan);
    const whole = size <= HEAD_MAX + TAIL_STEPS[0]!;
    await readRange(file, 0, whole ? size : HEAD_MAX, (chunk) => {
      head.feed(chunk);
      return !whole && scan.headDone(head);
    });
    if (scan.programs === null) return null;
    let tail = new Region(scan);
    if (!whole) {
      for (const step of TAIL_STEPS) {
        tail = new Region(scan);
        const length = Math.min(step, size);
        await readRange(file, size - length, length, (chunk) => {
          tail.feed(chunk);
          return false;
        });
        if (tail.lastTime !== null) break;
      }
    }
    return summarize(scan, head, tail);
  } finally {
    await file.close();
  }
}
