/**
 * データ放送を常に受信するか (ライブと録画の観る画面の、再生の設定の行。両方で同じ1つ)。**端末ごとに覚える** (`keep.ts`)。既定はオフ。
 *
 * 受信するのと開くのは別のこと。受信していると、開く前から入口の文書を裏で動かし、文書が自分で出したもの
 * (番組からの誘導・自動で出る画面) をテレビと同じく映像に重ねる。リモコンを出すのは開いたときだけ
 * (`DataBroadcast` の `receive`)。家の中の端末では受信しておきたいが、出先の回線では要らない、のように端末で変わる。
 *
 * 録画では、変化ログ (`server/recorded-bml.ts`) を開く前から取得して、再生位置に合わせて流す
 */

/** 覚える鍵。`1` / `0`。頭の `player-` は、バックグラウンド再生 (`player-background`) と同じく画面をまたいで効くもの */
export const DATA_RECEIVE_KEY = "player-data-always";

/** 覚えていた値。**既定はオフ** — オンにしたことのある端末だけオンで始まる */
export function storedDataReceive(saved: string | null): boolean {
  return saved === "1";
}

/**
 * サーバに受信をリクエストするか。開いている (d) か、常に受信していて局を映しているとき
 * (追っかけ・録画に譲っている間は局のデータ放送が無いのでリクエストしない)
 */
export function wantsData(now: {
  open: boolean;
  always: boolean;
  tuned: boolean;
}): boolean {
  return now.open || (now.always && now.tuned);
}
