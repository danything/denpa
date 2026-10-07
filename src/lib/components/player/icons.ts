/**
 * 映像の上に置くアイコン。**3画面 (ライブ・追っかけ・観る画面) で同じものを使う。**
 *
 * 別々に持っていた頃は、同じ「再生」でも画面によって形が違っていた
 * (両方に同じ `d` を書き写していて、片方だけ直したときにずれる)。
 *
 * **形は Lucide** (`~icons/lucide/*`。組むときに `<svg>` ごと埋め込まれる Svelte の部品)。
 * 絵文字にしていた頃は端末ごとに形も大きさも変わり、`d` を手で写していた頃は
 * 足すたびに出どころを探していた。名前は https://lucide.dev/icons で引ける。
 * 置き方は `Icon.svelte` (大きさと aria-hidden)。
 *
 * **チャプター送り (`PREV`/`NEXT`)・CM飛ばし (`CUT`)・削除 (`TRASH`/`CHECK`) は
 * 観る画面だけ。** 切り抜き (`CAMERA`)・情報 (`INFO`)・データ放送 (`DATA`) は
 * **ライブでも使う** (切り抜きとデータ放送は両方に置いた)。
 *
 * **10秒送り・戻しの絵は持たない。** PCは矢印キー、指は左右の端を素早く2回
 * (`ts/watch.ts` の `tap`) でできるので、絵の上に常に2つ置くだけの用が無かった。
 *
 * 並びは名前順 (biome が揃える)
 */

import type { Component } from 'svelte';
import type { SvelteHTMLElements } from 'svelte/elements';

/** アイコン1つの型 (`~icons/*` が返す部品) */
export type IconShape = Component<SvelteHTMLElements['svg']>;

/**
 * データ放送。**テレビのリモコンと同じ「d」**。
 *
 * 絵柄では何のことか伝わらないので、字そのものを形にしてある (角丸の四角に d)。
 * Lucide に無いので自前 (`src/lib/icons/data.svg`)。線の太さと角は Lucide に揃える
 */
export { default as DATA } from '~icons/denpa/data';
/** 音声を選ぶ (主・副・二か国語) */
export { default as AUDIO } from '~icons/lucide/audio-lines';
/** 切り抜き (いまの1コマを PNG に) */
export { default as CAMERA } from '~icons/lucide/camera';
export { default as CAPTION } from '~icons/lucide/captions';
/** 聞き返しの2回目 (レ点)。**文字を出さずに「これでいいか」を言う** */
export { default as CHECK } from '~icons/lucide/check';
/** 録画 (ライブの右上)。押すといま流れている番組の録画が始まる。丸に点 (録画の印) */
export { default as RECORD } from '~icons/lucide/circle-dot';
/**
 * 「ほか」(⋯)。**狭い枠でだけ出す** — 毎回は使わないもの (音声・送り・CM 飛ばし・焼き方・速さ・バックグラウンド再生・小窓) を
 * 畳んでおく口 (`Extras.svelte`)
 */
export { default as MORE } from '~icons/lucide/ellipsis';
/**
 * Hybridcast。**別のタブへ出ていく**ので「四角から飛び出す矢印」。
 *
 * データ放送の `d` と並べるものなので、**同じ形にはしない** — あちらは
 * denpa の中で開くもの、こちらは外へ出ていくもので、押した結果がまるで違う
 */
export { default as OPEN_OUT } from '~icons/lucide/external-link';
/**
 * バックグラウンド再生 (裏に回しても止めない)。ヘッドホン — 裏で続けるのはたいてい
 * 聴くため。入れている間は押されている見た目 (`OVERLAY_ON`)
 */
export { default as BACKGROUND } from '~icons/lucide/headphones';
/** 中身を読む。丸に i */
export { default as INFO } from '~icons/lucide/info';
/** 全画面にする / 戻す */
export { default as EXPAND } from '~icons/lucide/maximize';
export { default as SHRINK } from '~icons/lucide/minimize';
export { default as PAUSE } from '~icons/lucide/pause';
/**
 * ピクチャーインピクチャー (小窓)。大きな枠の右下に小さな枠。
 * 出している間は押されている見た目 (`OVERLAY_ON`)
 */
export { default as PIP } from '~icons/lucide/picture-in-picture-2';
export { default as PLAY } from '~icons/lucide/play';
/** CM飛ばし。**鋏**にしてあるのは、送りのボタン (`NEXT`) と見分けるため */
export { default as CUT } from '~icons/lucide/scissors';
/** チャプター送り・戻し */
export { default as PREV } from '~icons/lucide/skip-back';
export { default as NEXT } from '~icons/lucide/skip-forward';
export { default as TRASH } from '~icons/lucide/trash';
export { default as SOUND_ON } from '~icons/lucide/volume-2';
export { default as SOUND_OFF } from '~icons/lucide/volume-off';
export { default as CLOSE } from '~icons/lucide/x';

/**
 * 絵の上に置くボタンの見た目。**読めるように黒く敷く。**
 *
 * 主題の文字色に任せていた頃 (daisyUI の `btn-ghost`) は、暗い絵と
 * 下の黒いぼかしに**アイコンが沈んで見えなく**なっていた。
 *
 * **クラスの中身は `ControlButton.svelte` の `<style>` (`:global`)。** 3画面とも
 * ControlButton を読み込むので、そこに置けば必ず届く
 */
export const OVERLAY = 'ov';

/**
 * 絵の上に置くボタンの大きさ。**3画面で同じ。**
 *
 * `btn-sm` (32px) にしていた頃は、**タブレットでもPCでも小さすぎた** —
 * 絵の上に薄く敷くものなので、輪郭で狙うのではなく面で狙うことになる。
 *
 * 引き出し (速さ・音声・焼き方) の口も同じ大きさで揃える (`OverlayMenu` の
 * 口は ControlButton)。ボタンでない `<a>` (閉じる) にはここの字を直に当てる
 */
export const OVERLAY_BTN = 'ov-btn';

/** 丸いボタン (アイコンだけのとき)。`OVERLAY_BTN` と一緒に使う */
export const OVERLAY_ROUND = 'ov-round';

/**
 * 聞き返しの2回目の見た目 (削除)。**大きさは変えない。**
 *
 * 「確定」の札に差し替えていた頃は、そこだけ幅が変わって**隣のボタンが動いて**
 * いた。聞き返しは同じ場所をもう一度押すものなので、動くと押し直せない。
 * 変えるのは色と絵だけ — 鋏や送りと違い、**赤いレ点は「これでいいか」以外に
 * 読みようが無い**
 */
export const OVERLAY_DANGER = 'ov-danger';

/** 押されている間の見た目 (字幕を出しているときなど。ライブに居るときは EdgeButton の OVERLAY_DANGER) */
export const OVERLAY_ON = 'ov-on';
