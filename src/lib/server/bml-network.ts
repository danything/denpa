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
 * | 相手 | **https のみ・公開アドレスのみ**。私設・ループバック・リンクローカル・多重放送は断る |
 * | 追いかけ | 3回まで。**行き先ごとに確かめ直す** — 1回目が公開でも、飛ばされた先が内側のことがある |
 * | 大きさ | 4MB まで |
 * | 待ち | 10秒 |
 * | 持ち物 | **何も渡さない** (cookie も認証も)。denpa の資格情報が外へ出ない |
 *
 * **全部記録に残します。** 何に繋いだか分からないまま外へ出ていく口を
 * 作らないためで、切り分けのときにいちばん効きます。
 */

import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';

/** 追いかける上限。放送局は https へ寄せるのに1回挟むことがある */
const HOPS = 3;
/** 受け取る上限 */
export const LIMIT = 4 * 1024 * 1024;
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
 * その住所へ繋いでよいか。**内側を向いていたら断る。**
 *
 * IPv4 は数で、IPv6 は綴りで見ます。`::ffff:` で始まるものは IPv4 を
 * 被せただけなので、剥がしてから見ないと素通りします
 */
export function isPublicAddress(address: string): boolean {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    const target = mapped === null ? address : mapped[1];

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
 *
 * 名前で弾こうとすると `localhost` の別名や、内側を指す公開の名前
 * (いわゆる DNS リバインディング) が抜けます
 */
export async function resolvable(host: string): Promise<void> {
    let found: { address: string }[];
    try {
        found = await lookup(host, { all: true });
    } catch {
        throw new Refused(`名前を引けません (${host})`);
    }
    if (found.length === 0) throw new Refused(`名前を引けません (${host})`);
    for (const { address } of found) {
        if (!isPublicAddress(address)) throw new Refused(`内側の住所です (${host} → ${address})`);
    }
}

/** その URL を取りに行ってよいか。行けるなら整えた URL を返す */
export async function allowed(raw: string): Promise<URL> {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Refused('URL として読めません');
    }
    // **https だけ。** 放送の通信は暗号化された相手が前提で、http は中身を覗かれる
    if (url.protocol !== 'https:') throw new Refused(`https だけです (${url.protocol})`);
    await resolvable(url.hostname);
    return url;
}

/**
 * 取ってくる。**追いかけるぶんも1つずつ確かめる。**
 *
 * `redirect: 'follow'` に任せると、飛ばされた先が内側でも黙って繋ぎます。
 * 手で追いかけて、行き先ごとに `allowed` を通します
 */
export async function fetchForBml(raw: string): Promise<Fetched> {
    let url = await allowed(raw);
    for (let hop = 0; ; hop++) {
        const response = await fetch(url, {
            method: 'GET',
            redirect: 'manual',
            // **何も持たせない。** denpa の資格情報を外へ出さない
            credentials: 'omit',
            headers: { accept: '*/*' },
            signal: AbortSignal.timeout(TIMEOUT),
        });

        const next = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && next !== null) {
            if (hop >= HOPS) throw new Refused('飛ばされる回数が多すぎます');
            url = await allowed(new URL(next, url).toString());
            continue;
        }

        const body = new Uint8Array(await response.arrayBuffer());
        // **受け取ってから測るのでは遅い**が、fetch は先に長さを教えてくれないことがある。
        // 上限を超えたぶんは渡さずに断る
        if (body.length > LIMIT) throw new Refused(`大きすぎます (${body.length} バイト)`);
        return {
            status: response.status,
            contentType: response.headers.get('content-type') ?? 'application/octet-stream',
            body,
        };
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
    let url = await allowed(raw);
    let method = 'POST';
    for (let hop = 0; ; hop++) {
        const response = await fetch(url, {
            method,
            redirect: 'manual',
            credentials: 'omit',
            headers:
                method === 'POST'
                    ? { accept: '*/*', 'content-type': 'application/x-www-form-urlencoded' }
                    : { accept: '*/*' },
            body: method === 'POST' ? (body as BodyInit) : undefined,
            signal: AbortSignal.timeout(TIMEOUT),
        });

        const next = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && next !== null) {
            if (hop >= HOPS) throw new Refused('飛ばされる回数が多すぎます');
            if (response.status !== 307 && response.status !== 308) method = 'GET';
            url = await allowed(new URL(next, url).toString());
            continue;
        }

        const got = new Uint8Array(await response.arrayBuffer());
        if (got.length > LIMIT) throw new Refused(`大きすぎます (${got.length} バイト)`);
        return {
            status: response.status,
            contentType: response.headers.get('content-type') ?? 'application/octet-stream',
            body: got,
        };
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
    await resolvable(host);

    const started = Date.now();
    const { address } = await lookup(host);
    return await new Promise((resolve) => {
        const socket = connect({ host, port: 443, timeout: Math.max(1000, Math.min(timeoutMs, TIMEOUT)) });
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
