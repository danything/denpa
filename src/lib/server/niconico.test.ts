import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { idTokenFor, sealForDenpa } from "../../../tests/fake/niconico-seal";

const dir = mkdtempSync(join(tmpdir(), "denpa-niconico-"));
const { config } = await import("./config");
config.dbPath = join(dir, "denpa.db");
config.dataDir = dir;

/** 偽の hub の更新 (`/niconico/token`)。呼ばれた回数と、返す応答を差し替える */
let refreshCalls: string[] = [];
let reply: (refresh: string) => Response = () => new Response(null);
const hub = Bun.serve({
  port: 0,
  async fetch(request) {
    const form = new URLSearchParams(await request.text());
    const refresh = form.get("refresh_token") ?? "";
    refreshCalls.push(refresh);
    // 更新が重なったかが分かるよう、少し待ってから返す
    await Bun.sleep(30);
    return reply(refresh);
  },
});
config.hubUrl = `http://127.0.0.1:${hub.port}`;
afterAll(() => {
  void hub.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const {
  FINISH_ERRORS,
  FLOW_TTL,
  accessToken,
  finishLink,
  linkState,
  readTokens,
  renew,
  startLink,
  subjectOf,
  unlink,
  warnShape,
} = await import("./niconico");
const { orm } = await import("./db");
const { niconicoLink } = await import("./schema");

const ORIGIN = "http://192.168.1.20:3000";
const RETURN = `${ORIGIN}/settings/integrations/niconico/return`;

/** 連携を始め、hub と同じく結果を封じて返す */
async function link(
  response: Record<string, unknown> = {
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_in: 3600,
    token_type: "Bearer",
    id_token: idTokenFor("12345678"),
  },
  aad = RETURN,
) {
  const { flow, url } = await startLink(ORIGIN);
  const key = new URL(url).searchParams.get("key")!;
  const sealed = await sealForDenpa(key, JSON.stringify(response), aad);
  return { flow, url, sealed };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

beforeEach(() => {
  orm().delete(niconicoLink).run();
  refreshCalls = [];
  reply = (refresh) =>
    json({
      access_token: `${refresh}-access`,
      refresh_token: `${refresh}+`,
      expires_in: 3600,
    });
});

describe("連携を始める", () => {
  test("hub の入口へ、組み直した戻り先と P-256 の公開鍵 (65 バイト) を付けて送る", async () => {
    const { url } = await startLink(
      "http://192.168.1.20:3000/settings/integrations?x=1",
    );
    const target = new URL(url);
    expect(`${target.origin}${target.pathname}`).toBe(
      `${config.hubUrl}/niconico/authorize`,
    );
    expect(target.searchParams.get("return")).toBe(RETURN);
    const key = Buffer.from(target.searchParams.get("key")!, "base64url");
    expect(key.length).toBe(65);
    expect(key[0]).toBe(0x04);
  });

  test("既定のポートは付けない (hub が組み直す形と同じ)", async () => {
    const { url } = await startLink("http://denpa.local:80");
    expect(new URL(url).searchParams.get("return")).toBe(
      "http://denpa.local/settings/integrations/niconico/return",
    );
  });
});

describe("戻ってきた結果を保存する", () => {
  test("開いて、ユーザー ID と暗号化したトークンを置く", async () => {
    const { flow, sealed } = await link();
    expect(await finishLink(flow, sealed, "trusted-network")).toEqual({
      ok: true,
    });
    const state = linkState();
    expect(state).toMatchObject({ state: "linked", userId: "12345678" });
    const row = orm().select().from(niconicoLink).get()!;
    expect(row.linked_by).toBe("trusted-network");
    // DB にはトークンがそのままの形で入らない
    expect(row.access_token!.includes("access-1")).toBe(false);
    expect(row.refresh_token!.includes("refresh-1")).toBe(false);
    // 鍵のファイルは持ち主だけが読める
    expect(statSync(join(dir, "niconico.key")).mode & 0o077).toBe(0);
    expect(await accessToken()).toBe("access-1");
  });

  test("同じ結果は 2 度使えない", async () => {
    const { flow, sealed } = await link();
    await finishLink(flow, sealed, "trusted-network");
    expect(await finishLink(flow, sealed, "trusted-network")).toEqual({
      ok: false,
      message: FINISH_ERRORS.expired,
    });
  });

  test("Cookie が無い・10 分を過ぎたら断る", async () => {
    const { sealed } = await link();
    expect(await finishLink(undefined, sealed, "x")).toMatchObject({
      ok: false,
    });
    const late = await link();
    expect(
      await finishLink(late.flow, late.sealed, "x", Date.now() + FLOW_TTL + 1),
    ).toEqual({ ok: false, message: FINISH_ERRORS.expired });
    expect(linkState()).toEqual({ state: "none" });
  });

  test("別の戻り先に宛てたもの・壊れたものは開けない", async () => {
    const other = await link(
      undefined,
      "http://192.168.1.99:3000/settings/integrations/niconico/return",
    );
    expect(await finishLink(other.flow, other.sealed, "x")).toEqual({
      ok: false,
      message: FINISH_ERRORS.unreadable,
    });
    const broken = await link();
    expect(
      await finishLink(broken.flow, `${broken.sealed.slice(0, -4)}AAAA`, "x"),
    ).toEqual({ ok: false, message: FINISH_ERRORS.unreadable });
  });

  test("更新に使うトークンかユーザー ID が無ければ連携しない", async () => {
    const noRefresh = await link({
      access_token: "a",
      expires_in: 3600,
      id_token: idTokenFor("1"),
    });
    expect(await finishLink(noRefresh.flow, noRefresh.sealed, "x")).toEqual({
      ok: false,
      message: FINISH_ERRORS.noRefresh,
    });
    const noUser = await link({
      access_token: "a",
      refresh_token: "r",
      expires_in: 3600,
    });
    expect(await finishLink(noUser.flow, noUser.sealed, "x")).toEqual({
      ok: false,
      message: FINISH_ERRORS.noUser,
    });
    expect(linkState()).toEqual({ state: "none" });
  });
});

/** 期限の切れかけたトークンで連携した状態にする */
async function linkExpiring(): Promise<void> {
  const { flow, sealed } = await link({
    access_token: "old-access",
    refresh_token: "refresh-1",
    expires_in: 60,
    id_token: idTokenFor("12345678"),
  });
  await finishLink(flow, sealed, "trusted-network");
}

describe("更新", () => {
  test("期限まで余裕があれば hub を呼ばない", async () => {
    const { flow, sealed } = await link();
    await finishLink(flow, sealed, "x");
    expect(await accessToken()).toBe("access-1");
    expect(refreshCalls).toEqual([]);
  });

  test("切れかけていたら更新し、同時に呼ばれても hub へは 1 回。新しい更新用のトークンに置き換える", async () => {
    await linkExpiring();
    const tokens = await Promise.all([accessToken(), accessToken(), renew()]);
    expect(tokens).toEqual([
      "refresh-1-access",
      "refresh-1-access",
      "refresh-1-access",
    ]);
    expect(refreshCalls).toEqual(["refresh-1"]);
    // 次の更新は替わった更新用のトークンで
    expect(await renew()).toBe("refresh-1+-access");
    expect(refreshCalls).toEqual(["refresh-1", "refresh-1+"]);
    // 新しいアクセストークンは期限まで余裕があるので、そのまま使う
    expect(await accessToken()).toBe("refresh-1+-access");
    expect(refreshCalls.length).toBe(2);
  });

  test("ニコニコが断ったら (invalid_grant) 連携が切れた状態にし、トークンを消す", async () => {
    await linkExpiring();
    reply = () => json({ error: "invalid_grant" }, 400);
    expect(await accessToken()).toBeNull();
    expect(linkState()).toMatchObject({ state: "lost" });
    const row = orm().select().from(niconicoLink).get()!;
    expect(row.access_token).toBeNull();
    expect(row.refresh_token).toBeNull();
    // もう hub を呼ばない
    expect(await accessToken()).toBeNull();
    expect(refreshCalls.length).toBe(1);
  });

  test("hub に届かないときは投げ、連携はそのまま (次にまた試す)", async () => {
    await linkExpiring();
    reply = () => json({ error: "temporarily_unavailable" }, 502);
    await expect(accessToken()).rejects.toThrow("HTTP 502");
    expect(linkState()).toMatchObject({ state: "linked" });
    reply = (refresh) =>
      json({
        access_token: "back",
        refresh_token: `${refresh}+`,
        expires_in: 3600,
      });
    expect(await accessToken()).toBe("back");
  });

  test("更新の途中で外したら、受けたトークンで連携を戻さない", async () => {
    await linkExpiring();
    const pending = accessToken();
    unlink();
    expect(await pending).toBeNull();
    expect(linkState()).toEqual({ state: "none" });
  });

  test("鍵のファイルが替わって開けなければ、連携が切れた状態にする", async () => {
    const { flow, sealed } = await link();
    await finishLink(flow, sealed, "x");
    writeFileSync(join(dir, "niconico.key"), Buffer.alloc(32, 7));
    expect(await accessToken()).toBeNull();
    expect(linkState()).toMatchObject({ state: "lost" });
    rmSync(join(dir, "niconico.key"));
  });
});

describe("外す", () => {
  test("手元のトークンを消す", async () => {
    const { flow, sealed } = await link();
    await finishLink(flow, sealed, "x");
    unlink();
    expect(linkState()).toEqual({ state: "none" });
    expect(await accessToken()).toBeNull();
  });

  test("切れたあとに連携し直せる", async () => {
    await linkExpiring();
    reply = () => json({ error: "invalid_grant" }, 400);
    await accessToken();
    const { flow, sealed } = await link();
    expect(await finishLink(flow, sealed, "x")).toEqual({ ok: true });
    expect(linkState()).toMatchObject({ state: "linked" });
  });
});

describe("応答を読む", () => {
  test("期限が無ければ短めに見て、1 回警告する", () => {
    const warned: string[] = [];
    const tokens = readTokens({ access_token: "a" }, (m) => warned.push(m));
    expect(tokens.expiresIn).toBe(1800);
    expect(tokens.refresh).toBeNull();
    expect(warned.length).toBe(1);
  });

  test("形式の警告は、同じものは 1 度だけ、違うものはそれぞれ 1 度ずつ出す", () => {
    const original = console.warn;
    const logged: string[] = [];
    console.warn = (message: string) => logged.push(message);
    try {
      warnShape("一つ目");
      warnShape("一つ目");
      warnShape("二つ目");
    } finally {
      console.warn = original;
    }
    expect(logged).toEqual(["[niconico] 一つ目", "[niconico] 二つ目"]);
  });

  test("アクセストークンが無ければ投げる", () => {
    expect(() => readTokens({ refresh_token: "r" })).toThrow();
    expect(() => readTokens(null)).toThrow();
  });

  test("ID トークンの sub を読む。読めなければ null", () => {
    expect(subjectOf(idTokenFor("42"))).toBe("42");
    expect(subjectOf(null)).toBeNull();
    expect(subjectOf("a.b.c")).toBeNull();
    expect(subjectOf(idTokenFor(""))).toBeNull();
  });
});
