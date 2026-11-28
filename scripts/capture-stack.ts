/**
 * 偽の放送で撮るスクリプト (`capture-docs.ts`・`capture-demo.ts`) が一式を立てたあとに使う部品。
 * 画面と同じ API へ送る関数と、番組表・局ロゴ・偽の GPU を揃える手順
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Stack } from "../tests/stack";

/** 画面と同じエンドポイントへ送る。SvelteKit は Origin の無いフォームを断る */
export async function post(
  base: string,
  path: string,
  body: Record<string, string | string[]> | null,
): Promise<void> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body ?? {}))
    for (const v of [value].flat()) form.append(key, v);
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers:
      body === null
        ? { Origin: base, "Content-Type": "application/json" }
        : { Origin: base },
    body: body === null ? null : form,
  });
  if (res.status >= 400)
    throw new Error(
      `${path} が ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
}

/**
 * 局ロゴを集める (設定の「受信できるチャンネル」の「ロゴをいますぐ集める」と同じ API)。番組表とライブの局の列に出る。
 * 集めている間はチューナーが塞がり、ライブが映らないので、終わるまで待つ
 */
async function sweepLogos(base: string): Promise<void> {
  // 番組表を集め終えた直後は、衛星のロゴを待つ選局 (`awaitCarousel`) や番組表集めの片付けでチューナーが
  // まだ空いていないことがあり、押しても「空いているチューナーがありません」と断られる。空くまで押し直す
  const asked = Date.now() + 60_000;
  for (;;) {
    try {
      await post(base, "/settings/reception?/logoSweep", {});
      break;
    } catch (error) {
      if (
        Date.now() > asked ||
        !String(error).includes("空いているチューナーがありません")
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    const html = await (await fetch(`${base}/settings/reception`)).text();
    if (html.includes('data-testid="logo-sweep-done"')) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("局ロゴの取得が 3 分で終わりませんでした");
}

/**
 * 番組表と局ロゴを偽エージェントから取得し、偽の GPU を置く。
 * GPU が無いと、設定の画面に「GPU が見つかりません」(テスト用の置き場のパス付き) が出る
 */
export async function collect(stack: Stack): Promise<void> {
  const base = stack.appUrl;
  // 番組表。偽エージェントから取得し終わるまで待つ (`/api/sync`)
  await post(base, "/api/sync", null);
  await sweepLogos(base);
  // 1 回目で取りこぼした局 (チューナーの取り合いで待ちきれなかったもの) を取得し直す
  await post(base, "/api/sync", null);

  // GPU (偽物。置いたファイルを偽 ffmpeg が「ある」と答える)
  writeFileSync(join(stack.hwDir, "renderD128"), "");
  await post(base, "/settings/recording?/probeHw", {});
}
