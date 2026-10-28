/**
 * 映像の上に置くアイコン (3画面で同じ)。形は Lucide (`~icons/lucide/*`。名前は https://lucide.dev/icons で引ける)。
 * 置き方は `Icon.svelte`。並びは読み込み元の名前順
 */

import type { Component } from "svelte";
import type { SvelteHTMLElements } from "svelte/elements";

/** アイコン1つの型 (`~icons/*` が返す部品) */
export type IconShape = Component<SvelteHTMLElements["svg"]>;

/** データ放送。テレビのリモコンと同じ「d」(Lucide に無いので自前。`src/lib/icons/data.svg`) */
export { default as DATA } from "~icons/denpa/data";
/** 音声を選ぶ (主・副・二か国語) */
export { default as AUDIO } from "~icons/lucide/audio-lines";
/** 切り抜き (いまの1コマを PNG に) */
export { default as CAMERA } from "~icons/lucide/camera";
export { default as CAPTION } from "~icons/lucide/captions";
/** 聞き返しの2回目 (レ点)。**文字を出さずに「これでいいか」を言う** */
export { default as CHECK } from "~icons/lucide/check";
/** 再生の設定 (`SettingsMenu`) の選択肢の並びから戻る / 選択肢の並びに入る */
export { default as BACK } from "~icons/lucide/chevron-left";
export { default as FORWARD } from "~icons/lucide/chevron-right";
/** 録画 (ライブの右上)。押すといま流れている番組の録画が始まる。丸に点 (録画の印) */
export { default as RECORD } from "~icons/lucide/circle-dot";
/** Hybridcast。別のタブへ出ていくので、denpa の中で開くデータ放送の `d` とは違う形にする */
export { default as OPEN_OUT } from "~icons/lucide/external-link";
/** コーデック (再生の設定の行) */
export { default as CODEC } from "~icons/lucide/film";
/** 再生の速さ (`SpeedMenu`)。等速のときだけ出し、速めている間は数字だけにする */
export { default as SPEED } from "~icons/lucide/gauge";
/** バックグラウンド再生。ヘッドホン — 裏で続けるのはたいてい聴くため */
export { default as BACKGROUND } from "~icons/lucide/headphones";
/** 中身を読む。丸に i */
export { default as INFO } from "~icons/lucide/info";
/** 全画面にする / 戻す */
export { default as EXPAND } from "~icons/lucide/maximize";
/** 実況のコメント (再生の設定の行) */
export { default as JIKKYO } from "~icons/lucide/message-square-text";
export { default as SHRINK } from "~icons/lucide/minimize";
/** 互換モード (再生の設定の行。動画が止まる端末向けに canvas に描く。`canvas-video.ts`) */
export { default as COMPAT } from "~icons/lucide/monitor-play";
export { default as PAUSE } from "~icons/lucide/pause";
/** ピクチャーインピクチャー (小窓) */
export { default as PIP } from "~icons/lucide/picture-in-picture-2";
export { default as PLAY } from "~icons/lucide/play";
/** CM飛ばし。**鋏**にしてあるのは、送りのボタン (`NEXT`) と見分けるため */
export { default as CUT } from "~icons/lucide/scissors";
/** 再生の設定 (⚙ `SettingsMenu`) */
export { default as SETTINGS } from "~icons/lucide/settings";
/** チャプター送り・戻し */
export { default as PREV } from "~icons/lucide/skip-back";
export { default as NEXT } from "~icons/lucide/skip-forward";
/** アンビエントモード (`AmbientGlow.svelte`)。弱い光を放つ太陽 */
export { default as AMBIENT } from "~icons/lucide/sun-dim";
export { default as TRASH } from "~icons/lucide/trash";
export { default as SOUND_ON } from "~icons/lucide/volume-2";
export { default as SOUND_OFF } from "~icons/lucide/volume-off";
export { default as CLOSE } from "~icons/lucide/x";

/** 映像の上に置くボタンの字と影 (中身は `ControlButton.svelte` の `<style>` の `:global`。3画面とも読み込むので届く) */
export const OVERLAY = "ov";

/** 映像の上に置くボタンの大きさ (48px。面で狙うもの)。ボタンでない `<a>` (閉じる) にも当てる */
export const OVERLAY_BTN = "ov-btn";

/** 丸いボタン (アイコンだけのとき)。`OVERLAY_BTN` と一緒に使う */
export const OVERLAY_ROUND = "ov-round";

/**
 * 聞き返しの2回目の見た目 (削除)。大きさは変えず色とアイコンだけ変える — 「確定」の文字にすると幅が変わって
 * 隣のボタンが動き、同じ場所を押し直せなかった
 */
export const OVERLAY_DANGER = "ov-danger";

/** 押されている間の見た目 (字幕を出しているときなど。ライブにいるときは EdgeButton の OVERLAY_DANGER) */
export const OVERLAY_ON = "ov-on";
