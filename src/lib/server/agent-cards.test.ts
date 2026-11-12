import { describe, expect, test } from "bun:test";

import {
  type AgentCard,
  cardRanks,
  contractAgents,
  narrowPlaces,
} from "./agent-cards";
import type { CardStatus } from "./scramble";

const STATUS: CardStatus = {
  ok: true,
  message: "",
  source: "local",
  ids: [],
  tuners: [],
  readers: [],
};

/** エージェント `agent` のカード。`card` が null ならカードが無い */
function card(agent: number, id: string | null, local = true): AgentCard {
  return { agent, card: id, local, status: STATUS };
}

describe("有料の局を復号できる見込みの順 (cardRanks)", () => {
  test("契約中、確かめていない、未契約・期限切れ、カード無しの順", () => {
    const status = new Map([
      ["X", "subscribed" as const],
      ["Y", "unsubscribed" as const],
      ["Z", "expired" as const],
    ]);
    const ranks = cardRanks(
      [card(1, "X"), card(2, "W"), card(3, "Y"), card(4, "Z"), card(5, null)],
      (id) => status.get(id) ?? null,
    );
    expect([...ranks]).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 2],
      [5, 3],
    ]);
  });

  test("カードが 1 枚なら、カードを使えるエージェントはみな同じ順", () => {
    const ranks = cardRanks(
      [card(1, "X"), card(2, "X", false), card(3, null)],
      () => "unverified",
    );
    expect([...ranks]).toEqual([
      [1, 1],
      [2, 1],
      [3, 3],
    ]);
  });
});

describe("契約を確かめるエージェント (contractAgents)", () => {
  test("カードを手元に持つエージェントを、鍵を貰うエージェントより先にする", () => {
    expect([
      ...contractAgents([card(1, "X", false), card(2, "X"), card(3, "Y")]),
    ]).toEqual([
      ["X", 2],
      ["Y", 3],
    ]);
  });

  test("手元に持つエージェントが無ければ、鍵を貰うエージェントのうち並びの先", () => {
    expect([
      ...contractAgents([
        card(1, null),
        card(2, "X", false),
        card(3, "X", false),
      ]),
    ]).toEqual([["X", 2]]);
  });

  test("カードを使えるエージェントが無ければ空", () => {
    expect(contractAgents([card(1, null)]).size).toBe(0);
  });
});

describe("予約の割り振りで受けられる所を絞る (narrowPlaces)", () => {
  const places = "1\tT16\n2\tT16\n3\tT27";
  const cards = new Map([
    [1, card(1, "X")],
    [2, card(2, "Y")],
    [3, card(3, null)],
  ]);

  test("その局を復号できる見込みのいちばん高いエージェントの所だけを残す (振り分けと同じ順)", () => {
    const status = new Map([["X", "subscribed" as const]]);
    expect(narrowPlaces(places, cards, (id) => status.get(id) ?? null)).toBe(
      "1\tT16",
    );
  });

  test("カードがどれも同じ順なら絞らず、カードの無いエージェントだけを外す", () => {
    expect(narrowPlaces(places, cards, () => null)).toBe("1\tT16\n2\tT16");
  });

  test("訊けなかったエージェントはカードが無いものとして数え、受けられるエージェントが 1 台なら絞らない", () => {
    expect(narrowPlaces("1\tT16\n4\tT16", cards, () => null)).toBe("1\tT16");
    expect(narrowPlaces("4\tT16", cards, () => null)).toBe("4\tT16");
    expect(narrowPlaces("#12", cards, () => null)).toBe("#12");
  });
});
