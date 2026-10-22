import * as migrate from "./migrate.server";
import * as notifications from "./notifications.server";
import * as tv from "./tv.server";

/**
 * 連携。通知 (Webhook)・テレビのアプリ・EPGStation からの引き継ぎの節を1つの画面に積む。
 * 読み込みと保存 (actions) は節ごとのファイルが持ち、ここでまとめる。
 * 返す値の名前と action の名前は節どうしで重ならない
 */
export function load() {
  return { ...notifications.load(), ...tv.load(), ...migrate.load() };
}

export const actions = {
  ...notifications.actions,
  ...tv.actions,
  ...migrate.actions,
};
