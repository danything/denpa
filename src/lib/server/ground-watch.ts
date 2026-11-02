/**
 * **地上波は再編に付いていかず、知らせるだけにする。**
 *
 * 地上波の NIT には自分の TS の分しか載らないので、中継局の周波数が変わっても、ほかの局の行き先は分からない
 * (市販のテレビも「再スキャンしてください」と知らせる)。知らせるのは 2 つ。
 *
 * - **続けて選局できないチャンネル** (`reception.failingGround`)。周波数が変わったなら、スキャンし直せば選局できる
 * - **局の顔ぶれが控えと違うチャンネル。** 番組表集めがチャンネルを開いたときに NIT を読み、そのチャンネルに入っている
 *   局 (テレビ) を控え (スキャンの結果) と比べる。局が増えた・減ったなら、スキャンし直せば入る
 *
 * どちらもお知らせの 1 行 (録画・番組表・ライブの上) に出し、起きたときに通知の「チャンネルの変更」も送る。
 * スキャンし直すか、受信できるようになれば消える
 */
import { NitReader } from "@danything/arib/psi";

import { failingGround } from "./reception";
import type { AgentChannel } from "./tuner";
import { notify } from "./webhook";

/** 局の顔ぶれが控えと違ったチャンネル (名前 → 違いの印。同じ違いは 1 回だけ知らせる) */
const mismatched = new Map<string, string>();

/** 通知を送った文。同じ文は 2 度送らない */
const notified = new Set<string>();

/** 番組表集めがチャンネルを読むついでに、NIT を読む長さ (地上波の NIT は 10 秒に 1 回は流れる) */
const WATCH_FOR = 15_000;

/** テレビの局のサービス ID を並べた印 */
const shapeOf = (ids: Iterable<number>) =>
  [...ids].sort((a, b) => a - b).join(",");

/**
 * 地上波のチャンネルの NIT を読み、局の顔ぶれを控えと比べる。違えば覚え、同じなら忘れる。
 * NIT に自分の TS が無ければ比べない
 */
export function compareGround(channel: AgentChannel, nit: NitReader): void {
  const network = nit.actual;
  if (network === null) return;
  const ts = network.transportStreams.find(
    (candidate) => candidate.transportStreamId === channel.transportStreamId,
  );
  if (ts === undefined) return;
  const broadcast = shapeOf(
    ts.services
      .filter((service) => service.serviceType === 0x01)
      .map((service) => service.serviceId),
  );
  const kept = shapeOf(
    channel.services
      .filter((service) => service.serviceType === 0x01)
      .map((service) => service.serviceId),
  );
  if (broadcast === kept) mismatched.delete(channel.channel);
  else mismatched.set(channel.channel, broadcast);
}

/** 控えに無くなったチャンネルの違いを忘れる (スキャンし直した) */
export function forgetGround(channels: readonly AgentChannel[]): void {
  const listed = new Set(
    channels.filter((c) => c.type === "GR").map((c) => c.channel),
  );
  for (const channel of mismatched.keys()) {
    if (!listed.has(channel)) mismatched.delete(channel);
  }
}

/** お知らせの 1 行。知らせることが無ければ null */
export function groundNotice(): string | null {
  const failing = failingGround();
  const text =
    failing.length > 0
      ? `${failing.join("・")} を続けて選局できません。周波数が変わった場合は、地上波をスキャンし直すと選局できます`
      : mismatched.size > 0
        ? `${[...mismatched.keys()]
            .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
            .join(
              "・",
            )} の局が、受信できるチャンネルと違います。地上波をスキャンし直すと、新しい局を選局できます`
        : null;
  return text;
}

/**
 * 地上波のチャンネルを読み終えたあとに呼ぶ (`epg-collect.ts`)。知らせることが新しく起きていたら、通知を送る。
 * 同じ文は 2 度送らない
 */
export function alertGround(): void {
  const text = groundNotice();
  if (text === null || notified.has(text)) return;
  notified.add(text);
  console.warn(`[channels] ${text}`);
  notify({ event: "channels.changed", text });
}

/**
 * **番組表集めのついでに、地上波の NIT を読む** (`epg-collect.ts`)。開いてから `WATCH_FOR` の間だけ読み、
 * 閉じたら `compareGround` で控えと比べる
 */
export class GroundWatch {
  readonly nit = new NitReader();
  private readonly until = Date.now() + WATCH_FOR;

  constructor(private readonly channel: AgentChannel) {}

  feed(chunk: Uint8Array): void {
    if (Date.now() > this.until || this.nit.actual !== null) return;
    this.nit.feed(chunk);
  }

  compare(): void {
    compareGround(this.channel, this.nit);
  }
}
