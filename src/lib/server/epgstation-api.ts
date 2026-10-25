/**
 * EPGStation の HTTP API を読む (引き継ぎ用。`migrate.ts`)。v2 と v3 はエンドポイントの並びも形も
 * 取り込みに関わるところは同じなので、読み方は1つだけ。違うのは v3 のルールの `BS4K` だけで、
 * それは写す側 (`migrate.ts`) が見る。
 *
 * - **形が違っても止めない** (`shape.tolerate`)。1回だけ警告して来たものを使う。`id` など
 *   無いと扱えない項目が欠けた1件だけを飛ばす ({@link validItems})
 * - 一覧は `limit` を明示してページ送りで全部取る ({@link EpgstationClient.list})
 * - ファイルは Range で続きから取り、長さを確かめる ({@link downloadVideo})
 *
 * 宛先の URL に `user:pass@` があれば `Authorization: Basic` に直して送り、**URL からは外す**
 * (リバースプロキシの Basic 認証用)。ログとエラーに出すのは外したあとの URL だけ
 */
import { open, stat, unlink } from "node:fs/promises";

import {
  array,
  boolean,
  number,
  object,
  optional,
  record,
  string,
  tolerate,
  unknown,
} from "#lib/shape.js";

/** 待つ長さ。試験は短くする */
export const timing = {
  /** 繋いでヘッダが返るまで */
  header: 10_000,
  /** ファイルのデータが来ない間をどこまで待つか */
  idle: 60_000,
  /** 取り直す間隔の最初。2倍ずつ伸ばす */
  backoff: 2_000,
  /** 取り直す回数 */
  retries: 3,
};

/** 一覧を1回に取る数。省くと本物は 24 件しか返さない */
const PAGE = 100;

export interface EpgstationSource {
  /** 資格情報を外した URL (末尾の `/` なし)。ログと画面に出してよいのはこれだけ */
  base: string;
  headers: Record<string, string>;
}

/** URL の資格情報を戻す。壊れた `%` (`p%zz`) は戻せないので、書かれたまま使う */
function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 入力欄の URL を読む。`http://user:pass@host:8888/sub` の資格情報は `Authorization` に移す。
 * 読めなければ理由を投げる (資格情報は言わない)
 */
export function parseSource(input: string): EpgstationSource {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(
      "EPGStation の URL を読めません (例: http://epgstation:8888)",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(
      "EPGStation の URL は http:// か https:// で始めてください",
    );
  const headers: Record<string, string> = {};
  if (url.username !== "" || url.password !== "") {
    const user = decodePart(url.username);
    const pass = decodePart(url.password);
    headers["Authorization"] =
      `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    url.username = "";
    url.password = "";
  }
  url.search = "";
  url.hash = "";
  return { base: url.href.replace(/\/+$/, ""), headers };
}

/** `/api/version` の先頭の数字で見分ける。v1 は API が別物なので扱わない */
export type EpgstationVersion = { text: string; major: 2 | 3 | null };

export function readVersion(text: string): EpgstationVersion | "v1" {
  const major = Number(/^v?(\d+)\./.exec(text.trim())?.[1]);
  if (major === 1) return "v1";
  return { text, major: major === 2 || major === 3 ? major : null };
}

const VERSION = object({ version: string });

const CHANNEL = object({ id: number, name: string });
export type EpgstationChannel = { id: number; name: string };

const SEARCH_TIME = object({
  start: optional(number),
  range: optional(number),
  week: number,
});
const GENRE = object({ genre: number, subGenre: optional(number) });

const RULE = object({
  id: number,
  isTimeSpecification: boolean,
  searchOption: object({
    keyword: optional(string),
    ignoreKeyword: optional(string),
    keyCS: optional(boolean),
    keyRegExp: optional(boolean),
    ignoreKeyRegExp: optional(boolean),
    name: optional(boolean),
    description: optional(boolean),
    extended: optional(boolean),
    GR: optional(boolean),
    BS: optional(boolean),
    CS: optional(boolean),
    SKY: optional(boolean),
    BS4K: optional(boolean),
    channelIds: optional(array(number)),
    genres: optional(array(GENRE)),
    times: optional(array(SEARCH_TIME)),
    isFree: optional(boolean),
    durationMin: optional(number),
    durationMax: optional(number),
    searchPeriods: optional(array(unknown)),
  }),
  reserveOption: object({ enable: boolean, avoidDuplicate: boolean }),
});

const RESERVE = object({
  id: number,
  ruleId: optional(number),
  programId: optional(number),
  isSkip: boolean,
  isTimeSpecified: boolean,
  startAt: number,
  endAt: number,
  name: string,
});

const VIDEO_FILE = object({
  id: number,
  filename: optional(string),
  type: string,
  size: number,
});

const RECORDED = object({
  id: number,
  ruleId: optional(number),
  channelId: optional(number),
  startAt: number,
  endAt: number,
  name: string,
  description: optional(string),
  rawExtended: optional(record(string)),
  isRecording: boolean,
  isEncoding: optional(boolean),
  videoFiles: optional(array(VIDEO_FILE)),
});

/**
 * 型は形どおりだが、**形が違えば来たものがそのまま入っている** (`tolerate`)。写す側は
 * 値の型を確かめてから使う (`migrate.ts` の `flag` など)
 */
export type EpgstationRule = ReturnType<typeof RULE>;
export type EpgstationReserve = ReturnType<typeof RESERVE>;
export type EpgstationRecorded = ReturnType<typeof RECORDED>;
export type EpgstationVideoFile = ReturnType<typeof VIDEO_FILE>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

/**
 * 形を1回だけ確かめ (違えば警告して続ける)、無いと扱えない項目 (`essentials`) が欠けた1件だけ飛ばす。
 * 飛ばしたものは `skip` に言う
 */
export function validItems<T>(
  shape: (value: unknown, path: string) => T,
  items: unknown[],
  what: string,
  essentials: readonly string[],
  warn: (message: string) => void,
  skip: (message: string) => void,
): T[] {
  const out: T[] = [];
  for (const item of items) {
    const value = tolerate(shape, item, what, warn);
    const missing = isObject(value)
      ? essentials.filter((key) =>
          key === "name" ? typeof value[key] !== "string" : !isId(value[key]),
        )
      : [...essentials];
    if (missing.length > 0) {
      const id = isObject(value) && isId(value["id"]) ? ` #${value["id"]}` : "";
      skip(`${what}の1件${id}に ${missing.join("・")} が無いので飛ばします`);
      continue;
    }
    out.push(value);
  }
  return out;
}

/** 応答が ok でなかった。`status` で 404 などを見分ける */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class EpgstationClient {
  constructor(
    readonly source: EpgstationSource,
    /** 形が違ったときの警告の出し先 */
    private readonly warn: (message: string) => void = console.warn,
    /** 欠けた1件を飛ばしたときの出し先 */
    private readonly skip: (message: string) => void = console.warn,
  ) {}

  url(path: string, params: Record<string, string | number> = {}): string {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    ).toString();
    return `${this.source.base}/api${path}${query === "" ? "" : `?${query}`}`;
  }

  /** JSON を1つ取る。ヘッダまで {@link timing.header}、本文まで含めてその3倍で諦める */
  async json(
    path: string,
    params: Record<string, string | number> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const signals = [AbortSignal.timeout(timing.header * 3)];
    if (signal !== undefined) signals.push(signal);
    const res = await fetch(this.url(path, params), {
      headers: { ...this.source.headers, Accept: "application/json" },
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) {
      throw new HttpError(
        res.status,
        `EPGStation の /api${path} が HTTP ${res.status} を返しました`,
      );
    }
    return res.json();
  }

  async version(signal?: AbortSignal): Promise<EpgstationVersion | "v1"> {
    const body = tolerate(
      VERSION,
      await this.json("/version", {}, signal),
      "EPGStation の /api/version",
      this.warn,
    );
    return readVersion(
      isObject(body) && typeof body.version === "string" ? body.version : "",
    );
  }

  async channels(signal?: AbortSignal): Promise<EpgstationChannel[]> {
    const body = await this.json("/channels", {}, signal);
    return validItems(
      CHANNEL,
      Array.isArray(body) ? body : [],
      "EPGStation の /api/channels",
      ["id", "name"],
      this.warn,
      () => {},
    );
  }

  /**
   * ページ送りで全部取る。`total` に届くか、空のページが来たら止める。
   * `total` が読めなければ、`limit` に満たないページで止める
   */
  async list(
    path: string,
    key: string,
    params: Record<string, string | number>,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const all: unknown[] = [];
    /** もう受けた id。`offset` を無視して同じページを返す相手で、同じものを積み続けない */
    const seen = new Set<unknown>();
    for (;;) {
      const body = await this.json(
        path,
        { ...params, offset: all.length, limit: PAGE },
        signal,
      );
      const page = tolerate(
        object({ [key]: array(unknown), total: number }),
        body,
        `EPGStation の /api${path}`,
        this.warn,
      ) as Record<string, unknown>;
      const items = isObject(page) && Array.isArray(page[key]) ? page[key] : [];
      const fresh = items.filter(
        (item) => !isObject(item) || !isId(item["id"]) || !seen.has(item["id"]),
      );
      for (const item of fresh) if (isObject(item)) seen.add(item["id"]);
      all.push(...fresh);
      const total = isObject(page) ? page["total"] : undefined;
      if (items.length === 0 || fresh.length === 0) break;
      if (typeof total === "number" ? all.length >= total : items.length < PAGE)
        break;
    }
    return all;
  }

  async rules(signal?: AbortSignal): Promise<EpgstationRule[]> {
    return validItems(
      RULE,
      await this.list("/rules", "rules", {}, signal),
      "EPGStation の /api/rules",
      ["id"],
      this.warn,
      this.skip,
    );
  }

  async reserves(signal?: AbortSignal): Promise<EpgstationReserve[]> {
    return validItems(
      RESERVE,
      await this.list(
        "/reserves",
        "reserves",
        { type: "all", isHalfWidth: "false" },
        signal,
      ),
      "EPGStation の /api/reserves",
      ["id", "startAt", "endAt"],
      this.warn,
      this.skip,
    );
  }

  /** 録画を古い順に全部 (`isReverse=true`)。途中で増えても先に集めた分はずれない */
  async recorded(signal?: AbortSignal): Promise<EpgstationRecorded[]> {
    return validItems(
      RECORDED,
      await this.list(
        "/recorded",
        "records",
        { isHalfWidth: "false", isReverse: "true" },
        signal,
      ),
      "EPGStation の /api/recorded",
      ["id", "startAt", "endAt"],
      this.warn,
      this.skip,
    );
  }
}

/** ファイルの取り方の結果。`missing` は向こうに無い (404) */
export type DownloadResult = "done" | "missing";

/** 取り直してよい失敗 (切れた・止まった・5xx) */
class Retriable extends Error {}

/** 長さが合わない。取り直しても変わらないので、失敗にして次の録画へ */
class LengthMismatch extends Error {}

/** こちらのディスクの失敗。取り直しても変わらない */
const LOCAL_FAILURES = new Set([
  "ENOSPC",
  "EDQUOT",
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOENT",
  "EISDIR",
]);

/**
 * 取り直すか。向こうが ok 以外を返した (`HttpError`)・こちらのディスクの失敗は取り直さない。
 * 繋がらない・切れた・止まったは取り直す (fetch の失敗は実装ごとに型が違うので、ほかは全部)
 */
function retriable(reason: unknown): boolean {
  if (reason instanceof Retriable) return true;
  if (reason instanceof HttpError || reason instanceof LengthMismatch)
    return false;
  const code = (reason as { code?: unknown } | null)?.code;
  return !(typeof code === "string" && LOCAL_FAILURES.has(code));
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** `bytes 100-199/200` を読む */
function contentRange(
  value: string | null,
): { start: number; total: number } | null {
  const matched = /^bytes (\d+)-\d+\/(\d+)$/.exec(value?.trim() ?? "");
  return matched === null
    ? null
    : { start: Number(matched[1]), total: Number(matched[2]) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * EPGStation のファイル (`/api/videos/<id>`) を `temporary` へ取る。**書きかけがあれば続きから。**
 *
 * - 書きかけの長さ `n` で `Range: bytes=n-` を送る。`206` で始まりが `n`、全体が `size` なら足す。
 *   `200` (プロキシが Range を落とした) なら頭から書き直す。全体が `size` と違えば頭から取り直す
 * - `n == size` なら取りに行かない
 * - 止まったら (ヘッダまで {@link timing.header}、データが {@link timing.idle} 来ない)・切れたら・5xx なら、
 *   間隔を伸ばして {@link timing.retries} 回まで取り直す。続きから
 * - 終わったら長さを確かめる: 最後の長さ == `size` == 応答の全体の長さ。違えば書きかけを消して投げる
 * - `signal` で止めたら書きかけを残して投げる (次の実行で続きから)
 *
 * `onBytes` には書いたぶん (続きからなら、すでにあったぶんも最初に1回) を渡す
 */
export async function downloadVideo(
  client: EpgstationClient,
  videoFileId: number,
  size: number,
  temporary: string,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
): Promise<DownloadResult> {
  let have = await sizeOf(temporary);
  if (have > size) {
    await unlink(temporary).catch(() => {});
    have = 0;
  }
  if (have > 0) onBytes(have);
  /** 応答が言った全体の長さ。取りに行かなかったなら null */
  let announced: number | null = null;
  let failures = 0;

  const restart = async () => {
    await unlink(temporary).catch(() => {});
    onBytes(-have);
    have = 0;
  };

  while (have < size) {
    const attempt = new AbortController();
    const both = AbortSignal.any([signal, attempt.signal]);
    let timer = setTimeout(
      () => attempt.abort(new Retriable("EPGStation から応答がありません")),
      timing.header,
    );
    try {
      const res = await fetch(client.url(`/videos/${videoFileId}`), {
        headers: {
          ...client.source.headers,
          ...(have > 0 ? { Range: `bytes=${have}-` } : {}),
        },
        signal: both,
      });
      if (res.status === 404) {
        await res.body?.cancel();
        return "missing";
      }
      if (res.status === 416) {
        // 書きかけのほうが長い (向こうのファイルが変わった)。頭から
        await res.body?.cancel();
        await restart();
        throw new Retriable("EPGStation が範囲外 (416) を返しました");
      }
      if (res.status >= 500) {
        await res.body?.cancel();
        throw new Retriable(`EPGStation が HTTP ${res.status} を返しました`);
      }
      if (res.status !== 200 && res.status !== 206) {
        await res.body?.cancel();
        throw new HttpError(
          res.status,
          `EPGStation が HTTP ${res.status} を返しました`,
        );
      }

      let append = false;
      if (res.status === 206) {
        const range = contentRange(res.headers.get("content-range"));
        if (range === null || range.start !== have || range.total !== size) {
          // 続きにならない。頭から取り直す (Range を付けないので次は 200)
          await res.body?.cancel();
          await restart();
          throw new Retriable("続きの範囲が返りませんでした");
        }
        announced = range.total;
        append = true;
      } else {
        // Range を落とされた (か、頭から頼んだ)。書きかけは捨てて書き直す
        const length = res.headers.get("content-length");
        announced = length === null ? null : Number(length);
        if (announced !== null && announced !== size) {
          // 全部取ってから確かめるまでもない。数百GBを無駄に取らない
          await res.body?.cancel();
          await restart();
          throw new LengthMismatch(
            `長さが合いません (一覧 ${size} / 応答 ${announced} バイト)`,
          );
        }
        if (have > 0) {
          onBytes(-have);
          have = 0;
        }
      }

      const file = await open(temporary, append ? "a" : "w");
      try {
        const reader = res.body?.getReader();
        clearTimeout(timer);
        const idle = () =>
          setTimeout(
            () =>
              attempt.abort(
                new Retriable("EPGStation からのデータが止まりました"),
              ),
            timing.idle,
          );
        timer = idle();
        for (;;) {
          if (reader === undefined) break;
          let chunk: { done: boolean; value?: Uint8Array | undefined };
          try {
            chunk = await reader.read();
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            if (attempt.signal.aborted) throw attempt.signal.reason;
            throw new Retriable(`途中で切れました (${String(error)})`);
          }
          if (chunk.done || chunk.value === undefined) break;
          clearTimeout(timer);
          timer = idle();
          await file.write(chunk.value);
          have += chunk.value.length;
          onBytes(chunk.value.length);
        }
      } finally {
        await file.close();
      }

      if (announced !== null && announced !== size) break;
      if (have > size) break;
      if (have < size) throw new Retriable("途中で切れました");
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const reason = attempt.signal.aborted ? attempt.signal.reason : error;
      if (!retriable(reason)) throw reason;
      failures++;
      if (failures > timing.retries) {
        throw new Error(
          `${timing.retries} 回取り直しても取れませんでした: ${reason instanceof Error ? reason.message : String(reason)}`,
          { cause: reason },
        );
      }
      await sleep(timing.backoff * 2 ** (failures - 1), signal);
      // 続きから
      const now = await sizeOf(temporary);
      onBytes(now - have);
      have = now;
    } finally {
      clearTimeout(timer);
    }
  }

  const final = await sizeOf(temporary);
  if (final !== size || (announced !== null && announced !== size)) {
    await unlink(temporary).catch(() => {});
    onBytes(-have);
    throw new LengthMismatch(
      `長さが合いません (一覧 ${size} / 応答 ${announced ?? "-"} / 書いた ${final} バイト)`,
    );
  }
  return "done";
}
