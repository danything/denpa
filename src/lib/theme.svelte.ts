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
export const THEME_MODES: readonly ThemeMode[] = ["dark", "light", "system"];

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
    apply();
  },

  /** ヘッダーのボタン。ダーク → ライト → 端末に合わせる の順に巡る */
  cycle(): void {
    theme.set(
      THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length]!,
    );
  },
};
