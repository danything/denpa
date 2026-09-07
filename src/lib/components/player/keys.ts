import { SKIP } from '$lib/ts/watch';

/**
 * 再生画面のキー操作。**観る画面と追っかけで同じ割り当てにする。**
 *
 * 割り当てを画面ごとに書いていた頃は、**焼き上がった録画では効くキーが、
 * 焼く前の同じ録画では効かなかった** (追っかけには何も無かった)。観ている
 * ものは同じなので、押し方まで変わる理由が無い。
 *
 * **修飾キー付きは取らない。** Ctrl+C (コピー) を `c` (字幕) として横取りして
 * いた頃は、観ながら番組名や URL を写せなかった。Ctrl+F (検索) → 全画面、
 * Ctrl+S (保存) → 切り抜きも同じ。Shift だけは通す (`<` `>` は Shift 込みで
 * 打つ)。IME 変換中のキーも渡さない。
 *
 * 入力欄・ボタン・リンクの上では取らない — 空白でボタンを押せなくなる
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
}

export function playerKeys(actions: PlayerKeys): (event: KeyboardEvent) => void {
    return (event: KeyboardEvent) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
        if ((event.target as HTMLElement).closest('input, button, a') !== null) return;

        const { stepSpeed } = actions;
        const map: Record<string, (() => void) | undefined> = {
            ' ': actions.togglePlay,
            k: actions.togglePlay,
            ArrowLeft: () => actions.seekBy(-SKIP),
            ArrowRight: () => actions.seekBy(SKIP),
            c: actions.toggleCaptions,
            s: actions.snapshot,
            f: actions.toggleFull,
            '>': stepSpeed === undefined ? undefined : () => stepSpeed(1),
            '<': stepSpeed === undefined ? undefined : () => stepSpeed(-1),
            m: actions.toggleMute,
        };
        const run = map[event.key];
        if (run === undefined) return;
        event.preventDefault();
        run();
    };
}
