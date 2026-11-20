import { type Agent, listAgents } from "#lib/server/agents.js";
import { tokenRefusal } from "#lib/server/auth.js";
import { tunerList } from "#lib/server/tuner.js";

import * as agents from "./agents.server";
import * as broadcast from "./broadcast.server";
import * as channels from "./channels.server";
import * as logos from "./logos.server";
import * as tuners from "./tuners.server";

/**
 * 受信。エージェント・チューナー・チャンネル (局ロゴ・CM ロゴも)・データ放送の節を 1 つの画面に積む。
 * 読み込みと保存 (actions) は節ごとのファイルが持ち、ここでまとめる。
 * 返す値の名前と action の名前は節どうしで重ならない。
 * **エージェントごとのチューナーの一覧は 1 度だけ取得し**、エージェントの節 (台数) とチューナーの節 (表) で分け合う。
 * アクセストークンにはどちらの節も返さないので、エージェントを呼ばない
 */
export async function load({ locals }) {
  let all: Agent[] = [];
  try {
    if (tokenRefusal(locals) === null) all = listAgents();
  } catch {
    // TUNER_AGENT_URL が読めない。理由はエージェントを呼ぶところで出る
  }
  const lists: tuners.Lists = new Map(
    all.map((agent) => [agent.id, tunerList(agent)]),
  );
  return {
    ...agents.load(locals, all, lists),
    ...tuners.load(locals, all, lists),
    ...channels.load(),
    ...logos.load(),
    ...broadcast.load(),
  };
}

export const actions = {
  ...agents.actions,
  ...tuners.actions,
  ...channels.actions,
  ...logos.actions,
  ...broadcast.actions,
};
