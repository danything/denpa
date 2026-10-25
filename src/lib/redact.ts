/**
 * **バグ報告に貼る前に伏せるもの** (設定の「診断」→「Issue にする」)。
 *
 * 伏せるのは、貼ったその人やその家に辿り着けるものと、盗まれると使われるもの:
 * B-CAS カードの番号・アクセストークン・パスワード・秘密の値 (OIDC のクライアントシークレットなど)・
 * Webhook の URL・Cookie と Authorization・IP アドレスとホスト名 (家の LAN の作り)・メールアドレス・
 * ホームフォルダのユーザー名。
 *
 * **番組名・局名・ファイル名は伏せない。** 再現に要る (どの局のどの番組で起きたか)。
 * そのため、ホスト名はファイル名と見分けられる形 (URL の中・`名前:ポート`・よくあるドメインの末尾) だけを伏せる
 * (サーバが知っているホスト名 `known.hosts` は、形によらずどこでも伏せる)。
 * `video.mp4` や `agent.ts` は残る。
 *
 * どれも置き換えた先の印 (`[IP]` など) が分かるようにして、何かが伏せられたことは読み手に伝える
 */

/** 置き換えた先の印。伏せたことが読み手に分かるように、種類だけは残す */
export const MASK = {
  card: "[カード番号]",
  secret: "[秘密]",
  webhook: "[Webhook]",
  ip: "[IP]",
  host: "[ホスト名]",
  email: "[メール]",
  user: "[ユーザー]",
} as const;

/**
 * Webhook の URL。Discord・Slack と、パスに `webhook`・`hook` を含むもの。URL ごと伏せる
 * (パスそのものが鍵になっている)
 */
const WEBHOOK = /\bhttps?:\/\/[^\s"'<>]*?hooks?\b[^\s"'<>]*/gi;

/** `scheme://user:pass@host` の資格情報 */
const URL_CREDENTIALS =
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'<>]+:[^\s/@"'<>]*@/gi;

/** `Authorization: …`・`Cookie: …`・`Set-Cookie: …` は行の終わりまで */
const AUTH_HEADER =
  /\b((?:proxy-)?authorization|set-cookie|cookie)(["']?\s*[:=]\s*)[^\r\n]*/gi;

/** `Bearer <トークン>` */
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi;

/** denpa のアクセストークン (`denpa_…`。device-auth.ts) */
const DENPA_TOKEN = /\bdenpa_[A-Za-z0-9_-]{8,}/g;

/**
 * `password=…`・`"client_secret": "…"`・`OIDC_CLIENT_SECRET=…` の値。
 * 名前に secret・token・password などを含む鍵を、値だけ伏せる
 */
const SECRET_PAIR =
  /\b([\w.-]*(?:secret|token|passw(?:or)?d|passwd|pwd|api[_-]?key|private[_-]?key|credential|session[_-]?id)[\w.-]*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"',;&]+)/gi;

/** URL の問い合わせのうち、それ自体が鍵になるもの (OIDC の `code`・`state` など) */
const SECRET_QUERY =
  /([?&](?:code|state|nonce|token|access_token|id_token|refresh_token|key|sig|signature)=)[^&\s"'#]+/gi;

const EMAIL =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

/**
 * B-CAS カードの番号。エージェントは 16 桁 (`ToString("D16")`)、カードの裏の印字は 4 桁ずつ 20 桁。
 * 区切り (空白・`-`) があってもなくても。番組の ID は 15 桁までなので当たらない
 */
const CARD = /(?<![\d.])\d{4}([ -]?)\d{4}\1\d{4}\1\d{4}(?:\1\d{4})?(?![\d.])/g;
/** 区切り無しの 16〜20 桁 (上と重なるが、区切りの揃わない並びも拾う) */
const LONG_DIGITS = /(?<![\d.])\d{16,20}(?![\d.])/g;

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
/**
 * IPv4 (`/24` や `:8080` は残す)。`Chrome/131.0.0.0` のような製品のバージョン (英字と `/` の後ろ) と、
 * `6.18.54.1-microsoft` のようなカーネルのバージョン (後ろに `-英字`) は当てない
 */
const IPV4 = new RegExp(
  `(?<![\\w.])(?<![A-Za-z]/)${OCTET}(?:\\.${OCTET}){3}(?![\\d]|\\.\\d|-[A-Za-z])`,
  "g",
);

/**
 * IPv6。`::` を含む短い形と、8 つ並んだ形。`%eth0` のゾーンも一緒に。
 * 時刻 (`12:34:56`) は `::` も 8 つの並びも無いので当たらない
 */
const H16 = "[0-9a-f]{1,4}";
const IPV6 = new RegExp(
  `(?<![\\w:])(?:(?:${H16}:){7}${H16}|(?:${H16}(?::${H16}){0,6})?::(?:${H16}(?::${H16}){0,6})?(?::${OCTET}(?:\\.${OCTET}){3})?)(?:%[\\w.-]+)?(?![\\w:]|\\.\\d)`,
  "gi",
);

/** URL のホスト部 (`scheme://host`。資格情報を伏せた `[秘密]@` の後ろも)。`[` で始まる IPv6 は上で伏せてある */
const URL_HOST =
  /\b([a-z][a-z0-9+.-]*:\/\/(?:\[秘密\]@)?)([^\s/:?#@"'<>[\]]+)/gi;

/**
 * `名前:ポート` のホスト名 (`tuner-agent:25252`)。点の無い名前で、英字 2 字以上を含み、ポートは 2〜5 桁。
 * 点のある名前は URL の中か、よくあるドメインの末尾のときだけ伏せる (`agent.ts:42` はファイルと行の番号)。
 * `12:30:00` のように後ろにまだ `:数字` が続くもの (時刻・行と列) と、よくある言葉 (`line:42`) は残す
 */
const HOST_PORT =
  /(?<![\w.:/[\\-])([a-z][a-z0-9-]*[a-z][a-z0-9-]*)(?=:\d{2,5}(?![\d:]))/gi;
/** `名前:数字` の形になりやすい、ホストではない言葉 */
const NOT_HOSTS = new Set([
  "line",
  "lines",
  "col",
  "column",
  "code",
  "status",
  "port",
  "exit",
  "error",
  "pid",
  "tid",
  "id",
  "row",
  "step",
  "retry",
  "attempt",
  "http",
  "https",
  "ws",
  "wss",
  "ftp",
  "file",
]);

/**
 * 裸のドメイン名。**末尾がよくあるドメインのものだけ** (ファイル名と見分けるため。`.ts` `.app` は入れない)
 */
const BARE_HOST =
  /(?<![\w.@/-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:local|lan|home|internal|localdomain|arpa|intranet|corp|io|com|net|org|jp|dev|cloud|xyz|me|info|biz|co|us|uk|de)(?![\w.-]*\w)/gi;

/** 伏せないホスト。外の公開されたもので、家の作りは分からない */
const PUBLIC_HOSTS = new Set([
  "localhost",
  "github.com",
  "ghcr.io",
  "raw.githubusercontent.com",
]);

/** ホームフォルダのユーザー名 (`/Users/<名前>/`・`C:\Users\<名前>\`・`/home/<名前>/`) */
const HOME =
  /((?:^|[\s"'(=:])(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/])(?!\[)([^\\/\s"']+)/gim;

const isMask = (text: string) => /^\[[^\]]+\]$/.test(text);

function maskHost(host: string): string {
  if (isMask(host)) return host;
  if (PUBLIC_HOSTS.has(host.toLowerCase())) return host;
  if (/^[\d.]+$/.test(host)) return host; // IPv4 は IP の印に任せる
  return MASK.host;
}

/** 正規表現で使える形に (`known` の値をそのまま探す) */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 長いものから置き換える (短い値が長い値の一部だと、長いほうが半端に残る)。短すぎる値はふつうの言葉と区別が付かないので使わない */
function replaceKnown(
  text: string,
  values: readonly string[],
  mask: string,
  min: number,
  word: boolean,
): string {
  let out = text;
  const sorted = [...new Set(values)]
    .filter((value) => value.length >= min)
    .sort((a, b) => b.length - a.length);
  for (const value of sorted) {
    const body = escapeRegExp(value);
    out = out.replace(
      new RegExp(word ? `(?<![\\w.-])${body}(?![\\w-])` : body, "gi"),
      mask,
    );
  }
  return out;
}

/** サーバが知っている、形では見分けられない値 */
export interface Known {
  /** 秘密の値そのもの (OIDC のクライアントシークレット・登録してある Webhook の URL) */
  secrets?: readonly string[];
  /** ホスト名 (エージェントの宛先など。`tuner-agent` のように点の無い名前は形では見分けられない) */
  hosts?: readonly string[];
}

/**
 * **伏せる。** 1 行でも複数行でもよい。`known` に渡した値は、形にかかわらずそのまま探して伏せる
 */
export function redact(text: string, known: Known = {}): string {
  let out = replaceKnown(text, known.secrets ?? [], MASK.secret, 6, false);
  out = replaceKnown(
    out,
    // IP アドレスで来たときは IP の印に任せる (ホスト名の印にしない)
    (known.hosts ?? []).filter(
      (host) =>
        !PUBLIC_HOSTS.has(host.toLowerCase()) &&
        !/^[\d.]+$|:/.test(host) &&
        !host.startsWith("["),
    ),
    MASK.host,
    3,
    true,
  );
  out = out
    .replace(WEBHOOK, MASK.webhook)
    .replace(URL_CREDENTIALS, `$1${MASK.secret}@`)
    .replace(AUTH_HEADER, `$1$2${MASK.secret}`)
    .replace(BEARER, `$1 ${MASK.secret}`)
    .replace(DENPA_TOKEN, MASK.secret)
    .replace(SECRET_PAIR, (whole, key: string, sep: string, value: string) =>
      isMask(value.replace(/^["']|["']$/g, ""))
        ? whole
        : // 引用符で囲んだ値は、空白を含んでも閉じ引用符まで伏せる
          `${key}${sep}${/^["']/.test(value) ? `${value[0]}${MASK.secret}${value[0]}` : MASK.secret}`,
    )
    .replace(SECRET_QUERY, `$1${MASK.secret}`)
    .replace(EMAIL, MASK.email)
    .replace(CARD, MASK.card)
    .replace(LONG_DIGITS, MASK.card)
    .replace(IPV6, (found) =>
      // `::` だけ、16進の1字だけの並び (`a::b`) は C++ の名前などのことが多いので、数字を含むときだけ
      /\d/.test(found) ? MASK.ip : found,
    )
    .replace(IPV4, MASK.ip)
    .replace(
      URL_HOST,
      (_, scheme: string, host: string) => `${scheme}${maskHost(host)}`,
    )
    .replace(HOST_PORT, (host: string) =>
      NOT_HOSTS.has(host.toLowerCase()) ? host : maskHost(host),
    )
    .replace(BARE_HOST, maskHost)
    .replace(HOME, `$1${MASK.user}`);
  return out;
}
