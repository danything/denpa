import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HwDevice } from "./hwenc";

/**
 * **試しのエンコードの落とし方** (`hwenc.probe`)。手元にも CI にも GPU は無いので、ffmpeg を
 * 起こす `run` だけ差し替えて、ドライバの返事を作って見る。
 *
 * 作る返事は issue #417 の機材 (Gemini Lake・i965) に寄せたもの: QSV は初期化できず、
 * VA-API は ICQ を持たず CQP ならエンコードでき、MPEG-2 は GPU でデコードできる。AV1 はエンコードできない
 */
const real = await import("./stream");
/*
 * **差し替えはこのファイルの中だけで効かせる。** bun は1つのプロセスで全部のテストを回し、
 * `mock.module` は他のファイルにも残る。終わったら本物の `run` に戻す (下の `afterAll`)
 */
const realRun = real.run;
const calls: string[][] = [];
let answer: ((argv: string[]) => number) | null = null;
mock.module("./stream", () => ({
  ...real,
  run: async (argv: string[], options?: Parameters<typeof realRun>[1]) => {
    if (answer === null) return realRun(argv, options);
    calls.push(argv);
    return { code: answer(argv), stdout: new Uint8Array(), stderr: "" };
  },
}));

const { config } = await import("./config");
const dir = mkdtempSync(join(tmpdir(), "dri-"));
writeFileSync(join(dir, "renderD128"), "");
const devicesBefore = config.hwDevices;
const rkmppBefore = config.rkmppDevice;
config.hwDevices = `${dir}/renderD*`;
// Rockchip MPP のデバイスは下のテストが置くまで無い
const mppService = join(dir, "mpp_service");
config.rkmppDevice = mppService;
afterAll(() => {
  answer = null;
  config.hwDevices = devicesBefore;
  config.rkmppDevice = rkmppBefore;
});

const { probe, describeDevice, liveHw } = await import("./hwenc");

/** i965 らしい返事 */
function i965(argv: string[]): number {
  const line = argv.join(" ");
  if (line.includes("-f mpegts")) return 0; // 試し素材を作る (CPU)
  if (line.includes("qsv")) return 1;
  if (line.includes("av1_vaapi")) return 1;
  if (line.includes("-rc_mode ICQ")) return 1;
  return 0;
}

test("ICQ が落ちたら CQP で試し、通ったほうを覚える", async () => {
  answer = i965;
  calls.length = 0;
  const { devices } = await probe();
  expect(devices).toHaveLength(1);
  const device = devices[0]!;
  expect(device.qsv).toEqual([]);
  expect(device.vaapi).toEqual(["h264"]);
  expect(device.cqp).toEqual(["h264"]);
  // デコードから GPU の試しも CQP で指定している (ICQ で指定すると i965 では落ちる)
  const full = calls.find((argv) => argv.includes("-hwaccel"));
  expect(full?.join(" ")).toContain("-rc_mode CQP -qp 24");
  expect(full?.join(" ")).toContain("deinterlace_vaapi=rate=field");
  expect(device.full).toEqual(["h264"]);
  expect(describeDevice(device)).toBe(
    "VA-API: H.264 (CQP)、ライブはデコードから GPU: H.264",
  );
  // ライブはデコードから GPU の方式を、CQP のまま採る
  expect(liveHw("h264", {}, 0, devices)).toEqual({
    way: { device: device.path, kind: "vaapi", cqp: true },
    full: true,
  });
});

test("ICQ が通れば CQP は試さない", async () => {
  answer = (argv) => (argv.join(" ").includes("qsv") ? 1 : 0);
  calls.length = 0;
  const { devices } = await probe();
  expect(devices[0]!.vaapi).toEqual(["av1", "h264"]);
  expect(devices[0]!.cqp).toEqual([]);
  expect(calls.some((argv) => argv.includes("CQP"))).toBe(false);
});

test("MPEG-2 を GPU でデコードできなければ、エンコードするところだけ GPU", async () => {
  answer = (argv) => {
    const line = argv.join(" ");
    if (line.includes("qsv") || line.includes("-hwaccel")) return 1;
    return 0;
  };
  const { devices } = await probe();
  expect(devices[0]!.vaapi).toEqual(["av1", "h264"]);
  expect(devices[0]!.full).toEqual([]);
  expect(liveHw("h264", {}, 0, devices)).toEqual({
    way: { device: devices[0]!.path, kind: "vaapi" },
    full: false,
  });
});

test("試し素材を作れなければ、デコードから GPU は試さない", async () => {
  answer = (argv) =>
    argv.join(" ").includes("-f mpegts") || argv.join(" ").includes("qsv")
      ? 1
      : 0;
  calls.length = 0;
  const { devices } = await probe();
  expect(devices[0]!.full).toEqual([]);
  expect(calls.some((argv) => argv.includes("-hwaccel"))).toBe(false);
});

test("/dev/mpp_service が在れば、別の行で H.264 だけ h264_rkmpp を試す", async () => {
  writeFileSync(mppService, "");
  try {
    answer = (argv) => (argv.join(" ").includes("qsv") ? 1 : 0);
    calls.length = 0;
    const { devices, message } = await probe();
    expect(devices.map((d) => d.path)).toEqual([
      join(dir, "renderD128"),
      mppService,
    ]);
    const [gpu, mpp] = devices as [HwDevice, HwDevice];
    // renderD* では MPP を試さない (同じエンコーダが GPU の行に並ばない)
    expect(gpu.rkmpp).toEqual([]);
    expect(mpp).toMatchObject({
      label: "mpp_service (Rockchip)",
      qsv: [],
      vaapi: [],
      rkmpp: ["h264"],
      full: [],
    });
    const tried = calls.filter((argv) =>
      argv.some((a) => a.endsWith("_rkmpp")),
    );
    expect(tried.map((argv) => argv.find((a) => a.endsWith("_rkmpp")))).toEqual(
      ["h264_rkmpp"],
    );
    expect(describeDevice(mpp)).toBe("Rockchip MPP: H.264");
    expect(message).toBe(
      "デバイスが 2 個見つかり、2 個で GPU エンコードできます",
    );

    // MPP が開けなければ (BSP でないカーネル) 行は出るが、使えない
    answer = (argv) => (argv.includes("h264_rkmpp") ? 1 : 0);
    const again = await probe();
    expect(again.devices[1]!.rkmpp).toEqual([]);
  } finally {
    rmSync(mppService, { force: true });
  }
});
