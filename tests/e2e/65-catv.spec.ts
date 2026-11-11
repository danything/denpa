import { rmSync, writeFileSync } from "node:fs";

import {
  CATV_4K,
  CATV_4K_FREE,
  CATV_BS,
  CATV_GR,
  CATV_LOCKED,
  CATV_OWN,
} from "../fake/services";
import {
  encodeRuns,
  expect,
  goto,
  setRecording,
  syncEpg,
  test,
} from "./helpers";

/**
 * HTTP のライブを開いて、`enough` が true になるまで (20 秒まで) 読む。読み終えたら閉じる。
 * 中身は 1 バイト 1 文字の文字列にする (箱の名前を探す)
 */
async function streamHead(
  url: string,
  enough: (text: string) => boolean,
): Promise<{
  status: number;
  type: string | null;
  codec: string | null;
  text: string;
}> {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  let text = "";
  const reader = res.body?.getReader();
  const deadline = Date.now() + 20_000;
  while (reader !== undefined && !enough(text) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString("latin1");
  }
  controller.abort();
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    codec: res.headers.get("x-denpa-codec"),
    text,
  };
}

/**
 * ケーブル (種別 CATV。ISDB-C) の受信の設定・スキャン・番組表・ライブ。
 *
 * **CATV を受けられるのは、エージェントが直に持つ IT930x の機材 (`it930x:`) だけ。** 偽エージェントもその機材にだけ
 * `receivable` に CATV を返す。既定のチューナーには無いので、このファイルの間だけ 1 台足す。
 * 偽の放送の搬送波は 5 つ (`tests/fake/services.ts`): BS の再送信 (QC20)、BS4K の再送信 (QC26。TLV)、スクランブルしていない 4K の局 (QC28。TLV)、TSMF で 2 つの TS を束ねたもの
 * (QC30。地上波の再送信と自主放送)、B-CAS 以外の CA_system_id だけでスクランブルした局 (QC40。番組表もスクランブルしている)。
 * 復号できない局はライブに出ない。番組表を読める局 (ACAS の 4K の局) は、番組表に「観られません」の列で出る。
 * スクランブルしていない 4K の局はライブで観られる (放送の HEVC の詰め替えと、縮めたエンコード)
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
    await expect(card.getByTestId("scan-found")).toContainText("6");

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
      "4K の放送のスクランブル (ACAS) にまだ対応していないため",
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

    // ライブのタブにも「ケーブル」が出て、選ぶとその局を選局する。観る局 (service_id) も渡す (エージェントはその局の PMT と鍵で流し始める)
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
          opens: {
            use: string;
            type: string;
            channel: string;
            service: number | null;
          }[];
        };
        return opens.some(
          (open) =>
            open.use.startsWith("live ") &&
            open.type === "CATV" &&
            open.channel === CATV_GR.channel &&
            open.service === CATV_GR.serviceId,
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
      "4K の放送のスクランブル (ACAS) には、まだ対応していないため観られません",
    );
    await expect(page.getByTestId("detail-reserve")).toHaveCount(0);
    await expect(page.getByTestId("detail-watch")).toHaveCount(0);

    // 外から使う API の予約も、同じわけで断る (`reservations.reserve`)
    const refused = await request.post(`/api/programs/${programId}/record`, {
      headers: { accept: "application/json" },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).message).toContain(
      "4K の放送のスクランブル (ACAS) には、まだ対応していないため観られません",
    );

    // ライブも選局せずに断る
    const live = await request.get(`/api/services/${CATV_4K.id}/live`, {
      headers: { accept: "application/json" },
    });
    expect(live.status()).toBe(409);
  });

  test("スクランブルしていない 4K の局はライブで観られる。放送の HEVC は詰め替えて送る", async ({
    page,
    request,
    baseURL,
  }) => {
    await syncEpg(request);
    const live = `${baseURL}/api/services/${CATV_4K_FREE.id}/live`;

    // 放送の HEVC と AAC を、エンコードせずに fMP4 に詰め替えて流す (`codec=hevc`)
    const hevc = await streamHead(`${live}?codec=hevc`, (text) =>
      text.includes("mdat"),
    );
    expect(hevc.status).toBe(200);
    expect(hevc.type).toBe("video/mp4");
    expect(hevc.codec).toBe("hevc");
    for (const box of ["hev1", "hvcC", "mp4a", "moof", "mdat"])
      expect(hevc.text).toContain(box);
    // 1 局に絞った TLV そのもの (`codec=raw`)。頭は TLV のパケットの 0x7F
    const raw = await streamHead(`${live}?codec=raw`, (text) => text !== "");
    expect(raw.type).toBe("application/x-arib-tlv");
    expect(raw.text.charCodeAt(0)).toBe(0x7f);
    // 自動は MPEG-2 の TS を読めること (`raw`) を候補にしない。家の中は HEVC → H.264
    const auto = (playable: string) =>
      streamHead(`${live}?codec=auto&playable=${playable}`, () => true);
    expect((await auto("raw,h264")).codec).toBe("h264");
    expect((await auto("hevc,h264")).codec).toBe("hevc");

    /*
     * 画面は放送の HEVC (2160p・10 ビット・HLG) を再生できる端末で詰め替えをリクエストする (`#lib/hevc-4k.ts`)。
     * 試験のブラウザは HEVC をデコードできないので、再生できると答えさせて、届いた答え (`tuned`) と init だけを見る
     */
    await page.addInitScript(() => {
      const seen = window as unknown as {
        __tuned: unknown[];
        __init: string[];
      };
      seen.__tuned = [];
      seen.__init = [];
      const support = MediaSource.isTypeSupported.bind(MediaSource);
      MediaSource.isTypeSupported = (type) =>
        type.includes("hev1") || support(type);
      Object.defineProperty(navigator.mediaCapabilities, "decodingInfo", {
        value: async () => ({
          supported: true,
          smooth: true,
          powerEfficient: true,
        }),
      });
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener("message", (event) => {
            if (!(event.data instanceof ArrayBuffer)) return;
            const bytes = new Uint8Array(event.data);
            const body = new TextDecoder("latin1").decode(bytes.subarray(9));
            if (bytes[0] === 0x00) seen.__init.push(body);
            if (bytes[0] !== 0x40) return;
            const notice = JSON.parse(body) as { type: string };
            if (notice.type === "tuned") seen.__tuned.push(notice);
          });
        }
      };
    });
    await goto(page, "/live");
    await page.getByTestId("live-type-CATV").click();
    await page
      .locator(`[data-testid=live-channel][data-service="${CATV_4K_FREE.id}"]`)
      .click();
    // 開いたときは前回の局か一覧の先頭を選局するので、4K の局への答えを探す
    await expect
      .poll(() =>
        page.evaluate(
          (channel) =>
            (
              window as unknown as { __tuned: { channel: string }[] }
            ).__tuned.find((tuned) => tuned.channel === channel) ?? null,
          CATV_4K_FREE.channel,
        ),
      )
      .toMatchObject({
        codec: "hevc",
        raw: false,
        codecs: expect.stringContaining("hev1.2.4"),
      });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { __init: string[] }).__init.some((init) =>
            init.includes("hvcC"),
          ),
        ),
      )
      .toBe(true);
  });

  test("4K の局を再生できない端末では、縮めて SDR にした H.264 で観る", async ({
    page,
    request,
    stack,
  }) => {
    await syncEpg(request);
    // 偽の ffmpeg に本物の H.264 の fMP4 を流させる (渡した fMP4 は読まない)
    writeFileSync(stack.liveFmp4File, "");
    try {
      await goto(page, "/live");
      await page.getByTestId("live-type-CATV").click();
      await page
        .locator(
          `[data-testid=live-channel][data-service="${CATV_4K_FREE.id}"]`,
        )
        .click();
      await expect(page.getByTestId("live-title")).toBeVisible();
      /*
       * ffmpeg には詰め替えた fMP4 を渡し (局は 1 つなので番号で名指ししない)、1080p に縮めて HLG を SDR に直す。
       * 開いたときは前回の局か一覧の先頭も選局するので、4K の局のエンコード (zscale があるもの) を待つ
       */
      const uhd = () =>
        encodeRuns(stack.liveArgsFile).find((run) =>
          run.some((arg) => arg.includes("zscale")),
        );
      await expect.poll(() => uhd() !== undefined).toBe(true);
      expect(uhd()).toContain("libx264");
      expect(uhd()).toContain("0:v:0");
      expect(uhd()?.find((arg) => arg.includes("zscale"))).toContain(
        "scale=-2:1080",
      );
      // 家の中の自動は HEVC → H.264。試験のブラウザは 4K の HEVC を再生できない
      await expect(page.getByTestId("live-codec")).toContainText(
        "自動 (H.264)",
      );
      await expect
        .poll(
          () =>
            page
              .getByTestId("live-video")
              .evaluate((video) => (video as HTMLVideoElement).currentTime),
          { timeout: 20_000 },
        )
        .toBeGreaterThan(0.5);
    } finally {
      rmSync(stack.liveFmp4File, { force: true });
    }
  });

  /*
   * **4K の局の録画は、1 局に絞った TLV のまま `.mmts` で置く** (`recorder.ts`)。エンコードしない設定で録り、
   * 録っている最中は追っかけ (HTTP は放送の HEVC の詰め替えと 1 局に絞った TLV、画面は縮めて SDR にした H.264)、
   * 録り終えたら観る画面の詰め替えで観る
   */
  test("スクランブルしていない 4K の局を TLV のまま録り、追っかけと観る画面で観る", async ({
    page,
    request,
    stack,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    await syncEpg(request);
    await setRecording(request, { codecs: [] });
    const listed = (await (await request.get("/api/services")).json()) as {
      id: number;
      now: { id: number } | null;
    }[];
    const programId = listed.find((s) => s.id === CATV_4K_FREE.id)?.now?.id;
    expect(programId, "4K の局にいま放送中の番組が要る").toBeDefined();
    let id = 0;
    try {
      // いまの番組を録る (ライブの録画ボタンと同じ API)
      expect(
        (
          await request.post("/live?/record", {
            form: { service: String(CATV_4K_FREE.id) },
          })
        ).ok(),
      ).toBe(true);
      await expect(async () => {
        const list = (await (await request.get("/api/recordings")).json()) as {
          id: number;
          serviceId: number;
          recording: boolean;
        }[];
        const rec = list.find(
          (item) => item.recording && item.serviceId === CATV_4K_FREE.id,
        );
        expect(rec).toBeDefined();
        id = rec!.id;
      }).toPass({ timeout: 60_000, intervals: [500] });

      // 追っかけの HTTP。放送の HEVC と AAC の詰め替え (エンコードしない) と、1 局に絞った TLV
      const chase = `${baseURL}/api/recordings/${id}/chase`;
      await expect(async () => {
        const hevc = await streamHead(`${chase}?codec=hevc`, (text) =>
          text.includes("moof"),
        );
        expect(hevc.status).toBe(200);
        expect(hevc.codec).toBe("hevc");
        expect(hevc.text).toContain("moof");
      }).toPass({ timeout: 30_000 });
      const raw = await streamHead(
        `${chase}?codec=raw`,
        (text) => text.length > 0,
      );
      expect(raw.type).toBe("application/x-arib-tlv");
      expect(raw.text.charCodeAt(0)).toBe(0x7f);

      // 追っかけの画面。試験のブラウザは 4K の HEVC を再生できないので、縮めて SDR にした H.264 で観る
      writeFileSync(stack.liveFmp4File, "");
      // 前のテストのライブの引数を消してから数える
      writeFileSync(stack.liveArgsFile, "");
      try {
        await goto(page, `/chase/${id}`);
        await expect
          .poll(
            () =>
              page
                .getByTestId("chase-video")
                .evaluate((video) => (video as HTMLVideoElement).currentTime),
            { timeout: 30_000 },
          )
          .toBeGreaterThan(0.5);
        expect(
          encodeRuns(stack.liveArgsFile).some(
            (run) =>
              run.includes("pipe:0") &&
              run.some((arg) => arg.includes("zscale")),
          ),
        ).toBe(true);
      } finally {
        rmSync(stack.liveFmp4File, { force: true });
      }
    } finally {
      // ケーブルの偽番組は 30 分あるので、止めて録り終える
      await request.post("/guide?/cancel", {
        form: { programId: String(programId) },
      });
    }

    try {
      // 録り終えたら、元の録画 (`.mmts`) を詰め替えて観る。MPEG-2 の TS ではないので MPEG-2 は出さない
      await expect(async () => {
        const info = (await (
          await request.get(`/api/recordings/${id}/playback`)
        ).json()) as {
          broadcast?: string;
          offers: { codec: string; way: string; codecs?: string }[];
        };
        expect(info.broadcast).toBe("hevc");
        expect(info.offers).toContainEqual({
          codec: "hevc",
          way: "stream",
          codecs: "hev1.2.4.L153.B0,mp4a.40.2",
        });
        expect(info.offers.some((offer) => offer.codec === "mpeg2")).toBe(
          false,
        );
      }).toPass({ timeout: 60_000, intervals: [1000] });
      const stream = await streamHead(
        `${baseURL}/api/recordings/${id}/stream?codec=hevc`,
        (text) => text.includes("moof"),
      );
      expect(stream.status).toBe(200);
      expect(stream.codec).toBe("hevc");
      expect(stream.text).toContain("ftyp");
    } finally {
      await setRecording(request, {});
    }
  });

  test("ケーブルを受けられるチューナーがあっても、ケーブルの局を種別を選んで 2 回押しで消せる", async ({
    page,
    request,
    stack,
  }) => {
    await syncEpg(request);
    // 機材は挿さったまま (引っ越してケーブルの回線だけが無くなった)。スキャンし直しても 1 件も無い結果は書かないので、ここで消す
    await goto(page, "/settings/reception");
    await expect(page.getByTestId("channel-list")).toContainText(CATV_GR.name);
    await expect(
      page.locator('select[name="types"] option', { hasText: "ケーブル" }),
    ).not.toHaveCount(0);
    const choice = page.getByTestId("remove-type-select");
    await choice.selectOption("CATV");
    await page.getByTestId("remove-type").click();
    await page.getByTestId("remove-type-confirm").click();

    await expect(page.getByTestId("channel-list")).not.toContainText(
      CATV_GR.name,
    );
    // 局が無くなった種別は選べなくなる
    await expect(choice.locator('option[value="CATV"]')).toHaveCount(0);
    const channels = (await (
      await request.get(`${stack.agentUrl}/denpa/channels`)
    ).json()) as { type: string }[];
    expect(channels.some((channel) => channel.type === "CATV")).toBe(false);
    expect(channels.some((channel) => channel.type === "GR")).toBe(true);
  });
});
