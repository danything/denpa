import { expect, syncEpg, test } from "./helpers";

/**
 * **外から使う番組表と予約** (docs/api.md の `GET /api/programs`・`POST`/`DELETE /api/programs/<id>/record`)。
 * テレビのアプリの番組表が使う。形式を保つと約束しているので、名前と型と、画面のマスと同じ状態を返すことを押さえる。
 * アクセストークンで通ることは 31-device が押さえる
 */

const JSON_HEADERS = { "content-type": "application/json" };
const HOUR = 60 * 60 * 1000;

interface ApiProgram {
  id: number;
  startAt: number;
  endAt: number;
  copyNever: boolean;
  reservation: { state: string; reason: string | null } | null;
  recordingId: number | null;
}
interface ApiGuide {
  from: number;
  to: number;
  services: { id: number; programs: ApiProgram[] }[];
}

test.describe("外から使う番組表", () => {
  test("画面のマスと同じ局と状態を返し、24 時間で切る", async ({ request }) => {
    await syncEpg(request);
    const res = await request.get("/api/programs?type=GR");
    expect(res.status()).toBe(200);
    const guide = (await res.json()) as ApiGuide;
    // 省けば今日の放送日 (4:00 から 24 時間。4:00 の扱いは guide-api.test.ts)
    expect(guide.to - guide.from).toBe(24 * HOUR);
    expect(guide).toMatchObject({ type: "GR", until: expect.any(Number) });
    expect(guide.services.length).toBeGreaterThan(0);
    expect(guide.services[0]).toMatchObject({
      id: expect.any(Number),
      name: expect.any(String),
    });
    expect(guide.services[0]).toHaveProperty("remoteControlKey");
    expect(guide.services[0]).toHaveProperty("logo");

    // 先の番組を 1 つ予約して、状態が付いたものもマスと比べる
    const upcoming = guide.services
      .flatMap((service) => service.programs)
      .find(
        (p) =>
          p.startAt > Date.now() + 5 * 60_000 &&
          !p.copyNever &&
          p.reservation === null,
      )!;
    const reserved = await request.post(`/api/programs/${upcoming.id}/record`, {
      headers: JSON_HEADERS,
    });
    expect(reserved.status()).toBe(200);
    const body = await reserved.json();
    expect(body).toMatchObject({
      recorded: expect.any(String),
      programId: upcoming.id,
      reserved: expect.any(Boolean),
      state: expect.stringMatching(/^(scheduled|conflict)$/),
    });
    // 録るなら理由は null
    expect(body.reason === null || typeof body.reason === "string").toBe(true);

    const again = (await (
      await request.get(`/api/programs?type=GR&from=${guide.from}`)
    ).json()) as ApiGuide;
    const sheet = (await (
      await request.get(`/api/guide?type=GR&start=${guide.from}`)
    ).json()) as {
      programs: {
        id: number;
        service_id: number;
        reservation_state: string | null;
      }[];
    };
    const shown = new Set(again.services.map((service) => service.id));
    const grid = new Map(
      sheet.programs
        .filter((p) => shown.has(p.service_id))
        .map((p) => [p.id, p.reservation_state]),
    );
    const listed = again.services.flatMap((service) => service.programs);
    expect(listed.length).toBe(grid.size);
    for (const p of listed)
      expect(p.reservation?.state ?? null).toBe(grid.get(p.id) ?? null);
    expect(
      listed.find((p) => p.id === upcoming.id)?.reservation,
    ).not.toBeNull();

    // 24 時間を超えたぶんは切って、切った範囲を返す
    const wide = (await (
      await request.get(
        `/api/programs?type=GR&from=${guide.from}&to=${guide.from + 48 * HOUR}`,
      )
    ).json()) as ApiGuide;
    expect(wide.to).toBe(guide.from + 24 * HOUR);
    for (const p of wide.services.flatMap((service) => service.programs)) {
      expect(p.startAt).toBeLessThan(wide.to);
      expect(p.endAt).toBeGreaterThan(wide.from);
    }

    const canceled = await request.delete(
      `/api/programs/${upcoming.id}/record`,
      { headers: JSON_HEADERS },
    );
    expect(canceled.status()).toBe(200);
    expect(await canceled.json()).toEqual({ stopped: false });
  });

  test("種別が無い・読めない範囲は 400、番組や予約が無ければ 404 と理由", async ({
    request,
  }) => {
    await syncEpg(request);
    for (const query of [
      "",
      "?type=TV",
      "?type=GR&from=x",
      "?type=GR&from=2&to=1",
    ])
      expect((await request.get(`/api/programs${query}`)).status()).toBe(400);

    const missing = await request.post("/api/programs/1/record", {
      headers: JSON_HEADERS,
    });
    expect(missing.status()).toBe(404);
    expect((await missing.json()).message).toBe("番組が見つかりません");
    const none = await request.delete("/api/programs/1/record", {
      headers: JSON_HEADERS,
    });
    expect(none.status()).toBe(404);
    expect((await none.json()).message).toBe("予約が見つかりません");
    expect(
      (
        await request.delete("/api/programs/x/record", {
          headers: JSON_HEADERS,
        })
      ).status(),
    ).toBe(400);

    // 放送が終わった番組は 400 と理由
    const guide = (await (
      await request.get(`/api/programs?type=GR&from=${Date.now() - 3 * HOUR}`)
    ).json()) as ApiGuide;
    const ended = guide.services
      .flatMap((service) => service.programs)
      .find((p) => p.endAt < Date.now());
    if (ended !== undefined) {
      const late = await request.post(`/api/programs/${ended.id}/record`, {
        headers: JSON_HEADERS,
      });
      expect(late.status()).toBe(400);
      expect((await late.json()).message).toBe(
        "この番組は放送が終わっています",
      );
    }
  });

  test("録画中に取り消すと止め、そこまでの録画は残す", async ({ request }) => {
    // 枠の終わり際なら次の枠まで待つ (下)。そのぶん長く取る
    test.setTimeout(180_000);
    await syncEpg(request);
    /*
     * いま流れていて、終わるまで `LEFT` 以上ある番組。地上波の偽番組は時計にそろえた 30 分の枠なので、
     * 枠の終わり際 (10:29 など) にはそういう番組が無い。そのときは次の枠が始まるまで待って選び直す。
     * 録り始めるのはスケジューラの次の周期 (E2E では 0.5 秒ごと) なので、1 分あれば取り消すまで流れている
     */
    const LEFT = 60_000;
    let found: ApiProgram | undefined;
    for (let tries = 0; found === undefined && tries < 2; tries++) {
      const at = Date.now();
      const guide = (await (
        await request.get(
          `/api/programs?type=GR&from=${at}&to=${at + LEFT + 1}`,
        )
      ).json()) as ApiGuide;
      const open = guide.services
        .flatMap((service) => service.programs)
        .filter((p) => !p.copyNever && p.reservation === null);
      found = open.find((p) => p.startAt <= at && p.endAt > at + LEFT);
      const next = Math.min(
        ...open.filter((p) => p.startAt > at).map((p) => p.startAt),
      );
      if (found === undefined && Number.isFinite(next))
        await new Promise((resolve) => setTimeout(resolve, next - at + 500));
    }
    if (found === undefined)
      throw new Error("流れている地上波の番組がありません");
    const airing = found;
    const reserved = await request.post(`/api/programs/${airing.id}/record`, {
      headers: JSON_HEADERS,
    });
    expect(reserved.status()).toBe(200);

    // 次のスケジューラの周期で録り始める
    const stateOf = async () => {
      const now = Date.now();
      const sheet = (await (
        await request.get(`/api/programs?type=GR&from=${now}&to=${now + 1}`)
      ).json()) as ApiGuide;
      return sheet.services
        .flatMap((service) => service.programs)
        .find((p) => p.id === airing.id);
    };
    await expect
      .poll(async () => (await stateOf())?.reservation?.state, {
        timeout: 60_000,
      })
      .toBe("recording");

    const canceled = await request.delete(`/api/programs/${airing.id}/record`, {
      headers: JSON_HEADERS,
    });
    expect(canceled.status()).toBe(200);
    expect(await canceled.json()).toEqual({ stopped: true });

    // 予約は外れ、止めたところまでの録画は観られるまま残る
    await expect
      .poll(async () => {
        const program = await stateOf();
        return program?.reservation === null && program.recordingId !== null;
      })
      .toBe(true);
    const recordingId = (await stateOf())!.recordingId!;
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/recordings/${recordingId}`)).json())
            .state,
      )
      .not.toBe("recording");
    const state = (
      await (await request.get(`/api/recordings/${recordingId}`)).json()
    ).state;
    expect(state).not.toBe("failed");
  });
});
