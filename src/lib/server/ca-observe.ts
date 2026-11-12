/**
 * スキャンで、**カードが無くても TS から分かること**を数える (スカパー！プレミアムの実機の報告のため。#1578)。
 *
 * CATV のスキャンでも数え、局ごとの CA_system_id を控えに入れる (`caSystemIdsOf`。復号できるかを決める。`types.decodableService`)。
 *
 * 読むのはスクランブルされていない PSI/SI (ARIB STD-B10) だけで、ECM と EMM の中身は読まない。
 *
 * - PMT (局ごと) と CAT の CA 記述子 (0x09) にある CA_system_id と、ECM・EMM の PID
 * - 番組表 (EIT) とロゴ (CDT) のセクションが届いているか、スクランブルされているか
 *   (TS パケットの transport_scrambling_control が 0 でないものを数える)
 *
 * エージェントの `--decode-file`・`--tune` の出力 (`agent/Denpa.Agent/TsObservation.cs`) と同じものを数える。
 * スキャンの記録と、受信の設定の「受信できるチャンネル」に出す (`scan.ts`)
 */

import { u16 } from "@danything/arib/bytes";
import {
  descriptors,
  packetPid,
  PacketStream,
  parsePat,
  PID_PAT,
  pmtProgramInfo,
  pmtStreams,
  SectionAssembler,
} from "@danything/arib/psi";

import { BCAS_SYSTEM_ID } from "../types";

const PID_CAT = 0x0001;
const PID_CDT = 0x0029;
/** EIT を運ぶ PID。0x0012 (H-EIT) と、地上波の 0x0026 (M-EIT)・0x0027 (L-EIT) */
const EIT_PIDS = new Set([0x0012, 0x0026, 0x0027]);

/** セクションが読めたか (`readable`)・スクランブルされていて読めないか (`scrambled`)・来ていないか (`absent`) */
type Arrival = "readable" | "scrambled" | "absent";

/** CA 記述子 1 つ。`serviceId` は PMT のもの (CAT のものは null) */
interface CaEntry {
  serviceId: number | null;
  caSystemId: number;
  /** PMT なら ECM、CAT なら EMM の PID */
  pid: number;
}

/** 1 チャンネルを読んで分かったこと */
export interface Observed {
  /** PMT の CA 記述子 (ECM) */
  ecm: CaEntry[];
  /** CAT の CA 記述子 (EMM) */
  emm: CaEntry[];
  /** 番組表 (EIT) */
  epg: Arrival;
  /** ほかの TS の局の番組表 (EIT の other。table_id 0x4F・0x60〜0x6F) も読めたか */
  epgOther: boolean;
  /** ロゴ (CDT) */
  logo: Arrival;
}

/** 見た CA_system_id (重なりなし・小さい順) */
export function caSystemIds(observed: Observed): number[] {
  return [
    ...new Set(
      [...observed.ecm, ...observed.emm].map((entry) => entry.caSystemId),
    ),
  ].sort((a, b) => a - b);
}

export const hex = (value: number) =>
  `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;

/** CA_system_id を、B-CAS かどうかが分かる形で */
export function caName(id: number): string {
  return `${hex(id)}${id === BCAS_SYSTEM_ID ? " (B-CAS)" : " (B-CAS 以外)"}`;
}

const ARRIVAL: Record<Arrival, string> = {
  readable: "スクランブルされていない",
  scrambled: "スクランブルされている",
  absent: "来ていない",
};

/** 番組表の具合を短く (受信の設定の表とスキャンの記録で同じ言い方にする) */
export function epgText(observed: Observed): string {
  const other =
    observed.epg === "readable" && observed.epgOther
      ? " (ほかの TS の局のぶんも来ている)"
      : "";
  return `番組表 ${ARRIVAL[observed.epg]}${other}`;
}

/** ロゴの具合を短く */
export function logoText(observed: Observed): string {
  return `ロゴ ${ARRIVAL[observed.logo]}`;
}

/** スキャンの記録の 1 行に足す説明。CA 記述子・番組表・ロゴ */
export function describe(observed: Observed): string {
  const ca = (entries: CaEntry[], kind: string) =>
    entries.map(
      (entry) =>
        `CA_system_id ${caName(entry.caSystemId)} ${kind} ${hex(entry.pid)}`,
    );
  const found = [...ca(observed.ecm, "ECM"), ...ca(observed.emm, "EMM")];
  return [
    found.length === 0 ? "CA 記述子なし" : [...new Set(found)].join("・"),
    epgText(observed),
    logoText(observed),
  ].join("、");
}

/** TS を読みながら数える。1 つの実体は 1 本のストリームからだけ読む */
export class CaObserver {
  private readonly packets = new PacketStream();
  private readonly pat = new SectionAssembler(PID_PAT);
  private readonly cat = new SectionAssembler(PID_CAT);
  private readonly cdt = new SectionAssembler(PID_CDT);
  private readonly eit = new Map(
    [...EIT_PIDS].map((pid) => [pid, new SectionAssembler(pid)]),
  );
  /** PMT の PID → 組み立て中のセクション */
  private readonly pmts = new Map<number, SectionAssembler>();
  /** PAT を読んだか */
  private patSeen = false;
  /** 1 回でも組み上がった PMT の PID */
  private readonly pmtsSeen = new Set<number>();
  /** service_id → PMT の CA 記述子 */
  private readonly ecm = new Map<number, CaEntry[]>();
  private emm: CaEntry[] = [];
  private eitSections = 0;
  private eitOther = 0;
  private eitScrambled = 0;
  private cdtSections = 0;
  private cdtScrambled = 0;

  feed(chunk: Uint8Array): void {
    for (const packet of this.packets.feed(chunk)) this.packet(packet);
  }

  /** 番組表 (EIT) が読めたかスクランブルされていると分かったか。スキャンで、分かるまで少し長く読むのに使う */
  get epgKnown(): boolean {
    return this.eitSections > 0 || this.eitScrambled > 0;
  }

  /**
   * PAT にある局の PMT が全部 1 回は来たか。CATV のスキャンで、局ごとの CA_system_id が分かるまで少し長く読むのに使う
   */
  get pmtsKnown(): boolean {
    return (
      this.patSeen &&
      [...this.pmts.keys()].every((pid) => this.pmtsSeen.has(pid))
    );
  }

  /**
   * その局の PMT の CA 記述子にあった CA_system_id (重なりなし・小さい順)。CA 記述子が無い・PMT が来なかった局は空
   */
  caSystemIdsOf(serviceId: number): number[] {
    return [
      ...new Set(
        (this.ecm.get(serviceId) ?? []).map((entry) => entry.caSystemId),
      ),
    ].sort((a, b) => a - b);
  }

  result(): Observed {
    const arrival = (sections: number, scrambled: number): Arrival =>
      sections > 0 ? "readable" : scrambled > 0 ? "scrambled" : "absent";
    return {
      ecm: [...this.ecm.entries()]
        .sort(([a], [b]) => a - b)
        .flatMap(([, entries]) => entries),
      emm: this.emm,
      epg: arrival(this.eitSections, this.eitScrambled),
      epgOther: this.eitOther > 0,
      logo: arrival(this.cdtSections, this.cdtScrambled),
    };
  }

  private packet(packet: Uint8Array): void {
    // 誤りの印が立っているものは読まない
    if (packet[1]! & 0x80) return;
    const pid = packetPid(packet);
    if (packet[3]! >> 6 !== 0) {
      // スクランブルされている。中身は読めないので数えるだけ
      if (EIT_PIDS.has(pid)) this.eitScrambled++;
      else if (pid === PID_CDT) this.cdtScrambled++;
      return;
    }
    if (pid === PID_PAT) {
      for (const section of this.pat.feed(packet)) {
        if (section[0] === 0x00) this.patSeen = true;
        for (const pmtPid of parsePat(section).values())
          if (!this.pmts.has(pmtPid))
            this.pmts.set(pmtPid, new SectionAssembler(pmtPid));
      }
      return;
    }
    if (pid === PID_CAT) {
      for (const section of this.cat.feed(packet)) {
        if (section[0] !== 0x01) continue;
        this.emm = caEntries(section.subarray(8, section.length - 4), null);
      }
      return;
    }
    if (pid === PID_CDT) {
      for (const section of this.cdt.feed(packet))
        if (section[0] === 0xc8) this.cdtSections++;
      return;
    }
    const eit = this.eit.get(pid);
    if (eit !== undefined) {
      for (const section of eit.feed(packet)) {
        const table = section[0]!;
        // 自 TS は p/f (0x4E) と schedule (0x50〜0x5F)、ほかの TS は p/f (0x4F) と schedule (0x60〜0x6F)
        if (table === 0x4e || (table >= 0x50 && table <= 0x5f))
          this.eitSections++;
        else if (table === 0x4f || (table >= 0x60 && table <= 0x6f)) {
          this.eitSections++;
          this.eitOther++;
        }
      }
      return;
    }
    const pmt = this.pmts.get(pid);
    if (pmt === undefined) return;
    for (const section of pmt.feed(packet)) {
      if (section[0] !== 0x02) continue;
      this.pmtsSeen.add(pid);
      const serviceId = u16(section, 3);
      const entries = caEntries(pmtProgramInfo(section), serviceId);
      for (const [, , info] of pmtStreams(section))
        entries.push(...caEntries(info, serviceId));
      this.ecm.set(serviceId, unique(entries));
    }
  }
}

/** CA 記述子 (0x09) の CA_system_id と CA_PID。CA_PID の 0x1FFF は「無い」の意味なので除く */
function caEntries(data: Uint8Array, serviceId: number | null): CaEntry[] {
  const found: CaEntry[] = [];
  for (const [tag, body] of descriptors(data)) {
    if (tag !== 0x09 || body.length < 4) continue;
    const pid = u16(body, 2) & 0x1fff;
    if (pid === 0 || pid === 0x1fff) continue;
    found.push({ serviceId, caSystemId: u16(body, 0), pid });
  }
  return unique(found);
}

/** 同じ CA_system_id と PID の組を 1 つに */
function unique(entries: CaEntry[]): CaEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.caSystemId}:${entry.pid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
