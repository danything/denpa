import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ServiceFilter, StreamsWatch } from "@danything/arib/service-filter";
import {
  packetize,
  patSection,
  programMap,
  stream,
} from "@danything/arib/synth";
import { packetizePes, pes } from "@danything/arib/synth-av";

import {
  chasePlan,
  chaseReadHeld,
  fileSize,
  finishedTsSec,
  followFile,
  recordedSec,
  resumeFrom,
  resumePlan,
  tlvStart,
  tsFileHead,
} from "./chase";
import { chunks } from "./stream";

/**
 * 追っかけ再生の追い読み ([issue #16](https://github.com/danything/denpa/issues/16))。
 * 元の TS に時間の索引は無いので、シークはバイト比例の当たりでよい。
 * ここで守るのは「188 に揃う」「端に寄りすぎない」「録り終わるまで読み続ける」。
 */
describe("どこから読み始めるか (chasePlan)", () => {
  test("バイト比例で、TS パケットの先頭に揃える", () => {
    // 600 秒で 600 * 188 * 100 バイト → 1 秒 = 188*100 バイト
    const plan = chasePlan(600 * 188 * 100, 600, 300);
    expect(plan.at).toBe(300);
    expect(plan.offset).toBe(300 * 188 * 100);
    expect(plan.offset % 188).toBe(0);
  });

  test("書き込み中の端 (いま書いているところ) の少し手前までしか行かない", () => {
    const plan = chasePlan(600 * 188 * 100, 600, 9999);
    expect(plan.at).toBe(595);
  });

  test("負の位置は先頭に丸める", () => {
    expect(chasePlan(1_000_000, 60, -5).at).toBe(0);
    expect(chasePlan(1_000_000, 60, -5).offset).toBe(0);
  });

  test("送り込みは実測レートより速い (追い付けるように)", () => {
    const size = 600 * 2_000_000; // 2MB/s の 10 分
    const plan = chasePlan(size, 600, 0);
    expect(plan.paceBytesPerSec).toBeGreaterThan(size / 600);
  });
});

/*
 * 4K の局の録画 (TLV) は、`chasePlan` の 188 バイトに切った位置がパケットの途中に当たる。
 * HTTP の追っかけの `codec=raw` はパケットの先頭から送る
 */
describe("TLV のパケットの先頭 (tlvStart)", () => {
  /** 0x7F・種類 (ヌル)・長さ・中身 (0) の TLV パケット */
  const tlv = (length: number) => {
    const packet = new Uint8Array(4 + length);
    packet.set([0x7f, 0xff, length >> 8, length & 0xff]);
    return packet;
  };

  test("途中の位置から、次のパケットの先頭へ進める", () => {
    const dir = mkdtempSync(join(tmpdir(), "denpa-tlv-start-"));
    const path = join(dir, "a.mmts");
    writeFileSync(path, Buffer.concat([tlv(300), tlv(500), tlv(400), tlv(10)]));
    try {
      expect(tlvStart(path, 0)).toBe(0);
      expect(tlvStart(path, 188)).toBe(304);
      expect(tlvStart(path, 304)).toBe(304);
      expect(tlvStart(path, 376)).toBe(808);
      // 先頭が見つからなければ渡した位置のまま
      expect(tlvStart(join(dir, "none.mmts"), 188)).toBe(188);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

    // 末尾に着いたら 1 回だけ書き足し、次に訊かれたとき「終わった」と答える
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
   * (`live.ts` の `recordingCaptions`)。先頭のぶんは倍速の縛りを掛けない
   */
  test("先頭の burst ぶんは送り込みの上限を掛けずに読む", async () => {
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

  test("無いファイルはエラーとして伝わる", async () => {
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
  /** 前の番組 40 組・新しい番組 40 組の PAT/PMT が並んだ元の TS */
  const ts = stream(
    ...Array.from({ length: 40 }, () => [pat(), before()]).flat(),
    ...Array.from({ length: 40 }, () => [pat(), after()]).flat(),
  );

  /** `from` から塊ごとに読んで、並びが変わったら `from` から読んだ量を返す (`Session.pump` と同じ見方) */
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

/**
 * 追っかけを元の TS で送るときの物差しの 0 (`live.ts` の `openChase` が `timeline.origin` に載せる)。
 * 画面は届いた PTS からこれを引いて再生位置を出す
 */
describe("元の TS の先頭の PTS (tsFileHead)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  /** 映像と音声の PES を 1 つずつ。映像の PTS は音声より後 */
  function head(start: number): Uint8Array {
    const video = packetizePes(
      0x100,
      pes(0xe0, start + 3003, new Uint8Array(300)),
      0,
    ).packets;
    const audio = packetizePes(
      0x110,
      pes(0xc0, start, new Uint8Array(7)),
      0,
    ).packets;
    const out = new Uint8Array(video.length + audio.length);
    out.set(video);
    out.set(audio, video.length);
    return out;
  }

  test("映像と音声の最初の PTS の早いほう (観る画面の物差しと同じ `tsHead`)", async () => {
    dir = mkdtempSync(join(tmpdir(), "chase-"));
    const path = join(dir, "rec.ts");
    writeFileSync(path, head(900_000));
    expect(await tsFileHead(path)).toBe(900_000);
  });

  test("読めたものは覚える (録画中も先頭は変わらない)", async () => {
    dir = mkdtempSync(join(tmpdir(), "chase-"));
    const path = join(dir, "rec.ts");
    writeFileSync(path, head(1_800_000));
    expect(await tsFileHead(path)).toBe(1_800_000);
    writeFileSync(path, head(2_700_000));
    expect(await tsFileHead(path)).toBe(1_800_000);
  });

  test("まだ先頭が揃っていなければ null。しばらくは読み直さず、過ぎたら読み直す", async () => {
    dir = mkdtempSync(join(tmpdir(), "chase-"));
    const path = join(dir, "rec.ts");
    const at = 1_000_000;
    expect(await tsFileHead(path, at)).toBeNull();
    writeFileSync(path, head(450_000));
    // 控えている間は読まない (シークのたびに 4MB 読み直さない)
    expect(await tsFileHead(path, at + 1_000)).toBeNull();
    expect(await tsFileHead(path, at + 5_001)).toBe(450_000);
  });
});

/**
 * 追っかけを元の TS で送るとき、録画のファイルを読むのを止めるか (`live.ts` の `openChase` が `followFile` の `hold` に渡す)。
 * 元の TS は捨てると観ていない先が欠けるので、捨てる代わりに読むほうを止める
 */
describe("元の TS の追っかけで読むのを止めるか (chaseReadHeld)", () => {
  const none = { asked: false, congested: false, outside: false };

  test("画面が止めてと送ってきた・送り先が詰まっている・ほかの理由、のどれかで止める", () => {
    expect(chaseReadHeld(none)).toBe(false);
    expect(chaseReadHeld({ ...none, asked: true })).toBe(true);
    expect(chaseReadHeld({ ...none, congested: true })).toBe(true);
    expect(chaseReadHeld({ ...none, outside: true })).toBe(true);
  });

  test("止めている間は読まず、画面が続けてと送ったら続きを読む (`followFile` に渡したとき)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chase-"));
    try {
      const path = join(dir, "rec.ts");
      writeFileSync(path, "abcdef");
      const viewer = { held: true };
      let asked = 0;
      const stream = followFile(
        path,
        0,
        1e9,
        () => true,
        () => {
          // 3 回訊かれるまで止めてもらい、そのあと画面が `{ type: 'hold', on: false }` を送ったことにする
          if (++asked > 3) viewer.held = false;
          return chaseReadHeld({
            asked: viewer.held,
            congested: false,
            outside: false,
          });
        },
      );
      const parts: string[] = [];
      for await (const chunk of chunks(stream))
        parts.push(new TextDecoder().decode(chunk));
      expect(parts.join("")).toBe("abcdef");
      expect(asked).toBeGreaterThan(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 追っかけと録画の字幕が、秒をバイトに当てる物差し (`recordedSec`)。録り終えたものは元の TS を測る。
 * `duration_ms` はエンコードし終えると出来上がりの長さ (先頭を捨てたあと) になり、TS より短い
 */
describe("元の TS に録れている長さ (recordedSec)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  /** 先頭に音声の PES、そのあと 1 秒ごとに映像の PES を `seconds` 秒まで */
  function span(start: number, seconds: number): Uint8Array {
    const parts = [
      packetizePes(0x110, pes(0xc0, start, new Uint8Array(7)), 0).packets,
    ];
    for (let s = 0; s <= seconds; s++)
      parts.push(
        packetizePes(
          0x100,
          pes(0xe0, start + s * 90_000, new Uint8Array(300)),
          s,
        ).packets,
      );
    const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  const NOW = 1_800_000_000_000;
  const row = {
    finished_at: NOW,
    created_at: NOW - 3_600_000,
    duration_ms: 1_200_000,
    encode_skip: null as number | null,
    start_at: NOW - 1_800_000,
    end_at: NOW,
  };

  test("先頭を捨ててエンコードした録画でも、出来上がりの長さではなく元の TS の尺", () => {
    dir = mkdtempSync(join(tmpdir(), "chase-"));
    const path = join(dir, "rec.ts");
    writeFileSync(path, span(900_000, 1500));
    expect(finishedTsSec(path)).toBe(1500);
    expect(recordedSec({ ...row, encode_skip: 3 }, path, NOW)).toBe(1500);
  });

  test("測れなければ、エンコードしていない録画は録れた長さ、エンコードしたものは番組表の尺", () => {
    dir = mkdtempSync(join(tmpdir(), "chase-"));
    const path = join(dir, "rec.ts");
    // PES の無い TS (読めない)
    writeFileSync(path, new Uint8Array(188 * 10).fill(0x47));
    expect(finishedTsSec(path)).toBeNull();
    expect(recordedSec(row, path, NOW)).toBe(1200);
    expect(recordedSec({ ...row, encode_skip: 3 }, path, NOW)).toBe(1800);
  });

  test("録っている最中は、録り始めてからの経過", () => {
    dir = mkdtempSync(join(tmpdir(), "chase-"));
    const path = join(dir, "rec.ts");
    writeFileSync(path, span(900_000, 1500));
    expect(recordedSec({ ...row, finished_at: null }, path, NOW)).toBe(3600);
  });
});
