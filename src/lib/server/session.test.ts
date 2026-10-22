import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const { config } = await import("./config");
config.dbPath = join(mkdtempSync(join(tmpdir(), "denpa-session-")), "denpa.db");

const { countOthers, create, destroyOthers, find } = await import("./session");
const { now, orm } = await import("./db");
const { apiTokens, sessions } = await import("./schema");

beforeEach(() => {
  orm().delete(sessions).run();
  orm().delete(apiTokens).run();
});

describe("ほかの端末からもログアウト", () => {
  test("この控えだけ残して、ほかは誰のものでも消す", () => {
    const mine = create("alice", "Alice");
    const phone = create("alice", "Alice");
    const family = create("bob", "Bob");

    expect(countOthers(mine.id)).toBe(2);
    expect(destroyOthers(mine.id)).toBe(2);

    expect(find(mine.id)).not.toBeNull();
    expect(find(phone.id)).toBeNull();
    expect(find(family.id)).toBeNull();
    expect(countOthers(mine.id)).toBe(0);
    // もう一度押しても何も起きない
    expect(destroyOthers(mine.id)).toBe(0);
  });

  test("切れていた控えは数えない", () => {
    const mine = create("alice", "Alice");
    const stale = create("alice", "Alice");
    const live = create("bob", "Bob");
    orm()
      .update(sessions)
      .set({ expires_at: now() - 1000 })
      .where(eq(sessions.id, stale.id))
      .run();

    expect(countOthers(mine.id)).toBe(1);
    expect(destroyOthers(mine.id)).toBe(1);
    expect(find(live.id)).toBeNull();
  });

  test("テレビのアプリのアクセストークンは消さない", () => {
    const mine = create("alice", "Alice");
    create("alice", "Alice");
    orm()
      .insert(apiTokens)
      .values({
        name: "居間のテレビ",
        token_hash: "x".repeat(64),
        created_at: now(),
      })
      .run();
    destroyOthers(mine.id);
    expect(orm().select().from(apiTokens).all()).toHaveLength(1);
  });
});
