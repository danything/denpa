import { format } from "node:util";

import { cut, type LogLevel, type LogLine } from "../issue-report";

/**
 * **サーバのログの最後の 2000 行を、メモリに持っておく** (設定の「診断」に出し、Issue に貼る)。
 *
 * 本番のイメージにはシェルが無く (distroless)、Mac と Windows ではログがファイルに出るので、
 * 「ログを貼ってください」と言われても集めにくかった。画面から読めるように、`console` を包んで写しを取る。
 *
 * - **出し方は変えない。** 元の `console.log` などをそのまま呼んでから写す
 * - **メモリだけ。** ファイルにも DB にも書かない。再起動すれば消える
 * - 1 行は `util.format` で `console` と同じ字にする (`%s` や物の中身も同じに出る)
 *
 * 包むのは 1 回だけ。`hooks.server.ts` のいちばん頭で読む (起動のログから写す。`server.js` がアプリを読む前に
 * 出す行 (環境変数の警告など) は写らない)。開発中にもう一度
 * 読まれても、置き場は `globalThis` の 1 つを共有する
 */

export const LOG_LIMIT = 2000;
/** 1 行の上限。巨大な物を出した 1 行でメモリを食わないように */
const TEXT_LIMIT = 4000;

/** 決まった数だけ持つリングバッファ。いっぱいになったら古い行から上書きする */
export class LogRing {
  readonly #lines: (LogLine | undefined)[];
  /** 次に書く位置 */
  #next = 0;
  #count = 0;

  constructor(readonly limit = LOG_LIMIT) {
    this.#lines = new Array(limit);
  }

  push(level: LogLevel, text: string, at = Date.now()): void {
    this.#lines[this.#next] = {
      at,
      level,
      text: text.length > TEXT_LIMIT ? `${cut(text, TEXT_LIMIT)}…` : text,
    };
    this.#next = (this.#next + 1) % this.limit;
    this.#count = Math.min(this.#count + 1, this.limit);
  }

  /** 古い順に */
  lines(): LogLine[] {
    const start = (this.#next - this.#count + this.limit) % this.limit;
    const out: LogLine[] = [];
    for (let i = 0; i < this.#count; i++) {
      const line = this.#lines[(start + i) % this.limit];
      if (line !== undefined) out.push(line);
    }
    return out;
  }
}

const KEY = Symbol.for("denpa.logBuffer");
type Holder = { [KEY]?: LogRing };

const LEVELS = {
  debug: "info",
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
} as const satisfies Record<string, LogLevel>;

/** 写しを取り始める。2 回目からは何もしない */
function installLogBuffer(): void {
  const holder = globalThis as Holder;
  if (holder[KEY] !== undefined) return;
  const ring = new LogRing();
  holder[KEY] = ring;
  for (const [method, level] of Object.entries(LEVELS) as [
    keyof typeof LEVELS,
    LogLevel,
  ][]) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      try {
        ring.push(level, format(...args));
      } catch {
        // 写しが取れなくても、出すほうは止めない
      }
    };
  }
}

/** 持っている行を古い順に。写しを取っていなければ空 */
export function serverLogs(): LogLine[] {
  return (globalThis as Holder)[KEY]?.lines() ?? [];
}

installLogBuffer();
