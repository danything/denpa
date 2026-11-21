import * as jikkyo from "./jikkyo.server";
import * as migrate from "./migrate.server";
import * as notifications from "./notifications.server";
import * as ranking from "./ranking.server";
import * as transfer from "./transfer.server";
import * as tv from "./tv.server";

/**
 * 連携。通知 (Webhook)・テレビのアプリ・実況 (ニコニコのアカウントとの連携も)・番組ランキング・EPGStation と EDCB からの引き継ぎ・denpa を別の機械へ移すの節を 1 つの画面に積む。
 * 読み込みと保存 (actions) は節ごとのファイルが持ち、ここでまとめる。
 * 返す値の名前と action の名前は節どうしで重ならない
 */
export function load({ locals }) {
  return {
    ...notifications.load(locals),
    ...tv.load(),
    ...jikkyo.load(),
    ...ranking.load(),
    ...migrate.load(),
    ...transfer.load(),
  };
}

export const actions = {
  ...notifications.actions,
  ...tv.actions,
  ...jikkyo.actions,
  ...ranking.actions,
  ...migrate.actions,
};
