import { describe, expect, test } from "bun:test";

import {
  DATA_LOAD_FAILED,
  dataNote,
  type DataNoteState,
  loadEngine,
} from "./data-load";

describe("データ放送のエンジンの読み込み (loadEngine)", () => {
  test("読み込めたらその中身を返す", async () => {
    const warned: string[] = [];
    expect(
      await loadEngine(
        async () => ({ createBml: 1 }),
        (line) => warned.push(line),
      ),
    ).toEqual({ createBml: 1 });
    expect(warned).toEqual([]);
  });

  test("読み込めなければ null を返し、理由をコンソールに出す (投げたままにしない)", async () => {
    const warned: string[] = [];
    expect(
      await loadEngine(
        () => Promise.reject(new TypeError("Failed to fetch")),
        (line) => warned.push(line),
      ),
    ).toBeNull();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("Failed to fetch");
  });
});

describe("映像の上に出す通知 (dataNote)", () => {
  const base: DataNoteState = {
    on: true,
    app: null,
    failed: false,
    loading: false,
    receiving: false,
  };

  test("読み込み中と電波から取っている間は「データ取得中…」", () => {
    expect(dataNote({ ...base, loading: true })).toBe("データ取得中…");
    expect(dataNote({ ...base, receiving: true })).toBe("データ取得中…");
    expect(dataNote(base)).toBe("");
  });

  test("エンジンを読み込めなかったら「データ取得中…」を下ろし、読み込めなかったと出す", () => {
    expect(dataNote({ ...base, failed: true })).toBe(DATA_LOAD_FAILED);
  });

  test("開いていなければ何も出さない。Hybridcast のアプリを開いていればその通知", () => {
    expect(dataNote({ ...base, on: false, failed: true })).toBe("");
    expect(dataNote({ ...base, app: "", loading: true })).toBe("");
  });
});
