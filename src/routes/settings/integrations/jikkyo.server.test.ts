import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { config } = await import("#lib/server/config.js");
config.dbPath = join(
  mkdtempSync(join(tmpdir(), "denpa-jikkyo-form-")),
  "denpa.db",
);
const { niconicoLive } = await import("#lib/server/niconico-live.js");
const { jikkyoLive } = await import("#lib/server/jikkyo-live.js");
const { settings } = await import("#lib/server/settings.js");
const { actions } = await import("./jikkyo.server");

/** 設定の「実況」の保存の本文 */
function save(form: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(form)) body.set(key, value);
  const request = new Request("http://denpa.local/settings/integrations", {
    method: "POST",
    body,
  });
  return actions.saveJikkyo({ request } as Parameters<
    typeof actions.saveJikkyo
  >[0]);
}

describe("設定の「実況」の保存", () => {
  afterEach(() => mock.restore());

  test("オフにしたら、hub への購読と公式の実況への接続を閉じる", async () => {
    const closeAll = spyOn(niconicoLive, "closeAll");
    const closeHub = spyOn(jikkyoLive, "closeAll");
    await save({ jikkyoNg: "" });
    expect(settings().jikkyo).toBe(false);
    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(closeHub).toHaveBeenCalledTimes(1);
  });

  test("オンのままなら閉じない", async () => {
    const closeAll = spyOn(niconicoLive, "closeAll");
    const closeHub = spyOn(jikkyoLive, "closeAll");
    await save({ jikkyo: "on", jikkyoNg: "" });
    expect(settings().jikkyo).toBe(true);
    expect(closeAll).not.toHaveBeenCalled();
    expect(closeHub).not.toHaveBeenCalled();
  });
});
