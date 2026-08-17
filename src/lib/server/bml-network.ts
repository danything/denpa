/**
 * データ放送の双方向 (通信系コンテンツ) を中継する
 * ([docs/stream.md](../../../docs/stream.md#57-双方向通信系コンテンツプロキシ))。
 *
 * BML のアプリは `browser.transmitTextDataOverIP` や `get` で放送局のサーバへ
 * 取りに行きます。放送局のサーバは受信機の専用ネットワークスタックを前提に
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
 * | | |
 * | --- | --- |
 * | 既定 | **切** (設定画面で入れる)。入れるまで `isIPConnected` は 0 を返す |
 * | 手 | GET と POST (`transmitTextDataOverIP`)。**中身は放送のアプリが組んだものをそのまま通すだけ** |
 * | 相手 | **公開アドレスのみ** (http も可 — 放送がそう作られている)。私設・ループバック・リンクローカル・多重放送は断る |
 * | 追いかけ | 3回まで。**行き先ごとに確かめ直す** — 1回目が公開でも、飛ばされた先が内側のことがある |
 * | 大きさ | 4MB まで |
 * | 待ち | 10秒 |
 * | 持ち物 | **何も渡さない** (cookie も認証も)。denpa の資格情報が外へ出ない |
 *
 * **全部記録に残します。** 何に繋いだか分からないまま外へ出ていく口を
 * 作らないためで、切り分けのときにいちばん効きます。
 */

import { Resolver } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { error } from '@sveltejs/kit';
import { config } from './config';
import { settings } from './settings';

/** 追いかける上限。放送局は https へ寄せるのに1回挟むことがある */
const HOPS = 3;
/** 受け取る上限 */
const LIMIT = 4 * 1024 * 1024;
/** 待つ上限 */
const TIMEOUT = 10_000;

export interface Fetched {
    status: number;
    contentType: string;
    body: Uint8Array;
}

/** 断った理由。**画面にもログにも同じ言葉で出す** */
export class Refused extends Error {}

/**
 * 断りの言葉。`Refused` ならその理由、それ以外 (繋がらない・切れた) は
 * 口ごとの言い方 (`fallback`)。3 つの口 (proxy / post / confirm) で同じ形
 */
export function refusalMessage(failure: unknown, fallback: string): string {
    return failure instanceof Refused ? failure.message : fallback;
}

/** 双方向を切ってあるなら 403。3 つの口の入口で同じ */
export function requireBmlNetwork(): void {
    if (!settings().bmlNetwork) error(403, 'データ放送の双方向は切ってあります');
}

/**
 * **名前は自前の DNS で引く** (`BML_DNS`、既定は公開 DNS)。
 *
 * 家庭の DNS フィルタ (AdGuard 等) は局の双方向ドメインをブラックホール
 * (0.0.0.0 / ::) に落とすことがある — 実測で `view.fujitv.co.jp` と
 * `recv-entry.tbs.co.jp` がそうなり、下の SSRF 防御が「内側の住所」として
 * 正しく断った結果、TBS の TVer リンクが NAP エラーになっていた。
 * 上流が複数あると答えがフラつくので、放送アプリの通信はここで固定する。
 *
 * **繋ぐのも引いた住所へ直に繋ぐ** (`doRequest` の host に IP を渡す)。
 * 引き直しを OS に任せると、確かめた住所と繋ぐ住所がずれる (TOCTOU)
 */
const resolver = new Resolver();
const BML_DNS = config.bmlDns
    .split(',')
    .map((server) => server.trim())
    .filter((server) => server !== '');
if (BML_DNS.length > 0) resolver.setServers(BML_DNS);

/**
 * その住所へ繋いでよいか。**内側を向いていたら断る。**
 *
 * IPv4 は数で、IPv6 は綴りで見ます。`::ffff:` で始まるものは IPv4 を
 * 被せただけなので、剥がしてから見ないと素通りします
 */
export function isPublicAddress(address: string): boolean {
    /*
     * `::ffff:1.2.3.4` のほかに **16進の綴り (`::ffff:0102:0304`) も受ける** —
     * `new URL()` は括弧の中のドット形をこちらに直すので、ドット形だけ見ていると
     * `http://[::ffff:127.0.0.1]/` が素通りする
     */
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    const hexMapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i.exec(address);
    const target =
        mapped !== null
            ? mapped[1]
            : hexMapped !== null
              ? [
                    Number.parseInt(hexMapped[1], 16) >> 8,
                    Number.parseInt(hexMapped[1], 16) & 255,
                    Number.parseInt(hexMapped[2], 16) >> 8,
                    Number.parseInt(hexMapped[2], 16) & 255,
                ].join('.')
              : address;

    if (target.includes(':')) {
        const lower = target.toLowerCase();
        // ループバック / 未指定 / リンクローカル (fe80::/10) / ユニークローカル (fc00::/7)
        if (lower === '::1' || lower === '::') return false;
        if (/^fe[89ab]/.test(lower)) return false;
        if (/^f[cd]/.test(lower)) return false;
        return true;
    }

    const parts = target.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false; // リンクローカル (雲のメタデータもここ)
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // 事業者内 (CGNAT)
    if (a >= 224) return false; // 多重放送と予約
    return true;
}

/**
 * 取りに行ってよい住所か。**綴りではなく、引いた先で見る。**
 * 通った住所を1つ返す (繋ぐのもその住所へ直に繋ぐ)。
 *
 * 名前で弾こうとすると `localhost` の別名や、内側を指す公開の名前
 * (いわゆる DNS リバインディング) が抜けます
 */
async function resolvable(host: string): Promise<string> {
    /*
     * IPv6 リテラルの [] を自分で剥がす。**`new URL().hostname` は剥がさない** —
     * `[::1]` のままだと綴りの判定に1つも掛からず、内側の住所なのに
     * 公開扱いで素通りしていた
     */
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    // IP を直に書いてあるなら引かずに見る
    if (/^[\d.]+$/.test(bare) || bare.includes(':')) {
        if (!isPublicAddress(bare)) throw new Refused(`内側の住所です (${host})`);
        return bare;
    }

    let found: string[];
    try {
        found = await resolver.resolve4(host);
    } catch {
        try {
            found = await resolver.resolve6(host);
        } catch {
            throw new Refused(`名前を引けません (${host})`);
        }
    }
    if (found.length === 0) throw new Refused(`名前を引けません (${host})`);
    for (const address of found) {
        if (!isPublicAddress(address)) throw new Refused(`内側の住所です (${host} → ${address})`);
    }
    return found[0];
}

/**
 * その URL を取りに行ってよいか。行けるなら整えた URL と、確かめた住所を返す。
 * 繋ぐのはその住所へ直に — 引き直すと、確かめたのと違う先に化かされうる
 */
export async function allowed(raw: string): Promise<{ url: URL; address: string }> {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Refused('URL として読めません');
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
     * 覗かれる道を開けることは承知の上。ただし**これは放送のアプリの
     * 通信**で、denpa の資格情報も利用者の秘密も乗らない (`credentials:
     * 'omit'`)。実機のテレビが出す通信と同じもので、それ以上に危なくは
     * ならない。
     *
     * `file:` や `data:` のような別の仕組みへ逃がす道は塞いだままにする
     */
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Refused(`http か https だけです (${url.protocol})`);
    }
    return { url, address: await resolvable(url.hostname) };
}

/**
 * 1回ぶんの HTTP。**確かめた住所へ直に繋ぐ。**
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
    method: 'GET' | 'POST',
    body: Uint8Array | undefined,
): Promise<{ status: number; location: string | null; contentType: string; body: Uint8Array }> {
    return new Promise((resolve, reject) => {
        const https = url.protocol === 'https:';
        const req = (https ? httpsRequest : httpRequest)(
            {
                host: address,
                port: url.port === '' ? (https ? 443 : 80) : Number(url.port),
                path: `${url.pathname}${url.search}`,
                method,
                setHost: false,
                headers: {
                    host: url.host,
                    accept: '*/*',
                    ...(method === 'POST' && body !== undefined
                        ? {
                              'content-type': 'application/x-www-form-urlencoded',
                              'content-length': body.length,
                          }
                        : {}),
                },
                ...(https ? { servername: url.hostname, rejectUnauthorized: false } : {}),
                timeout: TIMEOUT,
            },
            (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    // **受け取りながら測る。** 上限を超えたぶんは渡さずに断る
                    if (size > LIMIT) {
                        req.destroy();
                        reject(new Refused(`大きすぎます (${size} バイト)`));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    resolve({
                        status: res.statusCode ?? 0,
                        location: res.headers.location ?? null,
                        contentType: res.headers['content-type'] ?? 'application/octet-stream',
                        body: new Uint8Array(Buffer.concat(chunks)),
                    });
                });
                res.on('error', reject);
            },
        );
        req.on('timeout', () => req.destroy(new Error('時間切れ')));
        req.on('error', reject);
        req.end(body);
    });
}

/**
 * 取ってくる。**追いかけるぶんも1つずつ確かめる。**
 *
 * 自動の redirect に任せると、飛ばされた先が内側でも黙って繋ぎます。
 * 手で追いかけて、行き先ごとに `allowed` を通します
 */
export async function fetchForBml(raw: string): Promise<Fetched> {
    let { url, address } = await allowed(raw);
    for (let hop = 0; ; hop++) {
        const got = await doRequest(url, address, 'GET', undefined);

        if (got.status >= 300 && got.status < 400 && got.location !== null) {
            if (hop >= HOPS) throw new Refused('飛ばされる回数が多すぎます');
            ({ url, address } = await allowed(new URL(got.location, url).toString()));
            continue;
        }
        return { status: got.status, contentType: got.contentType, body: got.body };
    }
}

/**
 * 送る (`browser.transmitTextDataOverIP`)。
 *
 * **「応募・投票」の口だと思っていたら、疎通の判定そのものだった。**
 * NHK のデータ放送は `isIPConnected` に 1 と答えても信じず、ここへ一度
 * 投げてみて、返らなければ「インターネットに接続されていません」と案内
 * します (実機で確かめた。`confirmIPNetwork` は呼びに来もしない)。
 * 実装しないという最初の決めでは、双方向を入れても入っていないのと同じ
 * でした。
 *
 * **中身は組み立てません。** 借りものが `Denbun=<EUC-JP か Shift_JIS を
 * %xx にしたもの>` まで作ってから渡してくるので、denpa はそれを
 * `application/x-www-form-urlencoded` として素通しするだけです。
 * 返りも解かずにそのまま返す (どちらの符号かは放送のアプリが知っている)。
 *
 * 飛ばされたときの手の変わりかたは web と同じ規則にします —
 * 301/302/303 は GET へ、307/308 は POST のまま。**行き先は毎回確かめ直す**
 */
export async function postForBml(raw: string, body: Uint8Array): Promise<Fetched> {
    let { url, address } = await allowed(raw);
    let method: 'GET' | 'POST' = 'POST';
    for (let hop = 0; ; hop++) {
        const got = await doRequest(url, address, method, method === 'POST' ? body : undefined);

        if (got.status >= 300 && got.status < 400 && got.location !== null) {
            if (hop >= HOPS) throw new Refused('飛ばされる回数が多すぎます');
            if (got.status !== 307 && got.status !== 308) method = 'GET';
            ({ url, address } = await allowed(new URL(got.location, url).toString()));
            continue;
        }
        return { status: got.status, contentType: got.contentType, body: got.body };
    }
}

/**
 * 相手まで届くかを確かめる (`browser.confirmIPNetwork`)。
 *
 * 「相手まで届くか」を訊かれたときに答える口です。**NHK は呼びに来ません**
 * (実機で確かめた。あちらは [postForBml](#) の側で判断していた) が、
 * 訊いてくる放送はあるので用意しておきます。借りものは実装が無いと `null`
 * (非対応) を返し、`getBrowserSupport(… "Com.IP.confirmIP")` も 0 になります。
 *
 * **ICMP は使いません。** 器の中から生の socket は開けない (`CAP_NET_RAW` が
 * 要る) ので、**443 番へ繋がるか**で代えます。放送局のサーバは https で
 * 待っているので、目的 (相手まで届くか) には十分です。
 *
 * 繋ぎ先は `allowed` と同じ枠で見ます — 内側を確かめる道具にしない
 */
export async function confirmReachable(
    destination: string,
    timeoutMs: number,
): Promise<{ success: boolean; ipAddress: string | null; responseTimeMillis: number | null }> {
    // `example.jp` でも `https://example.jp/x` でも受ける
    const host = destination.includes('://')
        ? new URL(destination).hostname
        : destination.replace(/^\/+/, '').split('/')[0];
    if (host === '') throw new Refused('宛先がありません');

    const started = Date.now();
    // 確かめた住所へ直に繋ぐ (名前で繋ぎ直すと、フィルタされた DNS に化かされうる)
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
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}
