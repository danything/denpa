import { describe, expect, test } from "bun:test";

import { readTar, type TarEntry, type TarSource, writeTar } from "./tar";

/**
 * 書き出しの tar (`tar.ts`)。書いたものを読み戻せることと、取り込みで断るもの
 * (リンク・壊れたヘッダ・途中で切れたもの・上限を超えるもの) を見る
 */

const LIMITS = { maxBytes: 1024 ** 2, maxEntries: 100 };

function source(name: string, text: string): TarSource {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    size: bytes.length,
    body: () => new Blob([bytes]).stream(),
  };
}

async function bytesOf(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function read(
  bytes: Uint8Array,
  limits = LIMITS,
): Promise<{ entries: TarEntry[]; files: Record<string, string> }> {
  const entries: TarEntry[] = [];
  const files: Record<string, string> = {};
  // 細かく分けて流す (ヘッダや中身が塊の境目をまたいでも読めること)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 100)
        controller.enqueue(bytes.slice(at, at + 100));
      controller.close();
    },
  });
  await readTar(stream, limits, (entry) => {
    entries.push(entry);
    if (entry.type === "dir") return null;
    let text = "";
    const decoder = new TextDecoder();
    return {
      write: (chunk) => {
        text += decoder.decode(chunk, { stream: true });
      },
      close: () => {
        files[entry.name] = text + decoder.decode();
      },
    };
  });
  return { entries, files };
}

/** ヘッダの種類を書き換え、チェックサムを付け直す */
function retype(bytes: Uint8Array, flag: string): Uint8Array {
  const out = bytes.slice();
  out[156] = flag.charCodeAt(0);
  out.fill(0x20, 148, 156);
  const sum = out.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  out.set(new TextEncoder().encode(sum.toString(8).padStart(6, "0")), 148);
  out[154] = 0;
  return out;
}

describe("tar", () => {
  test("書いたものを読み戻せる", async () => {
    const big = "あ".repeat(3000);
    const bytes = await bytesOf(
      writeTar([
        source("denpa-export.json", "{}"),
        source("logos/cm/1/own-logo-1440x1080.bin", big),
        source("empty", ""),
      ]),
    );
    expect(bytes.length % 512).toBe(0);
    const { entries, files } = await read(bytes);
    expect(entries.map((e) => e.name)).toEqual([
      "denpa-export.json",
      "logos/cm/1/own-logo-1440x1080.bin",
      "empty",
    ]);
    expect(files["logos/cm/1/own-logo-1440x1080.bin"]).toBe(big);
    expect(files["empty"]).toBe("");
  });

  test("書き出しの途中で大きさが変わったら止める", async () => {
    const liar: TarSource = { ...source("a", "abc"), size: 10 };
    await expect(bytesOf(writeTar([liar]))).rejects.toThrow("大きさ");
  });

  test("シンボリックリンク・ハードリンクは断る", async () => {
    const bytes = await bytesOf(writeTar([source("denpa.db", "x")]));
    for (const flag of ["1", "2", "x"]) {
      await expect(read(retype(bytes, flag))).rejects.toThrow(
        "普通のファイルでもフォルダでもない",
      );
    }
  });

  test("フォルダのエントリは読める", async () => {
    const bytes = await bytesOf(writeTar([source("logos/", "")]));
    const { entries } = await read(retype(bytes, "5"));
    expect(entries).toEqual([{ name: "logos", type: "dir", size: 0 }]);
  });

  test("チェックサムの合わないヘッダは断る", async () => {
    const bytes = await bytesOf(writeTar([source("denpa.db", "x")]));
    bytes[0] = "e".charCodeAt(0);
    await expect(read(bytes)).rejects.toThrow("チェックサム");
  });

  test("途中で切れたものは断る", async () => {
    const bytes = await bytesOf(
      writeTar([source("denpa.db", "x".repeat(2000))]),
    );
    await expect(read(bytes.slice(0, 1024))).rejects.toThrow("途中で切れて");
    // 終わりの印が無い
    await expect(read(bytes.slice(0, bytes.length - 1024))).rejects.toThrow(
      "途中で切れて",
    );
  });

  test("上限を超えたら書く前に止める", async () => {
    const bytes = await bytesOf(
      writeTar([source("a", "x".repeat(600)), source("b", "y")]),
    );
    await expect(
      read(bytes, { maxBytes: 500, maxEntries: 10 }),
    ).rejects.toThrow("大きすぎます");
    await expect(
      read(bytes, { maxBytes: 10_000, maxEntries: 1 }),
    ).rejects.toThrow("数が多すぎます");
  });
});
