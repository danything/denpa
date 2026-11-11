import { isAbsolute, relative, sep } from "node:path";

import { PACKET, SYNC } from "@danything/arib/psi";

import {
  array,
  boolean,
  type Infer,
  literal,
  object,
  optional,
  string,
  tolerate,
} from "../shape";
import { agentFetch } from "./agent-client";
import { config } from "./config";
import { openRecordingSync, type RecordingSyncHandle } from "./recording-io";

/**
 * スクランブルの検出と復号。
 *
 * カードが読めないまま録れると、**録画は成功してサイズもそれらしいのに、中身が
 * 全部スクランブルされていて ffmpeg が 1 フレームも取り出せない**、という分かりにくい
 * 壊れ方をする。
 *
 * 録画そのものは止めない (電波は二度と戻ってこないので、暗号のままでも残す)。
 * 代わりにエンコードの前に見て、掛かったままならその場で復号する。
 *
 * 復号するのはエージェント側 (`/denpa/decode`)。カードリーダーを使うのは
 * あちらなので、カードを持っている側に任せるようにしてある。元の TS の置き場は denpa とエージェントの両方から同じパスで見えるようにしてあり、
 * やり取りするのはパスだけ。
 */

/** 何パケット見るか。全部読むと数 GB の TS で時間がかかる */
const SAMPLE = 20_000;
/** これを超えていたらスクランブルされているとみなす */
const THRESHOLD = 0.5;

/**
 * TS の中でスクランブルされているパケットの割合。
 *
 * transport_scrambling_control (4 バイト目の上位 2 ビット) が立っているものを数える。
 * 正常なら 0 に近い。カードが読めていないと 98〜99% になる。
 */
export function scrambledRatio(path: string): number {
  const counted = countPackets(path);
  return counted === null || counted.total === 0
    ? 0
    : counted.scrambled / counted.total;
}

export function isScrambled(path: string): boolean {
  return scrambledRatio(path) > THRESHOLD;
}

/**
 * **復号できていると言える TS か** (有料の録画を契約の手がかりにする。`contracts.noteDecoded`)。
 * `isScrambled` の否定より厳しく、読めない・同期が取れていない・パケットが `SAMPLE` 個に届かないファイルは false にする。
 * 中身がほとんど無い録画を、復号できたことの証拠にしないため
 */
export function isDecoded(path: string): boolean {
  const counted = countPackets(path);
  return (
    counted !== null &&
    counted.total >= SAMPLE &&
    counted.scrambled / counted.total <= THRESHOLD
  );
}

/** `ServiceFilter.streams` (`種別:PID` の並び) から、映像・音声・字幕の PID。PMT を読む前は空 */
export function mediaPids(streams: string | null): Set<number> {
  const pids = new Set<number>();
  for (const one of streams?.split(",") ?? []) {
    const pid = Number(one.split(":")[1]);
    if (Number.isInteger(pid)) pids.add(pid);
  }
  return pids;
}

/**
 * **1 局に絞った TS で、映像・音声・字幕のパケットのうちスクランブルされたまま届いたものを数える** (契約の復号テストとライブ)。
 *
 * エージェントは、カードが鍵を返さなかった ES (未契約) をスクランブルされたまま流す ([docs/agent.md](../../../docs/agent.md))。
 * denpa が読むのはその印 (transport_scrambling_control)。PAT・PMT・ECM・EIT のようなセクションは掛からないので数えない
 * (割合が下がって、復号できたように見える)。ペイロードの無いパケットもスクランブルの対象にならないので数えない
 */
export class ScrambleCount {
  total = 0;
  scrambled = 0;

  /** @param limit これだけ数えたら、あとは数えない */
  constructor(readonly limit: number) {}

  /** `limit` まで数え終えた */
  get full(): boolean {
    return this.total >= this.limit;
  }

  /** パケットを 1 つ (188 バイト)。`media` はその局の映像・音声・字幕の PID (`mediaPids`) */
  feed(packet: Uint8Array, media: Set<number>): void {
    if (this.full || packet[0] !== SYNC) return;
    if (!media.has(((packet[1]! & 0x1f) << 8) | packet[2]!)) return;
    if ((packet[3]! & 0x10) === 0) return;
    this.total++;
    // 4 バイト目の上位 2 ビットが transport_scrambling_control
    if ((packet[3]! & 0xc0) !== 0) this.scrambled++;
  }

  /** 掛かったままと言えるか。数えたのが `least` 個に満たなければ言えない (false) */
  stillScrambled(least: number): boolean {
    return this.total >= least && this.scrambled / this.total > THRESHOLD;
  }
}

/**
 * **ライブで、局の映像・音声・字幕がスクランブルされたまま届き続けているかを決める** (`live.ts`)。
 *
 * 復号できる局でも、選局したての数百パケットがスクランブルされたまま届くことがある。鍵がそろう前のパケットで、
 * 本番 (2026-11-11、PT3 の地上波) ではエージェントが PMT の来ていない番組の ES をそのまま流していた ([docs/agent.md](../../../docs/agent.md))。
 * カードが鍵を返さない (未契約の) 局は、そのあとも掛かったまま届く。先頭だけで決めると、無料の局を「契約されていない」として止める。
 *
 * そこで `window` 個ずつ数え、掛かっているのが半分以下の窓が 1 つ来たら、復号できているとして数えるのをやめる (`verdict` が `clear`)。
 * 半分を超えて掛かった窓が `lasting` ミリ秒続いたら、掛かったままと決める (`scrambled`)
 */
export class LastingScramble {
  /** 決めた結果。決まるまで null */
  verdict: "clear" | "scrambled" | null = null;
  private count: ScrambleCount;
  /** 最後に数え終えた窓 */
  private done: ScrambleCount | null = null;
  /** いまの窓の最初のパケットを数えた時刻 */
  private openedAt = 0;
  /** 掛かった窓が続き始めた時刻。掛かった窓がまだ無ければ null */
  private since: number | null = null;

  constructor(
    readonly window: number,
    readonly lasting: number,
  ) {
    this.count = new ScrambleCount(window);
  }

  /** パケットを 1 つ (188 バイト)。`media` はその局の映像・音声・字幕の PID (`mediaPids`)、`now` は受けた時刻 (ミリ秒) */
  feed(packet: Uint8Array, media: Set<number>, now: number): void {
    if (this.verdict !== null) return;
    const empty = this.count.total === 0;
    this.count.feed(packet, media);
    if (empty && this.count.total > 0) this.openedAt = now;
    if (!this.count.full) return;
    this.done = this.count;
    this.count = new ScrambleCount(this.window);
    if (!this.done.stillScrambled(this.window)) {
      this.verdict = "clear";
      return;
    }
    this.since ??= this.openedAt;
    if (now - this.since >= this.lasting) this.verdict = "scrambled";
  }

  /** いちばん新しく数えた窓。いまの窓が `least` 個に届いていればそれ、届いていなければ最後に数え終えた窓 */
  newest(least: number): ScrambleCount | null {
    return this.count.total >= least ? this.count : this.done;
  }

  /**
   * **いま掛かったままと言えるか** (ffmpeg が `verdict` の決まる前に降りたとき)。いちばん新しく数えた窓 (`newest`) で決める。
   * 窓がまだ無ければ言えない (false)
   */
  stillScrambled(least: number): boolean {
    if (this.verdict !== null) return this.verdict === "scrambled";
    return this.newest(least)?.stillScrambled(least) ?? false;
  }
}

/** 先頭から `SAMPLE` 個までのパケットの数と、そのうちスクランブルされている数。読めない・同期が取れていないファイルは null */
function countPackets(
  path: string,
): { total: number; scrambled: number } | null {
  let file: RecordingSyncHandle;
  try {
    file = openRecordingSync(path);
  } catch {
    return null;
  }

  try {
    const buffer = Buffer.alloc(PACKET * 1000);
    let total = 0;
    let scrambled = 0;
    let offset = 0;

    while (total < SAMPLE) {
      const read = file.read(buffer, 0, buffer.length, offset);
      if (read < PACKET) break;
      offset += read;

      for (let i = 0; i + PACKET <= read; i += PACKET) {
        // 同期が取れていないファイルは判定しない。誤って復号に回すより素通しがまし
        if (buffer[i] !== SYNC) return null;
        total++;
        if ((buffer[i + 3]! & 0xc0) !== 0) scrambled++;
      }
    }
    return { total, scrambled };
  } finally {
    file.close();
  }
}

/** `/denpa/card` の 1 行。リーダー 1 つ */
const CARD_READER = object({
  name: string,
  /** カードが読めたか */
  card: boolean,
  /** カードの番号 (10 進 16 桁) */
  ids: array(string),
  /** 鍵の出どころが使っているリーダー。**使うのは 1 枚だけ** (他は予備) */
  active: boolean,
  /** このカードで復号しているチューナー */
  tuners: array(string),
  /** カードを読めなかった理由。挿さっていないだけなら無い */
  error: optional(string),
  /** 使わない設定のリーダー。開いていないので、カードの有無も分からない */
  disabled: optional(boolean),
});

/** エージェントの `/denpa/card` の答え。形式はここで確かめる (`shape.ts`) */
const CARD_STATUS = object({
  ok: boolean,
  /** 困っているときだけの一言。読めているときは空 */
  message: string,
  /** 手元のカードか、鍵を配る相手 (CARD_URL) か */
  source: literal("local", "remote"),
  /** 鍵を配る相手の URL (`source: 'remote'` のとき) */
  remote: optional(string),
  /** 配る相手のカードの番号と、それで復号しているチューナー (`source: 'remote'` のとき) */
  ids: optional(array(string)),
  tuners: optional(array(string)),
  readers: array(CARD_READER),
});

/** 画面での呼び分け */
export type CardReaderState =
  "active" | "standby" | "empty" | "error" | "disabled";

type CardReader = {
  name: string;
  state: CardReaderState;
  ids: string[];
  tuners: string[];
  error?: string;
};

export type CardStatus = {
  ok: boolean;
  message: string;
  source: "local" | "remote";
  remote?: string;
  ids: string[];
  tuners: string[];
  readers: CardReader[];
};

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** 来たままの形式。**どのキーも無いかもしれない**として読む */
type Loose<T> = { [K in keyof T]?: unknown };

function stateOf(row: Loose<Infer<typeof CARD_READER>>): CardReaderState {
  if (row.disabled === true) return "disabled";
  if (row.active === true) return "active";
  if (row.card === true) return "standby";
  return typeof row.error === "string" ? "error" : "empty";
}

/**
 * 画面に渡す形式に揃える。**形式が違っても止めない** (`tolerate`) ので、ここは来たものを
 * 疑って読む
 */
function normalize(raw: unknown): CardStatus {
  const body: Loose<Infer<typeof CARD_STATUS>> =
    typeof raw === "object" && raw !== null ? raw : {};
  const readers = (
    Array.isArray(body.readers) ? (body.readers as unknown[]) : []
  ).map((entry): CardReader => {
    const row: Loose<Infer<typeof CARD_READER>> =
      typeof entry === "object" && entry !== null ? entry : {};
    return {
      name: typeof row.name === "string" ? row.name : "",
      state: stateOf(row),
      ids: strings(row.ids),
      tuners: strings(row.tuners),
      ...(typeof row.error === "string" ? { error: row.error } : {}),
    };
  });
  return {
    ok: body.ok === true,
    message: typeof body.message === "string" ? body.message : "",
    source: body.source === "remote" ? "remote" : "local",
    ...(typeof body.remote === "string" ? { remote: body.remote } : {}),
    ids: strings(body.ids),
    tuners: strings(body.tuners),
    readers,
  };
}

/** エージェントの答えを読む。**形式が違えば 1 回だけ警告して、読めるだけ読む** */
export function readCardStatus(raw: unknown): CardStatus {
  return normalize(tolerate(CARD_STATUS, raw, "エージェントの /denpa/card"));
}

/** 確かめられなかった。読めていない手元のカードとして、理由だけ出す */
function failed(message: string): CardStatus {
  return normalize({ message });
}

/**
 * 使わないカードリーダーを入れ替える (設定の「受信」のカードリーダーの表のスイッチ)。
 * 渡すのは使わないリーダーの名前の一覧。使っている最中のリーダーなら、エージェントが手放して次のリーダーで繋ぎ直す
 */
export async function putCardReaders(disabled: string[]): Promise<void> {
  const res = await agentFetch("/denpa/card/readers", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disabled }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(
      `カードリーダーの設定を保存できません (${res.status}) ${await res.text()}`,
    );
  }
}

/** `/denpa/decode` の答え。断られたときは `error` に理由 */
const DECODED = object({ ok: optional(boolean), error: optional(string) });

/**
 * カードリーダーの状態。設定画面に出す。
 *
 * リーダーが見えていてもカードを読めていないことがある (挿さっていない・USB が黙る)。
 * そのまま録ると上に書いた壊れ方になるので、画面から見えるようにしてある。
 */
export async function cardStatus(): Promise<CardStatus> {
  try {
    const res = await agentFetch("/denpa/card", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return failed(
        `エージェントからカードの状態を取得できません (${res.status})`,
      );
    }
    return readCardStatus(await res.json());
  } catch (error) {
    return failed(`カードの状態を確かめるエージェントに繋がりません: ${error}`);
  }
}

/**
 * スクランブルを復号する。成功したら output に復号できた TS が出来ている。
 *
 * 渡すのはパスだけで、TS そのものは流さない。元の TS の置き場はエージェント側にも
 * 見せてあるので、読むのも書くのも向こうが直接する。数十 GB になることがあり、
 * HTTP で往復させる意味が無い (そもそも Bun の fetch は送りながら受け取れず、
 * 大きいものを渡すと詰まる)。
 *
 * **返事だけでは信じない。** 出来上がったものを読み、掛かったままなら失敗にする。
 */
export async function descramble(
  input: string,
  output: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error: string; stillScrambled?: boolean }> {
  /*
   * 向こうのマウント先はこちらと同じとは限らないので、元の TS の置き場からの相対で渡す。
   * 掛かったままの TS は必ずここにある (引き継いだ録画も、移行のときに
   * 未エンコードのものは元の TS としてここへ入る)
   */
  const base = config.rawDir;
  // 区切りは / にそろえる (Windows の `\` のまま渡すと、Linux のエージェントには 1 つの名前に見える)
  const from = relative(base, input).split(sep).join("/");
  const to = relative(base, output).split(sep).join("/");
  if (
    from.startsWith("..") ||
    to.startsWith("..") ||
    isAbsolute(from) ||
    isAbsolute(to)
  ) {
    return {
      ok: false,
      error: `元の TS の保存先 (${base}) の外にあるファイルは復号できません`,
    };
  }

  try {
    // 復号は数十分かかることがある。中止を押されたらここで切る
    const res = await agentFetch("/denpa/decode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: from, output: to }),
      signal: signal ?? null,
    });
    const body = tolerate(
      DECODED,
      await res.json(),
      "エージェントの /denpa/decode",
    );
    if (!res.ok || body.ok !== true) {
      return {
        ok: false,
        error:
          body.error ??
          `エージェントへの復号のリクエストが失敗しました (${res.status})`,
      };
    }
  } catch (error) {
    return { ok: false, error: `復号するエージェントに繋がりません: ${error}` };
  }

  if (isScrambled(output)) {
    // 素通しされた。ほぼカードが読めていない
    const card = await cardStatus();
    const why = card.ok
      ? "カードは読めているので、鍵が合わないか ECM が流れていません"
      : card.message;
    // カードは読めていて掛かったまま = 鍵を貰えなかった (契約が無い・切れたことが多い。`contracts.noteStillScrambled`)
    return {
      ok: false,
      error: `復号してもスクランブルが残っています。${why}`,
      stillScrambled: card.ok,
    };
  }
  return { ok: true, error: "" };
}
