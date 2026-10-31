import { describe, expect, test } from "bun:test";

import {
  ddbSection,
  diiSection,
  logoModule,
  packetize,
  patSection,
  pmtSection,
  stream,
} from "@danything/arib/synth";

import { LogoCollector } from "./logo";
import {
  CarouselProgress,
  DsmccLogoCollector,
  parseLogoModule,
} from "./logo-dsmcc";

/**
 * 衛星 (BS/CS) のロゴ。
 *
 * 地上波と違って CDT には載らず、データカルーセル (DSM-CC) で流れてくる。
 * PAT → エンジニアリングサービス (929) の PMT → component_tag 0x79/0x7A の ES
 * → DII でモジュールの大きさ → DDB でブロック、と辿らないと取得できない。
 */

/** PNG の署名だけのもの。中身は問わない */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xbe, 0xef,
]);

const ESS = 929;
const PMT_PID = 0x1f0;
const ES_PID = 0x1f1;
const DOWNLOAD_ID = 0x12345678;
const MODULE_ID = 0x0001;

/** カルーセル一式。モジュールを `blockSize` ごとに割って DDB に載せる */
function carousel(
  module: Uint8Array,
  blockSize: number,
  name = "LOGO-05",
): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (let at = 0, n = 0; at < module.length; at += blockSize, n++) {
    blocks.push(
      packetize(
        ES_PID,
        ddbSection(
          DOWNLOAD_ID,
          MODULE_ID,
          1,
          n,
          module.subarray(at, at + blockSize),
        ),
      ),
    );
  }
  return stream(
    packetize(0x0000, patSection([[ESS, PMT_PID]])),
    packetize(PMT_PID, pmtSection(ESS, ES_PID, 0x79)),
    packetize(
      ES_PID,
      diiSection(DOWNLOAD_ID, blockSize, {
        moduleId: MODULE_ID,
        moduleSize: module.length,
        moduleVersion: 1,
        name,
      }),
    ),
    ...blocks,
  );
}

describe("parseLogoModule", () => {
  test("ロゴと、それを使う局を読む", () => {
    const logos = parseLogoModule(
      logoModule(0x05, [
        {
          logoId: 0x0011,
          services: [
            [4, 211],
            [4, 212],
          ],
          data: PNG,
        },
      ]),
    );
    expect(logos).toHaveLength(1);
    expect(logos[0]!.logoId).toBe(0x0011);
    expect(logos[0]!.logoType).toBe(0x05);
    // **どの局のロゴかはモジュール自身が持っている。** 地上波と違って SDT を待たない
    expect(logos[0]!.services).toEqual([
      { networkId: 4, serviceId: 211 },
      { networkId: 4, serviceId: 212 },
    ]);
    /*
     * 中身はそのまま出てくる。地上波と同じく色の表を入れ直して返すが
     * (`withPalette`)、形式が違うものは触らない決まりなので、この偽 PNG は
     * 素通りする。入れ直しそのものは logo-palette 側で見ている
     */
    expect(logos[0]!.data).toEqual(PNG);
  });

  test("途中で切れていても、読めたぶんだけ返す", () => {
    const module = logoModule(0x05, [
      { logoId: 1, services: [[4, 211]], data: PNG },
    ]);
    expect(parseLogoModule(module.subarray(0, module.length - 4))).toEqual([]);
  });
});

describe("DsmccLogoCollector", () => {
  test("PAT から辿ってカルーセルを組み立てる", () => {
    const collector = new DsmccLogoCollector();
    const module = logoModule(0x05, [
      { logoId: 0x0011, services: [[4, 211]], data: PNG },
    ]);
    // わざと小さく割る。1つの DDB に収まると組み立てを試したことにならない
    for (const packet of packets(carousel(module, 16))) collector.feed(packet);

    const logos = collector.collected();
    expect(logos).toHaveLength(1);
    expect(logos[0]!.services).toEqual([{ networkId: 4, serviceId: 211 }]);
  });

  test("名前の違うモジュールは取得しない", () => {
    const collector = new DsmccLogoCollector();
    const module = logoModule(0x05, [
      { logoId: 1, services: [[4, 211]], data: PNG },
    ]);
    // カルーセルにはロゴ以外のモジュールも流れている
    for (const packet of packets(carousel(module, 16, "BOARD-1")))
      collector.feed(packet);
    expect(collector.collected()).toEqual([]);
  });

  test("CS の component_tag でも取得する", () => {
    const collector = new DsmccLogoCollector();
    const module = logoModule(0x05, [
      { logoId: 2, services: [[7, 330]], data: PNG },
    ]);
    const data = stream(
      packetize(0x0000, patSection([[ESS, PMT_PID]])),
      packetize(PMT_PID, pmtSection(ESS, ES_PID, 0x7a)),
      packetize(
        ES_PID,
        diiSection(DOWNLOAD_ID, 4066, {
          moduleId: MODULE_ID,
          moduleSize: module.length,
          moduleVersion: 1,
          name: "CS_LOGO-05",
        }),
      ),
      packetize(ES_PID, ddbSection(DOWNLOAD_ID, MODULE_ID, 1, 0, module)),
    );
    for (const packet of packets(data)) collector.feed(packet);
    expect(collector.collected()[0]?.services).toEqual([
      { networkId: 7, serviceId: 330 },
    ]);
  });

  /**
   * **CS のロゴは BS の中継から流れてくる。**
   *
   * 実機の `BS15_0` を15分読み続けると、エンジニアリングサービスに
   * `LOGO-00`〜`LOGO-05` と `CS_LOGO-00`〜`CS_LOGO-05` が並んで来ていた
   * (CS の12中継にはエンジニアリングサービスが1つもいない)。
   *
   * DII のモジュールを1つ見つけた時点で打ち切っていた頃は、先に並んでいる
   * BS のぶんしか組み立てず、CS が永久に揃わなかった。
   */
  test("1つのカルーセルに並んだ BS と CS のモジュールを両方組み立てる", () => {
    const collector = new DsmccLogoCollector();
    const bs = logoModule(0x05, [
      { logoId: 0x0011, services: [[4, 211]], data: PNG },
    ]);
    // logo_id は BS と CS で別々に振られていて、同じ番号が普通に出てくる
    const cs = logoModule(0x05, [
      { logoId: 0x0011, services: [[7, 330]], data: PNG },
    ]);
    const CS_MODULE_ID = MODULE_ID + 1;
    const data = stream(
      packetize(0x0000, patSection([[ESS, PMT_PID]])),
      packetize(PMT_PID, pmtSection(ESS, ES_PID, 0x79)),
      packetize(
        ES_PID,
        diiSection(DOWNLOAD_ID, 4066, [
          {
            moduleId: MODULE_ID,
            moduleSize: bs.length,
            moduleVersion: 1,
            name: "LOGO-05",
          },
          {
            moduleId: CS_MODULE_ID,
            moduleSize: cs.length,
            moduleVersion: 1,
            name: "CS_LOGO-05",
          },
        ]),
      ),
      packetize(ES_PID, ddbSection(DOWNLOAD_ID, MODULE_ID, 1, 0, bs)),
      packetize(ES_PID, ddbSection(DOWNLOAD_ID, CS_MODULE_ID, 1, 0, cs)),
    );
    for (const packet of packets(data)) collector.feed(packet);

    // 同じ logo_id でも上書きし合わないこと
    const found = collector.collected();
    expect(found).toHaveLength(2);
    expect(found.flatMap((logo) => logo.services)).toEqual([
      { networkId: 4, serviceId: 211 },
      { networkId: 7, serviceId: 330 },
    ]);
  });

  /*
   * **読み切ったかは、DII が知らせたモジュールが全部揃ったかで決める。** BS と CS のモジュールが
   * 別々の時刻に来ると、片方だけ揃った時点ではまだ読み切っていない
   */
  test("知らせたロゴのモジュールが全部揃うまでは、読み切ったことにしない", () => {
    const collector = new DsmccLogoCollector();
    const bs = logoModule(0x05, [
      { logoId: 0x0011, services: [[4, 211]], data: PNG },
    ]);
    const cs = logoModule(0x05, [
      { logoId: 0x0012, services: [[7, 330]], data: PNG },
    ]);
    const CS_MODULE_ID = MODULE_ID + 1;
    const head = stream(
      packetize(0x0000, patSection([[ESS, PMT_PID]])),
      packetize(PMT_PID, pmtSection(ESS, ES_PID, 0x79)),
      packetize(
        ES_PID,
        diiSection(DOWNLOAD_ID, 4066, [
          {
            moduleId: MODULE_ID,
            moduleSize: bs.length,
            moduleVersion: 1,
            name: "LOGO-05",
          },
          {
            moduleId: CS_MODULE_ID,
            moduleSize: cs.length,
            moduleVersion: 1,
            name: "CS_LOGO-05",
          },
        ]),
      ),
    );
    for (const packet of packets(head)) collector.feed(packet);
    expect(collector.carouselRead).toBe(false);

    const first = packetize(
      ES_PID,
      ddbSection(DOWNLOAD_ID, CS_MODULE_ID, 1, 0, cs),
    );
    for (const packet of packets(first)) collector.feed(packet);
    expect(collector.collected()).toHaveLength(1);
    expect(collector.carouselRead).toBe(false);

    const second = packetize(
      ES_PID,
      ddbSection(DOWNLOAD_ID, MODULE_ID, 1, 0, bs),
    );
    for (const packet of packets(second)) collector.feed(packet);
    expect(collector.carouselRead).toBe(true);
  });

  test("BS と CS が別々の DII で来るとき、片方の名前しか知らされていないうちは読み切ったことにしない", () => {
    const collector = new DsmccLogoCollector();
    const bs = logoModule(0x05, [
      { logoId: 0x0011, services: [[4, 211]], data: PNG },
    ]);
    const cs = logoModule(0x05, [
      { logoId: 0x0012, services: [[7, 330]], data: PNG },
    ]);
    const dii = (downloadId: number, size: number, name: string) =>
      packetize(
        ES_PID,
        diiSection(downloadId, 4066, {
          moduleId: MODULE_ID,
          moduleSize: size,
          moduleVersion: 1,
          name,
        }),
      );
    const bsPart = stream(
      packetize(0x0000, patSection([[ESS, PMT_PID]])),
      packetize(PMT_PID, pmtSection(ESS, ES_PID, 0x79)),
      dii(DOWNLOAD_ID, bs.length, "LOGO-05"),
      packetize(ES_PID, ddbSection(DOWNLOAD_ID, MODULE_ID, 1, 0, bs)),
    );
    for (const packet of packets(bsPart)) collector.feed(packet);
    expect(collector.collected()).toHaveLength(1);
    expect(collector.carouselRead).toBe(false);

    const csPart = stream(
      dii(DOWNLOAD_ID + 1, cs.length, "CS_LOGO-05"),
      packetize(ES_PID, ddbSection(DOWNLOAD_ID + 1, MODULE_ID, 1, 0, cs)),
    );
    for (const packet of packets(csPart)) collector.feed(packet);
    expect(collector.carouselRead).toBe(true);
  });

  /**
   * **放送の中身は外から作れる。** downloadId を変えた DII を次々に送られても、
   * 組み立て中のものは一定の数までしか溜めない (古いものから捨てる)
   */
  const flooded = (others: number) => {
    const collector = new DsmccLogoCollector();
    const module = logoModule(0x05, [
      { logoId: 1, services: [[4, 211]], data: PNG },
    ]);
    const dii = (downloadId: number) =>
      packetize(
        ES_PID,
        diiSection(downloadId, 4066, {
          moduleId: MODULE_ID,
          moduleSize: module.length,
          moduleVersion: 1,
          name: "LOGO-05",
        }),
      );
    const data = stream(
      packetize(0x0000, patSection([[ESS, PMT_PID]])),
      packetize(PMT_PID, pmtSection(ESS, ES_PID, 0x79)),
      dii(DOWNLOAD_ID),
      ...Array.from({ length: others }, (_, i) => dii(DOWNLOAD_ID + 1 + i)),
      packetize(ES_PID, ddbSection(DOWNLOAD_ID, MODULE_ID, 1, 0, module)),
    );
    for (const packet of packets(data)) collector.feed(packet);
    return collector.collected();
  };

  test("組み立て中のモジュールは数を限り、古いものから捨てる", () => {
    expect(flooded(3)).toHaveLength(1);
    expect(flooded(4)).toEqual([]);
  });

  test("大きすぎると言うモジュールは組み立てない", () => {
    const collector = new DsmccLogoCollector();
    const module = logoModule(0x05, [
      { logoId: 1, services: [[4, 211]], data: PNG },
    ]);
    const data = stream(
      packetize(0x0000, patSection([[ESS, PMT_PID]])),
      packetize(PMT_PID, pmtSection(ESS, ES_PID, 0x79)),
      packetize(
        ES_PID,
        diiSection(DOWNLOAD_ID, 4066, {
          moduleId: MODULE_ID,
          moduleSize: 0xffffffff,
          moduleVersion: 1,
          name: "LOGO-05",
        }),
      ),
      packetize(ES_PID, ddbSection(DOWNLOAD_ID, MODULE_ID, 1, 0, module)),
    );
    expect(() => {
      for (const packet of packets(data)) collector.feed(packet);
    }).not.toThrow();
    expect(collector.collected()).toEqual([]);
  });
});

/**
 * **開き直しても読みかけを捨てない** (`CarouselProgress`)。
 *
 * 衛星のカルーセルは十数分に一度まとめて来るだけで、チューナーが2台の衛星では番組表集めやライブに
 * 途中で取り上げられる。開くたびに一から読んでいた頃は、DII を見たあとで切れるとそれまでの
 * ブロックが消え、次に開いても DII が来るまで何も組み立てられず、何日経っても揃わなかった
 */
describe("読みかけ (CarouselProgress)", () => {
  const bs = logoModule(0x05, [
    { logoId: 1, services: [[4, 211]], data: PNG },
    { logoId: 2, services: [[4, 212]], data: PNG },
  ]);
  const cs = logoModule(0x05, [{ logoId: 1, services: [[7, 330]], data: PNG }]);
  const CS_MODULE_ID = MODULE_ID + 1;
  const BLOCK = 8;
  const blocksOf = (moduleId: number, module: Uint8Array) => {
    const list: Uint8Array[] = [];
    for (let at = 0, n = 0; at < module.length; at += BLOCK, n++)
      list.push(
        packetize(
          ES_PID,
          ddbSection(
            DOWNLOAD_ID,
            moduleId,
            1,
            n,
            module.subarray(at, at + BLOCK),
          ),
        ),
      );
    return list;
  };
  const head = (dii: boolean) =>
    stream(
      packetize(0x0000, patSection([[ESS, PMT_PID]])),
      packetize(PMT_PID, pmtSection(ESS, ES_PID, 0x79)),
      ...(dii
        ? [
            packetize(
              ES_PID,
              diiSection(DOWNLOAD_ID, BLOCK, [
                {
                  moduleId: MODULE_ID,
                  moduleSize: bs.length,
                  moduleVersion: 1,
                  name: "LOGO-05",
                },
                {
                  moduleId: CS_MODULE_ID,
                  moduleSize: cs.length,
                  moduleVersion: 1,
                  name: "CS_LOGO-05",
                },
              ]),
            ),
          ]
        : []),
    );
  const bsBlocks = blocksOf(MODULE_ID, bs);
  const csBlocks = blocksOf(CS_MODULE_ID, cs);
  const half = (list: Uint8Array[], first: boolean) => {
    const mid = Math.ceil(list.length / 2);
    return first ? list.slice(0, mid) : list.slice(mid);
  };
  /** 1回目: DII と前半のブロックで切れる。2回目: DII の無いまま後半のブロック */
  const first = stream(
    head(true),
    ...half(bsBlocks, true),
    ...half(csBlocks, true),
  );
  const second = stream(
    head(false),
    ...half(bsBlocks, false),
    ...half(csBlocks, false),
  );

  test("読みかけを渡せば、DII の無い2回目でも続きから組み立てる", () => {
    const progress = new CarouselProgress();
    const before = new DsmccLogoCollector(progress);
    for (const packet of packets(first)) before.feed(packet);
    expect(before.collected()).toEqual([]);
    expect(before.carouselRead).toBe(false);

    // 開き直し。PAT・PMT はその中継のものを読み直す
    const after = new DsmccLogoCollector(progress);
    for (const packet of packets(second)) after.feed(packet);
    expect(
      after
        .collected()
        .flatMap((logo) => logo.services.map((s) => s.serviceId))
        .sort(),
    ).toEqual([211, 212, 330]);
    // 2回に分けて読んでも、知らされたモジュールが全部揃えば読み切ったことになる
    expect(after.carouselRead).toBe(true);
  });

  test("渡さなければ一から (2回目だけでは何も組み立てられない)", () => {
    const before = new DsmccLogoCollector();
    for (const packet of packets(first)) before.feed(packet);
    const after = new DsmccLogoCollector();
    for (const packet of packets(second)) after.feed(packet);
    expect(after.collected()).toEqual([]);
  });

  test("LogoCollector も同じ読みかけを使う", () => {
    const progress = new CarouselProgress();
    new LogoCollector(4, progress).feed(first);
    const collector = new LogoCollector(4, progress);
    collector.feed(second);
    expect(collector.satelliteCarouselRead).toBe(true);
    expect(collector.collected().map((f) => f.networkId)).toEqual([4, 4, 7]);
  });
});

describe("LogoCollector (衛星)", () => {
  test("ネットワークごとにまとめて返す", () => {
    // 1つのロゴが他ネットワークの局にも紐付いていることがある
    const module = logoModule(0x05, [
      {
        logoId: 3,
        services: [
          [4, 211],
          [6, 800],
        ],
        data: PNG,
      },
    ]);
    const collector = new LogoCollector(4);
    collector.feed(carousel(module, 4066));

    const found = collector.collected();
    expect(found).toHaveLength(2);
    expect(found.map((f) => [f.networkId, f.serviceIds])).toEqual([
      [4, [211]],
      [6, [800]],
    ]);
  });
});

/** 188 バイトずつに切り分ける。`DsmccLogoCollector` はパケット単位で食べる */
function* packets(data: Uint8Array): Generator<Uint8Array> {
  for (let at = 0; at + 188 <= data.length; at += 188)
    yield data.subarray(at, at + 188);
}
