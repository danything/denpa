import { describe, expect, test } from "bun:test";

import { chunks, lowerPriority, run } from "./stream";

/**
 * 外の道具を起こして読み切るところ (`run`)。
 *
 * ここで見るのは**読み切った中身の形式**。`stdout` は `Uint8Array` だと
 * 名乗っているので、**大きさによらずそうであること**を確かめる。
 */
describe("run の標準出力", () => {
  test("小さい出力はそのまま読める", async () => {
    const { code, stdout } = await run(["echo", "-n", "PG"], { stdout: true });
    expect(code).toBe(0);
    expect(stdout).toBeInstanceOf(Uint8Array);
    expect(stdout.length).toBe(2);
  });

  /**
   * **1MB を跨いでも Uint8Array のまま。**
   *
   * Bun 1.3.14 の `Response.bytes()` は 1MB を境に ArrayBuffer を返し、
   * `.length` が `undefined` になっていた。型は Uint8Array のままなので
   * 型検査では気付けず、字幕の画像 (以前の `captions.sup`) が `Content-Length: undefined` を
   * 送って**本文ごと落ちていた** (6.4MB の字幕を持つ録画で字幕が出ない)。
   * `.length` を見るのはそれが壊れていた値だから
   */
  test("1MB を超える出力でも Uint8Array で、長さが取れる", async () => {
    const size = 4 * 1024 * 1024;
    const { code, stdout } = await run(
      ["head", "-c", String(size), "/dev/zero"],
      { stdout: true },
    );
    expect(code).toBe(0);
    expect(stdout).toBeInstanceOf(Uint8Array);
    expect(stdout.length).toBe(size);
    expect(stdout.byteLength).toBe(size);
    // Content-Length に載る値。ここが "undefined" になっていた
    expect(String(stdout.length)).toBe(String(size));
  });

  test("起こせない道具は投げずに 127 で返る", async () => {
    const { code } = await run(["denpa-such-command-does-not-exist"], {
      stdout: true,
    });
    expect(code).toBe(127);
  });

  /**
   * **押された後の合図でも起こさない。** `abort` の聞き耳は押された瞬間にしか
   * 鳴らないので、押された後に起こした道具は最後まで走っていた (中止を押した
   * あとの無音検出・字幕づくり)。殺されたときと同じ 143 で、すぐ返る
   */
  test("もう押されている中止の合図なら、起こさずに 143 で返る", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const { code } = await run(["sleep", "5"], { signal: controller.signal });
    expect(code).toBe(143);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("run の標準出力を流して受ける (onStdout)", () => {
  test("溜めずに来たそばから渡し、stdout は空で返る", async () => {
    let total = 0;
    const size = 4 * 1024 * 1024;
    const { code, stdout } = await run(
      ["head", "-c", String(size), "/dev/zero"],
      {
        onStdout: (chunk) => {
          total += chunk.length;
        },
      },
    );
    expect(code).toBe(0);
    expect(total).toBe(size);
    expect(stdout.length).toBe(0);
  });

  /** 受け手が投げたら道具を止める。止めないと誰も読まない管が詰まり、時間切れまで居座る */
  test("受け手が投げたら、道具を止めて投げ直す", async () => {
    const started = Date.now();
    const failing = run(["cat", "/dev/zero"], {
      onStdout: () => {
        throw new Error("壊れた");
      },
    });
    await expect(failing).rejects.toThrow("壊れた");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("run の標準エラーを 1 行ずつ受ける (onStderrLine)", () => {
  test("行ごとに渡し、返る stderr は末尾の数行だけ", async () => {
    const seen: string[] = [];
    const { code, stderr } = await run(
      ["sh", "-c", 'for i in $(seq 1 100); do echo "line $i" >&2; done'],
      {
        onStderrLine: (line) => seen.push(line),
      },
    );
    expect(code).toBe(0);
    expect(seen).toHaveLength(100);
    expect(seen[0]).toBe("line 1");
    expect(stderr.split("\n").at(-1)).toBe("line 100");
    expect(stderr.split("\n").length).toBeLessThan(100);
  });
});

/**
 * 録ったあとのエンコード・CM 検出はいちばん低い優先度で走らせ、ライブに CPU を譲る
 * (`lowerPriority`。非力な機材でライブのコマが落ちていた)
 */
describe("優先度を下げる", () => {
  test("起こしたプロセスを nice 19 にする", () => {
    const calls: [number, number][] = [];
    lowerPriority(4242, (pid, priority) => calls.push([pid, priority]));
    expect(calls).toEqual([[4242, 19]]);
  });

  test("下げられなくても投げない (いつもの優先度で続ける)", () => {
    expect(() =>
      lowerPriority(4242, () => {
        throw new Error("EACCES");
      }),
    ).not.toThrow();
    // もう終わっていた (ESRCH) ときも投げない
    expect(() =>
      lowerPriority(4242, () => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }),
    ).not.toThrow();
  });

  test("lowPriority で起こすと、動いているうちに 19 になっている", async () => {
    // 下げるのは起こした直後なので、少し待ってから自分の nice を読む
    const { code, stdout } = await run(["sh", "-c", "sleep 0.1; nice"], {
      stdout: true,
      lowPriority: true,
    });
    expect(code).toBe(0);
    expect(new TextDecoder().decode(stdout).trim()).toBe("19");
  });
});

/**
 * **途中で抜けたら読み元を cancel する** (`chunks`)。手放すだけだと、追っかけの `followFile` が
 * 誰も読まないファイルを録画が終わるまで読み足し続けていた
 */
describe("chunks", () => {
  /** 読まれるたびに 1 塊出し続ける読み元と、cancel されたか */
  const endless = () => {
    const seen = { canceled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        seen.canceled = true;
      },
    });
    return { stream, seen };
  };

  test("break で抜けたら読み元を cancel する", async () => {
    const { stream, seen } = endless();
    for await (const _ of chunks(stream)) break;
    await Bun.sleep(0);
    expect(seen.canceled).toBe(true);
  });

  test("中で投げて抜けても cancel する", async () => {
    const { stream, seen } = endless();
    const read = async () => {
      for await (const _ of chunks(stream)) throw new Error("受け手の失敗");
    };
    await expect(read()).rejects.toThrow("受け手の失敗");
    await Bun.sleep(0);
    expect(seen.canceled).toBe(true);
  });

  test("読み切ったら cancel しない", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.enqueue(new Uint8Array([2]));
        controller.close();
      },
      cancel() {
        canceled = true;
      },
    });
    const got: number[] = [];
    for await (const chunk of chunks(stream)) got.push(...chunk);
    expect(got).toEqual([1, 2]);
    expect(canceled).toBe(false);
  });

  test("読み元の失敗はそのまま投げる", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("切れた"));
      },
    });
    const read = async () => {
      for await (const _ of chunks(stream)) {
        // 届かない
      }
    };
    await expect(read()).rejects.toThrow("切れた");
  });
});
