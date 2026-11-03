/**
 * **ニコニコとの連携で、画面とサーバの両方が使うもの** (サーバの受け持ちは `server/niconico.ts`)。
 * 連携は denpa-hub が中継し、結果を戻り先 (`RETURN_PATH`) へ返す (denpa-hub の docs/niconico.md)。
 */

import { privateHost } from "./host";

/** 連携の結果を受け取る画面のパス (denpa-hub との約束。ほかのパスには返してもらえない) */
export const RETURN_PATH = "/settings/integrations/niconico/return";

/**
 * **denpa-hub が戻り先として受け付けるホストか** (`location.hostname` か `URL.hostname`)。
 * 家の中のアドレス (ループバック・プライベート・CGNAT (Tailscale などの VPN もここ)・`::1`・IPv6 のユニークローカル)、`localhost`、`.local`・`.home.arpa` で終わる名前。
 * 名前で開いている (`tv.example.com`・`*.ts.net`) ときは false。hub を置く人が名前を足していれば通ることもあるので、
 * 画面は止めずに案内だけ出す
 */
export function homeHost(hostname: string): boolean {
  return privateHost(hostname, true);
}
