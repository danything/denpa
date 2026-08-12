import type { Notice } from '$lib/components/Toasts.svelte';

/**
 * いまの1コマを字幕ごと切り抜く。**ライブ (`/live`) と観る画面 (`/watch/<id>`) で同じ。**
 *
 * 映像を1枚に写し、出している字幕 (`caption`) があればそのまま重ねる。クリップボードに
 * 絵を置けるのは安全な繋ぎ (https) と押した勢い (user activation) が要るので、断られたら
 * **落とすほうに倒す** — 撮ったものを取り落とさない。返り値は知らせ (トースト)、撮れなければ null。
 *
 * @param video いま映している映像
 * @param caption 重ねる字幕の canvas。消しているとき・持っていないときは null
 * @param filename 落とすときのファイル名 (拡張子は付けない)。撮った瞬間に決める
 */
export async function clipFrame(
    video: HTMLVideoElement,
    caption: HTMLCanvasElement | null,
    filename: () => string,
): Promise<Notice | null> {
    if (video.videoWidth === 0) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (caption !== null && caption.width > 1) {
        ctx.drawImage(caption, 0, 0, canvas.width, canvas.height);
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob === null) return null;

    const key = `shot-${Date.now()}`;
    try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return { key, kind: 'success', text: '切り抜きをコピーしました' };
    } catch {
        // 置けない繋ぎ (http) や断られたとき。落として渡す
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${filename()}.png`;
        link.click();
        URL.revokeObjectURL(url);
        return { key, kind: 'success', text: '切り抜きを保存しました' };
    }
}
