import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { concatBytes } from "@danything/arib/bytes";
import { WRAP } from "@danything/arib/pes";
import { PACKET, packetPid, PID_PAT } from "@danything/arib/psi";
import { packetize, patSection, programMap } from "@danything/arib/synth";
import {
  AUDIO_TICKS,
  FRAME_TICKS,
  mpeg2Frame,
  packetizePes,
  pes,
  silentAac,
} from "@danything/arib/synth-av";

import { chapterArgs, probeLiveAudio, probeVideo } from "./cm";
import { config } from "./config";
import { buildArgs } from "./encoder";
import {
  type AudioEs,
  encodeLateAudio,
  findLateAudio,
  lateAudio,
  lateAudioArgs,
  lateOffset,
  scanAudioEs,
  sinceStart,
} from "./late-audio";

const SERVICE = 1024;
const PMT_PID = 0x1f0;
const VIDEO_PID = 0x100;
const MAIN_PID = 0x110;
const SUB_PID = 0x111;
/** 時刻の始まり (90kHz)。放送の PTS は 0 から始まらない */
const BASE = 10 * 90_000;

const dir = mkdtempSync(join(tmpdir(), "denpa-late-audio-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * **途中から副音声が始まる録画** (偽の TS)。映像 (MPEG-2) と主音声 (AAC) は先頭から、副音声は `subFrom` 秒から。
 * 副音声が始まるときに PMT を作り直して ES を足す (版を上げる)。PAT と PMT は 3 コマ (約 100 ms) ごと
 */
function recording(seconds: number, subFrom: number): Uint8Array {
  const counters = new Map<number, number>();
  const out: Uint8Array[] = [];
  const put = (pid: number, data: Uint8Array, pcr: number | null = null) => {
    const { packets, counter } = packetizePes(
      pid,
      data,
      counters.get(pid) ?? 0,
      pcr,
    );
    counters.set(pid, counter);
    out.push(packets);
  };
  const audio = (tag: number): number[] => [0x52, 0x01, tag];
  const frames = Math.round((seconds * 90_000) / FRAME_TICKS);
  let mainAt = 0;
  let subAt = Math.round((subFrom * 90_000) / AUDIO_TICKS) * AUDIO_TICKS;
  for (let n = 0; n < frames; n++) {
    const at = n * FRAME_TICKS;
    const withSub = at >= subFrom * 90_000;
    if (n % 3 === 0) {
      out.push(packetize(PID_PAT, patSection([[SERVICE, PMT_PID]])));
      out.push(
        packetize(
          PMT_PID,
          programMap(SERVICE, VIDEO_PID, [
            [0x02, VIDEO_PID],
            [0x0f, MAIN_PID, audio(0x10)],
            ...(withSub
              ? [[0x0f, SUB_PID, audio(0x11)] as [number, number, number[]]]
              : []),
          ]),
        ),
      );
    }
    put(VIDEO_PID, pes(0xe0, BASE + at, mpeg2Frame(n)), BASE + at - 9_000);
    for (; mainAt <= at; mainAt += AUDIO_TICKS)
      put(MAIN_PID, pes(0xc0, BASE + mainAt, silentAac()));
    if (withSub)
      for (; subAt <= at; subAt += AUDIO_TICKS)
        put(SUB_PID, pes(0xc0, BASE + subAt, silentAac()));
  }
  return concatBytes(out);
}

function es(overrides: Partial<AudioEs>): AudioEs {
  return {
    pid: SUB_PID,
    index: 1,
    tags: [0x10, 0x11],
    resume: 0,
    first: BASE,
    last: BASE,
    ...overrides,
  };
}

describe("録画全体から音声の ES を探す", () => {
  test("途中で PMT に足された副音声も、現れた位置と時刻が分かる", async () => {
    const path = join(dir, "scan.ts");
    const data = recording(4, 2);
    writeFileSync(path, data);
    const found = await scanAudioEs(path);

    expect(found.map((e) => [e.pid, e.index])).toEqual([
      [MAIN_PID, 0],
      [SUB_PID, 1],
    ]);
    const [main, sub] = found as [AudioEs, AudioEs];
    expect(main.first).toBe(BASE);
    expect(main.resume).toBe(0);
    expect(sub.tags).toEqual([0x10, 0x11]);
    // 副音声の 1 フレーム目は 2 秒に近い AAC のフレームの切れ目
    expect(Math.abs(sub.first - (BASE + 2 * 90_000))).toBeLessThan(AUDIO_TICKS);
    expect(sub.last).toBeGreaterThan(sub.first);
    // 読み始める位置は PAT のパケット。そこから先に副音声の最初のパケットがある
    expect(packetPid(data.subarray(sub.resume, sub.resume + PACKET))).toBe(
      PID_PAT,
    );
    let firstSub = -1;
    for (let at = 0; at < data.length; at += PACKET)
      if (packetPid(data.subarray(at, at + PACKET)) === SUB_PID) {
        firstSub = at;
        break;
      }
    expect(sub.resume).toBeGreaterThan(0);
    expect(sub.resume).toBeLessThan(firstSub);
  });

  test("188 バイトの並びでなければ何も見つけない", async () => {
    const path = join(dir, "noise.ts");
    writeFileSync(path, new Uint8Array(PACKET * 10).fill(0x11));
    expect(await scanAudioEs(path)).toEqual([]);
  });
});

describe("足す ES を選ぶ", () => {
  const span = { formatStart: BASE / 90_000, programStart: 0, programEnd: 60 };

  test("先頭の探りで中身のあった ES は足さない", () => {
    const found = [
      es({ pid: MAIN_PID, index: 0 }),
      es({ first: BASE + 90_000 * 30 }),
    ];
    expect(lateAudio(found, [MAIN_PID], span).map((e) => e.pid)).toEqual([
      SUB_PID,
    ]);
    expect(lateAudio(found, [MAIN_PID, SUB_PID], span)).toEqual([]);
  });

  test("番組が終わってから現れる ES (次の番組の副音声) は足さない", () => {
    const next = es({ first: BASE + 90_000 * 61, last: BASE + 90_000 * 70 });
    expect(lateAudio([next], [MAIN_PID], span)).toEqual([]);
  });

  test("番組が始まる前に消えた ES (前の番組の副音声) は足さない", () => {
    const before = es({ first: BASE, last: BASE + 90_000 * 5 });
    expect(
      lateAudio([before], [MAIN_PID], { ...span, programStart: 10 }),
    ).toEqual([]);
  });

  test("録画の先頭の時刻が分からなければ足さない", () => {
    expect(
      lateAudio([es({})], [MAIN_PID], { ...span, formatStart: NaN }),
    ).toEqual([]);
  });

  test("録画の途中で PTS が 1 周しても、先頭より後ろとして数える", () => {
    const start = (WRAP - 90_000 * 10) / 90_000;
    expect(sinceStart(90_000 * 5, start)).toBeCloseTo(15, 6);
    expect(sinceStart(WRAP - 90_000 * 4, start)).toBeCloseTo(6, 6);
  });
});

describe("足すときのずらし幅", () => {
  test("本編の 0 秒 (録画の先頭から skip 秒) に合わせる", () => {
    expect(lateOffset(es({ first: BASE + 90_000 }), 10, 0.5)).toBeCloseTo(
      -10.5,
      6,
    );
  });

  test("録画の先頭より後で 1 周していたら 1 周を足す", () => {
    const start = (WRAP - 90_000 * 10) / 90_000;
    expect(lateOffset(es({ first: 90_000 * 5 }), start, 0)).toBeCloseTo(
      WRAP / 90_000 - start,
      6,
    );
  });
});

describe("途中から現れる音声をエンコードする引数", () => {
  test("現れる手前の PAT から読み、PID で名指しし、本編の 0 秒から無音で埋める", () => {
    const args = lateAudioArgs(
      "/in.m2ts",
      es({ resume: 188 * 40 }),
      "/a.mka",
      -10.5,
      2,
    ).join(" ");
    expect(args).toContain("-copyts -skip_initial_bytes 7520");
    expect(args).toContain(`-map 0:i:${SUB_PID}`);
    expect(args).toContain(
      "-af asetpts=PTS-10.500000/TB,aresample=async=1:first_pts=0",
    );
    expect(args).toContain("-c:a libopus -b:a 256k -ac 2");
  });
});

describe("途中から現れる音声を探す", () => {
  const audios = [
    { componentType: 3, componentTag: 0x10, text: "主音声" },
    { componentType: 9, componentTag: 0x11, text: "副音声" },
  ];
  const path = join(dir, "find.ts");
  writeFileSync(path, recording(4, 2));
  const options = {
    formatStart: BASE / 90_000,
    programStart: 0,
    programEnd: 4,
    audios,
    signal: new AbortController().signal,
  };

  test("名前とチャンネル数は部品タグで番組表と突き合わせる", async () => {
    const found = await findLateAudio(path, {
      ...options,
      live: [{ index: 0, pid: MAIN_PID }],
    });
    expect(found.map((f) => [f.es.pid, f.title, f.channels])).toEqual([
      [SUB_PID, "副音声", 6],
    ]);
  });

  test("先頭の探りで PID が読めなければ探さない", async () => {
    expect(
      await findLateAudio(path, {
        ...options,
        live: [{ index: 0, pid: null }],
      }),
    ).toEqual([]);
    expect(await findLateAudio(path, { ...options, live: [] })).toEqual([]);
  });
});

/** ffprobe で 1 本のストリームのパケットの時刻 (秒) を並べる */
function packetTimes(ffprobe: string, file: string, stream: string): number[] {
  const out = Bun.spawnSync([
    ffprobe,
    "-v",
    "error",
    "-select_streams",
    stream,
    "-show_entries",
    "packet=pts_time",
    "-of",
    "csv=p=0",
    file,
  ]);
  return out.stdout
    .toString()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => Number(line.trim().replace(/,$/, "")))
    .filter((t) => Number.isFinite(t));
}

/**
 * 本物の ffmpeg で、途中から副音声が始まる録画をエンコードする。本編は先頭の探りで見えた主音声だけでエンコードし
 * (`buildArgs`)、副音声は `encodeLateAudio` で音声だけにして、チャプターを書き足すときに足す (`chapterArgs`)。
 * 入っていない所 (CI の単体) では飛ばす
 */
const ffmpeg = Bun.which("ffmpeg");
const ffprobe = Bun.which("ffprobe");
test.skipIf(ffmpeg === null || ffprobe === null)(
  "本物の ffmpeg: 途中から始まる副音声を 2 本目の音声として残し、本編の 0 秒から終わりまでに収める",
  async () => {
    const saved = { ffmpeg: config.ffmpeg, ffprobe: config.ffprobe };
    config.ffmpeg = ffmpeg!;
    config.ffprobe = ffprobe!;
    try {
      const source = join(dir, "late.ts");
      writeFileSync(source, recording(24, 20));

      // 先頭の探り (15 秒) には主音声しか見えない
      const live = await probeLiveAudio(source);
      expect(live).toEqual([{ index: 0, pid: MAIN_PID }]);
      const measured = await probeVideo(source);

      const [late, ...others] = await findLateAudio(source, {
        live,
        formatStart: measured.formatStart,
        programStart: 0,
        programEnd: 24,
        audios: [
          { componentType: 3, componentTag: 0x10, text: "主音声" },
          { componentType: 3, componentTag: 0x11, text: "副音声" },
        ],
        signal: new AbortController().signal,
      });
      expect(others).toEqual([]);
      expect(late!.es.pid).toBe(SUB_PID);
      const sub = join(dir, "sub.mka");
      expect(
        await encodeLateAudio(
          source,
          late!,
          lateOffset(late!.es, measured.formatStart, 0),
          sub,
          new AbortController().signal,
        ),
      ).toBe(true);

      const main = join(dir, "main.mkv");
      const encoded = Bun.spawnSync([
        ffmpeg!,
        "-v",
        "error",
        ...buildArgs(source, main, 3, null, "h264", {
          audioStreams: [0],
          progress: "/dev/null",
        }),
      ]);
      if (encoded.exitCode !== 0) console.error(encoded.stderr.toString());
      expect(encoded.exitCode).toBe(0);

      const output = join(dir, "out.mkv");
      const merged = Bun.spawnSync(
        chapterArgs(main, null, output, {
          audios: 1,
          tracks: [{ path: sub, title: late!.title }],
        }),
      );
      if (merged.exitCode !== 0) console.error(merged.stderr.toString());
      expect(merged.exitCode).toBe(0);

      const probed = Bun.spawnSync([
        ffprobe!,
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name:stream_tags=title",
        "-of",
        "json",
        output,
      ]);
      const streams = (
        JSON.parse(probed.stdout.toString()) as {
          streams: {
            codec_type: string;
            codec_name: string;
            tags?: { title?: string };
          }[];
        }
      ).streams;
      expect(streams.map((s) => s.codec_type)).toEqual([
        "video",
        "audio",
        "audio",
      ]);
      expect(streams[2]!.codec_name).toBe("opus");
      expect(streams[2]!.tags?.title).toBe("副音声");
      // 副音声は 20 秒目から現れるが、0 秒から無音で埋めてあり、本編と同じ所で終わる
      const times = packetTimes(ffprobe!, output, "a:1");
      const mainTimes = packetTimes(ffprobe!, output, "a:0");
      expect(times[0]!).toBeLessThan(0.05);
      expect(Math.abs(times.at(-1)! - mainTimes.at(-1)!)).toBeLessThan(0.1);
    } finally {
      config.ffmpeg = saved.ffmpeg;
      config.ffprobe = saved.ffprobe;
    }
  },
  120_000,
);
