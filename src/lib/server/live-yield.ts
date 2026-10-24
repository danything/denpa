/**
 * **ライブがどの録画にチューナーを譲ったか**を突き止める。
 *
 * ライブは録画にだけ譲る (`config.priority`)。エージェントは録画より優先度の低い相手 (ライブを含む) しか
 * いないチューナーも使ってよいとみなし、要れば取り上げる (docs/agent.md「選ぶ順の約束」) ので、ほかに空いている
 * チューナーがあってもライブがチューナーを取り上げられることがある。取り上げられたライブは画面が同じ局をリクエストし直し、それでも入れない
 * ときだけチューナーを取り上げた録画の追っかけに切り替える (`live-player.svelte.ts`・テレビのアプリ)。ここはその
 * 「チューナーを取り上げた録画」を名指しするところ。
 *
 * **エージェントには訊かない。** エージェントは予約を知らない (知らせる約束にしていない) し、取り上げた
 * 相手を教える API も無い。代わりに denpa が自分で読む:
 *
 * 1. 使えたら、自分の利用者 (`live <種別>/<チャンネル>`) がいるチューナーを `GET /denpa/tuners` から覚える (`tunerOf`)
 * 2. 取り上げられたら、そのチューナーの利用者にいる録画 (`rec <録画ID>`。`tuner.recordingUse`) を読む (`recordingOn`)
 *
 * 1回の選局の利用者は終わるまで同じチューナーにいる約束 (同じ節の3) なので、覚えたチューナーは取り上げられるまで変わらない。
 * 取り上げた録画は、取り上げたチューナーに入る — そのチューナーに録画の利用者がいれば、それが取り上げた相手
 */

import { eq } from "drizzle-orm";

import type { YieldedRecording } from "#lib/live.js";

import { orm } from "./db";
import { recordingUntil } from "./recorder";
import { recordings } from "./schema";
import { displayTitle } from "./title";
import { type AgentTuner, getTuners, recordingOf } from "./tuner";

type Listed = Pick<AgentTuner, "index" | "channel" | "users">;

/** その利用者がいるチューナー (`index`)。いなければ null */
export function tunerOf(
  tuners: readonly Listed[],
  type: string,
  channel: string,
  use: string,
): number | null {
  const found = tuners.find(
    (tuner) =>
      tuner.channel?.type === type &&
      tuner.channel.channel === channel &&
      tuner.users.some((user) => user.use === use),
  );
  return found?.index ?? null;
}

/** そのチューナーにいる録画の ID。録画の利用者がいなければ null (2つあれば先のほう。どちらも同じチューナーを塞いでいる) */
export function recordingOn(
  tuners: readonly Listed[],
  index: number,
): number | null {
  const tuner = tuners.find((t) => t.index === index);
  for (const user of tuner?.users ?? []) {
    const id = recordingOf(user.use);
    if (id !== null) return id;
  }
  return null;
}

/**
 * 取り上げられてから読み直す回数と間 (ms)。**取り上げることと録画が入ることは、エージェントの中で前後しうる**
 * (取り上げられた側が途切れに気付いた時点で、まだ録画の利用者が載っていないことがある)。長くは待たない —
 * 待つ間、画面は前の映像のまま止まっている
 */
const LOOKS = 5;
const LOOK_WAIT = 300;

/** 録画の行から、画面に渡す形式を作る。消された・無い録画なら null */
function lookup(id: number): YieldedRecording | null {
  const rec = orm()
    .select({
      name: recordings.name,
      service_name: recordings.service_name,
      end_at: recordings.end_at,
      record_to: recordings.record_to,
      deleted_at: recordings.deleted_at,
    })
    .from(recordings)
    .where(eq(recordings.id, id))
    .get();
  if (rec === undefined || rec.deleted_at !== null) return null;
  return {
    id,
    title: displayTitle(rec.name),
    serviceName: rec.service_name,
    endAt: recordingUntil(rec),
  };
}

/**
 * 覚えておいたチューナー (`tunerOf`) にいまいる録画。**いなければ null** (録画以外に外された・チューナーを覚えて
 * いなかった・エージェントに訊けなかった)。そのときは画面はリクエストし直すだけで、追っかけには切り替えない
 */
export async function yieldedTo(
  index: number | null,
  list: () => Promise<readonly Listed[]> = getTuners,
  find: (id: number) => YieldedRecording | null = lookup,
  wait: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<YieldedRecording | null> {
  if (index === null) return null;
  for (let look = 0; look < LOOKS; look++) {
    if (look > 0) await wait(LOOK_WAIT);
    let tuners: readonly Listed[];
    try {
      tuners = await list();
    } catch {
      // エージェントが入れ替わっている最中かもしれない。読み直す
      continue;
    }
    const id = recordingOn(tuners, index);
    if (id !== null) return find(id);
  }
  return null;
}
