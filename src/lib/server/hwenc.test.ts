import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findDevices,
  hwArgs,
  hwChain,
  type HwDevice,
  liveHw,
  liveHwArgs,
  rkmppBitrate,
} from "./hwenc";

const A: HwDevice = {
  path: "/dev/dri/renderD128",
  label: "A",
  qsv: ["h264", "av1"],
  vaapi: ["h264", "av1"],
  rkmpp: [],
  cqp: [],
  full: [],
};
const B: HwDevice = {
  path: "/dev/dri/renderD129",
  label: "B",
  qsv: ["h264"],
  vaapi: ["h264"],
  rkmpp: [],
  cqp: [],
  full: [],
};

describe("GPU の方式の選び方", () => {
  test("載っていないデバイスは全部よい。同じデバイスの中では QSV → VA-API", () => {
    expect(hwChain("av1", {}, 0, [A, B])).toEqual([
      { device: A.path, kind: "qsv" },
      { device: A.path, kind: "vaapi" },
    ]);
  });

  test("デバイスはジョブごとに回す。両方エンコードできる H.264 は先頭が入れ替わる", () => {
    const first = hwChain("h264", {}, 0, [A, B]).map((w) => w.device);
    const second = hwChain("h264", {}, 1, [A, B]).map((w) => w.device);
    expect(first).toEqual([A.path, A.path, B.path, B.path]);
    expect(second).toEqual([B.path, B.path, A.path, A.path]);
  });

  test("デバイスごとに外せる。A は AV1 だけ、B は H.264 だけ、のような割り振り", () => {
    const allow = {
      [A.path]: { qsv: ["av1" as const], vaapi: [], rkmpp: [] },
      [B.path]: { qsv: ["h264" as const], vaapi: ["h264" as const], rkmpp: [] },
    };
    expect(hwChain("h264", allow, 0, [A, B])).toEqual([
      { device: B.path, kind: "qsv" },
      { device: B.path, kind: "vaapi" },
    ]);
    expect(hwChain("av1", allow, 0, [A, B])).toEqual([
      { device: A.path, kind: "qsv" },
    ]);
    // 使えないものは許しても出ない (B は AV1 をエンコードできない)
    expect(
      hwChain(
        "av1",
        { [B.path]: { qsv: ["av1"], vaapi: ["av1"], rkmpp: [] } },
        0,
        [B],
      ),
    ).toEqual([]);
  });

  test("デバイスは最後の段の * で探し、名前順", () => {
    const dir = mkdtempSync(join(tmpdir(), "dri-"));
    for (const name of ["renderD129", "renderD128", "card0"])
      writeFileSync(join(dir, name), "");
    expect(findDevices(`${dir}/renderD*`)).toEqual([
      `${dir}/renderD128`,
      `${dir}/renderD129`,
    ]);
    expect(findDevices("/nonexistent/renderD*")).toEqual([]);
  });
});

describe("ICQ を持たないドライバ (i965)", () => {
  const C: HwDevice = {
    ...B,
    path: "/dev/dri/renderD130",
    qsv: [],
    cqp: ["h264"],
  };

  test("CQP でだけエンコードできた VA-API には印を付けて渡す", () => {
    expect(hwChain("h264", {}, 0, [C])).toEqual([
      { device: C.path, kind: "vaapi", cqp: true },
    ]);
    // QSV には付けない (CQP に落とすのは VA-API の試しだけ)
    expect(hwChain("h264", {}, 0, [{ ...A, cqp: ["h264"] }])[0]).toEqual({
      device: A.path,
      kind: "qsv",
    });
  });

  test("CQP なら -qp で指定する。値は ICQ と同じ軸", () => {
    const icq = hwArgs({ device: C.path, kind: "vaapi" }, "h264").encoder;
    expect(icq).toEqual([
      "h264_vaapi",
      "-rc_mode",
      "ICQ",
      "-global_quality",
      "24",
    ]);
    const cqp = hwArgs(
      { device: C.path, kind: "vaapi", cqp: true },
      "h264",
    ).encoder;
    expect(cqp).toEqual(["h264_vaapi", "-rc_mode", "CQP", "-qp", "24"]);
    // AV1 の qp は 0〜255
    expect(
      hwArgs({ device: C.path, kind: "vaapi", cqp: true }, "av1").encoder,
    ).toContain("120");
  });
});

describe("ライブを GPU でエンコードする経路", () => {
  const FULL: HwDevice = { ...A, full: ["h264"] };

  test("印が無ければ (使えなければ) ソフトウェア", () => {
    expect(liveHw("h264", {}, 0, [])).toBeNull();
    expect(
      liveHw("h264", { [A.path]: { qsv: [], vaapi: [], rkmpp: [] } }, 0, [A]),
    ).toBeNull();
  });

  test("デコードから GPU で通せる VA-API を、同じデバイスの QSV より先に採る", () => {
    expect(liveHw("h264", {}, 0, [FULL])).toEqual({
      way: { device: A.path, kind: "vaapi" },
      full: true,
    });
    // 通せないコーデックは録画と同じ順 (QSV が先) で、エンコードするところだけ
    expect(liveHw("av1", {}, 0, [FULL])).toEqual({
      way: { device: A.path, kind: "qsv" },
      full: false,
    });
  });

  test("VA-API の印を外せば、デコードから GPU も使わない", () => {
    const allow = {
      [A.path]: { qsv: ["h264" as const], vaapi: [], rkmpp: [] },
    };
    expect(liveHw("h264", allow, 0, [FULL])).toEqual({
      way: { device: A.path, kind: "qsv" },
      full: false,
    });
  });

  test("遅れを作らない引数を足す (B フレームなし・先積みなし)", () => {
    const vaapi = liveHwArgs(
      { way: { device: A.path, kind: "vaapi" }, full: false },
      "h264",
    );
    expect(vaapi.input).toEqual([
      "-init_hw_device",
      `vaapi=va:${A.path}`,
      "-filter_hw_device",
      "va",
    ]);
    expect(vaapi.filter).toEqual(["format=nv12", "hwupload"]);
    expect(vaapi.encoder.join(" ")).toBe(
      "h264_vaapi -rc_mode ICQ -global_quality 24 -bf 0 -async_depth 1",
    );

    const qsv = liveHwArgs(
      { way: { device: A.path, kind: "qsv" }, full: false },
      "av1",
    );
    expect(qsv.filter).toEqual(["format=nv12"]);
    expect(qsv.encoder.join(" ")).toBe(
      "av1_qsv -preset veryfast -global_quality 24 -bf 0 -async_depth 1",
    );
  });

  test("デコードから GPU なら、フレームを GPU に置いたままインタレ解除してエンコードする", () => {
    const full = liveHwArgs(
      { way: { device: A.path, kind: "vaapi", cqp: true }, full: true },
      "h264",
    );
    expect(full.input.join(" ")).toBe(
      `-init_hw_device vaapi=va:${A.path} -hwaccel vaapi -hwaccel_output_format vaapi -hwaccel_device va`,
    );
    // CPU のフィルタ (format / hwupload) は挟まない
    expect(full.filter).toEqual(["deinterlace_vaapi=rate=field"]);
    expect(full.encoder.join(" ")).toBe(
      "h264_vaapi -rc_mode CQP -qp 24 -bf 0 -async_depth 1",
    );
  });
});

describe("Rockchip MPP", () => {
  /** `/dev/mpp_service`。renderD* とは別の行で、H.264 だけ */
  const R: HwDevice = {
    path: "/dev/mpp_service",
    label: "mpp_service (Rockchip)",
    qsv: [],
    vaapi: [],
    rkmpp: ["h264"],
    cqp: [],
    full: [],
  };

  test("H.264 だけを受け持ち、ほかの GPU と同じくジョブごとに回す", () => {
    expect(hwChain("av1", {}, 0, [R])).toEqual([]);
    expect(hwChain("h264", {}, 0, [B, R])).toEqual([
      { device: B.path, kind: "qsv" },
      { device: B.path, kind: "vaapi" },
      { device: R.path, kind: "rkmpp" },
    ]);
    expect(hwChain("h264", {}, 1, [B, R])[0]).toEqual({
      device: R.path,
      kind: "rkmpp",
    });
    // 印を外せば使わない
    expect(
      hwChain("h264", { [R.path]: { qsv: [], vaapi: [], rkmpp: [] } }, 0, [R]),
    ).toEqual([]);
  });

  test("ビットレートは出す高さとコマ数で決まり、高さが測れなければ 1080 の値", () => {
    const hd30 = rkmppBitrate({ height: 1080, smooth: false });
    const hd60 = rkmppBitrate({ height: 1080, smooth: true });
    const p720 = rkmppBitrate({ height: 720, smooth: true });
    const sd60 = rkmppBitrate({ height: 480, smooth: true });
    expect(hd60).toBeGreaterThan(hd30);
    expect(hd60).toBeGreaterThan(p720);
    expect(p720).toBeGreaterThan(sd60);
    expect(rkmppBitrate({ height: Number.NaN, smooth: true })).toBe(hd60);
    expect(rkmppBitrate({ height: Number.NaN, smooth: false })).toBe(hd30);
    // MPP が受ける幅 (1K〜100M bit/s)。外れると MPP は黙って既定の 2 Mbit/s に戻す
    for (const bps of [hd30, hd60, p720, sd60]) {
      expect(bps).toBeGreaterThan(1000);
      expect((bps * 17) / 16).toBeLessThan(100_000_000);
    }
  });

  test("録画は CPU で作ったフレームを nv12 で渡し、AVBR に上限と下限も添える", () => {
    const picture = { height: 1080, smooth: false };
    const bps = rkmppBitrate(picture);
    const args = hwArgs({ device: R.path, kind: "rkmpp" }, "h264", picture);
    // デバイスは MPP が自分で開く
    expect(args.device).toEqual([]);
    expect(args.filter).toEqual(["format=nv12"]);
    expect(args.encoder).toEqual([
      "h264_rkmpp",
      "-rc",
      "avbr",
      "-b:v",
      String(bps),
      "-maxrate",
      String(Math.round((bps * 17) / 16)),
      "-minrate",
      String(Math.round(bps / 16)),
      "-g",
      "250",
    ]);
  });

  test("ライブは 1080 の 60コマの値で、MPP が持たない引数 (-async_depth) を渡さない", () => {
    const live = liveHwArgs(
      { way: { device: R.path, kind: "rkmpp" }, full: false },
      "h264",
    );
    expect(live.input).toEqual([]);
    expect(live.filter).toEqual(["format=nv12"]);
    expect(live.encoder.slice(0, 5)).toEqual([
      "h264_rkmpp",
      "-rc",
      "avbr",
      "-b:v",
      String(rkmppBitrate({ height: 1080, smooth: true })),
    ]);
    expect(live.encoder).not.toContain("-async_depth");
    // -g はライブの側が足す
    expect(live.encoder).not.toContain("-g");
    expect(liveHw("h264", {}, 0, [R])).toEqual({
      way: { device: R.path, kind: "rkmpp" },
      full: false,
    });
  });
});
