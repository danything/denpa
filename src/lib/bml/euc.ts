/**
 * データ放送の字 (EUC-JP)。**スクリプトは字を EUC-JP の符号として扱う**
 * (STD-B24 第二編 付属2 5.4.3.4)。`"あ".charCodeAt(0)` は 0xA4A2、
 * `String.fromCharCode(0xA4A2)` は「あ」、大小の比べ方も EUC-JP の符号の順。
 * 実際の放送もこれに頼っている (TBS・テレ東が `fromCharCode(0xA1A1〜)`、MX が
 * `charCodeAt` を EUC の範囲と比べる)。
 *
 * ## 中の持ち方
 *
 * VM の文字列はふつうの JS の文字列 (UTF-16) で持ち、**1 字は必ず 1 単位**にする。
 *
 * - JIS X 0208 の 1〜84 区は `TextDecoder('euc-jp')` が返す字 (表は同梱しない。起動して
 *   最初に要ったときに 94×94 字を 1 回だけデコードして作る)
 * - **85〜94 区 (ARIB の追加記号・追加漢字と DRCS) は私用領域 U+E000〜** に置く。
 *   WHATWG の EUC-JP はこの区を IBM の拡張漢字として読むので任せられない。追加記号には
 *   U+1F000 台の字もあり、そのまま持つと 1 字が 2 単位になって `length` や `substring` が
 *   ずれる。描くときに `toDisplay` で本当の字 (または DRCS の画像) に開く
 * - 1〜84 区で `TextDecoder` が字を返さない点も私用領域 (U+E400〜) に置いて、符号が
 *   往復で失われないようにする
 */

import { ADDITIONAL } from "#lib/ts/b24-tables.js";

/** 85 区 1 点の置き場所 */
export const PUA_ADDITIONAL = 0xe000;
/** 字の無い 1〜84 区の点の置き場所。詰めて順に置く (千点ほど。U+F8FF までに収まる) */
const PUA_EMPTY = 0xe400;
/** 85〜94 区で 940 点 */
const ADDITIONAL_POINTS = 10 * 94;
/** DRCS (外字) が入る 87・88 区 (STD-B24 付属1 表13-1。BML では追加記号ではない) */
const DRCS_FIRST = PUA_ADDITIONAL + 2 * 94;
const DRCS_LAST = PUA_ADDITIONAL + 4 * 94 - 1;

/** 読めない字の代わり (〓)。EUC-JP で 0xA2AE */
const GETA = 0xa2ae;

let forward: string | null = null;
let additional: string[] | null = null;
let backward: Map<number, number> | null = null;
/** 字の無い点を置いた終わり (`table` が決める) */
let emptyEnd = PUA_EMPTY;

/** 1〜84 区を `TextDecoder` で一度だけデコードする */
function table(): string {
  if (forward !== null) return forward;
  const bytes = new Uint8Array(84 * 94 * 2);
  for (let i = 0; i < 84 * 94; i++) {
    bytes[i * 2] = 0xa1 + Math.floor(i / 94);
    bytes[i * 2 + 1] = 0xa1 + (i % 94);
  }
  const decoded = new TextDecoder("euc-jp").decode(bytes);
  let out = "";
  let at = 0;
  let empty = PUA_EMPTY;
  for (let i = 0; i < 84 * 94; i++) {
    const code = decoded.codePointAt(at) ?? 0xfffd;
    at += code > 0xffff ? 2 : 1;
    // 1 単位に収まらない字・読めない点は私用領域に置く (上の説明)
    out += String.fromCharCode(
      code === 0xfffd || code > 0xffff ? empty++ : code,
    );
  }
  emptyEnd = empty;
  forward = out;
  return out;
}

function reverse(): Map<number, number> {
  if (backward !== null) return backward;
  const map = new Map<number, number>();
  const all = table();
  for (let i = 0; i < all.length; i++) {
    const unit = all.charCodeAt(i);
    // 同じ字が 2 か所にあるときは若い番号 (NEC 特殊文字より JIS の本来の位置)
    if (!map.has(unit))
      map.set(unit, ((0xa1 + Math.floor(i / 94)) << 8) | (0xa1 + (i % 94)));
  }
  backward = map;
  return map;
}

/** EUC-JP の 2 バイト符号を中の字 1 単位に */
function fromPair(lead: number, trail: number): string {
  const ku = lead - 0xa0;
  const ten = trail - 0xa0;
  if (ku >= 85)
    return String.fromCharCode(PUA_ADDITIONAL + (ku - 85) * 94 + (ten - 1));
  return table()[(ku - 1) * 94 + (ten - 1)] ?? "�";
}

/** EUC-JP のバイト列を中の文字列に */
export function decodeEuc(data: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]!;
    if (byte < 0x80) {
      parts.push(String.fromCharCode(byte));
    } else if (byte >= 0xa1 && byte <= 0xfe) {
      const trail = data[i + 1];
      if (trail === undefined || trail < 0xa1 || trail > 0xfe) {
        parts.push("�");
        continue;
      }
      parts.push(fromPair(byte, trail));
      i++;
    } else if (
      byte === 0x8e &&
      (data[i + 1] ?? 0) >= 0xa1 &&
      (data[i + 1] ?? 0) <= 0xdf
    ) {
      // 半角カナ。運用されないが、読めるものは読む
      parts.push(String.fromCharCode(0xff61 + data[i + 1]! - 0xa1));
      i++;
    } else {
      // 3 バイト (JIS X 0212) も運用されない
      if (byte === 0x8f) i += 2;
      parts.push("�");
    }
  }
  return parts.join("");
}

/** 中の字 1 単位の EUC-JP の符号 (`charCodeAt`)。読めない字は 〓 */
export function eucCode(unit: number): number {
  if (unit < 0x80) return unit;
  if (unit >= PUA_ADDITIONAL && unit < PUA_ADDITIONAL + ADDITIONAL_POINTS) {
    const i = unit - PUA_ADDITIONAL;
    return ((0xa1 + 84 + Math.floor(i / 94)) << 8) | (0xa1 + (i % 94));
  }
  if (unit >= 0xff61 && unit <= 0xff9f) return 0x8e00 | (unit - 0xff61 + 0xa1);
  return reverse().get(unit) ?? GETA;
}

/** EUC-JP の符号から中の字 (`String.fromCharCode`)。2 バイトの形でなければ符号そのまま */
export function fromEucCode(code: number): string {
  const lead = (code >> 8) & 0xff;
  const trail = code & 0xff;
  if (lead >= 0xa1 && lead <= 0xfe && trail >= 0xa1 && trail <= 0xfe)
    return fromPair(lead, trail);
  if (lead === 0x8e && trail >= 0xa1 && trail <= 0xdf)
    return String.fromCharCode(0xff61 + trail - 0xa1);
  return String.fromCharCode(code & 0xffff);
}

/** 中の文字列を EUC-JP のバイト列に (通信で送る・NVRAM に書く) */
export function encodeEuc(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    const code = eucCode(text.charCodeAt(i));
    if (code < 0x100) out[at++] = code;
    else {
      out[at++] = code >> 8;
      out[at++] = code & 0xff;
    }
  }
  return out.subarray(0, at);
}

/** EUC-JP の符号の順で比べる (`<` など)。負・0・正 */
export function compareEuc(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    return eucCode(x) - eucCode(y);
  }
  return a.length - b.length;
}

/** DRCS の字か (87・88 区) */
export function isDrcs(unit: number): boolean {
  return unit >= DRCS_FIRST && unit <= DRCS_LAST;
}

/**
 * 画面に出す字に開く。追加記号は本当の字に、字の無い点は 〓 に。
 * **DRCS はここでは開かない** (画像は描く側が持つ。`isDrcs` で見分ける)
 */
export function toDisplay(text: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < PUA_ADDITIONAL || unit >= emptyEnd || isDrcs(unit)) continue;
    out += text.slice(from, i);
    if (unit >= PUA_EMPTY) out += "〓";
    else {
      additional ??= [...ADDITIONAL];
      const char = additional[unit - PUA_ADDITIONAL];
      out += char === undefined || char === "�" ? "〓" : char;
    }
    from = i + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}

/** 1 文字 2 バイトまでとして、EUC-JP で n バイトに切る (Ureg/Greg は 256 バイト) */
export function clipEuc(text: string, bytes: number): string {
  let size = 0;
  for (let i = 0; i < text.length; i++) {
    size += text.charCodeAt(i) < 0x80 ? 1 : 2;
    if (size > bytes) return text.slice(0, i);
  }
  return text;
}
