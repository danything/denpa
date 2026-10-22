import { dateTime, stateLabel } from "./format";

/**
 * **ヘッダーの欄の候補** (`SearchField`)。`/api/search` の答えを、節ごとの候補の並びにする。
 * 候補を選んだときの行き先 (`href`。denpa の根からの相対) もここで決める:
 *
 * - 番組 … 結果の画面でその番組の詳細を開く (`search?q=…&program=<id>`。番組表には番組を名指しで開く URL が無い)
 * - 録画 … 観る画面 (録っている最中は追っかけ再生)。観られないものは結果の画面
 * - 予約 … 録っている最中なら追っかけ再生、まだなら番組と同じく詳細
 * - ルール … そのルールの編集
 */

export interface SuggestResponse {
  q: string;
  programs: {
    more: boolean;
    rows: {
      id: number;
      name: string;
      service_name: string;
      start_at: number;
      end_at: number;
      reservation_state: string | null;
    }[];
  };
  recordings: {
    more: boolean;
    rows: {
      id: number;
      name: string;
      service_name: string;
      start_at: number;
      state: string;
      watch: string | null;
    }[];
  };
  reservations: {
    more: boolean;
    rows: {
      id: number;
      program_id: number;
      name: string;
      service_name: string;
      start_at: number;
      end_at: number;
      state: string;
      chase: string | null;
    }[];
  };
  rules: {
    more: boolean;
    rows: { id: number; name: string; enabled: boolean }[];
  };
}

export interface Suggestion {
  /** 画面の中で1つだけの鍵。候補の id (`aria-activedescendant`) にも使う */
  key: string;
  label: string;
  /** 名前の下の小さな字 (局・時刻・状態) */
  meta: string;
  /** 選ぶと何が起きるか (右に小さく) */
  hint: string;
  href: string;
  /** 番組名・局名は放送から来た字 */
  broadcast: boolean;
}

export interface SuggestGroup {
  key: "programs" | "recordings" | "reservations" | "rules";
  title: string;
  items: Suggestion[];
}

/** 結果の画面の URL (相対)。言葉と、開いておく番組 */
export function resultsHref(q: string, program?: number): string {
  const params = new URLSearchParams({ q });
  if (program !== undefined) params.set("program", String(program));
  return `search?${params}`;
}

/** 候補の節。行の無い節は出さない */
export function suggestGroups(res: SuggestResponse): SuggestGroup[] {
  const q = res.q;
  const groups: SuggestGroup[] = [
    {
      key: "programs",
      title: "これからの放送",
      items: res.programs.rows.map((p) => ({
        key: `program-${p.id}`,
        label: p.name,
        meta: [
          p.service_name,
          dateTime(p.start_at),
          p.reservation_state && stateLabel(p.reservation_state),
        ]
          .filter(Boolean)
          .join(" ・ "),
        hint: "詳細",
        href: resultsHref(q, p.id),
        broadcast: true,
      })),
    },
    {
      key: "recordings",
      title: "録画",
      items: res.recordings.rows.map((r) => ({
        key: `recording-${r.id}`,
        label: r.name,
        meta: [r.service_name, dateTime(r.start_at)].join(" ・ "),
        hint:
          r.watch === null
            ? "結果を見る"
            : r.watch.startsWith("chase/")
              ? "追っかけ再生"
              : "再生",
        href: r.watch ?? resultsHref(q),
        broadcast: true,
      })),
    },
    {
      key: "reservations",
      title: "予約",
      items: res.reservations.rows.map((r) => ({
        key: `reservation-${r.id}`,
        label: r.name,
        meta: [r.service_name, dateTime(r.start_at), stateLabel(r.state)].join(
          " ・ ",
        ),
        hint: r.chase === null ? "詳細" : "追っかけ再生",
        href: r.chase ?? resultsHref(q, r.program_id),
        broadcast: true,
      })),
    },
    {
      key: "rules",
      title: "ルール",
      items: res.rules.rows.map((r) => ({
        key: `rule-${r.id}`,
        label: r.name,
        meta: r.enabled ? "" : "無効",
        hint: "編集",
        href: `search?rule=${r.id}`,
        broadcast: false,
      })),
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}
