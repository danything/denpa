import { stateLabel } from "./format.js";

/** 録画ボタンの結果の通知 (`Toasts.svelte` の `Notice` と同じ形) */
export interface RecordNotice {
  key: string;
  kind: "info" | "warning";
  text: string;
}

/**
 * ライブの録画ボタンの結果の文 (`?/record`。`recordAiring` の `state`・`reason`)。
 * 予約は残っても、競合 (チューナーが足りない) とコピー禁止では録らないので、
 * 「始めます」とは言わずに理由 (`conflict_reason`) を添えて注意で出す
 */
export function recordNotice(
  name: string,
  state: string,
  reason: string | null,
): RecordNotice {
  const key = `record-${name}-${state}`;
  const why = reason === null ? "" : `。${reason}`;
  if (state === "scheduled")
    return { key, kind: "info", text: `「${name}」の録画を始めます` };
  if (state === "recording")
    return { key, kind: "info", text: `「${name}」は録画中です` };
  if (state === "conflict")
    return {
      key,
      kind: "warning",
      text: `「${name}」を予約しましたが、競合のため録画できません${why}`,
    };
  if (state === "skipped")
    return { key, kind: "warning", text: `「${name}」は録画しません${why}` };
  return {
    key,
    kind: "info",
    text: `「${name}」の予約は「${stateLabel(state)}」です`,
  };
}
