/**
 * **ライブの局の一覧の「実況」タブの並べ方** (画面に触らない所。単体テストで見る)。
 *
 * - 実況に対応している局を、種別をまたいで勢い (1 分あたりのコメント数) の大きい順に並べる
 * - 勢いが同じ局は番号順 (種別は 地上波 → BS → CS。局の一覧はもうこの順に並んでいる)
 * - 放送中のスレッドが無い局 (返事に入っていない) は末尾に番号順で
 * - 勢いを読めないときは番号順のまま
 *
 * 数字が届くたびに並べ直す。ただし一覧に指・ポインタ・キーボードのフォーカスが乗っている間は待つ
 * (`ListHold`。押そうとした行が動いて別の局を選ばないように)
 */

/** 一覧から離れてから並べ直すまで (ミリ秒)。指を離した直後にもう 1 行押そうとしても、並びが替わっていない */
export const SETTLE = 1_000;

/** 一覧を使っている理由。どれか 1 つでも立っていれば並べ直さない */
export type HoldReason = "pointer" | "touch" | "focus";

/**
 * **一覧を使っている間は並べ直しを待つ。** 理由が全部外れてから `settle` ミリ秒たったら `release` を呼ぶ。
 * 待っている間に理由が立ち直したら呼ばない。巻いたとき (`poke`) も待ち直す
 */
export class ListHold {
  private readonly reasons = new Set<HoldReason>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly release: () => void,
    private readonly settle = SETTLE,
  ) {}

  /** 使っている (理由が立っている) か、離れてから待っている途中か */
  get held(): boolean {
    return this.reasons.size > 0 || this.timer !== null;
  }

  set(reason: HoldReason, on: boolean): void {
    if (on) {
      this.reasons.add(reason);
      this.stop();
    } else if (this.reasons.delete(reason) && this.reasons.size === 0) {
      this.wait();
    }
  }

  /** 巻いた。理由が無くても、止まってから `settle` ミリ秒は待つ (指を離した後の惰性で巻いている間に替えない) */
  poke(): void {
    if (this.reasons.size === 0) this.wait();
  }

  /**
   * 忘れる (タブを閉じた)。待つのをやめ、理由も消す。乗ったまま一覧が消えると離れた合図が来ないので、
   * 残すと次に開いたときに並べ直さないままになる (タブは一覧の外にあるので、開くときは一覧から離れている)
   */
  clear(): void {
    this.reasons.clear();
    this.stop();
  }

  private stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private wait(): void {
    this.stop();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.release();
    }, this.settle);
  }
}

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

/**
 * 並べ直した行を、前の場所からどれだけずらして見せ始めるか (局の ID → px)。
 * `before` と `after` は行の上端。動かなかった行・どちらかに無い行は入れない
 */
export function slides(
  before: ReadonlyMap<number, number>,
  after: ReadonlyMap<number, number>,
): Map<number, number> {
  const offsets = new Map<number, number>();
  for (const [id, top] of after) {
    const from = before.get(id);
    if (from !== undefined && from !== top) offsets.set(id, from - top);
  }
  return offsets;
}
