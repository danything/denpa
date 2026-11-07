import { type Actions, fail } from "@sveltejs/kit";
import { count, eq, inArray, or, sql } from "drizzle-orm";

import { orm } from "#lib/server/db.js";
import { collectNow, collectState } from "#lib/server/epg-collect.js";
import { currentServices, typeRank } from "#lib/server/epg.js";
import { lineupNotice, seenLineupChanges } from "#lib/server/lineup-follow.js";
import {
  type Reception,
  receptionOf,
  unreceivableChannels,
} from "#lib/server/reception.js";
import {
  SCAN_KINDS,
  type ScanKind,
  scanState,
  start,
  stop,
} from "#lib/server/scan.js";
import { programs, services } from "#lib/server/schema.js";
import { measureSignal } from "#lib/server/signal-quality.js";
import type { ChannelType } from "#lib/types.js";

/** 物理チャンネル 1 本と、そこに入っている局 */
interface Coverage {
  type: ChannelType;
  channel: string;
  /** 受信できるか。受信できないチャンネルも、印を付けて出す (`reception.ts`) */
  reception: Reception;
  services: { id: number; name: string; programs: number; until: number }[];
}

/**
 * 取れているチャンネルと、局ごとの番組表の集まり具合。**denpa 自身の DB から。**
 *
 * エージェントにも同じ顔ぶれの控えがある (スキャンの結果を預けてあるので) が、
 * **聞きに行かない。** 向こうが持っているのは選局に要る周波数と TSID のためで、
 * 局名も番組表も denpa のもの。両方を並べていた頃は、取り込みが 1 分おきだった
 * 名残で「denpa への取り込み待ち」を出していたが、いまはスキャンが終わった
 * その場で取り込む (scan.ts) ので、待ちようがない。
 *
 * 出すのは**いま選局できる局だけ**。スキャンをやり直すと局は入れ替わり、
 * 前の回の行は残る (録画や過去の予約が辿れなくなるので消せない)。
 * **受信できないチャンネルの局は出す** (番組表やライブからは外れている。外れた理由をここで言う)
 */
function coverage(): Coverage[] {
  const unreceivable = unreceivableChannels();
  const blocked = [...unreceivable].map((key) =>
    key.slice(key.indexOf(":") + 1),
  );
  const rows = orm()
    .select({
      id: services.id,
      name: services.name,
      type: services.type,
      channel: services.channel,
      programs: count(programs.id),
      until: sql`COALESCE(MAX(${programs.end_at}), 0)`.mapWith(Number),
      current: sql`CASE WHEN ${currentServices()} THEN 1 ELSE 0 END`.mapWith(
        Number,
      ),
    })
    .from(services)
    .leftJoin(programs, eq(programs.service_id, services.id))
    // 取り残しの局は出さない
    .where(
      blocked.length === 0
        ? currentServices()
        : or(currentServices(), inArray(services.channel, blocked)),
    )
    .groupBy(services.id)
    .orderBy(services.service_id)
    .all()
    // 名前だけで絞ったぶんを、種別と名前の組で絞り直す (いまの局はそのまま)
    .filter(
      (row) =>
        !blocked.includes(row.channel) ||
        unreceivable.has(`${row.type}:${row.channel}`) ||
        row.current === 1,
    );

  const channels = new Map<string, Coverage>();
  for (const { id, name, type, channel, programs, until } of rows) {
    const key = `${type}:${channel}`;
    const entry = channels.get(key) ?? {
      type,
      channel,
      reception: "ok" as Reception,
      services: [],
    };
    entry.services.push({ id, name, programs, until });
    channels.set(key, entry);
  }
  const list = [...channels.values()];
  const reception = receptionOf(list);
  for (const entry of list)
    entry.reception = reception.get(`${entry.type}:${entry.channel}`) ?? "ok";
  return list.sort(
    (a, b) =>
      typeRank(a.type) - typeRank(b.type) ||
      a.channel.localeCompare(b.channel, "en", { numeric: true }),
  );
}

export function load() {
  return {
    // スキャンの進み具合。回しているのは denpa 自身 (scan.ts)
    scan: scanState(),
    channels: coverage(),
    /** 番組表を集めている最中の様子。1 チャンネルに数分かかる */
    collect: collectState(),
    /** チャンネルを書き換えたお知らせが出ているか。出ていれば、画面を開いたところで消す (`seenLineup`) */
    lineupChanged: lineupNotice() !== null,
  };
}

export const actions = {
  /**
   * 番組表をいますぐ集める。**全チューナーで、録画とライブ視聴以外には譲らせて。**
   *
   * 入れたばかりのときのためのもの。普段の周回はスキャンにも譲るので、
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
      // 画面の選ぶ欄は 1 つ。「すべて」は `GR,BS,CS`、CATV は `CATV` で来る
      .flatMap((value) => String(value).split(","))
      .filter((t): t is ScanKind => SCAN_KINDS.includes(t as ScanKind));
    if (types.length === 0)
      return fail(400, { message: "スキャンする種別を選んでください" });

    const result = start({ types });
    if (!result.started) return fail(409, { message: result.message });
    return { success: true, scan: result.message };
  },

  /**
   * チャンネルを書き換えたお知らせを消す。**開いた画面が呼ぶ** (`Channels.svelte`)。load で消すと、
   * リンクに指を乗せただけの先読みでも消える
   */
  seenLineup: () => {
    seenLineupChanges();
    return { success: true };
  },

  /** 走っているスキャンを中断する。設定は書き換えないまま止まる */
  scanStop: () => {
    const result = stop();
    if (!result.stopped) return fail(409, { message: result.message });
    return { success: true, scan: result.message };
  },

  /**
   * 1 つのチャンネルの受信品質を測る (`signal-quality.ts`)。**測り終えるまで待つ** (5 秒ほど)。
   * 結果はそのチャンネルの行の下に出す。選局できなければ、その理由を通知に出す。
   * 測れるのは一覧に並んでいるチャンネルだけ (チャンネル名はエージェントへのリクエストと名乗りにそのまま入る)
   */
  measureSignal: async ({ request }) => {
    const form = await request.formData();
    const found = coverage().find(
      (entry) =>
        entry.type === form.get("type") &&
        entry.channel === form.get("channel"),
    );
    if (found === undefined)
      return fail(400, { message: "チャンネルを選んでください" });
    const { type, channel } = found;
    try {
      const quality = await measureSignal(type, channel, request.signal);
      return { success: true, measured: { type, channel, ...quality } };
    } catch (error) {
      return fail(502, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
} satisfies Actions;
