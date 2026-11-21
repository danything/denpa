import type { Page } from "@playwright/test";

import {
  cancelAllReservations,
  expect,
  goto,
  pairToken,
  searchRowStart,
  syncEpg,
  test,
} from "./helpers";

/**
 * **番組ランキングに参加する** (設定の「連携」の「番組ランキング」。`server/ranking.ts`)。
 *
 * 偽の denpa-hub (`tests/fake/denpa-hub.ts`) がトークンを出し、送られた本文を貯めるので、
 * スイッチをオンにする → トークンを受け取ってすぐ送る → 最後に送った時刻が出る → オフにするとトークンを消す、まで画面で通す。
 * 検索を言葉なしで開いたときの節「人気の番組」も、偽の hub が送られた予約をそのまま順位にして返すので画面で通す。
 * まだ決めていない家に同じ場所で出す参加の案内も、「参加」から画面で通す。
 * 送る中身・差分・送る時刻のずらし方・順位の突き合わせとためておき方は単体テスト (`ranking.test.ts`)
 */
interface HubState {
  ranking: { tokens: number; votes: { v: number }[]; revoked: number };
}

test.describe("番組ランキング", () => {
  test.beforeEach(async ({ request, stack }) => {
    await request.post(`${stack.hubUrl}/__control/ranking`, { data: "ok" });
  });

  /*
   * **まだ決めていない家にだけ、検索の「人気の番組」の場所に参加の案内を出す。** 参加するかを決めるのはこのファイルだけなので、
   * 先頭のこのテストだけが「まだ決めていない」を見られる。参加を選んだあとは二度と出ないので、
   * 「参加しない」は単体テスト (`ranking.test.ts` の「参加するかの案内」) で見る
   */
  test("まだ決めていなければ検索に参加の案内を出し、参加したら出さない。オフに決めたあとも出さない", async ({
    page,
    request,
    stack,
  }) => {
    const tokens = async () =>
      (
        (await (
          await request.get(`${stack.hubUrl}/__control/state`)
        ).json()) as HubState
      ).ranking.tokens;
    const before = await tokens();

    // アクセストークン (テレビのアプリ) には出さず、参加もさせない
    const token = await pairToken(request, "ranking-invite");
    const auth = { authorization: `Bearer ${token}` };
    const html = await (await request.get("/search", { headers: auth })).text();
    expect(html).not.toContain('data-testid="search-ranking-invite"');
    const refused = await request.post("/search?/joinRanking", {
      headers: {
        ...auth,
        origin: stack.appUrl,
        accept: "application/json",
        "x-sveltekit-action": "true",
      },
    });
    expect(await refused.json()).toMatchObject({
      type: "failure",
      status: 403,
    });
    expect(await tokens()).toBe(before);

    await goto(page, "/search");
    const invite = page.getByTestId("search-ranking-invite");
    await expect(
      invite.getByRole("heading", { level: 2, name: "人気の番組" }),
    ).toBeVisible();
    await expect(invite).toContainText(
      "予約した番組・録画した番組・観た番組を denpa-hub (Doa が動かすサーバ) に送り",
    );
    await expect(
      invite.getByTestId("search-ranking-invite-more"),
    ).toHaveAttribute("href", /\/settings\/integrations#ranking$/);
    await expect(page.getByTestId("search-ranking")).toHaveCount(0);

    // 参加できなければ理由を出し、案内は出したまま (決めたことにしない)
    await request.post(`${stack.hubUrl}/__control/ranking`, { data: "off" });
    await invite.getByTestId("search-ranking-join").click();
    await expect(page.getByTestId("search-error")).toContainText(
      "denpa-hub が番組ランキングを受け付けていないため、参加できませんでした",
    );
    await goto(page, "/search");
    await expect(invite).toBeVisible();

    // 参加すると、設定でオンにしたときと同じくトークンを受け取り、案内の代わりに順位の節を出す
    await request.post(`${stack.hubUrl}/__control/ranking`, { data: "ok" });
    await invite.getByTestId("search-ranking-join").click();
    await expect(page.getByTestId("search-ranking")).toBeVisible();
    await expect(invite).toHaveCount(0);
    expect(await tokens()).toBe(before + 1);
    await goto(page, "/settings/integrations#ranking");
    await expect(page.getByTestId("ranking-setting")).toBeChecked();

    // 設定でオフにしたら、決めたことなので案内も順位も出さない
    await setRanking(page, false);
    await goto(page, "/search");
    await expect(page.getByTestId("search-ranking")).toHaveCount(0);
    await expect(invite).toHaveCount(0);
  });

  test("既定はオフ。オンにするとすぐ送り、オフにするとトークンを消す", async ({
    page,
    request,
    stack,
  }) => {
    const state = async () =>
      (await (
        await request.get(`${stack.hubUrl}/__control/state`)
      ).json()) as HubState;
    const before = (await state()).ranking;

    await goto(page, "/settings/integrations#ranking");
    const toggle = page.getByTestId("ranking-setting");
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId("ranking-state")).toHaveCount(0);

    await toggle.setChecked(true);
    await expect(
      page.locator("#ranking").getByTestId("saved-result"),
    ).toBeVisible();
    await expect(page.getByTestId("ranking-state")).toContainText(
      "最後に送った時刻: ",
    );
    const on = (await state()).ranking;
    expect(on.tokens).toBe(before.tokens + 1);
    expect(on.votes.length).toBe(before.votes.length + 1);
    expect(on.votes.at(-1)?.v).toBe(1);

    // 読み直してもオンのまま
    await goto(page, "/settings/integrations#ranking");
    await expect(page.getByTestId("ranking-setting")).toBeChecked();

    await page.getByTestId("ranking-setting").setChecked(false);
    await expect(
      page.locator("#ranking").getByTestId("saved-result"),
    ).toBeVisible();
    await expect(page.getByTestId("ranking-state")).toHaveCount(0);
    const off = (await state()).ranking;
    expect(off.tokens).toBe(before.tokens);
    expect(off.revoked).toBe(before.revoked + 1);
  });

  test("hub がランキングを受け付けていなければ、オフに戻して理由を出す", async ({
    page,
    request,
    stack,
  }) => {
    await request.post(`${stack.hubUrl}/__control/ranking`, { data: "off" });
    await goto(page, "/settings/integrations#ranking");
    const toggle = page.getByTestId("ranking-setting");
    // 断られるとすぐオフに戻るので、オンになったかは確かめずに押すだけ
    await toggle.click();
    await expect(
      page.locator("#ranking").getByTestId("settings-error"),
    ).toContainText(
      "denpa-hub が番組ランキングを受け付けていないため、参加できませんでした",
    );
    await expect(toggle).not.toBeChecked();
    await goto(page, "/settings/integrations#ranking");
    await expect(page.getByTestId("ranking-setting")).not.toBeChecked();
  });

  test("参加すると、検索を言葉なしで開いたときに人気の番組を出し、その場で予約できる", async ({
    page,
    request,
  }) => {
    await syncEpg(request);
    // 参加していなければ節を出さない
    await goto(page, "/search");
    await expect(page.getByTestId("search-ranking")).toHaveCount(0);

    // 先の放送を 1 つ予約してから参加する。参加するとすぐ送り、偽の hub はその予約を順位に入れる
    const programId = await reserveLater(page);
    await setRanking(page, true);

    await goto(page, "/search");
    const section = page.getByTestId("search-ranking");
    await expect(
      section.getByRole("heading", { level: 2, name: "人気の番組" }),
    ).toBeVisible();
    const mine = section.locator(
      `[data-testid="search-program"][data-program-id="${programId}"]`,
    );
    await expect(mine.getByTestId("search-rank")).toHaveText(/^\d+$/);
    await expect(mine.getByTestId("search-votes")).toHaveText("約 10 世帯");
    await expect(mine.getByTestId("search-program-state")).toHaveText(
      "予約済み",
    );

    // 行からその場で取消・予約できる
    await mine.getByTestId("search-cancel").click();
    await expect(mine.getByTestId("search-program-state")).toHaveCount(0);
    await mine.getByTestId("search-reserve").click();
    await expect(mine.getByTestId("search-program-state")).toHaveText(
      "予約済み",
    );

    // 受信できない局の番組は、予約のボタンを出さずに局名を添える
    const rows = section.locator("li");
    await expect(rows).toHaveCount(5);
    await section.getByTestId("search-more-ranking").click();
    expect(await rows.count()).toBeGreaterThan(5);
    const away = section.getByTestId("search-ranking-away").first();
    await expect(away).toContainText("受信できない局・BSよその局1");
    await expect(away).toContainText("約 5 世帯");
    await expect(away.getByRole("button")).toHaveCount(0);

    // やめると節を出さない
    await setRanking(page, false);
    await goto(page, "/search");
    await expect(page.getByTestId("search-ranking")).toHaveCount(0);
    await cancelAllReservations(page);
  });
});

/** 検索の結果から、まだ予約の無い先の放送を 1 つ予約する (`46-search.spec.ts` と同じ選び方)。番組の ID を返す */
async function reserveLater(page: Page): Promise<string> {
  await goto(page, `/search?q=${encodeURIComponent("テストアニメ")}`);
  const programs = page.getByTestId("search-program");
  await expect(programs.first()).toBeVisible();
  const more = page.getByTestId("search-more-programs");
  if (await more.isVisible()) await more.click();
  for (const row of await programs.all()) {
    const later =
      searchRowStart((await row.textContent()) ?? "") > Date.now() + 2 * 60_000;
    if (!later || (await row.getByTestId("search-reserve").count()) !== 1)
      continue;
    const id = (await row.getAttribute("data-program-id"))!;
    await row.getByTestId("search-reserve").click();
    await expect(row.getByTestId("search-program-state")).toHaveText(
      "予約済み",
    );
    return id;
  }
  throw new Error("予約できる先の放送がありません");
}

/** 設定の「番組ランキング」のスイッチを切り替え、保存されるのを待つ */
async function setRanking(page: Page, on: boolean): Promise<void> {
  await goto(page, "/settings/integrations#ranking");
  await page.getByTestId("ranking-setting").setChecked(on);
  await expect(
    page.locator("#ranking").getByTestId("saved-result"),
  ).toBeVisible();
}
