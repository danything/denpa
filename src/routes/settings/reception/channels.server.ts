import { type Actions, fail } from "@sveltejs/kit";
import { count, eq, sql } from "drizzle-orm";
import { orm } from "#lib/server/db.js";
import { collectNow, collectState } from "#lib/server/epg-collect.js";
import { refresh, start, stop } from "#lib/server/scan.js";
import { programs, services } from "#lib/server/schema.js";
import { CHANNEL_TYPES, type ChannelType } from "#lib/types.js";

/** 物理チャンネル1本と、そこに入っている局 */
interface Coverage {
  type: ChannelType;
  channel: string;
  services: { id: number; name: string; programs: number; until: number }[];
}

/**
 * 取れているチャンネルと、局ごとの番組表の集まり具合。**denpa 自身のDBから。**
 *
 * エージェントにも同じ顔ぶれの控えがある (スキャンの結果を預けてあるので) が、
 * **聞きに行かない。** 向こうが持っているのは選局に要る周波数と TSID のためで、
 * 局名も番組表も denpa のもの。両方を並べていた頃は、取り込みが1分おきだった
 * 名残で「denpa への取り込み待ち」を出していたが、いまはスキャンが終わった
 * その場で取り込む (scan.ts) ので、待ちようがない。
 *
 * 出すのは**いま選局できる局だけ**。スキャンをやり直すと局は入れ替わり、
 * 前の回の行は残る (録画や過去の予約が辿れなくなるので消せない)。
 */
function coverage(): Coverage[] {
  const rows = orm()
    .select({
      id: services.id,
      name: services.name,
      type: services.type,
      channel: services.channel,
      programs: count(programs.id),
      until: sql`COALESCE(MAX(${programs.end_at}), 0)`.mapWith(Number),
    })
    .from(services)
    .leftJoin(programs, eq(programs.service_id, services.id))
    // 取り残しの局は出さない (CURRENT_SERVICES と同じ。番組表と JOIN するので列を名指しする)
    .where(
      sql`${services.updated_at} >= (SELECT MAX(${services.updated_at}) FROM ${services})`,
    )
    .groupBy(services.id)
    .orderBy(services.service_id)
    .all();

  const order: Record<string, number> = { GR: 0, BS: 1, CS: 2 };
  const channels = new Map<string, Coverage>();
  for (const { id, name, type, channel, programs, until } of rows) {
    const key = `${type}:${channel}`;
    const entry = channels.get(key) ?? { type, channel, services: [] };
    entry.services.push({ id, name, programs, until });
    channels.set(key, entry);
  }
  return [...channels.values()].sort(
    (a, b) =>
      (order[a.type] ?? 9) - (order[b.type] ?? 9) ||
      a.channel.localeCompare(b.channel),
  );
}

export function load() {
  return {
    // スキャンの進み具合。回しているのは denpa 自身 (scan.refresh)
    scan: refresh(),
    channels: coverage(),
    /** 番組表を集めている最中の様子。1チャンネルに数分かかる */
    collect: collectState(),
  };
}

export const actions = {
  /**
   * 番組表をいますぐ集める。**全チューナーで、録画とライブ視聴以外には譲らせて。**
   *
   * 入れたばかりのときのためのもの。普段の周回はスキャンにもロゴにも譲るので、
   * 何か動いていると番組表がなかなか埋まらない。
   *
   * **待たない。** 全チャンネル回ると数分〜十数分かかる。押した人には
   * 始めたことだけ返して、進み具合は画面に流す (`collect`)
   */
  collectNow: async () => {
    void collectNow().catch(() => undefined);
    return {
      success: true,
      scan: "番組表を集めています。録画とライブ視聴に使っていないチューナーを全部使います",
    };
  },

  scan: async ({ request }) => {
    const form = await request.formData();
    const types = form
      .getAll("types")
      // 画面の選ぶ欄は1つ。「すべて」は `GR,BS,CS` で来る
      .flatMap((value) => String(value).split(","))
      .filter((t): t is ChannelType =>
        CHANNEL_TYPES.includes(t as ChannelType),
      );
    if (types.length === 0)
      return fail(400, { message: "スキャンする種別を選んでください" });

    const result = await start({ types });
    if (!result.started) return fail(409, { message: result.message });
    return { success: true, scan: result.message };
  },

  /** 走っているスキャンを中断する。設定は書き換えないまま止まる */
  scanStop: async () => {
    const result = await stop();
    if (!result.stopped) return fail(409, { message: result.message });
    return { success: true, scan: result.message };
  },
} satisfies Actions;
