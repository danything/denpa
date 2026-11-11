import {
  CATV_4K,
  CATV_BS,
  CATV_GR,
  CATV_LOCKED,
  CATV_OWN,
} from "../fake/services";
import { expect, goto, syncEpg, test } from "./helpers";

/**
 * ケーブル (種別 CATV。ISDB-C) の受信の設定・スキャン・番組表・ライブ。
 *
 * **CATV を受けられるのは、エージェントが直に持つ IT930x の機材 (`it930x:`) だけ。** 偽エージェントもその機材にだけ
 * `receivable` に CATV を返す。既定のチューナーには無いので、このファイルの間だけ 1 台足す。
 * 偽の放送の搬送波は 4 つ (`tests/fake/services.ts`): BS の再送信 (QC20)、BS4K の再送信 (QC26。TLV)、TSMF で 2 つの TS を束ねたもの
 * (QC30。地上波の再送信と自主放送)、B-CAS 以外の CA_system_id だけでスクランブルした局 (QC40。番組表もスクランブルしている)。
 * 復号できない局はライブに出ない。番組表を読める局 (4K の局) は、番組表に「観られません」の列で出る
 */

/** 偽エージェントの既定のチューナー (`tests/fake/agent.ts` の `plugged`) */
const DEFAULT_TUNERS = [0, 1, 2, 3].map((index) => ({
  name: `adapter${index}`,
  types: index % 2 === 0 ? ["BS", "CS"] : ["GR"],
  device: `/dev/dvb/adapter${index}/frontend0`,
  disabled: false,
}));

/** CATV を受けられる機材の受信機。初めは地上波だけを選んである */
const MLT = {
  name: "PX-MLT5U",
  types: ["GR"],
  device: "it930x:1-1:0",
  disabled: false,
};

test.describe("ケーブル", () => {
  test.beforeAll(async ({ request, stack }) => {
    await request.put(`${stack.agentUrl}/denpa/tuners`, {
      data: { tuners: [...DEFAULT_TUNERS, MLT] },
    });
  });

  /*
   * 偽エージェントはワーカーに 1 つで、spec をまたいで共有している。足した機材と CATV のチャンネルを残すと、
   * 後のファイルのチューナーと局の数がずれる
   */
  test.afterAll(async ({ request, stack }) => {
    await request.put(`${stack.agentUrl}/denpa/tuners`, {
      data: { tuners: DEFAULT_TUNERS },
    });
    await request.post(`${stack.agentUrl}/__control/channels`);
    await syncEpg(request);
  });

  test("受けられる機材でだけケーブルを選べ、選ぶとスキャンの選び方と「すべて」に入る", async ({
    page,
    request,
    stack,
  }) => {
    await syncEpg(request);
    await goto(page, "/settings/reception");

    const tuners = page.getByTestId("tuner-section");
    await expect(
      tuners.getByTestId("tuner-list").getByTestId("tuner-row"),
    ).toHaveCount(5);
    // 受けられない機材 (adapter0) では選べず、IT930x の機材では選べる
    await expect(tuners.locator('input[name="type.0.CATV"]')).toBeDisabled();
    const catv = tuners.locator('input[name="type.4.CATV"]');
    await expect(catv).toBeEnabled();
    await expect(catv).not.toBeChecked();

    // CATV を選んだチューナーが無いうちは、スキャンの選び方に出さない
    const select = page
      .getByTestId("channel-section")
      .getByLabel("スキャンする種別");
    await expect(select.locator("option", { hasText: "ケーブル" })).toHaveCount(
      0,
    );
    await expect(select.locator("option").first()).toHaveAttribute(
      "value",
      "GR,BS,CS",
    );

    await catv.check();
    await expect(tuners.getByTestId("saved-result")).toBeVisible();
    await expect
      .poll(async () => {
        const res = await request.get(`${stack.agentUrl}/denpa/tuners`);
        const { tuners: list } = (await res.json()) as {
          tuners: { device: string | null; types: string[] }[];
        };
        return list.find((tuner) => tuner.device === MLT.device)?.types;
      })
      .toEqual(["GR", "CATV"]);
    await expect(select.locator("option", { hasText: "ケーブル" })).toHaveCount(
      1,
    );
    // 「すべて」にも入る (SKY と同じ)
    await expect(select.locator("option").first()).toHaveAttribute(
      "value",
      "GR,BS,CS,CATV",
    );
  });

  test("CATV をスキャンすると TSMF の 2 つ目の TS も回し、元の放送と復号できない局を受信できるチャンネルに出す", async ({
    page,
  }) => {
    await goto(page, "/settings/reception");

    const card = page.getByTestId("channel-section");
    await card.getByLabel("スキャンする種別").selectOption("CATV");
    await card.getByTestId("scan-start").click();
    await expect(card.getByTestId("scan-state")).toHaveText("完了", {
      timeout: 90_000,
    });
    // QC13〜QV12 の 113 チャンネルと、TSMF で束ねた 2 つ目の TS (QC30:1)
    await expect(card.getByTestId("scan-count")).toContainText("114 / 114");
    await expect(card.getByTestId("scan-found")).toContainText("5");

    // 取り込み直した表を読み直す
    await goto(page, "/settings/reception");
    const row = (channel: string) =>
      card.locator(`[data-testid="channel-row"][data-channel="${channel}"]`);
    await expect(row("QC20")).toContainText(CATV_BS.name);
    await expect(row("QC20").getByTestId("channel-origin")).toHaveText(
      "BS の再送信",
    );
    await expect(row("QC30")).toContainText(CATV_GR.name);
    await expect(row("QC30").getByTestId("channel-origin")).toHaveText(
      "地上波の再送信",
    );
    // 自主放送には元の放送を出さない
    await expect(row("QC30:1")).toContainText(CATV_OWN.name);
    await expect(row("QC30:1").getByTestId("channel-origin")).toHaveCount(0);

    // 復号できない局は印と、ライブと録画に使えないわけを添える
    await expect(row("QC40")).toContainText(CATV_LOCKED.name);
    await expect(row("QC40").getByTestId("service-undecodable")).toHaveText(
      "復号できません",
    );
    // 4K の局 (TLV) は、元の放送が BS4K で、まだ復号できない (CA_system_id が B-CAS と同じ 0x0005 でも ACAS が要る)
    await expect(row("QC26")).toContainText(CATV_4K.name);
    await expect(row("QC26").getByTestId("channel-origin")).toHaveText(
      "BS4K の再送信",
    );
    await expect(row("QC26").getByTestId("service-undecodable")).toHaveText(
      "復号できません",
    );
    await expect(card.getByTestId("service-undecodable")).toHaveCount(2);
    const note = card.getByTestId("undecodable-note");
    await expect(note).toContainText(
      "B-CAS 以外の方式でスクランブルされているため",
    );
    await expect(note).toContainText(
      "ケーブルの 4K の局は、まだライブと録画に対応していません",
    );
    await expect(note).toContainText(
      "番組表を読める局は、番組表に「観られません」の列で出します",
    );
    // スキャンで分かったこと (CA_system_id) を、チャンネルの行の下に出す
    await expect(
      card.locator(`[data-testid="ca-observed"][data-channel="QC40"]`),
    ).toContainText("CA_system_id 0x0006 (B-CAS 以外)");
    await expect(
      card.locator(`[data-testid="ca-observed"][data-channel="QC20"]`),
    ).toContainText("CA 記述子なし");
  });

  test("復号できる局は番組表の「ケーブル」とライブに出て観られ、復号できない局は出ず、ライブでは断る", async ({
    page,
    request,
    stack,
  }) => {
    await syncEpg(request);

    // 番組表は、ケーブルの局があるときだけタブを足す
    await goto(page, "/guide");
    const tab = page.getByTestId("type-CATV");
    await expect(tab).toHaveText("ケーブル");
    await tab.click();
    await expect(page).toHaveURL(/type=CATV/);
    const grid = page.getByTestId("guide-grid");
    await expect(grid).toContainText(CATV_GR.name);
    await expect(grid).toContainText(CATV_BS.name);
    // 番組表がスクランブルされている局 (QC40) は出さない
    await expect(grid).not.toContainText(CATV_LOCKED.name);
    // 4K の局は番組表を読めるので、局名の下に「観られません」を添えて出す。局名はライブへのリンクにしない
    const head4k = grid
      .getByTestId("guide-service")
      .filter({ hasText: CATV_4K.name });
    await expect(head4k.getByTestId("guide-service-unwatchable")).toHaveText(
      "観られません",
    );
    await expect(head4k.getByTestId("guide-service-live")).toHaveCount(0);
    await expect(grid.getByTestId("guide-service-unwatchable")).toHaveCount(1);

    // 局の一覧には入るが、復号できない局はライブの一覧に出ない (`airing` が false)。ライブは選局せずに断る
    const services = (await (await request.get("/api/services")).json()) as {
      id: number;
      type: string;
      airing: boolean;
    }[];
    const locked = services.find((service) => service.id === CATV_LOCKED.id);
    expect(locked?.type).toBe("CATV");
    expect(locked?.airing).toBe(false);
    expect(services.find((s) => s.id === CATV_GR.id)?.airing).toBe(true);
    const refused = await request.get(`/api/services/${CATV_LOCKED.id}/live`, {
      headers: { accept: "application/json" },
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).message).toContain(
      "B-CAS 以外の方式でスクランブルされた局のため",
    );

    // ライブのタブにも「ケーブル」が出て、選ぶとその局を選局する
    await goto(page, "/live");
    await page.getByTestId("live-type-CATV").click();
    await expect(
      page.locator(
        `[data-testid=live-channel][data-service="${CATV_LOCKED.id}"]`,
      ),
    ).toHaveCount(0);
    await page
      .locator(`[data-testid=live-channel][data-service="${CATV_GR.id}"]`)
      .click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await expect
      .poll(async () => {
        const res = await request.get(`${stack.agentUrl}/__control/opens`);
        const { opens } = (await res.json()) as {
          opens: { use: string; type: string; channel: string }[];
        };
        return opens.some(
          (open) =>
            open.use.startsWith("live ") &&
            open.type === "CATV" &&
            open.channel === CATV_GR.channel,
        );
      })
      .toBe(true);
  });

  test("4K の局の番組は、詳細で予約とライブの代わりにわけを出し、予約を断る", async ({
    page,
    request,
  }) => {
    await syncEpg(request);
    await goto(page, "/guide?type=CATV");
    const cells = page
      .getByTestId("guide-grid")
      .locator(`[data-testid=grid-program][data-service-id="${CATV_4K.id}"]`);
    await expect(cells.first()).toBeAttached();
    // マスは少しずつ描くので、描き終わるのを待ってから探す
    await expect(page.getByTestId("guide-grid")).not.toHaveAttribute(
      "data-drawing",
      "",
    );
    // これから始まる番組を開く (始まった番組には、どの局でも予約のボタンが出ない)
    const later = await cells.evaluateAll((nodes) =>
      nodes.findIndex(
        (node) =>
          Number((node as HTMLElement).dataset["startAt"]) >
          Date.now() + 60_000,
      ),
    );
    expect(later).toBeGreaterThanOrEqual(0);
    const cell = cells.nth(later);
    const programId = Number(await cell.getAttribute("data-program-id"));
    await cell.getByTestId("program-button").click();
    await expect(page.getByTestId("detail-unwatchable")).toHaveText(
      "ケーブルの 4K の局は、まだライブと録画に対応していないため観られません",
    );
    await expect(page.getByTestId("detail-reserve")).toHaveCount(0);
    await expect(page.getByTestId("detail-watch")).toHaveCount(0);

    // 外から使う API の予約も、同じわけで断る (`reservations.reserve`)
    const refused = await request.post(`/api/programs/${programId}/record`, {
      headers: { accept: "application/json" },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).message).toContain(
      "ケーブルの 4K の局は、まだライブと録画に対応していないため観られません",
    );

    // ライブも選局せずに断る
    const live = await request.get(`/api/services/${CATV_4K.id}/live`, {
      headers: { accept: "application/json" },
    });
    expect(live.status()).toBe(409);
  });

  test("ケーブルを受けられるチューナーが無くなったら、ケーブルの局を 2 回押しで消せる", async ({
    page,
    request,
    stack,
  }) => {
    await syncEpg(request);
    // 受けられる機材があるうちは、スキャンし直せば入れ替わるので出さない
    await goto(page, "/settings/reception");
    await expect(page.getByTestId("channel-list")).toContainText(CATV_GR.name);
    await expect(page.getByTestId("orphan-type")).toHaveCount(0);

    // 機材を外す (引っ越してケーブルが無くなった)。スキャンの選び方から「ケーブル」が消え、表の上に削除が出る
    await request.put(`${stack.agentUrl}/denpa/tuners`, {
      data: { tuners: DEFAULT_TUNERS },
    });
    await goto(page, "/settings/reception");
    await expect(
      page.locator('select[name="types"] option', { hasText: "ケーブル" }),
    ).toHaveCount(0);
    const orphan = page.getByTestId("orphan-type");
    await expect(orphan).toHaveCount(1);
    await orphan.getByTestId("remove-type-CATV").click();
    await orphan.getByTestId("remove-type-CATV-confirm").click();

    await expect(page.getByTestId("orphan-type")).toHaveCount(0);
    await expect(page.getByTestId("channel-list")).not.toContainText(
      CATV_GR.name,
    );
    const channels = (await (
      await request.get(`${stack.agentUrl}/denpa/channels`)
    ).json()) as { type: string }[];
    expect(channels.some((channel) => channel.type === "CATV")).toBe(false);
    expect(channels.some((channel) => channel.type === "GR")).toBe(true);
  });
});
