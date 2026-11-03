/**
 * **地上波は再編に付いていかず、知らせるだけにする。**
 *
 * 地上波の NIT には自分の TS の分しか載らないので、中継局の周波数が変わっても、ほかの局の行き先は分からない
 * (市販のテレビも「再スキャンしてください」と知らせる)。知らせるのは 2 つ。
 *
 * - **続けて選局できないチャンネル** (`reception.failingGround`)。周波数が変わったなら、スキャンし直せば選局できる
 * - **局の顔ぶれがスキャンの結果と違うチャンネル。** 番組表の取得がチャンネルを開いたときに SDT を読み、そのチャンネルに入っている
 *   局 (テレビ) をスキャンの結果と比べる。局が増えた・減ったなら、スキャンし直せば入る
 *
 * どちらもお知らせの 1 行 (録画・番組表・ライブの上) に出し、起きたときに通知の「チャンネルの変更」も送る。
 * スキャンし直すか、受信できるようになれば消える
 */
import { SdtReader, type TransportInfo } from "@danything/arib/psi";

import { failingGround } from "./reception";
import type { AgentChannel } from "./tuner";
import { notify } from "./webhook";

/** 局の顔ぶれがスキャンの結果と違ったチャンネル (名前 → 放送の局のサービス ID の並び) */
const mismatched = new Map<string, string>();

/** 通知を送った文。同じ文は 2 度送らない */
const notified = new Set<string>();

/** 番組表の取得がチャンネルを読むついでに、SDT を読む長さ (SDT は 2 秒に 1 回は流れる) */
const WATCH_FOR = 15_000;

/** テレビの局のサービス ID を並べた文字列 (比べるため) */
const shapeOf = (ids: Iterable<number>) =>
  [...ids].sort((a, b) => a - b).join(",");

/**
 * 地上波のチャンネルの SDT (自分の TS の局の一覧) を、スキャンの結果と比べる。違えば覚え、同じなら忘れる。
 * **スキャンと同じ SDT で比べる** (スキャンも SDT の局を保存する。NIT と比べると、NIT にだけ載る局で毎回違って見える)。
 * 読めなかったとき・別の TS の表のときは比べない
 */
export function compareGround(
  channel: AgentChannel,
  ts: TransportInfo | null,
): void {
  if (ts === null || ts.transportStreamId !== channel.transportStreamId) return;
  /*
   * 局の一覧 (サービス記述子) の無い SDT では比べない。ロゴの対応だけを載せた SDT が先にそろうことがあり
   * (偽の放送がそう)、比べると局が全部消えたように見える
   */
  if (ts.services.length === 0) return;
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

/** スキャンの結果から無くなったチャンネルの違いを忘れる (スキャンし直した) */
export function forgetGround(channels: readonly AgentChannel[]): void {
  const listed = new Set(
    channels.filter((c) => c.type === "GR").map((c) => c.channel),
  );
  for (const channel of mismatched.keys()) {
    if (!listed.has(channel)) mismatched.delete(channel);
  }
}

/** 知らせること (続けて選局できない・局の顔ぶれが違う)。どちらも無ければ空 */
function groundTexts(): string[] {
  const texts: string[] = [];
  const failing = failingGround();
  if (failing.length > 0)
    texts.push(
      `${failing.join("・")} を続けて選局できません。周波数が変わった場合は、地上波をスキャンし直すと選局できます`,
    );
  if (mismatched.size > 0) {
    const channels = [...mismatched.keys()].sort((a, b) =>
      a.localeCompare(b, "en", { numeric: true }),
    );
    texts.push(
      `${channels.join("・")} の局が、受信できるチャンネルと違います。地上波をスキャンし直すと、新しい局を選局できます`,
    );
  }
  return texts;
}

/** お知らせの 1 行。両方あれば、選局できないほうを出す。知らせることが無ければ null */
export function groundNotice(): string | null {
  return groundTexts()[0] ?? null;
}

/**
 * 地上波のチャンネルを読み終えたあとに呼ぶ (`epg-collect.ts`)。知らせることが新しく起きていたら、通知を送る。
 * 同じ文は続いている間は 2 度送らず、消えたら忘れる (また起きたら送る)。再起動すると、続いているものも 1 度送り直す
 */
export function alertGround(): void {
  const texts = groundTexts();
  for (const text of notified) if (!texts.includes(text)) notified.delete(text);
  for (const text of texts) {
    if (notified.has(text)) continue;
    notified.add(text);
    console.warn(`[channels] ${text}`);
    notify({ event: "channels.changed", text });
  }
}

/**
 * **番組表の取得のついでに、地上波の SDT を読む** (`epg-collect.ts`)。開いてから `WATCH_FOR` の間だけ読み、
 * 閉じたら `compareGround` でスキャンの結果と比べる
 */
export class GroundWatch {
  readonly sdt = new SdtReader();
  /** 読むのをやめる時刻。最初の塊が届いた時刻から数える (選局を待つ間は数えない) */
  private until: number | null = null;

  constructor(private readonly channel: AgentChannel) {}

  feed(chunk: Uint8Array): void {
    this.until ??= Date.now() + WATCH_FOR;
    if (Date.now() > this.until || this.sdt.actual !== null) return;
    this.sdt.feed(chunk);
  }

  compare(): void {
    compareGround(this.channel, this.sdt.actual);
  }
}
