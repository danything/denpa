import { describe, expect, test } from "bun:test";

import { cpuText, gpuText } from "./diagnostics";
import type { HwDevice } from "./hwenc";

describe("サーバの機材", () => {
  test("CPU は型番とコア数。型番が読めなければコア数だけ", () => {
    const model = "AMD Ryzen 7 5700G with Radeon Graphics";
    expect(cpuText(Array.from({ length: 16 }, () => ({ model })))).toBe(
      `${model} (16 コア)`,
    );
    expect(cpuText([{ model: "" }, { model: " " }])).toBe("2 コア");
    expect(cpuText([])).toBe("—");
  });

  test("GPU はデバイスごとにエンコードできるもの。確かめる前と見つからないときはそう書く", () => {
    const device: HwDevice = {
      path: "/dev/dri/renderD128",
      label: "renderD128 (Intel)",
      vaapi: ["av1", "h264"],
      rkmpp: [],
      nvenc: [],
      qsv: [],
      amf: [],
      videotoolbox: [],
      mediacodec: [],
      cqp: [],
      amfTranscoding: [],
      qsvSystem: [],
      full: [],
    };
    expect(gpuText({ probed: true, devices: [device], message: "" })).toBe(
      "renderD128 (Intel): VA-API: AV1 / H.264",
    );
    expect(gpuText({ probed: false, devices: [], message: "" })).toBe(
      "確かめています…",
    );
    expect(
      gpuText({ probed: true, devices: [], message: "GPU が見つかりません" }),
    ).toBe("GPU が見つかりません");
  });
});
