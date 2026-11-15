import { describe, expect, test } from "bun:test";

import { konomiTvLogoUrl } from "./logo-remote";

/**
 * 埋め合わせのロゴ (KonomiTV のロゴ集) の URL。
 * 内部 ID の組み立て (`tuner.serviceKey`) と食い違うと、全く違う局の
 * ファイルを引きに行く。CATV の局はオフセットを引いて元の network_id に戻す
 */
describe("KonomiTV のロゴの URL (konomiTvLogoUrl)", () => {
  const base =
    "https://raw.githubusercontent.com/tsukumijima/KonomiTV/master/server/static/logos";

  test("地上波は networkId * 100000 + serviceId をそのまま割る", () => {
    // TBCテレビ1 (宮城)。network_id 32482、service_id 17424
    expect(konomiTvLogoUrl(32482 * 100000 + 17424)).toBe(
      `${base}/NID32482-SID17424.png`,
    );
  });

  test("衛星も同じ組み立て (NHK BS。network_id 4、service_id 101)", () => {
    expect(konomiTvLogoUrl(4 * 100000 + 101)).toBe(`${base}/NID4-SID101.png`);
  });

  test("CATV の局はオフセット (0x10000) を引いて元の network_id で引く", () => {
    // ケーブルで再送信されている局。内部 ID は (0x10000 + 4) * 100000 + 151
    expect(konomiTvLogoUrl((0x10000 + 4) * 100000 + 151)).toBe(
      `${base}/NID4-SID151.png`,
    );
  });
});
