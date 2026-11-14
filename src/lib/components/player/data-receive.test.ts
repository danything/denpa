import { describe, expect, test } from "bun:test";

import {
  closesData,
  dataReceiveNote,
  storedDataReceive,
  wantsData,
} from "./data-receive";

describe("データ放送を自動で受信するか", () => {
  test("オンにしたことのある端末だけオンで始まる (「常に受信」だった頃の値もそのまま読む)", () => {
    expect(storedDataReceive(null)).toBe(false);
    expect(storedDataReceive("0")).toBe(false);
    expect(storedDataReceive("1")).toBe(true);
  });

  test("切り替えたら今の状態を知らせる", () => {
    expect(dataReceiveNote(true)).toBe("データ放送を自動で受信します");
    expect(dataReceiveNote(false)).toBe("データ放送を自動で受信しません");
  });

  test("開いているか、自動で受信していて自動起動の指定のある局を映しているときにサーバへリクエストする", () => {
    const now = { open: false, auto: true, tuned: true, autoStart: true };
    expect(wantsData(now)).toBe(true);
    // 指定の無い局は、自動で受信していても d を押すまでリクエストしない
    expect(wantsData({ ...now, autoStart: false })).toBe(false);
    expect(wantsData({ ...now, autoStart: false, open: true })).toBe(true);
    // オフなら指定があってもリクエストしない
    expect(wantsData({ ...now, auto: false })).toBe(false);
    expect(wantsData({ ...now, auto: false, open: true })).toBe(true);
    // 追っかけ・録画に譲っている間は、自動で受信でもリクエストしない (開いていれば今までどおり)
    expect(wantsData({ ...now, tuned: false })).toBe(false);
    expect(wantsData({ ...now, tuned: false, open: true })).toBe(true);
  });

  test("別の局へ移ったら、開いたデータ放送を閉じる (次の局に d を届けない)", () => {
    expect(closesData(1, 2)).toBe(true);
    // 同じ局のリクエストし直し・初めての選局では閉じない
    expect(closesData(1, 1)).toBe(false);
    expect(closesData(null, 1)).toBe(false);
  });
});
