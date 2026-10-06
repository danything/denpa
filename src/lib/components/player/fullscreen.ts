/**
 * 全画面の入り方。**端末が持っている口で決める** (#471)。
 *
 * - `standard` … `element.requestFullscreen()`。PC・Android・iPadOS 16.4 以降
 * - `webkit` … `element.webkitRequestFullscreen()`。それより前の iPadOS
 * - `pseudo` … どちらも無い (iPhone の Safari)。**枠を画面いっぱいに広げて
 *   代わりにする** (`fullscreen.svelte.ts`)。iPhone は要素の全画面を持たず、
 *   あるのは `<video>` だけの `webkitEnterFullscreen` — あれは映像だけを OS の
 *   再生画面に渡すので、字幕・データ放送・操作列が置いていかれる。だから使わない
 *
 * 口があっても `fullscreenEnabled` が偽なら使えない (iframe の許可が無いなど) ので、
 * そのときも次へ回す
 */
export type FullscreenMode = 'standard' | 'webkit' | 'pseudo';

/** 前置き付きの口 (古い iPadOS の Safari)。型に無いので自分で書く */
interface WebkitElement {
    requestFullscreen?: () => Promise<void>;
    webkitRequestFullscreen?: () => Promise<void> | undefined;
}
interface WebkitDocument {
    fullscreenEnabled?: boolean;
    fullscreenElement?: Element | null;
    exitFullscreen?: () => Promise<void>;
    webkitFullscreenEnabled?: boolean;
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => Promise<void> | undefined;
}

export function fullscreenMode(element: object, doc: object): FullscreenMode {
    const el = element as WebkitElement;
    const d = doc as WebkitDocument;
    if (typeof el.requestFullscreen === 'function' && d.fullscreenEnabled !== false) return 'standard';
    if (typeof el.webkitRequestFullscreen === 'function' && d.webkitFullscreenEnabled !== false)
        return 'webkit';
    return 'pseudo';
}

/** いま本物の全画面に入っている要素 (前置き付きも見る)。無ければ null */
export function nativeFullscreenElement(doc: object): Element | null {
    const d = doc as WebkitDocument;
    return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/**
 * 本物の全画面に入る。**転んでも黙る** (押した勢いが切れている・許可が無いなど)。
 * 古い webkit は約束を返さないことがある
 */
export async function requestNative(element: object, mode: FullscreenMode): Promise<void> {
    const el = element as WebkitElement;
    try {
        if (mode === 'standard') await el.requestFullscreen?.();
        else if (mode === 'webkit') await el.webkitRequestFullscreen?.();
    } catch {
        // 押せばまた入れる
    }
}

/** 本物の全画面を出る。入っていなければ何もしない */
export async function exitNative(doc: object): Promise<void> {
    const d = doc as WebkitDocument;
    try {
        if (d.fullscreenElement != null && typeof d.exitFullscreen === 'function') await d.exitFullscreen();
        else if (d.webkitFullscreenElement != null && typeof d.webkitExitFullscreen === 'function')
            await d.webkitExitFullscreen();
    } catch {
        // 出られなかったものは UA の Esc に任せる
    }
}
