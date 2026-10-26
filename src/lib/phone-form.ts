/**
 * **テーブルトップ** (折り畳み端末を半分に折って机に置いた形)。折っていて (`device-posture: folded`)、
 * 画面が上下 2 段に分かれている (`vertical-viewport-segments: 2`。折り目が横)。どちらも Android の Chrome 系だけが知っていて、
 * 知らないブラウザ・平らに開いた端末・本の形 (左右 2 段) では当たらない。
 * 映像の画面の並べ方 (`PlayerLayout` などの `@media`) も同じ条件 — CSS には変数で渡せないので、変えるときは両方 (`phone-form.test.ts` が見る)
 */
export const TABLETOP =
  "(device-posture: folded) and (vertical-viewport-segments: 2)";

/**
 * **スマホの形** (上のヘッダーを出さず、画面の下にタブを出す。操作の 1 行もタブのすぐ上に浮かべる)。**条件はここだけで決める。**
 * 1000px 未満 (スマホ・タブレット・狭めた窓。ヘッダーに画面のリンクと検索の欄を並べきれない) と、テーブルトップ (横幅は広いが上下の段がどちらも低いので、操作を下へ寄せる)。
 * 横にしたスマホ (844px など) も幅で入る。開いた Fold の横持ち (1104px) は幅では入らないので、テーブルトップは残す。
 * 条件を足すときはこの並びに足す (どれか 1 つに当たればスマホの形)。
 *
 * CSS の `@media` には名前を付けて引けないので、`<html data-phone>` の印にして配る。`app.html` の頭のスクリプトが
 * 描く前に付け、当たり外れが変わるたびに付け直す (条件の文字は `hooks.server.ts` が差し込む)。
 * CSS は `html[data-phone]` と `html:not([data-phone])` で書き分け、JS は `new MediaQuery(PHONE_FORM)` で見る。
 * ダイアログを下から出す・行を折り返すなど、幅だけで決まるものは今までどおり幅の `@media` で書く
 */
export const PHONE_FORM = ["(max-width: 999.98px)", TABLETOP].join(", ");
