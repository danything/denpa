/**
 * データ放送を自動で受信するか (ライブと録画の観る画面の、データ放送のボタン (d) の長押し。両方で同じ 1 つ)。
 * **端末ごとに覚える** (`keep.ts`)。既定はオフ。
 *
 * 受信するのと開くのは別のこと。自動で受信する端末は、放送局が入口に自動起動の指定 (`auto_start_flag`。
 * `ts/data-auto-start.ts` の `autoStarts`) を付けている局でだけ、開く前から受信して入口の文書を裏で動かし、
 * 文書が自分で出したもの (番組からの誘導・天気のような自動で出る画面) をテレビと同じく映像に重ねる。
 * 指定の無い局は d を押すまで受信しない (指定の無い入口は開くまで始まらないので、先に受け取っても使わない)。
 * リモコンを出すのは開いたときだけ (`DataBroadcast` の `receive`)。家の中の端末では受信しておきたいが、
 * 出先の回線では要らない、のように端末で変わる。
 *
 * 録画では、録画の PMT に指定があれば (`server/recorded-bml.ts` の `recordedAutoStart`)、
 * 変化ログを開く前から取得して、再生位置に合わせて流す
 */

/**
 * 覚えるキー。`1` / `0`。接頭辞の `player-` は、バックグラウンド再生 (`player-background`) と同じく画面をまたいで効くもの。
 * 名前は「常に受信」だった頃のまま (オンにしていた端末はオンのまま)
 */
export const DATA_RECEIVE_KEY = "player-data-always";

/** 覚えていた値。**既定はオフ**。オンにしたことのある端末だけオンで始まる */
export function storedDataReceive(saved: string | null): boolean {
  return saved === "1";
}

/** 切り替えたときの通知 */
export function dataReceiveNote(on: boolean): string {
  return on ? "データ放送を自動で受信します" : "データ放送を自動で受信しません";
}

/**
 * サーバに受信をリクエストするか。開いている (d) か、自動で受信していて、局を映していて、
 * その局の入口に自動起動の指定があるとき (`autoStart`。サーバが PMT を読んで知らせる `Notice` の `autoStart`)。
 * 追っかけ・録画に譲っている間は局のデータ放送が無いので、開いていなければリクエストしない。
 * 別の局への選局の答えを待っている間 (`switching`。`closingOnTune`) は、開いていてもリクエストしない。
 * 答えが届けば閉じるので、次の局のセッションが覚えているぶん (実機で約 2MB) を受け取っても使わない
 */
export function wantsData(now: {
  open: boolean;
  auto: boolean;
  tuned: boolean;
  autoStart: boolean;
  switching: boolean;
}): boolean {
  if (now.switching) return false;
  return now.open || (now.auto && now.tuned && now.autoStart);
}

/**
 * 選局したら開いたデータ放送を閉じるか。**別の局へ移ったら閉じる** (テレビと同じ。次の局は入口から始まり、d は押されていない)。
 * 開いたままにすると、次の局の入口に出す操作の d が届き (`DataBroadcast` の `knock`)、選局しただけでメニューまで開く。
 * 同じ局のリクエストし直し (`previous` と同じ) と、初めての選局 (`previous` が null) では閉じない。
 * 自動起動の指定 (`wantsData` の `autoStart`) も、閉じるときに忘れる (次の局の PMT を読むまで分からない)。
 * `previous`・`next` は局の内部 ID (`Tuned.serviceId`)
 */
export function closesData(previous: number | null, next: number): boolean {
  return previous !== null && previous !== next;
}

/**
 * 選局をリクエストしたとき、答えを待ってから閉じる局 (`closesData` が閉じると言う次の局)。閉じないなら null。
 * **閉じるのはサーバが選局を受けたとき** (`tunedCloses`)。リクエストした時点で閉じていた頃は、サーバが選局を
 * 断ると (復号できない局の `error`) 前の局を受信したまま、データ放送だけが閉じていた。
 * `onAir` はサーバが選局の答え (`tuned`) で受けたと知らせた局 (`Tuned.serviceId`)。追っかけの間も前の局のまま覚えておく
 */
export function closingOnTune(
  onAir: number | null,
  next: number,
): number | null {
  return closesData(onAir, next) ? next : null;
}

/**
 * 選局の答え (`tuned` の `serviceId`) が届いたとき、開いたデータ放送を閉じるか。待っていた局 (`closingOnTune`) の答えのときだけ閉じる。
 * 続けて選び直したあとで前の指示の答えが遅れて届いても、待っている局のものでなければ閉じない
 */
export function tunedCloses(closing: number | null, served: number): boolean {
  return closing !== null && closing === served;
}
