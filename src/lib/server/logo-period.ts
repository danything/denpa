/**
 * 衛星のロゴを待つ間隔 (`logo.awaitCarousel`)。**ダウンロードの期間中かどうか**で開き方を変える。
 *
 * 衛星のロゴ (全受信機共通データ) は、データの持ち主が申し込んだ「ダウンロードの期間」の間だけ、
 * 20 分以内の間隔でカルーセル 3 周ぶん流れる。期間の外は SDTT もカルーセルも止まる (ARIB TR-B15 第一部
 * 5.2.3.2・5.5)。流れる時刻を前もって知らせる仕組みは無い。共通データの SDTT は予定を持たず、
 * 流している間だけ送られる (同 5.1.2.2・5.3.2。`ts/logo-sdtt.ts`)。
 * 本番でも、10/28 は約 14 分おきに流れて揃い、11/02 は BS15:16625 を何度開いても SDTT もカルーセルも来なかった。
 *
 * なので「最後に流れているのを見た時刻」(`seenAt`) で期間中かを見分ける。
 * - **期間中**: 今までどおり番組表の取得より上の優先度で、空くたびに開いて待つ (#1939)。20 分以内に来るはず
 * - **期間の外**: いちばん下の優先度で、7 時間おきにだけ開く。来ないもののために番組表の取得を押しのけない
 */

/** 期間中とみなす長さ。最後に流れているのを見てから 48 時間。期間の長さは規格に無いので、実測が溜まったら直す */
export const PERIOD_HOLD = 48 * 60 * 60_000;

/**
 * 期間の外で開き直す間隔。7 時間は 24 時間を割り切らないので、開く時刻が毎日 3 時間ずつずれ、
 * 一日のどの時刻にも順に当たる (規格どおりなら時刻は関係ないが、外れたときの保険)。
 * 前は 6 時間で、毎日同じ 4 つの時刻にしか開かなかった
 */
export const OFF_PERIOD_RETRY = 7 * 60 * 60_000;

export interface CarouselWatch {
  /**
   * 最後にカルーセルが流れているのを見た時刻。読み進んだ (初めての DII のモジュールかブロックを受け取った) か、
   * 全受信機共通データの SDTT を見たとき。共有 (`ride`) でも自分で開いても控える
   */
  seenAt?: number;
  /** 当たりの中継を上限まで開けても何も来なかった時刻。`seenAt` より新しければ、期間はもう終わっている */
  ranOutAt?: number;
  /** 自分で開いて待ち始めた時刻 (開けた回だけ)。期間の外の間隔はここから数える */
  triedAt?: number;
}

interface CarouselAttempt {
  /** ダウンロードの期間中とみなすか。期間中だけ番組表の取得より上の優先度で開く */
  period: boolean;
  /** この時刻から開いてよい。`now` 以下ならいま */
  at: number;
}

/** 次にいつ、どの優先度で当たりの中継を開くか */
export function nextCarouselAttempt(
  watch: CarouselWatch,
  now: number,
): CarouselAttempt {
  const { seenAt, ranOutAt, triedAt } = watch;
  const period =
    seenAt !== undefined &&
    now - seenAt < PERIOD_HOLD &&
    (ranOutAt === undefined || ranOutAt < seenAt);
  if (period) return { period, at: now };
  return {
    period,
    at: triedAt === undefined ? now : triedAt + OFF_PERIOD_RETRY,
  };
}
