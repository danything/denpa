import { json } from "@sveltejs/kit";

import { check } from "#lib/server/transfer.js";

import { failure, migrating, refuse } from "../guard.server";

/**
 * **確かめる。** 送ったファイルを開いて migrate を当て、録画のファイルが置き場にあるかを数える。
 * 「再確認」も同じ (開くのは初めの 1 回だけ)
 */
export async function POST(event) {
  const refused = refuse(event) ?? migrating();
  if (refused !== null) return refused;
  try {
    return json(await check());
  } catch (error) {
    return failure(error);
  }
}
