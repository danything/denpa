import { bootClosed } from "../stack";
import { expect, goto, syncEpg, test } from "./helpers";

/**
 * **テレビのアプリのペアリング** (docs/auth.md「アプリのペアリング」、device-auth.ts)。
 *
 * テレビがペアリングコードを貰い、スマホで QR (`device?code=…`) を開き、コードを見比べてボタンを押すと済み、テレビはアクセストークンを受け取って
 * `Authorization: Bearer` で API に入る。普段のスタックはローカルを信頼しているので、
 * スマホ役のブラウザはログインなしで `/device` に入れる (家の LAN と同じ)
 */
test.describe("テレビのペアリング", () => {
  test("QR を開いてボタンを押すと済み、アクセストークンで API に入れる。取り消すと 401", async ({
    page,
    request,
  }) => {
    const issued = await request.post("/api/device/code", {
      data: { name: "E2E のテレビ" },
    });
    expect(issued.status()).toBe(200);
    const code = await issued.json();
    expect(code).toMatchObject({
      deviceCode: expect.any(String),
      userCode: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
      verificationUri: "device",
      expiresIn: 600,
      interval: 5,
    });
    expect(code.verificationUriComplete).toBe(`device?code=${code.userCode}`);

    // 開く前は待てと言われる
    const early = await request.post("/api/device/token", {
      data: { deviceCode: code.deviceCode },
    });
    expect(early.status()).toBe(400);
    expect(await early.json()).toEqual({ error: "authorization_pending" });

    /*
     * スマホで QR を開く。**開いただけでは済まない** (人の作ったコードのリンクを開かされても渡らないように)。
     * 端末の名前とコードが出て、ボタンを押すまでテレビは待たされたまま
     */
    await goto(page, `/${code.verificationUriComplete}`);
    await expect(page.getByTestId("device-page")).toContainText(
      "E2E のテレビ とペアリングしますか",
    );
    await expect(page.getByTestId("device-code")).toHaveText(code.userCode);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const unapproved = await request.post("/api/device/token", {
      data: { deviceCode: code.deviceCode },
    });
    expect(await unapproved.json()).toEqual({
      error: "authorization_pending",
    });

    await page.getByTestId("device-approve").click();
    await expect(page.getByTestId("device-done")).toContainText(
      "E2E のテレビ とペアリングしました",
    );

    // 間隔を守って聞き直すと、アクセストークンを 1 度だけ受け取れる
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const got = await request.post("/api/device/token", {
      data: { deviceCode: code.deviceCode },
    });
    expect(got.status()).toBe(200);
    const { token, tokenType } = await got.json();
    expect(tokenType).toBe("Bearer");
    expect(token).toMatch(/^denpa_/);

    const again = await request.post("/api/device/token", {
      data: { deviceCode: code.deviceCode },
    });
    expect(await again.json()).toEqual({ error: "invalid_grant" });

    const auth = { authorization: `Bearer ${token}` };
    expect(
      (await request.get("/api/recordings", { headers: auth })).status(),
    ).toBe(200);

    // 番組表を見て、予約して、取り消す (テレビのアプリの番組表。docs/api.md)。
    // 今日の放送日 (4:00 まで) ではなく今から 24 時間を取る。4:00 の直前は、今日の放送日に先の番組が残っていないことがある
    await syncEpg(request);
    const guide = await request.get(
      `/api/programs?type=GR&from=${Date.now()}`,
      {
        headers: auth,
      },
    );
    expect(guide.status()).toBe(200);
    const upcoming = (
      (await guide.json()) as {
        services: {
          programs: {
            id: number;
            startAt: number;
            copyNever: boolean;
            reservation: unknown;
          }[];
        }[];
      }
    ).services
      .flatMap((service) => service.programs)
      .find(
        (p) =>
          p.startAt > Date.now() + 5 * 60_000 &&
          !p.copyNever &&
          p.reservation === null,
      )!;
    const write = { ...auth, "content-type": "application/json" };
    expect(
      (
        await request.post(`/api/programs/${upcoming.id}/record`, {
          headers: write,
        })
      ).status(),
    ).toBe(200);
    const canceled = await request.delete(
      `/api/programs/${upcoming.id}/record`,
      { headers: write },
    );
    expect(canceled.status()).toBe(200);
    expect(await canceled.json()).toEqual({ stopped: false });

    // アクセストークンでは、別のペアリングコードを済ませられない (盗まれたもので増やせないように)
    const other = await (
      await request.post("/api/device/code", { data: { name: "別の端末" } })
    ).json();
    const viaToken = await request.get(`/${other.verificationUriComplete}`, {
      headers: auth,
    });
    expect(await viaToken.text()).toContain(
      "アクセストークンではペアリングできません",
    );
    const posted = await request.post(`/${other.verificationUriComplete}`, {
      headers: { ...auth, origin: new URL(viaToken.url()).origin },
      form: { code: other.userCode },
    });
    expect(posted.status()).toBe(403);
    const stillPending = await request.post("/api/device/token", {
      data: { deviceCode: other.deviceCode },
    });
    expect(await stillPending.json()).toEqual({
      error: "authorization_pending",
    });

    // 設定画面に並ぶ
    await goto(page, "/settings/integrations");
    const row = page
      .getByTestId("device-row")
      .filter({ hasText: "E2E のテレビ" });
    await expect(row).toBeVisible();

    // 取消は 2 回押し。1 回目は聞き返すだけで、ほかを触れば取り下げる (取り消すのは下でアプリが自分で外す)
    await row.getByTestId("device-revoke").click();
    await expect(row.getByTestId("device-revoke-confirm")).toHaveText(
      "取消を確定",
    );
    await page
      .getByRole("heading", { name: "テレビのアプリ", exact: true })
      .click();
    await expect(row.getByTestId("device-revoke-confirm")).toHaveCount(0);
    await expect(row.getByTestId("device-revoke")).toBeVisible();

    // アプリが自分で外す。無効にしたアクセストークンは信頼するネットワークからでも 401 (ペアリングし直しと分かるように)
    expect(
      (await request.post("/api/device/logout", { headers: auth })).status(),
    ).toBe(204);
    const revoked = await request.get("/api/recordings", { headers: auth });
    expect(revoked.status()).toBe(401);
    expect(await revoked.json()).toEqual({ error: "invalid_token" });
  });

  /*
   * **外のサイトの枠 (iframe) に入れさせない。** 信頼するネットワークの人は接続元で通るので、
   * 枠に入れられると外のサイトに隠した画面でボタンを押させられる
   */
  test("画面は外のサイトの枠に入れられない", async ({ request }) => {
    const res = await request.get("/device?code=ZZZZ-ZZZZ");
    expect(res.headers()["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers()["content-security-policy"]).toContain(
      "frame-ancestors 'self'",
    );
  });

  test("知らないペアリングコードの画面は、そうと言う", async ({ page }) => {
    await goto(page, "/device?code=ZZZZ-ZZZZ");
    await expect(page.getByTestId("device-page")).toContainText(
      "見つかりません",
    );
  });
});

/*
 * テレビはアクセストークンを持たずにまず API を呼び、401 の JSON ならペアリングに進む
 * (信頼するネットワークの中なら通るので、ペアリングは要らない)。ログイン画面の HTML に回さない
 */
test.describe("信頼するネットワークの外からアクセストークンなしで", () => {
  test("API は 401 の JSON。ペアリングコードの API は資格なしで開いている", async ({
    stack,
  }) => {
    const closed = await bootClosed(test.info().workerIndex, stack.root, {
      TRUSTED_NETWORKS: "10.10.0.0/16",
    });
    try {
      const res = await fetch(`${closed.appUrl}/api/services`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });

      const issued = await fetch(`${closed.appUrl}/api/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "外のテレビ" }),
      });
      expect(issued.status).toBe(200);

      // QR の画面は守られている (ここで OIDC か信頼するネットワークを通る)
      expect(
        (await fetch(`${closed.appUrl}/device?code=ABCD-EFGH`)).status,
      ).toBe(403);
    } finally {
      await closed.shutdown();
    }
  });
});

/*
 * **アプリの WebView の Cookie** (`POST /api/device/web`。docs/auth.md「アプリの WebView の Cookie」)。WebView は `Authorization` を
 * 付けられないので、アクセストークンと引き換えた Cookie で入る。信頼するネットワークの外から、結んだアクセストークンと同じに通ることを見る。
 * 前段のふりをして `x-forwarded-for` で接続元を変える (ペアリングを済ませるのは中から、Cookie を使うのは外から)
 */
test.describe("アプリの WebView の Cookie", () => {
  test("アクセストークンと引き換えに受け取り、外からでも通る。Cookie では取り直せず、取り消すと効かない", async ({
    stack,
  }) => {
    const closed = await bootClosed(test.info().workerIndex, stack.root, {
      TRUSTED_NETWORKS: "10.10.0.0/16",
      TRUSTED_PROXIES: "127.0.0.1",
    });
    const inside = { "x-forwarded-for": "10.10.5.9" };
    const outside = { "x-forwarded-for": "203.0.113.9" };
    const json = { "content-type": "application/json" };
    try {
      const code = await (
        await fetch(`${closed.appUrl}/api/device/code`, {
          method: "POST",
          headers: { ...outside, ...json },
          body: JSON.stringify({ name: "WebView のテレビ" }),
        })
      ).json();
      // スマホ役が中からボタンを押す (画面のフォームと同じ POST)
      const approved = await fetch(
        `${closed.appUrl}/${code.verificationUriComplete}`,
        {
          method: "POST",
          headers: {
            ...inside,
            origin: closed.appUrl,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ code: code.userCode }),
        },
      );
      expect(approved.status).toBe(200);
      const { token } = await (
        await fetch(`${closed.appUrl}/api/device/token`, {
          method: "POST",
          headers: { ...outside, ...json },
          body: JSON.stringify({ deviceCode: code.deviceCode }),
        })
      ).json();
      expect(token).toMatch(/^denpa_/);
      const bearer = { authorization: `Bearer ${token}` };

      // Bearer が無ければ出さない
      expect(
        (
          await fetch(`${closed.appUrl}/api/device/web`, {
            method: "POST",
            headers: { ...outside, ...json },
          })
        ).status,
      ).toBe(401);
      const issued = await fetch(`${closed.appUrl}/api/device/web`, {
        method: "POST",
        headers: { ...outside, ...json, ...bearer },
      });
      expect(issued.status).toBe(200);
      const web = (await issued.json()) as {
        name: string;
        value: string;
        maxAge: number;
      };
      expect(web).toEqual({
        name: "denpa_app",
        value: expect.any(String),
        maxAge: 30 * 24 * 60 * 60,
      });
      const cookie = { cookie: `${web.name}=${web.value}` };

      // 外から Cookie だけで API に入れる
      expect(
        (
          await fetch(`${closed.appUrl}/api/services`, {
            headers: { ...outside, ...cookie },
          })
        ).status,
      ).toBe(200);
      // Cookie では取り直せず、アプリも外せない (WebView の中のページに資格を延ばさせない・アプリを外させない)
      for (const path of ["/api/device/web", "/api/device/logout"])
        expect(
          (
            await fetch(`${closed.appUrl}${path}`, {
              method: "POST",
              headers: { ...outside, ...json, ...cookie },
            })
          ).status,
          path,
        ).toBe(401);

      // 書き込みはデータ放送の中継のほかは通さない (WebView の中では放送の文書が動く)。
      // 信頼するネットワークの中からでも、接続元で通さない
      for (const from of [outside, inside])
        expect(
          (
            await fetch(`${closed.appUrl}/api/programs/1/record`, {
              method: "POST",
              headers: { ...from, ...json, ...cookie },
            })
          ).status,
        ).toBe(401);

      // アクセストークンを取り消すと、Cookie も効かない
      expect(
        (
          await fetch(`${closed.appUrl}/api/device/logout`, {
            method: "POST",
            headers: { ...outside, ...json, ...bearer },
          })
        ).status,
      ).toBe(204);
      const revoked = await fetch(`${closed.appUrl}/api/services`, {
        headers: { ...outside, ...cookie },
      });
      expect(revoked.status).toBe(401);
      expect(await revoked.json()).toEqual({ error: "unauthorized" });
    } finally {
      await closed.shutdown();
    }
  });
});
