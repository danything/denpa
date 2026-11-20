import { afterAll, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packetize, patSection, programMap } from "@danything/arib/synth";

import { CHANNEL } from "#lib/live.js";

import type { HwDevice } from "./hwenc";

/**
 * **段を下げる枠が空かなかったら、今のセッションに留まる** (`attend`)。TS で送る 4K の局では、段を下げた H.265 のセッションが
 * PMT を読んで送る形式を H.264 に替える (`hevcTsCodec`)。留まる先はリクエストされた形式 (`asked`) で比べる。
 *
 * 画面の WebSocket の代わりに `Connection` に偽のソケットを渡し、選局は `./tuner` の `openWhenFree` を差し替えて
 * PAT と HEVC の PMT だけの TS を流す。ffmpeg は起きたまま何も出さない偽物。GPU は H.265 だけ、その場で変換する本数の枠は 1 本。
 * DB は一時ファイルへ
 */
const dir = mkdtempSync(join(tmpdir(), "denpa-live-rung-stay-"));
const ffmpeg = join(dir, "ffmpeg");
writeFileSync(ffmpeg, "#!/bin/sh\nexec sleep 60\n");
chmodSync(ffmpeg, 0o755);
const { config } = await import("./config");
config.dbPath = join(dir, "denpa.db");
config.ffmpeg = ffmpeg;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PROGRAM = 0x0401;
/** ケーブルの局 (`types.serviceKey`) */
const SERVICE = (0x10000 + 0x0004) * 100000 + PROGRAM;

/** PAT と、映像が HEVC (0x24) の PMT。TS に HEVC を入れて送る 4K の局 */
const HEAD = Uint8Array.from([
  ...packetize(0x0000, patSection([[PROGRAM, 0x1000]])),
  ...packetize(
    0x1000,
    programMap(PROGRAM, 0x0100, [
      [0x24, 0x0100],
      [0x0f, 0x0110],
    ]),
  ),
]);

/** 選局した回数。新しくエンコードし始めたセッションごとに 1 回 */
let tunes = 0;
const actualTuner = await import("./tuner");
mock.module("./tuner", () => ({
  ...actualTuner,
  openWhenFree: async (
    _type: string,
    _places: unknown,
    signal: AbortSignal,
  ) => {
    tunes++;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(HEAD);
        signal.addEventListener("abort", () => controller.close());
      },
    });
    return { stream, place: { agent: 1, channel: "QC30" } };
  },
  tunersOf: async () => [],
}));

const GPU: HwDevice = {
  path: "/dev/dri/renderD128",
  label: "GPU",
  vaapi: ["hevc"],
  rkmpp: [],
  nvenc: [],
  qsv: [],
  amf: [],
  videotoolbox: [],
  mediacodec: [],
  cqp: [],
  amfTranscoding: [],
  qsvSystem: [],
  full: ["hevc"],
};
const actualHw = await import("./hwenc");
mock.module("./hwenc", () => ({
  ...actualHw,
  hwEncode: () => ({ probed: true, devices: [GPU], message: "" }),
}));

/** その場で変換する本数の枠。1 本だけ */
let used = 0;
const actualTranscode = await import("./transcode");
mock.module("./transcode", () => ({
  ...actualTranscode,
  transcodeRoom: () => 1 - used,
  holdTranscode: () => {
    if (used >= 1) return null;
    used++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      used--;
    };
  },
}));

const { now, orm } = await import("./db");
const { services } = await import("./schema");
const { placeServices } = await import("./fake-channels");
const { attend } = await import("./live");
const { Connection } = await import("./ws");

orm()
  .insert(services)
  .values({
    id: SERVICE,
    service_id: PROGRAM,
    network_id: 0x0004,
    name: "ケーブル 4K",
    type: "CATV",
    service_type: 1,
    transport: "ts",
    updated_at: now(),
  })
  .run();
placeServices([{ id: SERVICE, channel: "QC30" }]);

/** 画面の WebSocket の代わり。送られた制御の JSON を取っておく */
function viewer(): {
  connection: InstanceType<typeof Connection>;
  notices: Record<string, unknown>[];
} {
  const notices: Record<string, unknown>[] = [];
  const socket = {
    getBufferedAmount: () => 0,
    sendBinary: (out: Uint8Array) => {
      if (out[0] !== CHANNEL.control) return;
      notices.push(
        JSON.parse(new TextDecoder().decode(out.subarray(9))) as Record<
          string,
          unknown
        >,
      );
    },
  };
  const connection = new Connection(socket as never);
  attend(connection);
  return { connection, notices };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("待ちきれませんでした");
    await Bun.sleep(20);
  }
}

const tune = (rung: number) => ({
  type: "tune",
  channelType: "CATV",
  channel: "QC30",
  serviceId: SERVICE,
  codec: "hevc",
  rung,
  playable: ["hevc", "h264"],
});

describe("段を下げる枠が空かないとき", () => {
  test("TS で送る 4K の局で形式を替えたセッションにも留まり、枠なしで新しくエンコードし始めない", async () => {
    const a = viewer();
    const b = viewer();
    // 段 1 の H.265 で開く (枠を 1 本使う)。PMT を読むと、4K の局として段 1 を H.264 でエンコードし直すと答え直す
    a.connection.onmessage?.(tune(1));
    expect(a.notices[0]).toMatchObject({ type: "tuned", codec: "hevc" });
    await until(() =>
      a.notices.some(
        (notice) =>
          notice["type"] === "tuned" &&
          notice["codec"] === "h264" &&
          notice["broadcast"] === "hevc",
      ),
    );
    expect(tunes).toBe(1);
    expect(used).toBe(1);
    // もう 1 人が同じ段で観る (同じセッションを共有する)。a が抜けても枠は空かない
    b.connection.onmessage?.(tune(1));
    expect(tunes).toBe(1);

    // 段 2 をリクエストしても枠が空かないので、今の段 1 のセッションに留まる
    const before = a.notices.length;
    a.connection.onmessage?.(tune(2));
    const answers = a.notices.slice(before);
    expect(answers).toContainEqual(expect.objectContaining({ type: "notice" }));
    // 今のセッションの答え (PMT を読んで替えた形式)。新しくエンコードし始めると、まだ PMT を読んでいない答えになる
    expect(answers[0]).toMatchObject({
      type: "tuned",
      codec: "h264",
      rung: 1,
      broadcast: "hevc",
    });
    await Bun.sleep(100);
    expect(tunes).toBe(1);
    expect(used).toBe(1);

    a.connection.finish();
    b.connection.finish();
  });
});
