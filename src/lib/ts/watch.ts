/**
 * 録画を観るときの、**押したことの読み方**。DOM を触らない。
 *
 * 画面 (`routes/watch/[id]/+page.svelte`・`components/player/stage-tap.ts`) から切り離してあるのは、ここが
 * **指の癖に合わせて何度も直すところ**だからで、テストで確かめられる形にしておきたい。
 *
 * 決まりは動画アプリの通例に合わせる。
 *
 * - **どこを押しても再生/一時停止** (マウスのとき)。指のときは操作バーの出し入れ
 * - **左右の端を素早く 2 回**で 10 秒戻す/送る。続けて押せばそのぶん重なる
 * - **チャプター送り**は「いま観ているものの先頭」を挟む (曲送りと同じ癖)
 */

import { logoUnusable } from "../format";

/** 1 回で動かす秒数。動画アプリの通例に合わせる */
export const SKIP = 10;

/**
 * 2 回目とみなす間合い (ms)。
 *
 * **短いと繋がらず、長いと普通の連打まで数える。** 300 ms は OS の既定
 * (ダブルクリック) とほぼ同じで、指でも届く
 */
export const DOUBLE_TAP = 300;

/**
 * 左右それぞれ、幅のどれだけを端とみなすか。
 *
 * **真ん中は空けておく。** ここまで端にすると、映像の真ん中を押したつもりが
 * 送りになる。3 分割よりやや狭くして、中央に余白を残す
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

type TapAction =
  /** 送る・戻す。`undo` が true なら、直前に切り替えた再生/一時停止も戻す */
  | { kind: "seek"; by: number; undo: boolean }
  /** 再生/一時停止 */
  | { kind: "play" }
  /** 操作バーの出し入れ */
  | { kind: "controls" };

/** 前に押されたときのこと。2 回目かどうかを決めるのに要る */
export interface Tap {
  at: number;
  zone: Zone;
}

/**
 * 1 回押されたときに何をするか。
 *
 * **待たせない。** 2 回目を待ってから決める作りにすると、押してから再生が
 * 止まるまでに間合いのぶん (0.3 秒) 遅れる。1 回目はその場で効かせておいて、
 * 2 回目が来たら**1 回目を打ち消す** (`undo`)。
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
     * **続けて押せば重なる。** 30 秒戻したいときに 3 回押せるようにしておく
     * (`next` を残すので、次の 1 回もまた 2 回目として届く)。
     *
     * 打ち消すのはマウスのときだけ。指のときの 1 回目は操作バーの出し入れで、
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
   * **真ん中を素早く 2 回で再生/一時停止** (スマホの VLC と同じ癖)。
   * 指の 1 回目は操作バーの出し入れなので、2 回目で初めて再生に触る。
   * マウスは押すたびに切り替える
   */
  return { action: { kind: coarse && !again ? "controls" : "play" }, next };
}

/** チャプター 1 つ。`start` / `end` は秒 */
export interface Chapter {
  start: number;
  end: number;
  title: string;
}

/**
 * 「頭出し」とみなす猶予 (秒)。
 *
 * **これより後ろで戻すと、まずいまのチャプターの先頭に戻る。** 曲送りと同じ癖で、
 * 押し間違えたときに 1 つ前まで飛ばずに済む
 */
const REWIND_HEAD = 3;

/**
 * 次のチャプターの先頭。**無ければ null** (最後のチャプターにいる)。
 *
 * CM はチャプターとして入っているので (`docs/cm.md`)、これが
 * **そのまま CM 飛ばし**になる。
 */
export function nextChapterAt(chapters: Chapter[], at: number): number | null {
  for (const chapter of chapters) {
    if (chapter.start > at + 0.01) return chapter.start;
  }
  return null;
}

/**
 * 前のチャプターの先頭。**無ければ null**。
 *
 * 先頭から `REWIND_HEAD` 秒より後ろにいるなら、**いま観ているものの先頭**へ戻す。
 */
export function prevChapterAt(chapters: Chapter[], at: number): number | null {
  let head: number | null = null;
  let before: number | null = null;
  for (const chapter of chapters) {
    if (chapter.start > at + 0.01) break;
    before = head;
    head = chapter.start;
  }
  return head !== null && at - head > REWIND_HEAD ? head : before;
}

/**
 * いま観ているチャプター。**無ければ null**。
 *
 * 何本目かではなく中身を返す。画面に出すのは名前 (「本編」「CM」) のほう
 */
export function chapterAt(chapters: Chapter[], at: number): Chapter | null {
  let found: Chapter | null = null;
  for (const chapter of chapters) {
    if (chapter.start > at + 0.01) break;
    found = chapter;
  }
  return found !== null && at < found.end ? found : null;
}

/**
 * CM のチャプターか。
 *
 * エンコードするときに「本編」と「CM」で入れている (`server/cm.ts` の `chapterMetadata`)。
 * **引き継いだ録画 (EPGStation) は名前が違う**ことがあるので、そういうものは
 * CM とみなさない。飛ばし損なうより、本編を飛ばすほうが困る
 */
export function isCm(title: string): boolean {
  return title.trim().toUpperCase() === "CM";
}

/**
 * いま CM の中にいるなら、**その終わり**。いなければ null。
 *
 * **続いている CM はまとめて跨ぐ。** 検出は CM を 1 本ずつの区間で返すので、
 * 1 回ずつ飛ばすと 15 秒ごとに何度も飛ぶことになる。
 *
 * @param at いまの位置 (秒)
 */
export function skipTarget(
  chapters: Chapter[],
  at: number,
  lead = 0,
): number | null {
  /*
   * **`lead` のぶん先を見る。** CM に入ってから飛ぶと、飛ぶまでのコマが必ず
   * 見える (画面は飛ぶまで今の映像を出し続けるため)。**跨ぐ直前に飛べば、
   * 最後に映っているのは本編の 1 コマ**で、CM のコマは 1 枚も出ない。
   * 早く飛んだぶん本編の末尾が欠けるが、境目は場面の切れ目なので
   * 1 コマぶんなら分からない
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
 * CM を跨ぐ手前で飛ぶための先読みの基本 (実時間の秒。30 コマ/秒で 3 コマ)。入ってから飛ぶと必ず CM のコマが見え、
 * コンポジタに渡し済みのコマもあるので 1 コマぶんでは間に合わない。本編の末尾 0.1 秒が静止画になるが、
 * 境目は場面の切れ目なので分からない
 */
const CM_LEAD = 0.1;
/** 先読みの上限 (実時間の秒)。これより長く本編の末尾を削らない */
const CM_LEAD_MOST = 0.5;
/** 1 コマの長さ (秒。30 コマ/秒)。呼び出しの間隔がこれを超えたぶんだけ先読みを伸ばす */
const FRAME = 1 / 30;
/** 呼び出しの間隔を見る長さ (ms) */
const GAP_WINDOW = 5_000;
/** これより長い間隔は数えない (ms)。止めていた・飛んでいた間で、画面の処理の遅れではない */
const GAP_IGNORE = 1_000;

/**
 * **CM を跨ぐ判断をした呼び出しの間隔を測る** (`<video>` は映したコマごと、canvas は刻みごと)。
 *
 * 判断は画面の処理 (メインスレッド) で動くので、ほかの処理 (データ放送・実況・字幕を描く) が長く続くと
 * 呼び出しが遅れ、そのあいだも映像は進む。次の呼び出しが CM に入ってからになると、CM のコマが映る。
 * 直近 `GAP_WINDOW` のいちばん長い間隔を返し、先読み (`cmLead`) をそのぶん伸ばす
 */
export class CallGaps {
  private last: number | null = null;
  private gaps: { at: number; gap: number }[] = [];

  /** 呼ばれた (ms。`performance.now()`) */
  mark(now: number): void {
    if (this.last !== null) {
      const gap = now - this.last;
      if (gap > 0 && gap <= GAP_IGNORE) this.gaps.push({ at: now, gap });
    }
    this.last = now;
    this.prune(now);
  }

  /** 飛んだ・止めた。次の呼び出しまでの間隔は数えない */
  pause(): void {
    this.last = null;
  }

  /** 直近 `GAP_WINDOW` でいちばん長い間隔 (秒)。測れていなければ 0 */
  worst(now: number): number {
    this.prune(now);
    let most = 0;
    for (const item of this.gaps) most = Math.max(most, item.gap);
    return most / 1000;
  }

  private prune(now: number): void {
    while (this.gaps.length > 0 && now - this.gaps[0]!.at > GAP_WINDOW)
      this.gaps.shift();
  }
}

/**
 * CM を跨ぐ手前で飛ぶ先読み (物差しの上の秒。`skipTarget` の `lead`)。
 *
 * - **呼び出しが 1 コマより間遠なら、そのぶん伸ばす** (`gap`。`CallGaps`)。上限は `CM_LEAD_MOST`
 * - **早送りでは速さを掛ける。** 物差しの 0.1 秒のままだと、2 倍速では実時間の 0.05 秒しか先を見ていない
 *
 * @param rate 再生の速さ
 * @param gap 直近の呼び出しの間隔のうち、いちばん長いもの (秒)
 */
export function cmLead(rate: number, gap: number): number {
  const wall = Math.min(CM_LEAD_MOST, CM_LEAD + Math.max(0, gap - FRAME));
  return wall * Math.max(1, rate);
}

/**
 * ffprobe の `-show_chapters -print_format json` を読む。
 *
 * **時刻は秒の文字列で来る** (`start_time`)。刻み (`time_base`) から起こす手も
 * あるが、ffprobe が既に直したものを添えてくるのでそちらを採る。
 *
 * 読めない・1 つも無いときは空。**チャプターの無い録画はある。** CM 検出が当たらなかったものと、
 * 前のバージョンで CM を切ってエンコードしたもの (切ったので位置が無い)
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
 * - 先頭のすぐそば … まだ観はじめていない。覚えても先頭から出すのと同じで、
 *   「続きがある」と見えるぶんだけ紛らわしい
 *
 * サーバも画面も同じ判断をする必要がある (片方だけが「観終えた」と判断すると、
 * 目印が残ったり消えたりが噛み合わない) ので、ここ 1 箇所に置く。
 *
 * @param at いまの位置 (秒)
 * @param length 尺 (秒)。分からなければ 0
 * @returns 覚える位置。覚えないなら null
 */
export function resumePoint(at: number, length: number): number | null {
  if (!Number.isFinite(at) || at < RESUME_HEAD || watchedToEnd(at, length))
    return null;
  return at;
}

/**
 * 末尾まで観たか。**一覧の「未視聴」を外す境目** (`recordings.watched_at`)。
 * 続きの目印を消す境目 (`resumePoint`) と同じにしておく。片方だけ動くと、
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
 * 続きの位置の物差し。**続きの位置は元の TS の物差し (入れ物の先頭からの秒) で覚える。**
 * 録っている最中 (追っかけ) は元の TS で、エンコードしたあとはエンコードしたもので観るので、どちらかの
 * 物差しのまま覚えると、もう一方で開いたときに先頭で捨てたぶん (`encode_skip`) や切った CM のぶんずれる。
 *
 * - `kept` … 前のバージョンで CM を切ってエンコードしたときに残した区間 (`cm_kept`。元の TS の物差し)。
 *   エンコードしたものはこれをつないだもの。null は切っていない (今のバージョンは切らない)
 * - `skip` … 切っていないとき、エンコードしたときに先頭から捨てた長さ (`encode_skip`)
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

/** 元の TS の物差しで測った位置 (秒) を、`ruler` の物差しへ。**切った CM の中は、その後の本編の先頭へ寄せる** */
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

/** `ruler` の物差しで測った位置 (秒) を、元の TS の物差しへ (`fromTsTime` の逆) */
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

/**
 * 元の TS の物差しで測った位置 (秒) が、`ruler` の物差しのどこで観られるか (コメントの一覧の時刻)。
 * `fromTsTime` と違って寄せず、観られる所より前は `"before"`、切った CM の中と残した区間の後は `"cut"` を返す
 */
export function playbackAt(
  at: number,
  ruler: Ruler | null,
): number | "before" | "cut" {
  if (at < 0) return "before";
  if (ruler === null) return at;
  const kept = keptOf(ruler);
  if (kept.length === 0) return at < ruler.skip ? "before" : at - ruler.skip;
  if (at < kept[0]!.start) return "before";
  let sum = 0;
  for (const range of kept) {
    if (at < range.start) return "cut";
    if (at < range.end) return sum + (at - range.start);
    sum += range.end - range.start;
  }
  return "cut";
}

/** 末尾のここから先は「観終えた」とみなす (秒) */
export const RESUME_EDGE = 30;
/** 先頭のここまでは「まだ観ていない」とみなす (秒) */
const RESUME_HEAD = 15;

/**
 * 観はじめるときに CM 飛ばしをオンにしておくか。
 *
 * **既定はオン。** CM はチャプターとして入っているだけなので、オフだと観るたびに送りのボタンを
 * 押すことになる。押さずに済むほうを既定にする。
 * 覚えているのは端末ごとで、人がオフにしたときだけ `'0'` が入っている。
 *
 * **ロゴでの判定に失敗した 1 本だけは、覚えていてもオフで始める。**
 * あれはロゴを使えず**無音と CM の尺だけで当てている**ので外れやすく、外れると
 * CM ではなく本編のほうを飛ばす。飛んでから気付くのでは遅いので、精度を
 * 当てにできない 1 本では自動で飛ばさない。**押せばその場でオンになる**
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
 * シークバーで塗る **CM の区間**。続いている CM は 1 本にまとめる (`skipTarget` と同じ考え)。
 *
 * 検出は CM を 1 本ずつ返すことがあり、そのまま塗ると 15 秒ごとに継ぎ目が出る。
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
 * `at` より後で次に始まる CM の先頭 (続いている CM はまとめた区間の先頭)。**無ければ null**。
 *
 * canvas のプレイヤーに「ここから先のコマは描かない」と渡す (`canvas-player.ts` の `stopAt`)。
 * 画面の刻みが遅れて飛ぶのが間に合わなくても、CM の 1 コマ目は描かれない
 */
export function nextCmStart(chapters: Chapter[], at: number): number | null {
  return cmSpans(chapters).find((span) => span.start > at)?.start ?? null;
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
