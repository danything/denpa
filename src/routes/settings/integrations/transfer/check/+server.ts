import { json } from "@sveltejs/kit";

import { check } from "#lib/server/transfer.js";

import { failure, refuse } from "../guard.server";

/**
 * **確かめる。** 送ったファイルを開いて migrate を当て、録画のファイルが置き場にあるかを数える。
 * 「もう一度確かめる」も同じ (開くのは初めの 1 回だけ)
 */
export async function POST(event) {
  const refused = refuse(event);
  if (refused !== null) return refused;
  try {
    return json(await check());
  } catch (error) {
    return failure(error);
  }
}
