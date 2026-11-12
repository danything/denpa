import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { listAgents } from "./agents";
import { config } from "./config";
import { markRemoved, removedSatellites } from "./satellite-lineup";
import { store } from "./settings";

const realAgent = config.agentUrl;
const realDb = config.dbPath;
const dir = mkdtempSync(`${tmpdir()}/satellite-removed-`);
config.dbPath = `${dir}/denpa.db`;
config.agentUrl = "https://a:1#pair=x,https://b:2#pair=y";
afterAll(() => {
  config.agentUrl = realAgent;
  config.dbPath = realDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("設定から消した衛星の種別", () => {
  test("消したエージェントにだけ入れ直さず、そのエージェントでスキャンすれば戻る", () => {
    const [a, b] = listAgents().map((agent) => agent.id);
    markRemoved(["BS"], true, [a!]);
    expect(removedSatellites(a!)).toEqual(["BS"]);
    expect(removedSatellites(b!)).toEqual([]);
    markRemoved(["BS"], false, [b!]);
    expect(removedSatellites(a!)).toEqual(["BS"]);
    markRemoved(["BS"], false, [a!]);
    expect(removedSatellites(a!)).toEqual([]);
  });

  test("前のバージョンの控え (種別だけ) は全部のエージェントで消したもの。スキャンしたエージェントのぶんだけ戻す", () => {
    const [a, b] = listAgents().map((agent) => agent.id);
    store("removedSatellites", JSON.stringify(["CS"]));
    expect(removedSatellites(a!)).toEqual(["CS"]);
    expect(removedSatellites(b!)).toEqual(["CS"]);
    markRemoved(["CS"], false, [a!]);
    expect(removedSatellites(a!)).toEqual([]);
    expect(removedSatellites(b!)).toEqual(["CS"]);
  });
});
