import { type Actions, fail } from "@sveltejs/kit";
import { eq } from "drizzle-orm";

import { parseId } from "#lib/id.js";
import {
  addAgent,
  AgentAdminError,
  agentEntries,
  agentState,
  moveAgent,
  removeAgent,
  renameAgent,
} from "#lib/server/agent-admin.js";
import type { Agent } from "#lib/server/agents.js";
import { tokenRefusal } from "#lib/server/auth.js";
import { orm } from "#lib/server/db.js";
import { recordings } from "#lib/server/schema.js";

import type { Lists } from "./tuners.server";

/** 録画 ID → 番組名 (削除の確かめに出す) */
function recordingName(id: number): string | null {
  return (
    orm()
      .select({ name: recordings.name })
      .from(recordings)
      .where(eq(recordings.id, id))
      .get()?.name ?? null
  );
}

/**
 * エージェントの節。1 台 1 件の一覧と、エージェントに訊く様子 (後から流し込む)。
 * **アクセストークンには何も返さない** (宛先を読めれば、エージェントのある場所が分かる。操作もできない)
 */
export function load(locals: { token?: number }, all: Agent[], lists: Lists) {
  if (tokenRefusal(locals) !== null)
    return { agents: [], agentStates: Promise.resolve([]) };
  return {
    agents: agentEntries(),
    agentStates: Promise.all(
      all.map((agent) =>
        agentState(
          agent,
          (lists.get(agent.id) ?? Promise.reject(new Error("-"))).then(
            (got) => got.tuners,
          ),
          recordingName,
        ),
      ),
    ),
  };
}

/** 断りを画面の言葉にする。思いがけない失敗は、何ができなかったか (`what`) と理由を添える */
function refusal(error: unknown, what: string) {
  if (error instanceof AgentAdminError)
    return fail(400, { message: error.message });
  return fail(502, {
    message: `${what}: ${error instanceof Error ? error.message : error}`,
  });
}

/**
 * **どれもアクセストークン (テレビのアプリ) では断る** (403。`tokenRefusal`)。テレビのアプリに渡した資格で、チューナーの登録を差し替えさせない。
 * 登録用の URL (合言葉入り) は POST の本文でだけ受け取り、ログにも DB にも残さない
 */
export const actions = {
  addAgent: async ({ request, locals }) => {
    const refused = tokenRefusal(locals);
    if (refused !== null) return fail(403, { message: refused });
    const form = await request.formData();
    try {
      const agent = await addAgent(String(form.get("url") ?? ""));
      return { success: true, agentAdded: agent.name };
    } catch (error) {
      return refusal(error, "エージェントを登録できませんでした");
    }
  },

  renameAgent: async ({ request, locals }) => {
    const refused = tokenRefusal(locals);
    if (refused !== null) return fail(403, { message: refused });
    const form = await request.formData();
    const id = parseId(form.get("id"));
    if (id === null) return fail(400, { message: "ID が不正です" });
    try {
      renameAgent(id, String(form.get("name") ?? ""));
      return { success: true };
    } catch (error) {
      return refusal(error, "名前を変えられませんでした");
    }
  },

  moveAgent: async ({ request, locals }) => {
    const refused = tokenRefusal(locals);
    if (refused !== null) return fail(403, { message: refused });
    const form = await request.formData();
    const id = parseId(form.get("id"));
    if (id === null) return fail(400, { message: "ID が不正です" });
    try {
      const agent = await moveAgent(id, String(form.get("url") ?? ""));
      return { success: true, agentMoved: agent.name };
    } catch (error) {
      return refusal(error, "URL を変えられませんでした");
    }
  },

  removeAgent: async ({ request, locals }) => {
    const refused = tokenRefusal(locals);
    if (refused !== null) return fail(403, { message: refused });
    const form = await request.formData();
    const id = parseId(form.get("id"));
    if (id === null) return fail(400, { message: "ID が不正です" });
    try {
      const removed = await removeAgent(id);
      return {
        success: true,
        // 届かなければ、エージェントの側に登録が残ることを言う
        agentLeft: removed.reached
          ? null
          : `「${removed.name}」に届かなかったため、エージェントの側にはこの denpa の登録が残っています`,
      };
    } catch (error) {
      return refusal(error, "エージェントを削除できませんでした");
    }
  },
} satisfies Actions;
