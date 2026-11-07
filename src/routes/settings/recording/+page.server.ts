import { basename } from "node:path";

import { fail } from "@sveltejs/kit";

import { parseIndoorHosts } from "#lib/host.js";
import {
  chooseHw,
  HW_CODECS,
  HW_EVERY,
  HW_SOFTWARE,
  type HwAllow,
  type HwCodec,
  hwUsable,
} from "#lib/hw.js";
import { LIVE_CODECS } from "#lib/live.js";
import { isCmMode } from "#lib/server/cm.js";
import {
  describeDevice,
  type HwEncode,
  hwEncode,
  probe,
} from "#lib/server/hwenc.js";
import {
  parseTranscodeLimit,
  saveSettings,
  settings,
  TRANSCODE_LIMIT_MAX,
} from "#lib/server/settings.js";
import { transcodeAuto } from "#lib/server/transcode.js";
import type { VideoCodec } from "#lib/types.js";

/** 画面に渡す形式。GPU ごとの一言 (`summary`) と、testid に使う GPU の名前 (`port`) を添える */
function forScreen(hw: HwEncode) {
  return {
    ...hw,
    devices: hw.devices.map((device) => ({
      ...device,
      summary: describeDevice(device),
      port: basename(device.path),
    })),
  };
}

export function load() {
  const hw = hwEncode();
  return {
    recording: settings(),
    /**
     * GPU でエンコードできるか (server/hwenc.ts)。起動直後の確かめが終わっていなければ
     * promise のまま渡す。画面は「確認中」を出して待つ
     */
    hw: hw.probed ? forScreen(hw) : probe().then(forScreen),
    /** その場で変換する本数 (`server/transcode.ts`)。自動のときの本数と、選べる本数 */
    transcode: {
      auto: transcodeAuto(),
      choices: Array.from({ length: TRANSCODE_LIMIT_MAX }, (_, i) => i + 1),
    },
  };
}

export const actions = {
  /**
   * エンコード。番組ごとに変えたくなることが実際にはほとんど無いので全体で 1 つ。
   * コーデックごとのエンコーダ (GPU)・その場で変換する本数・元の TS・コマ数も同じ節で受ける。
   * **節ごとにフォームが分かれている** (視聴・CM は別の action)。ここで受けない値には触らない
   */
  saveEncoding: async ({ request }) => {
    const form = await request.formData();
    // **コーデックは複数選べる** (`av1` / `hevc` / `h264`)。1 つも選ばなければ「エンコードしない」。カンマ区切りで持つ
    const picked = form.getAll("codecs").map(String);
    /*
     * H.265 の行は、H.265 をエンコードできる GPU を確かめ終えてからしか出ない (`codecsShown`)。
     * 出ていない画面から来たら、H.265 のチェックは前のまま (確かめている最中に別の欄を変えて外れないように)
     */
    const shown = form.getAll("codecsShown").map(String);
    const codecs = HW_CODECS.filter((codec) =>
      codec === "hevc" && !shown.includes("hevc")
        ? settings().codecs.includes("hevc")
        : picked.includes(codec),
    );
    // その場で変換する本数の上限。空は自動 (GPU の有無で決める)。欄が無ければ前のまま
    const rawLimit = form.get("transcodeLimit");
    const transcodeLimit =
      rawLimit === null ? undefined : parseTranscodeLimit(String(rawLimit));
    if (
      rawLimit !== null &&
      String(rawLimit).trim() !== "" &&
      transcodeLimit === null
    ) {
      return fail(400, { message: "本数が不正です" });
    }
    /*
     * **コーデックごとのエンコーダ** (`hw.av1` / `hw.hevc` / `hw.h264`。ソフトウェア・デバイスの path・順番に使う。H.265 にソフトウェアは無い)。
     * 持ち方はデバイス × 方式 × コーデックのまま (`chooseHw`)。欄が無いコーデック (GPU を
     * 確かめ終わる前に保存した・そのコーデックを使えるデバイスが無い) と、いま見えていないデバイスを
     * 選んできたもの (画面を開いたあとに確かめ直して GPU が変わった) は前のまま。
     * **ライブの列** (`liveHw.av1` / `liveHw.hevc` / `liveHw.h264`) も同じ読み方で `liveHwAllow` に書く。H.265 の欄の `off` は、
     * ソフトウェアでエンコードせず、ライブで H.265 を出さない (画面の「使わない」)
     */
    const devices = hwEncode().devices;
    const choose = (
      prefix: string,
      codecs: readonly HwCodec[],
      from: HwAllow,
    ): HwAllow => {
      let allow = from;
      for (const codec of codecs) {
        const choice = String(form.get(`${prefix}.${codec}`) ?? "");
        const known =
          choice === HW_SOFTWARE ||
          choice === HW_EVERY ||
          hwUsable(devices, codec).some((device) => device.path === choice);
        if (known) allow = chooseHw(allow, devices, codec, choice);
      }
      return allow;
    };
    const hwAllow = choose("hw", HW_CODECS, settings().hwAllow);
    const liveHwAllow = choose(
      "liveHw",
      LIVE_CODECS.map((codec) => codec.id),
      settings().liveHwAllow,
    );
    saveSettings({
      // 並びは HW_CODECS のまま (AV1 → H.265 → H.264)
      codec: (codecs.length > 0 ? codecs.join(",") : "none") as VideoCodec,
      keepOriginal: form.get("keepOriginal") === "on",
      fpsDetect: form.get("fpsDetect") === "on",
      hwAllow,
      liveHwAllow,
      ...(transcodeLimit === undefined ? {} : { transcodeLimit }),
    });
    return { success: true, saved: true };
  },

  /** CM の扱い (チャプターを打つ・切り取る・何もしない) */
  saveCm: async ({ request }) => {
    const cmCut = String((await request.formData()).get("cmCut") ?? "");
    if (!isCmMode(cmCut)) {
      return fail(400, { message: "CM の指定が不正です" });
    }
    saveSettings({ cmCut });
    return { success: true, saved: true };
  },

  /**
   * 視聴 (世帯の設定)。家の中の名前 (1 行に 1 つ。ライブの「自動」で MPEG-2 を先に選ぶ。`#lib/host.ts`) と、
   * コーデックのメニューに H.264 と H.265 を出さないか (`#lib/live-choice.ts` の `HIDDEN_CODECS`)
   */
  saveViewing: async ({ request }) => {
    const form = await request.formData();
    const parsed = parseIndoorHosts(String(form.get("indoorHosts") ?? ""));
    if ("error" in parsed) return fail(400, { message: parsed.error });
    saveSettings({
      indoorHosts: parsed.hosts,
      hideH264Hevc: form.get("hideH264Hevc") === "on",
    });
    return { success: true, saved: true };
  },

  /** GPU を挿し直した・権限を直したあとに、再起動せずに確かめ直す */
  probeHw: async () => {
    await probe();
    return { success: true, probed: true };
  },
};
