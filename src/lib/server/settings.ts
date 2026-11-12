import { eq, sql } from "drizzle-orm";

import { readIndoorHosts } from "../host";
import {
  HW_CODECS,
  HW_KINDS,
  type HwAllow,
  type HwCodec,
  type HwKind,
} from "../hw";
import { readNg } from "../jikkyo/ng";
import { normalizePrefecture } from "../prefecture";
import type { VideoCodec } from "../types";
import { config } from "./config";
import { now, orm } from "./db";
import { settings as settingsTable } from "./schema";

/**
 * 画面から変えられる設定。
 *
 * コーデックは、番組ごとに変えたくなることが実際にはほとんど無い。
 * ルールにも予約にも同じ選択肢を並べると、どこで決まったのか分からなくなるので
 * 全体で 1 つに寄せてある。初期値は下の `settings()` が持ち (コーデックだけ config.ts)、DB に値があればそちらが勝つ。
 */

interface Settings {
  /**
   * 録画のエンコードに使う映像コーデック。`none` ならエンコードしない。
   * **主のほう。** いくつもエンコードするときは AV1 → H.265 → H.264 の先頭 (小さいので既定の再生に向く)
   */
  codec: VideoCodec;
  /**
   * エンコードするコーデックの一覧。**いくつでも選べる** (`["av1", "hevc", "h264"]`)。H.265 は GPU でだけエンコードする
   *
   * 古いテレビは AV1 をデコードできないので、H.264 も一緒にエンコードしておくと同じ録画を
   * どちらの端末でも観られる (`server/encoder.ts`)。`none` (エンコードしない)
   * のときは空。並びは AV1 → H.265 → H.264 で、主 (`library_path`) は先頭にする
   */
  codecs: HwCodec[];
  /**
   * **デバイス (GPU) と方式ごとに、GPU でエンコードしてよいコーデック** (`#lib/hw.js` の HwAllow)。使えるかは
   * 別 (`server/hwenc.ts`) で、エンコードするのは「使える かつ 許されている」もの。いま使えない
   * GPU の印も保存で消さない (挿し直せばそのまま効く。`chooseHw`)。設定の 1 キーに JSON で持つ。
   * **録画のエンコードだけが読む。** ライブ・追っかけ・その場の変換は `liveHwAllow`
   */
  hwAllow: HwAllow;
  /**
   * **ライブ・追っかけ・録画のその場の変換で、GPU でエンコードしてよいコーデック。** 持ち方は `hwAllow` と同じ。
   * 録画と分けてあるのは、録画とライブで使う GPU を分けられるようにするため (`server/live.ts` の `pickLiveHw`)。
   * H.265 は GPU でだけエンコードするので、どの GPU でも H.265 を外すと、ライブで H.265 を出さない (`live.liveHevc`)
   */
  liveHwAllow: HwAllow;
  /** エンコードするか。**コーデックの選択から決まる** (`none` 以外なら する) */
  encode: boolean;
  /** エンコードしたあとも元の TS を残すか */
  keepOriginal: boolean;
  /**
   * データ放送に渡す郵便番号 (数字 7 桁。空なら渡さない)。
   *
   * **テレビの初期設定で必ず訊かれるあれ。** 放送のアプリは
   * `nvram://receiverinfo/zipcode` を読んで、天気・地域のニュース・
   * 防災情報をどこのものにするかを決める。入っていないと NHK なら
   * **「郵便番号が正しく設定されていません」**と出て、その欄が空のままになる。
   *
   * 受け取るのは端末の中 (localStorage) だが、置き場をここにしてあるのは
   * **端末ごとに訊き直さずに済ませる**ため。家の場所は端末では変わらない
   */
  postalCode: string;
  /**
   * データ放送に渡す都道府県 (`#lib/prefecture.js` の番号。未設定は 255)。
   *
   * 放送のアプリは `nvram://receiverinfo/prefecture` を読んで、地域の情報を
   * 出し分けることがある。置き場は郵便番号と同じくここ (家の場所は端末で変わらない)
   */
  prefecture: number;
  /**
   * データ放送の双方向 (通信系コンテンツ) を使うか。**既定はオン** (テレビと同じく通信の項目が開く。
   * 一度保存した人は、保存した値のまま)。
   *
   * オンだと denpa のサーバが**放送局のサーバへ代理で取得し、送りもします**
   * (`server/bml-network.ts`)。取得 (GET) だけでなく、放送のアプリが組んだ
   * 応募・投票の送信 (POST = `transmitTextDataOverIP`) もそのまま中継します。
   * 切っている間は `isIPConnected` が 0 を返すので、放送のアプリは
   * 「インターネットに接続されていません」と正しく案内します
   */
  bmlNetwork: boolean;
  /**
   * **その場で変換する本数の上限** (`server/transcode.ts`)。録画をエンコード済みと違う形式で流す
   * (`/api/recordings/<id>/stream`) のと追っかけ再生を数える。null は自動 (GPU が無ければ 2、あれば 4)
   */
  transcodeLimit: number | null;
  /**
   * **実況のコメントを流せるようにするか。既定はオフ。** オンのときだけ、局の一覧に実況のチャンネル (`jikkyo`) が入り、
   * 端末の ⚙ に「実況」の行が出る。流れるコメントは denpa のサーバを通らず、実況をオンにした端末が
   * NX-Jikkyo と過去ログ API に直接繋ぐ (`#lib/jikkyo/endpoints.ts`)。相手には端末の IP と、どの局をいつ観ているかが見える。
   * 公式の実況への書き込みだけは、ニコニコと連携していれば denpa のサーバが中継する (`server/niconico-live.ts`)
   */
  jikkyo: boolean;
  /** **実況の NG ワード** (世帯で 1 つ)。含むコメントは流さない (`#lib/jikkyo/ng.ts`)。設定の 1 キーに JSON の配列で持つ */
  jikkyoNg: string[];
  /**
   * **家の中で使う名前** (世帯で 1 つ。`dp.l.example.com` など)。この名前で開いた画面は、ライブと追っかけの「自動」で
   * MPEG-2 (放送のまま) を先に選ぶ (`#lib/live-choice.ts` の `autoOrder`。家の中かは `#lib/host.ts` の `indoorHost`)。プライベートの IP・`localhost`・`.local` などは
   * 載せなくても家の中。設定の 1 キーに JSON の配列で持つ
   */
  indoorHosts: string[];
  /**
   * **ロゴを取得した結果を DB に残すか。既定はオフ。** デバッグ用。衛星のロゴが流れてくる期間を測るときだけオンにする
   * (`logo-record.ts`。docs/logo.md「ロゴの取得を記録する」)
   */
  recordLogo: boolean;
}

/** 本数の上限に選べる幅 */
export const TRANSCODE_LIMIT_MAX = 16;

/** 本数の上限を読む。1〜`TRANSCODE_LIMIT_MAX` の整数でなければ自動 (null) */
export function parseTranscodeLimit(
  value: string | null | undefined,
): number | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= TRANSCODE_LIMIT_MAX ? n : null;
}

/**
 * 数字 7 桁だけを残す。`123-4567` でも `1234567` でも同じに読む。
 *
 * **7 桁でなければ空にする。** 途中まで入った番号を渡すと、放送側は
 * 「入っているが違う場所」として扱う。入っていないほうがまだ分かりやすい
 */
export function normalizePostalCode(value: string): string {
  const digits = value.replace(/[^0-9]/g, "");
  return digits.length === 7 ? digits : "";
}

/** 設定の表の 1 つを読む。画面の設定でない控え (`restore-width` の済んだ所・`satellite-lineup` の消した種別) もここ */
export function stored(key: string): string | undefined {
  return orm()
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, key))
    .get()?.value;
}

/**
 * コーデックの選択を読む。**カンマ区切りで、1 つだけの古い値も読める。**
 *
 * `av1,h264` → `['av1', 'h264']`、`av1` → `['av1']`、`none` や空 → `[]`。
 * **並びは AV1 → H.265 → H.264 に揃える。** 主 (`library_path`) を先頭にするので、順序を固定する
 */
export function parseCodecs(value: string | undefined): HwCodec[] {
  const raw = (value ?? config.encodeCodec).split(",").map((s) => s.trim());
  return HW_CODECS.filter((codec) => raw.includes(codec));
}

/**
 * `hwAllow`・`liveHwAllow` を読む。壊れていれば空 (= 全部よい)。デバイスごとに `{ vaapi: [...], rkmpp: [...], nvenc: [...], qsv: [...], amf: [...], videotoolbox: [...] }`。
 * 書かれていない方式は空。方式はデバイスごとに決まっていて (`/dev/dri/*` は VA-API、
 * `/dev/mpp_service` は Rockchip MPP、`/dev/nvidia0` などは NVENC、Windows の `qsv0` は QSV、`amf0` は AMF、Mac の `videotoolbox` は VideoToolbox)、そのデバイスで使えない方式の印は何にも効かない
 */
function parseHwAllow(value: string | undefined): HwAllow {
  if (value === undefined || value === "") return {};
  try {
    const raw = JSON.parse(value) as Record<
      string,
      Partial<Record<HwKind, unknown>>
    >;
    const out: HwAllow = {};
    for (const [device, entry] of Object.entries(raw)) {
      if (entry === null || typeof entry !== "object") continue;
      const pick = (raw: unknown): HwCodec[] =>
        HW_CODECS.filter((codec) => Array.isArray(raw) && raw.includes(codec));
      out[device] = Object.fromEntries(
        HW_KINDS.map((kind) => [kind, pick(entry[kind])]),
      ) as Record<HwKind, HwCodec[]>;
    }
    return out;
  } catch {
    return {};
  }
}

export function settings(): Settings {
  const flag = (key: string, fallback: boolean) => {
    const value = stored(key);
    return value === undefined ? fallback : value === "true";
  };
  const codecs = parseCodecs(stored("codec"));
  // 主は先頭 (parseCodecs が AV1 → H.265 → H.264 に揃えている)
  const primary: VideoCodec = codecs[0] ?? "none";
  return {
    codec: primary,
    codecs,
    hwAllow: parseHwAllow(stored("hwAllow")),
    liveHwAllow: parseHwAllow(stored("liveHwAllow")),
    encode: codecs.length > 0,
    keepOriginal: flag("keepOriginal", false),
    postalCode: normalizePostalCode(stored("postalCode") ?? ""),
    prefecture: normalizePrefecture(stored("prefecture")),
    // テレビと同じく通信できるのが既定。設定画面の説明の 1 行目で、視聴の記録が送られうることを出す
    bmlNetwork: flag("bmlNetwork", true),
    transcodeLimit: parseTranscodeLimit(stored("transcodeLimit")),
    jikkyo: flag("jikkyo", false),
    jikkyoNg: readNg(stored("jikkyoNg")),
    indoorHosts: readIndoorHosts(stored("indoorHosts")),
    recordLogo: flag("recordLogo", false),
  };
}

/** 設定の表の 1 つを書く (`stored` の対) */
export function store(key: string, value: string): void {
  saveRaw(orm(), key, value, now());
}

function saveRaw(
  db: Pick<ReturnType<typeof orm>, "insert">,
  key: string,
  value: string,
  at: number,
): void {
  db.insert(settingsTable)
    .values({ key, value, updated_at: at })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { value: sql`excluded.value`, updated_at: sql`excluded.updated_at` },
    })
    .run();
}

/**
 * 設定を書く。**コーデックの選択は `codecs` で渡す** (設定の表の `codec` にカンマ区切りで書く。どれも選ばなければ `none`)。
 * `codec` (主) と `encode` は `codecs` から決まるだけなので書かない
 */
export function saveSettings({
  codecs,
  ...rest
}: Partial<Omit<Settings, "encode" | "codec">>): Settings {
  const at = now();
  orm().transaction((tx) => {
    if (codecs !== undefined)
      saveRaw(tx, "codec", codecs.length > 0 ? codecs.join(",") : "none", at);
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      // デバイスごとの GPU の設定と NG ワードの並びは JSON。自動 (null) は空。ほかは文字列で足りる
      const text =
        value === null
          ? ""
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
      saveRaw(tx, key, text, at);
    }
  });
  return settings();
}
