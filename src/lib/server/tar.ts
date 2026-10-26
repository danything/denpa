/**
 * tar (ustar) の読み書き。**denpa の書き出し (`transfer.ts`) のためだけの、小さなもの。**
 *
 * Bun 1.4 の `Bun.Archive` は使わない。中身を全部メモリに載せて組む作りで (数百 MB の DB を
 * 抱えることになる)、読むときもエントリの種類を見せず、`..` は断らずに畳んで、
 * シンボリックリンクはそのまま作る。取り込みでは「普通のファイルとフォルダだけ」「名前は決めたものだけ」を
 * 厳しく見たいので、ヘッダを自分で読む。
 *
 * 書くのは普通のファイルだけ (フォルダのエントリは書かない。読む側が親を作る)。名前は 100 バイトまで
 * (書き出すものの名前は決まっていて、いちばん長い CM のロゴでも 40 バイトほど)
 */

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface TarSource {
  /** tar の中の名前 (`/` 区切り) */
  name: string;
  /** 大きさ (バイト)。流れてきた量と合わなければ止める (書き出しの途中で変わったもの) */
  size: number;
  body: () => ReadableStream<Uint8Array<ArrayBuffer>>;
}

/** 数を 8 進の文字列にして、`width` バイトの欄に書く (最後は NUL) */
function octal(
  header: Uint8Array,
  at: number,
  width: number,
  value: number,
): void {
  const text = value.toString(8).padStart(width - 1, "0");
  if (text.length > width - 1)
    throw new Error(`tar の欄に入らない数です: ${value}`);
  header.set(encoder.encode(text), at);
  header[at + width - 1] = 0;
}

function header(
  name: string,
  size: number,
  mtime: number,
): Uint8Array<ArrayBuffer> {
  const bytes = encoder.encode(name);
  if (bytes.length === 0 || bytes.length > 100)
    throw new Error(`tar に書けない名前です: ${name}`);
  const block = new Uint8Array(BLOCK);
  block.set(bytes, 0);
  octal(block, 100, 8, 0o644);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, size);
  octal(block, 136, 12, Math.floor(mtime / 1000));
  block[156] = 0x30; // "0" = 普通のファイル
  block.set(encoder.encode("ustar\u000000"), 257);
  // チェックサムは、自分の欄を空白で埋めて足したもの
  block.fill(0x20, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.set(encoder.encode(sum.toString(8).padStart(6, "0")), 148);
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

async function* chunks(
  entries: TarSource[],
  mtime: number,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  for (const entry of entries) {
    yield header(entry.name, entry.size, mtime);
    let written = 0;
    for await (const chunk of entry.body()) {
      written += chunk.length;
      if (written > entry.size) break;
      yield chunk;
    }
    if (written !== entry.size)
      throw new Error(`${entry.name} の大きさが書き出しの途中で変わりました`);
    const pad = (BLOCK - (written % BLOCK)) % BLOCK;
    if (pad > 0) yield new Uint8Array(pad);
  }
  // 終わりの印 (0 のブロック 2 つ)
  yield new Uint8Array(BLOCK * 2);
}

/** ファイルを順に並べた tar を流す。受け手がやめたら (`cancel`) 読みかけのファイルも閉じる */
export function writeTar(
  entries: TarSource[],
  mtime = Date.now(),
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const iterator = chunks(entries, mtime);
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

export interface TarLimits {
  /** 中身の大きさの合計の上限。縮めたものを開くと膨らむので、ここで止める */
  maxBytes: number;
  /** エントリの数の上限 */
  maxEntries: number;
}

export interface TarEntry {
  /** 名前。フォルダは最後の `/` を外したもの */
  name: string;
  type: "file" | "dir";
  size: number;
}

/** 読んだ中身の書き込み先。`write` は流れてきた順に呼ぶ */
export interface TarSink {
  write(chunk: Uint8Array): void;
  close(): void;
}

/** 読み進めながら、決まった長さだけ取り出す */
class Reader {
  private buffer: Uint8Array = new Uint8Array(0);
  private offset = 0;

  constructor(private readonly source: AsyncIterator<Uint8Array>) {}

  private get left(): number {
    return this.buffer.length - this.offset;
  }

  private async fill(): Promise<boolean> {
    const { value, done } = await this.source.next();
    if (done) return false;
    if (this.left === 0) {
      this.buffer = value;
    } else {
      const merged = new Uint8Array(this.left + value.length);
      merged.set(this.buffer.subarray(this.offset), 0);
      merged.set(value, this.left);
      this.buffer = merged;
    }
    this.offset = 0;
    return true;
  }

  /** ちょうど `n` バイト。何も残っていなければ null、途中で尽きたら投げる */
  async exact(n: number): Promise<Uint8Array | null> {
    while (this.left < n) {
      if (await this.fill()) continue;
      if (this.left === 0) return null;
      throw new Error("ファイルが途中で切れています");
    }
    const out = this.buffer.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  /** `n` バイトを、届いた塊のまま渡す (大きなファイルをメモリに溜めない) */
  async pipe(n: number, sink: (chunk: Uint8Array) => void): Promise<void> {
    let rest = n;
    while (rest > 0) {
      if (this.left === 0 && !(await this.fill()))
        throw new Error("ファイルが途中で切れています");
      const take = Math.min(rest, this.left);
      sink(this.buffer.subarray(this.offset, this.offset + take));
      this.offset += take;
      rest -= take;
    }
  }
}

function text(block: Uint8Array, at: number, width: number): string {
  const field = block.subarray(at, at + width);
  const end = field.indexOf(0);
  try {
    return decoder.decode(end === -1 ? field : field.subarray(0, end));
  } catch {
    throw new Error("tar のヘッダの名前が読めません");
  }
}

function number(block: Uint8Array, at: number, width: number): number {
  // 先頭のビットが立っているもの (GNU の 256 進) は書かないので読まない
  if ((block[at]! & 0x80) !== 0) throw new Error("tar の数の欄が読めません");
  const raw = text(block, at, width).trim();
  if (!/^[0-7]*$/.test(raw)) throw new Error("tar の数の欄が読めません");
  return raw === "" ? 0 : parseInt(raw, 8);
}

function parseHeader(block: Uint8Array): TarEntry {
  const sum = block.reduce(
    (total, byte, i) => total + (i >= 148 && i < 156 ? 0x20 : byte),
    0,
  );
  if (number(block, 148, 8) !== sum)
    throw new Error("tar のヘッダが壊れています (チェックサムが合いません)");
  if (text(block, 257, 6).trimEnd() !== "ustar")
    throw new Error("tar の形式が違います (ustar ではありません)");
  const prefix = text(block, 345, 155);
  const base = text(block, 0, 100);
  const full = prefix === "" ? base : `${prefix}/${base}`;
  const flag = block[156];
  const size = number(block, 124, 12);
  if (flag === 0x30 || flag === 0) return { name: full, type: "file", size };
  if (flag === 0x35)
    return { name: full.replace(/\/$/, ""), type: "dir", size };
  // リンク・デバイス・拡張ヘッダ (pax) などは入れない
  throw new Error(
    `普通のファイルでもフォルダでもないもの (${JSON.stringify(full)}) が入っています`,
  );
}

/**
 * tar を読み、エントリごとに `accept` に渡す。`accept` は書き込み先を返すか、名前が駄目なら投げる。
 * 上限 (`limits`) を超えたら、書き込む前に止める
 */
export async function readTar(
  stream: ReadableStream<Uint8Array>,
  limits: TarLimits,
  accept: (entry: TarEntry) => TarSink | null,
): Promise<number> {
  const reader = new Reader(stream[Symbol.asyncIterator]());
  let entries = 0;
  let bytes = 0;
  for (;;) {
    const block = await reader.exact(BLOCK);
    if (block === null) throw new Error("ファイルが途中で切れています");
    // 0 のブロックが終わりの印。後ろの詰め物は読まない
    if (block.every((byte) => byte === 0)) return entries;
    const entry = parseHeader(block);
    entries++;
    if (entries > limits.maxEntries)
      throw new Error(`中身の数が多すぎます (${limits.maxEntries} 個まで)`);
    bytes += entry.size;
    if (bytes > limits.maxBytes)
      throw new Error(
        `中身が大きすぎます (${Math.round(limits.maxBytes / 1024 ** 3)} GiB まで)`,
      );
    const sink = accept(entry);
    if (entry.type === "dir" || sink === null) {
      await reader.pipe(entry.size, () => {});
    } else {
      try {
        await reader.pipe(entry.size, (chunk) => sink.write(chunk));
      } finally {
        sink.close();
      }
    }
    const pad = (BLOCK - (entry.size % BLOCK)) % BLOCK;
    if (pad > 0) await reader.pipe(pad, () => {});
  }
}
