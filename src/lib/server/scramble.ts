import { closeSync, openSync, readSync } from "node:fs";
import { relative } from "node:path";

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
import { config } from "./config";

/**
 * スクランブルの検出と復号。
 *
 * カードが読めないまま録れると、**録画は成功してサイズもそれらしいのに、中身が
 * 全部スクランブルされていて ffmpeg が1フレームも取り出せない**、という分かりにくい
 * 壊れ方をする。
 *
 * 録画そのものは止めない(電波は二度と戻ってこないので、暗号のままでも残す)。
 * 代わりにエンコードの前に見て、掛かったままならその場で復号する。
 *
 * 復号するのはエージェント側 (`/denpa/decode`)。カードリーダーを使うのは
 * あちらなので、カードを持っている側に任せるようにしてある。元のTSの置き場は両方のコンテナに見せてあり、
 * やり取りするのはパスだけ。
 */

/** 何パケット見るか。全部読むと数GBのTSで時間がかかる */
const SAMPLE = 20_000;
/** これを超えていたらスクランブルされているとみなす */
const THRESHOLD = 0.5;

/**
 * TS の中でスクランブルされているパケットの割合。
 *
 * transport_scrambling_control (4バイト目の上位2ビット) が立っているものを数える。
 * 正常なら 0 に近い。カードが読めていないと 98〜99% になる。
 */
export function scrambledRatio(path: string): number {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return 0;
  }

  try {
    const buffer = Buffer.alloc(PACKET * 1000);
    let total = 0;
    let scrambled = 0;
    let offset = 0;

    while (total < SAMPLE) {
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      if (read < PACKET) break;
      offset += read;

      for (let i = 0; i + PACKET <= read; i += PACKET) {
        // 同期が取れていないファイルは判定しない。誤って復号に回すより素通しがまし
        if (buffer[i] !== SYNC) return 0;
        total++;
        if ((buffer[i + 3]! & 0xc0) !== 0) scrambled++;
      }
    }
    return total === 0 ? 0 : scrambled / total;
  } finally {
    closeSync(fd);
  }
}

export function isScrambled(path: string): boolean {
  return scrambledRatio(path) > THRESHOLD;
}

/** `/denpa/card` の1行。リーダー1つ */
const CARD_READER = object({
  name: string,
  /** カードが読めたか */
  card: boolean,
  /** カードの番号 (10進16桁) */
  ids: array(string),
  /** 鍵の出どころが使っているリーダー。**使うのは1枚だけ** (他は予備) */
  active: boolean,
  /** このカードで復号しているチューナー */
  tuners: array(string),
  /** 覗けなかった理由。挿さっていないだけなら無い */
  error: optional(string),
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

/** 画面での呼び分け。`unknown` は前のバージョンのエージェント (名前しか返さない) */
export type CardReaderState =
  "active" | "standby" | "empty" | "error" | "unknown";

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

/** 来たままの形式。**どの鍵も無いかもしれない**として読む */
type Loose<T> = { [K in keyof T]?: unknown };

function stateOf(row: Loose<Infer<typeof CARD_READER>>): CardReaderState {
  if (row.active === true) return "active";
  if (row.card === true) return "standby";
  return typeof row.error === "string" ? "error" : "empty";
}

/**
 * 画面に渡す形式に揃える。**形式が違っても止めない** (`tolerate`) ので、ここは来たものを
 * 疑って読む。前のバージョンのエージェントは `readers` がリーダーの名前の並びで、
 * 名前と番号は `message` に書いてある — 行は名前だけ出し、状態は「—」にする
 */
function normalize(raw: unknown): CardStatus {
  const body: Loose<Infer<typeof CARD_STATUS>> =
    typeof raw === "object" && raw !== null ? raw : {};
  const readers = (
    Array.isArray(body.readers) ? (body.readers as unknown[]) : []
  ).map((entry): CardReader => {
    if (typeof entry === "string")
      return { name: entry, state: "unknown", ids: [], tuners: [] };
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

/** エージェントの答えを読む。**形式が違えば1回だけ警告して、読めるだけ読む** */
export function readCardStatus(raw: unknown): CardStatus {
  return normalize(tolerate(CARD_STATUS, raw, "エージェントの /denpa/card"));
}

/** 確かめられなかった。読めていない手元のカードとして、理由だけ出す */
function failed(message: string): CardStatus {
  return normalize({ message });
}

/** `/denpa/decode` の答え。断られたときは `error` に理由 */
const DECODED = object({ ok: optional(boolean), error: optional(string) });

/**
 * カードリーダーの状態。設定画面に出す。
 *
 * リーダーが見えていてもカードを読めていないことがある(挿さっていない・USBが黙る)。
 * そうなると録画は成功したように見えて中身が全部スクランブルされたまま、という
 * 気づきにくい壊れ方をするので、画面から見えるようにしてある。
 */
export async function cardStatus(): Promise<CardStatus> {
  try {
    const res = await fetch(`${config.agentUrl}/denpa/card`, {
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
 * スクランブルを復号する。成功したら output に復号できたTSが出来ている。
 *
 * 渡すのはパスだけで、TS そのものは流さない。元のTSの置き場はエージェント側にも
 * 見せてあるので、読むのも書くのも向こうが直接やる。数十GBになることがあり、
 * HTTP で往復させる意味が無い(そもそも Bun の fetch は送りながら受け取れず、
 * 大きいものを投げると詰まる)。
 *
 * **返事だけでは信じない。** 出来上がったものを読み、掛かったままなら失敗にする。
 */
export async function descramble(
  input: string,
  output: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error: string }> {
  /*
   * 向こうのマウント先はこちらと同じとは限らないので、元のTSの置き場からの相対で渡す。
   * 掛かったままのTSは必ずここにある(引き継いだ録画も、移行のときに
   * 未エンコードのものは元のTSとしてここへ入る)
   */
  const base = config.rawDir;
  const from = relative(base, input);
  const to = relative(base, output);
  if (from.startsWith("..") || to.startsWith("..")) {
    return {
      ok: false,
      error: `元のTSの保存先 (${base}) の外にあるファイルは復号できません`,
    };
  }

  try {
    // 復号は数十分かかることがある。中止を押されたらここで切る
    const res = await fetch(`${config.agentUrl}/denpa/decode`, {
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
    return { ok: false, error: `復号してもスクランブルが残っています。${why}` };
  }
  return { ok: true, error: "" };
}
