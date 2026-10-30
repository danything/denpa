import { SKIP } from "#lib/ts/watch.js";

/**
 * 再生画面のキー操作。**観る画面と追っかけで同じ割り当てにする** (観ているものは同じなので、
 * エンコードの前後で押し方を変えない)。
 *
 * **修飾キー付きは取らない。** Ctrl+C (コピー) を `c` (字幕) として横取りして
 * いた頃は、観ながら番組名や URL を写せなかった。Ctrl+F (検索) → 全画面、
 * Ctrl+S (保存) → 切り抜きも同じ。Shift だけは通す (`<` `>` は Shift 込みで
 * 打つ)。IME 変換中のキーも渡さない。
 *
 * 入力欄 (テキストエリア・選択・編集できる要素も)・ボタン・リンク・メニューの上では取らない — 空白でボタンを押せなくなる
 */
export interface PlayerKeys {
  /** 空白 / k */
  togglePlay: () => void;
  /** ← → (10秒。`ts/watch.ts` の端2回タップと同じ幅) */
  seekBy: (seconds: number) => void;
  /** c。持っていない画面は省く */
  toggleCaptions?: () => void;
  /** s */
  snapshot?: () => void;
  /** f */
  toggleFull?: () => void;
  /** `>` `<`。順送りと、行き過ぎたときの戻り */
  stepSpeed?: (direction: number) => void;
  /** m */
  toggleMute?: () => void;
  /** ↑ ↓ (音量。`volume.svelte.ts` の `step`) */
  stepVolume?: (direction: number) => void;
}

export function playerKeys(
  actions: PlayerKeys,
): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing)
      return;
    const target = event.target as HTMLElement;
    if (
      target.isContentEditable ||
      target.closest('input, textarea, select, button, a, [role="menu"]') !==
        null
    )
      return;

    const { stepSpeed, stepVolume } = actions;
    const map: Record<string, (() => void) | undefined> = {
      " ": actions.togglePlay,
      k: actions.togglePlay,
      ArrowLeft: () => actions.seekBy(-SKIP),
      ArrowRight: () => actions.seekBy(SKIP),
      c: actions.toggleCaptions,
      s: actions.snapshot,
      f: actions.toggleFull,
      ">": stepSpeed === undefined ? undefined : () => stepSpeed(1),
      "<": stepSpeed === undefined ? undefined : () => stepSpeed(-1),
      m: actions.toggleMute,
      ArrowUp: stepVolume === undefined ? undefined : () => stepVolume(1),
      ArrowDown: stepVolume === undefined ? undefined : () => stepVolume(-1),
    };
    const run = map[event.key];
    if (run === undefined) return;
    event.preventDefault();
    run();
  };
}
