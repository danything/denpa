/**
 * **AudioContext を、押されたときに作っておく。**
 *
 * iOS の Safari は、押したとき以外に作った AudioContext を止めたまま (`suspended`) 始め、押されて `resume` するまで鳴らさない。
 * 押されたときに作って `resume` しておけば、あとで押されていないときに使い始めても鳴る。
 * ライブで MPEG-2 (canvas に描く) から段を下げると `<video>` に移り、WebKit では音を別に鳴らす (`native-audio.ts`)。
 * 移る瞬間は押されていないので、そこで初めて作ると止まったまま始まり、自動再生を断られたとみて消音にしていた。
 *
 * 押したと見なす出来事は `awake.svelte.ts` と同じ。押し始め (`pointerdown`) は Safari では数えないことがあるので、押し終わりで見る。
 * DOM の出来事と AudioContext を渡せば単体で確かめられる (`gesture-context.test.ts`)
 */

/** 押したと見なす出来事 */
export const GESTURES = ["click", "keydown", "touchend"] as const;

export class GestureContext {
  private context: AudioContext | null = null;
  private listening: AbortController | null = null;

  /**
   * @param make AudioContext を作る (`seam.ts` の `audioContext`)
   * @param wanted 押されたときに作っておくか。使う見込みが無いうちに作らない (音の無い AudioContext も CPU を使う)
   */
  constructor(
    private readonly make: () => AudioContext,
    private readonly wanted: () => boolean,
  ) {}

  /** 押されるのを待ち始める。何度呼んでも 1 つ */
  listen(target: EventTarget): void {
    if (this.listening !== null) return;
    this.listening = new AbortController();
    for (const type of GESTURES)
      target.addEventListener(type, this.prime, {
        capture: true,
        passive: true,
        signal: this.listening.signal,
      });
  }

  /** 使う。まだ作っていなければここで作る (押されていなければ、iOS では止まったまま始まる) */
  get(): AudioContext {
    return (this.context ??= this.make());
  }

  /** 閉じて、待つのもやめる (画面を離れるとき)。次に `listen`・`get` を呼べば作り直す */
  close(): void {
    this.listening?.abort();
    this.listening = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  /** 押された。使う見込みがあれば作り、止まっていれば起こす */
  private readonly prime = (): void => {
    if (this.context === null && !this.wanted()) return;
    let context: AudioContext;
    try {
      context = this.get();
    } catch {
      // 作れない (AudioContext が無い)。使うときに呼ぶ側が断る
      return;
    }
    // iOS は電話などで止められると `interrupted` になる (型には無い)。閉じたもの以外は起こす
    if (context.state !== "running" && context.state !== "closed")
      void context.resume().catch(() => undefined);
  };
}
