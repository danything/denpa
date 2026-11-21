/**
 * **データ放送の受け口 (ライブ・追っかけと観る画面で同じ)。** 出しているか (d ボタン) と、自動で受信するか (長押し。
 * 端末ごとに覚える。`data-receive.ts`) を持ち、エンジン (`DataBroadcast`) へ通知 (`ResponseMessage`) を渡す。
 *
 * 通知の受け取り方は出どころで違う。ライブは WebSocket で届いたものをそのまま渡し、描く側ができるまで控える (`deliver`)。
 * 観る画面はエンコードするときに取り出した変化ログ (`server/recorded-bml.ts`) を再生位置に合わせて流し直す
 * (`listenAt`・`follow`。`ts/data-timeline.ts`)
 */

import type { ResponseMessage } from "@danything/arib/bml-protocol";

import {
  DATA_RECEIVE_KEY,
  storedDataReceive,
} from "#lib/components/player/data-receive.js";
import { read, write } from "#lib/keep.js";
import {
  feedFor,
  type PlacedMessage,
  replayAt,
} from "#lib/ts/data-timeline.js";

/**
 * 通知を、受け取る側ができるまでに取っておく数 (`deliver`)。待つのは 700 KB を読み込む間だけで
 * 数十で足りるが、モジュールは 1 通が 100 KB を超えることがあるので、立たなかったときに際限なく抱え込ませない
 */
export const HOLD_DATA = 300;

type Emit = (message: ResponseMessage) => void;

export class DataLayer {
  /** 出しているか (テレビの d ボタン) */
  show = $state(false);
  /** 自動で受信するか。既定はオフ */
  receive = $state(false);
  /** 通知を渡す先。**描いているものがあるときだけ** (`DataBroadcast` が開くたびに渡してくる) */
  #emit: Emit | null = null;
  /**
   * 受け取る側ができるまでの控え (ライブ)。サーバは押された瞬間に番組・PMT・モジュールをまとめて送るが、描く側は
   * 700 KB を読み込んでから立ち上がる。番組 (`programInfo`) は一度きりなので、捨てると押しても何も出なかった
   */
  #held: ResponseMessage[] = [];
  /** 変化ログ (観る画面)。時刻の順 */
  timeline: PlacedMessage[] = [];
  /** 変化ログをどこまで流したか (再生位置 ms)。まだなら -1 */
  #fed = -1;

  /** 覚えている「自動で受信するか」を読む。**開いた端末で決まる**ので、開いてから呼ぶ */
  restore(): void {
    this.receive = storedDataReceive(read(DATA_RECEIVE_KEY));
  }

  /** 自動で受信するかを切り替えて、端末に覚える */
  toggleReceive(): void {
    this.receive = !this.receive;
    write(DATA_RECEIVE_KEY, this.receive ? "1" : "0");
  }

  /**
   * 届いた通知を渡す (ライブ)。受け取る側がまだ無ければ、`keep` のときだけ控える
   * (受け取るつもりが無いなら取っておく意味も無い)
   */
  deliver(message: ResponseMessage, keep: boolean): void {
    if (this.#emit !== null) this.#emit(message);
    else if (keep && this.#held.length < HOLD_DATA) this.#held.push(message);
  }

  /** 控えを捨てる (受け取らなくなった) */
  drop(): void {
    this.#held = [];
  }

  /** 受け取る先を預かる (ライブ)。**預かった時点で、控えてあるぶんを先に流す** */
  listen(emit: Emit | null): void {
    this.#emit = emit;
    const held = this.#held;
    this.#held = [];
    if (emit === null) return;
    for (const message of held) emit(message);
  }

  /** 受け取る先を預かる (観る画面)。**預かった直後に、再生位置 `to` (ms) まで積んで追いつく** (`replayAt`) */
  listenAt(emit: Emit | null, to: number): void {
    this.#emit = emit;
    if (emit === null) return;
    for (const message of replayAt(this.timeline, to)) emit(message);
    this.#fed = to;
  }

  /**
   * 再生が `to` (ms) まで進んだぶんを流す (観る画面)。先へ飛んだ (シーク・CM 飛ばし) ときはその間の変化を足す。
   * **戻っていたら流さずに false** を返す。呼んだ側はエンジンを作り直す (開いているかは持ち越し、入口から出直す)
   */
  follow(to: number): boolean {
    if (this.#emit === null) return true;
    const feed = feedFor(this.timeline, this.#fed, to);
    if (feed.reset) return false;
    for (const message of feed.messages) this.#emit(message);
    this.#fed = to;
    return true;
  }

  /** 変化ログを流し始める前に戻す (エンジンを作らせる前) */
  rewind(): void {
    this.#fed = -1;
  }
}
