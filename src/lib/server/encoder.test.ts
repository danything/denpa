import { describe, expect, test } from "bun:test";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { concatBytes } from "@danything/arib/bytes";
import { MmtServiceFilter } from "@danything/arib/mmt-service-filter";
import { SynthMmtAv } from "@danything/arib/synth-mmt-av";

import { config } from "./config";
import {
  buildArgs,
  combineProgress,
  encodeAttempts,
  encodeOrder,
  encodeProgress,
  expectedFrames,
  failureReason,
  findInputFd,
  headSkip,
  inputSkip,
  programSpan,
  readInputPos,
  rereadArgs,
} from "./encoder";
import { hwBitrate, type HwWay } from "./hwenc";
import { remuxMmts } from "./mmts";
import { tsProbe } from "./ts-probe";
import { HLG_PARAMS } from "./uhd";

function argValue(args: string[], key: string): string | undefined {
  const i = args.indexOf(key);
  return i === -1 ? undefined : args[i + 1];
}

describe("録画エンコードの引数", () => {
  test("既定は AV1 8bit で、コマ数は増やさない", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null);
    expect(args).toContain("libsvtav1");
    // send_field だとコマ数が倍になり、時間もサイズも約 2 倍になる
    expect(argValue(args, "-vf")).toBe(
      "bwdif=mode=send_frame:deint=interlaced,format=yuv420p",
    );
    expect(args.at(-1)).toBe("/out.mkv");
  });

  // 上流の既定 preset はバージョンで変わる (encoder.videoArgs の実測)。書いてあることを守る。
  // **10 に戻さない**。M10 以上はシーンの変わり目でブロックノイズが出る
  // (docs/encode.md「preset は 8・crf 37 (値は書いておく)」)
  test("AV1 の preset と crf は書いてある", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null);
    expect(argValue(args, "-preset")).toBe("8");
    expect(argValue(args, "-crf")).toBe("37");
  });

  /*
   * **H.264 の crf は AV1 (前の preset 9・crf 35) と同じ画質になる値。** 24 だった頃は、実写の忙しい
   * ところで AV1 より 0.94dB 低く、そのぶん小さいだけだった。実測の表は docs/encode.md「H.264 は crf 23」
   */
  test("H.264 の crf は AV1 と同じ画質の 23", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "h264");
    expect(argValue(args, "-preset")).toBe("medium");
    expect(argValue(args, "-crf")).toBe("23");
  });

  test("なめらかにすると 1 フィールドごとに 1 コマ出す", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1", {
      smoothMotion: true,
    });
    expect(argValue(args, "-vf")).toBe("bwdif=deint=interlaced,format=yuv420p");
  });

  // どちらも 8bit (理由と実測は encoder.videoArgs)
  test("10bit では出さない", () => {
    for (const codec of ["av1", "h264"] as const) {
      const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, codec);
      expect(argValue(args, "-vf"), codec).not.toContain("10le");
    }
  });
});

/**
 * **エンコードしたものの音声と字幕に名前を入れる** (`arib.audioTitles`)。
 *
 * 入れていなかった頃は、プレイヤーの切り替えに「Audio 1」「Audio 2」しか
 * 出なかった。二か国語や解説放送でどちらがどちらか分からない。
 */
describe("トラックの名前", () => {
  const title = (args: string[], key: string) => argValue(args, key);

  test("音声に番組表と同じ名前を入れる", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1", {
      audioTitles: ["主音声 (日本語)", "解説 (日本語)"],
    });
    expect(title(args, "-metadata:s:a:0")).toBe("title=主音声 (日本語)");
    expect(title(args, "-metadata:s:a:1")).toBe("title=解説 (日本語)");
  });

  /*
   * **多すぎても困らない。** 番組表が言っている本数と実際に入っている本数は
   * 食い違いうるが、ffmpeg は在りもしないトラックへの指定を黙って読み飛ばす
   * (実機で確認)。名前が無いものは何も言わない
   */
  test("名前が無ければ何も言わない", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null);
    expect(args.some((arg) => arg.startsWith("-metadata:s:a:"))).toBe(false);
  });

  test("空の名前は入れない", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1", {
      audioTitles: ["", "副音声"],
    });
    expect(args).not.toContain("-metadata:s:a:0");
    expect(title(args, "-metadata:s:a:1")).toBe("title=副音声");
  });

  /** 冒頭に中身の無い音声 (次の番組の副音声) は使わない。分からなければ全部使う */
  test("使う音声を名指しされたらそれだけを map する", () => {
    const all = buildArgs("/in.m2ts", "/out.mkv", 1, null);
    expect(all).toContain("0:a");

    const picked = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1", {
      audioStreams: [0, 2],
    });
    expect(picked).not.toContain("0:a");
    expect(picked).toContain("0:a:0");
    expect(picked).toContain("0:a:2");
    expect(picked).not.toContain("0:a:1");

    expect(
      buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1", { audioStreams: [] }),
    ).toContain("0:a");
  });

  /** 字幕には「字幕」と日本語の名前 */
  test("字幕にも名前を入れる", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null);
    expect(title(args, "-metadata:s:s:0")).toBe("title=字幕");
  });

  /** 入れ物の title は番組名 */
  test("入れ物に番組名を入れる", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1", {
      mediaTitle: "転生したらスライムだった件 #88",
    });
    expect(title(args, "-metadata")).toBe(
      "title=転生したらスライムだった件 #88",
    );

    // 無ければ書かない (空の title で上書きしない)
    const plain = buildArgs("/in.m2ts", "/out.mkv", 1, null);
    expect(plain).not.toContain("-metadata");
  });
});

describe("エンコードの引数 (入れ物・コーデック・字幕・先頭を捨てる長さ)", () => {
  test("入れ物は拡張子ではなく引数で決める", () => {
    // 書いている間は .mkv.encoding という名前なので、拡張子からは決まらない
    const args = buildArgs("/in.m2ts", "/out.mkv.encoding", 1, null);
    expect(argValue(args, "-f")).toBe("matroska");
    expect(args.at(-1)).toBe("/out.mkv.encoding");
  });

  test("h264 を選ぶと x264 の 8bit になる", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "h264");
    expect(args).toContain("libx264");
    expect(args).not.toContain("libsvtav1");
    expect(argValue(args, "-vf")).toBe(
      "bwdif=mode=send_frame:deint=interlaced,format=yuv420p",
    );
    expect(args).toContain("-preset");
  });

  test("GPU でエンコードするときはデバイスを先に開け、CPU で作った nv12 を GPU へ上げて渡す", () => {
    // 画質は H.264 が CQP の qp 24、AV1 が ICQ 26。録画はどちらも品質寄りの段 (1)
    for (const [codec, flag, value] of [
      ["av1", "-global_quality:v", "26"],
      ["h264", "-qp", "24"],
      ["av1", "-compression_level:v", "1"],
      ["h264", "-compression_level:v", "1"],
    ] as const) {
      const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, codec, {
        hardware: { device: "/dev/dri/renderD128", kind: "vaapi" },
      });
      expect(args.indexOf("-init_hw_device")).toBeLessThan(args.indexOf("-i"));
      expect(args).toContain(`${codec}_vaapi`);
      expect(argValue(args, flag)).toBe(value);
      expect(args).not.toContain("libx264");
      expect(args).not.toContain("libsvtav1");
    }
    const va = buildArgs("/in.m2ts", "/out.mkv", 1, null, "h264", {
      hardware: { device: "/dev/dri/renderD128", kind: "vaapi" },
    });
    expect(argValue(va, "-init_hw_device")).toBe(
      "vaapi=va:/dev/dri/renderD128",
    );
    expect(argValue(va, "-filter_hw_device")).toBe("va");
    expect(argValue(va, "-vf")).toBe(
      "bwdif=mode=send_frame:deint=interlaced,format=nv12,hwupload",
    );
    expect(va).toContain("h264_vaapi");
    expect(argValue(va, "-rc_mode")).toBe("CQP");
    // 渡さなければソフトウェア。GPU のデバイスも開けない
    expect(buildArgs("/in.m2ts", "/out.mkv", 1, null, "h264")).not.toContain(
      "-init_hw_device",
    );
  });

  test("Rockchip MPP はデバイスを開けず、映像の高さとコマ数でビットレートを決める", () => {
    const mpp = (height: number | undefined, smoothMotion: boolean) =>
      buildArgs("/in.m2ts", "/out.mkv", 1, null, "h264", {
        hardware: { device: "/dev/mpp_service", kind: "rkmpp" },
        smoothMotion,
        ...(height === undefined ? {} : { height }),
        displaySize: { width: 1920, height: 1080 },
      });
    const hd = mpp(1080, false);
    expect(hd).not.toContain("-init_hw_device");
    expect(hd).toContain("h264_rkmpp");
    expect(argValue(hd, "-rc")).toBe("avbr");
    // インタレ解除と引き伸ばしは CPU のまま
    expect(argValue(hd, "-vf")).toBe(
      "bwdif=mode=send_frame:deint=interlaced,scale=1920:1080,setsar=1,format=nv12",
    );
    expect(argValue(hd, "-b:v")).toBe(
      String(hwBitrate("h264", { height: 1080, smooth: false })),
    );
    expect(argValue(mpp(1080, true), "-b:v")).toBe(
      String(hwBitrate("h264", { height: 1080, smooth: true })),
    );
    expect(argValue(mpp(480, true), "-b:v")).toBe(
      String(hwBitrate("h264", { height: 480, smooth: true })),
    );
    // 高さが分からなければ 1080 の値
    expect(argValue(mpp(undefined, false), "-b:v")).toBe(
      String(hwBitrate("h264", { height: 1080, smooth: false })),
    );
  });

  test("NVENC はデバイスを開けず GPU の番号で選び、映像の高さとコマ数でビットレートを決める", () => {
    for (const codec of ["av1", "h264"] as const) {
      const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, codec, {
        hardware: { device: "/dev/nvidia1", kind: "nvenc", gpu: 1 },
        smoothMotion: false,
        height: 720,
        displaySize: { width: 1280, height: 720 },
      });
      expect(args).not.toContain("-init_hw_device");
      expect(args).toContain(`${codec}_nvenc`);
      expect(argValue(args, "-gpu")).toBe("1");
      // ICQ (-global_quality) は NVENC が断るので渡さない
      expect(args).not.toContain("-global_quality:v");
      expect(argValue(args, "-rc")).toBe("vbr");
      expect(argValue(args, "-b:v")).toBe(
        String(hwBitrate(codec, { height: 720, smooth: false })),
      );
      expect(argValue(args, "-vf")).toBe(
        "bwdif=mode=send_frame:deint=interlaced,scale=1280:720,setsar=1,format=nv12",
      );
    }
  });

  test("字幕は 1 本だけ。入力も 1 回しか開かない", () => {
    for (const codec of ["av1", "h264"] as const) {
      const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, codec);
      /*
       * ASS (外字が「〓」になる) と dvdsub (1 枚 4 色) を作るために同じ入力を
       * 2 回開いていた頃の名残を残さない
       */
      expect(args.filter((a) => a === "/in.m2ts")).toHaveLength(1);
      expect(args).not.toContain("ass");
      expect(args).not.toContain("dvdsub");
      expect(argValue(args, "-disposition:s:0")).toBe("default");
      expect(argValue(args, "-c:s:1")).toBeUndefined();
      expect(argValue(args, "-c:a")).toBe("libopus");
    }
  });

  test("デュアルモノは左右を別トラックに分ける", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 2, null);
    expect(argValue(args, "-filter_complex")).toContain("channelsplit");
    expect(args).toContain("language=jpn");
    expect(args).toContain("language=und");
  });

  test("再試行時は先頭を捨てる", () => {
    expect(argValue(buildArgs("/in.m2ts", "/out.mkv", 1, 0.2), "-ss")).toBe(
      "0.2",
    );
  });

  test("字幕は落とさずに写す", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1");
    expect(args).not.toContain("-sn");
    expect(argValue(args, "-c:s")).toBe("copy");
  });

  test("チャプターはエンコードするときには入れない (エンコードしたあとに書き足す)", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1");
    expect(args).not.toContain("-map_chapters");
    // 入力は録画の TS だけ
    expect(args.filter((a) => a === "-i")).toHaveLength(1);
  });

  test("字幕は放送の ARIB 字幕を名指しして写す (局では名指ししない。#2189)", () => {
    // 名指ししない既定の選び方では ARIB の字幕が落ちる。Matroska には S_ARIBSUB で入る
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1");
    expect(args).toContain("0:s:0?");
    expect(args.some((a) => a.includes("0:p:"))).toBe(false);
    expect(argValue(args, "-c:s")).toBe("copy");
  });

  test("音声のチャンネル数は番組表の構成にそろえ、探りは本編の開始まで延ばす (#2189)", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1", {
      audioChannels: [2, undefined],
      probeLead: 30,
    });
    expect(argValue(args, "-ac:a:0")).toBe("2");
    expect(args).not.toContain("-ac:a:1");
    expect(argValue(args, "-analyzeduration")).toBe("45000000");
    expect(argValue(args, "-probesize")).toBe("90000000");
    // 先頭に中身の無い音声を外したときは、入力の何本目で引く
    const picked = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1", {
      audioChannels: [1, 6],
      audioStreams: [1],
    });
    expect(argValue(picked, "-ac:a:0")).toBe("6");
    // 全部使うときは、出す何本目と入力の何本目が同じ
    const all = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1", {
      audioChannels: [undefined, 1],
    });
    expect(all).not.toContain("-ac:a:0");
    expect(argValue(all, "-ac:a:1")).toBe("1");
  });

  /**
   * TS は音声のほうが先に始まっていることが多い。実機では映像の 1 コマ目が
   * 0.930 秒あとで、エンコードしたものも音声だけの区間から始まっていた。
   * 1 コマ目を 0 秒として数えるプレイヤーでは、そのぶん字幕が早く出る。
   *
   * **ずらすのではなく捨てる。** `-output_ts_offset` では直らなかった。
   * Matroska は負の時刻を持てないので、下がった音声を muxer が押し戻し、
   * 全トラックまとめて元の位置に戻る (実測: 0.363 渡して動いたのは 0.022 だけ)。
   * 捨てれば映像も音声も 0.000 から始まる (実測で確認)
   */
  test("映像が出るまでの音声だけの区間は捨てる", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1", {
      videoStart: 0.93,
    });
    expect(argValue(args, "-ss")).toBe("0.93");
    // ずらす方式は効かないので使わない
    expect(args).not.toContain("-output_ts_offset");
  });

  test("捨てるのは入力側 (最初の -i より前)", () => {
    // 出力側に置くと、読み飛ばさずに全部デコードしてから捨てることになる
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1", {
      videoStart: 0.93,
    });
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
  });

  test("ほぼ 0 なら捨てない", () => {
    // 数ミリ秒のずれのために seek を掛けても、得るものが無い
    expect(
      argValue(buildArgs("/in.m2ts", "/out.mkv", 1, null), "-ss"),
    ).toBeUndefined();
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1", {
      videoStart: 0.02,
    });
    expect(argValue(args, "-ss")).toBeUndefined();
  });

  test("再試行で捨てる長さと足し算になる", () => {
    // 再試行 (PAT/PMT が固まる前) と音声だけの区間は別の理由。両方捨てる
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, 0.2, "av1", {
      videoStart: 0.93,
    });
    expect(Number(argValue(args, "-ss"))).toBeCloseTo(1.13, 5);
  });

  /**
   * 地上波の HD は 1440x1080 の横長画素で送られてくる。正方形に直して出す (理由は encoder.ts の `squarePixels`)。
   * **大きさは測って渡す**。`iw*sar` と式で書くと、SAR が読めない素材で
   * 幅が 0 になって落ちる
   */
  test("横長の画素は正方形に直した大きさへ引き伸ばす", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1", {
      displaySize: { width: 1920, height: 1080 },
    });
    expect(argValue(args, "-vf")).toBe(
      "bwdif=mode=send_frame:deint=interlaced,scale=1920:1080,setsar=1,format=yuv420p",
    );
  });

  test("渡されなければ引き伸ばさない", () => {
    // もともと正方形の素材。同じ大きさへの scale は仕事が増えるだけ
    expect(argValue(buildArgs("/in.m2ts", "/out.mkv", 1, null), "-vf")).toBe(
      "bwdif=mode=send_frame:deint=interlaced,format=yuv420p",
    );
  });
});

describe("4K の局の録画 (詰め替えた MP4 が入力)", () => {
  const uhd = (codec: "av1" | "h264" | "hevc", hardware?: HwWay) =>
    buildArgs("/raw/a.mmts.remux.mp4", "/out.mkv", 1, null, codec, {
      uhd: true,
      smoothMotion: true,
      hardware,
    });

  test("AV1 は 2160p・10 ビット・HLG のまま。インタレ解除も縮めもしない", () => {
    const args = uhd("av1");
    // 色はコマに書き込む (映像に VUI が無くても、出したものに HLG の印が付く)
    expect(argValue(args, "-vf")).toBe(`${HLG_PARAMS},format=yuv420p10le`);
    expect(args).toContain("libsvtav1");
  });

  test("H.264 は今の録画と同じ 1080p・8 ビットの SDR に縮めて直す (ライブの 4K の局と同じ)", () => {
    const vf = argValue(uhd("h264"), "-vf")!;
    expect(vf.startsWith("scale=-2:1080,setparams=")).toBe(true);
    expect(vf).toContain("tonemap=tonemap=hable");
    expect(vf.endsWith("format=yuv420p")).toBe(true);
    expect(vf).not.toContain("bwdif");
  });

  test("H.265 は GPU で、縮めて SDR に直してから GPU へ上げる。ビットレートは 1080p の値", () => {
    const args = uhd("hevc", { device: "/dev/dri/renderD128", kind: "vaapi" });
    const vf = argValue(args, "-vf")!;
    expect(vf.startsWith("scale=-2:1080,")).toBe(true);
    expect(vf.endsWith("format=nv12,hwupload")).toBe(true);
    expect(args).toContain("hevc_vaapi");
  });
});

describe("inputSkip", () => {
  /*
   * **エンコードするほう (`-ss`) と進み具合の分母で同じ値を使う。** 片方だけ変わると、
   * 捨てた量と分母から引いた量がずれて、進み具合が最後まで届かなくなる
   */
  test("再試行で捨てる長さと、音声だけの区間の足し算", () => {
    expect(inputSkip(0.5, 1.5)).toBe(2);
  });

  test("どちらも無ければ 0", () => {
    expect(inputSkip(null, undefined)).toBe(0);
  });

  test("1 コマにも満たない音声だけの区間は数えない (headSkip と同じ判断)", () => {
    expect(inputSkip(null, 0.01)).toBe(0);
    expect(inputSkip(0.5, 0.01)).toBe(0.5);
  });
});

describe("expectedFrames", () => {
  // 1080i の放送 = 毎秒 29.97 コマ。60 コマで出すならインタレ解除が倍にする
  const hd = { duration: 100, fps: 30000 / 1001 };

  test("60 コマで出すなら入力のコマ数の 2 倍", () => {
    expect(expectedFrames(hd, 0, true)).toBeCloseTo(5994, 0);
  });

  test("30 コマで出すなら入力のコマ数そのまま", () => {
    expect(expectedFrames(hd, 0, false)).toBeCloseTo(2997, 0);
  });

  /*
   * **720p で送っている局は入力が 59.94 のプログレッシブで、インタレ解除は倍にしない** (`deint=interlaced`)。
   * 倍にして数えると分母が 2 倍になり、50% で頭打ちになる
   */
  test("入力が 59.94 の素材は、60 コマで出しても倍にしない", () => {
    expect(
      expectedFrames({ duration: 100, fps: 60000 / 1001 }, 0, true),
    ).toBeCloseTo(5994, 0);
  });

  test("先頭から捨てるぶんはエンコードしないので引く", () => {
    expect(expectedFrames(hd, 10, false)).toBeCloseTo(2697, 0);
  });

  test("測れていなければ NaN (呼ぶ側が読み位置に落ちる)", () => {
    expect(expectedFrames(undefined, 0, true)).toBeNaN();
    expect(expectedFrames({ duration: NaN, fps: 30 }, 0, true)).toBeNaN();
    expect(expectedFrames({ duration: 100, fps: NaN }, 0, true)).toBeNaN();
    // 捨てるぶんが尺より長い (測り違え)。0 コマや負のコマ数は出さない
    expect(expectedFrames(hd, 200, true)).toBeNaN();
  });
});

describe("encodeProgress", () => {
  /*
   * out_time_us はわざとほぼ最後を指す値にしてある。実機の TOKYO MX 録画で、
   * 入力を 65% しか読んでいないのに時刻だけ 99.1% に飛んで「あと 1 秒」のまま
   * 数分止まって見えた。割合はエンコードできたコマ数だけを信じ、時刻には釣られないこと
   */
  const at = (frame: number) => ({
    progress: "continue",
    frame: String(frame),
    out_time_us: "1810000000",
    total_size: "1048576",
    bitrate: "2000.0",
    speed: "8.0x",
    drop_frames: "0",
  });
  const block = at(0);

  test("エンコードできたコマ数から割合を出す。ffmpeg の言う時刻には釣られない", () => {
    expect(encodeProgress(1000, 1000)(0, 0, at(500), 0).percent).toBeCloseTo(
      0.5,
      3,
    );
  });

  /*
   * **実機で起きた例** (2026-09、7.4GB の映画)。デマクサだけ先に進んで入力を
   * 読み切り、エンコードするほうは半分。読み位置で出していた頃は 99% に貼り付いて
   * 「あと 50 分」の間ずっと止まって見えた
   */
  test("入力を読み切っていても、エンコードできた量で答える", () => {
    const p = encodeProgress(1000, 1000)(0, 1000, at(500), 0);
    expect(p.percent).toBeCloseTo(0.5, 3);
  });

  test("コマ数が数えられなければ読み位置に落ちる", () => {
    expect(encodeProgress(NaN, 1000)(0, 500, at(0), 0).percent).toBeCloseTo(
      0.5,
      3,
    );
  });

  test("どちらも取れない間は直前の値を保つ", () => {
    expect(encodeProgress(NaN, NaN)(0, NaN, block, 0.42).percent).toBe(0.42);
  });

  test("割合は巻き戻らない", () => {
    const report = encodeProgress(1000, 1000);
    report(0, 0, at(800), 0);
    expect(report(1000, 0, at(700), 0.8).percent).toBe(0.8);
  });

  test("progress=end で必ず 100% にする", () => {
    expect(
      encodeProgress(NaN, NaN)(0, NaN, { progress: "end" }, 0.9).percent,
    ).toBe(1);
  });

  test("エンコードし切っても、終わるまでは 99% で止める", () => {
    // 最後のコマをエンコードしたあとも溜めたフレームの出力と mux の後処理が残っている。100.0% で
    // 止まって見えるより、99% のまま「まだ終わっていない」と出すほうが実際に近い
    expect(encodeProgress(1000, 1000)(0, 0, at(1000), 0).percent).toBe(0.99);
  });

  test("残り時間は直近にエンコードできたぶんから出す。速さが読めないうちは null", () => {
    const report = encodeProgress(10_000, NaN);
    expect(report(0, NaN, at(1000), 0).etaMs).toBeNull(); // 窓がまだ短い
    // 5 秒で 1000 コマエンコードできた → 残り 8000 コマは 40 秒
    expect(report(5000, NaN, at(2000), 0.1).etaMs).toBe(40_000);
  });

  test("エンコードするほうが止まったら残り時間を出さない (「あと 1 秒」で張り付かせない)", () => {
    const report = encodeProgress(10_000, NaN);
    report(0, NaN, at(2000), 0);
    report(31_000, NaN, at(2000), 0.2); // 窓から最初の 1 点が落ちる
    expect(report(36_000, NaN, at(2000), 0.2).etaMs).toBeNull();
  });

  /** 詰まった時の見立てに、読み位置とコマ数の両方を残す */
  test("控えの読み位置もログに残る", () => {
    const log = encodeProgress(1000, 10 * 1024 * 1024)(
      0,
      5 * 1024 * 1024,
      at(500),
      0,
    ).log;
    expect(log).toContain("frame: 500/1000");
    expect(log).toContain("input: 5/10MB");
  });
});

describe("入力の読み位置を /proc から覗く", () => {
  test("自分が開いているファイルの fd と読み位置が見える", () => {
    const dir = mkdtempSync(join(tmpdir(), "denpa-pos-"));
    const path = join(dir, "input.ts");
    writeFileSync(path, "abcdefgh");

    // /proc の fd は実体のパスで見えるので、実装と同じく解決してから探す
    const fd = openSync(realpathSync(path), "r");
    try {
      expect(findInputFd(process.pid, realpathSync(path))).toBe(fd);
      expect(readInputPos(process.pid, fd)).toBe(0);
      readSync(fd, Buffer.alloc(3), 0, 3, null);
      expect(readInputPos(process.pid, fd)).toBe(3);
    } finally {
      closeSync(fd);
    }
    // 開いていない fd は読めない (ffmpeg は入力を読み終えると閉じる)
    expect(readInputPos(process.pid, 999_999)).toBeNaN();
    expect(findInputFd(process.pid, join(dir, "closed.ts"))).toBeNull();
  });
});

describe("failureReason", () => {
  test("警告に埋もれずエラー行を読み取る", () => {
    const stderr = [
      "[in#0/mpegts] Codec AVOption font has not been used for any stream.",
      "Stream mapping: Stream #0:3 -> #0:0 (mpeg2video -> av1)",
      "[libsvtav1 @ 0x1] Error initializing the encoder",
      "Conversion failed!",
    ].join("\n");
    const reason = failureReason(stderr);
    expect(reason).toContain("Error initializing the encoder");
    expect(reason).toContain("Conversion failed!");
    expect(reason).not.toContain("has not been used for any stream");
  });

  test("エラー行が無ければ末尾をそのまま出す", () => {
    expect(failureReason("a\nb\nc")).toBe("a\nb\nc");
  });
});

describe("CM を探しながらエンコードする", () => {
  const outputs = ["-an", "-vf", "scdet=threshold=0", "-f", "null", "-"];

  test("CM 検出の出力はエンコードする出力のあとに足す", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "av1", {
      analysis: outputs,
    });
    // -map は出力ごとなので、エンコードする出力の指定が検出の出力に効かないよう後ろに置く
    expect(args.indexOf("/out.mkv")).toBeLessThan(
      args.indexOf("scdet=threshold=0"),
    );
    expect(args.slice(-outputs.length)).toEqual(outputs);
  });

  test("進み具合は fd 3 へ (標準出力はロゴの枠が使い、標準エラーはログで混み合う)", () => {
    const args = buildArgs("/in.m2ts", "/out.mkv", 1, null);
    expect(argValue(args, "-progress")).toBe("pipe:3");
    expect(args).toContain("-nostats");
  });
});

describe("キーフレーム", () => {
  test("置く所を指さない (CM はチャプターにするだけで、切らない)", () => {
    const ways: (HwWay | undefined)[] = [
      undefined,
      { kind: "vaapi", device: "/dev/dri/renderD128" },
      { kind: "nvenc", device: "/dev/nvidia0", gpu: 0 },
    ];
    for (const hardware of ways) {
      const args = buildArgs("/in.m2ts", "/out.mkv", 1, null, "h264", {
        hardware,
      });
      expect(args).not.toContain("-force_key_frames:v");
      expect(args).not.toContain("-forced-idr");
      expect(argValue(args, "-vf")).not.toContain("scdet");
    }
  });

  test("H.265 はソフトウェアでエンコードしない (呼ぶ側の誤りなので投げる)", () => {
    expect(() =>
      buildArgs("/in.m2ts", "/out.mkv", 1, null, "hevc", {}),
    ).toThrow();
  });
});

/*
 * 片方だけ「短いから捨てない」と判断すると、そのぶん字幕がずれる。
 * 判断そのものを 1 か所に置いてある
 */
describe("先頭から捨てる長さ", () => {
  test("そのまま返す", () => {
    expect(headSkip(0.93)).toBe(0.93);
  });

  test("ごく短いものと、測れなかったものは捨てない", () => {
    expect(headSkip(0.02)).toBe(0);
    expect(headSkip(0)).toBe(0);
    expect(headSkip(undefined)).toBe(0);
    expect(headSkip(Number.NaN)).toBe(0);
  });
});

describe("encodeOrder", () => {
  test("並びは変えない", () => {
    expect(encodeOrder(["av1", "hevc", "h264"], true)).toEqual([
      "av1",
      "hevc",
      "h264",
    ]);
  });

  test("H.265 をエンコードできる GPU が無ければ外す", () => {
    expect(encodeOrder(["av1", "hevc"], false)).toEqual(["av1"]);
    expect(encodeOrder(["hevc"], false)).toEqual([]);
  });
});

describe("combineProgress", () => {
  const part = (percent: number, etaMs: number | null, log = "frame: 1") => ({
    percent,
    etaMs,
    log,
  });

  test("1 本だけならそのまま", () => {
    const one = part(0.4, 1000);
    expect(combineProgress(new Map([["av1", one]]), 1)).toEqual(one);
  });

  test("同時に動くコーデックの平均。残り時間はいちばん遅いもの", () => {
    const got = combineProgress(
      new Map([
        ["av1", part(0.2, 80_000)],
        ["h264", part(0.6, 20_000)],
      ]),
      2,
    );
    expect(got.percent).toBeCloseTo(0.4);
    expect(got.etaMs).toBe(80_000);
    expect(got.log).toBe("AV1: frame: 1 / H.264: frame: 1");
  });

  test("エンコードし終えたものは 1 で数え、残り時間には入れない", () => {
    const got = combineProgress(
      new Map([
        ["av1", part(0.5, 10_000)],
        ["h264", part(1, null)],
      ]),
      2,
    );
    expect(got.percent).toBeCloseTo(0.75);
    expect(got.etaMs).toBe(10_000);
  });

  test("まだ始まっていない (枠を待っている) ものは 0 で数え、残り時間は出さない", () => {
    const got = combineProgress(new Map([["av1", part(0.6, 10_000)]]), 3);
    expect(got.percent).toBeCloseTo(0.2);
    expect(got.etaMs).toBeNull();
  });

  test("速さが読めないものがあれば残り時間は出さない", () => {
    const got = combineProgress(
      new Map([
        ["av1", part(0.5, 10_000)],
        ["h264", part(0.1, null)],
      ]),
      2,
    );
    expect(got.etaMs).toBeNull();
  });
});

describe("encodeAttempts (1 回の実行の中で ffmpeg を起こす順)", () => {
  const A: HwWay = { device: "/dev/dri/renderD128", kind: "vaapi" };
  const B: HwWay = { device: "/dev/dri/renderD129", kind: "vaapi" };
  const R: HwWay = { device: "/dev/mpp_service", kind: "rkmpp" };
  /** 方式ごとの、捨てる長さの並び (起こした順) */
  const perWay = (attempts: ReturnType<typeof encodeAttempts>) => {
    const ways = new Map<string, (number | null)[]>();
    for (const { seek, hardware } of attempts) {
      const key = hardware === undefined ? "software" : hardware.device;
      ways.set(key, [...(ways.get(key) ?? []), seek]);
    }
    return ways;
  };

  test("どの方式も「素のまま → 先頭を少し捨てて」の 2 回だけ。最後にソフトウェア", () => {
    for (const codec of ["av1", "h264", "hevc"] as const) {
      const attempts = encodeAttempts(codec, [A, B, R]);
      for (const seeks of perWay(attempts).values())
        expect(seeks).toEqual([null, config.encodeRetrySeek]);
    }
    expect([...perWay(encodeAttempts("av1", [A, B, R])).keys()]).toEqual([
      A.device,
      B.device,
      R.device,
      "software",
    ]);
  });

  test("H.265 はソフトウェアに倒さない。GPU が無ければ 1 回も起こさない", () => {
    expect([...perWay(encodeAttempts("hevc", [A])).keys()]).toEqual([A.device]);
    expect(encodeAttempts("hevc", [])).toEqual([]);
    expect(encodeAttempts("h264", [])).toHaveLength(2);
  });
});

/*
 * 番組の始まり (`programSpan`) は CM 検出が前後の番組を見分けるのに使い、探る長さ (`tsProbe`) にもなる。
 * 録画の先頭は測った放送時刻 (`ts_head`) で、測れていなければ録り始める予定の時刻
 */
describe("番組の始まりと、CM 検出をやり直すときの探り", () => {
  const START = 1_800_000_000_000;
  const row = {
    start_at: START,
    end_at: START + 1_800_000,
    ts_head: null,
    record_from: null,
  };

  test("録画の先頭は測った時刻。無ければ録り始める予定の時刻 (譲ったぶんがあればそこ)", () => {
    expect(programSpan({ ...row, ts_head: START - 7_000 })).toEqual({
      programLength: 1800,
      programStart: 7,
    });
    expect(programSpan(row).programStart).toBe(config.startMargin / 1000);
    expect(
      programSpan({ ...row, record_from: START + 60_000 }).programStart,
    ).toBe(-60);
  });

  test("元の TS から読み直すときは、エンコードしたときと同じ長さまで探り、先頭は捨てない", () => {
    const measured = { ...row, ts_head: START - 90_000 };
    expect(rereadArgs(measured, true)).toEqual([...tsProbe(90)]);
    expect(rereadArgs(measured, true)).not.toContain("-ss");
    expect(rereadArgs(measured, false)).toEqual([]);
  });
});

/**
 * 本物の ffmpeg で、4K の局の録画をエンコードする。偽の放送と同じ素材 (HEVC Main10 と AAC。`synth-mmt-av`) を録画と同じく
 * 1 局に絞って書き、詰め替えた MP4 (`mmts.remuxMmts`) を `buildArgs` の引数でエンコードする。入っていない所 (CI の単体) では飛ばす
 */
const ffmpeg = Bun.which("ffmpeg");
const ffprobeBin = Bun.which("ffprobe");
test.skipIf(ffmpeg === null || ffprobeBin === null)(
  "本物の ffmpeg: 4K の局の録画を、AV1 は 10 ビットの HLG のまま、H.264 は 1080p の SDR にする",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "denpa-uhd-"));
    const av = new SynthMmtAv({
      serviceId: 301,
      mptPacketId: 0x9000,
      startMs: Date.UTC(2026, 10, 11, 12),
    });
    const filter = new MmtServiceFilter(301);
    const source = join(dir, "a.mmts");
    writeFileSync(
      source,
      concatBytes(Array.from({ length: 30 }, () => filter.filter(av.next()))),
    );
    const remuxed = join(dir, "a.mmts.remux.mp4");
    expect((await remuxMmts(source, 301, remuxed)).wrote).toBe(true);

    const encode = (codec: "av1" | "h264") => {
      const output = join(dir, `${codec}.mkv`);
      const done = Bun.spawnSync([
        ffmpeg!,
        "-v",
        "error",
        ...buildArgs(remuxed, output, 1, null, codec, {
          uhd: true,
          smoothMotion: true,
          progress: "/dev/null",
        }),
      ]);
      if (done.exitCode !== 0) console.error(done.stderr.toString());
      expect(done.exitCode).toBe(0);
      const probed = Bun.spawnSync([
        ffprobeBin!,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,pix_fmt,height,color_transfer,color_primaries",
        "-of",
        "json",
        output,
      ]);
      return (
        JSON.parse(probed.stdout.toString()) as {
          streams: Record<string, string | number>[];
        }
      ).streams[0]!;
    };
    expect(encode("av1")).toMatchObject({
      codec_name: "av1",
      pix_fmt: "yuv420p10le",
      height: 64,
      color_transfer: "arib-std-b67",
      color_primaries: "bt2020",
    });
    expect(encode("h264")).toMatchObject({
      codec_name: "h264",
      pix_fmt: "yuv420p",
      height: 1080,
    });
  },
  120_000,
);
