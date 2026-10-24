import { type Actions, fail } from "@sveltejs/kit";
import { sql } from "drizzle-orm";

import { forgetMaterials } from "#lib/server/cm-material-store.js";
import { orm } from "#lib/server/db.js";
import {
  forgetLogoData,
  learnedAt,
  siblings,
  stations,
  stats as learnStats,
} from "#lib/server/logo-data.js";
import {
  logoState,
  stats as logoStats,
  sweepNow,
  sweepState,
} from "#lib/server/logo.js";
import { services } from "#lib/server/schema.js";
import type { ChannelType } from "#lib/types.js";

/**
 * 局ごとのロゴ。**番組表に出す局ロゴと、CM検出のために覚えたロゴは別物** (logo.ts と logo-data.ts) だが、
 * 確かめたいのはどちらも「この局のロゴが取れているか・合っているか」なので、受信できるチャンネルの表の局の行に
 * 列を2つ並べる (`Channels.svelte`。局名と種別を別の表で繰り返さない)。
 *
 * - `logo` … 局ロゴの具合 (`logo.logoState`)
 * - `cm` … CM検出のロゴを覚えた時刻 (`logo-data.learnedAt`)。覚えていなければ null。
 *   CM検出の対象でない局 (テレビでない局・同じ映像を流しているサブチャンネル) もいつも null
 */
function stationLogos() {
  const rows = orm()
    .select({
      id: services.id,
      name: services.name,
      type: services.type,
      network_id: services.network_id,
      service_type: services.service_type,
    })
    .from(services)
    // いま選局できる局だけ (`epg.CURRENT_SERVICES` と同じ)
    .where(
      sql`${services.updated_at} >= (SELECT MAX(${services.updated_at}) FROM ${services})`,
    )
    .orderBy(services.service_id)
    .all();
  /*
   * CM検出のロゴを出す局。数え上げ (`logo-data.stats`) と同じく、テレビの局で、同じ映像を流している
   * サブチャンネルの枠は束ねて1局にする (覚えたものは写し合うので、束ねないと同じ画像が2つ並ぶ)
   */
  const cmShown = new Set(
    stations(rows.filter((row) => row.service_type === 1)).map((row) => row.id),
  );
  const order: Record<string, number> = { GR: 0, BS: 1, CS: 2 };
  return rows
    .map(({ id, name, type }) => ({
      id,
      name,
      type: type as ChannelType,
      logo: logoState(id),
      cm: cmShown.has(id) ? learnedAt(id) : null,
    }))
    .sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
}

export function load() {
  return {
    stations: stationLogos(),
    /*
     * 局ロゴを何局ぶん持っているか。
     *
     * ロゴは放送波から取得するしかないが、取得できたかどうかを確かめる場所が
     * どこにも無かった。番組表にロゴが出ないとき、取れていないのか
     * 出し方が悪いのかを見分けられるようにする
     */
    logos: logoStats(),
    /*
     * 取得している最中の様子。1チャンネルに数分かかるので、出さないと
     * 押しても何も起きていないように見える
     */
    logoSweep: sweepState(),
    /** CM検出のロゴを何局ぶん覚えたか (logo-data.ts) */
    cmLogoStats: learnStats(),
  };
}

export const actions = {
  /**
   * 覚えたロゴを捨てる。
   *
   * 自動の割り出しが見るのは「画面の隅で線の向きが毎コマ揃うこと」だけなので、
   * ロゴではないもの (番組がずっと出しているテロップの飾り、常時出ている枠) を
   * 覚えることがある。
   *
   * 捨てれば、**次にその局を録ってエンコードしたときに一から覚え直します** (`logo-own`)
   */
  logoForget: async ({ request }) => {
    const form = await request.formData();
    const serviceId = Number(form.get("serviceId"));
    if (!Number.isFinite(serviceId))
      return fail(400, { message: "局IDが不正です" });
    // 同じ映像を映しているサブチャンネルの枠にも配ってある (`logo-data.share`)
    const ids = [serviceId, ...siblings(serviceId)];
    for (const id of ids) forgetLogoData(id);
    // 控えておいた CM 検出の材料も捨てる。ロゴの区間は捨てた型で当てたもの (`cm-material-store.forgetMaterials`)
    forgetMaterials(ids);
    return {
      success: true,
      done: "覚えたロゴを消しました。次にこの局を録画したときに覚え直します",
    };
  },

  /**
   * 局ロゴを取得する。**チューナー2つで、衛星も混ぜて。**
   *
   * ロゴは放送波に数十秒〜数分に一度しか流れてこないので、押してもその場では
   * 出ない。どこまで進んだかを画面に流すので、押した人は待たなくていい。
   *
   * 衛星も対象にする。ロゴを運ぶ中継は1つだけで、当たれば数十秒で全局ぶんが
   * 揃い、外れは PAT を見た時点 (1秒ほど) で次へ行くので、待たせる時間は
   * 地上波と変わらない。当たり外れは覚えるので、二度目からは当たりだけを開く
   */
  logoSweep: async () => {
    const result = await sweepNow();
    if (!result.started) return fail(409, { message: result.message });
    return { success: true, scan: result.message };
  },
} satisfies Actions;
