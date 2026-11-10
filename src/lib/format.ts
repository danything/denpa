import type { CardReaderState } from "./server/scramble";
import type { TunerSignal } from "./server/tuner";
import type { VideoLoss } from "./types";

export const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * チャンネル種別の見出し。**どれを出すか (並び) は画面ごとに決める**。
 * ここは名前だけ。5 画面が同じ表をコピーしていたのを 1 つに (CATV と SKY が並ぶのはルールの条件と、
 * 受けられる機材があるときの受信の設定だけ。`types.ts` の `shownTypes`)
 */
export const SERVICE_TYPE_LABEL: Record<string, string> = {
  GR: "地上波",
  BS: "BS",
  CS: "CS",
  CATV: "ケーブルテレビ",
  SKY: "スカパー！プレミアム",
};

/** 種別の並びを画面の名前で (「地上波・BS・CS」)。知らない種別は符号のまま */
export function typeNames(types: readonly string[]): string {
  return types.map((type) => SERVICE_TYPE_LABEL[type] ?? type).join("・");
}

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function time(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 日付だけ。時刻と 2 行に分けて出すとき用 */
export function date(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
}

/**
 * 西暦つきの日付 (`2026/10/11(日)`)。録画と切り抜きの日付の見出しで使う。
 * 何年も溜まると同じ「10/11(日)」が並び、カレンダーの無いスマホの形では見分けられない (#1931)
 */
export function fullDate(ms: number): string {
  return `${new Date(ms).getFullYear()}/${date(ms)}`;
}

export function dateTime(ms: number): string {
  return `${date(ms)} ${time(ms)}`;
}

export function durationMs(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分`;
  const rest = min % 60;
  // 「24 時間 0 分」のような書き方は読みにくいので、端数が無いときは時間だけ出す
  return rest === 0
    ? `${Math.floor(min / 60)} 時間`
    : `${Math.floor(min / 60)} 時間 ${rest} 分`;
}

export function duration(startAt: number, endAt: number): string {
  return durationMs(endAt - startAt);
}

/** 「いま」の線に添える一言 (`NowLine`)。`short` は狭い幅で代わりに出す形 */
export interface NowStatus {
  text: string;
  short: string;
}

/**
 * **「いま」の線に添える一言。** 次の録画 (いまより後に始まる予約のうちいちばん早いもの) までを
 * 「次の録画まで 3 時間 59 分」と言う。無ければ null (何も添えない)。録画中かどうかは言わない。
 * 録画中の行は線の上にあり、あと何分かは行の 3 段目が言う (`recordingLeft`)。
 *
 * 分は切り上げる。線の時刻は分を切り捨てて出すので、22:00 の録画は 18:01 の間ずっと「3 時間 59 分」になり、
 * 時刻と食い違わない。1 日より先は日数で
 */
export function nowStatus(
  now: number,
  next: { start_at: number } | null,
): NowStatus | null {
  if (next === null) return null;
  return {
    text: `次の録画まで ${untilWords(next.start_at - now)}`,
    short: `次まで ${untilShort(next.start_at - now)}`,
  };
}

/**
 * **録画中の行の、あと何分か。** 「あと 21 分」(分は `nowStatus` と同じく切り上げ)。行の 3 段目に「録画中・あと 21 分」と出す (`RowActivity`)。
 * 終わりの時刻を過ぎても止まりきるまでは録画中のまま。そのときはあと何分かは言えないので null (「録画中」だけ)
 */
export function recordingLeft(now: number, endAt: number): string | null {
  return endAt <= now ? null : `あと ${untilWords(endAt - now)}`;
}

/** 切り上げた分。過ぎていても 1 分 (「0 分」とは言わない) */
function minutesUntil(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

/** 「3 時間 59 分」「12 分」「3 日」 */
function untilWords(ms: number): string {
  const min = minutesUntil(ms);
  return min < 24 * 60
    ? durationMs(min * 60_000)
    : `${Math.floor(min / (24 * 60))} 日`;
}

/** 狭い幅の形。「3:59」「12 分」「3 日」 */
function untilShort(ms: number): string {
  const min = minutesUntil(ms);
  if (min < 60) return `${min} 分`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}:${pad(min % 60)}`;
  return `${Math.floor(min / (24 * 60))} 日`;
}

/**
 * **チューナーの取り合いで、番組のどこが欠けるか。** 欠けないなら null。
 *
 * 重なりが番組の一部でしか起きていないときは、そこだけ譲って残りを録ります
 * ([server/conflict.ts](server/conflict.ts) の「入るところまで録る」)。
 * 番組の時刻は動かさないので、**譲った区間との差がそのまま欠けた幅**です。
 *
 * **マージンだけ削られたぶんは何も言いません。** 隣り合う番組はマージンぶんが
 * 必ず重なるので、そこまで数えると**ほとんどの録画にラベルが付いて意味を失います**
 */
export function clipNote(
  item: {
    start_at: number;
    end_at: number;
    record_from: number | null;
    record_to: number | null;
  },
  done = false,
): string | null {
  const head = item.record_from !== null ? item.record_from - item.start_at : 0;
  const tail = item.record_to !== null ? item.end_at - item.record_to : 0;
  const parts: string[] = [];
  if (head > 0) parts.push(`冒頭 ${durationMs(head)}`);
  if (tail > 0) parts.push(`末尾 ${durationMs(tail)}`);
  if (parts.length === 0) return null;
  return `${parts.join("と")}が${done ? "欠けています" : "欠けます"} (チューナー不足)`;
}

/**
 * 一覧に出す、映像が欠けた長さ (`recordings.video_loss`) の最短 (秒)。長さは分で出すので、1 分に満たないと
 * 「30 分のうち 30 分」になって伝わらない
 */
const VIDEO_LOSS_MIN = 60;

/**
 * **元の TS に映像が無かった所の言い方。** 出すほどでなければ null。
 * 映像が無いまま録画が終わったら「録画が途中で切れています」、途中だけなら「映像が途中で欠けています」。
 * どちらも、映像があるはずだった長さのうち、映像が残っている長さを添える (「30 分のうち 19 分」)。
 * 欠けた理由は書かない (サーバには分からない)
 */
export function videoLossNote(
  loss: VideoLoss | null,
): { label: string; detail: string } | null {
  if (loss === null || loss.lost < VIDEO_LOSS_MIN) return null;
  return {
    label: loss.tail ? "録画が途中で切れています" : "映像が途中で欠けています",
    detail: `${durationMs(loss.span * 1000)}のうち ${durationMs((loss.span - loss.lost) * 1000)}`,
  };
}

/**
 * 再生位置の表示。**`12:34` / `1:02:03`。**
 *
 * `durationMs` は「27 分」のように読み物の書き方をするもので、動かしている間の
 * 表示には向かない (秒が見えないと、10 秒送ったことが分からない)。
 * **1 時間を超えたときだけ時間を出す**。短いものに `0:12:34` と出ると、
 * 位を数えないと読めない
 */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * 録画の長さ。実際に録れた長さがあればそちらを出す。
 *
 * 番組表の尺 (end_at - start_at) は予定でしかなく、途中で止めたときや
 * 前のバージョンで CM を切ってエンコードしたときは出来上がりと合わない。取れていない古い行は予定で代用する。
 */
export function recordedDuration(recording: {
  duration_ms: number | null;
  start_at: number;
  end_at: number;
}): string {
  return recording.duration_ms != null && recording.duration_ms > 0
    ? durationMs(recording.duration_ms)
    : duration(recording.start_at, recording.end_at);
}

export function size(bytes: number): string {
  if (bytes <= 0) return "-";
  const gb = bytes / 1024 ** 3;
  return gb >= 1
    ? `${gb.toFixed(1)} GB`
    : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

/**
 * 進み具合のバー (`JobProgress`) に出す大きさの単位と換算。数百 GB をバイトで並べても読めないので、
 * 合計が 1GB 以上なら GB (小数 1 桁)、それより小さければ MB (引き継ぎ・別の機械へ移す)
 */
export function byteScale(total: number): {
  unit: "GB" | "MB";
  scaled: (bytes: number) => number;
} {
  return total >= 1024 ** 3
    ? {
        unit: "GB",
        scaled: (bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10,
      }
    : { unit: "MB", scaled: (bytes) => Math.round(bytes / 1024 ** 2) };
}

/**
 * 録画の見出しに添える空きと残り時間 (`disk.capacity`)。「空き 1.2TB」と「約 900 時間」。
 * 分けて返すのは、列が狭いと時間のほうだけ落とすため。目安が無ければ `hours` は null。
 *
 * **細かく出さない。** 見出しの脇に小さく置くので短く、また値が少し動くたびに
 * 画面の HTML が変わると ETag が合わなくなるので、サーバでこの粗さに丸めてから渡す。
 * 時間は桁に合わせて丸める (目安なので 937 と出すほどの精度は無い)
 */
export function capacityLabel(
  free: number,
  hours: number | null,
): { free: string; hours: string | null } {
  const tb = free / 1024 ** 4;
  const space =
    tb >= 1
      ? `${tb.toFixed(1)}TB`
      : free >= 1024 ** 3
        ? `${Math.floor(free / 1024 ** 3)}GB`
        : "1GB 未満";
  if (hours === null) return { free: `空き ${space}`, hours: null };
  if (hours < 1) return { free: `空き ${space}`, hours: "1 時間未満" };
  const step = hours >= 1000 ? 100 : hours >= 100 ? 10 : 1;
  return {
    free: `空き ${space}`,
    hours: `約 ${Math.floor(hours / step) * step} 時間`,
  };
}

/**
 * 進み具合。**小数第 1 位まで出す。**
 *
 * 整数だけだと、1 時間かかるエンコードでは同じ数字が 30 秒以上動かない。
 * 動いていないのか止まったのか画面から判らなかったので、1 桁足してある
 */
export function percent(value: number): string {
  const clamped = Math.min(Math.max(value, 0), 1);
  return `${(clamped * 100).toFixed(1)}%`;
}

/**
 * 残り時間の見込み。**秒まで出す。**
 *
 * 分どまりだと終わりぎわの数分が「あと 1 分」で固まってしまい、
 * 見終わるまで待てばいいのか席を立っていいのか判らなかった。
 * 秒の桁は多少ふらつくが、動いていることそのものが情報になる
 */
export function eta(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  const sec = total % 60;
  const min = Math.floor(total / 60) % 60;
  const hour = Math.floor(total / 3600);
  if (hour > 0) return `あと ${hour} 時間 ${pad(min)} 分 ${pad(sec)} 秒`;
  if (min > 0) return `あと ${min} 分 ${pad(sec)} 秒`;
  return `あと ${sec} 秒`;
}

/**
 * エンコードの「45.0%・あと 3 分 04 秒」。一覧の行も状態の欄もこれを使う。SSE で届いた進み (`encode-live`) があれば
 * **残り時間もそちらだけ**。届いた `etaMs` の null は見積もれないということ (docs/api.md) なので、DB の古い値に戻さず出さない
 */
export function encodeDetail(
  live: { percent: number; etaMs: number | null } | undefined,
  stored: { job_percent: number | null; job_eta_ms: number | null },
): string {
  const left = eta(live !== undefined ? live.etaMs : stored.job_eta_ms);
  const done = percent(live?.percent ?? stored.job_percent ?? 0);
  return left === "" ? done : `${done}・${left}`;
}

/**
 * エンコードの段階。ffmpeg が回る前の下ごしらえは進み具合を出せないので、
 * 何をしているところなのかを状態として出す。
 */
const PHASE_LABEL: Record<string, string> = {
  descramble: "スクランブル復号中",
  cm: "CM 検出中",
  encode: "エンコード中",
};

/** 行の状態。エンコードが動いていればその段階、そうでなければ録画の状態 */
function encodeLabel(
  job: { state: string; phase: string | null } | null,
): string | null {
  if (job === null) return null;
  if (job.state === "queued") return "エンコード待ち";
  if (job.state !== "running") return null;
  return PHASE_LABEL[job.phase ?? "encode"] ?? "エンコード中";
}

/**
 * 一覧の行に出す状態。
 *
 * 録画の状態 (`state`) は録画そのものの話しかしない。エンコードは別の仕事なので、
 * 動いていればその段階を、失敗していれば失敗したことを、こちらで足す。
 * エンコードの失敗を録画の状態に書き込んでいた頃は、元の TS が無事なのに
 * 「失敗」と出て再生できなくなっていた
 */
export function rowState(rec: {
  state: string;
  job_state: string | null;
  job_phase: string | null;
  encode_error: string | null;
}): { label: string; badge: string; quiet: boolean } {
  const running = encodeLabel(
    rec.job_state === null
      ? null
      : { state: rec.job_state, phase: rec.job_phase },
  );
  if (running !== null)
    return {
      label: running,
      badge: badgeClass(rec.job_state ?? ""),
      quiet: false,
    };
  // 動いているものが無く、いちばん新しいエンコードが失敗している
  if (rec.encode_error !== null && rec.encode_error !== "") {
    return {
      label: "エンコード失敗",
      badge: badgeClass("failed"),
      quiet: false,
    };
  }
  return {
    label: stateLabel(rec.state),
    badge: badgeClass(rec.state),
    quiet: quietState(rec.state),
  };
}

/**
 * 状態のラベル (app.css の `.tag`) の色。空は色なし (地の色のラベル)。
 *
 * **`solid` はいま動いているものの印** (行の段の色を決める。`row-status.ts`)。一覧は 1 画面に何十行も並ぶので、
 * 予約済み (青)・視聴可能 (緑)・録画中 (赤) を全部塗っていた頃は色の列が 3 本立ち、
 * どれが急ぐ話なのか分からなくなっていた。**待っているだけの状態は色を付けない**、
 * 済んだものは淡い緑、手を止めてほしいもの (競合・失敗) は淡い赤
 */
export function badgeClass(state: string): string {
  switch (state) {
    case "recording":
    case "running":
      return "solid error";
    case "encoding":
    case "queued":
      return "warning";
    case "available":
    case "done":
      return "success";
    case "conflict":
    case "failed":
      return "error";
    // 予約済み・待ち・取消・削除は「見て欲しいこと」が無いので色を付けない
    default:
      return "";
  }
}

/**
 * **ふつうの状態はラベルを出さない** (予約済み・視聴可能・録画済み・完了)。一覧のほとんどの行が
 * この状態なので、全部の行にラベルが並ぶと、録画中・失敗・競合・録り逃しのような
 * 見てほしい行が埋もれていた。予約の一覧にいる = 予約済み、ポスターと再生の印がある = 観られる、
 * で分かるので情報は減らない。読み上げ用には残す (画面の外に置く。`.visually-hidden`)
 */
const QUIET_STATES = new Set(["scheduled", "available", "recorded", "done"]);

export function quietState(state: string): boolean {
  return QUIET_STATES.has(state);
}

const STATE_LABEL: Record<string, string> = {
  scheduled: "予約済み",
  conflict: "競合",
  // コピー禁止の番組。録らないと決めた予約 (`COPY_NEVER_REASON`)
  skipped: "録画しない",
  recording: "録画中",
  done: "完了",
  failed: "失敗",
  canceled: "取り消し済み",
  missed: "録り逃し",
  recorded: "録画済み",
  encoding: "エンコード中",
  available: "視聴可能",
  // 消したあとも行は履歴として残る。「視聴可能」のままだと嘘になる
  deleted: "削除済み",
  queued: "待機中",
  running: "実行中",
};

export function stateLabel(state: string): string {
  return STATE_LABEL[state] ?? state;
}

/**
 * **コピー禁止の番組は録らない** (市販のレコーダーと同じ。docs/data.md「コピー禁止の番組」)。
 * 予約は「録画しない」(`skipped`) になってこの理由を持ち、手で予約しようとしても
 * この一文で断る。画面とサーバの両方で使うのでここに置く
 */
export const COPY_NEVER_REASON = "コピー禁止の番組なので録画しません";

/**
 * **録り始めてから、同じ回をもう録ってあると分かった** (ルールの「同じ回は最初の放送だけ」。
 * docs/data.md「同じ回は最初の放送だけ」)。予約は「録画しない」(`skipped`) になってこの理由を持つ。
 * 下見の「録らない (録画済み)」と同じ判定で、どこで録ったかを添える (引き継いだ履歴は局が無いことがある)
 */
export function duplicateReason(serviceName: string): string {
  return serviceName === ""
    ? "同じ回を録画済みなので録画しません"
    : `同じ回を ${serviceName} で録画済みなので録画しません`;
}

/**
 * **番組表の番組から、そのまま観られる録画。** 無ければ null。
 * 録画そのものが失敗したものと、ファイルの無いものは除く (配信は library_path ?? ts_path を返す)。
 * 番組表の詳細の再生ボタンと、外から使う API (`GET /api/programs` の `recordingId`) が同じ判定を使う
 */
export function playableRecordingId(program: {
  recording_id: number | null;
  recording_state: string | null;
  library_path: string | null;
  ts_path: string | null;
}): number | null {
  if (program.recording_id === null || program.recording_state === "failed")
    return null;
  return (program.library_path ?? program.ts_path) === null
    ? null
    : program.recording_id;
}

/** 予約を取り消せる状態。録り終えたもの・録り逃したものを取り消しにしても何も止まらず、記録だけが書き換わる */
const CANCELABLE_STATES: readonly string[] = [
  "scheduled",
  "conflict",
  "skipped",
  "recording",
];

/**
 * **予約を取り消せるか** (これから録るものと、いま録っているものだけ)。「録画しない」(`skipped`) は
 * 放送が終わるまで。番組表の「予約取消」と、`DELETE /api/programs/<id>/record` (`reservations.cancelProgram`) が同じ判定を使う
 */
export function cancelable(
  state: string | null,
  endAt: number,
  at: number,
): boolean {
  if (state === null || !CANCELABLE_STATES.includes(state)) return false;
  return !(state === "skipped" && endAt <= at);
}

/** 取り消せない予約 ({@link cancelable}) を取り消そうとしたときの理由 */
export const NOT_CANCELABLE_REASON = "放送か録画が終わった予約は取り消せません";

/**
 * ロゴでの判定が使えなかったときに、CM 検出の覚え書き (`recordings.cm_note`) へ
 * 入れる目印。無音だけの判定に切り替えた理由はこの後ろに続く。
 */
export const LOGO_UNUSABLE = "ロゴは使えず";

/**
 * その録画を「ロゴで CM を判定できなかった」(無音だけで判定) と扱うか。
 * 一覧に出し、観はじめに CM 飛ばしを入れない (`watch.skipCmAtStart`)。
 *
 * **覚え書きから読む。別の列では持たない。** 印を立てていた頃は、後から条件を
 * 広げても既に録ってある分には効かなかった (「結果の 100% が CM 判定だったので捨てた」
 * ときも出すようにしたのに、実機の 2 本は印が 0 のままで画面に出なかった)。
 *
 * ロゴが原因とは限らない (無音検出のツールが失敗することもある) が、そのときも
 * 出しておく。理由は覚え書きに書いてあるし、精度が落ちていることに変わりはない。
 */
export function logoUnusable(cmNote: string | null): boolean {
  return cmNote?.includes(LOGO_UNUSABLE) === true;
}

/**
 * カードリーダーの名前を「名前」と「挿さっている場所」に分ける。
 *
 * エージェントは `Gemplus USB SmartCard Reader (usb 4-11)` のように場所を括弧で
 * 後ろに付けて返す。**場所は 2 行目に小さく出す**。1 行に詰めていた頃は列が狭く、
 * 文字の途中で 1 文字ずつ折り返して名前が読めなかった。括弧の無い名前 (px4 の内蔵
 * リーダーなど) はそのまま
 */
export function splitReaderName(name: string): {
  name: string;
  where: string | null;
} {
  const found = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(name);
  if (found === null) return { name, where: null };
  return { name: found[1] ?? name, where: found[2] ?? null };
}

/** カードリーダーの状態の呼び名 */
export const READER_STATE_LABEL: Record<CardReaderState, string> = {
  active: "使用中",
  standby: "予備",
  empty: "カードなし",
  error: "エラー",
  disabled: "無効",
};

/**
 * 受信の状態と C/N と強度の出し方 (設定の「チューナー」と、チャンネルの受信品質の測定)。
 * **生の値は dB と読まれないように「(生の値)」を付け、単位を付けない** (機材やドライバが返した値のまま。docs/tuners.md「信号レベル」)。
 * 選局したときに測った値 (px4d) はそう言う。強度は dBm で測れた機材だけ出し、測れない機材では何も添えない
 */
export function signalText(signal: TunerSignal): string {
  const parts = [signal.locked ? "同期しています" : "同期していません"];
  if (signal.strengthDbm !== undefined) {
    parts.push(`強度: ${signal.strengthDbm.toFixed(1)} dBm`);
  }
  if (signal.cn !== null) {
    parts.push(
      signal.unit === "dB"
        ? `C/N: ${signal.cn.toFixed(1)} dB${signal.atTune ? " (選局したとき)" : ""}`
        : `C/N (生の値): ${signal.cn.toLocaleString("ja-JP")}`,
    );
  }
  return parts.join("・");
}

/** 生の値の C/N に添える注記。何と比べるものかを言う */
export const SIGNAL_RAW_NOTE =
  "C/N (生の値) は機材やドライバが返した値のままで、dB ではありません。同じチューナー・同じチャンネルで、配線を変える前とあとを比べる目安です";

/** ロゴまで見て判定できたときの覚え書き (`cm.openCm`) */
export const LOGO_OK = "ロゴ";

/**
 * その覚え書きを画面に出すか。
 *
 * **うまくいったときは何も出しません。** `ロゴ` とだけ書いてあっても
 * 読む人には何の情報にもならず、チャプターを見れば結果は分かります。ここに
 * 何か書いてあること自体が「いつもの精度は出ていない」の合図になります。
 */
export function cmNoteWorthShowing(cmNote: string | null): boolean {
  return cmNote !== null && cmNote !== "" && cmNote !== LOGO_OK;
}

/*
 * 番組の説明に入っている URL を取り出す。
 *
 * 番組表の説明欄には公式サイトや配信の告知が素のまま書いてある。読めるだけで
 * 押せないと、結局手で選んで貼り直すことになる。
 *
 * 閉じ括弧や句点は URL の一部にしない。「…example.com/)」のような書き方が多く、
 * そのまま含めると開けないリンクになる。日本語の記号は URL に現れないので切る
 */
const URL_PATTERN = /https?:\/\/[^\s"'<>）」』】〉、。，]+/g;
const TRAILING = /[.,!?:;)\]}]+$/;

interface TextPart {
  text: string;
  /** リンクなら宛先。素の文字なら undefined */
  href?: string;
}

/** 説明文を「素の文字」と「リンク」に切り分ける。`{@html}` を使わずに済ませるため */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const at = match.index;
    const url = match[0].replace(TRAILING, "");
    if (url === "") continue;
    if (at > cursor) parts.push({ text: text.slice(cursor, at) });
    parts.push({ text: url, href: url });
    cursor = at + url.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

/**
 * **テレビに出ている番号。** 地上波はリモコン番号、BS/CS はサービス ID がそのまま 3 桁番号
 * (BS朝日1=151)。局名だけだと、テレビで覚えている番号から探せない。
 * 地上波でリモコン番号が分からなければ null (出さない)
 */
export function channelNumber(service: {
  type: string;
  remote_control_key: number | null;
  service_id: number;
}): number | null {
  return (
    service.remote_control_key ??
    (service.type === "GR" ? null : service.service_id)
  );
}
