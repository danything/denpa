import { describe, expect, test } from "bun:test";

import { BROADCAST_HEVC_VIDEO, broadcastHevcPlayable } from "./hevc-4k";
import { BROADCAST_HEVC } from "./live";

/** **4K の局の放送の HEVC を再生できるか** (`broadcastHevcPlayable`)。MSE と、放送の値を渡した `decodingInfo` の両方で決める */
describe("4K の HEVC を再生できるか", () => {
  const asked: unknown[] = [];
  const probe = (mse: boolean, decode?: boolean | "throw") => ({
    isTypeSupported: (type: string) => mse && type === BROADCAST_HEVC,
    ...(decode === undefined
      ? {}
      : {
          decodingInfo: async (config: unknown) => {
            asked.push(config);
            if (decode === "throw") throw new Error("聞けない");
            return { supported: decode };
          },
        }),
  });

  test("MSE が受け取れなければ再生できない (decodingInfo は聞かない)", async () => {
    asked.length = 0;
    expect(await broadcastHevcPlayable(probe(false, true))).toBe(false);
    expect(asked).toHaveLength(0);
  });

  test("受け取れても、放送の値 (2160p・59.94 コマ・HLG・BT.2020) でデコードできなければ再生できない", async () => {
    asked.length = 0;
    expect(await broadcastHevcPlayable(probe(true, false))).toBe(false);
    expect(asked).toEqual([
      { type: "media-source", video: BROADCAST_HEVC_VIDEO },
    ]);
    expect(BROADCAST_HEVC_VIDEO).toMatchObject({
      width: 3840,
      height: 2160,
      transferFunction: "hlg",
      colorGamut: "rec2020",
    });
    expect(await broadcastHevcPlayable(probe(true, true))).toBe(true);
  });

  test("decodingInfo が無ければ MSE だけで決め、失敗したら再生できないとみる", async () => {
    expect(await broadcastHevcPlayable(probe(true))).toBe(true);
    expect(await broadcastHevcPlayable(probe(true, "throw"))).toBe(false);
  });
});
