/**
 * **途中から入った流れは、最初のキーフレームまで MSE に渡さない。**
 *
 * 誰かが見ている局に後から入ると、サーバは持っている init のあと、**いま出ている塊から**
 * 渡してくる (`server/live.ts`)。塊は 0.05 秒ずつなので、たいていキーフレームの途中です。
 * キーフレームが来るまでのコマは、どのブラウザも映せません。
 *
 * 映せないのに渡すと、Safari (WebKit) はそれを**デコードしては捨て、コマ落ちに数えます**。
 * 選局の直後に 3〜18 コマ、iPad の実機で 33 コマ (#1210)。Chromium は数えない代わりに、
 * キーフレームの手前から**音だけ先に鳴らし、映像はキーフレームで止まったまま**になります
 * (始める位置が手前にずれるぶん、遅延も伸びる)。
 *
 * 渡さなければ、どちらも始める位置がキーフレームになります (`at`)。待つ長さは変わりません —
 * 映せる1枚目はどのみちキーフレームです
 */
import { type Fmp4Track, readFragment, readInit } from "./fmp4";

/**
 * キーフレームを待つ上限 (秒。映像の尺で数える)。**待ちきりにはしない。**
 *
 * キーフレームの間隔は約 1 秒 (`-g 60` で 60 コマごと。ライブはインタレ解除で 59.94 コマ/秒にする。`server/live.ts`)。印 (`sample_is_non_sync_sample`) が
 * 読めない流れだったときに、映像が出ないまま止まるよりは、前のとおり全部渡すほうがいい
 */
const KEY_WAIT = 4;

export class KeyGate {
  #tracks: Fmp4Track[] = [];
  #video: Fmp4Track | undefined;
  #waiting = false;
  /** 待っている間に見送った映像の尺 (秒) */
  #skipped = 0;
  /** 最初のキーフレームの時刻 (秒。MSE の時刻と同じ物差し)。見つかるまで・待たなかったときは null */
  at: number | null = null;

  /** init が来た。**ここから数え直す** (選局・音声や形式の選び直しで作り直す) */
  init(bytes: Uint8Array): void {
    try {
      this.#tracks = readInit(bytes);
    } catch {
      this.#tracks = [];
    }
    this.#video = this.#tracks.find((t) => t.kind === "video");
    // 映像の無い放送は待たない
    this.#waiting = this.#video !== undefined;
    this.#skipped = 0;
    this.at = null;
  }

  /** この塊を MSE に渡してよいか。**キーフレームを含む塊から先は全部渡す** */
  pass(bytes: Uint8Array): boolean {
    const video = this.#video;
    if (!this.#waiting || video === undefined) return true;
    let samples: ReturnType<typeof readFragment>;
    try {
      samples = readFragment(bytes, this.#tracks);
    } catch {
      this.#waiting = false;
      return true;
    }
    for (const sample of samples) {
      if (sample.track !== video.id) continue;
      if (sample.key) {
        this.at = sample.pts / video.timescale;
        this.#waiting = false;
        return true;
      }
      this.#skipped += sample.duration / video.timescale;
    }
    if (this.#skipped >= KEY_WAIT) {
      this.#waiting = false;
      return true;
    }
    return false;
  }
}
