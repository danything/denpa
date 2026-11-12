import { arch, release, type } from "node:os";

import { type AgentAbout, guessLevel, type LogLine } from "../issue-report";
import { type Known, MASK, redact } from "../redact";
import { agentFetch } from "./agent-client";
import { agentHostnames, agentSecrets } from "./agents";
import { config } from "./config";
import { orm } from "./db";
import { serverLogs } from "./log-buffer";
import { pwaNames } from "./manifest";
import { webhooks } from "./schema";

/**
 * **設定の「その他」の「バージョンと環境」と「ログ」に出すもの。** サーバとエージェントのログ、動いている環境。
 *
 * エージェントのログは `GET /denpa/logs` (`{"lines":[{"at":<epoch ms>,"text":"…"}]}`。新しいほうから 2000 行まで、古い順)。
 * エージェント自身のことは `GET /denpa/about` (`{"version","os","arch","runtime","ccidDriver"}`。agent/Denpa.Agent/About.cs)。
 * 取れなければ理由を返して画面は止めない
 */

interface AgentLogs {
  lines: LogLine[];
  /** 取れなかった理由。取れたら null */
  error: string | null;
}

/** 来たものを疑って読む。形式が違う行は捨てる (`shape.tolerate` と同じく止めない) */
function readAgentLogs(raw: unknown): LogLine[] {
  const lines =
    typeof raw === "object" && raw !== null && "lines" in raw
      ? (raw as { lines: unknown }).lines
      : undefined;
  if (!Array.isArray(lines)) {
    console.warn(
      "エージェントの /denpa/logs の形式が違います (lines がありません)。エージェントとバージョンがずれているかもしれません",
    );
    return [];
  }
  const out: LogLine[] = [];
  for (const entry of lines as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { at, text } = entry as { at?: unknown; text?: unknown };
    if (typeof at !== "number" || typeof text !== "string") continue;
    out.push({ at, text, level: guessLevel(text) });
  }
  return out;
}

export async function agentLogs(known: Known): Promise<AgentLogs> {
  try {
    const res = await agentFetch("/denpa/logs", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok)
      return {
        lines: [],
        error: `エージェントからログを取得できません (${res.status})`,
      };
    return {
      lines: scrub(readAgentLogs(await res.json()), known),
      error: null,
    };
  } catch (error) {
    return {
      lines: [],
      error: `エージェントに繋がりません: ${redact(String(error), known)}`,
    };
  }
}

interface AgentAboutResult {
  about: AgentAbout | null;
  /** 取れなかった理由。取れたら null */
  error: string | null;
}

/** 来たものを疑って読む。項目ごとに、形式が違えば null にして続ける */
function readAgentAbout(raw: unknown): AgentAbout {
  const body =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const text = (key: string) =>
    typeof body[key] === "string" && body[key] !== "" ? body[key] : null;
  const about: AgentAbout = {
    version: text("version"),
    os: text("os"),
    arch: text("arch"),
    runtime: text("runtime"),
    ccidDriver:
      body["ccidDriver"] === "apple" || body["ccidDriver"] === "ifd-ccid"
        ? body["ccidDriver"]
        : null,
  };
  if (about.version === null)
    console.warn(
      "エージェントの /denpa/about の形式が違います (version がありません)。エージェントとバージョンがずれているかもしれません",
    );
  return about;
}

/** エージェントのバージョン・OS・arch と、macOS なら CCID ドライバ (`GET /denpa/about`) */
export async function agentAbout(known: Known): Promise<AgentAboutResult> {
  try {
    const res = await agentFetch("/denpa/about", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok)
      return {
        about: null,
        error: `エージェントからバージョンを取得できません (${res.status})`,
      };
    return { about: readAgentAbout(await res.json()), error: null };
  } catch (error) {
    return {
      about: null,
      error: `エージェントに繋がりません: ${redact(String(error), known)}`,
    };
  }
}

/**
 * **サーバの設定と DB にある、形式では見分けられない値。** 画面に送る前にログから消す
 * (OIDC のクライアントシークレット・登録してある Webhook の URL・エージェントと組む合言葉は、画面にも出さない)。
 * ホスト名は画面にはそのまま出し、Issue に貼るときに伏せる (`redact`)。
 * エージェントに繋がらないときの一言 (`agentLogs`・`agentAbout` の `error`) だけは、ホスト名ごと伏せて返す
 */
export function knownValues(requestHost: string): {
  secrets: string[];
  hosts: string[];
} {
  const secrets = [config.oidcClientSecret, ...agentSecrets()];
  try {
    for (const row of orm().select({ url: webhooks.url }).from(webhooks).all())
      secrets.push(row.url);
  } catch {
    // DB が読めなくても、形式で伏せるぶんは効く
  }
  const hosts = [requestHost, ...agentHostnames()];
  // 自分の名前として通すものと同じ読み方 (`manifest.pwaNames`。`=` の無いものは名前にしない)
  for (const { host } of pwaNames()) hosts.push(host);
  return { secrets: secrets.filter(Boolean), hosts: hosts.filter(Boolean) };
}

/** 秘密の値だけを消す (ホスト名は画面では残す) */
function scrub(lines: LogLine[], known: Known): LogLine[] {
  // 長いものから消す。短い秘密が長い秘密の一部だと、先に消したときに長いほうが半端に残る
  const secrets = (known.secrets ?? [])
    .filter((value) => value.length >= 6)
    .sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return lines;
  return lines.map((line) =>
    secrets.some((value) => line.text.includes(value))
      ? {
          ...line,
          text: secrets.reduce(
            (text, value) => text.replaceAll(value, MASK.secret),
            line.text,
          ),
        }
      : line,
  );
}

export function serverLogLines(known: Known): LogLine[] {
  return scrub(serverLogs(), known);
}

/** サーバの動いている環境 */
export function serverEnvironment(): {
  version: string;
  os: string;
  runtime: string;
} {
  const bun = (globalThis as { Bun?: { version: string } }).Bun?.version;
  return {
    version: config.version,
    os: `${type()} ${release()} (${arch()})`,
    runtime: bun === undefined ? `Node ${process.version}` : `Bun ${bun}`,
  };
}
