import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CmMaterial } from "./cm-material";

/**
 * ロゴの無かった場面の置き場 (`cm-shots.ts`)。照らす相手はほかの局の録画だけで、
 * 同じ映像を流している局 (サブチャンネルの枠) は同じ局とみる
 */
const root = mkdtempSync(join(tmpdir(), "denpa-cmshots-"));
const { config } = await import("./config");
config.dbPath = join(root, "denpa.db");
config.cmLogoDir = join(root, "logos");

const { orm } = await import("./db");
const { cmShots, recordings, services } = await import("./schema");
const { forgetShots, repeatedFor, saveShots } = await import("./cm-shots");

const station = (id: number, name: string) => ({
  id,
  service_id: 1000 + id,
  network_id: 4,
  name,
  type: "GR" as const,
  channel: "T27",
  updated_at: 0,
});
orm()
  .insert(services)
  .values([
    station(1, "でんぱテレビ"),
    station(2, "でんぱテレビ"),
    station(3, "BSでんぱ"),
  ])
  .run();
const now = Date.now();
for (const [id, service] of [
  [10, 1],
  [11, 2],
  [12, 3],
] as const)
  orm()
    .insert(recordings)
    .values({
      id,
      service_id: service,
      name: "番組",
      start_at: now,
      end_at: now + 600_000,
      created_at: now,
      updated_at: now,
    })
    .run();

/**
 * 60 秒の材料 (10 コマ/秒)。3 秒ずつの場面にハッシュ `hashes` (上の 32 ビットだけ)。
 * `bare` の秒 (ロゴの無い所) の外はロゴが出ている
 */
function material(hashes: number[], bare: [number, number]): CmMaterial {
  const fps = 10;
  const times = Float64Array.from({ length: 600 }, (_, i) => i / fps);
  const count = hashes.length;
  return {
    offset: 0,
    duration: 60,
    fps,
    silences: [],
    times,
    cuts: new Float32Array(600),
    logo: {
      spans: [
        { start: 0, end: bare[0] * fps - 1 },
        { start: bare[1] * fps, end: 599 },
      ],
      scores: new Float32Array(600),
    },
    why: "",
    look: {
      shots: {
        start: Uint32Array.from({ length: count }, (_, k) => k * 30),
        hi: Uint32Array.from(hashes),
        lo: new Uint32Array(count),
        contrast: new Uint8Array(count).fill(40),
      },
      tone: new Uint8Array(60 * 4),
    },
  };
}

// 場面ごとに離れたハッシュ (違うビットが多い)
const H = Array.from(
  { length: 20 },
  (_, k) => Math.imul(k + 1, 0x9e3779b1) >>> 0,
);

test("ロゴの無かった場面だけを書く", () => {
  saveShots(12, material(H.slice(0, 20), [30, 45]));
  const rows = orm().select().from(cmShots).all();
  expect(rows.map((r) => r.seq)).toEqual([10, 11, 12, 13, 14]);
  expect(rows[0]!.hash_hi).toBe(H[10]!);
  expect(rows[0]!.length).toBeCloseTo(3, 5);
});

test("ほかの局の録画でロゴ無しで流れた場面だけを返す。同じ映像の局 (サブチャンネルの枠) の録画とは照らさない", () => {
  // 録画 11 は録画 10 と同じ映像の局。そこで流れた場面 (H[2]・H[3]) は数えない
  saveShots(11, material([0, 0, H[2]!, H[3]!, 0], [6, 12]));
  const mine = material(
    [H[0]!, H[11]!, H[12]!, H[2]!, H[3]!, H[19]!, H[13]!, H[16]!, H[17]!],
    [0, 60],
  );
  expect(repeatedFor(10, 1, mine)).toEqual([{ start: 3, end: 9 }]);
});

test("縮めたコマの無い材料は照らさず、書き直すと前のものは消える", () => {
  expect(repeatedFor(10, 1, { ...material([], [0, 0]), look: null })).toEqual(
    [],
  );
  saveShots(12, { ...material([], [0, 0]), look: null });
  expect(
    orm()
      .select()
      .from(cmShots)
      .all()
      .map((r) => r.recording_id),
  ).toEqual([11, 11]);
  forgetShots([11]);
  expect(orm().select().from(cmShots).all()).toEqual([]);
});
