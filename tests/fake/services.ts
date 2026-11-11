import { DOCS_SERVICES } from "./docs";

/** 偽エージェントが返す局。テスト側からも ID を参照するのでここに置く */
export interface FakeService {
  id: number;
  serviceId: number;
  networkId: number;
  name: string;
  type: "GR" | "BS" | "CS" | "CATV" | "SKY";
  channel: string;
  /**
   * TS の TSID。省けば、衛星は名前に入っている値 (`BS11:18000`)、ほかはネットワーク ID と同じ値 (`broadcast.tsidOf`)。
   * ケーブルは同じネットワークの TS が搬送波ごとに分かれるので、TS ごとに決める
   */
  tsid?: number;
  /**
   * PMT の CA 記述子に置く CA_system_id。省けば CA 記述子を置かない (SKY は作り物の 0x000B。`broadcast.caDescriptor`)。
   * B-CAS (0x0005) 以外の値を置いた CATV の局は、denpa が復号できない局として扱う (`types.decodableService`)。
   * B-CAS 以外の値の局 (SKY も) は、番組表 (EIT) もスクランブルして流す (`broadcast.schedule`。denpa は番組表を読めない局として扱う)。
   * TLV の局は MPT のアクセス制御記述子に置く
   */
  caSystemId?: number;
  /**
   * 伝送の形式。`tlv` はケーブルで受けた 4K の局で、偽エージェントは TLV のバイト列を `application/x-arib-tlv` で流す
   * (`broadcast.broadcastTlv`)。番組表 (MH-EIT) はスクランブルしない。省けば TS
   */
  transport?: "tlv";
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
  /*
   * ケーブル (ISDB-C。種別 CATV) の局。**既定のチャンネルには入れない** (偽エージェントの `saved`)。
   * 受けられる機材 (`it930x:`) で CATV を選び、スキャンしたときだけ入る (`65-catv.spec.ts`)。搬送波は 5 つ。
   * - QC20 … BS の再送信 (ネットワーク ID 4)。TSMF ではない搬送波
   * - QC26 … BS4K の再送信 (TLV。ネットワーク ID 0x000B、tlv_stream_id 0xB111。実機の QC26 と同じ値)。CA_system_id は B-CAS と同じ 0x0005 でも
   *   ACAS が要るので、denpa は復号できない局として扱う。番組表 (MH-EIT) は読めるので、番組表に「観られません」で出る
   * - QC28 … スクランブルしていない 4K の自主放送 (TLV。作り物)。偽の放送は本物の HEVC と AAC と字幕を流す (`broadcast.broadcastTlv`)。
   *   denpa は復号できる局として扱い、ライブで観られる (録画はまだ無い)
   * - QC30 … TSMF で TS を 2 つ束ねた搬送波 (`X-Denpa-Tsmf-Streams: 2`)。0 番目が地上波の再送信、1 番目 (`QC30:1`) が自主放送
   * - QC40 … B-CAS 以外の CA_system_id (0x0006) だけでスクランブルした自主放送。番組表もスクランブルしているので、denpa は番組表にも出さない
   * 局の ID は `(0x10000 + network_id) * 100000 + service_id` (`server/tuner.ts`)。自主放送のネットワーク ID は作り物
   */
  {
    id: (0x10000 + 4) * 100000 + 181,
    serviceId: 181,
    networkId: 4,
    tsid: 16401,
    name: "ＢＳ再送信テスト",
    type: "CATV",
    channel: "QC20",
    slotMs: 30 * 60_000,
    serviceType: 1,
  },
  {
    id: (0x10000 + 0x000b) * 100000 + 161,
    serviceId: 161,
    networkId: 0x000b,
    tsid: 0xb111,
    name: "ＢＳでんぱ　４Ｋ",
    type: "CATV",
    channel: "QC26",
    slotMs: 30 * 60_000,
    serviceType: 1,
    caSystemId: 0x0005,
    transport: "tlv",
  },
  {
    id: (0x10000 + 0xfff1) * 100000 + 301,
    serviceId: 301,
    networkId: 0xfff1,
    tsid: 0xb201,
    name: "ケーブル４Ｋテスト",
    type: "CATV",
    channel: "QC28",
    slotMs: 30 * 60_000,
    serviceType: 1,
    transport: "tlv",
  },
  {
    id: (0x10000 + 0x7fe0) * 100000 + 1024,
    serviceId: 1024,
    networkId: 0x7fe0,
    name: "地上波再送信テスト",
    type: "CATV",
    channel: "QC30",
    slotMs: 30 * 60_000,
    serviceType: 1,
  },
  {
    id: (0x10000 + 0xfff0) * 100000 + 101,
    serviceId: 101,
    networkId: 0xfff0,
    tsid: 1,
    name: "ケーブル自主放送テスト",
    type: "CATV",
    channel: "QC30:1",
    slotMs: 30 * 60_000,
    serviceType: 1,
  },
  {
    id: (0x10000 + 0xfff0) * 100000 + 201,
    serviceId: 201,
    networkId: 0xfff0,
    tsid: 2,
    name: "ケーブル有料テスト",
    type: "CATV",
    channel: "QC40",
    slotMs: 30 * 60_000,
    serviceType: 1,
    caSystemId: 0x0006,
    noPrograms: true,
  },
  /*
   * スカパー！プレミアムサービス光 (J.83B) の局。**既定のチャンネルには入れない** (偽エージェントの `saved`)。
   * 受けられる機材 (`it930x:`) を足して SKY をスキャンしたときだけ入る (`64-sky.spec.ts`)。
   * ネットワーク ID は実機のスカパー！プレミアムの 10。番組は載せず、CA_system_id が B-CAS 以外 (作り物の 0x000B) なので番組表 (EIT) もスクランブルして流す
   * (denpa は番組表を読めない局として扱い、番組表に出さない)
   */
  {
    id: 1000600,
    serviceId: 600,
    networkId: 10,
    name: "プレミアムテスト",
    type: "SKY",
    channel: "H40",
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
export const SKY_TEST = TEST_SERVICES.find((s) => s.type === "SKY")!;
const catv = (channel: string) =>
  TEST_SERVICES.find((s) => s.type === "CATV" && s.channel === channel)!;
/** ケーブルの局 (上の CATV の局の説明) */
export const CATV_BS = catv("QC20");
export const CATV_GR = catv("QC30");
export const CATV_OWN = catv("QC30:1");
export const CATV_LOCKED = catv("QC40");
export const CATV_4K = catv("QC26");
export const CATV_4K_FREE = catv("QC28");
