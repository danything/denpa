/**
 * 削除の2回押し。1回目で聞き返し、2回目で本当に消す。**3画面で同じ挙動。**
 * 行のすぐ隣に並んでいるので、押し間違いで消えると取り返しがつかない。
 *
 * - 少し置いたら元に戻す (押したことを忘れた頃に消えないように)
 * - **他所を触ったら、聞き返しは取り下げる** (`stand`)。時間で戻すだけだと、
 *   間違えて押したことに気付いて別のところを触っても**まだ構えたまま**で、
 *   その数秒のうちに同じ場所をもう一度押すと消えてしまう。やめたことは
 *   他所を触った時点で分かる
 *
 * 別々に書いていた頃は、端末保存の一覧だけ3秒で戻り、取り下げも無かった。
 *
 * @param spare 取り下げから除く押し場所 (CSS セレクタ)。「削除」は次の行を
 *   構える押し方 (この後 `arm` が入れ直す)、「確定」はまさに実行する押し方
 */
export function arming(spare: string) {
    let armed = $state<number | null>(null);
    let disarm: ReturnType<typeof setTimeout> | undefined;

    return {
        /** 聞き返し中の id。構えていなければ null */
        get armed(): number | null {
            return armed;
        },
        arm(id: number): void {
            armed = id;
            clearTimeout(disarm);
            disarm = setTimeout(() => (armed = null), 5000);
        },
        /** 実行した (フォーム送信でない削除は、消したら自分で下ろす) */
        fire(): void {
            clearTimeout(disarm);
            armed = null;
        },
        /** `<svelte:window onclick={...}>` に。他所を触ったら取り下げる */
        stand(event: MouseEvent): void {
            if (armed === null) return;
            if ((event.target as HTMLElement | null)?.closest(spare)) return;
            clearTimeout(disarm);
            armed = null;
        },
    };
}
