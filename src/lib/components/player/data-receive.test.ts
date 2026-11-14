import { describe, expect, test } from "bun:test";

import {
  closesData,
  closingOnTune,
  dataReceiveNote,
  storedDataReceive,
  tunedCloses,
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
    const now = {
      open: false,
      auto: true,
      tuned: true,
      autoStart: true,
      switching: false,
    };
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

  test("別の局への選局の答えを待っている間は、開いていてもサーバへリクエストしない", () => {
    const now = {
      open: true,
      auto: true,
      tuned: true,
      autoStart: true,
      switching: true,
    };
    expect(wantsData(now)).toBe(false);
    expect(wantsData({ ...now, switching: false })).toBe(true);
  });

  test("別の局を選んだら、その局の答えが届くまで閉じない", () => {
    // 1 を映していて 2 を選んだ。2 の答えを待つ
    const closing = closingOnTune(1, 2);
    expect(closing).toBe(2);
    expect(tunedCloses(closing, 2)).toBe(true);
    // 同じ局の選び直し・初めての選局では待たない (答えが届いても閉じない)
    expect(closingOnTune(1, 1)).toBeNull();
    expect(closingOnTune(null, 1)).toBeNull();
    expect(tunedCloses(closingOnTune(1, 1), 1)).toBe(false);
    expect(tunedCloses(closingOnTune(null, 1), 1)).toBe(false);
  });

  test("サーバが選局を断ったら (答えが来ない)、データ放送は前の局のまま", () => {
    // 1 から 2 を選び、2 は断られた。画面は待つのをやめ (`fail`)、映しているのは 1 のまま
    const onAir = 1;
    expect(closingOnTune(onAir, 2)).toBe(2);
    // 1 に選び直すと、閉じる局は無い
    expect(closingOnTune(onAir, 1)).toBeNull();
    // 2 をもう一度選ぶと、また 2 の答えを待つ
    expect(closingOnTune(onAir, 2)).toBe(2);
  });

  test("続けて選び直したとき、前の指示の答えが遅れて届いても閉じない", () => {
    // 1 から 2、すぐに 3 を選んだ。2 の答えは待っている局のものではない
    const closing = closingOnTune(1, 3);
    expect(tunedCloses(closing, 2)).toBe(false);
    expect(tunedCloses(closing, 3)).toBe(true);
    // 待っていない (追っかけに移った・d を押した) なら閉じない
    expect(tunedCloses(null, 3)).toBe(false);
  });
});
