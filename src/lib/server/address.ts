/**
 * 住所 (IP アドレス) とネットワーク (CIDR) の小さな道具。
 *
 * **入口の `server.js` とアプリ (`auth.ts`) の両方が使う。** server.js は SvelteKit の
 * 組み立ての外に居る素の JS なので、ここは**何も import しない** (`$lib` も config も
 * 引かない)。bun は `.ts` をそのまま読めるので、server.js はこのファイルを直に
 * import する — 本番のイメージにもこの1枚だけ置いてある (Dockerfile)。
 * 同じ判定を2か所に書くと、片方だけ直して食い違うほうが危ない。
 */

/**
 * 住所を正規の形にそろえる。**読めなければ null。**
 *
 * - IPv4 はそのまま (`10.0.0.1`)
 * - IPv6 は小文字の省略なしの数として扱い、`::ffff:10.0.0.1` (IPv4 を写した IPv6) は
 *   IPv4 に戻す — Bun は IPv4 の相手をこの形で渡すことがある
 */
export function normalize(address: string): string | null {
    const parsed = parse(address);
    if (parsed === null) return null;
    return parsed.v4 ? formatV4(parsed.value) : formatV6(parsed.value);
}

/**
 * 住所がそのネットワークの中か。`10.10.0.0/16`・`fd00::/8` のような CIDR か、
 * 住所そのまま (`192.168.1.5`・`fd00::1`)。IPv4 と IPv6 は互いに当たらない
 * (`::ffff:a.b.c.d` は IPv4 として扱う)。書き方が読めなければ当たらない
 */
export function inNetwork(address: string, entry: string): boolean {
    const target = parse(address.trim());
    const [network = '', bits, ...rest] = entry.trim().split('/');
    const base = parse(network);
    if (target === null || base === null || rest.length > 0) return false;
    if (target.v4 !== base.v4) return false;

    const width = target.v4 ? 32 : 128;
    let length = width;
    if (bits !== undefined) {
        if (!/^\d{1,3}$/.test(bits)) return false;
        length = Number(bits);
        if (length > width) return false;
    }
    const shift = BigInt(width - length);
    return target.value >> shift === base.value >> shift;
}

/** カンマ区切りの並び (`TRUSTED_NETWORKS`・`TRUSTED_PROXIES`) を項目に分ける */
export function networks(list: string): string[] {
    return list
        .split(',')
        .map((raw) => raw.trim())
        .filter((raw) => raw !== '');
}

/** どれかのネットワークの中か */
export function inAny(address: string, entries: readonly string[]): boolean {
    return entries.some((entry) => inNetwork(address, entry));
}

/**
 * **本当の接続元を決める** (nginx の `set_real_ip_from` + `real_ip_recursive on`、
 * Express の `trust proxy` と同じ考え方)。
 *
 * - 直の相手 (`peer`) が信頼した前段 (`proxies`) でなければ、**相手そのもの**が接続元。
 *   `X-Forwarded-For` は誰でも付けられるので読まない
 * - 前段なら `X-Forwarded-For` を**右から**見て、前段の住所を飛ばし、最初に当たった
 *   前段でない住所を接続元とする。右端ほど近い前段が書いたもので、左ほど
 *   詐称しやすい。全部が前段なら左端 (いちばん遠いところ)
 * - 前段なのに `X-Forwarded-For` が無い・読めない項目に当たったら、そこで止めて
 *   それまでに分かった住所 (無ければ相手) を使う — 読めないものの先は信じない
 *
 * 返す住所は `normalize` した形。相手が読めなければ空文字 (どの CIDR にも当たらない)
 */
export function resolveClient(peer: string, forwardedFor: string | null, proxies: readonly string[]): string {
    let client = normalize(peer) ?? '';
    if (client === '' || !inAny(client, proxies) || !forwardedFor) return client;

    const hops = forwardedFor.split(',').map((raw) => raw.trim());
    for (let i = hops.length - 1; i >= 0; i--) {
        const hop = normalize(hops[i] ?? '');
        if (hop === null) break;
        client = hop;
        if (!inAny(hop, proxies)) break;
    }
    return client;
}

type Parsed = { v4: boolean; value: bigint };

function parse(raw: string): Parsed | null {
    const v4 = parseV4(raw);
    if (v4 !== null) return { v4: true, value: v4 };
    const v6 = parseV6(raw);
    if (v6 === null) return null;
    // ::ffff:0:0/96 は IPv4 を写したもの
    if (v6 >> 32n === 0xffffn) return { v4: true, value: v6 & 0xffffffffn };
    return { v4: false, value: v6 };
}

function parseV4(raw: string): bigint | null {
    const parts = raw.split('.');
    if (parts.length !== 4) return null;
    let out = 0n;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const byte = Number(part);
        if (byte > 255) return null;
        out = (out << 8n) | BigInt(byte);
    }
    return out;
}

function parseV6(raw: string): bigint | null {
    if (!raw.includes(':')) return null;
    let text = raw.toLowerCase();
    // 末尾が IPv4 の書き方 (::ffff:10.0.0.1) なら 16bit 2つに直す
    const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
    if (tail) {
        const v4 = parseV4(tail[2]!);
        if (v4 === null) return null;
        text = `${tail[1]}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
    }
    const halves = text.split('::');
    if (halves.length > 2) return null;
    const groups = (part: string | undefined) => (part ? part.split(':') : []);
    const head = groups(halves[0]);
    const rest = groups(halves[1]);
    let all: string[];
    if (halves.length === 2) {
        const missing = 8 - head.length - rest.length;
        if (missing < 1) return null;
        all = [...head, ...Array<string>(missing).fill('0'), ...rest];
    } else {
        all = head;
    }
    if (all.length !== 8) return null;
    let out = 0n;
    for (const group of all) {
        if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
        out = (out << 16n) | BigInt(Number.parseInt(group, 16));
    }
    return out;
}

function formatV4(value: bigint): string {
    return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.');
}

function formatV6(value: bigint): string {
    const groups: string[] = [];
    for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(((value >> shift) & 0xffffn).toString(16));
    return groups.join(':');
}
