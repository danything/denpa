/**
 * **ニコニコとの連携で、画面とサーバの両方が使うもの** (サーバの受け持ちは `server/niconico.ts`)。
 * 連携は denpa-hub が中継し、結果を戻り先 (`RETURN_PATH`) へ返す (denpa-hub の docs/niconico.md)。
 */

/** 連携の結果を受け取る画面のパス (denpa-hub との約束。ほかのパスには返してもらえない) */
export const RETURN_PATH = "/settings/integrations/niconico/return";

/** 家の中のアドレス (IPv4)。ループバック・プライベート・CGNAT (Tailscale などの VPN もここ) */
const HOME_V4: readonly [number, number][] = [
  [0x7f000000, 8],
  [0x0a000000, 8],
  [0xac100000, 12],
  [0xc0a80000, 16],
  [0x64400000, 10],
];

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

function homeV4(n: number): boolean {
  return HOME_V4.some(
    ([base, bits]) =>
      Math.floor(n / 2 ** (32 - bits)) === base / 2 ** (32 - bits),
  );
}

/**
 * **denpa-hub が戻り先として受け付けるホストか** (`location.hostname` か `URL.hostname`)。
 * 家の中のアドレス (上の範囲・`::1`・IPv6 のユニークローカル)、`localhost`、`.local`・`.home.arpa` で終わる名前。
 * 名前で開いている (`tv.example.com`・`*.ts.net`) ときは false。hub を置く人が名前を足していれば通ることもあるので、
 * 画面は止めずに案内だけ出す
 */
export function homeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  if (/^[^.].*\.(local|home\.arpa)$/.test(host)) return true;
  const ipv4 = v4(host);
  if (ipv4 !== null) return homeV4(ipv4);
  if (!host.includes(":")) return false;
  if (host === "::1") return true;
  // IPv4 を写した IPv6 (`::ffff:192.168.1.20`。URL は `::ffff:c0a8:114` に直す) は IPv4 として見る
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (dotted !== null) {
    const n = v4(dotted[1]!);
    return n !== null && homeV4(n);
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (hex !== null)
    return homeV4(parseInt(hex[1]!, 16) * 0x10000 + parseInt(hex[2]!, 16));
  // fc00::/7
  return /^f[cd][0-9a-f]{0,2}:/.test(host);
}
