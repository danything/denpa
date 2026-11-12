/**
 * **つないだエージェントの一覧** (DB の `agents`。docs/agent.md「組む」)。
 *
 * - `TUNER_AGENT_URL` はカンマで区切って何台でも書ける。書いたものは起動のたびに行と突き合わせ、
 *   URL (`#` の前) が同じ行があればそれを使い、無ければ行を足す。**環境変数から消したものは行も消す**
 * - 組むときの合言葉 (`#pair=`) は DB に持たない。環境変数から読む
 * - 通知の購読・ログ・バージョンと、チャンネルの控えを読むのは全部の行 (`listAgents`)。選局とチューナーの一覧と、
 *   スキャンの結果を預けるのは `tuningAgents`。カード・復号は並びの先頭の 1 台 (`primaryAgent`) に送る
 */
import { and, asc, eq, inArray, ne } from "drizzle-orm";

import { forgetMissingAgents } from "./agent-channels";
import { config } from "./config";
import { orm } from "./db";
import { agents } from "./schema";

/** `TUNER_AGENT_URL` の 1 台ぶんを、送る先 (`origin`) と合言葉に分けたもの */
export interface AgentTarget {
  /** `https://host:port` (ホスト名は小文字。末尾の `/` と `#` から後ろは除く) */
  origin: string;
  /** `#pair=` の値。無ければ null */
  pair: string | null;
}

/** 呼ぶ先のエージェント。DB の行と、環境変数から読んだ合言葉 */
export interface Agent {
  id: number;
  name: string;
  origin: string;
  /** 組むときの合言葉。環境変数に書いたものにだけある */
  pair: string | null;
}

/** `TUNER_AGENT_URL` の 1 台ぶんを読む。`https://` でなければ誤り */
export function parseAgentUrl(raw: string): AgentTarget {
  const hash = raw.indexOf("#");
  const base = (hash < 0 ? raw : raw.slice(0, hash)).replace(/\/+$/, "");
  const fragment = hash < 0 ? "" : raw.slice(hash + 1);
  if (!/^https:\/\//i.test(base)) {
    throw new Error(
      "TUNER_AGENT_URL は https:// で書きます (エージェントとは TLS で繋ぎます。docs/agent.md)",
    );
  }
  if (!URL.canParse(base) || new URL(base).hostname === "") {
    throw new Error(
      `TUNER_AGENT_URL のホストが読めません (${base})。https://ホスト:ポート の形で書きます (docs/agent.md)`,
    );
  }
  // 大文字と小文字だけが違うホスト名を別の行にしない (`https://Host` と `https://host`)
  const url = new URL(base);
  const origin = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  const pair = new URLSearchParams(fragment).get("pair");
  return { origin, pair: pair && pair.length > 0 ? pair : null };
}

/** `TUNER_AGENT_URL` の項目 (カンマ区切り。空の項目は飛ばす) */
function entries(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * `TUNER_AGENT_URL` を全部読む。空なら環境変数のエージェントは無い。
 * 同じ URL を 2 回書いたものは、前のものだけを使う
 */
export function parseAgentUrls(raw: string): AgentTarget[] {
  const out: AgentTarget[] = [];
  for (const entry of entries(raw)) {
    const target = parseAgentUrl(entry);
    if (out.some((t) => t.origin === target.origin)) continue;
    out.push(target);
  }
  return out;
}

/** 不具合報告で伏せる値 (合言葉)。読めない項目があっても、読める項目の合言葉は伏せる */
export function agentSecrets(): string[] {
  const out: string[] = [];
  for (const entry of entries(config.agentUrl)) {
    const hash = entry.indexOf("#");
    if (hash < 0) continue;
    const pair = new URLSearchParams(entry.slice(hash + 1)).get("pair");
    if (pair) out.push(pair);
  }
  return out;
}

/** エージェントの宛先のホスト名 (不具合報告で伏せるため)。環境変数に書いたものと、DB の全部の行 */
export function agentHostnames(): string[] {
  const out = new Set<string>();
  for (const entry of entries(config.agentUrl)) {
    try {
      out.add(new URL(parseAgentUrl(entry).origin).hostname);
    } catch {
      // 読めない項目は宛先にならない
    }
  }
  try {
    for (const row of orm()
      .select({ origin: agents.origin })
      .from(agents)
      .all())
      out.add(new URL(row.origin).hostname);
  } catch {
    // DB が読めなくても、環境変数のぶんは伏せる
  }
  return [...out];
}

/** 行の名前。今は URL のホスト名 */
function nameOf(origin: string): string {
  return new URL(origin).hostname;
}

/** 突き合わせた環境変数と DB。どちらかが変われば突き合わせ直す (テストは `config` を差し替える) */
let synced: { raw: string; db: string; pairs: Map<string, string> } | null =
  null;

/**
 * `TUNER_AGENT_URL` と `agents` の行を突き合わせる。起動したときに呼ぶ。
 * 読めない項目があれば、行を何も変えずにエラーを送出する (1 つの書き間違いで、ほかの行の保存した証明書を消さないため)
 */
export function syncEnvAgents(): void {
  const raw = config.agentUrl;
  const targets = parseAgentUrls(raw);
  const removed = orm().transaction((tx) => {
    const env = tx.select().from(agents).where(eq(agents.from_env, true)).all();
    const keep = new Set(targets.map((t) => t.origin));
    const gone = env.filter((row) => !keep.has(row.origin));
    if (gone.length > 0) {
      tx.delete(agents)
        .where(
          inArray(
            agents.id,
            gone.map((row) => row.id),
          ),
        )
        .run();
      // 外部キーは効かせていないので、そのエージェントのチャンネルの写しと受信の記録もここで消す
      forgetMissingAgents();
    }
    targets.forEach((target, position) => {
      const row = env.find((r) => r.origin === target.origin);
      if (row === undefined) {
        tx.insert(agents)
          .values({
            name: nameOf(target.origin),
            origin: target.origin,
            from_env: true,
            position,
            added_at: Date.now(),
          })
          .run();
      } else if (row.position !== position) {
        tx.update(agents).set({ position }).where(eq(agents.id, row.id)).run();
      }
    });
    // 環境変数に書いたものの後ろに、ほかの行を元の並びのまま置く
    const others = tx
      .select({ id: agents.id, position: agents.position })
      .from(agents)
      .where(eq(agents.from_env, false))
      .orderBy(asc(agents.position), asc(agents.id))
      .all();
    others.forEach((row, i) => {
      const position = targets.length + i;
      if (row.position !== position) {
        tx.update(agents).set({ position }).where(eq(agents.id, row.id)).run();
      }
    });
    return gone;
  });
  for (const row of removed) {
    console.log(
      `[agent] TUNER_AGENT_URL から消えたエージェント (${row.origin}) の行を消しました`,
    );
  }
  if (targets.length > 1) {
    console.warn(
      `[agent] TUNER_AGENT_URL に ${targets.length} 台書いてありますが、選局に使うのは最初の 1 台 (${targets[0]!.origin}) だけです`,
    );
  }
  const pairs = new Map<string, string>();
  for (const t of targets) if (t.pair !== null) pairs.set(t.origin, t.pair);
  synced = { raw, db: config.dbPath, pairs };
}

/**
 * 起動したときの突き合わせ。**読めない書き方でも起動は止めず**、理由をログに出す
 * (エージェントを呼ぶたびに同じ誤りを返す。行は何も変えない)。空なら、つなぐエージェントが無いと出す
 */
export function syncEnvAgentsOnBoot(): void {
  try {
    syncEnvAgents();
    if (config.agentUrl.trim() === "") {
      console.warn(
        "[agent] TUNER_AGENT_URL が空のため、つなぐエージェントがありません (docs/config.md)",
      );
    }
  } catch (error) {
    console.error(`[agent] ${error instanceof Error ? error.message : error}`);
  }
}

/** 環境変数と DB が前に突き合わせたときのままでなければ、突き合わせ直す */
function ensureSynced(): Map<string, string> {
  if (synced?.raw !== config.agentUrl || synced.db !== config.dbPath) {
    syncEnvAgents();
  }
  return synced!.pairs;
}

/** 全部のエージェント (並びの順)。通知の購読・ログ・バージョンはこの全部に送る */
export function listAgents(): Agent[] {
  const pairs = ensureSynced();
  return orm()
    .select({ id: agents.id, name: agents.name, origin: agents.origin })
    .from(agents)
    .orderBy(asc(agents.position), asc(agents.id))
    .all()
    .map((row) => ({ ...row, pair: pairs.get(row.origin) ?? null }));
}

/** エージェントが 1 台も無いときの理由 */
export const NO_AGENT =
  "エージェントがありません。TUNER_AGENT_URL に https://ホスト:25252#pair=<合言葉> を書きます (docs/agent.md)";

/**
 * 並びの先頭のエージェント。カード・復号はここに送る。
 * 1 台も無ければ、TUNER_AGENT_URL の書き方を入れたエラーを送出する
 */
export function primaryAgent(): Agent {
  const first = listAgents()[0];
  if (first === undefined) throw new Error(NO_AGENT);
  return first;
}

/**
 * 選局に使うエージェント。チューナーの一覧 (`getTuners`) はこの全部のものをつなげる。
 * 今は並びの先頭の 1 台だけ (どのエージェントで選局するかを選ぶ振り分けが、まだ無いため)。
 * 1 台も無ければ `primaryAgent` と同じエラーを送出する
 */
export function tuningAgents(): Agent[] {
  return [primaryAgent()];
}

/** 保存した証明書 (PEM)。まだ組んでいなければ null */
export function agentCert(id: number): string | null {
  return (
    orm()
      .select({ cert: agents.cert })
      .from(agents)
      .where(eq(agents.id, id))
      .get()?.cert ?? null
  );
}

/**
 * 組めた相手の証明書を行に保存する。
 * 同じ証明書の行がほかにあれば保存しない (同じエージェントを別の URL で 2 回書いたとき)
 */
export function rememberAgentCert(
  id: number,
  cert: string,
  fingerprint: string,
): void {
  const other = orm()
    .select({ origin: agents.origin })
    .from(agents)
    .where(and(eq(agents.fingerprint, fingerprint), ne(agents.id, id)))
    .get();
  if (other !== undefined) {
    throw new Error(
      `このエージェントはもう別の URL (${other.origin}) で登録してあります`,
    );
  }
  orm()
    .update(agents)
    .set({ cert, fingerprint })
    .where(eq(agents.id, id))
    .run();
}
