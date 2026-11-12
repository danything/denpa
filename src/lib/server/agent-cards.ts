/**
 * **エージェントごとのカード** (docs/architecture.md「エージェントを何台もつなぐ」)。
 *
 * どのカードで復号するかは、エージェントの `/denpa/card` から読む。手元のカード (`source: local`) ならそのカードの番号、
 * 鍵を配る相手から貰う (`source: remote`。`CARD_URL`) なら配る相手のカードの番号 (`scramble.getActiveCardId`)。
 * カードも `CARD_URL` も無い・カードを読めない・繋がらないエージェントは、復号に使うカードが無い (`card` が null)。
 *
 * 有料の局の選局はこれで振り分け (`tuner.route` の手順 1)、契約を確かめる先 (`contracts.checkContracts`) もこれで選ぶ
 */
import { and, eq, inArray } from "drizzle-orm";

import { type Agent, listAgents } from "./agents";
import { contractStatus } from "./contract-status";
import { orm } from "./db";
import { cardContracts } from "./schema";
import { type CardStatus, cardStatus, getActiveCardId } from "./scramble";

/** 1 台のエージェントのカード */
export interface AgentCard {
  /** `agents.id` */
  agent: number;
  /** 復号に使うカードの番号 (16 桁)。使えるカードが無ければ null */
  card: string | null;
  /** カードを手元に持つ (`source: local`)。false なら鍵を配る相手から貰う */
  local: boolean;
  /** `/denpa/card` の答え。繋がらなければ読めなかった理由が `message` に入る */
  status: CardStatus;
}

/** `/denpa/card` の答えから。カードを読めていない (`ok` が false) なら、番号が見えていても復号には使えない */
export function cardOf(agent: number, status: CardStatus): AgentCard {
  return {
    agent,
    card: status.ok ? getActiveCardId(status) : null,
    local: status.source === "local",
    status,
  };
}

/** 全部のエージェントのカードを、並びの順にその場で読む (契約を確かめるとき) */
export async function readAgentCards(
  agents: readonly Agent[] = listAgents(),
): Promise<AgentCard[]> {
  return Promise.all(
    agents.map(async (agent) => cardOf(agent.id, await cardStatus(agent))),
  );
}

/**
 * **カードごとに、契約を確かめる (`POST /denpa/card/confirm`) エージェント。** そのカードを手元に持つエージェントのうち並びの先のもの。
 * 手元に持つエージェントを登録していなければ (配る側のエージェントを denpa に繋いでいない)、そのカードから鍵を貰うエージェントのうち並びの先のもの
 * (貰う側のエージェントは、契約の問い合わせも配る側へ渡す)。並びはカードを初めて見た順 (`cards` の順)
 */
export function contractAgents(
  cards: readonly AgentCard[],
): Map<string, number> {
  const holders = new Map<string, number>();
  for (const local of [true, false])
    for (const entry of cards)
      if (
        entry.card !== null &&
        entry.local === local &&
        !holders.has(entry.card)
      )
        holders.set(entry.card, entry.agent);
  const order = [
    ...new Set(cards.flatMap((c) => (c.card === null ? [] : [c.card]))),
  ];
  return new Map(order.map((card) => [card, holders.get(card)!]));
}

/**
 * 振り分けで読んだカードの控え (メモリだけ)。選局のたびに全部のエージェントへ訊くと待たせるので、`CARD_KEEP` のあいだ使い回す。
 * カードの通知 (`card`) と、エージェントに繋がり直したときに捨てる (`forgetAgentCard`)。読めなかった答えは控えない
 */
const kept = new Map<number, { card: AgentCard; at: number }>();

/** 振り分けで読んだカードを使い回す長さ (ms) */
const CARD_KEEP = 60_000;

/** カードの控えを捨てる。`agent` を渡さなければ全部 */
export function forgetAgentCard(agent?: number): void {
  if (agent === undefined) kept.clear();
  else kept.delete(agent);
}

/**
 * 振り分けに使うカード。控えが新しければそれ、無ければ `wait` ミリ秒まで待って訊く。
 * 訊けなかったエージェントは、使えるカードが無いものとして返す (そのエージェントは一覧も返さないので、振り分けにも入らない)
 */
async function routeCards(
  agents: readonly number[],
  wait: number,
): Promise<Map<number, AgentCard>> {
  const now = Date.now();
  const all = new Map(listAgents().map((agent) => [agent.id, agent]));
  const got = await Promise.all(
    agents.map(async (id) => {
      const entry = kept.get(id);
      if (entry !== undefined && now - entry.at < CARD_KEEP) return entry.card;
      const agent = all.get(id);
      if (agent === undefined) return null;
      const status = await cardStatus(agent, wait);
      const card = cardOf(id, status);
      // 繋がらなかった・読めなかった答えは控えない (次の選局で訊き直す)
      if (status.ok) kept.set(id, { card, at: Date.now() });
      return card;
    }),
  );
  return new Map(
    got.flatMap((card) => (card === null ? [] : [[card.agent, card]])),
  );
}

/**
 * **有料の局を、そのエージェントで復号できる見込みの順** (小さいほど先)。振り分けは、いちばん小さいエージェントに絞る (`tuner.route` の手順 1)。
 *
 * | 順 | エージェント                                                                  |
 * | -- | ----------------------------------------------------------------------------- |
 * | 0  | 復号に使うカードで、その局を契約中と確かめた                                  |
 * | 1  | 復号に使うカードはあるが、その局の契約を確かめていない (無料の局はみなここ)   |
 * | 2  | 復号に使うカードで、その局は未契約か期限切れと確かめた                        |
 * | 3  | 復号に使うカードが無い (カードも `CARD_URL` も無い・読めない)                 |
 *
 * どのエージェントも同じカードなら (勧めている組み方。カードは世帯で 1 枚)、カードを使える所はみな同じ順になり、絞っても変わらない。
 * `statusOf` はカードの番号から、その局の契約の状態 (`contract-status.contractStatus`。行が無ければ null)
 */
export function cardRanks(
  cards: Iterable<AgentCard>,
  statusOf: (card: string) => ReturnType<typeof contractStatus> | null,
): Map<number, number> {
  const ranks = new Map<number, number>();
  for (const entry of cards) {
    if (entry.card === null) {
      ranks.set(entry.agent, 3);
      continue;
    }
    const status = statusOf(entry.card);
    ranks.set(
      entry.agent,
      status === "subscribed"
        ? 0
        : status === "unsubscribed" || status === "expired"
          ? 2
          : 1,
    );
  }
  return ranks;
}

/** 局 `service` (`services.id`) の契約の状態を、カードごとに */
function contractsOf(
  service: number,
  cards: readonly string[],
): Map<string, ReturnType<typeof contractStatus>> {
  if (cards.length === 0) return new Map();
  const now = Date.now();
  return new Map(
    orm()
      .select({
        card: cardContracts.card_id,
        state: cardContracts.state,
        code: cardContracts.code,
        decodeOk: cardContracts.decode_ok,
        decodedAt: cardContracts.decoded_at,
      })
      .from(cardContracts)
      .where(
        and(
          eq(cardContracts.service_id, service),
          inArray(cardContracts.card_id, [...cards]),
        ),
      )
      .all()
      .map((row) => [row.card, contractStatus(row, now)]),
  );
}

/**
 * **局 `service` を、エージェント `agents` のどれで復号できる見込みか** (`cardRanks`)。振り分け (`tuner.openChannel`) が、
 * 局を受けられるエージェントが 2 台以上あるときだけ呼ぶ。カードは控え (`CARD_KEEP`) を使い、無ければ `wait` ミリ秒まで待って訊く
 */
export async function keyRanks(
  service: number,
  agents: readonly number[],
  wait: number,
): Promise<Map<number, number>> {
  const cards = await routeCards(agents, wait);
  const contracts = contractsOf(service, [
    ...new Set(
      [...cards.values()].flatMap((c) => (c.card === null ? [] : [c.card])),
    ),
  ]);
  return cardRanks(cards.values(), (card) => contracts.get(card) ?? null);
}

/** 局を受けられる所 (`agent-order.placesKey`) を、カードの順で絞る関数。局の ID と受けられる所の文字列を受け、絞った文字列を返す */
export type CardNarrow = (service: number, places: string) => string;

/**
 * **予約の割り振り (`conflict.ts`) とルールの下見が、振り分け (`tuner.route` の手順 1) と同じ順で受けられる所を絞るための関数。**
 * 割り振りは同期で数えるので、先にカードを読んでおき (控えが新しければ訊かない。`routeCards`)、あとは控えだけで決める。
 * 受けられるエージェントが 1 台の局は絞らない (振り分けも訊かずに送る)。エージェントが 1 台なら何もしない
 */
export async function cardNarrower(
  agents: readonly number[],
  wait: number,
): Promise<CardNarrow> {
  if (agents.length <= 1) return (_service, places) => places;
  const cards = await routeCards(agents, wait);
  const memo = new Map<string, string>();
  return (service, places) => {
    const key = `${service}\n${places}`;
    let narrowed = memo.get(key);
    if (narrowed === undefined) {
      const contracts = contractsOf(service, [
        ...new Set(
          [...cards.values()].flatMap((c) => (c.card === null ? [] : [c.card])),
        ),
      ]);
      narrowed = narrowPlaces(
        places,
        cards,
        (card) => contracts.get(card) ?? null,
      );
      memo.set(key, narrowed);
    }
    return narrowed;
  };
}

/**
 * `cardNarrower` の中身。受けられる所のうち、その局を復号できる見込みのいちばん高いエージェントのものだけを残す。
 * `statusOf` はカードの番号から、その局の契約の状態 (`cardRanks` と同じ)
 */
export function narrowPlaces(
  places: string,
  cards: ReadonlyMap<number, AgentCard>,
  statusOf: (card: string) => ReturnType<typeof contractStatus> | null,
): string {
  const lines = places.split("\n");
  const agentOf = (line: string): number | null => {
    const tab = line.indexOf("\t");
    return tab < 0 ? null : Number(line.slice(0, tab));
  };
  const ids = new Set(
    lines.flatMap((line) => {
      const agent = agentOf(line);
      return agent === null ? [] : [agent];
    }),
  );
  if (ids.size <= 1) return places;
  const mine = [...ids].flatMap((id) => {
    const card = cards.get(id);
    return card === undefined ? [] : [card];
  });
  const ranks = cardRanks(mine, statusOf);
  // 訊けなかったエージェントは、使えるカードが無いものとして数える (振り分けと同じ)
  const rank = (id: number) => ranks.get(id) ?? 3;
  const best = Math.min(...[...ids].map(rank));
  return lines
    .filter((line) => {
      const agent = agentOf(line);
      return agent === null || rank(agent) === best;
    })
    .join("\n");
}
