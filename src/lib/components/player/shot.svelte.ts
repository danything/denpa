import type { Notice } from '$lib/components/Toasts.svelte';
import type { PlayerControls } from './controls.svelte';
import { clipFrame } from './snapshot';

/**
 * 切り抜きの3点セット (撮る・結果を持つ・トーストに出す)。**3画面で同じ形。**
 *
 * クリップボードに絵を置けるのは安全な繋ぎ (https) と押した勢いが要るので、
 * 断られたら**落とすほうに倒す** — 撮ったものを取り落とさない (`clipFrame`)。
 */
export function snapshotter(controls: PlayerControls) {
    let shot = $state<Notice | null>(null);

    return {
        /** トーストへ混ぜるぶん。撮っていなければ空 */
        get notices(): Notice[] {
            return shot === null ? [] : [shot];
        },
        /**
         * いまの1コマを字幕ごと切り抜く。
         * @param caption 出している字幕の canvas。出していなければ null
         */
        async take(
            video: HTMLVideoElement | null,
            caption: HTMLCanvasElement | null,
            title: () => string,
        ): Promise<void> {
            if (video === null) return;
            controls.stir();
            const notice = await clipFrame(video, caption, title);
            if (notice !== null) shot = notice;
        },
    };
}
