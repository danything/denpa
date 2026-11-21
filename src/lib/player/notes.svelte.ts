/**
 * **断り書き (3 画面で同じ)。** 失敗ではないが、リクエストされたとおりにできなかったときに映像の上へ出す 1 行
 * (形式を切り替えた・回線に合わせて段を替えた・サーバの `notice`)。
 *
 * 出してから決まった長さで引っ込める (`show`)。**ほかの文で替わっていれば消さない** (引っ込める時計は、出した文を
 * 出しているときだけ消す)。引っ込めないのは、その状態が続いている間だけ出す文 (`stand`。ライブの `encode`・`pinned`) で、
 * 状態が来なくなったら出した側が消す (`clear`)。
 * 出しっぱなしにしていた頃は、選び直すまで映像の上に残り、局を替えても押しても消えなかった (`StageNote` は押せない)
 */
export class Note {
  /** 出している文。無ければ空 */
  text = $state("");
  #timer: ReturnType<typeof setTimeout> | null = null;

  /** `text` を出し、`hold` (ms) で引っ込める */
  show(text: string, hold: number): void {
    this.text = text;
    this.#stop();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.text === text) this.text = "";
    }, hold);
  }

  /** 引っ込めずに出す。出した側が `clear` で消す */
  stand(text: string): void {
    this.text = text;
  }

  /** 消す。`only` を渡したら、その文を出しているときだけ */
  clear(only?: string): void {
    if (only !== undefined && this.text !== only) return;
    this.text = "";
  }

  /** 引っ込める時計を止める (画面を離れる) */
  close(): void {
    this.#stop();
  }

  #stop(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}
