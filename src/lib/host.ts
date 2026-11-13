/**
 * **開いているホスト名 (`location.hostname`・`URL.hostname`) が家の中のものか。** 画面とサーバの両方が使う。
 *
 * 決めるのは名前だけで、相手の IP は見ない。VPN (NetBird・Tailscale) は相手のアドレスを書き換えることがあり、
 * 家の中だけの名前が外からも引けることもあるので、IP では家の中かを決められない (docs/stream.md「どの形式で流すか」)。
 * 使うのは連携の戻り先 (`niconico.ts` の `homeHost`。CGNAT も家の中に入れる) と、ライブの自動の形式 (`indoorHost`。入れない)
 */

/** 家の中のアドレス (IPv4)。ループバック・プライベート */
const PRIVATE_V4: readonly [number, number][] = [
  [0x7f000000, 8],
  [0x0a000000, 8],
  [0xac100000, 12],
  [0xc0a80000, 16],
];

/** CGNAT (100.64.0.0/10)。Tailscale などの VPN のアドレスもここ */
const CGNAT_V4: readonly [number, number] = [0x64400000, 10];

function v4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    n = n * 256 + Number(part);
  }
  return n;
}

function within(n: number, [base, bits]: readonly [number, number]): boolean {
  return Math.floor(n / 2 ** (32 - bits)) === base / 2 ** (32 - bits);
}

/**
 * 家の中のアドレス・名前か。ループバック・プライベートの IPv4、`::1`、IPv6 のユニークローカル (fc00::/7)、
 * `localhost`、`.local`・`.home.arpa` で終わる名前。`cgnat` なら 100.64.0.0/10 も入れる
 */
export function privateHost(hostname: string, cgnat: boolean): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  if (/^[^.].*\.(local|home\.arpa)$/.test(host)) return true;
  const ranges = cgnat ? [...PRIVATE_V4, CGNAT_V4] : PRIVATE_V4;
  const home = (n: number) => ranges.some((range) => within(n, range));
  const ipv4 = v4(host);
  if (ipv4 !== null) return home(ipv4);
  if (!host.includes(":")) return false;
  if (host === "::1") return true;
  // IPv4 を写した IPv6 (`::ffff:192.168.1.20`。URL は `::ffff:c0a8:114` に直す) は IPv4 として見る
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (dotted !== null) {
    const n = v4(dotted[1]!);
    return n !== null && home(n);
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (hex !== null)
    return home(parseInt(hex[1]!, 16) * 0x10000 + parseInt(hex[2]!, 16));
  // fc00::/7
  return /^f[cd][0-9a-f]{0,2}:/.test(host);
}

/** ホスト名を比べられる形にそろえる (小文字・IPv6 の角括弧と末尾の点を落とす) */
function normalHost(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/**
 * **家の中だけの名前の後ろ。** 外の DNS では引けない (`.localhost` はブラウザが自分に向ける)。
 * ログインなしで開ける名前 (`server/auth.ts` の `knownHost`) と、ライブの「自動」の家の中 (`indoorHost`) が同じものを使う。
 * 連携の戻り先 (`privateHost`) は denpa-hub が受け付ける `.local`・`.home.arpa` だけで、これとは別
 */
export const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".lan",
  ".home.arpa",
  ".internal",
] as const;

/** 家の中だけの名前か (`LOCAL_SUFFIXES`)。`name` は小文字にそろえたもの */
export function localName(name: string): boolean {
  return LOCAL_SUFFIXES.some(
    (suffix) => name.length > suffix.length && name.endsWith(suffix),
  );
}

/**
 * **ライブの「自動」で家の中とみるホストか** (`#lib/live-choice.ts` の `autoCodec`)。
 *
 * 世帯の設定の「家の中の名前」(`indoorHosts`) に載っている名前なら家の中。載っていなくても、
 * プライベートの IP をそのまま打って開いた・`localhost`・家の中だけの名前 (`LOCAL_SUFFIXES`) なら家の中。
 * **CGNAT (100.64.0.0/10) は入れない。** VPN 越し (外から) のことが多い
 */
export function indoorHost(
  hostname: string,
  indoorHosts: readonly string[],
): boolean {
  const host = normalHost(hostname);
  return (
    indoorHosts.includes(host) || localName(host) || privateHost(host, false)
  );
}

/** 家の中の名前の数の上限 */
const INDOOR_HOSTS_MAX = 20;

const NAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** 名前か IP アドレスとして読めるか (そろえたあと) */
function hostLike(host: string): boolean {
  return NAME.test(host) || (host.includes(":") && /^[0-9a-f:.]+$/.test(host));
}

/**
 * 欄に書かれた家の中の名前を一覧にする。1 行に 1 つ。`https://dp.l.example.com/` のように URL で書かれても
 * ホスト名だけを採る。空の行と同じ名前は外し、名前として読めない・多すぎるときは理由 (画面に出す) を返す
 */
export function parseIndoorHosts(
  text: string,
): { hosts: string[] } | { error: string } {
  const hosts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let host = line.trim();
    if (host === "") continue;
    if (host.includes("://")) {
      try {
        host = new URL(host).hostname;
      } catch {
        return { error: `名前として読めません: ${line.trim()}` };
      }
    }
    host = normalHost(host);
    if (!hostLike(host))
      return { error: `名前として読めません: ${line.trim()}` };
    if (!hosts.includes(host)) hosts.push(host);
  }
  if (hosts.length > INDOOR_HOSTS_MAX)
    return { error: `家の中の名前は ${INDOOR_HOSTS_MAX} 個までです` };
  return { hosts };
}

/** 保存してある値 (JSON の配列) を読む。壊れていれば空。読めない名前と上限を超えたぶんは捨てる */
export function readIndoorHosts(value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  try {
    const raw: unknown = JSON.parse(value);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((host): host is string => typeof host === "string")
      .map(normalHost)
      .filter(hostLike)
      .slice(0, INDOOR_HOSTS_MAX);
  } catch {
    return [];
  }
}
