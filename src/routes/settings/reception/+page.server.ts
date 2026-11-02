import { seenLineupChanges } from "#lib/server/lineup-follow.js";

import * as broadcast from "./broadcast.server";
import * as channels from "./channels.server";
import * as logos from "./logos.server";
import * as tuners from "./tuners.server";

/**
 * 受信。チューナー・チャンネル (局ロゴ・CMロゴも)・データ放送の節を1つの画面に積む。
 * 読み込みと保存 (actions) は節ごとのファイルが持ち、ここでまとめる。
 * 返す値の名前と action の名前は節どうしで重ならない
 */
export async function load() {
  // チャンネルを書き換えたお知らせは、ここを開いたら消す (書き換えたチャンネルはここに並んでいる)
  seenLineupChanges();
  return {
    ...(await tuners.load()),
    ...channels.load(),
    ...logos.load(),
    ...broadcast.load(),
  };
}

export const actions = {
  ...tuners.actions,
  ...channels.actions,
  ...logos.actions,
  ...broadcast.actions,
};
