/**
 * **設定の「受信」の「エージェント」から、エージェントを登録・名前を変える・付け替える・削除する** (docs/agent.md「エージェントを足す」)。
 *
 * - 登録は登録用の URL (`https://ホスト:25252#pair=<合言葉>`) を貼るだけ。今と同じ手順で組み (`handshake`)、
 *   証明書を新しい行に保存する。**合言葉は DB にもログにも残さない** (組めたら捨てる。組み直しが要るときは URL を貼り直す)
 * - 環境変数 (`TUNER_AGENT_URL`) で決めたエージェントは、名前だけ変えられる。宛先と削除は環境変数が持ち主
 * - 登録・付け替え・削除のあとは、通知の購読 (`runtime.watchAgent`) と、カード・置き場の控えをそのエージェントの分だけ入れ替える
 */
import { and, asc, eq, max, ne } from "drizzle-orm";

import { sameVersion } from "../issue-report";
import { forgetAgentCard } from "./agent-cards";
import { forgetMissingAgents } from "./agent-channels";
import {
  AgentTrustError,
  fetchAgent,
  fetchAt,
  handshake,
  PairError,
  type PeerCert,
  refusedAsUnpaired,
} from "./agent-client";
import { agentDownSince } from "./agent-events";
import { aboutName, NAME_MAX } from "./agent-name";
import { type Agent, listAgents, parseAgentUrl } from "./agents";
import { config } from "./config";
import { orm } from "./db";
import { sync } from "./epg";
import { collectOnce } from "./epg-collect";
import { emit } from "./events";
import { unwatchAgent, watchAgent } from "./runtime";
import { agents } from "./schema";
import { forgetRawProbe, rawVisible } from "./scramble";
import { type AgentTuner, recordingOf } from "./tuner";

/** 画面に返す断り。`message` をそのまま出す */
export class AgentAdminError extends Error {}

/** 貼られた URL が読めないときの文 */
const URL_SHAPE = "https://ホスト:ポート#pair=… の形で貼ってください";

/** 登録・付け替えで貼られた URL を読む。`https://` でない・ホストが読めないときは形を言う */
function readUrl(raw: string): { origin: string; pair: string | null } {
  try {
    return parseAgentUrl(raw.trim());
  } catch {
    throw new AgentAdminError(URL_SHAPE);
  }
}

/** 行。画面から見える列だけ */
function rowOf(id: number) {
  return orm()
    .select({
      id: agents.id,
      name: agents.name,
      origin: agents.origin,
      cert: agents.cert,
      from_env: agents.from_env,
    })
    .from(agents)
    .where(eq(agents.id, id))
    .get();
}

/** 同じ宛先か同じ証明書の、ほかの行があれば断る */
function refuseDuplicate(
  match: { origin?: string; fingerprint?: string },
  except: number | null,
): void {
  const where =
    match.origin !== undefined
      ? eq(agents.origin, match.origin)
      : eq(agents.fingerprint, match.fingerprint!);
  const other = orm()
    .select({ name: agents.name, from_env: agents.from_env })
    .from(agents)
    .where(except === null ? where : and(where, ne(agents.id, except)))
    .get();
  if (other === undefined) return;
  throw new AgentAdminError(
    other.from_env
      ? `このエージェントは環境変数 (TUNER_AGENT_URL) で登録してあります (${other.name})`
      : `このエージェントはもう登録してあります (${other.name})`,
  );
}

/** 合言葉で組む。組めなければ、何をしたらどうなったかの文にして断る */
async function pairWith(origin: string, token: string): Promise<PeerCert> {
  try {
    return await handshake(origin, token);
  } catch (error) {
    if (!(error instanceof PairError)) throw error;
    if (error.kind === "unreachable") {
      const host = new URL(origin).host;
      throw new AgentAdminError(
        `${host} に繋がりません。この denpa から届く名前か IP アドレスに書き換えてください`,
      );
    }
    // 合言葉が違う・断られた。エージェントが返した文のまま
    throw new AgentAdminError(error.message);
  }
}

/** 入れ替わったエージェントの控えを捨て、購読を繋ぎ直し、局を取り込み直す (待たない) */
function refresh(agent: Agent): void {
  forgetAgentCard(agent.id);
  forgetRawProbe(agent.id);
  watchAgent(agent);
  emit("tuners");
  // 置き場が見えるかは、登録・付け替えのときに確かめる (後から復号させる先を選ぶとき、待たずに済む)
  void rawVisible(agent);
  void (async () => {
    try {
      await sync(agent);
      await collectOnce();
    } catch (error) {
      console.warn(
        `[agent] ${agent.name} のチャンネルを取り込めませんでした: ${error}`,
      );
    }
  })();
}

/** 行の ID から、呼ぶ先のエージェント (並びの全部から引く) */
function agentOf(id: number): Agent {
  const agent = listAgents().find((a) => a.id === id);
  if (agent === undefined)
    throw new AgentAdminError("このエージェントはもうありません");
  return agent;
}

/**
 * **登録する。** 貼られた URL で組み、証明書を新しい行に保存する。名前は `/denpa/about` の `name`、無ければホスト名。
 * 並びは最後 (環境変数のものより後ろ)
 */
export async function addAgent(raw: string): Promise<Agent> {
  const { origin, pair } = readUrl(raw);
  refuseDuplicate({ origin }, null);
  if (pair === null) {
    throw new AgentAdminError(
      "合言葉 (#pair=…) が入っていません。エージェントが出した URL をそのまま貼ってください",
    );
  }
  const peer = await pairWith(origin, pair);
  refuseDuplicate({ fingerprint: peer.fingerprint }, null);
  const id = orm().transaction((tx) => {
    const last =
      tx
        .select({ position: max(agents.position) })
        .from(agents)
        .get()?.position ?? -1;
    return tx
      .insert(agents)
      .values({
        name: new URL(origin).hostname,
        origin,
        cert: peer.cert,
        fingerprint: peer.fingerprint,
        from_env: false,
        position: last + 1,
        added_at: Date.now(),
      })
      .returning({ id: agents.id })
      .get().id;
  });
  let agent = agentOf(id);
  const name = await aboutName(agent);
  if (name !== null) {
    orm().update(agents).set({ name }).where(eq(agents.id, id)).run();
    agent = { ...agent, name };
  }
  console.log(
    `[agent] エージェント (${agent.name}・${peer.fingerprint.slice(0, 16)}) を登録しました`,
  );
  refresh(agent);
  return agent;
}

/** **名前を変える。** 画面に出すだけで、エージェントには送らない。環境変数のエージェントも変えられる */
export function renameAgent(id: number, raw: string): void {
  const name = raw.trim();
  if (name === "") throw new AgentAdminError("名前は空にできません");
  if (name.length > NAME_MAX)
    throw new AgentAdminError(`名前は ${NAME_MAX} 字までにしてください`);
  if (rowOf(id) === undefined)
    throw new AgentAdminError("このエージェントはもうありません");
  orm().update(agents).set({ name }).where(eq(agents.id, id)).run();
  // 繋がった・繋がらないの通知 (Webhook) に新しい名前を入れるため、購読を繋ぎ直す
  watchAgent(agentOf(id));
  emit("tuners");
}

/**
 * **付け替える** (「URL を変える」)。証明書が同じ (アドレスだけ変わった) なら、新しいアドレスで保存した証明書のまま繋がれば宛先だけ書き換える。
 * 証明書が違う (機材を入れ替えた・`tls/` を消した) なら `#pair=` で組み直し、証明書を差し替える。名前と並びは残す
 */
export async function moveAgent(id: number, raw: string): Promise<Agent> {
  const row = rowOf(id);
  if (row === undefined)
    throw new AgentAdminError("このエージェントはもうありません");
  if (row.from_env) {
    throw new AgentAdminError(
      "環境変数 (TUNER_AGENT_URL) で決めたエージェントの URL は、環境変数で変えます",
    );
  }
  const { origin, pair } = readUrl(raw);
  refuseDuplicate({ origin }, id);
  let peer: PeerCert | null = null;
  if (pair !== null) {
    peer = await pairWith(origin, pair);
    refuseDuplicate({ fingerprint: peer.fingerprint }, id);
  } else {
    if (row.cert === null) {
      throw new AgentAdminError(
        "合言葉 (#pair=…) が入っていません。エージェントが出した URL をそのまま貼ってください",
      );
    }
    let res: Response;
    try {
      res = await fetchAt(origin, row.cert, "/denpa/about", {
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (error instanceof AgentTrustError) {
        throw new AgentAdminError(
          "証明書が変わりました。エージェントが出した登録用の URL (#pair=… の入ったもの) を貼ってください",
        );
      }
      throw new AgentAdminError(
        `${new URL(origin).host} に繋がりません。この denpa から届く名前か IP アドレスに書き換えてください`,
      );
    }
    // 同じ証明書のエージェントだが、この denpa の登録が消えている (`tls/clients` から消された)。組み直すには合言葉が要る
    if (await refusedAsUnpaired(res)) {
      throw new AgentAdminError(
        "エージェントにこの denpa の登録がありません。エージェントが出した登録用の URL (#pair=… の入ったもの) を貼ってください",
      );
    }
    if (!res.ok) {
      throw new AgentAdminError(
        `${new URL(origin).host} のエージェントが答えませんでした (${res.status})`,
      );
    }
  }
  orm()
    .update(agents)
    .set(
      peer === null
        ? { origin }
        : { origin, cert: peer.cert, fingerprint: peer.fingerprint },
    )
    .where(eq(agents.id, id))
    .run();
  const agent = agentOf(id);
  console.log(`[agent] ${agent.name} の宛先を変えました`);
  refresh(agent);
  return agent;
}

/** 削除の結果。`reached` が false なら、エージェントの側にこの denpa の登録が残っている */
export interface Removed {
  name: string;
  reached: boolean;
}

/**
 * **削除する。** エージェントに `DELETE /denpa/pair` を送り、エージェントの `tls/clients` からこの denpa を消させてから行を消す。
 * 届かなくても行は消す。環境変数で決めたエージェントは消せない (環境変数から消すと、次の起動で行も消える)
 */
export async function removeAgent(id: number): Promise<Removed> {
  const row = rowOf(id);
  if (row === undefined)
    throw new AgentAdminError("このエージェントはもうありません");
  if (row.from_env) {
    throw new AgentAdminError(
      "環境変数 (TUNER_AGENT_URL) で決めたエージェントは、環境変数から消すと外れます",
    );
  }
  const agent = agentOf(id);
  let reached = false;
  try {
    const res = await fetchAgent(agent, "/denpa/pair", {
      method: "DELETE",
      signal: AbortSignal.timeout(5000),
    });
    // 古いエージェントは知らない API に 404 を返す。登録は残る
    reached = res.ok;
  } catch {
    reached = false;
  }
  unwatchAgent(id);
  orm().transaction((tx) => {
    tx.delete(agents).where(eq(agents.id, id)).run();
    // 外部キーは効かせていないので、チャンネルの写しと受信の記録も一緒に消す (`agents.syncEnvAgents` と同じ)
    forgetMissingAgents();
  });
  forgetAgentCard(id);
  forgetRawProbe(id);
  console.log(
    `[agent] エージェント (${row.name}) を削除しました${reached ? "" : " (エージェントには届きませんでした)"}`,
  );
  emit("tuners");
  // 局の取り込み直し。そのエージェントでしか受けられない局は、次の取り込みから数えて片付く (SERVICE_FORGET_AFTER)
  if (listAgents().length > 0) {
    void sync().catch((error: unknown) => {
      console.warn(`[agent] 局を取り込み直せませんでした: ${error}`);
    });
  }
  return { name: row.name, reached };
}

/** 設定の「エージェント」の 1 行 (すぐ返せるもの) */
export interface AgentEntry {
  id: number;
  name: string;
  /** 宛先のホスト (ポートを付けるのは既定の 25252 でないときだけ) */
  host: string;
  /** 環境変数 (`TUNER_AGENT_URL`) で決めたものか。削除と URL を変えるのは環境変数で */
  fromEnv: boolean;
}

/** 並びの順の全部の行。`TUNER_AGENT_URL` が読めなければ、DB の行のまま */
export function agentEntries(): AgentEntry[] {
  try {
    listAgents();
  } catch {
    // 突き合わせられなくても、前の行は出す (読めない理由はエージェントを呼ぶところで出る)
  }
  return orm()
    .select({
      id: agents.id,
      name: agents.name,
      origin: agents.origin,
      from_env: agents.from_env,
    })
    .from(agents)
    .orderBy(asc(agents.position), asc(agents.id))
    .all()
    .map((row) => {
      const url = new URL(row.origin);
      return {
        id: row.id,
        name: row.name,
        host: url.port === "25252" ? url.hostname : url.host,
        fromEnv: row.from_env,
      };
    });
}

/**
 * 1 台の様子 (エージェントに訊くもの。画面には後から流し込む)。
 *
 * - `trouble` は保存した証明書で繋がらない (`changed`) か、エージェントに組んでいないと断られた (`unpaired`)。どちらも URL を貼り直してもらう
 * - `downSince` は猶予 (3 分) を超えて繋がらないときの、繋がらなくなった時刻。猶予の中は null (一瞬の切れで出さない)
 * - `rawVisible` は元の TS の置き場が見えるか (`scramble.rawVisible`。null は確かめられない)
 */
export interface AgentState {
  id: number;
  version: string | null;
  /** denpa とバージョンが違うか */
  versionDiffers: boolean;
  /** チューナーの台数。訊けなければ null */
  tuners: number | null;
  trouble: "changed" | "unpaired" | null;
  downSince: number | null;
  rawVisible: boolean | null;
  /** このエージェントで録画している番組の名前 (削除の確かめに出す) */
  recordings: string[];
}

/** エージェントの `/denpa/about` を読む。証明書が変わった・組んでいないと断られたなら `trouble` */
async function readAbout(
  agent: Agent,
): Promise<{ version: string | null; trouble: AgentState["trouble"] }> {
  try {
    const res = await fetchAgent(agent, "/denpa/about", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (await refusedAsUnpaired(res))
      return { version: null, trouble: "unpaired" };
    if (!res.ok) return { version: null, trouble: null };
    const body = (await res.json().catch(() => null)) as {
      version?: unknown;
    } | null;
    return {
      version: typeof body?.version === "string" ? body.version : null,
      trouble: null,
    };
  } catch (error) {
    if (error instanceof AgentTrustError)
      return { version: null, trouble: error.kind };
    return { version: null, trouble: null };
  }
}

/**
 * 1 台の様子を訊く。`list` はそのエージェントのチューナーの一覧 (チューナーの表と同じものを 1 度だけ訊く。`tuners.server.ts`)。
 * 録画の名前は `nameOf` で引く (録画 ID → 番組名)
 */
export async function agentState(
  agent: Agent,
  list: Promise<AgentTuner[]>,
  nameOf: (recording: number) => string | null,
): Promise<AgentState> {
  const [about, tuners, raw] = await Promise.all([
    readAbout(agent),
    list.catch(() => null),
    rawVisible(agent).catch(() => null),
  ]);
  const recordings = new Set<string>();
  for (const tuner of tuners ?? []) {
    for (const user of tuner.users) {
      const id = recordingOf(user.use);
      const name = id === null ? null : nameOf(id);
      if (name !== null) recordings.add(name);
    }
  }
  return {
    id: agent.id,
    version: about.version,
    versionDiffers:
      about.version !== null && !sameVersion(config.version, about.version),
    tuners: tuners?.length ?? null,
    trouble: about.trouble,
    downSince: tuners === null ? agentDownSince(agent.id) : null,
    rawVisible: about.trouble === null && tuners !== null ? raw : null,
    recordings: [...recordings],
  };
}

/** 付け替えを試した時刻 (`agents.id` →)。偽の答えが続いても、繋ぎに行くのは 1 台 5 分に 1 回まで */
const followTried = new Map<number, number>();
const FOLLOW_GAP = 5 * 60_000;

/**
 * **登録したエージェントのアドレスが変わったら付け替える** (LAN で見つけたとき。`agent-mdns.ts`)。
 *
 * - 見つけたものの `id` (証明書の指紋の先頭 16 字) と指紋が合う、画面から登録した行だけを見る。環境変数のものは環境変数が持ち主なので追わない
 * - 今の宛先で保存した証明書のまま繋がるなら何もしない (名前で登録していて、名前がまだ引けるとき)
 * - 繋がらなければ、新しいアドレスで**保存した証明書のまま繋がったときだけ**宛先を書き換える (`moveAgent` の `#pair=` の無い付け替えと同じ)。
 *   `id` が合うだけの偽の答えでは書き換わらない
 */
export async function followAgent(found: {
  id: string;
  host: string;
  port: number;
}): Promise<boolean> {
  const origin = `https://${found.host}:${found.port}`;
  const row = orm()
    .select({
      id: agents.id,
      name: agents.name,
      origin: agents.origin,
      cert: agents.cert,
      fingerprint: agents.fingerprint,
    })
    .from(agents)
    .where(eq(agents.from_env, false))
    .all()
    .find(
      (agent) =>
        agent.cert !== null && agent.fingerprint?.startsWith(found.id) === true,
    );
  if (row === undefined || row.cert === null || row.origin === origin)
    return false;
  const now = Date.now();
  if (now - (followTried.get(row.id) ?? 0) < FOLLOW_GAP) return false;
  followTried.set(row.id, now);
  try {
    await fetchAt(row.origin, row.cert, "/denpa/about", {
      signal: AbortSignal.timeout(5000),
    });
    return false;
  } catch {
    // 今の宛先では繋がらない (アドレスが変わった・ほかの機械が答えた)
  }
  try {
    await moveAgent(row.id, origin);
  } catch (error) {
    console.warn(
      `[agent] ${row.name} を LAN で ${found.host} に見つけましたが、付け替えられませんでした: ${error instanceof Error ? error.message : error}`,
    );
    return false;
  }
  console.log(
    `[agent] ${row.name} のアドレスが変わったため、${new URL(origin).host} に付け替えました`,
  );
  return true;
}

/** 試験から。付け替えを試した時刻を忘れる */
export function forgetFollowTries(): void {
  followTried.clear();
}

/** LAN で見つけたもののうち、まだ登録していないもの (指紋の先頭が、どの行の指紋とも合わない)。環境変数のものも登録済みに数える */
export function unregistered<T extends { id: string }>(found: T[]): T[] {
  const prints = orm()
    .select({ fingerprint: agents.fingerprint })
    .from(agents)
    .all()
    .flatMap((row) => (row.fingerprint === null ? [] : [row.fingerprint]));
  return found.filter(
    (agent) => !prints.some((print) => print.startsWith(agent.id)),
  );
}
