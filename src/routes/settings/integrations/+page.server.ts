import * as jikkyo from "./jikkyo.server";
import * as migrate from "./migrate.server";
import * as notifications from "./notifications.server";
import * as transfer from "./transfer.server";
import * as tv from "./tv.server";

/**
 * 連携。通知 (Webhook)・テレビのアプリ・実況・EPGStation と EDCB からの引き継ぎ・denpa を別の機械へ移すの節を1つの画面に積む。
 * 読み込みと保存 (actions) は節ごとのファイルが持ち、ここでまとめる。
 * 返す値の名前と action の名前は節どうしで重ならない
 */
export function load() {
  return {
    ...notifications.load(),
    ...tv.load(),
    ...jikkyo.load(),
    ...migrate.load(),
    ...transfer.load(),
  };
}

export const actions = {
  ...notifications.actions,
  ...tv.actions,
  ...jikkyo.actions,
  ...migrate.actions,
};
