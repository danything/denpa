/**
 * **分ごとに進む時計** (番組表の「いま」・ホームの録画中の行・ルールの「次」・検索の放送中の判定)。
 * 分の変わり目に合わせて進めるので、出した時刻が時計の分とずれない。
 * 部品を組む間に呼ぶ (`$effect` で止め時を部品に預ける)
 */
export function minuteClock(): { readonly now: number } {
  let now = $state(Date.now());
  $effect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const next = (): void => {
      timer = setTimeout(
        () => {
          now = Date.now();
          next();
        },
        60_000 - (Date.now() % 60_000),
      );
    };
    next();
    return () => clearTimeout(timer);
  });
  return {
    get now() {
      return now;
    },
  };
}
