import { afterAll, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HwDevice } from "./hwenc";

/**
 * **試しのエンコードの落とし方** (`hwenc.probe`)。手元にも CI にも GPU は無いので、ffmpeg を
 * 起こす `run` だけ差し替えて、ドライバの返事を作って見る。
 *
 * 作る返事は issue #417 の機材 (Gemini Lake・i965) に寄せたもの: QSV は初期化できず、
 * VA-API は ICQ を持たず CQP ならエンコードでき、MPEG-2 は GPU でデコードできる。AV1 はエンコードできない。
 * H.265 は H.264 と同じく CQP で通る側にしてある (デコードから GPU は、ライブが使わない H.265 では試さない)
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
// NVIDIA の GPU のデバイスファイルも、下のテストが置くまで無い (本物の /dev は見ない)
const nvidiaDirBefore = config.nvidiaDir;
const nvidiaDir = join(dir, "nvidia");
mkdirSync(nvidiaDir);
config.nvidiaDir = nvidiaDir;
afterAll(() => {
  answer = null;
  config.hwDevices = devicesBefore;
  config.rkmppDevice = rkmppBefore;
  config.nvidiaDir = nvidiaDirBefore;
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
  expect(device.vaapi).toEqual(["hevc", "h264"]);
  expect(device.cqp).toEqual(["hevc", "h264"]);
  // H.265 の CQP も qp 24 (H.264 と同じ 0〜51 の軸)
  expect(
    calls.some((argv) =>
      argv.join(" ").includes("hevc_vaapi -rc_mode CQP -qp 24"),
    ),
  ).toBe(true);
  // デコードから GPU の試しは H.264 だけ (ライブは H.265 を出さない)
  expect(
    calls
      .filter((argv) => argv.includes("-hwaccel"))
      .map((argv) => argv.find((a) => a.endsWith("_vaapi"))),
  ).toEqual(["h264_vaapi"]);
  // デコードから GPU の試しも CQP で指定している (ICQ で指定すると i965 では落ちる)
  const full = calls.find((argv) => argv.includes("-hwaccel"));
  expect(full?.join(" ")).toContain("-rc_mode CQP -qp 24");
  expect(full?.join(" ")).toContain("deinterlace_vaapi=rate=field");
  expect(device.full).toEqual(["h264"]);
  expect(describeDevice(device)).toBe(
    "VA-API: H.265 (CQP) / H.264 (CQP)、ライブはデコードから GPU: H.264",
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
  expect(devices[0]!.vaapi).toEqual(["av1", "hevc", "h264"]);
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
  expect(devices[0]!.vaapi).toEqual(["av1", "hevc", "h264"]);
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

test("/dev/mpp_service が在れば、別の行で H.264 と H.265 だけ MPP で試す", async () => {
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
      rkmpp: ["hevc", "h264"],
      nvenc: [],
      full: [],
    });
    const tried = calls.filter((argv) =>
      argv.some((a) => a.endsWith("_rkmpp")),
    );
    expect(tried.map((argv) => argv.find((a) => a.endsWith("_rkmpp")))).toEqual(
      ["hevc_rkmpp", "h264_rkmpp"],
    );
    expect(describeDevice(mpp)).toBe("Rockchip MPP: H.265 / H.264");
    expect(message).toBe(
      "デバイスが 2 個見つかり、2 個で GPU エンコードできます",
    );

    // MPP が開けなければ (BSP でないカーネル) 行は出るが、使えない
    answer = (argv) => (argv.some((a) => a.endsWith("_rkmpp")) ? 1 : 0);
    const again = await probe();
    expect(again.devices[1]!.rkmpp).toEqual([]);
  } finally {
    rmSync(mppService, { force: true });
  }
});

test("NVIDIA の GPU は1枚ずつ別の行で NVENC を試し、GPU の番号で選ぶ", async () => {
  // 2枚挿し。nvidiactl は GPU ではないので行にしない
  for (const name of ["nvidia0", "nvidia1", "nvidiactl"])
    writeFileSync(join(nvidiaDir, name), "");
  try {
    // 1枚目 (-gpu 0) は RTX 40 より前で AV1 をエンコードできない。QSV はどの行でも落ちる
    answer = (argv) => {
      const line = argv.join(" ");
      if (line.includes("qsv")) return 1;
      if (line.includes("av1_nvenc -gpu 0")) return 1;
      return 0;
    };
    calls.length = 0;
    const { devices, message } = await probe();
    expect(devices.map((d) => d.path)).toEqual([
      join(dir, "renderD128"),
      join(nvidiaDir, "nvidia0"),
      join(nvidiaDir, "nvidia1"),
    ]);
    const [gpu, n0, n1] = devices as [HwDevice, HwDevice, HwDevice];
    // renderD* では NVENC を試さない
    expect(gpu.nvenc).toEqual([]);
    expect(n0).toMatchObject({
      label: "nvidia0 (NVIDIA)",
      gpu: 0,
      qsv: [],
      vaapi: [],
      nvenc: ["hevc", "h264"],
      full: [],
    });
    expect(n1).toMatchObject({ gpu: 1, nvenc: ["av1", "hevc", "h264"] });
    // GPU の番号はデバイスファイルの並びの位置。デバイスファイルは ffmpeg に渡さない
    const tried = calls.filter((argv) =>
      argv.some((a) => a.endsWith("_nvenc")),
    );
    expect(tried).toHaveLength(6);
    expect(tried.every((argv) => !argv.join(" ").includes(nvidiaDir))).toBe(
      true,
    );
    expect(describeDevice(n0)).toBe("NVENC: H.265 / H.264");
    expect(describeDevice(n1)).toBe("NVENC: AV1 / H.265 / H.264");
    expect(message).toBe(
      "デバイスが 3 個見つかり、3 個で GPU エンコードできます",
    );
    // ライブも番号を添えて NVENC に載る (デコードから GPU はしない)
    expect(liveHw("av1", {}, 0, [n0, n1])).toEqual({
      way: { device: n1.path, kind: "nvenc", gpu: 1 },
      full: false,
    });
  } finally {
    rmSync(nvidiaDir, { recursive: true, force: true });
    mkdirSync(nvidiaDir);
  }
});
