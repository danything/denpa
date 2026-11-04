import { PROBE_MOST, probeSize } from "#lib/live-adapt.js";
import { clientAddress } from "#lib/server/auth.js";
import { ProbeGate } from "#lib/server/probe-gate.js";

/** 回数の制限 (`ProbeGate`)。利用者ごとに間を置く */
const gate = new ProbeGate();

/**
 * 乱数で埋めたもの。**途中で圧縮されないように** (リバースプロキシが圧縮すると、回線の速さより速く見える)。
 * 毎回作らず、最初に要ったときに 1 回だけ作って使い回す
 */
let noise: Uint8Array | null = null;

function filled(): Uint8Array {
  if (noise !== null) return noise;
  const made = new Uint8Array(PROBE_MOST);
  // getRandomValues は 1 回に 64KB まで
  for (let at = 0; at < made.length; at += 65_536)
    crypto.getRandomValues(made.subarray(at, at + 65_536));
  noise = made;
  return made;
}

/**
 * **回線の速さを測る試しのデータ** (docs/stream.md「ライブと追っかけの画面」)。ライブの画面が段を上げる前に、`?bytes=` だけ取って
 * 届く速さを測る (`live-player.svelte.ts` の `probeLink`)。ライブのストリームは実時間でしか届かないので、それだけでは回線の余裕が
 * 分からないため。量は `PROBE_LEAST`〜`PROBE_MOST` に丸める。キャッシュさせない
 */
export function GET(event) {
  const { url, locals } = event;
  // ログインしていれば利用者、していなければ (信頼するネットワークから) 送り元ごとに数える。送り元が読めなければ
  // (`clientAddress` が空)、読めないもの全部を 1 人として数える (通すと、送り元を隠すだけで制限を抜けられる)
  const key = locals.user?.subject ?? `addr:${clientAddress(event)}`;
  const wait = gate.allow(key, Date.now());
  if (wait > 0)
    return new Response("試しのデータは同じ利用者で 10 秒に 1 回までです", {
      status: 429,
      headers: {
        "Retry-After": String(Math.ceil(wait / 1000)),
        "Cache-Control": "no-store",
      },
    });
  const bytes = probeSize(url.searchParams.get("bytes"));
  return new Response(filled().slice(0, bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes),
      "Cache-Control": "no-store",
    },
  });
}
