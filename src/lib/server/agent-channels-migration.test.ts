import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

/**
 * **チャンネルをエージェントごとに持つ** (`0039_agent-channels`)。`services.channel` を消し、`agent_channels` と
 * `services.transport_stream_id` を足し、`channel_reception` にエージェントを足す。
 *
 * 本番は main の開発ビルドを使っているので、上げる前の DB (エージェント 1 台、チャンネル・局・予約・録画が入っている) を
 * 作り、本物の手順 (`bootstrap`) で上げて、局・予約・録画が変わらないことと、最初の取り込みで局から元のチャンネルが引けることを確かめる
 */
const { config } = await import("./config");
const dir = mkdtempSync(join(tmpdir(), "denpa-agent-channels-migration-"));
config.dbPath = join(dir, "denpa.db");
config.dataDir = dir;

const { MIGRATIONS } = await import("./db");
const { parseAgentUrl } = await import("./agents");

/** `before` より前のマイグレーションだけの置き場 (journal を切り詰めるだけ。SQL は同じもの) */
function migrationsBefore(before: string): string {
  const old = mkdtempSync(join(tmpdir(), "denpa-migrations-"));
  cpSync(MIGRATIONS, old, { recursive: true });
  const journal = JSON.parse(
    readFileSync(join(old, "meta/_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.filter(
    (entry: { tag: string }) => entry.tag < before,
  );
  writeFileSync(join(old, "meta/_journal.json"), JSON.stringify(journal));
  return old;
}

/** 上げる前の局。地上波 2 局 (同じチャンネルの本チャンネルとサブチャンネル) と BS 1 局 */
const SERVICES = [
  {
    id: 3_273_601_024,
    sid: 1024,
    network: 32_736,
    type: "GR",
    channel: "T27",
    ts: 32_736,
  },
  {
    id: 3_273_601_025,
    sid: 1025,
    network: 32_736,
    type: "GR",
    channel: "T27",
    ts: 32_736,
  },
  {
    id: 400_151,
    sid: 151,
    network: 4,
    type: "BS",
    channel: "BS01:16400",
    ts: 16_400,
  },
] as const;

/** 上げる前の DB を作る。0038 (エージェントの行) までを当て、本番と同じ形の行を入れる */
function seedBefore(db: Database, origin: string): void {
  migrate(drizzle({ client: db }), {
    migrationsFolder: migrationsBefore("0039"),
  });
  db.run(
    `INSERT INTO agents (name, origin, cert, fingerprint, from_env, position, added_at)
       VALUES ('tuner-agent', ?, '-----BEGIN CERTIFICATE-----', 'ab12', 1, 0, 1)`,
    [origin],
  );
  const service = db.prepare(
    `INSERT INTO services (id, service_id, network_id, name, type, service_type, channel, remote_control_key,
       has_logo, decodable, epg_readable, transport, listed, updated_at, epg_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, 1, 1, 1, 1, 'ts', 1, 1000, 2000)`,
  );
  for (const s of SERVICES)
    service.run(s.id, s.sid, s.network, `局${s.sid}`, s.type, s.channel);
  db.run(
    `INSERT INTO reservations (id, program_id, service_id, name, start_at, end_at, created_at, updated_at)
       VALUES (1, 11, ?, '予約', 5000, 6000, 10, 10), (2, 12, ?, '衛星の予約', 7000, 8000, 10, 10)`,
    [SERVICES[0].id, SERVICES[2].id],
  );
  db.run(
    `INSERT INTO recordings (id, program_id, service_id, service_name, name, start_at, end_at, created_at, updated_at)
       VALUES (1, 21, ?, '局1024', '録画', 100, 200, 10, 10), (2, 22, ?, '局151', '衛星の録画', 300, 400, 10, 10)`,
    [SERVICES[0].id, SERVICES[2].id],
  );
  db.run(
    `INSERT INTO channel_reception (type, channel, ok_at, failed_at, failing_since, failures, unreceivable)
       VALUES ('BS', 'BS01:16400', 100, NULL, NULL, 0, 0), ('BS', 'BS03:16432', NULL, 300, 200, 2, 1)`,
  );
}

const rows = (db: Database, table: string) =>
  db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<
    string,
    unknown
  >[];

describe("0039_agent-channels", () => {
  test("局・予約・録画は変わらない。局の物理チャンネルは消え、TS は取り込むまで null", async () => {
    const db = new Database(config.dbPath);
    seedBefore(db, "https://tuner-agent:25252");
    const before = {
      services: rows(db, "services"),
      reservations: rows(db, "reservations"),
      recordings: rows(db, "recordings"),
    };
    db.close();

    // 本物の手順で上げる (`orm()` が開くときに `bootstrap` を通す)
    const { orm } = await import("./db");
    const { agents, channelReception } = await import("./schema");
    const agent = orm().select().from(agents).get()!;
    const after = new Database(config.dbPath);
    expect(rows(after, "reservations")).toEqual(before.reservations);
    expect(rows(after, "recordings")).toEqual(before.recordings);
    expect(rows(after, "services")).toEqual(
      before.services.map((row) => ({
        ...Object.fromEntries(
          Object.entries(row).filter(([column]) => column !== "channel"),
        ),
        transport_stream_id: null,
      })),
    );
    after.close();

    // 受信の記録は、並びの先頭のエージェントのものになる (受信できないと決めたものもそのまま)
    expect(
      orm()
        .select()
        .from(channelReception)
        .all()
        .map((row) => [row.agent_id, row.channel, row.unreceivable]),
    ).toEqual([
      [agent.id, "BS01:16400", false],
      [agent.id, "BS03:16432", true],
    ]);

    // 最初の取り込みで、局から上げる前と同じチャンネルが引け、局の一覧も変わらない
    const { syncServices, currentServices } = await import("./epg");
    const { channelOfService } = await import("./agent-channels");
    const { services } = await import("./schema");
    syncServices([
      {
        agent: agent.id,
        channels: [
          {
            type: "GR",
            channel: "T27",
            networkId: 32_736,
            transportStreamId: 32_736,
            remoteControlKeyId: 1,
            services: [
              { serviceId: 1024, serviceType: 1, name: "局1024" },
              { serviceId: 1025, serviceType: 1, name: "局1025" },
            ],
          },
          {
            type: "BS",
            channel: "BS01:16400",
            networkId: 4,
            transportStreamId: 16_400,
            remoteControlKeyId: 1,
            services: [{ serviceId: 151, serviceType: 1, name: "局151" }],
          },
        ],
      },
    ]);
    for (const s of SERVICES) expect(channelOfService(s.id)).toBe(s.channel);
    expect(
      orm()
        .select({ id: services.id })
        .from(services)
        .where(currentServices())
        .all()
        .map((row) => row.id)
        .sort(),
    ).toEqual(SERVICES.map((s) => s.id).sort());
  });

  test("エージェントの行のホスト名を、今の突き合わせと同じ形にする", () => {
    for (const written of [
      "https://Tuner-Agent:25252",
      "https://TUNER.example:443",
      "HTTPS://Tuner.Example:25252/Agent",
      "https://Tuner.Example:443/Agent",
      "https://[::1]:443",
    ]) {
      const db = new Database(":memory:");
      seedBefore(db, written);
      migrate(drizzle({ client: db }), { migrationsFolder: MIGRATIONS });
      const { origin } = db.query("SELECT origin FROM agents").get() as {
        origin: string;
      };
      expect(origin).toBe(parseAgentUrl(written).origin);
      db.close();
    }
  });

  test("エージェントの行がまだ無い (0038 と一緒に上げる) なら、受信の記録は捨てて決め直す", () => {
    const db = new Database(":memory:");
    migrate(drizzle({ client: db }), {
      migrationsFolder: migrationsBefore("0038"),
    });
    db.run(
      `INSERT INTO channel_reception (type, channel, ok_at, failures, unreceivable) VALUES ('BS', 'BS03:16432', NULL, 2, 1)`,
    );
    migrate(drizzle({ client: db }), { migrationsFolder: MIGRATIONS });
    expect(rows(db, "channel_reception")).toEqual([]);
    db.close();
  });
});
