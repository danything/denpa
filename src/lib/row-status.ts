/**
 * **ホームの行の状態は、番組名の下の段 (3段目) に出す** (`RowActivity`)。1段目は時刻と番組名だけ。
 *
 * 動いているもの (録画中・エンコード中・待ち・端末に保存中) も、止まっている問題 (競合・失敗・録り逃し・
 * 一部だけ録れた・ロゴでCMを判定できなかった・削除済み・取り消し済み) も同じ形で、
 * 頭に点か印、ラベル、「・」の後ろに中身 (あと何分か・理由)。番組名の行にバッジを置くと、狭い画面で番組名が押し出される
 */

/**
 * 色と頭の印。
 * - 動いているもの: `rec` (録画中。赤) / `busy` (エンコード中。主の色) / `wait` (待ち。地の字) / `ok` で `running`
 * - 止まっているもの: `error` (✕) / `warning` (⚠) / `neutral` (削除済み・取り消し済み) / `ok` (端末に保存済み)
 */
export type StatusTone =
  "rec" | "busy" | "wait" | "ok" | "error" | "warning" | "neutral";

export interface RowStatus {
  /** 何の段か (`data-kind`。テストの目印) */
  kind: string;
  tone: StatusTone;
  label: string;
  /** 「・」の後ろに続ける中身。無ければ出さない */
  detail?: string | null | undefined;
  /** いま動いている (頭の点が脈打つ) */
  running?: boolean;
  /** ラベルに付ける testid (行の状態 `reservation-state` など。読み上げも画面もここ) */
  testid?: string | undefined;
  /** 中身に付ける testid (エンコードの進み `encode-progress`) */
  detailTestid?: string | undefined;
}

/** **状態の段は 2 つまで。** 行の高さが揃わなくなるのと、3つ並ぶと読まれなくなるため */
const MAX_STATUS_LINES = 2;

/** 重いものから。問題が重なったら重いほうを先に出す */
const RANK: Record<StatusTone, number> = {
  error: 0,
  warning: 1,
  neutral: 2,
  ok: 3,
  rec: 4,
  busy: 4,
  wait: 4,
};

/**
 * バッジの色 (`badgeClass`) を段の色に。塗ったもの (`solid`) はいま動いているもの (録画中)
 */
export function toneOf(badge: string): StatusTone {
  if (badge.includes("solid")) return "rec";
  if (badge.includes("error")) return "error";
  if (badge.includes("warning")) return "warning";
  if (badge.includes("success")) return "ok";
  return "neutral";
}

/**
 * 行に出す段。**動いているものが先、問題は重い順に後ろ。**
 *
 * 2つに収まらないときは、2段目に残りのラベルを「・」でつないで1段にまとめる (中身は落とす。
 * 詳細を開けば全部ある)。色はまとめたうちいちばん重いもの
 */
export function statusLines(
  activities: RowStatus[],
  problems: RowStatus[],
): RowStatus[] {
  const lines = [
    ...activities,
    ...[...problems].sort((a, b) => RANK[a.tone] - RANK[b.tone]),
  ];
  if (lines.length <= MAX_STATUS_LINES) return lines;
  const keep = lines.slice(0, MAX_STATUS_LINES - 1);
  const rest = lines.slice(MAX_STATUS_LINES - 1);
  const worst = rest.reduce((a, b) => (RANK[b.tone] < RANK[a.tone] ? b : a));
  return [
    ...keep,
    {
      kind: rest.map((l) => l.kind).join(" "),
      tone: worst.tone,
      label: rest.map((l) => l.label).join("・"),
      running: rest.some((l) => l.running === true),
      testid: rest.find((l) => l.testid !== undefined)?.testid,
    },
  ];
}
