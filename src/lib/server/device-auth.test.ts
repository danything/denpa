import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { config } = await import("./config");
config.dbPath = join(mkdtempSync(join(tmpdir(), "denpa-device-")), "denpa.db");

const {
  approve,
  bearerToken,
  CODE_TTL_MS,
  issueCode,
  liveTokens,
  MAX_PENDING,
  MAX_PENDING_PER_SOURCE,
  newUserCode,
  normalizeUserCode,
  poll,
  POLL_INTERVAL_MS,
  pruneCodes,
  revokeToken,
  sha256,
  sourceKey,
  TOKEN_PREFIX,
  verifyToken,
  viewCode,
} = await import("./device-auth");
const { orm } = await import("./db");
const { apiTokens, deviceCodes } = await import("./schema");

/** 接続元をテストごとに変える (同じ接続元の上限に掛からないように) */
let sources = 0;
function nextSource(): string {
  sources++;
  return `10.1.${sources >> 8}.${sources & 255}`;
}

/** コードを出して、テストの間だけ時計を進めて扱う */
function pair(name = "居間のテレビ", at = 1_000_000) {
  const issued = issueCode(name, nextSource(), at);
  if (issued === null) throw new Error("コードが出ない");
  return issued;
}

describe("コード", () => {
  test("コードは見間違えない字だけで ABCD-EFGH の形式", () => {
    for (let i = 0; i < 200; i++) {
      const code = newUserCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(code).not.toMatch(/[01IO]/);
    }
  });

  test("URL から来たコードは揃えて読む。形式が違えば null", () => {
    expect(normalizeUserCode("abcd efgh")).toBe("ABCD-EFGH");
    expect(normalizeUserCode("ABCD-EFG")).toBeNull();
    // 0 と O はコードに使わない字
    expect(normalizeUserCode("ABCD-EF0H")).toBeNull();
  });

  test("秘密そのものは DB に置かない (SHA-256 だけ)", () => {
    const { deviceCode, userCode } = pair("ハッシュ", 2_000_000);
    const row = orm()
      .select()
      .from(deviceCodes)
      .all()
      .find((r) => r.user_code === userCode);
    expect(row?.device_code_hash).toBe(sha256(deviceCode));
    expect(JSON.stringify(row)).not.toContain(deviceCode);
  });
});

describe("ペアリングの流れ", () => {
  test("許されるまでは待てと言い、許されたらアクセストークンを1度だけ渡す", () => {
    const at = 3_000_000;
    const { deviceCode, userCode } = pair("居間", at);
    expect(poll(deviceCode, at)).toEqual({ error: "authorization_pending" });

    expect(approve(userCode, "trusted-network", at + 1)?.state).toBe(
      "approved",
    );
    const got = poll(deviceCode, at + POLL_INTERVAL_MS);
    expect("token" in got).toBe(true);
    const token = (got as { token: string }).token;
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);

    // 2度目は渡さない (使い終えたコード)
    expect(poll(deviceCode, at + 2 * POLL_INTERVAL_MS)).toEqual({
      error: "invalid_grant",
    });
    expect(viewCode(userCode, at + 3 * POLL_INTERVAL_MS)?.state).toBe(
      "consumed",
    );

    // アクセストークンも DB には SHA-256 だけ
    const row = orm().select().from(apiTokens).all().at(-1);
    expect(row?.token_hash).toBe(sha256(token));
    expect(row?.name).toBe("居間");
    expect(row?.created_by).toBe("trusted-network");
  });

  test("許すのは何度呼んでも同じ (読み直しでアクセストークンが2つにならない)", () => {
    const at = 4_000_000;
    const { deviceCode, userCode } = pair("二度押し", at);
    approve(userCode, "trusted-network", at);
    approve(userCode, "trusted-network", at + 1);
    expect("token" in poll(deviceCode, at + POLL_INTERVAL_MS)).toBe(true);
    expect(
      approve(userCode, "trusted-network", at + 2 * POLL_INTERVAL_MS)?.state,
    ).toBe("consumed");
    expect(
      orm()
        .select()
        .from(apiTokens)
        .all()
        .filter((r) => r.name === "二度押し"),
    ).toHaveLength(1);
  });

  test("急いで聞きに来たら slow_down", () => {
    const at = 5_000_000;
    const { deviceCode } = pair("せっかち", at);
    expect(poll(deviceCode, at)).toEqual({ error: "authorization_pending" });
    expect(poll(deviceCode, at + 1000)).toEqual({ error: "slow_down" });
    // タイマーのずれ (4.9秒) は許す
    expect(poll(deviceCode, at + 1000 + POLL_INTERVAL_MS - 100)).toEqual({
      error: "authorization_pending",
    });
  });

  test("10分で切れる。切れたコードは許せず、端末には expired_token", () => {
    const at = 6_000_000;
    const { deviceCode, userCode } = pair("遅刻", at);
    const later = at + CODE_TTL_MS;
    expect(approve(userCode, "trusted-network", later)?.state).toBe("expired");
    expect(poll(deviceCode, later)).toEqual({ error: "expired_token" });
    expect(pruneCodes(later)).toBeGreaterThan(0);
    expect(viewCode(userCode, later)).toBeNull();
  });

  test("知らない秘密には invalid_grant", () => {
    expect(poll("nope", 7_000_000)).toEqual({ error: "invalid_grant" });
  });

  /*
   * **呼び続ける1台がいても、ほかの人はペアリングできる。** 前は全体の上限を全員で
   * 分け合っていて、埋められると10分のあいだ誰もコードを貰えなかった
   */
  test("1つの接続元が呼び続けても、持てるのは上限まで (古いものから切れる)", () => {
    const at = 8_000_000_000;
    const flood = Array.from({ length: 10 }, (_, i) =>
      issueCode(`連打${i}`, "203.0.113.7", at + i),
    );
    expect(flood.every((issued) => issued !== null)).toBe(true);
    const states = flood.map(
      (issued) => viewCode(issued!.userCode, at + 10)?.state,
    );
    expect(states.filter((state) => state === "pending")).toHaveLength(
      MAX_PENDING_PER_SOURCE,
    );
    // 残るのは新しいほう
    expect(states.slice(-MAX_PENDING_PER_SOURCE)).toEqual(
      Array(MAX_PENDING_PER_SOURCE).fill("pending"),
    );
    // 切れたコードの端末には expired_token (コードを貰い直す)
    expect(poll(flood[0]!.deviceCode, at + 10)).toEqual({
      error: "expired_token",
    });

    // ほかの接続元のコードには触らない
    const mine = issueCode("居間", "198.51.100.2", at + 20);
    for (let i = 0; i < 10; i++)
      issueCode(`連打${i}`, "203.0.113.7", at + 30 + i);
    expect(viewCode(mine!.userCode, at + 40)?.state).toBe("pending");
  });

  test("IPv6 は /64 で1つの接続元として数える", () => {
    expect(sourceKey("2001:db8:1:2::a")).toBe(sourceKey("2001:db8:1:2::b"));
    expect(sourceKey("2001:db8:1:2::a")).not.toBe(sourceKey("2001:db8:1:3::a"));
    expect(sourceKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(sourceKey("")).toBe("");
  });

  test("全体が埋まったら、許されていないコードを古いものから切らせて出す", () => {
    const at = 8_500_000_000;
    const approved = issueCode("許し済み", "192.0.2.200", at);
    approve(approved!.userCode, "trusted-network", at);
    const issued = Array.from({ length: MAX_PENDING }, (_, i) =>
      issueCode(`満員${i}`, `192.0.2.${i}`, at + 1 + i),
    );
    expect(issued.every((code) => code !== null)).toBe(true);
    // 押し出されたのは許されていないうちの古いもの。許したものは受け取りに来る途中なので残す
    expect(viewCode(issued[0]!.userCode, at + 100)?.state).toBe("expired");
    expect(viewCode(issued.at(-1)!.userCode, at + 100)?.state).toBe("pending");
    expect(viewCode(approved!.userCode, at + 100)?.state).toBe("approved");
  });

  test("有効なコードが全部許し済みで空けられなければ出さない", () => {
    const at = 8_800_000_000;
    for (let i = 0; i < MAX_PENDING; i++) {
      const issued = issueCode(`許し済み${i}`, `192.0.2.${i}`, at);
      approve(issued!.userCode, "trusted-network", at);
    }
    expect(issueCode("あふれ", "198.51.100.9", at)).toBeNull();
    // 切れれば、また出せる
    expect(
      issueCode("あふれ", "198.51.100.9", at + CODE_TTL_MS),
    ).not.toBeNull();
  });
});

describe("アクセストークン", () => {
  function mint(name: string, at: number): string {
    const { deviceCode, userCode } = pair(name, at);
    approve(userCode, "trusted-network", at);
    const got = poll(deviceCode, at);
    if (!("token" in got)) throw new Error("アクセストークンが出ない");
    return got.token;
  }

  test("Authorization から denpa のアクセストークンだけを取り出す (ほかの Bearer は見ない)", () => {
    expect(bearerToken(`Bearer ${TOKEN_PREFIX}abc`)).toBe(`${TOKEN_PREFIX}abc`);
    expect(bearerToken(`bearer   ${TOKEN_PREFIX}abc`)).toBe(
      `${TOKEN_PREFIX}abc`,
    );
    expect(bearerToken("Bearer eyJhbGciOi.someone-elses")).toBeNull();
    expect(bearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });

  test("生きているトークンは持ち主を返し、止めたトークンは通さない", () => {
    const at = 9_000_000_000;
    const token = mint("寝室", at);
    const owner = verifyToken(token, at);
    expect(owner?.name).toBe("寝室");
    expect(liveTokens().some((t) => t.id === owner?.id)).toBe(true);

    expect(revokeToken(owner!.id, at)).toBe(true);
    expect(verifyToken(token, at)).toBeNull();
    expect(liveTokens().some((t) => t.id === owner?.id)).toBe(false);
    expect(verifyToken(`${TOKEN_PREFIX}forged`, at)).toBeNull();
  });

  test("最後に使った時刻は1分に1度だけ書く", () => {
    const at = 10_000_000_000;
    const token = mint("書斎", at);
    const id = verifyToken(token, at)!.id;
    const used = () =>
      orm()
        .select()
        .from(apiTokens)
        .all()
        .find((r) => r.id === id)?.last_used_at;
    expect(used()).toBe(at);
    verifyToken(token, at + 30_000);
    expect(used()).toBe(at);
    verifyToken(token, at + 60_000);
    expect(used()).toBe(at + 60_000);
  });
});
