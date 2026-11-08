/**
 * 番組表のマスを置く行 (`guide/+page.svelte` の `.program`)。
 *
 * 行は 5 分のマスに合わせ、始まりを切り捨て、終わりを切り上げて置く。表の先頭と末尾で切る。
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

export function cellRows(
  startAt: number,
  endAt: number,
  tableStart: number,
  slots: number,
  slot: number,
): CellRows {
  const from = Math.max(0, Math.floor((startAt - tableStart) / slot));
  const to = Math.max(
    from + 1,
    Math.min(slots, Math.ceil((endAt - tableStart) / slot)),
  );
  return { from, to, end: (endAt - tableStart) / slot };
}
