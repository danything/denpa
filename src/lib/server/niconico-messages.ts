/**
 * **公式のニコニコ実況のメッセージサーバの返事を読む** (protobuf。`niconico-view.ts` が使う)。
 *
 * - 依存を足さず、使うフィールドだけを読む小さな読み取り関数。知らないフィールドは読み飛ばす
 * - 返事は「長さ (varint) + メッセージ」の並びで、少しずつ届く。`Delimited` が届いたぶんを溜めて、そろったものから返す
 * - view (`ChunkedEntry`) から使うのは `segment` (URI) と `next` (次の view の時刻)。
 *   セグメント (`ChunkedMessage`) から使うのは `meta` の ID と投稿時刻、`message` のコメント (`chat` と `overflowed_chat`)
 * - **コメントの投稿者の ID・名前・番号は、自分の書き込みかを見たら捨てる。** 返すのは本文と時刻と流し方 (`mail` に組んだもの) だけ。
 *   書体と透過も捨てる
 */

/** 1 つのフィールド。長さ付きのものは中身のバイト列、varint は数 */
type Field =
  | { no: number; kind: "varint"; value: number }
  | { no: number; kind: "bytes"; value: Uint8Array };

/** varint を読む。読み切れなければ null。53 ビットを超える値は丸める (使うのは時刻と ID の比較だけ) */
function varint(
  buf: Uint8Array,
  at: number,
): { value: number; next: number } | null {
  let value = 0;
  let scale = 1;
  for (let i = at; i < buf.length && i < at + 10; i++) {
    const byte = buf[i]!;
    value += (byte & 0x7f) * scale;
    scale *= 128;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
  }
  if (buf.length - at >= 10) throw new Error("varint が長すぎます");
  return null;
}

/** メッセージを 1 つ、フィールドに分ける。形が壊れていたら投げる */
function fields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let at = 0;
  while (at < buf.length) {
    const key = varint(buf, at);
    if (key === null) throw new Error("フィールドが途中で切れています");
    at = key.next;
    const no = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (wire === 0) {
      const v = varint(buf, at);
      if (v === null) throw new Error("フィールドが途中で切れています");
      out.push({ no, kind: "varint", value: v.value });
      at = v.next;
    } else if (wire === 2) {
      const len = varint(buf, at);
      if (len === null || len.next + len.value > buf.length)
        throw new Error("フィールドが途中で切れています");
      out.push({
        no,
        kind: "bytes",
        value: buf.subarray(len.next, len.next + len.value),
      });
      at = len.next + len.value;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else throw new Error(`知らない種類のフィールドです (${wire})`);
  }
  if (at > buf.length) throw new Error("フィールドが途中で切れています");
  return out;
}

function bytes(list: Field[], no: number): Uint8Array | null {
  for (const f of list) if (f.no === no && f.kind === "bytes") return f.value;
  return null;
}

function num(list: Field[], no: number): number | null {
  let found: number | null = null;
  for (const f of list) if (f.no === no && f.kind === "varint") found = f.value;
  return found;
}

const text = new TextDecoder();
function str(list: Field[], no: number): string | null {
  const b = bytes(list, no);
  return b === null ? null : text.decode(b);
}

/** `google.protobuf.Timestamp` を unix ms に */
function timestamp(buf: Uint8Array | null): number | null {
  if (buf === null) return null;
  const list = fields(buf);
  const seconds = num(list, 1) ?? 0;
  const nanos = num(list, 2) ?? 0;
  return seconds * 1000 + Math.floor(nanos / 1_000_000);
}

/**
 * **長さ付きの並びを、届いたぶんから 1 つずつ切り出す。** 途中で切れているものは次に届くまで持つ
 */
export class Delimited {
  private rest: Uint8Array = new Uint8Array(0);

  /** 届いたバイト列を足し、そろったメッセージを返す */
  push(chunk: Uint8Array): Uint8Array[] {
    const buf =
      this.rest.length === 0
        ? chunk
        : new Uint8Array(this.rest.length + chunk.length);
    if (buf !== chunk) {
      buf.set(this.rest);
      buf.set(chunk, this.rest.length);
    }
    const out: Uint8Array[] = [];
    let at = 0;
    for (;;) {
      const len = varint(buf, at);
      if (len === null || len.next + len.value > buf.length) break;
      out.push(buf.slice(len.next, len.next + len.value));
      at = len.next + len.value;
    }
    this.rest = buf.slice(at);
    return out;
  }
}

/** view の 1 項目。使うものだけ */
export type Entry =
  /** セグメントの URI と、その区間の終わり (unix ms) */
  | { segment: string; until: number }
  | { next: number }
  /** `backward`・`previous` など。読まない */
  | null;

/** view (`ChunkedEntry`) を 1 つ読む */
export function readEntry(buf: Uint8Array): Entry {
  const list = fields(buf);
  const segment = bytes(list, 1);
  if (segment !== null) {
    const seg = fields(segment);
    const uri = str(seg, 3);
    return uri === null
      ? null
      : { segment: uri, until: timestamp(bytes(seg, 2)) ?? 0 };
  }
  const next = bytes(list, 4);
  if (next !== null) return { next: num(fields(next), 1) ?? 0 };
  return null;
}

/** 受けたコメント。投稿者の ID はもう持たない */
export interface OfficialChat {
  /** メッセージの ID (重なりを除くため) */
  id: string;
  /** 投稿時刻 (unix ms) */
  at: number;
  text: string;
  /** 色・位置・大きさのコマンド (`readMail` で読む形) */
  mail: string;
  /** 投稿者が自分 (世帯のアカウント) */
  own: boolean;
}

/** 位置・大きさ・名前の色の番号 → コマンド (protobuf の enum の並び) */
const POSITIONS = ["naka", "shita", "ue"];
const SIZES = ["medium", "small", "big"];
const COLORS = [
  "white",
  "red",
  "pink",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "black",
  "white2",
  "red2",
  "pink2",
  "orange2",
  "yellow2",
  "green2",
  "cyan2",
  "blue2",
  "purple2",
  "black2",
];

function hex(v: number | null): string {
  return Math.max(0, Math.min(255, v ?? 0))
    .toString(16)
    .padStart(2, "0");
}

/** 修飾を `mail` のコマンドの並びに組む */
function modifierMail(buf: Uint8Array | null): string {
  if (buf === null) return "";
  const list = fields(buf);
  const out: string[] = [];
  const position = POSITIONS[num(list, 1) ?? 0];
  if (position !== undefined) out.push(position);
  const size = SIZES[num(list, 2) ?? 0];
  if (size !== undefined) out.push(size);
  const full = bytes(list, 4);
  if (full !== null) {
    const rgb = fields(full);
    out.push(`#${hex(num(rgb, 1))}${hex(num(rgb, 2))}${hex(num(rgb, 3))}`);
  } else {
    const color = COLORS[num(list, 3) ?? 0];
    if (color !== undefined) out.push(color);
  }
  return out.join(" ");
}

/**
 * セグメントの 1 メッセージ (`ChunkedMessage`) を読む。コメント (`chat`・`overflowed_chat`) でなければ null。
 * `self` は `messageServer` の `hashedUserId` (いつも 184 で書くので、自分の書き込みはこれで見分ける)
 */
export function readMessage(
  buf: Uint8Array,
  self: string | null,
): OfficialChat | null {
  const list = fields(buf);
  const meta = bytes(list, 1);
  const message = bytes(list, 2);
  if (meta === null || message === null) return null;
  const metaFields = fields(meta);
  const id = str(metaFields, 1);
  const at = timestamp(bytes(metaFields, 2));
  const body = fields(message);
  const chat = bytes(body, 1) ?? bytes(body, 20);
  if (id === null || at === null || chat === null) return null;
  const c = fields(chat);
  const own = self !== null && str(c, 6) === self;
  return {
    id,
    at,
    text: str(c, 1) ?? "",
    mail: modifierMail(bytes(c, 7)),
    own,
  };
}
