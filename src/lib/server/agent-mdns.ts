/**
 * **LAN でエージェントを見つける** (mDNS / DNS-SD。docs/agent.md「LAN で見つける」)。
 *
 * エージェントは `_denpa-agent._tcp` を知らせる (agent/Denpa.Agent/Mdns.cs。Android はアプリが `NsdManager` で)。
 * TXT は `v=1`・`id` (証明書の指紋の先頭 16 字)・`name` だけで、**合言葉は入らない**。見つけたものは次の 2 つに使う。
 *
 * - 設定の「エージェントを追加」の候補に出す。組むには今どおり登録用の URL (合言葉入り) が要る
 * - 登録したエージェントのアドレスが変わったら付け替える (`agent-admin.followAgent`)。保存した証明書で繋がった相手にだけ付け替えるので、
 *   偽の答えで起きるのは「繋がりません」だけ
 *
 * UDP 5353 を開いて 224.0.0.251 に入り、問いを送って、答えとアナウンス (エージェントが起動したとき・アドレスが変わったときに送るもの) を受ける。5353 を開けなければ空いたポートで問い、
 * 答えをこちらにだけ返してもらう (legacy unicast。アナウンスは受けられない)。
 * **コンテナのブリッジや Kubernetes の Pod のネットワークでは LAN のマルチキャストが届かない** (推定)。そのときは候補が出ないだけで、
 * 登録は URL か QR のまま
 */
import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";

/** 見つけたエージェント 1 台 */
export interface FoundAgent {
  /** 証明書の指紋の先頭 16 字 (TXT の `id`) */
  id: string;
  /** TXT の `name` */
  name: string;
  /** IPv4 のアドレス。答えに A があればそれ、無ければ答えの送り元 */
  host: string;
  port: number;
  /** 最後に答えかアナウンスを受けた時刻 */
  seenAt: number;
}

const GROUP = "224.0.0.251";
const MDNS_PORT = 5353;
const SERVICE = "_denpa-agent._tcp.local";
/** 問い直す間。アナウンス (起動したとき・アドレスが変わったとき) はそのつど受ける */
const QUERY_EVERY = 5 * 60_000;
/** 問いを続けて送らない間 (設定の画面を何度開いても) */
const QUERY_GAP = 5_000;
/** 答えを待つ間 (設定の画面の候補) */
const ANSWER_WAIT = 1_500;
/** 答えなくなったものを忘れるまで */
const FORGET_AFTER = 2 * QUERY_EVERY;
/** 控えるインスタンスの数の上限。偽のインスタンス名を大量に送られても増え続けないよう、超えたら古いものから忘れる */
const MAX_INSTANCES = 64;

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const CLASS_IN = 1;

// --- パケット ---------------------------------------------------------------

/** 名前をラベルの並びで書く */
function writeName(out: number[], name: string): void {
  for (const label of name.split(".")) {
    const bytes = new TextEncoder().encode(label);
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
}

/** 問い。`questions` は名前と型の組。`id` は legacy unicast のときだけ 0 以外 */
export function queryPacket(
  questions: { name: string; type: number }[],
  id = 0,
): Uint8Array {
  const out = [id >> 8, id & 0xff, 0, 0, 0, questions.length, 0, 0, 0, 0, 0, 0];
  for (const question of questions) {
    writeName(out, question.name);
    out.push(question.type >> 8, question.type & 0xff, 0, CLASS_IN);
  }
  return Uint8Array.from(out);
}

/** 読んだ記録 1 つ */
export interface MdnsRecord {
  name: string;
  type: number;
  ttl: number;
  /** PTR と SRV の宛先 */
  target?: string | undefined;
  /** SRV のポート */
  port?: number | undefined;
  /** TXT の `key=value` */
  txt?: Map<string, string> | undefined;
  /** A のアドレス */
  address?: string;
}

/** 名前を読む (圧縮を辿る)。読めなければ null */
function readName(
  packet: Uint8Array,
  start: number,
): { name: string; next: number } | null {
  const labels: string[] = [];
  let at = start;
  let next = -1;
  for (let hops = 0; hops < 128; hops++) {
    if (at >= packet.length) return null;
    const length = packet[at]!;
    if (length === 0) {
      return { name: labels.join("."), next: next < 0 ? at + 1 : next };
    }
    if ((length & 0xc0) === 0xc0) {
      if (at + 1 >= packet.length) return null;
      if (next < 0) next = at + 2;
      at = ((length & 0x3f) << 8) | packet[at + 1]!;
      continue;
    }
    if ((length & 0xc0) !== 0 || at + 1 + length > packet.length) return null;
    labels.push(
      new TextDecoder().decode(packet.subarray(at + 1, at + 1 + length)),
    );
    at += 1 + length;
  }
  return null;
}

/** TXT の中身 (長さ付きの文字列の並び) を `key=value` で読む */
function readTxt(data: Uint8Array): Map<string, string> {
  const entries = new Map<string, string>();
  for (let at = 0; at < data.length;) {
    const length = data[at]!;
    const text = new TextDecoder().decode(
      data.subarray(at + 1, at + 1 + length),
    );
    at += 1 + length;
    const equals = text.indexOf("=");
    if (equals > 0)
      entries.set(text.slice(0, equals).toLowerCase(), text.slice(equals + 1));
  }
  return entries;
}

/** 答えのパケットの記録を全部読む (答え・権威・追加の欄)。問いや読めないものは null */
export function readResponse(packet: Uint8Array): MdnsRecord[] | null {
  if (packet.length < 12) return null;
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );
  if ((view.getUint16(2) & 0x8000) === 0) return null;
  const questions = view.getUint16(4);
  const count = view.getUint16(6) + view.getUint16(8) + view.getUint16(10);
  let at = 12;
  for (let index = 0; index < questions; index++) {
    const name = readName(packet, at);
    if (name === null) return null;
    at = name.next + 4;
  }
  const records: MdnsRecord[] = [];
  for (let index = 0; index < count; index++) {
    const name = readName(packet, at);
    if (name === null || name.next + 10 > packet.length) return null;
    at = name.next;
    const type = view.getUint16(at);
    const ttl = view.getUint32(at + 4);
    const length = view.getUint16(at + 8);
    at += 10;
    if (at + length > packet.length) return null;
    const record: MdnsRecord = { name: name.name, type, ttl };
    if (type === TYPE_PTR) record.target = readName(packet, at)?.name;
    if (type === TYPE_SRV && length >= 7) {
      record.port = view.getUint16(at + 4);
      record.target = readName(packet, at + 6)?.name;
    }
    if (type === TYPE_TXT)
      record.txt = readTxt(packet.subarray(at, at + length));
    if (type === TYPE_A && length === 4) {
      record.address = Array.from(packet.subarray(at, at + 4)).join(".");
    }
    records.push(record);
    at += length;
  }
  return records;
}

// --- 見つけたものの控え ------------------------------------------------------

/** インスタンス 1 つ分の控え (SRV と TXT が別のパケットで来ることもある) */
interface Instance {
  port?: number | undefined;
  target?: string | undefined;
  txt?: Map<string, string> | undefined;
  /** SRV の宛先の A。無ければ送り元 */
  address?: string;
  source: string;
  seenAt: number;
}

/** 見つけたものの控え。パケットを受けるたびに足し、TTL 0 (さよなら) で消す */
export class Sightings {
  readonly instances = new Map<string, Instance>();

  /**
   * 答え 1 つを控えに入れる。`source` は送り元のアドレス。
   * 戻り値は、SRV か TXT が足りないインスタンス (問い直す) と、そろったエージェント
   */
  take(
    records: MdnsRecord[],
    source: string,
    now = Date.now(),
  ): { missing: string[]; found: FoundAgent[] } {
    const addresses = new Map<string, string>();
    for (const record of records) {
      if (record.type === TYPE_A && record.address !== undefined)
        addresses.set(record.name.toLowerCase(), record.address);
    }
    const touched = new Set<string>();
    const touch = (name: string): Instance | null => {
      const key = name.toLowerCase();
      if (!key.endsWith(`.${SERVICE}`)) return null;
      let entry = this.instances.get(key);
      if (entry === undefined) {
        if (this.instances.size >= MAX_INSTANCES) this.forgetOldest();
        entry = { source, seenAt: now };
        this.instances.set(key, entry);
      }
      entry.source = source;
      entry.seenAt = now;
      touched.add(key);
      return entry;
    };
    for (const record of records) {
      const owner =
        record.type === TYPE_PTR && record.name.toLowerCase() === SERVICE
          ? record.target
          : record.type === TYPE_SRV || record.type === TYPE_TXT
            ? record.name
            : undefined;
      if (owner === undefined) continue;
      if (record.ttl === 0) {
        this.instances.delete(owner.toLowerCase());
        touched.delete(owner.toLowerCase());
        continue;
      }
      const entry = touch(owner);
      if (entry === null) continue;
      if (record.type === TYPE_SRV) {
        entry.port = record.port;
        entry.target = record.target;
      }
      if (record.type === TYPE_TXT) entry.txt = record.txt;
    }
    const missing: string[] = [];
    const found: FoundAgent[] = [];
    for (const key of touched) {
      const entry = this.instances.get(key)!;
      const address =
        entry.target === undefined
          ? undefined
          : addresses.get(entry.target.toLowerCase());
      if (address !== undefined) entry.address = address;
      if (entry.port === undefined || entry.txt === undefined) {
        missing.push(key);
        continue;
      }
      const agent = agentOf(entry);
      if (agent !== null) found.push(agent);
    }
    return { missing, found };
  }

  /** 答えなくなったもの (`FORGET_AFTER` を過ぎたもの) を忘れる。問い直すたびと `list` で呼ぶ */
  prune(now = Date.now()): void {
    for (const [key, entry] of this.instances) {
      if (now - entry.seenAt > FORGET_AFTER) this.instances.delete(key);
    }
  }

  /** いちばん古いものを 1 つ忘れる (上限を超えたとき) */
  private forgetOldest(): void {
    let oldest: [string, number] | null = null;
    for (const [key, entry] of this.instances) {
      if (oldest === null || entry.seenAt < oldest[1])
        oldest = [key, entry.seenAt];
    }
    if (oldest !== null) this.instances.delete(oldest[0]);
  }

  /** `since` より後に答えたエージェント。古いものはここで忘れる */
  list(since: number, now = Date.now()): FoundAgent[] {
    this.prune(now);
    const found: FoundAgent[] = [];
    for (const entry of this.instances.values()) {
      if (entry.seenAt < since) continue;
      const agent = agentOf(entry);
      if (agent !== null) found.push(agent);
    }
    return found;
  }
}

/** そろった控えをエージェントにする。TXT の決まりが違う (`v` が 1 でない・`id` が読めない) ものは使わない */
function agentOf(entry: Instance): FoundAgent | null {
  const id = entry.txt?.get("id")?.toLowerCase();
  if (
    entry.txt?.get("v") !== "1" ||
    id === undefined ||
    !/^[0-9a-f]{16}$/.test(id)
  )
    return null;
  if (entry.port === undefined || entry.port === 0) return null;
  return {
    id,
    name:
      entry.txt?.get("name")?.trim() ||
      entry.target?.replace(/\.local$/i, "") ||
      id,
    host: entry.address ?? entry.source,
    port: entry.port,
    seenAt: entry.seenAt,
  };
}

// --- 受ける ----------------------------------------------------------------

/** この機械の IPv4 のアドレス (ループバックを除く)。インターフェースごとに問いを送り、224.0.0.251 に入る */
function interfaces(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map((address) => address.address);
}

let socket: Socket | null = null;
/** 5353 を開けず、空いたポートで問うているか (答えはこちらにだけ返る) */
let legacy = false;
let sightings = new Sightings();
let lastQuery = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let onFound: ((agent: FoundAgent) => void) | null = null;
/** SRV と TXT を問い直した時刻 (インスタンス →)。PTR だけのパケットが続いても、1 つにつき `QUERY_GAP` に 1 回しか問わない */
let asked = new Map<string, number>();

/** 224.0.0.251 に、全部のインターフェースで入る (もう入っていれば何もしない) */
function join(): void {
  if (socket === null || legacy) return;
  for (const address of interfaces()) {
    try {
      socket.addMembership(GROUP, address);
    } catch {
      // もう入っている・入れないインターフェース
    }
  }
}

/** 問いを全部のインターフェースから送る */
function send(packet: Uint8Array): void {
  if (socket === null) return;
  const list = interfaces();
  for (const address of list.length > 0 ? list : [null]) {
    try {
      if (address !== null) socket.setMulticastInterface(address);
      socket.send(packet, MDNS_PORT, GROUP);
    } catch {
      // 消えかけのインターフェース
    }
  }
}

/** `_denpa-agent._tcp.local` を問う。続けては送らない */
function query(): void {
  const now = Date.now();
  if (socket === null || now - lastQuery < QUERY_GAP) return;
  lastQuery = now;
  join();
  send(
    queryPacket(
      [{ name: SERVICE, type: TYPE_PTR }],
      legacy ? 1 + Math.floor(Math.random() * 0xfffe) : 0,
    ),
  );
}

function receive(message: Buffer, source: string): void {
  const records = readResponse(new Uint8Array(message));
  if (records === null) return;
  const now = Date.now();
  const { missing, found } = sightings.take(records, source, now);
  const ask = missing.filter(
    (name) => now - (asked.get(name) ?? 0) >= QUERY_GAP,
  );
  if (ask.length > 0) {
    if (asked.size > 256) asked.clear();
    for (const name of ask) asked.set(name, now);
    send(
      queryPacket(
        ask.flatMap((name) => [
          { name, type: TYPE_SRV },
          { name, type: TYPE_TXT },
        ]),
        legacy ? 1 + Math.floor(Math.random() * 0xfffe) : 0,
      ),
    );
  }
  for (const agent of found) onFound?.(agent);
}

/** 開く。5353 を開けなければ空いたポートで開き直す。どちらも開けなければ、見つけるのをやめる */
function open(port: number): void {
  const next = createSocket({ type: "udp4", reuseAddr: true });
  next.on("message", (message, from) => receive(message, from.address));
  next.once("error", (error) => {
    next.close();
    if (socket !== next) {
      // 開く途中。5353 が駄目なら空いたポートで
      if (port === MDNS_PORT) {
        open(0);
        return;
      }
      console.warn(
        `[agent] LAN でエージェントを見つけられません (mDNS): ${error.message}。登録は登録用の URL でできます`,
      );
      return;
    }
    socket = null;
    console.warn(
      `[agent] LAN でエージェントを見つけるのをやめました (mDNS): ${error.message}`,
    );
  });
  next.bind(port, () => {
    socket = next;
    legacy = port !== MDNS_PORT;
    try {
      next.setMulticastTTL(255);
    } catch {
      // 既定のまま
    }
    lastQuery = 0;
    query();
  });
}

/**
 * **検出を始める** (起動したときに 1 回。runtime.ts)。`found` は答えかアナウンスでエージェントがそろうたびに呼ぶ
 * (アドレスを追う。`agent-admin.followAgent`)
 */
export function startDiscovery(found: (agent: FoundAgent) => void): void {
  if (timer !== null) return;
  onFound = found;
  open(MDNS_PORT);
  timer = setInterval(() => {
    sightings.prune();
    query();
  }, QUERY_EVERY);
  timer.unref?.();
}

/** やめる (試験から) */
export function stopDiscovery(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  socket?.close();
  socket = null;
  onFound = null;
  sightings = new Sightings();
  asked = new Map();
  lastQuery = 0;
}

/**
 * **いま LAN で答えるエージェント** (設定の「エージェントを追加」の候補)。問い直して少し待ち、問いのあとに答えたものを返す。
 * 検出を始めていない (自動の処理を止めている) か、ソケットを開けなかったときは空
 */
export async function discoverAgents(
  wait = ANSWER_WAIT,
): Promise<FoundAgent[]> {
  if (socket === null) return [];
  query();
  const since = lastQuery - 1000;
  await Bun.sleep(wait);
  return sightings.list(since).sort((a, b) => a.name.localeCompare(b.name));
}
