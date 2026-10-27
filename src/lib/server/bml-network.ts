/**
 * データ放送の双方向 (通信系コンテンツ) を中継する
 * ([docs/stream.md](../../../docs/stream.md#双方向通信系コンテンツプロキシ))。
 *
 * BML のアプリは `browser.transmitTextDataOverIP` や `get` で放送局のサーバへ
 * 送ったり、そこから取得したりします。放送局のサーバは受信機の専用ネットワークスタックを前提に
 * していて **CORS を返さない**ので、ブラウザからは直に取れません。
 * denpa が中継します。
 *
 * ## 局ごとのドメイン表は持ちません
 *
 * 「いま映している局のドメインだけ許す」には、局とドメインの対応表を
 * 抱えることになります。**その表は必ず古くなり**、新しい局や引っ越した先で
 * 黙って繋がらなくなります (しかも「繋がらない」は放送側の不調と見分けが
 * 付きません)。
 *
 * 代わりに**繋ぎ先ではなく繋ぐ範囲**を縛ります。危ないのは「放送局以外に
 * 繋ぐこと」ではなく、**denpa のサーバが内側に繋ぐこと** (SSRF) だからです。
 *
 * 既定は**オン** (設定画面で切れる)。オフの間は 403 で、画面側も `isIPConnected` に 0 を返す。
 * 何を通して何を断るか (相手・ポート・追いかけ・大きさ・持ち物・返し方) の一覧は docs の
 * 「局ごとのドメイン表は持たない」に、数はこのファイルの定数 (`HOPS`・`LIMIT`・`TIMEOUT`・
 * `CONCURRENCY`・`PORTS`) にあります。
 *
 * **全部記録に残します。** 何に繋いだか分からないまま外へ出ていく経路を
 * 作らないためで、切り分けのときにいちばん効きます。
 */

import { Resolver } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";

import { error } from "@sveltejs/kit";

import { normalize } from "./address";
import { config } from "./config";
import { settings } from "./settings";

/** 追いかける上限。放送局は https へ寄せるのに1回挟むことがある */
const HOPS = 3;
/** 受け取る上限 */
const LIMIT = 4 * 1024 * 1024;
/** 待つ上限。追いかけるぶんと本文を読み終えるまでを含めた全体 */
const TIMEOUT = 10_000;
/**
 * 同時に中継する上限。データ放送や Hybridcast のアプリは文書を開くと画像や script をまとめて
 * 取りに来る (HTTP/2 の前段ならブラウザは一度に何十本も投げる) ので、ゆとりを持たせて 32。
 * 待たせると溜まるだけなので、あふれたら断る
 */
const CONCURRENCY = 32;
/**
 * 繋いでよいポート (空は既定の 80・443)。放送の通信は Web の 80・443 で、ほかに使われうるのは
 * 8080・8443 くらい。公開アドレスでも、メールや DB のような別のサービスへ繋ぐ道具にはしない
 */
const PORTS = new Set(["", "80", "443", "8080", "8443"]);

/** 送るものの既定の形式 (データ放送の `Denbun=…`) */
const FORM = "application/x-www-form-urlencoded";

export interface Fetched {
  status: number;
  contentType: string;
  body: Uint8Array;
}

/** 断った理由。**画面にもログにも同じ言葉で出す** */
export class Refused extends Error {}

/**
 * 断りの言葉。`Refused` ならその理由、それ以外 (繋がらない・切れた) は
 * エンドポイントごとの言い方 (`fallback`)。3 つのエンドポイント (proxy / post / confirm) で同じ形式
 */
export function refusalMessage(failure: unknown, fallback: string): string {
  return failure instanceof Refused ? failure.message : fallback;
}

/**
 * 中継した答えを返す (`/api/bml/proxy` と `/api/bml/post`)。
 *
 * - **相手の返した符号をそのまま返す。** 放送のアプリは 404 や 503 を見て出し分けることがあるので、
 *   こちらで 200 に均すと判断を奪う
 * - **溜めさせない。** 放送の通信は「いまの値」を取りに来るもの
 * - `x-bml-relayed` は相手まで行けた印。相手の 502 をそのまま返すので、符号だけではこちらで断った
 *   502 と見分けが付かない。画面側はこれを見て成否を決める
 * - **返したものを denpa の権限で動かさない。** 中身も形式も相手の言うままなので、`text/html` や SVG が
 *   来ることがある。`sandbox` の CSP と `nosniff` を付け、直に開かれても denpa のオリジンの文書には
 *   ならないようにする (`hc-relay.ts` と同じ考え)。形式は変えない — 画面側は fetch で読み、`content-type`
 *   を見て文字コードや BML の文書かどうかを決める。CSP は fetch で読む分には効かない
 */
export function relayed(got: Fetched): Response {
  return new Response(got.body as BodyInit, {
    status: got.status,
    headers: {
      "content-type": got.contentType,
      "content-security-policy": "sandbox; default-src 'none'",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "x-bml-relayed": "1",
    },
  });
}

/**
 * fetch・XHR からの読み込みでなければ 403 (`/api/bml/proxy` と `/api/bml/post` の入口)。
 *
 * 中継を読むのは画面の fetch だけ (`DataBroadcast`・`HybridcastFrame`)。ページとして開かれたり、
 * `<img>` や `<script>` から読まれたりする筋合いは無いので、相手に繋ぐ前に断る。
 * `sec-fetch-dest` を送らない古いブラウザは通す (その分は `relayed` の CSP で守る)
 */
export function requireFetch(request: Request): void {
  const dest = request.headers.get("sec-fetch-dest");
  if (dest !== null && dest !== "empty")
    error(403, "画面の通信からのみ使えます");
}

/** 双方向を切ってあるなら 403。`/api/bml/*` のどのエンドポイントも入口で呼ぶ (Hybridcast の入れ物も) */
export function requireBmlNetwork(): void {
  if (!settings().bmlNetwork)
    error(403, "データ放送の双方向通信はオフになっています");
}

/**
 * **名前は自前の DNS で引く** (`BML_DNS`、既定は公開 DNS)。
 *
 * 家庭の DNS フィルタ (AdGuard 等) は局の双方向ドメインをブラックホール
 * (0.0.0.0 / ::) に落とすことがある — 実測で `view.fujitv.co.jp` と
 * `recv-entry.tbs.co.jp` がそうなり、下の SSRF 防御が「内側のアドレス」として
 * 正しく断った結果、TBS の TVer リンクが NAP エラーになっていた。
 * 上流が複数あると答えがフラつくので、放送アプリの通信はここで固定する。
 *
 * **繋ぐのも引いたアドレスへ直に繋ぐ** (`doRequest` の host に IP を渡す)。
 * 引き直しを OS に任せると、確かめたアドレスと繋ぐアドレスがずれる (TOCTOU)
 */
const resolver = new Resolver();
const BML_DNS = config.bmlDns
  .split(",")
  .map((server) => server.trim())
  .filter((server) => server !== "");
if (BML_DNS.length > 0) resolver.setServers(BML_DNS);

/**
 * そのアドレスへ繋いでよいか。**内側を向いていたら断る。**
 *
 * 綴りは `normalize` (address.ts) でそろえてから数で見ます。省かない書き方も、
 * `::ffff:` で IPv4 を被せただけのもの (16進の綴りも) も、同じ数になる。
 * IPv6 は**公開のユニキャスト (2000::/3) だけを通す** — 断る範囲を並べるやり方では、
 * 並べ忘れた範囲 (サイトローカルや IPv4 互換) が素通りしていた
 */
export function isPublicAddress(raw: string): boolean {
  const address = normalize(raw);
  if (address === null) return false;
  if (!address.includes(":")) return isPublicV4(address);

  const g = address.split(":").map((group) => Number.parseInt(group, 16));
  const v4 = (high: number, low: number) =>
    [high >> 8, high & 255, low >> 8, low & 255].join(".");
  /*
   * **IPv4 を埋め込んだ形式は、埋め込まれた IPv4 で見る。** NAT64 (64:ff9b::/96) と
   * 6to4 (2002::/16) は、着く先が中の IPv4 そのもの
   */
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0))
    return isPublicV4(v4(g[6]!, g[7]!));
  if (g[0] === 0x2002) return isPublicV4(v4(g[1]!, g[2]!));
  /*
   * ここから先は公開のユニキャストだけ。::/96 (未指定・ループバック・IPv4 互換)・
   * ユニークローカル・リンクローカル・サイトローカル・マルチキャストはここで外れる
   */
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  // Teredo (2001::/32) は中の IPv4 が伏せてあって確かめられない。文書用 (2001:db8::/32) はどこにも着かない
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return false;
  return true;
}

/** IPv4 (`normalize` した形式) へ繋いでよいか */
function isPublicV4(address: string): boolean {
  const [a, b, c] = address.split(".").map(Number);
  if (a === undefined || b === undefined || c === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false; // リンクローカル (クラウドのメタデータもここ)
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false; // プロトコル用 (NAT64 や DS-Lite の機器)
  if (a === 198 && (b === 18 || b === 19)) return false; // 機器の性能試験用
  if (a === 100 && b >= 64 && b <= 127) return false; // 事業者内 (CGNAT)
  if (a >= 224) return false; // マルチキャストと予約
  return true;
}

/**
 * 取得してよいアドレスか。**綴りではなく、引いた先で見る。**
 * 通ったアドレスを1つ返す (繋ぐのもそのアドレスへ直に繋ぐ)。
 *
 * 名前で弾こうとすると `localhost` の別名や、内側を指す公開の名前
 * (いわゆる DNS リバインディング) が抜けます
 */
async function resolvable(host: string): Promise<string> {
  /*
   * IPv6 リテラルの [] を自分で剥がす。**`new URL().hostname` は剥がさない** —
   * `[::1]` のままだと綴りの判定に1つも掛からず、内側のアドレスなのに
   * 公開扱いで素通りしていた
   */
  const bare =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // IP を直に書いてあるなら引かずに見る
  if (/^[\d.]+$/.test(bare) || bare.includes(":")) {
    if (!isPublicAddress(bare))
      throw new Refused(`内部ネットワークのアドレスです (${host})`);
    return bare;
  }

  let found: string[];
  try {
    found = await resolver.resolve4(host);
  } catch {
    try {
      found = await resolver.resolve6(host);
    } catch {
      throw new Refused(`名前解決できません (${host})`);
    }
  }
  if (found.length === 0) throw new Refused(`名前解決できません (${host})`);
  for (const address of found) {
    if (!isPublicAddress(address))
      throw new Refused(
        `内部ネットワークのアドレスです (${host} → ${address})`,
      );
  }
  return found[0]!;
}

/**
 * その URL を取得してよいか。行けるなら整えた URL と、確かめたアドレスを返す。
 * 繋ぐのはそのアドレスへ直に — 引き直すと、確かめたのと違う先に化かされうる
 */
export async function allowed(
  raw: string,
): Promise<{ url: URL; address: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Refused("URL として読めません");
  }
  /*
   * **http も通す。**
   *
   * 最初は https だけにしていた。**放送がそう作られていない。** NHK は
   * `http://beacon.nhk.jp/` へ投げてくるし、通信系コンテンツはおおむね
   * 素の http で組まれている (受信機がそうしているから)。https だけに
   * すると、双方向を入れても「接続されていません」のまま — 実機で
   * そうなった。
   *
   * 覗かれる経路を開けることは承知の上。ただし**これは放送のアプリの
   * 通信**で、denpa の資格情報も利用者の秘密も乗らない (cookie も認証も
   * 渡さない。`doRequest`)。実機のテレビが出す通信と同じもので、それ以上に
   * 危なくはならない。
   *
   * `file:` や `data:` のような別の仕組みへ逃がす経路は塞いだままにする
   */
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Refused(`http か https のみ使えます (${url.protocol})`);
  }
  if (!PORTS.has(url.port))
    throw new Refused(`このポートには繋ぎません (${url.port})`);
  return { url, address: await resolvable(url.hostname) };
}

/**
 * 1回ぶんの HTTP。**確かめたアドレスへ直に繋ぐ。**
 *
 * fetch は名前引きを差し替えられないので node:http(s) で繋ぐ。Host と SNI には
 * 元の名前を入れる (IP へ繋いでも相手には正しい名前で名乗る)。
 *
 * **証明書は検証しない。** 放送局の通信系サーバは受信機の専用スタック前提で、
 * 証明書の鎖を最後まで送ってこないことがある (実測: フジの
 * `tvid-sha1.tver-tech.co.jp` が `unable to get local issuer certificate` で
 * 転び、502 → データ放送が `affiliationId == null` で描けなかった)。実機の
 * テレビは厳密な PKI 検証をしないので、ここも同じにする。資格情報は何も
 * 乗せないし、素の http すら通しているので、検証を外して増える危険は無い
 */
function doRequest(
  url: URL,
  address: string,
  method: "GET" | "POST",
  body: Uint8Array | undefined,
  deadline: number,
  contentType = FORM,
): Promise<{
  status: number;
  location: string | null;
  contentType: string;
  body: Uint8Array;
}> {
  return new Promise((resolve, reject) => {
    const https = url.protocol === "https:";
    const req = (https ? httpsRequest : httpRequest)(
      {
        host: address,
        port: url.port === "" ? (https ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method,
        setHost: false,
        headers: {
          host: url.host,
          accept: "*/*",
          ...(method === "POST" && body !== undefined
            ? {
                "content-type": contentType,
                "content-length": body.length,
              }
            : {}),
        },
        ...(https
          ? { servername: url.hostname, rejectUnauthorized: false }
          : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          // **受け取りながら測る。** 上限を超えたぶんは渡さずに断る
          if (size > LIMIT) {
            clearTimeout(timer);
            req.destroy();
            reject(new Refused(`大きすぎます (${size} バイト)`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          clearTimeout(timer);
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location ?? null,
            contentType:
              res.headers["content-type"] ?? "application/octet-stream",
            body: new Uint8Array(Buffer.concat(chunks)),
          });
        });
        res.on("error", (failure) => {
          clearTimeout(timer);
          reject(failure);
        });
      },
    );
    /*
     * **締め切りは本文を読み終えるまで。** 通信の途切れだけを見る `timeout` では、少しずつ
     * 送り続ける相手にいつまでも付き合わされる
     */
    const timer = setTimeout(
      () => req.destroy(new Refused("時間切れです")),
      Math.max(0, deadline - Date.now()),
    );
    req.on("error", (failure) => {
      clearTimeout(timer);
      reject(failure);
    });
    req.end(body);
  });
}

/**
 * 取ってくる。**追いかけるぶんも1つずつ確かめる。**
 *
 * 自動の redirect に任せると、飛ばされた先が内側でも黙って繋ぎます。
 * 手で追いかけて、行き先ごとに `allowed` を通します
 */
export function fetchForBml(raw: string): Promise<Fetched> {
  return follow(raw, "GET", undefined);
}

/**
 * 送る (`browser.transmitTextDataOverIP`)。
 *
 * **「応募・投票」の API だと思っていたら、疎通の判定そのものだった。**
 * NHK のデータ放送は `isIPConnected` に 1 と答えても信じず、ここへ一度
 * 投げてみて、返らなければ「インターネットに接続されていません」と案内
 * します (実機で確かめた。`confirmIPNetwork` は呼びに来もしない)。
 * 実装しないという最初の決めでは、双方向を入れても入っていないのと同じ
 * でした。
 *
 * **中身は組み立てません。** エンジン (`src/lib/bml/`) が `Denbun=<EUC-JP か Shift_JIS を
 * %xx にしたもの>` まで作ってから渡してくるので、denpa はそれを
 * `application/x-www-form-urlencoded` として素通しするだけです。
 * 返りもデコードせずにそのまま返す (どちらの符号かは放送のアプリが知っている)。
 *
 * 飛ばされたときの手の変わりかたは web と同じ規則にします —
 * 301/302/303 は GET へ、307/308 は POST のまま。**行き先は毎回確かめ直す**
 */
export function postForBml(
  raw: string,
  body: Uint8Array,
  contentType = FORM,
): Promise<Fetched> {
  return follow(raw, "POST", body, contentType);
}

/** いま中継している数 (`CONCURRENCY` まで) */
let running = 0;

/**
 * 同時の数を数えながら走らせる。**あふれたら待たせずに断る** — 待ち行列を持つと、
 * 呼び続けられたときにそこへ溜まるだけになる
 */
export async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY)
    throw new Refused(
      "中継が混み合っています (しばらくしてからやり直してください)",
    );
  running++;
  try {
    return await task();
  } finally {
    running--;
  }
}

/** 飛ばされるのを1つずつ確かめながら追いかける (`fetchForBml` / `postForBml` の本体) */
function follow(
  raw: string,
  first: "GET" | "POST",
  body: Uint8Array | undefined,
  contentType = FORM,
): Promise<Fetched> {
  return limited(() => hops(raw, first, body, contentType));
}

async function hops(
  raw: string,
  first: "GET" | "POST",
  body: Uint8Array | undefined,
  contentType: string,
): Promise<Fetched> {
  // 名前を引くのも含めて、全体で `TIMEOUT` まで
  const deadline = Date.now() + TIMEOUT;
  let { url, address } = await allowed(raw);
  let method = first;
  for (let hop = 0; ; hop++) {
    const got = await doRequest(
      url,
      address,
      method,
      method === "POST" ? body : undefined,
      deadline,
      contentType,
    );

    if (got.status >= 300 && got.status < 400 && got.location !== null) {
      if (hop >= HOPS) throw new Refused("リダイレクトが多すぎます");
      if (got.status !== 307 && got.status !== 308) method = "GET";
      ({ url, address } = await allowed(new URL(got.location, url).toString()));
      continue;
    }
    return { status: got.status, contentType: got.contentType, body: got.body };
  }
}

/**
 * 相手まで届くかを確かめる (`browser.confirmIPNetwork`)。
 *
 * 「相手まで届くか」を訊かれたときに答える API です。**NHK は呼びに来ません**
 * (実機で確かめた。あちらは `postForBml` の側で判断していた) が、
 * 訊いてくる放送はあるので用意しておきます。
 *
 * **ICMP は使いません。** コンテナの中から raw socket は開けない (`CAP_NET_RAW` が
 * 要る) ので、**443 番へ繋がるか**で代えます。放送局のサーバは https で
 * 待っているので、目的 (相手まで届くか) には十分です。
 *
 * 繋ぎ先は `allowed` と同じ枠で見ます — 内側を確かめる道具にしない
 */
export async function confirmReachable(
  destination: string,
  timeoutMs: number,
): Promise<{
  success: boolean;
  ipAddress: string | null;
  responseTimeMillis: number | null;
}> {
  // `example.jp` でも `https://example.jp/x` でも受ける
  const host = destination.includes("://")
    ? new URL(destination).hostname
    : (destination.replace(/^\/+/, "").split("/")[0] ?? "");
  if (host === "") throw new Refused("宛先がありません");

  return limited(async () => {
    const started = Date.now();
    // 確かめたアドレスへ直に繋ぐ (名前で繋ぎ直すと、フィルタされた DNS に化かされうる)
    const address = await resolvable(host);
    return await new Promise((resolve) => {
      const socket = connect({
        host: address,
        port: 443,
        timeout: Math.max(1000, Math.min(timeoutMs, TIMEOUT)),
      });
      const done = (success: boolean) => {
        socket.destroy();
        resolve({
          success,
          ipAddress: address,
          responseTimeMillis: success ? Date.now() - started : null,
        });
      };
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
  });
}
