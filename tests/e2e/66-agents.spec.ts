import {
  bootSecondAgent,
  bootSpare,
  type SecondAgent,
  type Spare,
} from "../stack";
import { expect, goto, recordOne, test } from "./helpers";

/**
 * **設定の「受信」の「エージェント」** (docs/agent.md「エージェントを足す」、agent-admin.ts)。
 *
 * いつもの偽エージェントを `TUNER_AGENT_URL` に書いた、まだ使っていない denpa (`bootSpare`) に、2 台目の偽エージェントを画面から登録する。
 * 環境変数のエージェントは削除できないこと、登録用の URL の断り、名前の変更、チューナーの表がエージェントごとに分かれること、削除を通す。
 * 別の denpa を使うのは、ワーカーの denpa のエージェントを増やすと同じワーカーのほかのファイルの振り分けが変わるため
 */
test.describe("エージェントの登録", () => {
  test.describe.configure({ mode: "serial" });
  let spare: Spare;
  let second: SecondAgent;

  test.beforeAll(async ({ stack }, info) => {
    spare = await bootSpare(info.workerIndex, stack.root, stack.tunerAgentUrl);
    second = await bootSecondAgent(info.workerIndex, spare.rawDir, "書斎");
  });
  test.afterAll(async () => {
    await second?.shutdown();
    await spare?.shutdown();
  });

  test("環境変数のエージェントは一覧に「環境変数」と出し、削除の代わりに外し方を言う", async ({
    page,
  }) => {
    await goto(page, `${spare.appUrl}/settings/reception#agents`);
    const rows = page.getByTestId("agent-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByTestId("agent-facts")).toContainText(
      "環境変数",
    );
    await expect(rows.first().getByTestId("agent-facts")).toContainText(
      /チューナー \d+ 台/,
    );
    await rows.first().getByTestId("agent-more").click();
    await expect(page.getByTestId("agent-env-note")).toHaveText(
      "TUNER_AGENT_URL から消すと外れます",
    );
    await expect(page.getByTestId("agent-delete")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // チューナーの表は 1 台でもエージェントの名前の見出しの下に出る
    await expect(page.getByTestId("agent-tuners-name")).toHaveCount(1);
  });

  test("登録用の URL を貼って 2 台目を登録すると、チューナーの表がエージェントごとに分かれる", async ({
    page,
  }) => {
    await goto(page, `${spare.appUrl}/settings/reception#agents`);
    await page.getByTestId("agent-add").click();
    const dialog = page.getByTestId("agent-dialog");
    await expect(dialog).toBeVisible();

    // 合言葉の無い URL は、何をすればよいかを言って断る (窓は閉じない)
    await dialog
      .getByTestId("agent-url")
      .fill(second.pairUrl.replace(/#.*$/, ""));
    await dialog.getByTestId("agent-submit").click();
    await expect(dialog.getByTestId("agent-error")).toContainText(
      "合言葉 (#pair=…) が入っていません",
    );

    await dialog.getByTestId("agent-url").fill(second.pairUrl);
    await dialog.getByTestId("agent-submit").click();
    await expect(dialog).toBeHidden();

    const rows = page.getByTestId("agent-row");
    await expect(rows).toHaveCount(2);
    // 名前はエージェントの `/denpa/about` の name (AGENT_NAME)
    await expect(rows.nth(1).getByTestId("agent-name")).toHaveText("書斎");
    await expect(rows.nth(1).getByTestId("agent-facts")).not.toContainText(
      "環境変数",
    );
    await expect(page.getByTestId("agent-tuners-name")).toHaveText([
      "127.0.0.1",
      "書斎",
    ]);

    // 同じエージェントは 2 度登録しない
    await page.getByTestId("agent-add").click();
    await dialog.getByTestId("agent-url").fill(second.pairUrl);
    await dialog.getByTestId("agent-submit").click();
    await expect(dialog.getByTestId("agent-error")).toContainText(
      "このエージェントはもう登録してあります (書斎)",
    );
    await dialog.getByRole("button", { name: "閉じる" }).last().click();
  });

  test("名前を変え、削除する", async ({ page }) => {
    await goto(page, `${spare.appUrl}/settings/reception#agents`);
    const row = page.getByTestId("agent-row").nth(1);
    await row.getByTestId("agent-more").click();
    await page.getByTestId("agent-rename").click();
    await row.getByTestId("agent-name-input").fill("寝室");
    await row.getByTestId("agent-name-save").click();
    await expect(row.getByTestId("agent-name")).toHaveText("寝室");
    await expect(page.getByTestId("agent-tuners-name").nth(1)).toHaveText(
      "寝室",
    );

    await row.getByTestId("agent-more").click();
    await page.getByTestId("agent-delete").click();
    await page.getByTestId("agent-delete-confirm").click();
    await expect(page.getByTestId("agent-row")).toHaveCount(1);
    await expect(page.getByTestId("agent-tuners-name")).toHaveCount(1);
  });
});

/** 偽エージェントが受けた選局の印 (`/__control/opens` の `use`) */
async function opened(agentUrl: string): Promise<string[]> {
  const body = (await (await fetch(`${agentUrl}/__control/opens`)).json()) as {
    opens: { use: string }[];
  };
  return body.opens.map((open) => open.use);
}

/**
 * **2 台のエージェントで、スキャン・番組表・録画・ライブを通す** (docs/agent.md「エージェントが何台もあるとき」)。
 * どちらも同じ偽の放送を受ける。スキャンはエージェントごとに回り、ほかは局を受けられるどちらかに振り分けられる。
 * 常駐処理を回す別の denpa (`bootSpare` の `autostart`) を、`TUNER_AGENT_URL` に 2 台書いて立てる
 */
test.describe("2 台のエージェント", () => {
  test.describe.configure({ mode: "serial" });
  let spare: Spare;
  let living: SecondAgent;
  let study: SecondAgent;

  test.beforeAll(async ({ stack }, info) => {
    const rawDir = `${stack.root}/spare/raw`;
    living = await bootSecondAgent(info.workerIndex, rawDir, "居間", 2);
    study = await bootSecondAgent(info.workerIndex, rawDir, "書斎", 4);
    spare = await bootSpare(
      info.workerIndex,
      stack.root,
      `${living.pairUrl},${study.pairUrl}`,
      true,
    );
  });
  test.afterAll(async () => {
    await spare?.shutdown();
    await study?.shutdown();
    await living?.shutdown();
  });

  test("スキャンはエージェントごとに回し、進み具合もエージェントごとに出す", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: spare.appUrl });
    const page = await context.newPage();
    try {
      // 環境変数で決めたエージェントの名前はホスト名 (どちらも 127.0.0.1)。見分けられるよう画面で名前を付ける
      await goto(page, "/settings/reception#agents");
      for (const [at, name] of [
        [0, "居間"],
        [1, "書斎"],
      ] as const) {
        const row = page.getByTestId("agent-row").nth(at);
        await row.getByTestId("agent-more").click();
        await page
          .getByTestId("agent-rename")
          .filter({ visible: true })
          .click();
        await row.getByTestId("agent-name-input").fill(name);
        await row.getByTestId("agent-name-save").click();
        await expect(row.getByTestId("agent-name")).toHaveText(name);
      }

      await goto(page, "/settings/reception#channels");
      const card = page.getByTestId("channel-section");
      await expect(card.getByTestId("scan-agents").first()).toContainText(
        "居間",
      );
      await card.getByLabel("スキャンする種別").first().selectOption("GR");
      await card.getByTestId("scan-start").first().click();
      await expect(card.getByTestId("scan-state")).toHaveText("完了", {
        timeout: 90_000,
      });
      const progress = card.getByTestId("scan-agent-progress");
      await expect(progress).toContainText("居間 50 / 50 チャンネル");
      await expect(progress).toContainText("書斎 50 / 50 チャンネル");
      // どちらのエージェントも自分のチューナーで総当たりした
      for (const agent of [living, study])
        expect(
          (await opened(agent.agentUrl)).some((use) => use.startsWith("scan ")),
        ).toBe(true);
      // チャンネルの表には、受けられるエージェントの名前が並ぶ
      await expect(card.getByTestId("channel-agents").first()).toHaveText(
        "居間・書斎",
      );
    } finally {
      await context.close();
    }
  });

  test("番組表と録画とライブは、どちらか 1 台に振り分ける", async ({
    browser,
    playwright,
  }) => {
    const context = await browser.newContext({ baseURL: spare.appUrl });
    const page = await context.newPage();
    const request = await playwright.request.newContext({
      baseURL: spare.appUrl,
      extraHTTPHeaders: { Origin: spare.appUrl },
    });
    try {
      // 番組表 (`/api/sync`) と、すぐ始まる BS の番組を 1 本録る
      const { id } = await recordOne(page, request);
      const all = [
        ...(await opened(living.agentUrl)),
        ...(await opened(study.agentUrl)),
      ];
      expect(all.some((use) => use.startsWith("epg "))).toBe(true);
      // 録画は 1 台にだけ送る
      const holders = [];
      for (const agent of [living, study])
        if ((await opened(agent.agentUrl)).includes(`rec ${id}`))
          holders.push(agent);
      expect(holders).toHaveLength(1);

      // ライブ: 既定の H.264 (エンコードの経路) で開き、最初のバイトが届けばどちらかのエージェントが選局している
      const [first] = await grServices(spare.appUrl);
      await openLive(spare.appUrl, first!.live);
      const lives = [
        ...(await opened(living.agentUrl)),
        ...(await opened(study.agentUrl)),
      ].filter((use) => use.startsWith("live "));
      expect(lives.length).toBeGreaterThan(0);
    } finally {
      await request.dispose();
      await context.close();
    }
  });

  test("1 台目が止まっていれば、H.264 のライブを 2 台目で開く", async () => {
    // 一覧を返さないエージェントには振り分けない (`tuner.route`)。開いたままのライブと同じ局を避け、別の局を開く
    await living.shutdown();
    const before = await opened(study.agentUrl);
    const services = await grServices(spare.appUrl);
    await openLive(spare.appUrl, services.at(-1)!.live);
    const added = (await opened(study.agentUrl)).slice(before.length);
    expect(added.some((use) => use.startsWith("live GR/"))).toBe(true);
  });
});

/** 地上波の局 (`/api/services`) */
async function grServices(
  appUrl: string,
): Promise<{ id: number; live: string }[]> {
  const services = (await (await fetch(`${appUrl}/api/services`)).json()) as {
    id: number;
    type: string;
    live: string;
  }[];
  return services.filter((service) => service.type === "GR");
}

/**
 * 局のライブのエンドポイントを既定の H.264 で開き、最初のバイトが届いたら閉じる。
 * `bootSpare` の偽 ffmpeg は作り置きの fMP4 を流す (`fmp4-loop.ts`)
 */
async function openLive(appUrl: string, live: string): Promise<void> {
  const aborter = new AbortController();
  try {
    const res = await fetch(`${appUrl}/${live}`, { signal: aborter.signal });
    expect(res.ok).toBe(true);
    expect(res.headers.get("X-Denpa-Codec")).toBe("h264");
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
  } finally {
    aborter.abort();
  }
}
