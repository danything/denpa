import type { APIRequestContext } from "@playwright/test";
import { FUJI } from "../fake/services";
import {
  cellOf,
  clearRules,
  expect,
  goto,
  makeRule,
  reserveSoon,
  syncEpg,
  test,
  upcoming,
} from "./helpers";

const REASON = "コピー禁止の番組なので録画しません";

/**
 * **番組表を読み直す。** 偽の放送のつまみを変えたあとに使う。
 *
 * `syncEpg` だけでは、さっき集め終えたチャンネルには行き直さない (`epg-collect.pickChannels`)。
 * 画面の「いますぐ集める」(`/settings/reception?/collectNow`) は全部を回り直すので、それを起こしてから
 * `syncEpg` で待つ (走っている回に合流する)
 */
async function recollect(request: APIRequestContext): Promise<void> {
  const res = await request.post("/settings/reception?/collectNow", {
    form: {},
  });
  expect(res.ok()).toBe(true);
  await syncEpg(request);
}

/**
 * **コピー禁止の番組は録らない** (市販のレコーダーと同じ。docs/data.md「コピー禁止の番組」)。
 *
 * - 番組表 (EIT) が禁止と言えば、予約の時点で止める。手で押せば断り、ルールの予約は「録画しない」と理由を出す
 * - 番組表が古い・無いときは、録り始めてから PMT を見て保存しない
 *
 * 観るのはそのまま (保存しないので)。ここでは見ない
 */
test.describe("コピー禁止の番組", () => {
  test.afterEach(async ({ page, request, stack }) => {
    await request.post(`${stack.agentUrl}/__control/copy-never?eit=&pmt=0`);
    await clearRules(page);
    // 番組表の印を外しておく (同じワーカーのあとのファイルが、予約できない番組を引かないように)
    await recollect(request);
  });

  test("番組表で禁止なら、予約できず、ルールの予約は「録画しない」になって理由が出る", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);
    await request.post(
      `${stack.agentUrl}/__control/copy-never?eit=${FUJI.serviceId}&pmt=0`,
    );
    await recollect(request);

    // 番組表のマスと詳細に、控えめに出る。予約のボタンは出さない
    await goto(page, "/guide?type=GR");
    const target = (await upcoming(page)).find(
      (c) => c.serviceId === String(FUJI.id),
    );
    if (target === undefined)
      throw new Error("フジテレビのこれから始まる番組が無い");
    const cell = cellOf(page, target.programId);
    await expect(cell.getByTestId("grid-copy-never")).toHaveText("コピー禁止");
    await cell.getByTestId("program-button").click();
    await expect(page.getByTestId("detail-copy-never")).toBeVisible();
    await expect(page.getByTestId("detail-reserve")).toHaveCount(0);
    await page.getByTestId("detail-close").click();

    // ライブの録画ボタンと同じ処理 (`recordAiring`)。断って理由を返す
    const recorded = await request.post(`/api/services/${FUJI.id}/record`, {
      headers: { "content-type": "application/json" },
    });
    expect(recorded.status()).toBe(400);
    expect((await recorded.json()).message).toBe(REASON);

    // ルールは予約を立てるが、録らないと決めて理由を残す
    await clearRules(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await makeRule(page, "テストアニメ", { dedupe: false });

    await goto(page, "/");
    const rows = page
      .getByTestId("reservation-row")
      .filter({ hasText: "テストアニメ" })
      .filter({ hasText: "フジテレビ" });
    // いちばん先の予約 (一覧の頭)。線に近いものは放送が終わって消えることがある
    const row = rows.first();
    await expect(row.getByTestId("reservation-state")).toHaveText("録画しない");
    await expect(row).toContainText(REASON);
    // 予約済みのものは1つも無い (録れるように見せない)
    await expect(
      rows.filter({
        has: page.getByTestId("reservation-state").getByText("予約済み"),
      }),
    ).toHaveCount(0);
  });

  test("番組表が言っていなくても、流れているものが禁止なら保存しない", async ({
    page,
    request,
    stack,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);
    // 番組表はそのまま (禁止と言わない)。PMT だけ禁止にする
    await request.post(`${stack.agentUrl}/__control/copy-never?eit=&pmt=1`);

    const programId = await reserveSoon(page, request, "BS");
    const row = page.locator(
      `[data-testid="recording-row"][data-program-id="${programId}"]`,
    );
    await expect(async () => {
      await goto(page, "/");
      await expect(row.getByTestId("recording-state")).toHaveText("失敗", {
        timeout: 1_000,
      });
    }).toPass({ timeout: 120_000, intervals: [500] });

    // 理由は詳細に出る (観られない行は、行そのものが詳細の入口)
    await row.getByTestId("row-open").click();
    await expect(page.getByTestId("detail-error")).toContainText(
      "コピー禁止の番組なので録画しませんでした",
    );
    await page.getByTestId("detail-close").click();
  });
});
