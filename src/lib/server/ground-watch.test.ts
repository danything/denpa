import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NitReader } from "@danything/arib/psi";
import { nitSection, packetize } from "@danything/arib/synth";

import type { AgentChannel } from "./tuner";

/**
 * 地上波は付いていかず、知らせるだけ。合成の NIT と受信の記録で、お知らせの 1 行が出ることを見る
 */
const { config } = await import("./config");
config.dbPath = join(mkdtempSync(join(tmpdir(), "denpa-ground-")), "denpa.db");

const { orm } = await import("./db");
const { channelReception } = await import("./schema");
const { recordFailed, recordReceived } = await import("./reception");
const { compareGround, forgetGround, groundNotice } =
  await import("./ground-watch");

const HOUR = 60 * 60_000;
const T0 = 1_800_000_000_000;

/** TOKYO MX (T16)。控えには MX1 (23608) だけ */
const MX: AgentChannel = {
  type: "GR",
  channel: "T16",
  networkId: 32391,
  transportStreamId: 32391,
  remoteControlKeyId: 9,
  services: [
    { serviceId: 23608, serviceType: 1, name: "ＴＯＫＹＯ　ＭＸ１" },
    { serviceId: 23615, serviceType: 192, name: "ＭＸデータ" },
  ],
};

function nitOf(services: [number, number][]): NitReader {
  const nit = new NitReader();
  nit.feed(packetize(0x10, nitSection(32391, 9, [[32391, 32391, services]])));
  return nit;
}

beforeEach(() => {
  orm().delete(channelReception).run();
  forgetGround([]);
  compareGround(MX, nitOf([[23608, 0x01]]));
});

describe("地上波の知らせ", () => {
  test("局の顔ぶれが控えと違えば知らせ、同じに戻れば消す", () => {
    expect(groundNotice()).toBeNull();
    // MX2 (23610) が増えた。データ放送の違いは数えない
    compareGround(
      MX,
      nitOf([
        [23608, 0x01],
        [23610, 0x01],
      ]),
    );
    expect(groundNotice()).toBe(
      "T16 の局が、受信できるチャンネルと違います。地上波をスキャンし直すと、新しい局を選局できます",
    );
    compareGround(
      MX,
      nitOf([
        [23608, 0x01],
        [23615, 0xc0],
      ]),
    );
    expect(groundNotice()).toBeNull();
  });

  test("スキャンし直して控えから消えたチャンネルの違いは忘れる", () => {
    compareGround(
      MX,
      nitOf([
        [23608, 0x01],
        [23610, 0x01],
      ]),
    );
    forgetGround([{ ...MX, channel: "T23" }]);
    expect(groundNotice()).toBeNull();
  });

  test("続けて選局できないチャンネルを知らせる (外さない)", () => {
    recordReceived("GR", "T16", T0);
    recordFailed("GR", "T27", T0 + HOUR);
    recordReceived("GR", "T16", T0 + 2 * HOUR);
    recordFailed("GR", "T27", T0 + 3 * HOUR);
    expect(groundNotice()).toBe(
      "T27 を続けて選局できません。周波数が変わった場合は、地上波をスキャンし直すと選局できます",
    );
    // 受信できたら消える
    recordReceived("GR", "T27", T0 + 4 * HOUR);
    expect(groundNotice()).toBeNull();
  });

  test("地上波がどれも選局できなくなったら知らせない (アンテナの問題)", () => {
    recordReceived("GR", "T16", T0);
    recordFailed("GR", "T27", T0 + HOUR);
    recordFailed("GR", "T16", T0 + HOUR + 1);
    recordFailed("GR", "T27", T0 + 3 * HOUR);
    recordFailed("GR", "T16", T0 + 3 * HOUR + 1);
    expect(groundNotice()).toBeNull();
  });
});
