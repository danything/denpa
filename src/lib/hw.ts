/**
 * GPU でエンコードする話の、**画面とサーバで共有する型と名前**。
 * 探し方・エンコード方式の本体は `server/hwenc.ts` (画面からは読み込めない)
 */

/** GPU でエンコードできるコーデック。**AV1 が先** — 主 (`library_path`) をそちらにする順序と同じ */
export const HW_CODECS = ["av1", "h264"] as const;
export type HwCodec = (typeof HW_CODECS)[number];

/** GPU でエンコードする方式。並びがそのまま試す順 (QSV が先。理由は server/hwenc.ts) */
export const HW_KINDS = ["qsv", "vaapi"] as const;
export type HwKind = (typeof HW_KINDS)[number];

export const HW_KIND_LABEL: Record<HwKind, string> = {
  qsv: "QSV",
  vaapi: "VA-API",
};
export const CODEC_LABEL: Record<HwCodec, string> = {
  av1: "AV1",
  h264: "H.264",
};

/**
 * **デバイス (GPU) ごとに、GPU でエンコードしてよいコーデック** (設定 `hwAllow`)。デバイスの path がキー。
 * **載っていないデバイスは全部よい** — GPU が見つかれば黙って使う (「自動でチェックが入る」)
 */
export type HwAllow = Record<string, Record<HwKind, HwCodec[]>>;

/** そのデバイス・方式・コーデックが、設定で許されているか */
export function hwAllowed(
  allow: HwAllow,
  device: string,
  kind: HwKind,
  codec: HwCodec,
): boolean {
  const entry = allow[device];
  return entry === undefined || entry[kind].includes(codec);
}

/** 設定画面の「エンコーダ」で選ぶのに要る、デバイスの見え方。`server/hwenc.ts` の `HwDevice` の一部 */
export type HwUsable = { path: string } & Record<HwKind, readonly HwCodec[]>;

/** エンコーダの選び方。デバイスの path のほかに、ソフトウェアと「GPU を順番に使う」 */
export const HW_SOFTWARE = "software";
export const HW_EVERY = "every";

/** そのコーデックを GPU でエンコードできる (試しのエンコードが通った) デバイス */
export function hwUsable<D extends HwUsable>(
  devices: readonly D[],
  codec: HwCodec,
): D[] {
  return devices.filter((device) =>
    HW_KINDS.some((kind) => device[kind].includes(codec)),
  );
}

/** デバイスの使える方式のうち、このコーデックで1つでも許されているか */
function onFor(allow: HwAllow, device: HwUsable, codec: HwCodec): boolean {
  return HW_KINDS.some(
    (kind) =>
      device[kind].includes(codec) &&
      hwAllowed(allow, device.path, kind, codec),
  );
}

/**
 * **設定 (`hwAllow`) を、コーデックごとの「エンコーダ」1つに読み替える。**
 * 使えるデバイスのうち許されているのが 0 ならソフトウェア、1つならそのデバイス、2つ以上なら順番に使う
 */
export function hwChoice(
  allow: HwAllow,
  devices: readonly HwUsable[],
  codec: HwCodec,
): string {
  const on = hwUsable(devices, codec).filter((device) =>
    onFor(allow, device, codec),
  );
  if (on.length === 0) return HW_SOFTWARE;
  return on.length === 1 ? (on[0] as HwUsable).path : HW_EVERY;
}

/**
 * **選んだエンコーダを設定 (`hwAllow`) に書き戻す。** 持ち方はデバイス × 方式 × コーデックのまま。
 *
 * - 選ばれなかったデバイスは、このコーデックの印を (使える方式すべてで) 外す
 * - 選ばれたデバイスは、すでにどれかの方式で許されていればそのまま (QSV だけ外した、などを崩さない)。
 *   どれも許されていなければ、使える方式すべてに印を付ける
 * - 使えない方式の印・ほかのコーデック・いま見えていないデバイスは前のまま (GPU を挿し替えたときにそのまま効く)
 */
export function chooseHw(
  allow: HwAllow,
  devices: readonly HwUsable[],
  codec: HwCodec,
  choice: string,
): HwAllow {
  const next: HwAllow = { ...allow };
  for (const device of hwUsable(devices, codec)) {
    const chosen = choice === HW_EVERY || choice === device.path;
    const keep = chosen && onFor(allow, device, codec);
    next[device.path] = Object.fromEntries(
      HW_KINDS.map((kind) => {
        const before = HW_CODECS.filter((c) =>
          hwAllowed(allow, device.path, kind, c),
        );
        if (keep || !device[kind].includes(codec)) return [kind, before];
        const others = before.filter((c) => c !== codec);
        // 並びは HW_CODECS のまま (AV1 が先)
        return [
          kind,
          chosen
            ? HW_CODECS.filter((c) => c === codec || others.includes(c))
            : others,
        ];
      }),
    ) as HwAllow[string];
  }
  return next;
}
