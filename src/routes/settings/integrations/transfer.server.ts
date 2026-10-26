import { status } from "#lib/server/transfer.js";

/**
 * denpa を別の機械へ移す (書き出す・取り込む)。押したときの処理はフォームの action ではなく
 * `transfer/` の下のエンドポイント (小分けに送るため。書き出しはダウンロードとして返すため)
 */
export function load() {
  return { transfer: status() };
}
