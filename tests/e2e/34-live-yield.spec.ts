import type { APIRequestContext } from "@playwright/test";
import { MX, SERVICES } from "../fake/services";
import type { Stack } from "../stack";
import { expect, goto, syncEpg, test } from "./helpers";

/**
 * **ライブが録画にチューナーを取り上げられたとき** (docs/stream.md#録画に譲る)。
 *
 * ライブは録画にだけ譲る。取り上げられたら画面は同じ局をリクエストし直し、入れなかったときだけその録画の
 * 追っかけに切り替える。どの録画に取り上げられたかはサーバが読む (覚えておいたチューナーにいる `rec <録画ID>`。
 * `server/live-yield.ts`)。
 *
 * 場面は偽エージェントで作る — 地上波のチューナーを1台だけにして、ライブを観ている間に別の
 * チャンネルを録る。偽エージェントは空きが無ければ弱い利用者からチューナーを取り上げる (`tests/fake/agent.ts` の `pick`)。
 * 映像は出ない (偽 ffmpeg) ので、見るのは通知と、エージェントの利用者の顔ぶれ
 */

/** 偽エージェントの既定のチューナー (tests/fake/agent.ts の `TUNERS`)。偶数が衛星、奇数が地上波 */
const tunerDefs = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    name: `adapter${index}`,
    types: index % 2 === 0 ? ["BS", "CS"] : ["GR"],
    device: `/dev/dvb/adapter${index}/frontend0`,
    lnb: null,
    disabled: false,
  }));

/** 偽エージェントのチューナーを入れ替える。3台 = 地上波は1台だけ、4台 = 既定 */
async function setTuners(stack: Stack, count: number): Promise<void> {
  const res = await fetch(`${stack.agentUrl}/denpa/tuners`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tuners: tunerDefs(count) }),
  });
  expect(res.ok).toBe(true);
}

/** 地上波のチューナーにいる利用者の印 (`live GR/T16`・`rec 3` …) */
async function grUsers(stack: Stack): Promise<string[]> {
  const res = await fetch(`${stack.agentUrl}/denpa/tuners`);
  const body = (await res.json()) as {
    tuners: { types: string[]; users: { use: string }[] }[];
  };
  return body.tuners
    .filter((t) => t.types.includes("GR"))
    .flatMap((t) => t.users.map((u) => u.use));
}

interface Listed {
  id: number;
  channel: string;
  /** いま放送中の番組 (`/api/services` の `now.id`)。録画を止めるのに使う */
  programId: number;
}

/** 地上波の局を2つ、物理チャンネルの違うもの (MX と、ほかの中継の局) */
async function twoChannels(
  request: APIRequestContext,
): Promise<[Listed, Listed]> {
  const other = SERVICES.find(
    (s) => s.type === "GR" && s.serviceType === 1 && s.channel !== MX.channel,
  )!;
  const services = (await (await request.get("/api/services")).json()) as {
    id: number;
    now: { id: number } | null;
  }[];
  const listed = (fake: typeof MX): Listed => {
    const now = services.find((s) => s.id === fake.id)?.now;
    expect(now, `${fake.name} にいま放送中の番組が要る`).toBeTruthy();
    return { id: fake.id, channel: fake.channel, programId: now!.id };
  };
  return [listed(MX), listed(other)];
}

/** いま放送中の番組を録る (ライブの録画ボタンと同じ API) */
async function recordNow(
  request: APIRequestContext,
  service: Listed,
): Promise<void> {
  const res = await request.post("/live?/record", {
    form: { service: String(service.id) },
  });
  expect(res.ok()).toBe(true);
}

/** 録っている番組を止める。地上波の偽番組は30分あるので、止めないと次のテストまでチューナーを塞ぐ */
async function stopRecording(
  request: APIRequestContext,
  service: Listed,
): Promise<void> {
  await request.post("/guide?/cancel", {
    form: { programId: String(service.programId) },
  });
}

test.describe("ライブが録画にチューナーを取り上げられたとき", () => {
  test.beforeEach(async ({ request, stack }) => {
    await syncEpg(request);
    await setTuners(stack, 3);
  });
  test.afterEach(async ({ stack }) => {
    await setTuners(stack, 4);
  });

  /*
   * **同じチャンネルの録画は選局を共有するので、取り上げられない。** チューナーは増えないので、地上波が1台でも
   * ライブはそのまま。切り替えの通知も出ない
   */
  test("同じチャンネルの録画なら、ライブはそのまま", async ({
    page,
    request,
    stack,
  }) => {
    const [watched] = await twoChannels(request);
    await goto(page, "/live");
    await page
      .locator(`[data-testid="live-channel"][data-service="${watched.id}"]`)
      .click();
    await expect
      .poll(() => grUsers(stack))
      .toContain(`live GR/${watched.channel}`);

    await recordNow(request, watched);
    try {
      // 録画が同じチューナーを共有する。ライブの利用者も残っている
      await expect
        .poll(
          async () =>
            (await grUsers(stack)).some((use) => use.startsWith("rec ")),
          {
            timeout: 30_000,
          },
        )
        .toBe(true);
      await page.waitForTimeout(3_000);
      expect(await grUsers(stack)).toContain(`live GR/${watched.channel}`);
      await expect(page.getByTestId("live-yielded")).toHaveCount(0);
    } finally {
      await stopRecording(request, watched);
    }
  });

  test("別のチャンネルの録画に取り上げられ、入れなければ録画の追っかけに切り替える", async ({
    page,
    request,
    stack,
    baseURL,
  }) => {
    const [watched, recorded] = await twoChannels(request);
    await goto(page, "/live");
    await page
      .locator(`[data-testid="live-channel"][data-service="${watched.id}"]`)
      .click();
    await expect
      .poll(() => grUsers(stack))
      .toContain(`live GR/${watched.channel}`);

    /*
     * **テレビのアプリは通知 (`yielded`) で知る。** HTTP で観ているものにはストリームの中で伝えられない
     * ので、画面と同じものを通知にも流す (docs/api.md)
     */
    const events = new AbortController();
    const heard: string[] = [];
    const listening = fetch(`${baseURL}/api/events`, { signal: events.signal })
      .then(async (res) => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          heard.push(decoder.decode(value));
        }
      })
      .catch(() => undefined);

    await recordNow(request, recorded);
    try {
      const note = page.getByTestId("live-yielded");
      await expect(note).toContainText("録画のため局を切り替えました", {
        timeout: 30_000,
      });
      await expect(note).toContainText("(録画中を再生しています)");
      // チューナーは録画のもの。ライブはリクエストし直したが入れなかった
      const users = await grUsers(stack);
      expect(users.some((use) => use.startsWith("rec "))).toBe(true);
      expect(users).not.toContain(`live GR/${watched.channel}`);

      // 通知には、外れた局と、譲った録画が乗る。画面に出した番組名と同じもの
      await expect
        .poll(() => heard.join("").includes("event: yielded"))
        .toBe(true);
      const block = heard
        .join("")
        .split("\n\n")
        .find((b) => b.startsWith("event: yielded"))!;
      const yielded = JSON.parse(block.split("\ndata: ")[1]!) as {
        serviceId: number;
        recording: { id: number; title: string; endAt: number };
      };
      expect(yielded.serviceId).toBe(watched.id);
      expect(yielded.recording.endAt).toBeGreaterThan(Date.now());
      await expect(note).toContainText(yielded.recording.title);
      // 観ているのは録画のほう (操作バーの読みものも)
      await expect(page.getByTestId("live-title")).toHaveText(
        yielded.recording.title,
      );

      /*
       * **「ライブに戻る」はリクエストし直しを試す。** 録画がまだチューナーを塞いでいるので入れず、追っかけに戻って
       * いつまで待てばいいかを言う
       */
      await page.getByTestId("live-back").click();
      await expect(page.getByTestId("live-refused")).toContainText(
        "録画が終わるまでライブは見られません (",
        {
          timeout: 30_000,
        },
      );
      await expect(note).toBeVisible();
    } finally {
      events.abort();
      await listening;
      await stopRecording(request, recorded);
    }
  });
});
