import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, goto, setRecording, test } from "./helpers";
import { sharedRecording } from "./watch";
import {
  paceWaits,
  playMuted,
  streamOnly,
  streamRequests,
} from "./watch-stream";

/**
 * **エンコードが遅いその場の変換でも、回線が細ければ詰まって画質を下げる** (`adapt.ts` の `short`)。
 * 回線が太ければ下げないところは `39-watch-adapt-encode`。作りも同じ (段 0 の変換を、偽 ffmpeg が実時間の 1.2 倍で
 * 6 Mbit/s ほど出す)。回線は 2 Mbit/s に絞る
 */

const watchable = sharedRecording();

test.describe("観る画面で、エンコードが遅いその場の変換を細い回線で観る", () => {
  test.beforeAll(async ({ request, stack }) => {
    await setRecording(request, { codecs: [] });
    writeFileSync(stack.liveFmp4File, "");
    writeFileSync(stack.streamPaceFile, "1.2 6000");
  });
  test.afterAll(async ({ request, stack }) => {
    rmSync(stack.liveFmp4File, { force: true });
    rmSync(stack.streamPaceFile, { force: true });
    await setRecording(request, {});
  });

  test("回線を絞れば (2 Mbit/s)、詰まって下げる", async ({
    page,
    request,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "回線の絞りは Chromium だけ");
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await streamOnly(page, id);
    const asked = streamRequests(page);
    // ブラウザの絞り (CDP)。始めたあとのリクエストにだけ効くので、開く前に絞る
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 20,
      downloadThroughput: 2_000_000 / 8,
      uploadThroughput: 2_000_000 / 8,
    });

    await goto(page, `/watch/${id}`);
    await playMuted(page);
    await expect(page.getByTestId("watch-adapt")).toContainText(
      "に下げました",
      {
        timeout: 60_000,
      },
    );
    expect(asked.at(-1)?.searchParams.get("rung")).not.toBeNull();
  });

  /**
   * **間に応答を溜める中継があっても、回線が細ければ詰まって下げる**。中継はサーバから受けるそばから溜めるので、
   * サーバは送るのを待たされず、ffmpeg を待っていた割合は 1 に近いまま。割合で足した速さで詰まりまで許していた頃は、
   * 詰まり続けても下げなかった。中継はこのテストが立て (`bufferingRelay`)、溜めたものを 2 Mbit/s で画面へ送る
   */
  test("応答を溜める中継の先で回線が細ければ、サーバが ffmpeg を待っていても詰まって下げる", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const id = await watchable(page, request);
    await streamOnly(page, id);
    const asked = streamRequests(page);
    const waits = paceWaits(page);
    const relay = await bufferingRelay(2_000_000);
    try {
      await page.route(`**/api/recordings/${id}/stream?**`, (route) => {
        return route.continue({ url: relay.via(route.request().url()) });
      });

      await goto(page, `/watch/${id}`);
      await playMuted(page);
      await expect(page.getByTestId("watch-adapt")).toContainText(
        "に下げました",
        { timeout: 60_000 },
      );
      expect(asked.at(-1)?.searchParams.get("rung")).not.toBeNull();
      // サーバは送るのを待たされず、ffmpeg を待っていた
      expect(Math.max(...waits)).toBeGreaterThan(0.5);
    } finally {
      relay.close();
    }
  });
});

/**
 * **応答を溜める中継** (応答を溜める設定の逆プロキシのようなもの)。`via` に渡した URL から受けるそばから溜め、
 * 画面へは `bps` の速さで送る。リクエストのヘッダはそのまま渡し、応答のヘッダもそのまま返す。
 * 宛先は `via` で控えた URL だけ (中継に来たリクエストの URL から宛先を組まない)
 */
async function bufferingRelay(
  bps: number,
): Promise<{ via: (url: string) => string; close: () => void }> {
  /** 中継の URL のパス (`/1` など) から、宛先の URL */
  const targets = new Map<string, string>();
  const server = createServer((req, res) => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const target = targets.get(req.url ?? "");
    if (target === undefined) {
      res.writeHead(404).end();
      return;
    }
    void (async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (typeof value === "string" && name !== "host")
          headers.set(name, value);
      const upstream = await fetch(target, {
        headers,
        signal: abort.signal,
      });
      const out: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (name !== "content-length" && name !== "content-encoding")
          out[name] = value;
      });
      res.writeHead(upstream.status, out);
      if (upstream.body === null) {
        res.end();
        return;
      }
      // 受けるそばから溜める (サーバは送るのを待たされない)
      const held: Uint8Array[] = [];
      let finished = false;
      const reader = upstream.body.getReader();
      void (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          held.push(value);
        }
      })()
        .catch(() => undefined)
        .finally(() => {
          finished = true;
        });
      // 画面へは `bps` で送る (16 KB ずつ)
      const SLICE = 16 * 1024;
      while (!res.destroyed) {
        const next = held.shift();
        if (next === undefined) {
          if (finished) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        for (let at = 0; at < next.length && !res.destroyed; at += SLICE) {
          const part = next.subarray(at, at + SLICE);
          res.write(part);
          await new Promise((resolve) =>
            setTimeout(resolve, (part.length * 8 * 1000) / bps),
          );
        }
      }
      res.end();
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    via: (url) => {
      const path = `/${targets.size + 1}`;
      targets.set(path, url);
      return `http://127.0.0.1:${port}${path}`;
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
