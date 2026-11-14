import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * E2E の偽 ffmpeg (`tests/fake/ffmpeg.sh`) が、引数を見て正しい経路を選ぶか。
 *
 * 偽 ffmpeg は `printf '%s\n' "$@" | grep -q …` で引数を探す。grep -q は見つけた所で終わるので、
 * printf は残りの引数を閉じたパイプへ書いて SIGPIPE で終わる。`pipefail` だとこの終了がパイプライン全体の
 * 失敗になり、**見つかったのに見つからなかったことになる**。CI で 1 度、CM 検出を一緒にするエンコードが
 * 無音を返さず、エンコードしたもの (作業ファイル) も書かずに 0 で終わり、置くところで `ENOENT ... rename` になった。
 * 残りの引数が短いと printf が先に書き終えるので、たまにしか起きない。ここでは残りをパイプの容量より長くして、毎回起こす
 */
const root = mkdtempSync(join(tmpdir(), "denpa-fake-ffmpeg-"));

describe("偽 ffmpeg", () => {
  test("CM 検出の出力の後ろに長い引数が続いても、無音を返してエンコードしたものを書く", async () => {
    const working = join(root, "番組.mkv.1.av1.encoding");
    const silences = join(root, "silences");
    // パイプの容量 (64 KiB) より長い
    const rest = Array.from({ length: 20_000 }, () => "-metadata");
    const proc = Bun.spawn(
      [
        "tests/fake/ffmpeg.sh",
        "-y",
        "-i",
        join(root, "in.m2ts"),
        "-f",
        "matroska",
        working,
        "-map",
        "0:a:0",
        "-af",
        `silencedetect=noise=-50dB:d=0.5,ametadata=mode=print:file=${silences}`,
        ...rest,
        "-f",
        "null",
        "-",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await proc.exited).toBe(0);
    expect(existsSync(working)).toBe(true);
    expect(readFileSync(silences, "utf8")).toContain("lavfi.silence_start");
  });
});

describe("偽 ffmpeg の「そろうまで終えない」目印", () => {
  test("2 本目の起動が 1 本目のエンコードの長さより遅れても、2 本の間は重なる", async () => {
    const dir = mkdtempSync(join(root, "together-"));
    const spans = join(dir, "spans");
    const together = join(dir, "together");
    writeFileSync(together, "2");
    const input = join(dir, "in.m2ts");
    const encode = (codec: string) =>
      Bun.spawn(
        [
          "tests/fake/ffmpeg.sh",
          "-y",
          "-i",
          input,
          "-f",
          "matroska",
          join(dir, `番組.mkv.1.${codec}.encoding`),
        ],
        {
          stdout: "ignore",
          stderr: "ignore",
          env: {
            ...process.env,
            FAKE_FFMPEG_ENCODE_SPANS_FILE: spans,
            FAKE_FFMPEG_ENCODE_TOGETHER_FILE: together,
          },
        },
      );
    const before = Date.now();
    const first = encode("av1");
    // 偽 ffmpeg のエンコード (0.8 秒) より長く遅らせる
    await Bun.sleep(1500);
    const second = encode("h264");
    expect([await first.exited, await second.exited]).toEqual([0, 0]);
    const after = Date.now();

    // 落ちたときに、残った時刻とテストから見た時刻をそのまま出す
    const text = readFileSync(spans, "utf8");
    const at = (kind: string) =>
      text
        .split("\n")
        .filter((line) => line.startsWith(`${kind}\t`))
        .map((line) => Number(line.split("\t")[1]));
    const [start, end] = [at("start"), at("end")];
    const report = `before=${before} after=${after}\n${text}`;
    // 時刻はテストから見た起動から終了までの間に入る。Ubuntu 26.04 の `date +%s%3N` は最大 0.9 秒ずれた
    expect(
      [...start, ...end].every((t) => before <= t && t <= after) ? "" : report,
    ).toBe("");
    expect(Math.max(...start) < Math.min(...end) ? "" : report).toBe("");
  });
});
