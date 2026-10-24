import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ServiceFilter, StreamsWatch } from "#lib/ts/service-filter.js";
import { packetize, patSection, programMap, stream } from "#lib/ts/synth.js";

import {
  chasePlan,
  fileSize,
  followFile,
  resumeFrom,
  resumePlan,
} from "./chase";
import { chunks } from "./stream";

/**
 * 追っかけ再生の追い読み ([issue #16](https://github.com/danything/denpa/issues/16))。
 * 元のTSに時間の索引は無いので、シークはバイト比例の当たりでよい —
 * ここで守るのは「188に揃う」「際に寄りすぎない」「録り終わるまで読み続ける」。
 */
describe("どこから読み始めるか (chasePlan)", () => {
  test("バイト比例で、TSパケットの頭に揃える", () => {
    // 600秒で 600 * 188 * 100 バイト → 1秒 = 188*100 バイト
    const plan = chasePlan(600 * 188 * 100, 600, 300);
    expect(plan.at).toBe(300);
    expect(plan.offset).toBe(300 * 188 * 100);
    expect(plan.offset % 188).toBe(0);
  });

  test("書き込み中の端 (いま書いているところ) の少し手前までしか行かない", () => {
    const plan = chasePlan(600 * 188 * 100, 600, 9999);
    expect(plan.at).toBe(595);
  });

  test("負の位置は頭に丸める", () => {
    expect(chasePlan(1_000_000, 60, -5).at).toBe(0);
    expect(chasePlan(1_000_000, 60, -5).offset).toBe(0);
  });

  test("送り込みは実測レートより速い (追い付けるように)", () => {
    const size = 600 * 2_000_000; // 2MB/s の10分
    const plan = chasePlan(size, 600, 0);
    expect(plan.paceBytesPerSec).toBeGreaterThan(size / 600);
  });
});

describe("伸びるファイルの追い読み (followFile)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  async function readAll(
    stream: ReadableStream<Uint8Array>,
  ): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const chunk of chunks(stream)) parts.push(chunk);
    const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  test("書き足されたぶんも読んでから終わる", async () => {
    dir = mkdtempSync(join(tmpdir(), "chase-"));
    const path = join(dir, "rec.ts");
    writeFileSync(path, "abcdef");

    // 尻に着いたら1回だけ書き足し、次に訊かれたとき「終わった」と答える
    let asked = 0;
    const stream = followFile(path, 0, 1e9, () => {
      asked++;
      if (asked === 1) {
        appendFileSync(path, "ghij");
        return false;
      }
      return true;
    });
    const got = await readAll(stream);
    expect(new TextDecoder().decode(got)).toBe("abcdefghij");
  });

  test("途中 (offset) から読める", async () => {
    dir = mkdtempSync(join(tmpdir(), "chase-"));
    const path = join(dir, "rec.ts");
    writeFileSync(path, "0123456789");
    const got = await readAll(followFile(path, 4, 1e9, () => true));
    expect(new TextDecoder().decode(got)).toBe("456789");
  });

  /*
   * HTTP の追っかけで、エンコードした先が読まれていない間は送り込みを止める (`live.ts` の
   * `chaseStream`)。止めている間は読まず、外れたら続きから読む
   */
  test("止めておく間 (hold) は読まず、外れたら続きを読む", async () => {
    dir = mkdtempSync(join(tmpdir(), "chase-"));
    const path = join(dir, "rec.ts");
    writeFileSync(path, "abcdef");
    let held = 0;
    const got = await readAll(
      followFile(
        path,
        0,
        1e9,
        () => true,
        () => ++held <= 3,
      ),
    );
    expect(new TextDecoder().decode(got)).toBe("abcdef");
    expect(held).toBeGreaterThan(3);
  });

  /*
   * アプリ向けの字幕 API は、リクエストされた位置より手前から読み始めて観ている位置を追い越す
   * (`live.ts` の `recordingCaptions`)。頭のぶんは倍速の縛りを掛けない
   */
  test("頭の burst ぶんは送り込みの上限を掛けずに読む", async () => {
    dir = mkdtempSync(join(tmpdir(), "chase-"));
    const path = join(dir, "rec.ts");
    writeFileSync(path, new Uint8Array(600 * 1024));
    const started = Date.now();
    // 1KB/秒の縛りなら 10 分かかる量
    const got = await readAll(
      followFile(path, 0, 1024, () => true, undefined, 600 * 1024),
    );
    expect(got.length).toBe(600 * 1024);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("無いファイルは転ぶ (エラーとして伝わる)", async () => {
    dir = mkdtempSync(join(tmpdir(), "chase-"));
    const stream = followFile(join(dir, "missing.ts"), 0, 1e9, () => true);
    expect(readAll(stream)).rejects.toThrow();
  });
});

describe("fileSize", () => {
  test("無ければ null", () => {
    expect(fileSize("/no/such/file.ts")).toBeNull();
  });
});

/**
 * **番組が替わって作り直したところから読み直す** (`resumeFrom` / `resumePlan`)。秒からバイトへの当たりは比例なので、
 * 少し手前に当たると前の番組の PMT を読んでからまた変わり、作り直しを繰り返す。変わったところの近くを
 * リクエストされたら、変わったところのバイトから読む
 */
describe("作り直したところから読み直す (resumePlan)", () => {
  const SERVICE = 1024;
  const PMT = 0x1f0;
  const pat = () => packetize(0x0000, patSection([[SERVICE, PMT]]));
  const before = () =>
    packetize(
      PMT,
      programMap(SERVICE, 0x100, [
        [0x02, 0x100],
        [0x0f, 0x110],
      ]),
    );
  // 番組が替わって音声が増えた
  const after = () =>
    packetize(
      PMT,
      programMap(SERVICE, 0x100, [
        [0x02, 0x100],
        [0x0f, 0x110],
        [0x0f, 0x111],
      ]),
    );
  /** 前の番組 40 組・新しい番組 40 組の PAT/PMT が並んだ元のTS */
  const ts = stream(
    ...Array.from({ length: 40 }, () => [pat(), before()]).flat(),
    ...Array.from({ length: 40 }, () => [pat(), after()]).flat(),
  );

  /** `from` から塊ごとに読んで、並びが変わったら頭から読んだ量を返す (`Session.pump` と同じ見方) */
  function readUntilChange(
    from: number,
    size: number,
  ): { consumed: number | null; first: string | null } {
    const filter = new ServiceFilter(SERVICE);
    const watch = new StreamsWatch();
    let first: string | null = null;
    for (let at = from; at < ts.length; at += size) {
      filter.filter(ts.subarray(at, Math.min(ts.length, at + size)));
      first ??= filter.streams;
      if (watch.changed(filter))
        return { consumed: Math.min(ts.length, at + size) - from, first };
    }
    return { consumed: null, first };
  }

  test("変わったところから読み直すと、新しい並びから始まって作り直しを繰り返さない", () => {
    const plan = chasePlan(ts.length, 80, 0);
    // 塊は 188 に揃っていない (読む量は 256KB)
    const { consumed } = readUntilChange(plan.offset, 1000);
    expect(consumed).not.toBeNull();
    const resume = resumeFrom(plan, consumed ?? 0, 0);
    expect(resume.offset % 188).toBe(0);

    // 少し手前の秒をリクエストされても、変わったところから
    const again = resumePlan(
      chasePlan(ts.length, 80, resume.at - 3),
      resume,
      1,
    );
    expect(again.offset).toBe(resume.offset);
    expect(again.at).toBe(resume.at);
    const reread = readUntilChange(again.offset, 1000);
    expect(reread.first).toBe("2:256,15:272,15:273");
    expect(reread.consumed).toBeNull();
  });

  test("遠くの位置・期限を過ぎたあと・覚えていない録画は、いつもの当たりのまま", () => {
    const plan = chasePlan(ts.length, 80, 0);
    const resume = resumeFrom(plan, 40 * 2 * 188, 0);
    const far = chasePlan(ts.length, 80, resume.at + 30);
    expect(resumePlan(far, resume, 1)).toEqual(far);
    const near = chasePlan(ts.length, 80, resume.at);
    expect(resumePlan(near, resume, resume.until + 1)).toEqual(near);
    expect(resumePlan(near, undefined)).toEqual(near);
  });
});
