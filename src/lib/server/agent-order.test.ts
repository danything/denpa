import { describe, expect, test } from "bun:test";

import { orderGroups, parsePlaces, placesKey } from "./agent-order";

/** 並んだ組を「エージェント:順位」で書く */
const order = (tuners: Parameters<typeof orderGroups>[0]) =>
  orderGroups(tuners).map((g) => `${g.agent}:${g.rank}`);

describe("全部のエージェントの組を 1 つの順に並べる", () => {
  test("エージェントが 1 台なら rank の順そのもの。無効なチューナーは入れない", () => {
    expect(
      order([
        { agent: 1, types: ["GR", "BS", "CS"], rank: 1 },
        { agent: 1, types: ["GR"], rank: 0 },
        { agent: 1, types: ["GR"], rank: 0 },
        { agent: 1, types: ["GR"], rank: null },
      ]),
    ).toEqual(["1:0", "1:1"]);
    expect(orderGroups([{ agent: 1, types: ["GR"], rank: 0 }])[0]?.count).toBe(
      1,
    );
  });

  test("受けられる種別がもう片方にすっかり含まれるなら、含まれるほう (狭いほう) を前にする", () => {
    expect(
      order([
        { agent: 1, types: ["GR", "BS", "CS"], rank: 0 },
        { agent: 2, types: ["GR"], rank: 0 },
      ]),
    ).toEqual(["2:0", "1:0"]);
  });

  test("含まれる関係が無いか同じ種別なら、エージェントの並びの順", () => {
    expect(
      order([
        { agent: 1, types: ["GR"], rank: 0 },
        { agent: 2, types: ["BS", "CS"], rank: 0 },
      ]),
    ).toEqual(["1:0", "2:0"]);
    expect(
      order([
        { agent: 2, types: ["GR"], rank: 0 },
        { agent: 1, types: ["GR"], rank: 0 },
      ]),
    ).toEqual(["2:0", "1:0"]);
  });

  test("同じエージェントの中の順は崩さない (エージェントが広いほうを前にしていても、その順を勝たせる)", () => {
    expect(
      order([
        { agent: 1, types: ["GR", "BS"], rank: 0 },
        { agent: 1, types: ["GR"], rank: 1 },
        { agent: 2, types: ["GR", "BS"], rank: 0 },
      ]),
    ).toEqual(["1:0", "1:1", "2:0"]);
  });

  test("兼用と専用が両方のエージェントにあれば、専用どうしが先、兼用どうしが後", () => {
    expect(
      order([
        { agent: 1, types: ["GR"], rank: 0 },
        { agent: 1, types: ["GR", "BS", "CS"], rank: 1 },
        { agent: 2, types: ["GR"], rank: 0 },
        { agent: 2, types: ["GR", "BS", "CS"], rank: 1 },
      ]),
    ).toEqual(["1:0", "2:0", "1:1", "2:1"]);
  });
});

describe("局を受けられる所の文字列", () => {
  test("書いたものを読み戻せる。タブの無い行はエージェントを決めていない所", () => {
    const places = [
      { agent: 1, channel: "T16" },
      { agent: 2, channel: "BS01:16400" },
    ];
    expect(parsePlaces(placesKey(places))).toEqual(places);
    expect(parsePlaces("T16")).toEqual([{ agent: null, channel: "T16" }]);
  });
});
