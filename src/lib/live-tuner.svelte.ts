/**
 * ライブで使うチューナーの名指し (デバッグ用。設定の「その他」の「この端末」にある)。
 *
 * ふつうはエージェントが選ぶ (docs/agent.md「選ぶ順の約束」)。ここで選ぶと、ライブの選局にエージェントの
 * `tuner` として渡り、そのチューナーだけで選局する。使えなければ、ほかへ振り替えずに理由を出す。
 * 端末ごとの話なのでサーバには置かず、端末に覚える (localStorage)
 */

import { forget, read, write } from "#lib/keep.js";

const KEY = "denpa_live_tuner";

/** 設定画面が選択肢に出すいまの値。ライブの選局は覚えた値を直に読む (`pinnedTuner`) */
let pin = $state<string | null>(null);

/** 覚えている名指し。無ければ null (エージェントに任せる) */
export function pinnedTuner(): string | null {
  const value = read(KEY);
  return value === null || value === "" ? null : value;
}

export const liveTuner = {
  get pin(): string | null {
    return pin;
  },

  /** 設定画面を開いたときに覚えた値を読む */
  load(): void {
    pin = pinnedTuner();
  },

  /** 選び直す。null で名指しをやめる */
  set(next: string | null): void {
    pin = next;
    if (next === null) forget(KEY);
    else write(KEY, next);
  },
};
