/**
 * **ログから GitHub の Issue を開く** (設定の「診断」→「Issue にする」)。
 *
 * denpa のサーバからは GitHub に何も送らない。組み立てた URL をその人のブラウザで開くだけで、
 * 開く前に中身 (伏せたあとのもの) を見せて、直したり消したりできるようにする。
 *
 * 開くのは Issue のフォーム (`.github/ISSUE_TEMPLATE/bug_report.yml`) で、欄の `id` をそのまま
 * 問い合わせの名前にすると、その欄が埋まった状態で開く。埋めるのはタイトル・バージョン・環境・ログ。
 * 「何が起きたか」「再現手順」はその人が GitHub で書く。
 *
 * **URL は 8000 字まで** (`URL_LIMIT`)。長すぎる URL は GitHub やブラウザに断られる。
 * ログは警告とエラーを先に、それぞれ新しいほうから選び、出すときは古い順に並べ直す。
 * 入りきらなかったぶんは数を書き、全部はコピーかダウンロードしたものを貼ってもらう
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogLine {
  /** epoch ミリ秒 */
  at: number;
  level: LogLevel;
  text: string;
}

export interface LogSource {
  /** 見出しに出す名前 (サーバ・エージェント) */
  label: string;
  lines: LogLine[];
  /** `level` が本物か。エージェントのログは字から推し量ったものなので、行に `[warn]` を付けない */
  tagged: boolean;
  /** 取得できなかったときの一言。見出しのすぐ下に出す */
  note?: string;
}

export interface IssueFields {
  title: string;
  version: string;
  environment: string;
  logs: string;
}

export const ISSUE_NEW = "https://github.com/danything/denpa/issues/new";
export const ISSUE_TEMPLATE = "bug_report.yml";
/** URL 全体の上限。GitHub は 8KB を超える URL を断る */
export const URL_LIMIT = 8000;
/** 1 行の上限。長い 1 行 (例外の中身を詰めたものなど) が枠を全部使わないように */
const LINE_LIMIT = 400;
/** タイトルと環境の上限 (字数と、URL に入れたときの長さ)。ここを超えるのは貼り間違い */
const TITLE_LIMIT = 256;
const TITLE_ENCODED_LIMIT = 1500;
const ENVIRONMENT_LIMIT = 1500;
const ENVIRONMENT_ENCODED_LIMIT = 3000;

/**
 * URL に入れる形にする。**片割れのサロゲート (切り詰めた絵文字など) があると `encodeURIComponent` は投げる**ので、
 * 先に置き換え文字 (U+FFFD) に直す
 */
const enc = (text: string) => encodeURIComponent(text.toWellFormed());
/** ログの欄の中で 1 行が使う長さ (改行込み) */
const cost = (line: string) => enc(`${line}\n`).length;

/**
 * **エージェントの行の重さを字から推し量る。** エージェントのログ (`GET /denpa/logs`) には重さが無い。
 * 「警告とエラーだけ」と、Issue に入れる順を決めるためだけに使う
 */
export function guessLevel(text: string): LogLevel {
  if (
    /\b(?:fail(?:ed|ure)?|errors?|exception|fatal|crit(?:ical)?)\b|失敗|エラー|例外|誤り|できません|繋がりません|見つかりません|ありません/i.test(
      text,
    )
  )
    return "error";
  if (/\bwarn(?:ing)?\b|警告|注意/i.test(text)) return "warn";
  return "info";
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** 端末の時刻で `2026-10-25 12:34:56` */
export function stamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 報告に書く 1 行。重さが本物のときだけ `[warn]` `[error]` を付ける */
export function formatLine(line: LogLine, tagged: boolean): string {
  const tag = tagged && line.level !== "info" ? ` [${line.level}]` : "";
  return `${stamp(line.at)}${tag} ${line.text}`;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${cut(text, limit - 1)}…`;
}

/** 先頭から `length` 字 (UTF-16) で切る。絵文字などのサロゲートの間に当たったら、その字の前で切る */
export function cut(text: string, length: number): string {
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

/** 字数と、URL に入れたときの長さの両方で切る (日本語は 1 字が 9 字になる) */
function clipField(text: string, chars: number, encoded: number): string {
  let out = clip(text, chars);
  while (enc(out).length > encoded) out = clip(out, out.length - 1);
  return out;
}

const header = (label: string, shown: number, total: number) =>
  `--- ${label}のログ (${shown === total ? `${shown} 行` : `${shown} / ${total} 行`}) ---`;

const omittedNote = (count: number) =>
  `(長いので ${count} 行を省きました。全部はコピーかダウンロードしたものにあります)`;

/**
 * **枠 (`budget`。URL に入れたときの字数) に入るだけのログを選ぶ。**
 * 警告とエラーを先に、同じ重さなら新しいほうから。出すときは見出しごとに古い順
 */
export function fitLogs(
  sources: readonly LogSource[],
  budget: number,
): { text: string; omitted: number } {
  const all = sources.flatMap((source, at) =>
    source.lines.map((line, index) => ({
      source: at,
      index,
      line,
      text: clip(formatLine(line, source.tagged), LINE_LIMIT),
    })),
  );
  // 見出しと「省きました」の分を先に取っておく (数の桁はいちばん多いときで数える)
  let used = cost(omittedNote(all.length));
  for (const source of sources) {
    used += cost(
      header(source.label, source.lines.length - 1, source.lines.length),
    );
    if (source.note !== undefined) used += cost(source.note);
  }

  const order = [...all].sort(
    (a, b) =>
      Number(a.line.level === "info") - Number(b.line.level === "info") ||
      b.line.at - a.line.at,
  );
  const chosen = new Set<(typeof all)[number]>();
  for (const entry of order) {
    const size = cost(entry.text);
    if (used + size > budget) continue;
    used += size;
    chosen.add(entry);
  }

  const out: string[] = [];
  sources.forEach((source, at) => {
    const picked = all
      .filter((entry) => entry.source === at && chosen.has(entry))
      .sort((a, b) => a.line.at - b.line.at || a.index - b.index);
    out.push(header(source.label, picked.length, source.lines.length));
    if (source.note !== undefined) out.push(source.note);
    for (const entry of picked) out.push(entry.text);
  });
  const omitted = all.length - chosen.size;
  if (omitted > 0) out.push(omittedNote(omitted));
  return { text: out.join("\n"), omitted };
}

/** 問い合わせの並び。欄の名前は `bug_report.yml` の `id` と同じ */
function query(fields: IssueFields): string {
  return [
    ["template", ISSUE_TEMPLATE],
    ["title", fields.title],
    ["version", fields.version],
    ["environment", fields.environment],
    ["logs", fields.logs],
  ]
    .map(([key, value]) => `${key}=${enc(value ?? "")}`)
    .join("&");
}

/** ログを除いた URL の長さ (`logs=` までの分)。ログの枠を数えるのに使う */
function baseLength(fields: Omit<IssueFields, "logs">): number {
  return `${ISSUE_NEW}?${query({ ...fields, logs: "" })}`.length;
}

/**
 * **最初にログの欄に入れるもの** (確かめる画面に出す)。タイトル・バージョン・環境を除いた残りの枠に入るだけ
 */
export function initialLogs(
  fields: Omit<IssueFields, "logs">,
  sources: readonly LogSource[],
  limit = URL_LIMIT,
): { text: string; omitted: number } {
  return fitLogs(sources, limit - baseLength(fields));
}

/**
 * **開く URL。** 確かめる画面で書き足して上限を超えたら、ログの頭 (古いほう) から削り、削った数を頭に書く。
 * タイトルと環境が長すぎるときは、それぞれの上限で切る
 */
export function issueUrl(
  input: IssueFields,
  limit = URL_LIMIT,
): { url: string; dropped: number } {
  const fields = {
    ...input,
    title: clipField(input.title, TITLE_LIMIT, TITLE_ENCODED_LIMIT),
    environment: clipField(
      input.environment,
      ENVIRONMENT_LIMIT,
      ENVIRONMENT_ENCODED_LIMIT,
    ),
  };
  const make = (logs: string) => `${ISSUE_NEW}?${query({ ...fields, logs })}`;
  const whole = make(fields.logs);
  if (whole.length <= limit) return { url: whole, dropped: 0 };

  const lines = fields.logs.split("\n");
  const room = limit - baseLength(fields);
  let size = lines.reduce((sum, line) => sum + cost(line), 0) - 3; // 最後の行に改行は無い
  let dropped = 0;
  const note = (count: number) => `(長いので頭の ${count} 行を省きました)`;
  while (dropped < lines.length && size + cost(note(dropped + 1)) > room) {
    size -= cost(lines[dropped]!);
    dropped += 1;
  }
  const kept = lines.slice(dropped);
  const logs = [note(dropped), ...kept].join("\n");
  const url = make(logs);
  // 頭の 1 行も入らない (タイトルが上限まで長いなど) ときは、ログを空にする
  return url.length <= limit
    ? { url, dropped }
    : { url: make(""), dropped: lines.length };
}

/** **コピーとダウンロードに使う全部入りの報告。** ログは全部 (1 行も削らない) */
export function fullReport(
  fields: Omit<IssueFields, "logs">,
  sources: readonly LogSource[],
): string {
  const out = [
    fields.title === "" ? "(タイトル未記入)" : fields.title,
    "",
    `denpa のバージョン: ${fields.version}`,
    `環境: ${fields.environment}`,
  ];
  for (const source of sources) {
    out.push(
      "",
      header(source.label, source.lines.length, source.lines.length),
    );
    if (source.note !== undefined) out.push(source.note);
    for (const line of source.lines) out.push(formatLine(line, source.tagged));
  }
  return `${out.join("\n")}\n`;
}
