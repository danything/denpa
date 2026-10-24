import { describe, expect, test } from "bun:test";

import {
  resultsHref,
  suggestGroups,
  type SuggestResponse,
} from "./search-suggest";

const empty = { more: false, rows: [] };

function response(fields: Partial<SuggestResponse>): SuggestResponse {
  return {
    q: "でんぱ",
    programs: empty,
    recordings: empty,
    reservations: empty,
    rules: empty,
    ...fields,
  };
}

describe("ヘッダーの欄の候補", () => {
  test("行の無い節は出さない", () => {
    expect(suggestGroups(response({}))).toEqual([]);
    const groups = suggestGroups(
      response({
        rules: {
          more: false,
          rows: [{ id: 3, name: "でんぱ枠", enabled: false }],
        },
      }),
    );
    expect(groups.map((group) => group.title)).toEqual(["ルール"]);
    expect(groups[0]?.items[0]).toMatchObject({
      href: "search?rule=3",
      hint: "編集",
      meta: "無効",
    });
  });

  test("番組は結果の画面で詳細を開き、録画は観る画面へ", () => {
    const [programs, recordings] = suggestGroups(
      response({
        programs: {
          more: true,
          rows: [
            {
              id: 7,
              name: "でんぱ劇場",
              service_name: "局",
              start_at: 0,
              end_at: 1,
              reservation_state: null,
            },
          ],
        },
        recordings: {
          more: false,
          rows: [
            {
              id: 1,
              name: "A",
              service_name: "局",
              start_at: 0,
              state: "available",
              watch: "watch/1",
            },
            {
              id: 2,
              name: "B",
              service_name: "局",
              start_at: 0,
              state: "recording",
              watch: "chase/2",
            },
            {
              id: 3,
              name: "C",
              service_name: "局",
              start_at: 0,
              state: "failed",
              watch: null,
            },
          ],
        },
      }),
    );
    expect(programs?.items[0]?.href).toBe(
      "search?q=%E3%81%A7%E3%82%93%E3%81%B1&program=7",
    );
    expect(recordings?.items.map((item) => [item.href, item.hint])).toEqual([
      ["watch/1", "再生"],
      ["chase/2", "追っかけ再生"],
      ["search?q=%E3%81%A7%E3%82%93%E3%81%B1", "結果を見る"],
    ]);
  });

  test("予約は録っている最中なら追っかけ再生、まだなら詳細", () => {
    const [reservations] = suggestGroups(
      response({
        reservations: {
          more: false,
          rows: [
            {
              id: 1,
              program_id: 10,
              name: "A",
              service_name: "局",
              start_at: 0,
              end_at: 1,
              state: "scheduled",
              chase: null,
            },
            {
              id: 2,
              program_id: 11,
              name: "B",
              service_name: "局",
              start_at: 0,
              end_at: 1,
              state: "recording",
              chase: "chase/5",
            },
          ],
        },
      }),
    );
    expect(reservations?.items.map((item) => item.href)).toEqual([
      resultsHref("でんぱ", 10),
      "chase/5",
    ]);
  });
});
