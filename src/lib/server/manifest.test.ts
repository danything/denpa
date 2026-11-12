import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { config } from "./config";
import { appName, manifest } from "./manifest";

/**
 * **同じ denpa を 2 つの名前で出している。** 両方をホーム画面に置くと、
 * 名前もアイコンも同じものが並んで見分けが付かない。
 */
describe("ホーム画面に置いたときの名前", () => {
  const original = config.pwaNames;
  beforeEach(() => {
    config.pwaNames = "lan.denpa.example=denpa 宅内";
  });
  afterEach(() => {
    config.pwaNames = original;
  });

  test("載っている名前で来たら、その表示名", () => {
    expect(appName("lan.denpa.example")).toBe("denpa 宅内");
    // ブラウザが送ってくるものをそのまま見るので、大文字小文字は問わない
    expect(appName("LAN.DENPA.EXAMPLE")).toBe("denpa 宅内");
  });

  test("載っていない名前は denpa のまま", () => {
    expect(appName("denpa.example")).toBe("denpa");
    expect(appName("localhost")).toBe("denpa");
  });

  test("何も書かなければ全部 denpa", () => {
    config.pwaNames = "";
    expect(appName("lan.denpa.example")).toBe("denpa");
  });

  test("いくつでも並べられる", () => {
    config.pwaNames = "a.example=denpa A, b.example=denpa B";
    expect(appName("a.example")).toBe("denpa A");
    expect(appName("b.example")).toBe("denpa B");
  });

  test("= が無い書き方は読み捨てる", () => {
    config.pwaNames = "lan.denpa.example";
    expect(appName("lan.denpa.example")).toBe("denpa");
  });

  test("名前は name と short_name の両方に入る", () => {
    const out = manifest("lan.denpa.example") as {
      name: string;
      short_name: string;
    };
    expect(out.name).toBe("denpa 宅内");
    // ホーム画面のアイコンの下に出るのはこちら
    expect(out.short_name).toBe("denpa 宅内");
  });

  test("id を名前ごとに分ける。片方がもう片方の入れ直しにならないように", () => {
    const lan = manifest("lan.denpa.example") as { id: string };
    const outside = manifest("denpa.example") as { id: string };
    expect(lan.id).not.toBe(outside.id);
  });
});

/**
 * **Android でホーム画面から開くと、下のジェスチャーバーは `background_color` で塗られる。**
 * ダークの色のままだと、ライトで開いてもジェスチャーバーだけ黒い
 */
describe("テーマの地の色", () => {
  test("既定はダークの地", () => {
    const out = manifest("denpa.example") as {
      background_color: string;
      theme_color: string;
    };
    expect(out.background_color).toBe("#0b0c0f");
    expect(out.theme_color).toBe("#0b0c0f");
  });

  test("ライトなら白", () => {
    const out = manifest("denpa.example", "light") as {
      background_color: string;
      theme_color: string;
    };
    expect(out.background_color).toBe("#ffffff");
    expect(out.theme_color).toBe("#ffffff");
  });

  test("テーマで id は変わらない (ライトで入れ直しても別のアプリにならない)", () => {
    const dark = manifest("denpa.example") as { id: string };
    const light = manifest("denpa.example", "light") as { id: string };
    expect(light.id).toBe(dark.id);
  });
});
