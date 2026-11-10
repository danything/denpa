/**
 * 番組表のマスを置く行 (`guide/+page.svelte` の `.program`)。
 *
 * 行は 5 分のマスに合わせ、始まりも終わりも近いほうの 5 分に丸めて置く。表の先頭と末尾で切る。
 * 始まりを切り捨て、終わりを切り上げていた頃は、5 分刻みでない時刻 (15:07 など) で切り替わる 2 つの番組が
 * 同じ 5 分の行に入り、後ろのマスが前のマスの下の端を覆っていた (#2488)。同じ向きに丸めれば、切り替わりはどちらも同じ境目になる。
 * 5 分より短い番組が続くと丸めても重なるので、同じ列では前のマスの下端より上から始めない (`placeRows`)。
 *
 * 過ぎた所を暗くする覆いは、この上端 (`from`) と下端 (`to`) を基準に高さを出す。
 * 実際の始まりと終わりで割合を出してマスの高さに掛けると、5 分刻みでない番組だけ境目がいまの位置からずれた (#2387)。
 * 終わったかどうか (覆いの濃さ) は実際の終わり (`end`) で決める。マスの下端で決めると、20:54 に終わった番組が 20:55 まで放送中の濃さのままになる
 */
export interface CellRows {
  /** マスの上端。表の先頭から何マス目か */
  from: number;
  /** マスの下端。`from` より 1 マス以上下 */
  to: number;
  /** 実際の終わり。表の先頭から何マスぶんか (端数つき。表の外にも出る) */
  end: number;
}

/**
 * 1 つのマスの行。
 *
 * @param top 同じ列の前のマスの下端。これより上からは始めない
 */
export function cellRows(
  startAt: number,
  endAt: number,
  tableStart: number,
  slots: number,
  slot: number,
  top = 0,
): CellRows {
  // 表の末尾より下には置かない (前のマスに押されても、最後の 1 マスに収める)
  const from = Math.min(
    slots - 1,
    Math.max(0, top, Math.round((startAt - tableStart) / slot)),
  );
  const to = Math.max(
    from + 1,
    Math.min(slots, Math.round((endAt - tableStart) / slot)),
  );
  return { from, to, end: (endAt - tableStart) / slot };
}

/** 番組表の 1 つのマス。`column` から右へ `span` 列にまたがる */
export interface PlacedProgram {
  key: string;
  column: number;
  span: number;
  start_at: number;
  end_at: number;
}

/**
 * 表のすべてのマスの行。列ごとに始まりの早い順に置き、またがる列のうち一番下の下端より上からは始めない。
 * 描いている途中 (先頭から少しずつ描く) でも位置が変わらないよう、描く前に全部のマスで出す
 */
export function placeRows(
  cells: readonly PlacedProgram[],
  tableStart: number,
  slots: number,
  slot: number,
): Map<string, CellRows> {
  const order = [...cells].sort(
    (a, b) => a.start_at - b.start_at || a.end_at - b.end_at,
  );
  const bottom: number[] = [];
  const rows = new Map<string, CellRows>();
  for (const cell of order) {
    let top = 0;
    for (let c = cell.column; c < cell.column + cell.span; c++)
      top = Math.max(top, bottom[c] ?? 0);
    const row = cellRows(
      cell.start_at,
      cell.end_at,
      tableStart,
      slots,
      slot,
      top,
    );
    for (let c = cell.column; c < cell.column + cell.span; c++)
      bottom[c] = row.to;
    rows.set(cell.key, row);
  }
  return rows;
}
