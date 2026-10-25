import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";

import { inAny, networks, normalize, overlaps, unreadable } from "./address";
import { config } from "./config";
import { enabled as oidcEnabled } from "./oidc";

/**
 * 誰を通すか。**どこでも通る方法が3つと、エンドポイントを限った方法が2つ。**
 *
 * | 方法 | 何者か |
 * | --- | --- |
 * | `TRUSTED_NETWORKS` | 信頼したネットワークから、知っている名前 (`knownHost`) で来た人。何も聞かずに通す |
 * | OIDC のログイン | 画面から入る人 (`docs/auth.md`)。ブラウザで観る・端末に保存もこの控え (Cookie) で通る |
 * | アクセストークン (`Bearer denpa_…`) | ペアリングしたアプリ (`device-auth.ts`) |
 * | 使い捨てのチケット | ライブ視聴の WebSocket だけ (`tickets.ts`) |
 * | Hybridcast の中継の合言葉 | http の Hybridcast のアプリの読み込みだけ (`hc-relay.ts`。下の `OPEN_PATHS`) |
 *
 * **どれも設定していなければ、全部断る** (`configured`)。以前はベーシック認証を
 * 起動時に自動で掛けていたが、廃止した — 残っていたのは「画面に出して
 * 覚えさせるパスワード」だけだった。全部開けたいなら `TRUSTED_NETWORKS=0.0.0.0/0`
 * (公開の注意は docs/auth.md)。
 */

/**
 * 素通しにするエンドポイント。
 *
 * - **ログインの入口。** 守ると入れなくなる (ログイン画面へ行くのにログインが要る)
 * - **`/logout`。** ここも素通し (ログアウトするのにログインを要求しない)
 * - **`/api/health`。** Kubernetes の `livenessProbe` が呼ぶ。守ると**Pod が
 *   再起動を繰り返す** (掛ける範囲を選べるのをやめたときに実際に踏んだ —
 *   E2E のスタックが起動待ちで固まった)。出しているのは
 *   「生きているか・動いているバージョンと新しいバージョン・局が何件か・録画が何本か」だけ
 * - **`/manifest.webmanifest`。** ブラウザは**資格情報を付けずに**取得する
 *   ので (`<link rel="manifest">` に `crossorigin` を書かない限り)、守ると
 *   ホーム画面に置けなくなる。static に置いてあった頃は adapter-node が
 *   hooks より手前で返していて、そもそも掛かっていなかった。出しているのは
 *   アプリの名前・色・アイコンの場所だけ
 * - **ペアリングコードとアクセストークンの受け取り** (`/api/device/code`・`/api/device/token`)。テレビは
 *   まだ何の資格も持っていない。コードを出すだけでは入れず、許すのは `/device` (ここは守る)。
 *   誰でも呼べるので、有効なコードの数に上限がある (device-auth.ts の `MAX_PENDING`)
 * - **http の Hybridcast のアプリの中継** (`/api/bml/hc/<合言葉>/…`)。アプリは使い捨てのオリジンの iframe にいて、
 *   そこからの読み込みにはログインの cookie が付かない。推測できない合言葉が許可証で、出すのはログインした人にだけ
 *   (`POST /api/bml/hc`。hc-relay.ts)
 */
const OPEN_PATHS = [
  /^\/login(\/|$)/,
  /^\/logout$/,
  /^\/api\/health$/,
  /^\/manifest\.webmanifest$/,
  /^\/api\/device\/(code|token)$/,
  /^\/api\/bml\/hc\/[0-9a-f]{32}\//,
];

export function isOpenPath(pathname: string): boolean {
  return OPEN_PATHS.some((pattern) => pattern.test(pathname));
}

/**
 * ログイン方法が1つでも設定してあるか。**無ければ全部断る** (fail-closed)。
 *
 * 分からない状態で開けておくより、閉まっていることが起動ログとエラーページから
 * はっきり分かるほうがいい。以前の「起動時にパスワードを自動生成して掛ける」は、
 * 掛かってはいるが**受け取り損ねると誰も入れない**うえ、その状態と区別が付かなかった。
 */
export function configured(): boolean {
  return oidcEnabled() || networks(config.trustedNetworks).length > 0;
}

/** ログイン方法が無いまま上がったとき (と、TRUSTED_NETWORKS の書き損じ) の案内。起動ログに1度だけ出す */
export function warnIfClosed(): void {
  // 書き損じは当たらないだけなので、気づけるように知らせる
  for (const entry of unreadable(networks(config.trustedNetworks))) {
    console.warn(
      `[boot] TRUSTED_NETWORKS の「${entry}」は読めないので無視します`,
    );
  }
  if (configured()) return;
  console.warn(
    "[boot] ログイン方法が設定されていないため、すべてのアクセスを断ります。\n" +
      "       OIDC (docs/auth.md) か TRUSTED_NETWORKS (CIDR のカンマ区切り) を設定してください。\n" +
      "       すべて開けるなら TRUSTED_NETWORKS=0.0.0.0/0 (公開時の注意は docs/auth.md)",
  );
}

/**
 * ログイン方法が無い相手への返事。理由が分からない 403 にしない。
 *
 * 接続元のアドレスも書く。localhost で入ると Docker の中継を通って思わぬアドレスに見えることがあり、
 * 本人が見れば何を `TRUSTED_NETWORKS` に足せばよいか分かる (相手のアドレスを相手に返すだけ)。
 * 信頼するネットワークの中から知らない名前で来たときは (`foreignHost`)、そう書く
 */
export function denied(address = "", host: string | null = null): Response {
  const text = !configured()
    ? "ログイン方法が設定されていません。OIDC か TRUSTED_NETWORKS を設定してください (docs/auth.md)"
    : host !== null
      ? `信頼したネットワークの中からでも、「${host || "(名前なし)"}」という名前ではログインなしで開けません。` +
        "この名前で開くなら ALLOWED_HOSTS に足してください (docs/auth.md)"
      : "このページは、信頼したネットワーク (TRUSTED_NETWORKS) の中からでないと開けません" +
        ` (接続元: ${address || "不明"})`;
  return new Response(text, {
    status: 403,
    // 本文に相手が送ってきた名前が入るので、HTML として読ませない
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * 資格の無い API の呼び出しへの答え。**いつも同じ形式の 401 JSON** (docs/api.md)。
 * テレビのアプリはアクセストークンを持たずにまず API を呼び、これが返ればペアリングに進む
 * (信頼するネットワークの中なら通るので、ペアリングは要らない)。HTML のログイン画面へ
 * 回すと、アプリは JSON として読もうとして意味の分からない失敗になる
 */
export function needsPairing(): Response {
  return Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { "www-authenticate": 'Bearer realm="denpa"' } },
  );
}

/**
 * **何も聞かずに通す相手か。** 見るのはアドレス (`TRUSTED_NETWORKS`、CIDR の
 * カンマ区切り)。名前は `foreignHost` で別に確かめる (hooks が両方を見る)。
 *
 * **ここに当たり、名前も知っていれば OIDC も掛からない。** LAN のテレビのアプリ (denpa-tv)
 * に資格情報を入れずに使わせるのが狙い。
 */
export function trusted(address: string): boolean {
  return inAny(address, networks(config.trustedNetworks));
}

/** 名前の後ろがこれなら、外の DNS では引けない (家の中だけの名前。`.localhost` はブラウザが自分に向ける) */
const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".lan",
  ".home.arpa",
  ".internal",
];

/**
 * **信頼したネットワークから、ログインなしで開いてよい名前か。**
 *
 * アドレスだけで通すと、DNS リバインディングで抜けられる。悪いサイトが自分の名前を LAN の
 * denpa の IP に向け直すと、そのサイトを開いた LAN の人のブラウザは、denpa を「そのサイトと
 * 同じオリジン」として読み書きできる (接続元は LAN の人なので `TRUSTED_NETWORKS` に当たり、
 * CSRF の判定も `Host` から組んだ origin と `Origin` が同じ名前なので通る)。
 * そこで、攻める側が自分の名前として用意できないものだけを通す:
 *
 * - IP の直書き (IPv4・IPv6)、`localhost`、ドットの無い名前
 * - 家の中だけの名前 (`LOCAL_SUFFIXES`)
 * - 自分の名前として設定にあるもの (`ALLOWED_HOSTS`、`PWA_NAMES`)
 *
 * `host` は `Host` ヘッダの値 (ポート付きでよい)。読めない形なら通さない
 */
export function knownHost(host: string): boolean {
  const name = bareName(host);
  if (name === null) return false;
  if (normalize(name) !== null) return true;
  if (!/^[a-z0-9_.-]+$/.test(name)) return false;
  if (name === "localhost" || !name.includes(".")) return true;
  if (LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  return ownNames().some((entry) =>
    entry.startsWith(".")
      ? name === entry.slice(1) || name.endsWith(entry)
      : name === entry,
  );
}

/** ポートと `[]` を外し、小文字にして、最後のドットを落とす。空なら null */
function bareName(host: string): string | null {
  let name = host.trim().toLowerCase();
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    return end > 1 ? name.slice(1, end) : null;
  }
  const colon = name.indexOf(":");
  if (colon >= 0) name = name.slice(0, colon);
  name = name.replace(/\.$/, "");
  return name === "" ? null : name;
}

/** 設定にある自分の名前 (`ALLOWED_HOSTS` と、`PWA_NAMES` の `ホスト名=表示名` のホスト名) */
function ownNames(): string[] {
  const pwa = networks(config.pwaNames).map((raw) => raw.split("=")[0]!);
  return [...networks(config.allowedHosts), ...pwa]
    .map((raw) => raw.trim().toLowerCase().replace(/\.$/, ""))
    .filter((raw) => raw !== "" && raw !== ".");
}

/** 知らせた名前。同じ名前で何度来ても1度だけ出す (ログを埋めないよう、覚えるのは上限まで) */
const reported = new Set<string>();
const MAX_REPORTED = 64;

/**
 * **知らない名前で来ていれば、その名前を返す** (`knownHost` に当たらないもの)。どれも知っていれば null。
 * 名前が無ければ空文字 (通さない)。
 *
 * 見るのは `Host` と、`HOST_HEADER` を設定していればそのヘッダも (adapter が名前に使うほう)。
 * `Host` はブラウザのスクリプトから変えられないが、`X-Forwarded-Host` のようなヘッダは
 * 同じオリジンからなら付けられるので、どちらか片方だけでは足りない。
 *
 * 信頼したネットワークの中から知らない名前で来たときに呼ぶ。ログに理由を1度だけ出す
 */
export function foreignHost(headers: Headers, address: string): string | null {
  const names = [headers.get("host")];
  if (config.hostHeader !== "" && config.hostHeader !== "host") {
    const forwarded = headers.get(config.hostHeader);
    if (forwarded !== null) names.push(forwarded);
  }
  const foreign = names.find((name) => name === null || !knownHost(name));
  if (foreign === undefined) return null;
  const host = foreign ?? "";
  if (!reported.has(host) && reported.size < MAX_REPORTED) {
    reported.add(host);
    console.warn(
      `[auth] 信頼したネットワーク (${address}) から、知らない名前「${host || "(名前なし)"}」で来たので、ログインなしでは通しません。` +
        "この名前で開くなら ALLOWED_HOSTS に足してください (docs/auth.md)",
    );
  }
  return host;
}

/**
 * **前段と同じネットワークを信頼していないか。** 当たれば、重なっているネットワークを返す。
 *
 * `TRUSTED_PROXIES` が空だと、前段 (Caddy・cloudflared など) 越しの接続元は前段のアドレスになる。
 * 前段は denpa と同じ Docker のネットワークにいることが多く、そこが `TRUSTED_NETWORKS` に入っていると、
 * インターネットから来た人も前段のアドレスで当たり、OIDC が掛からない。docker-proxy が IPv6 の
 * 接続を Docker のゲートウェイから繋ぎ直すときも同じ。
 *
 * 自分のインターフェースのネットワークと `TRUSTED_NETWORKS` が重なっていて、`TRUSTED_PROXIES` が
 * 空のときに当たる。ループバックとリンクローカル (`169.254.0.0/16`・`fe80::/10`) は見ない —
 * ループバックは外から来ない。リンクローカルは IPv6 ならどのインターフェースにもあり、
 * wslc はこの PC からの接続を `169.254.x.x` に見せる (install.ps1 が信頼している)
 */
export function sharedNetworks(
  trustedList: string,
  proxies: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string[] {
  if (networks(proxies).length > 0) return [];
  const entries = networks(trustedList);
  const shared: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const { internal, cidr } of list ?? []) {
      if (internal || cidr === null) continue;
      if (overlaps(cidr, "169.254.0.0/16") || overlaps(cidr, "fe80::/10"))
        continue;
      if (entries.some((entry) => overlaps(cidr, entry))) shared.push(cidr);
    }
  }
  return shared;
}

/** 前段と同じネットワークを信頼していそうなら (`sharedNetworks`)、起動ログに出す */
export function warnIfProxyHidden(): void {
  const shared = sharedNetworks(
    config.trustedNetworks,
    config.trustedProxies,
    networkInterfaces(),
  );
  if (shared.length === 0) return;
  console.warn(
    `[boot] TRUSTED_NETWORKS が、このコンテナのネットワーク (${shared.join("・")}) と重なっていて、TRUSTED_PROXIES が空です。\n` +
      "       同じネットワークに前段 (リバースプロキシ・cloudflared など) を置いているなら、TRUSTED_PROXIES に前段のアドレスを書いてください。\n" +
      "       書かないと、前段越しの人が全員信頼したネットワークから来たことになり、OIDC が掛かりません (docs/auth.md)",
  );
}

/**
 * 接続元のアドレス。**読めなければ空文字を返す。**
 *
 * アドレスは入口の server.js が決めて `x-denpa-remote` に入れ、adapter-bun はそれを読む
 * (`ADDRESS_HEADER` は server.js が固定する。前段をどこまで信じるかは `TRUSTED_PROXIES`)。
 * adapter-bun はそのヘッダが無いと**例外を投げる** — server.js が相手のアドレスを
 * 読めなかったときがそれで、そのまま呼ぶと 500 になる。
 *
 * **読めなかったときは素通しにしない** (空文字はどの CIDR にも当たらない)。
 * 分からないほうを通すと、ヘッダを外すだけで認証を抜けられてしまう
 */
export function clientAddress(event: { getClientAddress(): string }): string {
  try {
    return event.getClientAddress();
  } catch {
    return "";
  }
}

/** OIDC でログインを求めるか (素通しのエンドポイントは呼ぶ側 (hooks) が先に振り分ける) */
export function needsLogin(): boolean {
  return oidcEnabled();
}
