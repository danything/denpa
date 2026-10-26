import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTar, type TarSource, writeTar } from "../../src/lib/server/tar";

/**
 * **新しいバージョンの denpa が書き出したように見せたファイル**を作る (`56-transfer`)。
 * 書き出したファイルを開き、DB の `__drizzle_migrations` に今より先の時刻の行を足して、縮め直す。
 * e2e の本体 (Playwright) からは bun:sqlite を使えないので、bun で別に走らせる
 *
 *     bun tests/fake/transfer-archive.ts <書き出したファイル> <作るファイル>
 */
const [from, to] = process.argv.slice(2);
if (from === undefined || to === undefined)
  throw new Error("使い方: transfer-archive.ts <元> <先>");

const files = new Map<string, Uint8Array<ArrayBuffer>>();
await readTar(
  Bun.file(from)
    .stream()
    .pipeThrough(new DecompressionStream("zstd" as CompressionFormat)),
  { maxBytes: 1024 ** 3, maxEntries: 10_000 },
  (entry) => {
    const parts: Uint8Array[] = [];
    return {
      write: (chunk) => parts.push(chunk.slice()),
      close: () => files.set(entry.name, new Uint8Array(Buffer.concat(parts))),
    };
  },
);

const work = mkdtempSync(join(tmpdir(), "denpa-newer-"));
const path = join(work, "denpa.db");
writeFileSync(path, files.get("denpa.db")!);
const db = new Database(path);
db.query(
  "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('from-the-future', ?)",
).run(Date.now() + 365 * 24 * 3_600_000);
db.close();
files.set("denpa.db", new Uint8Array(readFileSync(path)));
files.set(
  "denpa-export.json",
  new TextEncoder().encode(JSON.stringify({ version: "v99.0.0" })),
);

const entries: TarSource[] = [...files].map(([name, bytes]) => ({
  name,
  size: bytes.length,
  body: () => new Blob([bytes]).stream(),
}));
await Bun.write(
  to,
  await new Response(
    writeTar(entries).pipeThrough(
      new CompressionStream("zstd" as CompressionFormat),
    ),
  ).arrayBuffer(),
);
