/**
 * **録画をエンコードする枠。数えるのはジョブではなく、エンコードする ffmpeg の本数** (`ENCODE_CONCURRENCY`)。
 *
 * コーデックをいくつも選んだ録画は、コーデックごとに ffmpeg を1本ずつ同時に走らせる (`encoder.runJob`)。
 * ジョブで数えると、3つ選んだ録画1本で ffmpeg が3本になり、ライブや追っかけ再生と CPU (GPU) を取り合う。
 * ffmpeg の本数で数えれば、同時に走るエンコードは今までどおり上限の本数まで。
 *
 * - **ジョブは走り出すときに1枠取る** (持ち枠。`open`)。走っている間ずっと持っていて、下ごしらえ (復号・CM の支度・
 *   コマ数の実測) もこの枠でやる。1本目のコーデックはこの枠でエンコードする
 * - **2本目からは空いた枠を取ってから起こす** (`acquire`)。空いていなければ待つ。自分のジョブの持ち枠が空けば
 *   (1本目が終われば) それを使う
 * - **待っている人がいる間は新しいジョブを始めない** (`free`)。走り出したジョブを先に終わらせる。どのジョブも
 *   持ち枠があるので、待っていても必ず1本は進む (枠を取り合って止まることはない)
 * - 上限が選んだコーデックの数より小さければ、取れたぶんだけ同時に走り、残りは枠が空いてから走る (上限 1 なら今までどおり1本ずつ)
 *
 * 再エンコードせずに書き直すだけのもの (チャプターを足す・CM を切る。`-c copy`) は数えない (軽い)。
 * その場の変換 (`transcode.ts`) とは別の枠で、こちらがあちらの枠を食うことはない
 */

/** 返すと枠が空く。何度呼んでも1回だけ */
export type Release = () => void;

export interface SlotPool {
  /** 新しいジョブを始めてよいか (空きがあり、待っている人がいない) */
  free(): boolean;
  /** ジョブの持ち枠を取る。取れなければ false */
  open(owner: number): boolean;
  /** ジョブが終わった。持ち枠を返し、そのジョブの待ちを取り下げる */
  close(owner: number): void;
  /**
   * エンコードする ffmpeg のために1枠取る。持ち枠が空いていればそれ、無ければ空いた枠、無ければ空くまで待つ。
   * 待っている間に中止されたら null。**持ち枠が空いていれば、その場で取れる** (呼んだ順に取れるように)
   */
  acquire(owner: number, signal: AbortSignal): Promise<Release | null>;
  /** いま使っている枠の数 (持ち枠を含む) */
  inUse(): number;
}

interface Waiter {
  owner: number;
  grant: (release: Release | null) => void;
}

/**
 * 枠を作る。`limit` は上限の本数。`onFree` は枠が空いて新しいジョブを
 * 始められるようになったときに呼ぶ (`encoder.pump`)
 */
export function slotPool(limit: () => number, onFree: () => void): SlotPool {
  let used = 0;
  /** ジョブの持ち枠が空いているか */
  const idle = new Map<number, boolean>();
  const waiting: Waiter[] = [];

  const once = (fn: () => void): Release => {
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      fn();
    };
  };

  /** 持ち枠を返す。同じジョブで待っている人がいれば、その人に渡す */
  const baseRelease = (owner: number): Release =>
    once(() => {
      if (!idle.has(owner)) return;
      const at = waiting.findIndex((w) => w.owner === owner);
      if (at === -1) {
        idle.set(owner, true);
        return;
      }
      const [waiter] = waiting.splice(at, 1);
      waiter!.grant(baseRelease(owner));
    });

  const poolRelease = (): Release =>
    once(() => {
      used--;
      drain();
    });

  /** 空いた枠を待っている順に渡す。渡し切って空きが残れば新しいジョブを始めさせる */
  const drain = (): void => {
    while (used < limit() && waiting.length > 0) {
      const waiter = waiting.shift()!;
      used++;
      waiter.grant(poolRelease());
    }
    if (used < limit() && waiting.length === 0) onFree();
  };

  return {
    free: () => used < limit() && waiting.length === 0,
    open(owner) {
      if (!(used < limit() && waiting.length === 0)) return false;
      used++;
      idle.set(owner, true);
      return true;
    },
    close(owner) {
      if (!idle.has(owner)) return;
      idle.delete(owner);
      used--;
      for (let i = waiting.length - 1; i >= 0; i--) {
        if (waiting[i]!.owner !== owner) continue;
        const [waiter] = waiting.splice(i, 1);
        waiter!.grant(null);
      }
      drain();
    },
    acquire(owner, signal) {
      if (signal.aborted) return Promise.resolve(null);
      if (idle.get(owner) === true) {
        idle.set(owner, false);
        return Promise.resolve(baseRelease(owner));
      }
      if (used < limit() && waiting.length === 0) {
        used++;
        return Promise.resolve(poolRelease());
      }
      return new Promise((resolve) => {
        const waiter: Waiter = {
          owner,
          grant: (release) => {
            signal.removeEventListener("abort", onAbort);
            resolve(release);
          },
        };
        const onAbort = () => {
          const at = waiting.indexOf(waiter);
          if (at !== -1) waiting.splice(at, 1);
          resolve(null);
          // 待ちが減ったので、新しいジョブを始められるかもしれない
          if (used < limit() && waiting.length === 0) onFree();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiting.push(waiter);
      });
    },
    inUse: () => used,
  };
}
