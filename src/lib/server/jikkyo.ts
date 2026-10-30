/**
 * **実況のコメント (サーバの受け持ち)。** コメントそのものはサーバを通らない — 端末が NX-Jikkyo と
 * 過去ログ API に直接繋ぐ (`#lib/jikkyo/endpoints.ts`)。サーバが渡すのは次の 2 つだけ:
 *
 * - 録画の実況のチャンネルと頭の放送時刻 (`recordingJikkyo`)。観る画面がコメントを再生位置に合わせるのに使う
 * - 局の勢い (`RankingRelay`)。NX-Jikkyo の REST は CORS を許していないのでブラウザから読めず、
 *   ここで中継する。**保持しない** (30 秒だけメモリに持つ。DB にもファイルにも書かない)
 *
 * どちらも世帯の設定 (連携の「実況」) がオフなら何も渡さない
 */
import { eq } from "drizzle-orm";

import { jikkyoChannel, type JikkyoStation } from "../jikkyo/channels";
import { NX_JIKKYO_CHANNELS } from "../jikkyo/endpoints";
import type { Recording } from "../types";
import { config } from "./config";
import { orm } from "./db";
import { services } from "./schema";
import { settings } from "./settings";

/**
 * 録画の実況。チャンネルと、元の TS の頭 (再生位置 0 の手前) の放送時刻、録画の終わりの放送時刻 (unix ms)。
 * 観る画面は `[head, end)` のコメントを過去ログ API から 1 回で取る
 */
export interface RecordingJikkyo {
  channel: string;
  head: number;
  end: number;
}

/**
 * 録画の実況のチャンネルと頭の放送時刻。世帯の設定がオフ・実況の無い局なら null。
 *
 * 頭は測った値 (`ts_head`) を使い、測れていない録画 (TDT を読めない・取り込んだ録画) は
 * 予定の時刻 (`record_from ?? start_at − START_MARGIN`) で代わりに合わせる。数秒ずれることがある
 */
export function recordingJikkyo(recording: Recording): RecordingJikkyo | null {
  if (!settings().jikkyo) return null;
  const station = orm()
    .select({
      type: services.type,
      service_id: services.service_id,
    })
    .from(services)
    .where(eq(services.id, recording.service_id))
    .get();
  if (station === undefined) return null;
  const channel = jikkyoChannel(station);
  if (channel === null) return null;
  return {
    channel,
    head:
      recording.ts_head ??
      recording.record_from ??
      recording.start_at - config.startMargin,
    // 録画の終わりは予定 (使えた区間・後ろのマージン込み)。録っている途中ならまだ先
    end: recording.record_to ?? recording.end_at + config.endMargin,
  };
}

/** NX-Jikkyo から読んだ勢い (チャンネル → 直近 60 秒のコメント数) */
export type Forces = ReadonlyMap<string, number>;

/** 中継を読んで持っておく長さ。勢いは 60 秒の窓なので、細かく読んでも変わらない (NX-Jikkyo 自身も 10 秒ごとに作り直している) */
export const RANKING_TTL = 30_000;

/**
 * `GET /api/v1/channels` の返事から、放送中のスレッドの勢いを抜く。
 * 返すのは勢いだけで、`viewers` (NX-Jikkyo に繋いでいる数で、ニコニコの視聴者数ではない)・番組名・スレッドの一覧は捨てる。
 * 形がずれていたら、読めたチャンネルだけ使う (`warn` に 1 回言う)。1 つも読めなければ失敗にする
 */
export function parseForces(
  body: unknown,
  warn: (message: string) => void = () => {},
): Map<string, number> {
  if (!Array.isArray(body))
    throw new Error("返事の形が違います (配列ではありません)");
  const forces = new Map<string, number>();
  let odd = 0;
  for (const entry of body as unknown[]) {
    const channel = entry as { id?: unknown; threads?: unknown } | null;
    if (
      channel === null ||
      typeof channel.id !== "string" ||
      !Array.isArray(channel.threads)
    ) {
      odd++;
      continue;
    }
    const active = (channel.threads as unknown[]).find(
      (thread) => (thread as { status?: unknown } | null)?.status === "ACTIVE",
    ) as { jikkyo_force?: unknown } | undefined;
    // 放送中のスレッドが無いチャンネルは載せない (勢いは放送中のスレッドにだけ入る)
    if (active === undefined) continue;
    if (typeof active.jikkyo_force !== "number") {
      odd++;
      continue;
    }
    forces.set(channel.id, active.jikkyo_force);
  }
  if (odd > 0 && forces.size === 0)
    throw new Error("返事の形が違います (勢いを読めません)");
  if (odd > 0)
    warn(
      `NX-Jikkyo の返事の形が一部違います (${odd} チャンネルを読めません)。NX-Jikkyo のバージョンが変わったかもしれません`,
    );
  return forces;
}

/** NX-Jikkyo から全チャンネルの今の状態を読む。Cookie は受けても使わない (サーバの fetch は覚えない) */
async function readChannels(): Promise<unknown> {
  const res = await fetch(NX_JIKKYO_CHANNELS, {
    headers: {
      Accept: "application/json",
      "User-Agent": `denpa/${config.version} (+https://github.com/danything/denpa)`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * **局の勢いの中継。** 誰かが呼んだときだけ NX-Jikkyo を読み、`RANKING_TTL` の間は同じものを返す (読めなかったときも、その間は同じ失敗を返す)。
 * 誰も呼ばなければ読まない。同時に呼ばれても読むのは 1 回。
 * 読めないときは記録に警告を 1 行だけ残す (同じ理由は繰り返さない。戻ったらそのことも 1 行)
 */
export class RankingRelay {
  private cached: { at: number; forces: Forces } | null = null;
  private pending: Promise<{ at: number; forces: Forces }> | null = null;
  /** 最後に読めなかった時刻と理由。`RANKING_TTL` の間は読み直さずに同じ失敗を返す (止まっている相手を叩き続けない) */
  private failed: { at: number; error: unknown } | null = null;
  /** 最後に記録に残した失敗の理由。戻ったら null */
  private failure: string | null = null;
  /** 形のずれの警告を出したか (1 回だけ) */
  private warnedShape = false;

  constructor(
    private readonly read: () => Promise<unknown> = readChannels,
    private readonly clock: () => number = Date.now,
  ) {}

  /** 今の勢い。読めなければ投げる */
  async get(): Promise<{ at: number; forces: Forces }> {
    const cached = this.cached;
    if (cached !== null && this.clock() - cached.at < RANKING_TTL)
      return cached;
    const failed = this.failed;
    if (failed !== null && this.clock() - failed.at < RANKING_TTL)
      throw failed.error;
    this.pending ??= this.load().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async load(): Promise<{ at: number; forces: Forces }> {
    try {
      const forces = parseForces(await this.read(), (message) => {
        if (this.warnedShape) return;
        this.warnedShape = true;
        console.warn(`[jikkyo] ${message}`);
      });
      if (this.failure !== null) {
        console.log("[jikkyo] NX-Jikkyo から勢いを読めるようになりました");
        this.failure = null;
      }
      this.failed = null;
      this.cached = { at: this.clock(), forces };
      return this.cached;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason !== this.failure) {
        console.warn(`[jikkyo] NX-Jikkyo から勢いを読めません: ${reason}`);
        this.failure = reason;
      }
      // 古い勢いは返さない (画面は「いまは勢いを読めません」にする)
      this.cached = null;
      this.failed = { at: this.clock(), error };
      throw error;
    }
  }
}

/** 勢いの一覧の 1 行。`serviceId` は denpa の局の ID (`services.id`) */
export interface RankingEntry {
  serviceId: number;
  force: number;
}

/**
 * 勢いを denpa の局に当てる。局の一覧の `jikkyo` と同じ対応表で、1 つのチャンネルに局が複数当たる
 * (系列の地方局・サブチャンネル) ときは、そのどれにも同じ勢いを付ける。放送中のスレッドが無い局は載せない。
 * 並べ替えはしない (タブを開いた時点の順で止めるのは画面の都合なので、画面が並べる)
 */
export function rankingEntries(
  stations: readonly (JikkyoStation & { id: number })[],
  forces: Forces,
): RankingEntry[] {
  return stations.flatMap((station) => {
    const channel = jikkyoChannel(station);
    const force = channel === null ? undefined : forces.get(channel);
    return force === undefined ? [] : [{ serviceId: station.id, force }];
  });
}
