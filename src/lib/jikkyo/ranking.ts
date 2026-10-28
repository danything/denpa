/**
 * **ライブの局の一覧の「実況」タブの並べ方** (画面に触らない所。単体テストで見る)。
 *
 * - 実況に対応している局を、種別をまたいで勢い (1 分あたりのコメント数) の大きい順に並べる
 * - 勢いが同じ局は番号順 (種別は 地上波 → BS → CS。局の一覧はもうこの順に並んでいる)
 * - 放送中のスレッドが無い局 (返事に入っていない) は末尾に番号順で
 * - 勢いを読めないときは番号順のまま
 *
 * 並べるのはタブを開いた時点の 1 回だけ (`ranking.svelte.ts`)。勝手に並び直すと、押そうとした行が動く
 */

/** 勢いの中継の返事 (`GET /api/jikkyo/ranking`) を読む。形がずれていれば null */
export function parseRanking(body: unknown): Map<number, number> | null {
  const channels = (body as { channels?: unknown } | null)?.channels;
  if (!Array.isArray(channels)) return null;
  const forces = new Map<number, number>();
  for (const entry of channels as unknown[]) {
    const row = entry as { serviceId?: unknown; force?: unknown } | null;
    if (typeof row?.serviceId !== "number" || typeof row.force !== "number")
      return null;
    forces.set(row.serviceId, row.force);
  }
  return forces;
}

/**
 * 局の ID を勢いの順に並べる。`ids` は番号順 (局の一覧の並び) で渡す。
 * `forces` が null (読めない・まだ届いていない) なら番号順のまま
 */
export function rankOrder(
  ids: readonly number[],
  forces: ReadonlyMap<number, number> | null,
): number[] {
  if (forces === null) return [...ids];
  const at = new Map(ids.map((id, index) => [id, index]));
  return [...ids].sort((a, b) => {
    const fa = forces.get(a);
    const fb = forces.get(b);
    if (fa !== undefined && fb !== undefined && fa !== fb) return fb - fa;
    if (fa !== undefined && fb === undefined) return -1;
    if (fa === undefined && fb !== undefined) return 1;
    return at.get(a)! - at.get(b)!;
  });
}
