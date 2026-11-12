import { describe, expect, test } from "bun:test";

import { type AgentCard, cardRanks, contractAgents } from "./agent-cards";
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
