import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * **外から使う録画の一覧** (`GET /api/recordings`。docs/api.md)。
 *
 * ここでは元の TS の `codec` を押さえる。映像の無い局 (サービス種別が 1 以外。`types.hasVideo`) の録画は `none`、
 * 局が分からない録画は今までどおり `mpeg2`。名前と型は E2E (`30-api`) が押さえる
 */
const { config } = await import("./config");
config.dbPath = join(
  mkdtempSync(join(tmpdir(), "denpa-recordings-api-")),
  "denpa.db",
);
config.dataDir = dirname(config.dbPath);

const { orm } = await import("./db");
const { recordings, services } = await import("./schema");
const { GET } = await import("../../routes/api/recordings/+server");

const TV = 1;
const RADIO = 2;
/** services に無い局 (消えた局の録画) */
const GONE = 3;

orm()
  .insert(services)
  .values([
    {
      id: TV,
      service_id: 1032,
      network_id: 32_736,
      name: "でんぱテレビ",
      type: "GR",
      service_type: 1,
      updated_at: 0,
    },
    {
      id: RADIO,
      service_id: 1033,
      network_id: 32_736,
      name: "でんぱラジオ",
      type: "GR",
      service_type: 2,
      updated_at: 0,
    },
  ])
  .run();

for (const serviceId of [TV, RADIO, GONE])
  orm()
    .insert(recordings)
    .values({
      service_id: serviceId,
      name: `録画${serviceId}`,
      start_at: serviceId * 1_000,
      end_at: serviceId * 1_000 + 500,
      ts_path: `/recorded/${serviceId}.m2ts`,
      finished_at: serviceId * 1_000 + 500,
      created_at: 0,
      updated_at: 0,
    })
    .run();

/** 局ごとの、元の TS の `codec` */
async function tsCodecs(): Promise<Map<number, string>> {
  const response = await GET({
    url: new URL("http://denpa.test/api/recordings"),
  } as Parameters<typeof GET>[0]);
  const rows = (await response.json()) as {
    serviceId: number;
    files: { source: string; codec: string }[];
  }[];
  return new Map(
    rows.map((row) => [
      row.serviceId,
      row.files.find((file) => file.source === "ts")!.codec,
    ]),
  );
}

describe("録画の一覧の元の TS", () => {
  test("映像の無い局の録画は none、映像のある局は mpeg2", async () => {
    const codecs = await tsCodecs();
    expect(codecs.get(RADIO)).toBe("none");
    expect(codecs.get(TV)).toBe("mpeg2");
  });

  test("局が分からなければ mpeg2", async () => {
    expect((await tsCodecs()).get(GONE)).toBe("mpeg2");
  });
});
