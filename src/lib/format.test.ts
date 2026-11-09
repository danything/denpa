import { describe, expect, test } from "bun:test";

import {
  byteScale,
  capacityLabel,
  clipNote,
  clock,
  duration,
  durationMs,
  encodeDetail,
  eta,
  fullDate,
  nowStatus,
  percent,
  recordedDuration,
  recordingLeft,
  signalText,
  splitReaderName,
  videoLossNote,
} from "./format";

const MIN = 60_000;

describe("長さの表示", () => {
  test("1時間未満は分だけ", () => {
    expect(durationMs(25 * MIN)).toBe("25 分");
  });

  test("端数が無ければ時間だけ", () => {
    // 「2 時間 0 分」は読みにくい
    expect(durationMs(120 * MIN)).toBe("2 時間");
  });

  test("端数があれば時間と分", () => {
    expect(durationMs(95 * MIN)).toBe("1 時間 35 分");
  });

  test("放送日時からも出せる", () => {
    expect(duration(0, 30 * MIN)).toBe("30 分");
  });
});

describe("再生位置の表示", () => {
  test("分と秒。秒は2桁に揃える", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(9)).toBe("0:09");
    expect(clock(754)).toBe("12:34");
  });

  /** 短いものに「0:12:34」と出ると、位を数えないと読めない */
  test("1時間を超えたときだけ時間を出す", () => {
    expect(clock(3599)).toBe("59:59");
    expect(clock(3723)).toBe("1:02:03");
  });

  /** 尺が読めるまで duration は NaN。押した拍子に負になることもある */
  test("読めない値でも 0:00 を返す", () => {
    expect(clock(Number.NaN)).toBe("0:00");
    expect(clock(-5)).toBe("0:00");
    expect(clock(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});

describe("録画の長さ", () => {
  // 番組表の尺は 30 分
  const scheduled = { start_at: 0, end_at: 30 * MIN };

  test("実際に録れた長さがあればそちらを出す", () => {
    // 途中で止めたので 12 分しか録れていない
    expect(recordedDuration({ ...scheduled, duration_ms: 12 * MIN })).toBe(
      "12 分",
    );
  });

  test("取れていない古い行は番組表の尺で代用する", () => {
    expect(recordedDuration({ ...scheduled, duration_ms: null })).toBe("30 分");
  });

  test("0 は取れていないものとして扱う", () => {
    // 1 バイトも受信できずに失敗した行が「0 分」になると、
    // 長さが取れていないのか本当に 0 なのか見分けられない
    expect(recordedDuration({ ...scheduled, duration_ms: 0 })).toBe("30 分");
  });
});

/*
 * エンコードの進み具合。**細かく出す。**
 *
 * 整数の % と分どまりの残り時間では、1 時間かかるエンコードで数字が
 * 30 秒以上動かない。止まったのか進んでいるのか画面から判らなかった
 */
describe("進み具合", () => {
  test("小数第1位まで出す", () => {
    expect(percent(0)).toBe("0.0%");
    expect(percent(0.1234)).toBe("12.3%");
    expect(percent(1)).toBe("100.0%");
  });

  test("範囲の外は詰める", () => {
    // 見積もりの総コマ数を超えると 1 を跨ぐことがある
    expect(percent(1.4)).toBe("100.0%");
    expect(percent(-0.2)).toBe("0.0%");
  });
});

describe("残り時間の見込み", () => {
  test("1分未満は秒だけ", () => {
    expect(eta(45_000)).toBe("あと 45 秒");
    expect(eta(1_000)).toBe("あと 1 秒");
  });

  test("1時間未満は分と秒", () => {
    expect(eta(12 * MIN + 34_000)).toBe("あと 12 分 34 秒");
    // 秒が 1 桁でも桁を揃える (数字の位置が動くと読みにくい)
    expect(eta(2 * MIN + 5_000)).toBe("あと 2 分 05 秒");
  });

  test("1時間以上は時間・分・秒", () => {
    expect(eta(3600_000 + 2 * MIN + 3_000)).toBe("あと 1 時間 02 分 03 秒");
  });

  test("見込みが立たないうちは何も出さない", () => {
    expect(eta(null)).toBe("");
    expect(eta(0)).toBe("");
    expect(eta(Number.NaN)).toBe("");
  });
});

describe("エンコードの進み", () => {
  const stored = { job_percent: 0.2, job_eta_ms: 5 * MIN };

  test("届いた進みが無ければ DB の値", () => {
    expect(encodeDetail(undefined, stored)).toBe("20.0%・あと 5 分 00 秒");
  });

  test("届いた進みがあれば、そちらの残り時間", () => {
    expect(encodeDetail({ percent: 0.45, etaMs: 64_000 }, stored)).toBe(
      "45.0%・あと 1 分 04 秒",
    );
  });

  test("届いた残り時間が見積もれない (null) なら、DB の古い値に戻さず出さない", () => {
    expect(encodeDetail({ percent: 0.45, etaMs: null }, stored)).toBe("45.0%");
  });
});

describe("欠けの表示", () => {
  const base = { start_at: 0, end_at: 30 * MIN };

  test("丸ごと録れるなら何も言わない", () => {
    expect(
      clipNote({ ...base, record_from: null, record_to: null }),
    ).toBeNull();
  });

  /*
   * **マージンだけ削られたぶんは言わない。** 隣り合う番組はマージンぶんが
   * 必ず重なるので、そこまで数えるとほとんどの録画にラベルが付く
   */
  test("マージンが削られただけなら言わない", () => {
    expect(
      clipNote({ ...base, record_from: 0, record_to: 30 * MIN }),
    ).toBeNull();
  });

  test("頭を譲ったら、どれだけ欠けるかを言う", () => {
    expect(clipNote({ ...base, record_from: 15 * MIN, record_to: null })).toBe(
      "冒頭 15 分が欠けます (チューナー不足)",
    );
  });

  test("録れたあとは言い方が変わる", () => {
    expect(
      clipNote({ ...base, record_from: 15 * MIN, record_to: null }, true),
    ).toBe("冒頭 15 分が欠けています (チューナー不足)");
  });

  test("両方譲ったら両方言う", () => {
    expect(
      clipNote({ ...base, record_from: 5 * MIN, record_to: 25 * MIN }),
    ).toBe("冒頭 5 分と末尾 5 分が欠けます (チューナー不足)");
  });
});

describe("カードリーダーの名前", () => {
  test("後ろの括弧は挿さっている場所として分ける", () => {
    expect(splitReaderName("Gemplus USB SmartCard Reader (usb 4-11)")).toEqual({
      name: "Gemplus USB SmartCard Reader",
      where: "usb 4-11",
    });
  });

  test("括弧の無い名前はそのまま", () => {
    const name = "px4-userland 0960 Internal Card Reader";
    expect(splitReaderName(name)).toEqual({ name, where: null });
  });
});

describe("進み具合のバーの大きさ", () => {
  test("1GB からは GB で小数1桁、それより小さければ MB", () => {
    const big = byteScale(30 * 1024 ** 3);
    expect(big.unit).toBe("GB");
    expect(big.scaled(1.26 * 1024 ** 3)).toBe(1.3);
    const small = byteScale(512 * 1024 ** 2);
    expect(small.unit).toBe("MB");
    expect(small.scaled(100.4 * 1024 ** 2)).toBe(100);
  });
});

describe("空きと残り時間", () => {
  const GB = 1024 ** 3;
  test("1TB からは TB で、時間は桁で丸める", () => {
    expect(capacityLabel(1.25 * 1024 * GB, 937.4)).toEqual({
      free: "空き 1.3TB",
      hours: "約 930 時間",
    });
    expect(capacityLabel(512.7 * GB, 64.9)).toEqual({
      free: "空き 512GB",
      hours: "約 64 時間",
    });
    expect(capacityLabel(4 * 1024 * GB, 2345)).toEqual({
      free: "空き 4.0TB",
      hours: "約 2300 時間",
    });
  });

  test("目安が無ければ空きだけ、残りわずかはそう言う", () => {
    expect(capacityLabel(300 * GB, null)).toEqual({
      free: "空き 300GB",
      hours: null,
    });
    expect(capacityLabel(0.5 * GB, 0.2)).toEqual({
      free: "空き 1GB 未満",
      hours: "1 時間未満",
    });
  });
});

describe("「いま」の線の一言", () => {
  // 18:01:20。線の時刻は 18:01
  const now = new Date(2026, 9, 19, 18, 1, 20).getTime();
  const at = (h: number, m: number) => new Date(2026, 9, 19, h, m).getTime();

  test("次の録画まで。録画中でも次の予約を言う。分は線の時刻と食い違わないよう切り上げる", () => {
    expect(nowStatus(now, { start_at: at(22, 0) })).toEqual({
      text: "次の録画まで 3 時間 59 分",
      short: "次まで 3:59",
    });
  });

  test("1時間を切ると分だけ", () => {
    expect(nowStatus(now, { start_at: at(18, 13) })).toEqual({
      text: "次の録画まで 12 分",
      short: "次まで 12 分",
    });
  });

  test("ちょうどの時間は時間だけ、狭い形は 0 を埋める", () => {
    expect(nowStatus(at(18, 0), { start_at: at(20, 5) })).toEqual({
      text: "次の録画まで 2 時間 5 分",
      short: "次まで 2:05",
    });
    expect(nowStatus(at(18, 0), { start_at: at(20, 0) })?.text).toBe(
      "次の録画まで 2 時間",
    );
  });

  test("1日より先は日数で", () => {
    expect(nowStatus(now, { start_at: now + 3 * 24 * 60 * MIN })).toEqual({
      text: "次の録画まで 3 日",
      short: "次まで 3 日",
    });
  });

  test("始まる時刻を過ぎていても「0分」とは言わない", () => {
    expect(nowStatus(now, { start_at: now - MIN })?.text).toBe(
      "次の録画まで 1 分",
    );
  });

  test("予約が無ければ何も添えない", () => {
    expect(nowStatus(now, null)).toBeNull();
  });
});

describe("録画中の行のあと何分か", () => {
  const now = new Date(2026, 9, 19, 18, 1, 20).getTime();
  const at = (h: number, m: number) => new Date(2026, 9, 19, h, m).getTime();

  test("分は切り上げ、1時間を越えれば時間も", () => {
    expect(recordingLeft(now, at(18, 22))).toBe("あと 21 分");
    expect(recordingLeft(now, at(19, 30))).toBe("あと 1 時間 29 分");
  });

  test("終わりの時刻を過ぎても止まりきるまでは録画中なので、あと何分かは言わない", () => {
    expect(recordingLeft(now, at(18, 0))).toBeNull();
  });
});

describe("西暦つきの日付", () => {
  // 年をまたいで溜まった録画で、同じ「10/11(日)」を見分けられる (#1931)
  test("年を前に付ける", () => {
    expect(fullDate(new Date(2026, 9, 11, 21, 0).getTime())).toBe(
      "2026/10/11(日)",
    );
    expect(fullDate(new Date(2020, 9, 11, 0, 0).getTime())).toBe(
      "2020/10/11(日)",
    );
    // 月と日は前に 0 を付けない (見出しの「10/11(日)」と同じ形)
    expect(fullDate(new Date(2027, 0, 5, 12, 0).getTime())).toBe(
      "2027/1/5(火)",
    );
  });
});

describe("受信の状態と C/N と強度", () => {
  test("強度は dBm で測れたときだけ、C/N の前に出す", () => {
    expect(
      signalText({
        locked: true,
        cn: 25.3,
        unit: "dB",
        atTune: false,
        strengthDbm: -35,
      }),
    ).toBe("同期しています・強度: -35.0 dBm・C/N: 25.3 dB");
  });

  test("強度の無い古いエージェントの答えは、C/N だけ出す", () => {
    expect(
      signalText({ locked: true, cn: 25.3, unit: "dB", atTune: false }),
    ).toBe("同期しています・C/N: 25.3 dB");
  });

  test("C/N が測れなくても、強度は出す", () => {
    expect(
      signalText({
        locked: false,
        cn: null,
        unit: "dB",
        atTune: false,
        strengthDbm: -80.4,
      }),
    ).toBe("同期していません・強度: -80.4 dBm");
  });
});

describe("映像の欠けの表示", () => {
  test("映像が無いまま録画が終わったら、途中で切れたと言い、残っている長さを添える", () => {
    expect(videoLossNote({ span: 1800, lost: 670, tail: true })).toEqual({
      label: "録画が途中で切れています",
      detail: "30 分のうち 19 分",
    });
  });

  test("途中だけ欠けたなら、欠けたと言う", () => {
    expect(videoLossNote({ span: 1800, lost: 180, tail: false })).toEqual({
      label: "映像が途中で欠けています",
      detail: "30 分のうち 27 分",
    });
  });

  test("1 分に満たない欠けと、測っていない録画は出さない", () => {
    expect(videoLossNote({ span: 1800, lost: 59, tail: true })).toBeNull();
    expect(videoLossNote(null)).toBeNull();
  });
});
