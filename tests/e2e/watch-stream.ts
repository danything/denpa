import type { Page } from "@playwright/test";

/**
 * 観る画面で、サーバがその場で流すものを観るスペックの部品
 * (`39-watch-stream`・`39-watch-adapt`・`40-watch-compat`・`40-watch-compat-long`)
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
