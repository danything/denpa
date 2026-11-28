import type { Page } from "@playwright/test";

/**
 * 観る画面で、サーバがその場で流すものを観るスペックの部品
 * (`39-watch-stream`・`39-watch-adapt`・`39-watch-adapt-handoff`・`39-watch-adapt-encode`・`39-watch-adapt-relay`・`40-watch-compat`・`40-watch-compat-long`)
 */

/** リクエストした `stream` の URL を順に控える */
export function streamRequests(page: Page): URL[] {
  const seen: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/\/api\/recordings\/\d+\/stream$/.test(url.pathname)) seen.push(url);
  });
  return seen;
}

/** 段 0 の変換で観る。MPEG-2 (元の TS) は出さない (`playback` の応答から外す) */
export async function streamOnly(page: Page, id: string): Promise<void> {
  await page.route(`**/api/recordings/${id}/playback`, async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as { offers: { codec: string }[] };
    json.offers = json.offers.filter((offer) => offer.codec !== "mpeg2");
    await route.fulfill({ response, json });
  });
}

/** 音を消して再生を始める (音を消した自動再生はブラウザが断らない) */
export async function playMuted(page: Page): Promise<void> {
  await page.getByTestId("watch-video").evaluate((v) => {
    const media = v as HTMLVideoElement;
    media.muted = true;
    void media.play().catch(() => undefined);
  });
}

/** 送り出しの具合 (`GET /api/playback/pace`) の `wait` を、読んだ順に控える */
export function paceWaits(page: Page): number[] {
  const seen: number[] = [];
  page.on("response", async (response) => {
    if (!response.url().includes("/api/playback/pace")) return;
    const wait = (
      (await response.json().catch(() => ({}))) as { wait?: number | null }
    ).wait;
    if (typeof wait === "number") seen.push(wait);
  });
  return seen;
}
