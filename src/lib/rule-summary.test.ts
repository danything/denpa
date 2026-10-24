import { describe, expect, test } from "bun:test";

import { conditionSummary, upcomingLabel } from "./rule-summary";

describe("ルールの条件を1行で", () => {
  const base = {
    search_fields: "name",
    service_ids: null,
    service_types: null,
    genres: null,
    time_from: null,
    time_to: null,
    weekdays: null,
    dedupe: false,
    skip_earlier: false,
    ignore_keyword: "",
  };
  const names = new Map([
    [1, "TOKYO MX"],
    [2, "BS11"],
    [3, "BSテレ東"],
  ]);
  const name = (id: number) => names.get(id);

  test("探す所と全局だけ", () => {
    expect(conditionSummary(base, name)).toBe("番組名 ・ 全局");
  });
  test("同じ回・前の回・除外・概要まで", () => {
    expect(
      conditionSummary(
        {
          ...base,
          search_fields: "name,description",
          dedupe: true,
          skip_earlier: true,
          ignore_keyword: " 再放送 ",
        },
        name,
      ),
    ).toBe(
      "番組名・概要 ・ 全局 ・ 同じ回は1度 ・ 前の回は録らない ・ 除外: 再放送",
    );
  });
  test("局は2つまで名前、それより多いと数", () => {
    expect(conditionSummary({ ...base, service_ids: [2] }, name)).toBe(
      "番組名 ・ BS11",
    );
    expect(
      conditionSummary(
        { ...base, service_types: ["GR"], service_ids: [2, 3, 9] },
        name,
      ),
    ).toBe("番組名 ・ 地上波・BS11 ほか 2 局");
  });
  test("ジャンルを選んでいれば名前", () => {
    expect(conditionSummary({ ...base, genres: ["7"] }, name)).toContain(
      "アニメ／特撮",
    );
  });
  test("時間帯と曜日はジャンルの後ろ。続く曜日はまとめる", () => {
    expect(
      conditionSummary(
        { ...base, time_from: 19 * 60, time_to: 20 * 60, weekdays: [5] },
        name,
      ),
    ).toBe("番組名 ・ 全局 ・ 金 19:00〜20:00");
    expect(
      conditionSummary(
        {
          ...base,
          time_from: 23 * 60,
          time_to: 2 * 60,
          weekdays: [1, 2, 3, 4, 5],
        },
        name,
      ),
    ).toBe("番組名 ・ 全局 ・ 月〜金 23:00〜02:00");
    expect(conditionSummary({ ...base, weekdays: [6, 0] }, name)).toBe(
      "番組名 ・ 全局 ・ 土・日",
    );
  });
});

describe("次の放送の日時", () => {
  const now = new Date(2026, 9, 19, 12, 0).getTime();
  test("今日・明日は言葉で、その先は月/日", () => {
    expect(upcomingLabel(new Date(2026, 9, 19, 23, 30).getTime(), now)).toBe(
      "今日 23:30",
    );
    expect(upcomingLabel(new Date(2026, 9, 20, 1, 5).getTime(), now)).toBe(
      "明日 01:05",
    );
    expect(upcomingLabel(new Date(2026, 9, 26, 9, 0).getTime(), now)).toBe(
      "10/26 09:00",
    );
  });
});
