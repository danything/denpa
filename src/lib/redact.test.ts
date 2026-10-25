import { describe, expect, test } from "bun:test";

import { MASK, redact } from "./redact";

describe("伏せる (Issue に貼る前)", () => {
  describe("B-CAS カードの番号", () => {
    test.each([
      [
        "カード 0123456789012345 を読みました",
        "カード [カード番号] を読みました",
      ],
      ['ids: ["0000000000000001"]', 'ids: ["[カード番号]"]'],
      ["裏の番号 0123-4567-8901-2345-6789", "裏の番号 [カード番号]"],
      ["0123 4567 8901 2345", "[カード番号]"],
      ["card=01234567890123456789", "card=[カード番号]"],
    ])("%s", (input, expected) => {
      expect(redact(input)).toBe(expected);
    });

    test("番組の ID (15 桁まで)・epoch ミリ秒・日付は残す", () => {
      const text = "program 327360102400123 at 1761360000000 on 2026-10-25";
      expect(redact(text)).toBe(text);
    });
  });

  describe("秘密", () => {
    test("引用符で囲んだ値は、空白を含んでも閉じ引用符まで伏せる", () => {
      expect(redact('"client_secret": "abc def ghi"')).toBe(
        `"client_secret": "${MASK.secret}"`,
      );
      expect(redact("password='p a s s'")).toBe(`password='${MASK.secret}'`);
      expect(redact("token=abc123 次")).toBe(`token=${MASK.secret} 次`);
    });

    test("Authorization・Cookie は行の終わりまで", () => {
      expect(redact("Authorization: Bearer abc.def")).toBe(
        `Authorization: ${MASK.secret}`,
      );
      expect(redact("cookie: denpa_session=xyz; other=1")).toBe(
        `cookie: ${MASK.secret}`,
      );
      expect(redact("Set-Cookie: sid=1; HttpOnly")).toBe(
        `Set-Cookie: ${MASK.secret}`,
      );
    });

    test("Bearer とアクセストークン", () => {
      expect(redact("送った Bearer eyJhbGciOi.payload.sig で")).toBe(
        `送った Bearer ${MASK.secret} で`,
      );
      expect(redact("token denpa_AbCdEf0123456789 は取り消し済み")).toBe(
        `token ${MASK.secret} は取り消し済み`,
      );
    });

    test("名前に secret・token・password を含む値", () => {
      expect(redact("OIDC_CLIENT_SECRET=s3cr3t-value")).toBe(
        `OIDC_CLIENT_SECRET=${MASK.secret}`,
      );
      expect(redact('{"password": "hunter2", "user": "a"}')).toBe(
        `{"password": "${MASK.secret}", "user": "a"}`,
      );
      expect(redact("access_token: abc123")).toBe(
        `access_token: ${MASK.secret}`,
      );
      expect(redact("api-key=XYZ")).toBe(`api-key=${MASK.secret}`);
    });

    test("URL の問い合わせの code・state と、URL の中の資格情報", () => {
      expect(redact("/login/callback?code=abc&state=def&x=1")).toBe(
        `/login/callback?code=${MASK.secret}&state=${MASK.secret}&x=1`,
      );
      expect(redact("smb://user:pa55@nas/share")).toBe(
        `smb://${MASK.secret}@${MASK.host}/share`,
      );
    });

    test("サーバが知っている値は形にかかわらず消す", () => {
      expect(
        redact("value plainsecret123 leaked", { secrets: ["plainsecret123"] }),
      ).toBe(`value ${MASK.secret} leaked`);
      // 短すぎる値はふつうの言葉と区別が付かないので使わない
      expect(redact("abc", { secrets: ["abc"] })).toBe("abc");
    });

    test("Webhook の URL は丸ごと", () => {
      expect(
        redact("通知 https://discord.com/api/webhooks/123/abcDEF に送れません"),
      ).toBe(`通知 ${MASK.webhook} に送れません`);
      expect(redact("https://hooks.slack.com/services/T0/B0/xyz")).toBe(
        MASK.webhook,
      );
      expect(redact("POST https://example.com/my/webhook?id=1 -> 500")).toBe(
        `POST ${MASK.webhook} -> 500`,
      );
    });
  });

  describe("LAN の作り", () => {
    test("IPv4 (ポートと CIDR の長さは残す)", () => {
      expect(redact("from 192.168.1.20:5000")).toBe(`from ${MASK.ip}:5000`);
      expect(redact("TRUSTED_NETWORKS=10.10.0.0/16")).toBe(
        `TRUSTED_NETWORKS=${MASK.ip}/16`,
      );
      expect(redact("http://10.0.0.4:25252/denpa/stream")).toBe(
        `http://${MASK.ip}:25252/denpa/stream`,
      );
    });

    test("IPv6", () => {
      expect(redact("listen [::1]:3000")).toBe(`listen [${MASK.ip}]:3000`);
      expect(redact("peer fe80::1ff:fe23:4567:890a%eth0 closed")).toBe(
        `peer ${MASK.ip} closed`,
      );
      expect(redact("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(MASK.ip);
      expect(redact("::ffff:192.0.2.1")).toBe(MASK.ip);
    });

    test("ホスト名 (URL の中・名前:ポート・よくあるドメイン)", () => {
      expect(redact("http://tuner-agent:25252/denpa/tuners -> 502")).toBe(
        `http://${MASK.host}:25252/denpa/tuners -> 502`,
      );
      expect(redact("connect nas-box:445 failed")).toBe(
        `connect ${MASK.host}:445 failed`,
      );
      expect(redact("dp.l.doany.io に繋がりません")).toBe(
        `${MASK.host} に繋がりません`,
      );
      expect(redact("mDNS denpa.local")).toBe(`mDNS ${MASK.host}`);
    });

    test("渡されたホスト名は点が無くても消す", () => {
      expect(
        redact("tuner-agent に繋がりません", { hosts: ["tuner-agent"] }),
      ).toBe(`${MASK.host} に繋がりません`);
      // IP アドレスで開いたときは IP の印にする
      expect(
        redact("Listening on http://127.0.0.1:4173/", { hosts: ["127.0.0.1"] }),
      ).toBe(`Listening on http://${MASK.ip}:4173/`);
      // 別の言葉の一部は消さない
      expect(redact("my-tuner-agent2", { hosts: ["tuner-agent"] })).toBe(
        "my-tuner-agent2",
      );
    });

    test("メールアドレスとホームフォルダのユーザー名", () => {
      expect(redact("login alice@example.com ok")).toBe(
        `login ${MASK.email} ok`,
      );
      expect(redact("open /Users/alice/denpa/config/tuners.json")).toBe(
        `open /Users/${MASK.user}/denpa/config/tuners.json`,
      );
      expect(redact("C:\\Users\\bob\\denpa\\logs\\agent.log")).toBe(
        `C:\\Users\\${MASK.user}\\denpa\\logs\\agent.log`,
      );
    });
  });

  describe("伏せないもの", () => {
    test.each([
      "録画: でんぱニュース (BSでんぱ) を開始",
      "ファイル /media/encoded/でんぱニュース_20261025.mp4 を書きました",
      "at render (/app/build/server/chunks/index.js:123:45)",
      "agent.ts:42 で落ちました",
      "Program.cs line:42",
      "12:34:56 に始まります",
      "BS15_0 / T16 / GR27",
      "ffmpeg -i in.ts -c:v libsvtav1 out.mkv",
      "Chrome/131.0.0.0 Safari/537.36",
      "Linux 6.18.54.1-microsoft-standard-WSL2 (x64)",
      "https://github.com/danything/denpa/issues/1",
      "localhost:3000 で待っています",
      "std::vector と Foo::Bar",
      "エラー: 404 Not Found",
      "Denpa.app を開きました",
      "exit code: 1",
    ])("%s", (text) => {
      expect(redact(text)).toBe(text);
    });
  });

  test("何度かけても同じ (伏せた印をさらに伏せない)", () => {
    const once = redact(
      "http://192.168.1.2:8080 card 0123456789012345 token=abc nas:445",
    );
    expect(redact(once)).toBe(once);
  });
});
