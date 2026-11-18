import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "./config";

const dir = mkdtempSync(join(tmpdir(), "denpa-agent-faults-"));
const original = config.dbPath;
config.dbPath = join(dir, "denpa.db");

const { orm } = await import("./db");
const { agentFaults } = await import("./schema");
const { AGENT_FAULT_DAYS, AGENT_FAULT_KEEP, recordAgentFault } =
  await import("./agent-faults");

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 18, 0);

const fault = (at: number, text = "[PLEX PX-MLT8PE 3-1] 溢れました") => ({
  at,
  text,
  context: [{ at: at - 1000, text: "[agent] CATV QU31 (epg QU31): 選局" }],
});

function rows() {
  return orm().select().from(agentFaults).orderBy(agentFaults.at).all();
}

afterAll(() => {
  config.dbPath = original;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  orm().delete(agentFaults).run();
});

describe("エージェントが知らせた機材の異常", () => {
  test("行と直前の記録を残す", () => {
    expect(recordAgentFault(1, "main", fault(NOW - 5000), NOW)).toBe(true);
    const [row] = rows();
    expect(row?.agent_id).toBe(1);
    expect(row?.at).toBe(NOW - 5000);
    expect(row?.text).toBe("[PLEX PX-MLT8PE 3-1] 溢れました");
    expect(JSON.parse(row?.context ?? "")).toEqual([
      { at: NOW - 6000, text: "[agent] CATV QU31 (epg QU31): 選局" },
    ]);
  });

  test("繋ぎ直して送り直された同じ行は重ねない", () => {
    expect(recordAgentFault(1, "main", fault(NOW - 5000), NOW)).toBe(true);
    expect(recordAgentFault(1, "main", fault(NOW - 5000), NOW)).toBe(false);
    // 別のエージェントの同じ時刻・同じ文は別の行
    expect(recordAgentFault(2, "sub", fault(NOW - 5000), NOW)).toBe(true);
    expect(rows()).toHaveLength(2);
  });

  test("形が違えば残さず、前の記録の形が違うものは捨てて行だけ残す", () => {
    expect(recordAgentFault(1, "main", null, NOW)).toBe(false);
    expect(recordAgentFault(1, "main", { at: "x", text: "a" }, NOW)).toBe(
      false,
    );
    expect(recordAgentFault(1, "main", { at: NOW, text: "" }, NOW)).toBe(false);
    expect(
      recordAgentFault(
        1,
        "main",
        { at: NOW, text: "溢れました", context: [{ at: "x" }, 3] },
        NOW,
      ),
    ).toBe(true);
    expect(rows().map((row) => row.context)).toEqual(["[]"]);
  });

  test("古い行と、上限を越えた行を消す", () => {
    // 期限より古い行は入れない (繋ぎ直すたびに送り直される)
    expect(
      recordAgentFault(
        1,
        "main",
        fault(NOW - (AGENT_FAULT_DAYS + 1) * DAY),
        NOW,
      ),
    ).toBe(false);
    for (let i = 0; i < AGENT_FAULT_KEEP + 3; i++)
      recordAgentFault(1, "main", fault(NOW - 1_000_000 + i), NOW);
    const kept = rows();
    expect(kept).toHaveLength(AGENT_FAULT_KEEP);
    expect(kept[0]?.at).toBe(NOW - 1_000_000 + 3);
  });
});
