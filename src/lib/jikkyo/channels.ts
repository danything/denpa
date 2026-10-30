/**
 * **局と実況のチャンネル (`jk1` など) の対応表。** NX-Jikkyo の 35 チャンネルに当て、ほかの局はコメントなし (null)。
 *
 * サーバ (局の一覧の `jikkyo`・勢いの中継) と単体テストが読む。画面は表を読まず、局の一覧の `jikkyo` を使う。
 *
 * どれも**局の番号 (service_id) で引く。**
 *
 * - **BS・CS** は全国どこでも同じ番号なので、ここに並べた (サブチャンネルも本チャンネルと同じチャンネル)。
 *   4K の局は受けられないので載せない
 * - **地上波**は KonomiTV の表を写したもの (`terrestrial.ts`)。系列の地方局はキー局のチャンネルに当たる
 *   (例: 毎日放送 → jk6)。地方局が独自の番組を流している間もキー局のコメントが流れる (見分けられないので、そのまま)。
 *   表には本チャンネルしか無いので、1 つ前・2 つ前の番号も見てサブチャンネルを本チャンネルに当てる
 *   (地上波のサブチャンネルはせいぜい 3 つで、別の局と番号が隣り合わないように振られている)
 */
import { TERRESTRIAL } from "./terrestrial";

/** BS の局の番号 → チャンネル。サブチャンネルも本チャンネルと同じ */
const BS: ReadonlyMap<number, string> = new Map([
  [101, "jk101"],
  [102, "jk101"],
  ...[141, 142, 143].map((id) => [id, "jk141"] as const),
  ...[151, 152, 153].map((id) => [id, "jk151"] as const),
  ...[161, 162, 163].map((id) => [id, "jk161"] as const),
  ...[171, 172, 173].map((id) => [id, "jk171"] as const),
  ...[181, 182, 183].map((id) => [id, "jk181"] as const),
  [191, "jk191"],
  [192, "jk192"],
  [193, "jk193"],
  [200, "jk200"],
  [201, "jk201"],
  [202, "jk201"],
  [211, "jk211"],
  [222, "jk222"],
  [236, "jk236"],
  [252, "jk252"],
  [260, "jk260"],
  [265, "jk265"],
]);

/** CS の局の番号 → チャンネル */
const CS: ReadonlyMap<number, string> = new Map([[333, "jk333"]]);

/** 局から引くのに要る列 (`services` の行) */
export interface JikkyoStation {
  type: string;
  service_id: number;
}

/** その局の実況のチャンネル (`jk1` など)。コメントの無い局は null */
export function jikkyoChannel(station: JikkyoStation): string | null {
  if (station.type === "BS") return BS.get(station.service_id) ?? null;
  if (station.type === "CS") return CS.get(station.service_id) ?? null;
  if (station.type !== "GR") return null;
  for (const id of [
    station.service_id,
    station.service_id - 1,
    station.service_id - 2,
  ]) {
    const jk = TERRESTRIAL.get(id);
    if (jk !== undefined) return `jk${jk}`;
  }
  return null;
}
