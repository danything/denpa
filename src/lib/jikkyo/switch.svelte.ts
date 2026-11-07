import { MediaQuery } from "svelte/reactivity";

import { PHONE_LANDSCAPE } from "#lib/components/player/PlayerLayout.svelte";
import { read, write } from "#lib/keep.js";

/**
 * 実況を流すか (⚙ の「実況」)。**端末ごとに覚える** (`keep.ts`)。既定はオフ。
 * ライブ・追っかけ・観る画面で同じキー (先頭の `player-` は、画面をまたいで効くもの)。
 * 出すのは世帯の設定 (連携の「実況」) がオンのときだけで、そちらは画面が load で受け取る
 */
const JIKKYO_KEY = "player-jikkyo";
/** 右の列に「コメントの一覧」を出すか (映像の右端の列のボタン)。これも端末ごと。既定は出さない */
const JIKKYO_LIST_KEY = "player-jikkyo-list";

interface JikkyoSwitch {
  readonly on: boolean;
  toggle: () => void;
}

export function jikkyoSwitch(key = JIKKYO_KEY): JikkyoSwitch {
  /** 開いた端末で決まる。サーバで組むときは無いので、開いてから読む */
  let on = $state(false);
  $effect(() => {
    on = read(key) === "1";
  });
  return {
    get on() {
      return on;
    },
    toggle() {
      on = !on;
      write(key, on ? "1" : "0");
    },
  };
}

interface JikkyoListSwitch extends JikkyoSwitch {
  /** 一覧を出せる形か。実況を流していて (`ready`)、右の列がある (横にしたスマホ・全画面でない) */
  readonly can: boolean;
  /** 一覧を出している (出せる形で、ボタンで出してある) */
  readonly shown: boolean;
}

/**
 * **右の列の「コメントの一覧」(`JikkyoList`) を出すか** (3 画面で同じ)。映像の右端の列のボタンで出し入れし、端末ごとに覚える (`JIKKYO_LIST_KEY`)。
 * 右の列の無い形 (横にしたスマホ・全画面) では出さない。`ready` は実況を流していて、実況のチャンネルがあるか
 */
export function jikkyoListSwitch(
  ready: () => boolean,
  fullscreen: () => boolean,
): JikkyoListSwitch {
  const list = jikkyoSwitch(JIKKYO_LIST_KEY);
  const phoneLandscape = new MediaQuery(PHONE_LANDSCAPE);
  const can = $derived(ready() && !phoneLandscape.current && !fullscreen());
  return {
    get on() {
      return list.on;
    },
    toggle: list.toggle,
    get can() {
      return can;
    },
    get shown() {
      return can && list.on;
    },
  };
}
