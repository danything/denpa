import { SKY_TEST } from "../fake/services";
import { expect, goto, syncEpg, test } from "./helpers";

/**
 * スカパー！プレミアム (種別 SKY。J.83B) の受信の設定とスキャン。
 *
 * **SKY を受けられるのは、エージェントが直に持つ IT930x の機材 (`it930x:`) だけ。** 偽エージェントもその機材にだけ
 * `receivable` に SKY を返す。既定のチューナーには無いので、このファイルの間だけ 1 台足す。
 * SKY の局はスクランブルを復号できないので、受信の設定の「受信できるチャンネル」にだけ出て、ライブには出ない
 */

/** 偽エージェントの既定のチューナー (`tests/fake/agent.ts` の `plugged`) */
const DEFAULT_TUNERS = [0, 1, 2, 3].map((index) => ({
  name: `adapter${index}`,
  types: index % 2 === 0 ? ["BS", "CS"] : ["GR"],
  device: `/dev/dvb/adapter${index}/frontend0`,
  disabled: false,
}));

/** SKY を受けられる機材の受信機。初めは地上波だけを選んである */
const MLT = {
  name: "PX-MLT5U",
  types: ["GR"],
  device: "it930x:1-1:0",
  disabled: false,
};

test.describe("スカパー！プレミアム", () => {
  test.beforeAll(async ({ request, stack }) => {
    await request.put(`${stack.agentUrl}/denpa/tuners`, {
      data: { tuners: [...DEFAULT_TUNERS, MLT] },
    });
  });

  /*
   * 偽エージェントはワーカーに 1 つで、spec をまたいで共有している。足した機材と SKY のチャンネルを残すと、
   * 後のファイルのチューナーと局の数がずれる
   */
  test.afterAll(async ({ request, stack }) => {
    await request.put(`${stack.agentUrl}/denpa/tuners`, {
      data: { tuners: DEFAULT_TUNERS },
    });
    await request.post(`${stack.agentUrl}/__control/channels`);
    await syncEpg(request);
  });

  test("受けられる機材があるときだけ、受信できる種別にスカパー！プレミアムが出て選べる", async ({
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
    await expect(tuners.locator('input[name="type.0.SKY"]')).toBeDisabled();
    const sky = tuners.locator('input[name="type.4.SKY"]');
    await expect(sky).toBeEnabled();
    await expect(sky).not.toBeChecked();
    // 足す欄は機材が分からないので、SKY を並べない
    await tuners.getByTestId("tuner-add-open").click();
    await expect(
      tuners.getByTestId("tuner-add").locator('input[name="type.add.GR"]'),
    ).toBeVisible();
    await expect(
      tuners.getByTestId("tuner-add").locator('input[name="type.add.SKY"]'),
    ).toHaveCount(0);

    // SKY を選んだチューナーが無いうちは、スキャンの選び方に出さない
    const select = page
      .getByTestId("channel-section")
      .getByLabel("スキャンする種別");
    await expect(
      select.locator("option", { hasText: "スカパー！プレミアム" }),
    ).toHaveCount(0);

    await sky.check();
    await expect(tuners.getByTestId("saved-result")).toBeVisible();
    await expect
      .poll(async () => {
        const res = await request.get(`${stack.agentUrl}/denpa/tuners`);
        const { tuners: list } = (await res.json()) as {
          tuners: { device: string | null; types: string[] }[];
        };
        return list.find((tuner) => tuner.device === MLT.device)?.types;
      })
      .toEqual(["GR", "SKY"]);
    await expect(
      select.locator("option", { hasText: "スカパー！プレミアム" }),
    ).toHaveCount(1);
  });

  test("SKY をスキャンすると H01〜H105 を回し、局は受信できるチャンネルにだけ出て、ライブでは断る", async ({
    page,
    request,
  }) => {
    await goto(page, "/settings/reception");

    const card = page.getByTestId("channel-section");
    await card.getByLabel("スキャンする種別").selectOption("SKY");
    await card.getByTestId("scan-start").click();
    await expect(card.getByTestId("scan-state")).toHaveText("完了", {
      timeout: 90_000,
    });
    await expect(card.getByTestId("scan-count")).toContainText("105 / 105");
    await expect(card.getByTestId("scan-found")).toContainText("1");

    // 受信できるチャンネルには出し、番組表とライブに出ないわけを添える (取り込み直した表を読み直す)
    await goto(page, "/settings/reception");
    await expect(
      card.locator(`[data-testid="channel-row"][data-channel="H40"]`),
    ).toContainText(SKY_TEST.name);
    await expect(card.getByTestId("undecodable-note")).toContainText(
      "スクランブルを復号できないため",
    );
    // スキャンで分かったこと (CA_system_id。偽の放送は B-CAS 以外の作り物の値を置いている) をチャンネルの行の下に出す
    const observed = card.locator(
      `[data-testid="ca-observed"][data-channel="H40"]`,
    );
    await expect(observed).toContainText("CA_system_id 0x000B (B-CAS 以外)");
    await expect(observed).toContainText("番組表");
    // ほかの種別のチャンネルには出さない
    await expect(card.getByTestId("ca-observed")).toHaveCount(1);

    // 局の一覧には入るが、ライブの一覧には出ない (`airing` が false)。ライブは選局せずに断る
    const services = (await (await request.get("/api/services")).json()) as {
      id: number;
      type: string;
      airing: boolean;
    }[];
    const found = services.find((service) => service.id === SKY_TEST.id);
    expect(found?.type).toBe("SKY");
    expect(found?.airing).toBe(false);
    const live = await request.get(`/api/services/${SKY_TEST.id}/live`, {
      headers: { accept: "application/json" },
    });
    expect(live.status()).toBe(409);
    expect((await live.json()).message).toContain(
      "スクランブルを復号できないため観られません",
    );

    await goto(page, "/live");
    await expect(page.getByText(SKY_TEST.name)).toHaveCount(0);
  });
});
