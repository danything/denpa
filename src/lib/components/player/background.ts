/**
 * バックグラウンド再生の決め方 (`background.svelte.ts` の中身のうち、画面に触らない所)。
 *
 * 単体テストで見るために分けてある (`background.test.ts`)
 */

/** 端末ごとに覚える鍵 (`keep.ts`)。速さ・CM 飛ばしと同じ置き場 */
export const BACKGROUND_KEY = 'player-background';

/** 覚えていた値。**既定は切** — 入れたことのある端末だけ入で始まる */
export function storedBackground(saved: string | null): boolean {
    return saved === '1';
}

export interface Situation {
    /** バックグラウンド再生を入れているか */
    allowed: boolean;
    /** ページが裏に回っているか (`visibilityState` が `hidden`、または `pagehide` のあと) */
    hidden: boolean;
    /** 押して開いた小窓 (PiP) を出しているか */
    pip: boolean;
    /** 止めているか */
    paused: boolean;
    /** **こちらが止めたか。** 戻ってきたときに再開するのはこれだけ */
    held: boolean;
}

/**
 * いま何をするか。
 *
 * - **裏に回ったら止める** — 入れていない・小窓を出していない・まだ止まっていない、が揃ったとき。
 *   小窓は押して開いたもので、裏でも観たいと言われている。閉じた時点でまだ裏なら、そこで止める
 * - **戻ってきたら再開する** — こちらが止めたときだけ。自分で止めて裏に回った人のは再開しない。
 *   裏にいる間に (ロック画面などから) 再開されていれば、そのまま
 */
export function step(now: Situation): 'pause' | 'resume' | null {
    if (!now.hidden) return now.held && now.paused ? 'resume' : null;
    if (now.allowed || now.pip || now.paused || now.held) return null;
    return 'pause';
}
