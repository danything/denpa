/**
 * 全画面への切り替え方。**端末が持っている API で決める** (#471)。
 *
 * - `standard` … `element.requestFullscreen()`。PC・Android・iPadOS 16.4 以降
 * - `webkit` … `element.webkitRequestFullscreen()`。それより前の iPadOS
 * - `pseudo` … どちらも無い (iPhone の Safari)。**枠を画面いっぱいに広げて
 *   代わりにする** (`fullscreen.svelte.ts`)。iPhone は要素の全画面を持たず、
 *   あるのは `<video>` だけの `webkitEnterFullscreen` — あれは映像だけを OS の
 *   再生画面に渡すので、字幕・データ放送・操作列が置いていかれる。だから使わない
 *
 * API があっても `fullscreenEnabled` が偽なら使えない (iframe の許可が無いなど) ので、
 * そのときも次へ回す
 */
export type FullscreenMode = "standard" | "webkit" | "pseudo";

/** ベンダープレフィックス付きの API (古い iPadOS の Safari)。型に無いので自分で書く */
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
  if (
    typeof el.requestFullscreen === "function" &&
    d.fullscreenEnabled !== false
  )
    return "standard";
  if (
    typeof el.webkitRequestFullscreen === "function" &&
    d.webkitFullscreenEnabled !== false
  )
    return "webkit";
  return "pseudo";
}

/** いま本物の全画面に入っている要素 (プレフィックス付きも見る)。無ければ null */
export function nativeFullscreenElement(doc: object): Element | null {
  const d = doc as WebkitDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/**
 * 本物の全画面に入る。**失敗しても黙る** (押した直後でなくなった・許可が無いなど)。
 * 古い webkit は Promise を返さないことがある
 */
export async function requestNative(
  element: object,
  mode: FullscreenMode,
): Promise<void> {
  const el = element as WebkitElement;
  try {
    if (mode === "standard") await el.requestFullscreen?.();
    else if (mode === "webkit") await el.webkitRequestFullscreen?.();
  } catch {
    // 押せばまた入れる
  }
}

/**
 * 全画面の間だけ横向きに固定する。非対応・拒否は表示に影響させない。
 * 解除後に lock が完了しても固定を残さず、入り直した場合は新しい固定を保つ。
 */
export function landscapeLock(orientation?: object): (active: boolean) => void {
  const api = orientation as
    | { lock?: (value: "landscape") => Promise<void>; unlock?: () => void }
    | undefined;
  let active = false;
  const unlock = () => {
    try {
      api?.unlock?.();
    } catch {
      // 向きの固定を使えない環境でも全画面は維持する
    }
  };
  return (enabled) => {
    if (active === enabled || typeof api?.lock !== "function") return;
    active = enabled;
    if (!active) {
      unlock();
      return;
    }
    try {
      void api.lock("landscape").then(
        () => {
          if (!active) unlock();
        },
        () => {},
      );
    } catch {
      // API があっても同期的に拒否される場合がある
    }
  };
}

/** 本物の全画面を出る。入っていなければ何もしない */
export async function exitNative(doc: object): Promise<void> {
  const d = doc as WebkitDocument;
  try {
    if (d.fullscreenElement != null && typeof d.exitFullscreen === "function")
      await d.exitFullscreen();
    else if (
      d.webkitFullscreenElement != null &&
      typeof d.webkitExitFullscreen === "function"
    )
      await d.webkitExitFullscreen();
  } catch {
    // 出られなかったものは UA の Esc に任せる
  }
}
