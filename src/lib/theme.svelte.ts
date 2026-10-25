/**
 * テーマ (ダーク・ライト・端末に合わせる)。**切り替えるのはヘッダーのボタン (狭い画面は下の「その他」) だけ。**
 *
 * 最初の色は `app.html` が描く前に当てる (ハイドレーションを待つと一瞬ちがう色が出る)。
 * ここは画面に出たあとの持ち主で、選び直したときに `<html>` の印と端末の控え (localStorage) を書く。
 * 端末ごとの話なのでサーバには置かない
 */

import { write } from "#lib/keep.js";
import { syncThemeColor } from "#lib/theme-color.js";

export type ThemeMode = "system" | "light" | "dark";

/** 並びはヘッダーのボタンで巡る順 */
const THEME_MODES: readonly ThemeMode[] = ["dark", "light", "system"];

export const THEME_LABEL: Record<ThemeMode, string> = {
  system: "端末に合わせる",
  light: "ライト",
  dark: "ダーク",
};

/** 既定はダーク (映像を観るものはダークが基本)。system は端末の設定に従う */
let mode = $state<ThemeMode>("dark");

function apply(): void {
  const dark =
    mode === "dark" ||
    (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset["theme"] = dark ? "dark" : "light";
  document.documentElement.dataset["themeMode"] = mode;
  // ブラウザの枠の色も地に合わせる (`theme-color.ts`)
  syncThemeColor();
  // ホーム画面から開いた Android の下のジェスチャーバー (マニフェストの background_color。`server/manifest.ts`)。
  // Chrome が次にマニフェストを読み直したときに効く
  const link = document.querySelector('link[rel="manifest"]');
  const href = link?.getAttribute("href")?.split("?")[0];
  if (link && href !== undefined)
    link.setAttribute("href", dark ? href : `${href}?theme=light`);
}

/**
 * **選び直したときは、画面全体を前の色から次の色へなめらかに移す** (View Transitions の種類 `theme`。動きは `app.css` の「明暗の切り替え」)。
 * 地・件の面・ヘッダーはそれぞれ自分の色を持つので、どれか 1 つに transition を付けると、ほかが先に替わって段違いに見える。
 * 画面の写しを 1 枚撮って重ねるだけなので、移っている間も色を描き直さない。
 *
 * 移さずにすぐ替えるのは、動きを減らす設定の端末・種類を渡せないブラウザ・ソフトウェアで描いている端末 (`<html data-lite>`。重ねるのも CPU がやる)・映像を流している間
 * (移っている間は写しが映像を止めて見せる)。開いたときと端末の設定に従うときは `apply` を直に呼ぶので、移らない
 */
function crossfade(change: () => void): void {
  const playing = [...document.querySelectorAll("video")].some(
    (video) => !video.paused,
  );
  if (
    typeof ViewTransition === "undefined" ||
    !("types" in ViewTransition.prototype) ||
    matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.hasAttribute("data-lite") ||
    playing
  ) {
    change();
    return;
  }
  document.startViewTransition({ update: change, types: ["theme"] });
}

export const theme = {
  get mode(): ThemeMode {
    return mode;
  },

  /**
   * 画面に出たら `app.html` が当てた値を読み、端末側の設定の変化を見はじめる。返すのは止める関数
   */
  start(): () => void {
    const shown = document.documentElement.dataset["themeMode"];
    mode = shown === "light" || shown === "system" ? shown : "dark";
    // 端末側の設定が変わったら、system のときだけ追従する
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (mode === "system") apply();
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  },

  set(next: ThemeMode): void {
    mode = next;
    // 既定がダークなので「端末に合わせる」も選んだ印として残す (残さないと次に開いたときダークに戻る)
    write("theme", next);
    crossfade(apply);
  },

  /** ヘッダーのボタン。ダーク → ライト → 端末に合わせる の順に巡る */
  cycle(): void {
    theme.set(
      THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length]!,
    );
  },
};
