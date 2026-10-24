import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { configured, isOpenPath, trusted } from "./auth";
import { config } from "./config";

/**
 * ログインの入口。**ここを守ると入れなくなる** (ログイン画面へ行くのに
 * ログインが要る、という輪になる)。
 */
describe("素通しにするエンドポイント", () => {
  test("ログインとログアウト", () => {
    expect(isOpenPath("/login")).toBe(true);
    expect(isOpenPath("/login/callback")).toBe(true);
    expect(isOpenPath("/login/out")).toBe(true);
    expect(isOpenPath("/logout")).toBe(true);
  });

  /*
   * **死活確認。** Kubernetes の livenessProbe が呼ぶ。守ると Pod が
   * 再起動を繰り返す — 掛ける範囲を選べるのをやめたときに実際に踏んだ
   */
  test("死活確認", () => {
    expect(isOpenPath("/api/health")).toBe(true);
  });

  /*
   * **マニフェスト。** ブラウザは資格情報を付けずに取得するので、守ると
   * ホーム画面に置けなくなる。static に置いてあった頃は adapter-node が
   * hooks より手前で返していて、そもそも掛かっていなかった
   */
  test("PWA のマニフェスト", () => {
    expect(isOpenPath("/manifest.webmanifest")).toBe(true);
  });

  test("似た名前は素通しにしない", () => {
    expect(isOpenPath("/loginx")).toBe(false);
    expect(isOpenPath("/logoutx")).toBe(false);
    expect(isOpenPath("/api/healthz")).toBe(false);
    expect(isOpenPath("/manifest.webmanifest.map")).toBe(false);
    expect(isOpenPath("/")).toBe(false);
  });
});

/**
 * **ログイン方法が1つも無ければ、全部断る** (fail-closed)。OIDC はこのテストでは
 * 設定していないので、TRUSTED_NETWORKS の有無がそのまま答えになる。
 */
describe("ログイン方法が設定してあるか", () => {
  const original = config.trustedNetworks;
  afterEach(() => {
    config.trustedNetworks = original;
  });

  test("TRUSTED_NETWORKS があれば設定済み", () => {
    config.trustedNetworks = "10.10.0.0/16";
    expect(configured()).toBe(true);
  });

  test("何も無ければ未設定 (全部断る)", () => {
    config.trustedNetworks = "";
    expect(configured()).toBe(false);
  });
});

/**
 * **何も聞かずに通す相手。** 家の中のプレイヤーやテレビに資格情報を
 * 入れずに使わせるためのもの。ここに当たると OIDC も掛からない。
 *
 * 見るのはアドレスだけ。どの名前で来たかは問わない (名前で分けるのは前段の仕事)。
 */
describe("ネットワークの中なら素通しにする", () => {
  const original = config.trustedNetworks;
  beforeEach(() => {
    config.trustedNetworks = "10.10.0.0/16";
  });
  afterEach(() => {
    config.trustedNetworks = original;
  });

  test("ネットワークの中なら通す", () => {
    expect(trusted("10.10.5.9")).toBe(true);
  });

  test("ネットワークの外は通さない", () => {
    expect(trusted("203.0.113.9")).toBe(false);
  });

  test("アドレスが読めなければ通さない", () => {
    // `clientAddress` は読めないとき空文字を返す。閉じる側に倒す
    expect(trusted("")).toBe(false);
  });

  test("何も書かなければ誰も通さない", () => {
    config.trustedNetworks = "";
    expect(trusted("10.10.5.9")).toBe(false);
  });

  test("いくつでも並べられる", () => {
    config.trustedNetworks = "10.10.0.0/16, 10.20.0.0/16, 192.168.1.5";
    expect(trusted("10.10.1.1")).toBe(true);
    expect(trusted("10.20.1.1")).toBe(true);
    // CIDR でなくアドレスそのままでも書ける
    expect(trusted("192.168.1.5")).toBe(true);
    expect(trusted("192.168.1.6")).toBe(false);
  });
});
