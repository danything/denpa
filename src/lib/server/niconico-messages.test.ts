import { describe, expect, test } from "bun:test";

import { Delimited, readEntry, readMessage } from "./niconico-messages";

/*
 * メッセージサーバの返事 (protobuf) を読む。返事はここで組む (本物のサーバには繋がない)
 */

/** varint */
function v(n: number): number[] {
  const out: number[] = [];
  let rest = n;
  while (rest >= 128) {
    out.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}
const utf8 = new TextEncoder();
/** varint のフィールド */
function vf(no: number, n: number): number[] {
  return [...v(no * 8), ...v(n)];
}
/** 長さ付きのフィールド */
function bf(no: number, body: number[] | string): number[] {
  const bytes = typeof body === "string" ? [...utf8.encode(body)] : body;
  return [...v(no * 8 + 2), ...v(bytes.length), ...bytes];
}
/** 長さ付きの並びの 1 つ */
function delimited(body: number[]): number[] {
  return [...v(body.length), ...body];
}

const AT = Date.UTC(2026, 10, 28, 12, 0, 0);

function chatMessage(
  opts: {
    id?: string;
    text?: string;
    modifier?: number[];
    hashed?: string;
    raw?: number;
    overflowed?: boolean;
  } = {},
): number[] {
  const chat = [
    ...bf(1, opts.text ?? "こんにちは"),
    ...vf(3, 1234),
    ...bf(2, "名前"),
    ...(opts.raw === undefined ? [] : vf(5, opts.raw)),
    ...(opts.hashed === undefined ? [] : bf(6, opts.hashed)),
    ...(opts.modifier === undefined ? [] : bf(7, opts.modifier)),
    ...vf(8, 99),
  ];
  const meta = [
    ...bf(1, opts.id ?? "m1"),
    ...bf(2, [...vf(1, AT / 1000), ...vf(2, 250_000_000)]),
  ];
  return [
    ...bf(1, meta),
    ...bf(2, bf(opts.overflowed === true ? 20 : 1, chat)),
  ];
}

const nobody = null;

describe("長さ付きの並び", () => {
  test("途中で切れたものは次に届くまで持ち、そろったものから返す", () => {
    const one = delimited([1, 2, 3]);
    const two = delimited(Array.from({ length: 200 }, (_, i) => i % 256));
    const all = new Uint8Array([...one, ...two]);
    const d = new Delimited();
    expect(d.push(all.subarray(0, 5))).toEqual([new Uint8Array([1, 2, 3])]);
    expect(d.push(all.subarray(5, 6))).toEqual([]);
    const rest = d.push(all.subarray(6));
    expect(rest).toHaveLength(1);
    expect(rest[0]!.length).toBe(200);
  });
});

describe("view", () => {
  test("segment は URI、next は時刻。ほかは null", () => {
    const segment = bf(1, [
      ...bf(1, [...vf(1, 100)]),
      ...bf(2, [...vf(1, 116)]),
      ...bf(3, "https://mpn.example/data/segment/v4/abc"),
    ]);
    expect(readEntry(new Uint8Array(segment))).toEqual({
      segment: "https://mpn.example/data/segment/v4/abc",
      until: 116_000,
    });
    expect(readEntry(new Uint8Array(bf(4, vf(1, 1_764_331_200))))).toEqual({
      next: 1_764_331_200,
    });
    expect(readEntry(new Uint8Array(bf(2, [])))).toBeNull();
  });
});

describe("コメント", () => {
  test("ID・投稿時刻・本文を読み、投稿者の ID や名前は返さない", () => {
    const got = readMessage(new Uint8Array(chatMessage()), nobody);
    expect(got).toEqual({
      id: "m1",
      at: AT + 250,
      text: "こんにちは",
      mail: "",
      own: false,
    });
  });

  test("修飾は mail のコマンドに組む (位置・大きさ・名前の色・RGB)", () => {
    const named = chatMessage({
      modifier: [...vf(1, 2), ...vf(2, 2), ...vf(3, 1)],
    });
    expect(readMessage(new Uint8Array(named), nobody)?.mail).toBe("ue big red");
    const full = chatMessage({
      modifier: [
        ...vf(1, 1),
        ...bf(4, [...vf(1, 255), ...vf(2, 0), ...vf(3, 16)]),
      ],
    });
    expect(readMessage(new Uint8Array(full), nobody)?.mail).toBe(
      "shita medium #ff0010",
    );
    const plain = chatMessage({ modifier: [] });
    expect(readMessage(new Uint8Array(plain), nobody)?.mail).toBe(
      "naka medium white",
    );
  });

  test("あふれたコメントも読む", () => {
    const got = readMessage(
      new Uint8Array(chatMessage({ overflowed: true })),
      nobody,
    );
    expect(got?.text).toBe("こんにちは");
  });

  test("自分の書き込みは hashedUserId で見分ける", () => {
    const self = "a:own";
    expect(
      readMessage(new Uint8Array(chatMessage({ hashed: "a:own" })), self)?.own,
    ).toBe(true);
    expect(
      readMessage(new Uint8Array(chatMessage({ raw: 12345678 })), self)?.own,
    ).toBe(false);
    expect(
      readMessage(new Uint8Array(chatMessage({ hashed: "a:other" })), self)
        ?.own,
    ).toBe(false);
  });

  test("コメントでないもの (状態付きメッセージ・合図) は null", () => {
    const state = [...bf(1, bf(1, "s1")), ...bf(4, [])];
    expect(readMessage(new Uint8Array(state), nobody)).toBeNull();
    const signal = vf(5, 0);
    expect(readMessage(new Uint8Array(signal), nobody)).toBeNull();
    // 通知 (simple_notification) はコメントではない
    const notice = [
      ...bf(1, [...bf(1, "n1"), ...bf(2, vf(1, 1))]),
      ...bf(2, bf(7, bf(7, "来場者"))),
    ];
    expect(readMessage(new Uint8Array(notice), nobody)).toBeNull();
  });

  test("知らないフィールド (固定長を含む) は読み飛ばす。壊れていたら投げる", () => {
    const extra = [...chatMessage(), ...[(9 << 3) | 5, 1, 2, 3, 4]];
    expect(readMessage(new Uint8Array(extra), nobody)?.id).toBe("m1");
    expect(() =>
      readMessage(new Uint8Array([0x0a, 0x05, 1]), nobody),
    ).toThrow();
  });
});
