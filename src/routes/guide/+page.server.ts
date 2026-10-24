import { fail } from "@sveltejs/kit";
import { and, eq, ne } from "drizzle-orm";

import { channelNotice } from "#lib/channel-notice.js";
import { orm } from "#lib/server/db.js";
import { serviceCounts, watchableServices } from "#lib/server/epg.js";
import {
  broadcastDayStart,
  daysOf,
  HOUR,
  requestedDay,
  stationsOf,
  WINDOW_HOURS,
} from "#lib/server/guide.js";
import { cancel, reserve } from "#lib/server/reservations.js";
import { reservations } from "#lib/server/schema.js";
import { storedSubchannels, SUBCHANNELS_COOKIE } from "#lib/subchannels.js";
import type { ChannelType } from "#lib/types.js";
import { CHANNEL_TYPES } from "#lib/types.js";

/**
 * 時間×チャンネルのグリッドの外枠。並びを眺めて選ぶとき用
 * (言葉で探すのはサイト全体の検索 `/search` に寄せてある)。
 *
 * **番組 (マス) はここで返さない。** 画面が `/api/guide` から後で取る (`+page.ts`)。
 * 局の並び・日付・時刻は番組より先に決まるので、局名の行と時刻の列は本物を先に描き、
 * マスのところだけ骨組みにしておける — 届いたときに表の位置が動かない
 */
export function load({ url, cookies }) {
  const type = (CHANNEL_TYPES.find((t) => t === url.searchParams.get("type")) ??
    "GR") as ChannelType;

  // 既定は今日の放送日。めくるときだけ start が付く
  const start = requestedDay(url.searchParams.get("start"));

  /*
   * 局の数 (種別ごと)。選んでいる種別に局が無ければ、表の真ん中にスキャンの案内を出す。
   * そのときは上の案内 (`+layout.svelte`) を出さない — 同じことを2度言わない
   */
  const counts = serviceCounts();
  const typeEmpty = (counts[type] ?? 0) === 0;
  const today = broadcastDayStart(Date.now());
  const { services, split } = stationsOf(
    type,
    start,
    start + WINDOW_HOURS * HOUR,
  );

  return {
    type,
    start,
    hours: WINDOW_HOURS,
    /** 今日の放送日の 4:00。日付の並びの先頭 */
    today,
    /** 日付の並び (`daysOf`)。索引を引くだけ */
    days: daysOf(type, today),
    /** 表の列になる局 (`stationsOf`)。局名の行を番組より先に描く */
    services,
    /** 分割放送のあるサブチャンネル。サブの列もマスより先に立てておく (`columnsOf`) */
    split,
    // 詳細の「視聴」を出すかどうか。決め方はライブ画面と揃えてある (watchableServices)
    watchable: watchableServices(Date.now()),
    /** サブチャンネルも出すか (`#lib/subchannels.ts`)。端末ごとに覚える */
    subchannels: storedSubchannels(cookies.get(SUBCHANNELS_COOKIE)),
    typeEmpty,
    channelNotice: typeEmpty ? null : channelNotice(counts),
  };
}

export const actions = {
  /** 番組表から予約を止める。予約一覧まで行かずに済むように */
  cancel: async ({ request }) => {
    const form = await request.formData();
    const programId = Number(form.get("programId"));
    if (!Number.isFinite(programId))
      return fail(400, { message: "番組IDが不正です" });
    const reservation = orm()
      .select({ id: reservations.id })
      .from(reservations)
      .where(
        and(
          eq(reservations.program_id, programId),
          ne(reservations.state, "canceled"),
        ),
      )
      .get();
    if (reservation === undefined)
      return fail(404, { message: "予約が見つかりません" });
    await cancel(reservation.id);
    return { success: true };
  },

  /**
   * 番組表から予約する。
   *
   * 録画のしかた(エンコードするか・元のTSを残すか)はここでは選ばせない。
   * 設定画面の1箇所で決める (docs/app.md)。番組ごとに変えたくなることが
   * 実際にはほとんど無いのに、同じ選択肢が予約・ルール・設定の3箇所にあると
   * 「どれで決まったのか」が分からなくなる
   */
  reserve: async ({ request }) => {
    const form = await request.formData();
    const programId = Number(form.get("programId"));
    if (!Number.isFinite(programId))
      return fail(400, { message: "番組IDが不正です" });
    try {
      await reserve(programId);
    } catch (error) {
      return fail(400, { message: String(error) });
    }
    return { success: true };
  },
};
