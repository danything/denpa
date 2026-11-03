import { DOCS_SERVICES } from "./docs";

/** 偽エージェントが返す局。テスト側からも ID を参照するのでここに置く */
export interface FakeService {
  id: number;
  serviceId: number;
  networkId: number;
  name: string;
  type: "GR" | "BS" | "CS";
  channel: string;
  /**
   * 1 番組の長さ。
   * 地上波は本物らしい 30 分にして番組表のグリッドが成立するようにし、
   * BS だけ 5 秒にして「録画が終わるまで待つ」テストを現実的な時間で回す。
   */
  slotMs: number;
  /** ARIB のサービス種別。1 がデジタル TV、192 はデータ/ワンセグ */
  serviceType: number;
  /**
   * この中継にロゴのデータカルーセルが載っているか (衛星だけ)。
   *
   * **本物は 1 つの中継にしか載っていない。** 実機の BS はネットワーク 4 の
   * 26 中継のうち `BS15:16625` だけで、CS は 12 中継のどれにも無かった。
   * 全部の中継に載せてしまうと、外れを見切って次へ行く経路が試されない
   */
  carousel?: boolean;
  /**
   * 番組表を出さない局。
   *
   * ロゴの中継まわりを見るためだけに置いてある局は、番組まで生やすと
   * 他のテストが数えている番組の本数がずれる。**まだその局の番組表を
   * 集めていない状態**は本物でも普通に起きるので、無理は無い
   */
  noPrograms?: boolean;
  /**
   * Hybridcast が載っている局。**AIT を流す。**
   *
   * データ放送と違って、アプリの中身は電波に入ってこない。入っているのは
   * アドレス (URL) だけなので、偽の放送でも本物と同じものが作れる ([packages/arib/src/ait.ts](../../packages/arib/src/ait.ts))
   */
  hybridcast?: { name: string; base: string; path: string };
  /** リモコンのボタン (地上波だけ)。省けば 9 */
  remoteKey?: number;
}

const TEST_SERVICES: FakeService[] = [
  {
    id: 3239123608,
    serviceId: 23608,
    networkId: 32391,
    name: "ＴＯＫＹＯ　ＭＸ",
    type: "GR",
    channel: "T16",
    slotMs: 30 * 60_000,
    serviceType: 1,
    hybridcast: {
      name: "テスト連動",
      base: "https://hybridcast.example.jp/",
      path: "app.html",
    },
  },
  {
    id: 3274301056,
    serviceId: 1056,
    networkId: 32743,
    name: "フジテレビ",
    type: "GR",
    channel: "T21",
    slotMs: 30 * 60_000,
    serviceType: 1,
  },
  // データ放送。映像が入っていないので録画対象にしてはいけない。
  // 実機ではこれを録ってしまい、中身の無いファイルで失敗していた
  {
    id: 3239100700,
    serviceId: 700,
    networkId: 32391,
    name: "ＭＸデータ１",
    type: "GR",
    channel: "T16",
    slotMs: 30 * 60_000,
    serviceType: 192,
  },
  {
    id: 400211,
    serviceId: 211,
    networkId: 4,
    name: "ＢＳ１１イレブン",
    type: "BS",
    channel: "BS11:18000",
    slotMs: 5_000,
    serviceType: 1,
    carousel: true,
  },
  /*
   * ロゴの載っていない中継。**実機ではこちらが多数派。**
   * BS は 26 中継のうち 25、CS は 12 中継すべてがこれで、開いても永久に来ない。
   * 見切って次へ行けないと、10 分ごとに何十分もチューナーを塞ぐことになる
   */
  {
    id: 400171,
    serviceId: 171,
    networkId: 4,
    name: "ＢＳテレ東",
    type: "BS",
    channel: "BS03:16432",
    slotMs: 30 * 60_000,
    serviceType: 1,
    noPrograms: true,
  },
  /*
   * CS の局。**CS の中継があること**を確かめるテストがある (局ロゴの取得は CS の中継も回る)。
   * 前は標準の表から本物の CS の局が入っていたが、今は放送の一覧から作るので、偽の放送にも置く。
   * ロゴも番組表も載せない (CS の中継にロゴは来ない。本物と同じ)
   */
  {
    id: 600296,
    serviceId: 296,
    networkId: 6,
    name: "ＣＳテスト",
    type: "CS",
    channel: "CS02:24608",
    slotMs: 30 * 60_000,
    serviceType: 1,
    noPrograms: true,
  },
];

/**
 * **スクリーンショットを撮るときは作り物の局に差し替える** (`FAKE_PROFILE=docs`。`tests/fake/docs.ts`)。
 * 読むのは偽エージェントの側だけで、テストは下の名指し (MX など) をそのまま使う
 */
export const SERVICES: FakeService[] =
  process.env["FAKE_PROFILE"] === "docs" ? DOCS_SERVICES : TEST_SERVICES;

export const MX = TEST_SERVICES[0]!;
export const FUJI = TEST_SERVICES[1]!;
export const BS11 = TEST_SERVICES[3]!;
export const BS_NO_LOGO = TEST_SERVICES[4]!;
