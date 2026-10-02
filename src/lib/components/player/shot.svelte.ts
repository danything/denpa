import type { Notice } from '#lib/components/Toasts.svelte';
import type { PlayerControls } from './controls.svelte';
import { clipFrame, type Frame } from './snapshot';

/** 切り抜きの3点セット (撮る・結果を持つ・トーストに出す)。**3画面で同じ形。** 撮り方は `clipFrame` */
export function snapshotter(controls: PlayerControls) {
    let shot = $state<Notice | null>(null);
    /**
     * 撮っている最中か。**続けて押しても1枚ずつ** — 共有シートが開いている間に
     * もう一度押すと、2枚目の共有が「もう開いている」で断られて落ちてくる
     */
    let busy = false;

    return {
        /** トーストへ混ぜるぶん。撮っていなければ空 */
        get notices(): Notice[] {
            return shot === null ? [] : [shot];
        },
        /** 閉じた (自分で消えた) ら捨てる。持ったままだと、返事が変わったときに蘇る (Toasts) */
        dismiss(key: string): void {
            if (shot?.key === key) shot = null;
        },
        /**
         * いまの1コマを字幕ごと切り抜く。
         * @param frame 写す絵を取りに行く口。**撮れると決まってから呼ぶ** (`busy` の後) — 生で
         *   見ているときは worker に1枚頼む (`raw/engine.ts` の `grab`) ので、先に呼ぶと
         *   弾いた押しのぶんの絵 (1080 で 8MB) が誰にも閉じられずに残る
         * @param caption 出している字幕の canvas。出していなければ null
         * @param title 番組名 (ファイル名の頭)
         */
        async take(
            frame: () => Frame | null | Promise<Frame | null>,
            caption: HTMLCanvasElement | null,
            title: string,
        ): Promise<void> {
            if (busy) return;
            busy = true;
            controls.stir();
            let got: Frame | null = null;
            try {
                got = await frame();
                const notice = await clipFrame(got, caption, title);
                if (notice !== null) shot = notice;
            } finally {
                busy = false;
                // 生で貰った絵 (1080 で 8MB) は写し終えたら手放す。GC 任せだと押すたびに溜まる
                if (got?.image instanceof ImageBitmap) got.image.close();
            }
        },
    };
}
