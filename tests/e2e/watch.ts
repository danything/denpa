import { writeFileSync } from "node:fs";
import { extname } from "node:path";

import type { APIRequestContext, Page } from "@playwright/test";

import { expect, fakeDataBroadcast, recordOne } from "./helpers";

/**
 * 録画を観る画面のテスト (22-watch・22-watch-clips・22-watch-layout・23-watch-data・23-watch-data-receive) の道具
 */

/** 使い回す録画を返す関数。初めて呼んだときに録る */
export type Watchable = (
  page: Page,
  request: APIRequestContext,
) => Promise<string>;

/**
 * 読み取りだけのテストは**1 本の録画を使い回す**。全テストが `recordOne`
 * (予約→録画→エンコードの完了待ちで各 15 秒前後) を自前でやっていた頃は、22-watch
 * だけで 3 分近く掛かり、e2e の一番遅いシャードそのものだった。
 *
 * 使い回すのは**スペックのファイルの中だけ**。ファイルの冒頭で 1 つ作る。同じワーカーで前に流れた
 * ファイルの録画は使わない (そのファイルが録画を消していても、こちらは自分の 1 本を録る)。
 * `prepare` は録った 1 本に一度だけ手を加える (データ放送のサイドカーを置くなど)
 */
export function sharedRecording(
  prepare?: (recording: { id: string; libraryPath: string }) => void,
): Watchable {
  let shared: { id: string } | null = null;
  return async (page, request) => {
    if (shared === null) {
      const recording = await recordOne(page, request);
      prepare?.(recording);
      shared = { id: recording.id };
    }
    return shared.id;
  };
}

/** 合成の 1 枚 (端末の canvas で作った PNG) を API で切り抜きに置く。`page` は何か開いていること */
export async function putClip(
  page: Page,
  request: APIRequestContext,
  id: string,
  at: number,
): Promise<number> {
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#3a6";
    ctx.fillRect(0, 0, 320, 180);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  const res = await request.post(
    `/api/clips?place=watch&recording=${id}&at=${at}`,
    {
      headers: { "content-type": "image/png" },
      data: Buffer.from(png, "base64"),
    },
  );
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

/**
 * **「このブラウザでは再生できませんでした」の幕を畳む** (画像で字幕を確かめるテストだけ)。
 * 偽の録画は中身が無く、ブラウザは再生に転んで幕 (`watch-status`。映像の箱を暗く覆う) を出す。
 * データ放送の小窓に寄せた映像の箱もその下にあるので、塗った字幕が暗く写る。本物の録画では出ない
 */
export async function hideBroken(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '[data-testid="watch-status"] { display: none !important; }',
  });
}

/** 録画のサイドカーにデータ放送を置く */
export function placeDataBroadcast(libraryPath: string, script?: string): void {
  writeFileSync(
    `${libraryPath.slice(0, libraryPath.length - extname(libraryPath).length)}.bml.jsonl`,
    `${fakeDataBroadcast(script)
      .map((message) => JSON.stringify({ at: 0, message }))
      .join("\n")}\n`,
  );
}

/**
 * 小窓を持つ既定の BML を置いた録画を使い回す関数 (どのテストも同じサイドカーを読むだけ)。
 * 文書を差し替えるテストは自分のぶんを録る
 */
export function sharedDataBroadcast(): Watchable {
  return sharedRecording(({ libraryPath }) => placeDataBroadcast(libraryPath));
}
