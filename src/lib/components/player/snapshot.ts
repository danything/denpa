import type { Notice } from '#lib/components/Toasts.svelte';

/** 写す1コマ。`<video>` か、生で見ているときに worker から貰った絵 (`raw/engine.ts` の `grab`) */
export interface Frame {
    image: CanvasImageSource;
    width: number;
    height: number;
}

/** いま映している `<video>` の1コマ。まだ絵が来ていなければ null */
export function videoFrame(video: HTMLVideoElement | null): Frame | null {
    if (video === null || video.videoWidth === 0) return null;
    return { image: video, width: video.videoWidth, height: video.videoHeight };
}

/**
 * ファイル名に使えない字。Windows が断る `\ / : * ? " < > |` と制御文字。
 * 番組名には「／」(全角) や「:」がよく入る — 全角は通るので残し、半角だけ替える
 */
const FORBIDDEN = /[\\/:*?"<>|\p{Cc}]/gu;
/** 名前の上限 (字)。**長い番組名で 255 バイトを超えない**ように (日本語は1字3バイト) */
const NAME_MOST = 60;

/**
 * 切り抜きのファイル名。`番組名_YYYYMMDD-HHMMSS.png` (時刻は撮った瞬間・端末の時計)。
 *
 * **時刻は秒まで入れる。** 同じ番組を何枚も撮ると名前がぶつかり、ブラウザが「(1)」を
 * 足していくか、共有先 (写真アプリ) で上書きの確認が出る
 */
export function shotName(title: string, at: Date): string {
    const name =
        title
            .replace(FORBIDDEN, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, NAME_MOST)
            // 末尾の点と空白は Windows が黙って落とす
            .replace(/[. ]+$/, '') || 'denpa';
    const two = (n: number) => String(n).padStart(2, '0');
    const day = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}`;
    const time = `${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
    return `${name}_${day}-${time}.png`;
}

/**
 * **指の端末では共有に渡す。** スマホで `<a download>` に落とすと「ファイル」の奥に
 * 入るだけで、写真には並ばない (iOS)。共有シートなら「画像を保存」で写真へ、そのまま
 * LINE などへも送れる。PC にも共有の口を持つブラウザがある (Chrome・Safari) が、
 * あちらは落とすほうが早いので使わない
 */
function prefersShare(file: File): boolean {
    if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
    if (!window.matchMedia('(pointer: coarse)').matches) return false;
    try {
        return navigator.canShare({ files: [file] });
    } catch {
        return false;
    }
}

/** 落とす。**URL はすぐには捨てない** — Safari と Firefox は押した直後に捨てると落とし損ねる */
function download(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * いまの1コマを字幕ごと切り抜いて PNG にする。**3画面 (ライブ・追っかけ・観る画面) で同じ。**
 *
 * 映像を1枚に写し、出している字幕 (`caption`) があればそのまま重ねる。字幕の面は
 * 映像と大きさが違う (字幕 1440x1080 / 映像 1920x1080) ので、画面でやっているのと
 * 同じように引き伸ばす。
 *
 * 渡し方は端末で分ける:
 *
 * - **指の端末** … 共有シート (`navigator.share`)。断られたら (押した勢いが切れた・
 *   共有できない形) 落とすほうに倒す。閉じられたら何もしない (やめたのは本人)
 * - **PC** … 落とす。**クリップボードにも置く** — そのまま貼りたい用はこちらで
 *   受けていた (以前はコピーだけだった)。置けるのは安全な繋ぎ (https) と押した勢いが
 *   あるときだけなので、断られても黙って落とすだけにする
 *
 * 返り値は知らせ (トースト)。撮れなかった・共有に渡した (シートそのものが返事) なら null。
 *
 * @param frame 写す絵。まだ来ていなければ null (何もしない)
 * @param caption 重ねる字幕の canvas。消しているとき・持っていないときは null
 * @param title 番組名 (ファイル名の頭)
 */
export async function clipFrame(
    frame: Frame | null,
    caption: HTMLCanvasElement | null,
    title: string,
): Promise<Notice | null> {
    if (frame === null || frame.width === 0) return null;
    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.drawImage(frame.image, 0, 0, canvas.width, canvas.height);
    if (caption !== null && caption.width > 1) {
        ctx.drawImage(caption, 0, 0, canvas.width, canvas.height);
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob === null) return null;
    const name = shotName(title, new Date());
    const key = `shot-${Date.now()}`;

    const file = new File([blob], name, { type: 'image/png' });
    if (prefersShare(file)) {
        try {
            await navigator.share({ files: [file] });
            return null;
        } catch (error) {
            // 閉じた (やめた) なら何もしない。それ以外 (勢いが切れた・断られた) は落とす
            if (error instanceof DOMException && error.name === 'AbortError') return null;
        }
    }

    download(blob, name);
    try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return { key, kind: 'success', text: `切り抜きを保存しました (クリップボードにもコピー): ${name}` };
    } catch {
        // 置けない繋ぎ (http) や断られたとき。落としてあるので、それだけ言う
        return { key, kind: 'success', text: `切り抜きを保存しました: ${name}` };
    }
}
