/**
 * 録画を観るときの、**押したことの読み方**。DOM を触らない。
 *
 * 画面 (`routes/watch/[id]/+page.svelte`) から切り離してあるのは、ここが
 * **指の癖に合わせて何度も直すところ**だからで、試験で当てられる形にしておきたい。
 *
 * 決まりは動画アプリの通例に合わせる:
 *
 * - **どこを押しても再生/一時停止** (マウスのとき)。指のときは操作列の出し入れ
 * - **左右の端を素早く2回**で 10秒 戻す/送る。続けて押せばそのぶん重なる
 * - **チャプター送り**は「いま観ているものの頭」を挟む (曲送りと同じ癖)
 */

import { logoUnusable } from "../format";

/** 1回で動かす秒数。動画アプリの通例に合わせる */
export const SKIP = 10;

/**
 * 2回目とみなす間合い (ms)。
 *
 * **短いと繋がらず、長いと普通の連打まで数える。** 300ms は OS の既定
 * (ダブルクリック) とほぼ同じで、指でも届く
 */
export const DOUBLE_TAP = 300;

/**
 * 左右それぞれ、幅のどれだけを端とみなすか。
 *
 * **真ん中は空けておく。** ここまで端にすると、映像の真ん中を押したつもりが
 * 送りになる。3分割よりやや狭くして、中央に余白を残す
 */
const EDGE = 0.3;

export type Zone = "left" | "center" | "right";

/** 押されたのが左端か右端か真ん中か。`x` は映像の左端からの距離 */
export function zoneOf(x: number, width: number): Zone {
  if (width <= 0) return "center";
  const ratio = x / width;
  if (ratio < EDGE) return "left";
  if (ratio > 1 - EDGE) return "right";
  return "center";
}

export type TapAction =
  /** 送る・戻す。`undo` が true なら、直前に切り替えた再生/一時停止も戻す */
  | { kind: "seek"; by: number; undo: boolean }
  /** 再生/一時停止 */
  | { kind: "play" }
  /** 操作列の出し入れ */
  | { kind: "controls" };

/** 前に押されたときのこと。2回目かどうかを決めるのに要る */
export interface Tap {
  at: number;
  zone: Zone;
}

/**
 * 1回押されたときに何をするか。
 *
 * **待たせない。** 2回目を待ってから決める作りにすると、押してから再生が
 * 止まるまでに間合いのぶん (0.3秒) 遅れる。1回目はその場で効かせておいて、
 * 2回目が来たら**1回目を打ち消す** (`undo`)。
 *
 * @param last 前に押されたときのこと。無ければ null
 * @param now いまの時刻 (ms)
 * @param zone 押された場所
 * @param coarse 指で触っているか (`(pointer: coarse)`)
 */
export function tap(
  last: Tap | null,
  now: number,
  zone: Zone,
  coarse: boolean,
): { action: TapAction; next: Tap } {
  const next: Tap = { at: now, zone };
  const again =
    last !== null && now - last.at < DOUBLE_TAP && last.zone === zone;

  if (again && zone !== "center") {
    /*
     * **続けて押せば重なる。** 30秒 戻したいときに3回押せるようにしておく
     * (`next` を残すので、次の1回もまた2回目として届く)。
     *
     * 打ち消すのはマウスのときだけ — 指のときの1回目は操作列の出し入れで、
     * 再生には触っていない
     */
    return {
      action: {
        kind: "seek",
        by: zone === "left" ? -SKIP : SKIP,
        undo: !coarse,
      },
      next,
    };
  }
  /*
   * **真ん中を素早く2回で再生/一時停止** (スマホの VLC と同じ癖)。
   * 指の1回目は操作列の出し入れなので、2回目で初めて再生に触る。
   * マウスは1回目で既に切り替えているので、ここには来なくてよい
   */
  if (again && coarse) {
    return { action: { kind: "play" }, next };
  }
  return { action: coarse ? { kind: "controls" } : { kind: "play" }, next };
}

/** チャプター1つ。`start` / `end` は秒 */
export interface Chapter {
  start: number;
  end: number;
  title: string;
}

/**
 * 「頭出し」とみなす猶予 (秒)。
 *
 * **これより後ろで戻すと、まずいまのチャプターの頭に戻る。** 曲送りと同じ癖で、
 * 押し間違えたときに1つ前まで飛ばずに済む
 */
const REWIND_HEAD = 3;

/**
 * 次のチャプターの頭。**無ければ null** (最後のチャプターにいる)。
 *
 * CM はチャプターとして入っているので (`docs/cm.md`)、これが
 * **そのままCM飛ばし**になる。
 */
export function nextChapterAt(chapters: Chapter[], at: number): number | null {
  for (const chapter of chapters) {
    if (chapter.start > at + 0.01) return chapter.start;
  }
  return null;
}

/**
 * 前のチャプターの頭。**無ければ null**。
 *
 * 頭から `REWIND_HEAD` 秒より後ろにいるなら、**いま観ているものの頭**へ戻す。
 */
export function prevChapterAt(chapters: Chapter[], at: number): number | null {
  let head: number | null = null;
  let before: number | null = null;
  for (const chapter of chapters) {
    if (chapter.start > at + 0.01) break;
    before = head;
    head = chapter.start;
  }
  if (head === null) return null;
  if (at - head > REWIND_HEAD) return head;
  return before;
}

/**
 * いま観ているチャプター。**無ければ null**。
 *
 * 何本目かではなく中身を返す — 画面に出すのは名前 (「本編」「CM」) のほう
 */
export function chapterAt(chapters: Chapter[], at: number): Chapter | null {
  let found: Chapter | null = null;
  for (const chapter of chapters) {
    if (chapter.start > at + 0.01) break;
    found = chapter;
  }
  if (found === null) return null;
  return at < found.end ? found : null;
}

/**
 * CM のチャプターか。
 *
 * エンコードするときに「本編」と「CM」で入れている (`server/cm.ts` の `chapterMetadata`)。
 * **引き継いだ録画 (EPGStation) は名前が違う**ことがあるので、そういうものは
 * CM とみなさない — 飛ばし損なうより、本編を飛ばすほうが困る
 */
export function isCm(title: string): boolean {
  return title.trim().toUpperCase() === "CM";
}

/**
 * いま CM の中にいるなら、**その終わり**。いなければ null。
 *
 * **続いている CM はまとめて跨ぐ。** 検出は CM を1本ずつの区間で返すので、
 * 1回ずつ飛ばすと 15秒ごとに何度も飛ぶことになる。
 *
 * @param at いまの位置 (秒)
 */
export function skipTarget(
  chapters: Chapter[],
  at: number,
  lead = 0,
): number | null {
  /*
   * **`lead` のぶん先を見ます。** 入ってから飛ぶと、気付くまでのコマが必ず
   * 見えます (画面は飛ぶまで今の映像を出し続けるため)。**跨ぐ直前に飛べば、
   * 最後に映っているのは本編の1コマ**で、CM のコマは1枚も出ません。
   * 早く飛んだぶん本編の末尾が欠けますが、境目は場面の切れ目なので
   * 1コマぶんなら分かりません
   */
  const now = chapterAt(chapters, at + lead);
  if (now === null || !isCm(now.title)) return null;
  let end = now.end;
  for (const chapter of chapters) {
    // まだ手前のもの。`end` は跨いだぶんだけ伸びていく
    if (chapter.start < end - 0.01) continue;
    if (!isCm(chapter.title)) break;
    end = chapter.end;
  }
  return end;
}

/**
 * ffprobe の `-show_chapters -print_format json` を読む。
 *
 * **時刻は秒の文字列で来る** (`start_time`)。刻み (`time_base`) から起こす手も
 * あるが、ffprobe が既に直したものを添えてくるのでそちらを採る。
 *
 * 読めない・1つも無いときは空。**チャプターの無い録画はある** — CMを切って
 * エンコードしたもの (切ったので位置が無い) と、CM検出が当たらなかったもの
 */
export function parseChapters(json: string): Chapter[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const list = (raw as { chapters?: unknown })?.chapters;
  if (!Array.isArray(list)) return [];

  const chapters: Chapter[] = [];
  for (const entry of list) {
    const item = entry as {
      start_time?: unknown;
      end_time?: unknown;
      tags?: { title?: unknown };
    };
    const start = Number(item.start_time);
    const end = Number(item.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      continue;
    const title =
      typeof item.tags?.title === "string" && item.tags.title !== ""
        ? item.tags.title
        : "—";
    chapters.push({ start, end, title });
  }
  return chapters.sort((a, b) => a.start - b.start);
}

/**
 * 続きから観る、の「続き」をどこにするか。
 *
 * **端に来たら覚えない。**
 *
 * - 末尾の近く … 観終えたということ。覚えると**次はエンドロールから始まる**
 * - 頭のすぐそば … まだ観はじめていない。覚えても頭から出すのと同じで、
 *   「続きがある」と見えるぶんだけ紛らわしい
 *
 * サーバも画面も同じ判断をする必要がある (片方だけが「観終えた」と思うと、
 * 目印が残ったり消えたりが噛み合わない) ので、ここ1箇所に置く。
 *
 * @param at いまの位置 (秒)
 * @param length 尺 (秒)。分からなければ 0
 * @returns 覚える位置。覚えないなら null
 */
export function resumePoint(at: number, length: number): number | null {
  if (!Number.isFinite(at) || at < RESUME_HEAD) return null;
  if (Number.isFinite(length) && length > 0 && at > length - RESUME_EDGE)
    return null;
  return at;
}

/**
 * 末尾まで観たか。**一覧の「未視聴」を外す境目** (`recordings.watched_at`)。
 * 続きの目印を消す境目 (`resumePoint`) と同じにしておく — 片方だけ動くと、
 * 目印は消えたのに未視聴のまま、が起きる。尺が分からなければ観終えたとは言わない
 */
export function watchedToEnd(at: number, length: number): boolean {
  return (
    Number.isFinite(at) &&
    Number.isFinite(length) &&
    length > 0 &&
    at > length - RESUME_EDGE
  );
}

/**
 * 続きの位置の物差し。**続きの位置は元の TS の物差し (入れ物の頭からの秒) で覚える** —
 * 録っている最中 (追っかけ) は元の TS で、エンコードしたあとはエンコードしたもので観るので、どちらかの
 * 物差しのまま覚えると、もう一方で開いたときに捨てた頭 (`encode_skip`) や切った CM のぶんずれる。
 *
 * - `kept` … CM を切ってエンコードしたときに残した区間 (`cm_kept`。元の TS の物差し)。エンコードしたものは
 *   これをつないだもの。null は切っていない
 * - `skip` … 切っていないとき、エンコードしたときに頭から捨てた長さ (`encode_skip`)
 *
 * 物差しが元の TS そのもの (エンコードしたものが無い・TS で観ている) なら `Ruler` は null
 */
export interface Ruler {
  kept: readonly { start: number; end: number }[] | null;
  skip: number;
}

function keptOf(ruler: Ruler): { start: number; end: number }[] {
  return (ruler.kept ?? []).filter((range) => range.end > range.start);
}

/** 元の TS の物差しの位置 (秒) を、`ruler` の物差しへ。**切った CM の中は、その後の本編の頭へ寄せる** */
export function fromTsTime(at: number, ruler: Ruler | null): number {
  if (ruler === null) return at;
  const kept = keptOf(ruler);
  if (kept.length === 0) return Math.max(0, at - ruler.skip);
  let sum = 0;
  for (const range of kept) {
    if (at < range.start) return sum;
    if (at < range.end) return sum + (at - range.start);
    sum += range.end - range.start;
  }
  return sum;
}

/** `ruler` の物差しの位置 (秒) を、元の TS の物差しへ (`fromTsTime` の逆) */
export function toTsTime(at: number, ruler: Ruler | null): number {
  if (ruler === null) return at;
  const kept = keptOf(ruler);
  if (kept.length === 0) return at + ruler.skip;
  let rest = Math.max(0, at);
  for (const range of kept) {
    const length = range.end - range.start;
    if (rest < length) return range.start + rest;
    rest -= length;
  }
  return kept.at(-1)!.end;
}

/** 末尾のここから先は「観終えた」とみなす (秒) */
export const RESUME_EDGE = 30;
/** 頭のここまでは「まだ観ていない」とみなす (秒) */
const RESUME_HEAD = 15;

/**
 * 観はじめるときに CM 飛ばしを入れておくか。
 *
 * **既定は入れる。** 切らずにエンコードした録画 (既定はチャプターを入れるだけ) では、
 * 観るたびに送りのボタンを押すことになる。押さずに済むほうを既定にする。
 * 覚えているのは端末ごとで、人が切ったときだけ `'0'` が入っている。
 *
 * **ロゴでの判定に失敗した1本だけは、覚えていても切って始める。**
 * あれはロゴを使えず**無音だけで当てている**ので外れやすく、外れると
 * CM ではなく本編のほうを飛ばす。飛んでから気付くのでは遅いので、精度を
 * 当てにできない1本では黙って飛ばさない。**押せばその場で入る**
 */
export function skipCmAtStart(
  cmNote: string | null,
  remembered: string | null,
): boolean {
  if (logoUnusable(cmNote)) return false;
  return remembered !== "0";
}

/** シークバーで塗る区間 (秒) */
export interface Span {
  start: number;
  end: number;
}

/**
 * シークバーで塗る **CM の区間**。続いている CM は1本にまとめる (`skipTarget` と同じ考え)。
 *
 * 検出は CM を1本ずつ返すことがあり、そのまま塗ると 15 秒ごとに継ぎ目が出る。
 * 塗りで知りたいのは「どこからどこまでが CM か」なので、継ぎ目は要らない
 * (denpa-tv の `cmRuns` と同じ)
 */
export function cmSpans(chapters: Chapter[]): Span[] {
  const spans: Span[] = [];
  for (const chapter of chapters) {
    if (!isCm(chapter.title)) continue;
    const last = spans.at(-1);
    if (last !== undefined && chapter.start <= last.end + 0.01) {
      last.end = Math.max(last.end, chapter.end);
    } else {
      spans.push({ start: chapter.start, end: chapter.end });
    }
  }
  return spans;
}

/**
 * シークバーの溝を区切る、CM 以外の切れ目。**CM の端は CM の区間 (`cmSpans`) で区切る**ので、どちらの側も CM でない
 * 切れ目だけ (引き継いだ録画の、名前の付いたチャプターなど)
 */
export function plainMarks(chapters: Chapter[]): number[] {
  const marks: number[] = [];
  let before: Chapter | null = null;
  for (const chapter of chapters) {
    if (before !== null && !isCm(before.title) && !isCm(chapter.title))
      marks.push(chapter.start);
    before = chapter;
  }
  return marks;
}
