import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HwDevice } from "./hwenc";

/**
 * **試しのエンコードの落とし方** (`hwenc.probe`)。手元にも CI にも GPU は無いので、ffmpeg を
 * 起動する `run` だけ差し替えて、ドライバの返事を作って見る。
 *
 * 作る返事は issue #417 の機材 (Gemini Lake・i965) に寄せたもの。
 * VA-API は ICQ を持たず、MPEG-2 は GPU でデコードできる。AV1 はエンコードできない。
 * H.264・H.265 はいつも CQP で指定するので通る (デコードから GPU は、ライブが使わない H.265 では試さない)。
 * AV1 も CQP で通るドライバ (Mesa) は下の `mesa`
 */
const real = await import("./stream");
/*
 * **差し替えはこのファイルの中だけで効かせる。** `--isolate` を付けずに動かすと `mock.module` は
 * 他のファイルにも残るので、終わったら本物の `run` に戻す (下の `afterAll`)
 */
const realRun = real.run;
const calls: string[][] = [];
let answer: ((argv: string[]) => number) | null = null;
/** 落ちたときに ffmpeg が標準エラーに出すもの */
let failText = "";
mock.module("./stream", () => ({
  ...real,
  run: async (argv: string[], options?: Parameters<typeof realRun>[1]) => {
    if (answer === null) return realRun(argv, options);
    calls.push(argv);
    const code = answer(argv);
    return {
      code,
      stdout: new Uint8Array(),
      stderr: code === 0 ? "" : failText,
    };
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

const { probe, describeDevice, liveHw, hwArgs, hwChain, hwReady, hwEncode } =
  await import("./hwenc");

/** i965 らしい返事 */
function i965(argv: string[]): number {
  const line = argv.join(" ");
  if (line.includes("-f mpegts")) return 0; // 試し素材を作る (CPU)
  if (line.includes("av1_vaapi")) return 1;
  if (line.includes("-rc_mode ICQ")) return 1;
  return 0;
}

/*
 * **録画のエンコードは確かめ終わるのを待つ** (`hwReady`)。起動した直後のジョブが、確かめる前の「GPU 無し」で
 * H.265 を飛ばしていた。まだなら確かめて待ち、確かめ終わっていれば ffmpeg を起動しない
 */
test("hwReady: まだ確かめていなければ確かめ終わるのを待ち、済んでいれば探し直さない", async () => {
  answer = i965;
  calls.length = 0;
  const wasProbed = hwEncode().probed;
  const ready = await hwReady();
  expect(ready.probed).toBe(true);
  expect(ready.devices[0]?.vaapi).toEqual(["hevc", "h264"]);
  if (!wasProbed) expect(calls.length).toBeGreaterThan(0);
  calls.length = 0;
  expect(await hwReady()).toBe(hwEncode());
  expect(calls).toEqual([]);
});

test("H.264・H.265 は初めから CQP で試し、ICQ では試さない", async () => {
  answer = i965;
  calls.length = 0;
  const { devices } = await probe();
  expect(devices).toHaveLength(1);
  const device = devices[0]!;
  expect(device.vaapi).toEqual(["hevc", "h264"]);
  // CQP の印は AV1 が ICQ から落ちたときだけ。H.264・H.265 はいつも CQP なので付けない
  expect(device.cqp).toEqual([]);
  const lines = calls.map((argv) => argv.join(" "));
  // 録画と同じ引数 (品質寄りの段と B フレームのピラミッドも) で試す。どれもドライバが持たなくても落ちない
  for (const [codec, factor] of [
    ["hevc", "1.4"],
    ["h264", "1.3"],
  ]) {
    expect(
      lines.some((l) =>
        l.includes(
          `${codec}_vaapi -rc_mode CQP -qp 24 -compression_level:v 1 -bf 3 -b_depth 2 -b_qfactor ${factor}`,
        ),
      ),
    ).toBe(true);
  }
  expect(lines.some((l) => /(h264|hevc)_vaapi -rc_mode ICQ/.test(l))).toBe(
    false,
  );
  // デコードから GPU の試しは H.265 と H.264 (ライブはどちらも出す)
  expect(
    calls
      .filter((argv) => argv.includes("-hwaccel"))
      .map((argv) => argv.find((a) => a.endsWith("_vaapi"))),
  ).toEqual(["hevc_vaapi", "h264_vaapi"]);
  // デコードから GPU の試しはライブと同じ引数 (qp 25、ピラミッドなし)
  const full = calls.find((argv) => argv.includes("-hwaccel"));
  expect(full?.join(" ")).toContain("-rc_mode CQP -qp 25 -bf 0 -async_depth 1");
  expect(full?.join(" ")).toContain("deinterlace_vaapi=rate=field");
  expect(device.full).toEqual(["hevc", "h264"]);
  expect(describeDevice(device)).toBe(
    "VA-API: H.265 / H.264、ライブはデコードから GPU: H.265 / H.264",
  );
  expect(liveHw("h264", {}, 0, devices)).toEqual({
    way: { device: device.path, kind: "vaapi" },
    full: true,
  });
});

/** Mesa (AMD) らしい返事。ICQ を持たないが、AV1 も CQP ならエンコードできる */
function mesa(argv: string[]): number {
  return argv.join(" ").includes("-rc_mode ICQ") ? 1 : 0;
}

test("AV1 は ICQ が落ちたら CQP (-global_quality 75) で試し、通ったほうを覚える", async () => {
  answer = mesa;
  calls.length = 0;
  const { devices } = await probe();
  const device = devices[0]!;
  expect(device.vaapi).toEqual(["av1", "hevc", "h264"]);
  expect(device.cqp).toEqual(["av1"]);
  const lines = calls.map((argv) => argv.join(" "));
  expect(lines.some((l) => l.includes("av1_vaapi -rc_mode ICQ"))).toBe(true);
  expect(
    lines.some((l) =>
      l.includes(
        "av1_vaapi -rc_mode CQP -global_quality:v 75 -compression_level:v 1",
      ),
    ),
  ).toBe(true);
  // デコードから GPU の試しも、AV1 は CQP のまま
  const fullAv1 = calls.find(
    (argv) => argv.includes("-hwaccel") && argv.includes("av1_vaapi"),
  );
  expect(fullAv1?.join(" ")).toContain("-rc_mode CQP -global_quality:v 75");
  expect(device.full).toEqual(["av1", "hevc", "h264"]);
  // (CQP) を添えるのは AV1 の落とした分だけ
  expect(describeDevice(device)).toBe(
    "VA-API: AV1 (CQP) / H.265 / H.264、ライブはデコードから GPU: AV1 / H.265 / H.264",
  );
  // ライブはデコードから GPU の方式を、AV1 は CQP のまま採る
  expect(liveHw("av1", {}, 0, devices)).toEqual({
    way: { device: device.path, kind: "vaapi", cqp: true },
    full: true,
  });
  expect(liveHw("h264", {}, 0, devices)).toEqual({
    way: { device: device.path, kind: "vaapi" },
    full: true,
  });
});

test("AV1 の ICQ が通れば CQP は試さない", async () => {
  answer = () => 0;
  calls.length = 0;
  const { devices } = await probe();
  expect(devices[0]!.vaapi).toEqual(["av1", "hevc", "h264"]);
  expect(devices[0]!.cqp).toEqual([]);
  expect(
    calls.some((argv) => argv.join(" ").includes("av1_vaapi -rc_mode CQP")),
  ).toBe(false);
  // QSV は試さない (VA-API だけ)
  expect(calls.some((argv) => argv.join(" ").includes("qsv"))).toBe(false);
});

test("MPEG-2 を GPU でデコードできなければ、エンコードするところだけ GPU", async () => {
  answer = (argv) => {
    const line = argv.join(" ");
    if (line.includes("-hwaccel")) return 1;
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
  answer = (argv) => (argv.join(" ").includes("-f mpegts") ? 1 : 0);
  calls.length = 0;
  const { devices } = await probe();
  expect(devices[0]!.full).toEqual([]);
  expect(calls.some((argv) => argv.includes("-hwaccel"))).toBe(false);
});

test("/dev/mpp_service があれば、別の行で H.264 と H.265 だけ MPP で試す", async () => {
  writeFileSync(mppService, "");
  try {
    answer = () => 0;
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
      vaapi: [],
      rkmpp: ["hevc", "h264"],
      nvenc: [],
      qsv: [],
      amf: [],
      videotoolbox: [],
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

test("NVIDIA の GPU は 1 枚ずつ別の行で NVENC を試し、GPU の番号で選ぶ", async () => {
  // 2 枚挿し。nvidiactl は GPU ではないので行にしない
  for (const name of ["nvidia0", "nvidia1", "nvidiactl"])
    writeFileSync(join(nvidiaDir, name), "");
  try {
    // 1 枚目 (-gpu 0) は RTX 40 より前で AV1 をエンコードできない
    answer = (argv) => {
      const line = argv.join(" ");
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
      vaapi: [],
      nvenc: ["hevc", "h264"],
      qsv: [],
      amf: [],
      videotoolbox: [],
      full: [],
    });
    expect(n1).toMatchObject({
      gpu: 1,
      nvenc: ["av1", "hevc", "h264"],
      qsv: [],
      amf: [],
      videotoolbox: [],
    });
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

/** Windows の探し方 (`probeWindows`)。OS の名前だけ差し替えて、ffmpeg の返事を作る */
async function onWindows<T>(body: () => Promise<T>): Promise<T> {
  const before = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    return await body();
  } finally {
    Object.defineProperty(process, "platform", before);
  }
}

test("Windows で GPU が無ければ、行は 0 でソフトウェアにする", async () => {
  answer = () => 1;
  calls.length = 0;
  const { devices, message } = await onWindows(() => probe());
  expect(devices).toEqual([]);
  expect(liveHw("h264", {}, 0, devices)).toBeNull();
  expect(hwChain("h264", {}, 0, devices)).toEqual([]);
  expect(message).toContain("ソフトウェアでエンコードします");
  // /dev の探し方は使わない。NVENC は 0 番が落ちたら止め、QSV・AMF は 4 番まで H.264 だけ試す
  // (AMF は番号ごとに高画質の指定と古い世代向けの指定の 2 回)
  const lines = calls.map((argv) => argv.join(" "));
  expect(lines.filter((l) => l.includes("_nvenc"))).toHaveLength(1);
  expect(lines.filter((l) => l.includes("_qsv"))).toHaveLength(4);
  expect(lines.filter((l) => l.includes("_amf"))).toHaveLength(8);
  expect(lines.some((l) => l.includes("_vaapi"))).toBe(false);
});

test("Windows は NVENC・QSV・AMF を番号ごとに試し、通った番号だけを行にする", async () => {
  // NVIDIA 1 枚 (AV1 は RTX 40 より前で無い)、Intel (アダプタ 1。0 は NVIDIA で QSV が落ちる)、AMD 無し
  answer = (argv) => {
    const line = argv.join(" ");
    if (line.includes("av1_")) return 1;
    if (line.includes("_nvenc -gpu 0")) return 0;
    if (line.includes("child_device=1")) return 0;
    return 1;
  };
  calls.length = 0;
  const { devices, message } = await onWindows(() => probe());
  expect(devices.map((d) => d.path)).toEqual(["nvidia0", "qsv1"]);
  expect(devices[0]).toMatchObject({
    label: "nvidia0 (NVIDIA)",
    gpu: 0,
    nvenc: ["hevc", "h264"],
    qsv: [],
    amf: [],
    videotoolbox: [],
  });
  expect(devices[1]).toMatchObject({
    label: "qsv1 (Intel)",
    gpu: 1,
    qsv: ["hevc", "h264"],
    nvenc: [],
  });
  expect(describeDevice(devices[1]!)).toBe("QSV: H.265 / H.264");
  expect(message).toBe(
    "デバイスが 2 個見つかり、2 個で GPU エンコードできます",
  );
  // 同じコーデックを両方で使える。QSV はアダプタの番号を添える
  expect(hwChain("h264", {}, 1, devices)).toEqual([
    { device: "qsv1", kind: "qsv", gpu: 1 },
    { device: "nvidia0", kind: "nvenc", gpu: 0 },
  ]);
  // 通らなかった H.264 の番号 (AMF) では、AV1・H.265 を試さない
  const lines = calls.map((argv) => argv.join(" "));
  expect(lines.filter((l) => l.includes("_amf"))).toHaveLength(8);
  expect(lines.some((l) => l.includes("hevc_amf"))).toBe(false);
});

test("AMF は高画質の指定で落ちたら古い世代向けの指定で試し、通ったほうで録画する", async () => {
  // VCN 1.0 (Raven Ridge) らしい返事。アダプタ 0 の AMD で、AV1 は持たず、`-usage high_quality` を受けない
  answer = (argv) => {
    const line = argv.join(" ");
    if (!line.includes("d3d11va=d3d:0") || !line.includes("_amf")) return 1;
    if (line.includes("av1_amf")) return 1;
    return line.includes("-usage high_quality") ? 1 : 0;
  };
  failText = [
    "[h264_amf @ 0000020] encoder->Init() failed with error 9",
    "[vost#0:0/h264_amf @ 0000021] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.",
    "Error while filtering: Generic error in an external library",
    "Conversion failed!",
  ].join("\n");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const log = spyOn(console, "log").mockImplementation(() => {});
  calls.length = 0;
  try {
    const { devices } = await onWindows(() => probe());
    expect(devices.map((d) => d.path)).toEqual(["amf0"]);
    const device = devices[0]!;
    expect(device).toMatchObject({
      label: "amf0 (AMD)",
      gpu: 0,
      amf: ["hevc", "h264"],
      amfTranscoding: ["hevc", "h264"],
    });
    expect(describeDevice(device)).toBe(
      "AMF: H.265 (古い世代向けの指定) / H.264 (古い世代向けの指定)",
    );
    // 録画もライブも、その行の指定で GPU に載る
    const way = hwChain("h264", {}, 0, devices)[0]!;
    expect(way).toEqual({
      device: "amf0",
      kind: "amf",
      gpu: 0,
      amfTranscoding: true,
    });
    expect(hwArgs(way, "h264").encoder.slice(0, 5)).toEqual([
      "h264_amf",
      "-usage",
      "transcoding",
      "-quality",
      "quality",
    ]);
    expect(liveHw("hevc", {}, 0, devices)?.way).toMatchObject({
      kind: "amf",
      amfTranscoding: true,
    });
    // 高画質の指定を先に試し、落ちたときだけ古い世代向けの指定で試す
    const amf0 = calls
      .map((argv) => argv.join(" "))
      .filter((l) => l.includes("h264_amf") && l.includes("d3d11va=d3d:0"));
    expect(amf0).toHaveLength(2);
    expect(amf0[0]).toContain("-usage high_quality -quality high_quality");
    expect(amf0[1]).toContain("-usage transcoding -quality quality");
    // 落ちた理由は ffmpeg のエラーの最後の 3 行をログに出す
    const logged = warn.mock.calls.map((args) => String(args[0]));
    expect(logged).toContain(
      "[hwenc] h264_amf (amf0) の試しのエンコードが落ちました (終了コード 1): [vost#0:0/h264_amf @ 0000021] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height. / Error while filtering: Generic error in an external library / Conversion failed!",
    );
    // 警告のあとに、古い世代向けの指定で使えることも出す
    expect(log.mock.calls.map((args) => String(args[0]))).toContain(
      "[hwenc] h264_amf (amf0) は古い世代向けの指定でエンコードできました。この指定で使います",
    );
  } finally {
    warn.mockRestore();
    log.mockRestore();
    failText = "";
  }
});

test("AMF は高画質の指定が通れば、古い世代向けの指定を試さない", async () => {
  answer = (argv) => {
    const line = argv.join(" ");
    return line.includes("d3d11va=d3d:0") && line.includes("_amf") ? 0 : 1;
  };
  calls.length = 0;
  const { devices } = await onWindows(() => probe());
  expect(devices.map((d) => d.path)).toEqual(["amf0"]);
  expect(devices[0]).toMatchObject({
    amf: ["av1", "hevc", "h264"],
    amfTranscoding: [],
  });
  expect(hwChain("av1", {}, 0, devices)).toEqual([
    { device: "amf0", kind: "amf", gpu: 0 },
  ]);
  const lines = calls.map((argv) => argv.join(" "));
  expect(
    lines.some(
      (l) => l.includes("d3d11va=d3d:0") && l.includes("-usage transcoding"),
    ),
  ).toBe(false);
});

/** Mac の探し方 (`probeMac`)。Windows と同じく OS の名前だけ差し替える */
async function onMac<T>(body: () => Promise<T>): Promise<T> {
  const before = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    return await body();
  } finally {
    Object.defineProperty(process, "platform", before);
  }
}

test("Mac でハードウェアのエンコーダが見えなければ、行は 0 でソフトウェアにする", async () => {
  answer = () => 1;
  calls.length = 0;
  const { devices, message } = await onMac(() => probe());
  expect(devices).toEqual([]);
  expect(liveHw("hevc", {}, 0, devices)).toBeNull();
  expect(message).toContain("ソフトウェアでエンコードします");
  // VideoToolbox の H.265 と H.264 だけを試す (AV1 のエンコーダは無い)。/dev の探し方は使わない
  const lines = calls.map((argv) => argv.join(" "));
  expect(lines).toHaveLength(2);
  expect(lines.every((l) => /(hevc|h264)_videotoolbox/.test(l))).toBe(true);
});

test("Mac は VideoToolbox の 1 行で、通ったコーデックだけ使う", async () => {
  answer = (argv) => (argv.join(" ").includes("hevc_videotoolbox") ? 1 : 0);
  const { devices, message } = await onMac(() => probe());
  expect(devices).toHaveLength(1);
  expect(devices[0]).toMatchObject({
    path: "videotoolbox",
    label: "videotoolbox (Apple)",
    videotoolbox: ["h264"],
    vaapi: [],
  });
  expect(describeDevice(devices[0]!)).toBe("VideoToolbox: H.264");
  expect(message).toBe(
    "デバイスが 1 個見つかり、1 個で GPU エンコードできます",
  );
  expect(hwChain("h264", {}, 0, devices)).toEqual([
    { device: "videotoolbox", kind: "videotoolbox" },
  ]);
  expect(hwChain("hevc", {}, 0, devices)).toEqual([]);
});
