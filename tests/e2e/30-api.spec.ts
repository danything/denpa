import { BS_NO_LOGO } from "../fake/services";
import { expect, syncEpg, test } from "./helpers";

/**
 * **外から使う API** (docs/api.md)。形式を保つと約束しているので、名前と型をここで押さえる
 */
test.describe("外から使う API", () => {
  test("局の一覧と、ライブを HTTP で流す API", async ({ request, baseURL }) => {
    await syncEpg(request);
    const res = await request.get("/api/services");
    expect(res.status()).toBe(200);
    const services = await res.json();
    expect(services.length).toBeGreaterThan(0);
    const [first] = services;
    expect(first).toMatchObject({
      id: expect.any(Number),
      type: expect.any(String),
      name: expect.any(String),
    });
    expect(first.live).toBe(`api/services/${first.id}/live`);
    // いま放送中の番組。偽の番組表はいまを跨ぐ番組を持っているので、どこかの局には付く
    const now = services.find((s: { now: unknown }) => s.now !== null)?.now;
    expect(now).toMatchObject({
      id: expect.any(Number),
      title: expect.any(String),
      startAt: expect.any(Number),
      endAt: expect.any(Number),
      // 録画ボタンの印 (`POST /api/services/<id>/record`)
      reserved: expect.any(Boolean),
      recording: expect.any(Boolean),
    });
    // 選べる音声。番組表が何も言っていなくても「そのまま出す」1 つは入る
    expect(now.audios.length).toBeGreaterThan(0);
    expect(now.audios[0]).toMatchObject({
      id: expect.any(String),
      stream: expect.any(Number),
      side: expect.stringMatching(/^(main|sub|both)$/),
      label: expect.any(String),
    });
    expect(now.startAt).toBeLessThanOrEqual(Date.now());
    expect(now.endAt).toBeGreaterThan(Date.now());

    // 元の TS はエンコードせずに流す。先頭は同期バイト 0x47
    const controller = new AbortController();
    const raw = await fetch(`${baseURL}/${first.live}?codec=raw`, {
      signal: controller.signal,
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("video/mp2t");
    const reader = raw.body!.getReader();
    const { value } = await reader.read();
    expect(value?.[0]).toBe(0x47);
    controller.abort();

    /*
     * エンコードするもの (h264 / av1 / ?audio=only) はここでは流さない。偽の ffmpeg は TS をそのまま返すだけで
     * fMP4 を作らないので、何も届かない。エンコード方式の引数は live.test.ts が押さえている
     */
    expect((await request.get("/api/services/1/live")).status()).toBe(404);
  });

  /*
   * **ライブの字幕とデータ放送をアプリへ流す API** (`services/<id>/captions`・`services/<id>/data`)。どちらも映像のセッションを
   * 脇から共有する。偽の放送にはデータ放送が載っていないが、データ放送の API は繋いだときに番組 (`programInfo`) を先に配る。
   * 字幕の API には、データ放送の入口の自動起動の指定 (`autoStart`。偽の放送の PMT には無いので false) が来る
   */
  test("ライブの字幕とデータ放送を、映像を開いた局にだけ流す", async ({
    request,
    baseURL,
  }) => {
    await syncEpg(request);
    const [first] = (await (await request.get("/api/services")).json()) as {
      id: number;
      live: string;
    }[];
    const data = `${baseURL}/api/services/${first!.id}/data`;
    // 映像を開く前は共有する相手が無い
    expect((await fetch(data)).status).toBe(404);
    expect((await fetch(`${data}?codec=mpeg2`)).status).toBe(400);

    const controller = new AbortController();
    try {
      const media = await fetch(`${baseURL}/${first!.live}?codec=raw`, {
        signal: controller.signal,
      });
      expect(media.status).toBe(200);
      const fed = await fetch(data, { signal: controller.signal });
      expect(fed.status).toBe(200);
      expect(fed.headers.get("content-type")).toBe("application/octet-stream");
      const program = await nextFrame(fed, (kind) => kind === 0x30);
      expect(program).toMatchObject({
        type: "programInfo",
        serviceId: expect.any(Number),
      });

      const captions = await fetch(
        `${baseURL}/api/services/${first!.id}/captions`,
        { signal: controller.signal },
      );
      expect(
        await nextFrame(
          captions,
          (kind, body) => kind === 0x40 && body["type"] === "autoStart",
        ),
      ).toEqual({ type: "autoStart", on: false });
    } finally {
      controller.abort();
    }
  });

  /*
   * 録れる側 (予約が入る・2 度押しても 1 本) は record-airing.test.ts が押さえる。ここで録らせると、
   * 同じ組の試験がチューナーを取り合う
   */
  test("いまの番組を録る API は、番組表に無ければ 404 と理由を返す", async ({
    request,
  }) => {
    await syncEpg(request);
    const json = { "content-type": "application/json" };
    const missing = await request.post(
      `/api/services/${BS_NO_LOGO.id}/record`,
      { headers: json },
    );
    expect(missing.status()).toBe(404);
    expect((await missing.json()).message).toBe(
      "いま流れている番組が番組表に見つかりません",
    );
    expect(
      (
        await request.post("/api/services/x/record", { headers: json })
      ).status(),
    ).toBe(400);
  });

  test("録画の一覧は配列で、files はコーデック付き", async ({ request }) => {
    const res = await request.get("/api/recordings?limit=5");
    expect(res.status()).toBe(200);
    const recordings = await res.json();
    expect(Array.isArray(recordings)).toBe(true);
    for (const rec of recordings) {
      expect(rec.audio).toBe(`api/recordings/${rec.id}/file?audio=only`);
      // 続きの位置は、無ければ null (鍵ごと消さない)
      expect(rec).toHaveProperty("resumeMs");
      // 放送の音声の構成 (追っかけの ?audio=<id> で選ぶ)。空にはならない
      expect(rec.audios.length).toBeGreaterThan(0);
      expect(rec.audios[0]).toMatchObject({
        id: expect.any(String),
        stream: expect.any(Number),
      });
      // 番組の中身は別の API (テレビのアプリの詳細)
      const one = await (
        await request.get(`/api/recordings/${rec.id}/detail`)
      ).json();
      expect(one).toMatchObject({
        id: rec.id,
        description: expect.any(String),
        extended: expect.any(Object),
      });
      for (const file of rec.files) {
        expect(["av1", "h264", "mpeg2"]).toContain(file.codec);
        expect(file.url).toBe(
          `api/recordings/${rec.id}/file?source=${file.source}`,
        );
      }
      // 録画の状態 (追っかけの終わりの確かめ)。録れた長さは一覧と同じ。録っている最中のものは
      // 読む間に録り終えて変わりうるので、鍵があることだけ見る
      const state = await (
        await request.get(`/api/recordings/${rec.id}`)
      ).json();
      expect(state).toMatchObject({
        id: rec.id,
        encoded: expect.any(Boolean),
        state: expect.any(String),
      });
      expect(state).toHaveProperty("durationMs");
      if (!rec.recording) expect(state.durationMs).toBe(rec.durationMs);
      // CM 飛ばしの行き先 (playback の物差しの秒)。無ければ空の配列
      const { chapters } = await (
        await request.get(`/api/recordings/${rec.id}/chapters`)
      ).json();
      expect(Array.isArray(chapters)).toBe(true);
      for (const chapter of chapters) {
        expect(chapter).toMatchObject({
          start: expect.any(Number),
          end: expect.any(Number),
          title: expect.any(String),
        });
        expect(chapter.end).toBeGreaterThan(chapter.start);
      }
    }
  });
});

/**
 * アプリ向けの字幕・データ放送の API の本文 (`[4: 後ろの長さ][1: 種別][8: 時刻][JSON]`) を読み、`wanted` に当たる最初のフレームの JSON を返す。
 * 15 秒で当たらなければ失敗にする
 */
async function nextFrame(
  res: Response,
  wanted: (kind: number, body: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const reader = res.body!.getReader();
  const deadline = Date.now() + 15_000;
  let held = new Uint8Array(0);
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    const joined = new Uint8Array(held.length + value.length);
    joined.set(held);
    joined.set(value, held.length);
    held = joined;
    while (held.length >= 4) {
      const length = new DataView(held.buffer, held.byteOffset).getUint32(0);
      if (held.length < 4 + length) break;
      const kind = held[4]!;
      const body = JSON.parse(
        new TextDecoder().decode(held.subarray(13, 4 + length)),
      ) as Record<string, unknown>;
      held = held.slice(4 + length);
      if (wanted(kind, body)) {
        reader.releaseLock();
        return body;
      }
    }
  }
  throw new Error("待っていたフレームが届きませんでした");
}
