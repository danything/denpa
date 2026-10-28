import { read, write } from "#lib/keep.js";

/**
 * 実況を流すか (⚙ の「実況」)。**端末ごとに覚える** (`keep.ts`)。既定はオフ。
 * ライブ・追っかけ・観る画面で同じ鍵 (頭の `player-` は、画面をまたいで効くもの)。
 * 出すのは世帯の設定 (連携の「実況」) がオンのときだけで、そちらは画面が load で受け取る
 */
export const JIKKYO_KEY = "player-jikkyo";

export interface JikkyoSwitch {
  readonly on: boolean;
  toggle: () => void;
}

export function jikkyoSwitch(): JikkyoSwitch {
  /** 開いた端末で決まる。サーバで組むときは無いので、開いてから読む */
  let on = $state(false);
  $effect(() => {
    on = read(JIKKYO_KEY) === "1";
  });
  return {
    get on() {
      return on;
    },
    toggle() {
      on = !on;
      write(JIKKYO_KEY, on ? "1" : "0");
    },
  };
}
