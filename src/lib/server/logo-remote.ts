import { PNG_SIGNATURE } from "../ts/png";

/**
 * 放送波からまだ取得できていない局ロゴの埋め合わせ。
 *
 * KonomiTV (https://github.com/tsukumijima/KonomiTV) が GitHub で公開している
 * 局ロゴ集を、**ファイルを取り込まず、URL で参照してサーバが取りに行く**。
 * ブラウザが読むのは denpa 自身 (`/api/services/<id>/logo`) だけなので、
 * CSP の `img-src` (自分・data:・blob:) は広げない。データ放送のエンジンが
 * 「外へは出られない」決まり (docs/architecture.md) もそのまま保てる。
 *
 * 放送波からの取得 (server/logo.ts) が本筋で、こちらは揃うまでの代わり。
 * 取れなければ (その局のロゴが無い・ネットに繋がらない) null を返し、
 * 呼び出し側は従来どおり「ロゴが無い」として扱う。
 */

/** ロゴ集の置き場。ファイル名は `NID<network_id>-SID<service_id>.png` */
const LOGO_BASE =
  "https://raw.githubusercontent.com/tsukumijima/KonomiTV/master/server/static/logos";

/** `tuner.serviceKey` が CATV の局に足すオフセット。内部 ID から元の network_id に戻すために引く */
const CATV_NETWORK_OFFSET = 0x10000;

/** 取りに行く上限 (ms)。外の都合でロゴの応答を長く待たせない */
const FETCH_TIMEOUT = 10_000;

/** 無かった局を取り直しに行く間隔 (ms)。ロゴ集に足されても、ここを過ぎれば拾い直す */
const MISS_RETRY = 60 * 60 * 1000;

/**
 * 内部 ID から KonomiTV のロゴの URL を組む。
 *
 * 内部 ID は `networkId * 100000 + serviceId` で、CATV の局だけ networkId に
 * `CATV_NETWORK_OFFSET` が足してある (`tuner.serviceKey`)。ケーブルで再送信
 * されている局もロゴ集では元の network_id で引くので、足された分は引いて戻す
 */
export function konomiTvLogoUrl(serviceId: number): string {
  const packed = Math.floor(serviceId / 100000);
  const sid = serviceId % 100000;
  const nid =
    packed >= CATV_NETWORK_OFFSET ? packed - CATV_NETWORK_OFFSET : packed;
  return `${LOGO_BASE}/NID${nid}-SID${sid}.png`;
}

/** 取れたロゴ (局ごとに覚えて、次からは取りに行かない) */
const hits = new Map<number, Uint8Array>();
/** 無かった控え (局ごとに、最後に取りに行った時刻) */
const misses = new Map<number, number>();

/**
 * その局のロゴを KonomiTV のロゴ集から取る。
 * 無い・繋がらない・PNG でなければ null
 */
export async function fetchKonomiTvLogo(
  serviceId: number,
): Promise<Uint8Array | null> {
  const hit = hits.get(serviceId);
  if (hit) return hit;
  const missedAt = misses.get(serviceId);
  if (missedAt !== undefined && Date.now() - missedAt < MISS_RETRY) {
    return null;
  }
  try {
    const response = await fetch(konomiTvLogoUrl(serviceId), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // 404 のページのような、画像でないものをロゴとして配らない
    if (!PNG_SIGNATURE.every((byte, at) => bytes[at] === byte)) {
      throw new Error("PNG ではありません");
    }
    hits.set(serviceId, bytes);
    misses.delete(serviceId);
    return bytes;
  } catch {
    misses.set(serviceId, Date.now());
    return null;
  }
}
