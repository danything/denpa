/**
 * **Web Audio で鳴らす音の出口** (3画面共通)。canvas に描く経路 (`raw/engine.ts`) と、`<video>` の音を通す
 * 経路 (`components/player/volume.svelte.ts`) が同じものを使う。
 *
 * 出口までは「音量 → リミッタ → 出口」の1本の経路 (`Outlet`)。決め方は `volume.ts`
 */

import {
  LIMITER,
  limiterTrim,
  MAX_LEVEL,
  throughAudio,
  volumeGain,
} from "./volume";

/**
 * **「再生する音」だと Safari に言う** (Audio Session API。Safari にしか無い)。
 *
 * Web Audio で鳴らす音を、言わずにおくと iOS は効果音と同じに扱い、**Safari を裏へ回すと止める** —
 * 小窓で観ていても音だけ消えた (iPhone 15 Pro Max、iOS 27.2)。消音スイッチで黙らないのも `<video>` と
 * 同じになる。畳むときは既定 (`auto`) に戻す。
 *
 * これが言える端末 (Safari) では `<audio>` を通さない (`Outlet.route`)
 */
export function playbackSession(on: boolean): void {
  const session = audioSession();
  if (session === undefined) return;
  try {
    session.type = on ? "playback" : "auto";
  } catch {
    // 受け付けない種類。言えなくても鳴らすことはできる
  }
}

export function audioSession(): { type: string } | undefined {
  return (navigator as Navigator & { audioSession?: { type: string } })
    .audioSession;
}

/** `<audio>` を通す出口。**要るまで作らない** (`Outlet.route`) */
interface Through {
  audio: HTMLAudioElement;
  destination: MediaStreamAudioDestinationNode;
}

/**
 * 音量を掛け、リミッタを通して鳴らす。**鳴らす先は2つ** — ページから直に (`context.destination`) か、
 * ストリームにして `<audio>` から (`route`)。
 *
 * 音を消すのは使う側 (canvas はその前の GainNode、`<video>` は `muted`)。ここは触らない
 */
export class Outlet {
  /** ここへ繋ぐ。音量 (`level`) を掛ける */
  readonly input: GainNode;
  /** リミッタが足す大きさを打ち消す (`limiterTrim`)。鳴らす先を差し替えるのはここの後ろ */
  private readonly tail: GainNode;
  /** `<audio>` を通したいか (`want`)。通しているかは `through` */
  private wanted = false;
  /** 止めているか (`hold`)。`<audio>` も止めておく — 外から見て「止まっている」と分かるように */
  private held = false;
  /** `<audio>` の出口。一度作ったら畳むまで使い回す */
  private out: Through | null = null;
  private passing = false;
  private gone = false;

  /**
   * @param place 作った `<audio>` を置く。操作 UI (`controls`) を出さないので、どこに置いても見えない
   * @param remote `<audio>` を外 (ロック画面・車のハンドルの再生ボタン・ブラウザの再生中の通知) から止められた・再開された
   * @param testid 作る `<audio>` の testid
   */
  constructor(
    private readonly context: AudioContext,
    private readonly place: (audio: HTMLAudioElement) => void,
    private readonly remote: (paused: boolean) => void,
    private readonly testid: string,
  ) {
    this.input = context.createGain();
    this.input.gain.value = volumeGain(MAX_LEVEL);
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = LIMITER.threshold;
    limiter.knee.value = LIMITER.knee;
    limiter.ratio.value = LIMITER.ratio;
    limiter.attack.value = LIMITER.attack;
    limiter.release.value = LIMITER.release;
    this.tail = context.createGain();
    this.tail.gain.value = limiterTrim(LIMITER);
    this.input.connect(limiter);
    limiter.connect(this.tail);
    this.tail.connect(context.destination);
  }

  /** 音量 (%。`volume.ts` の `volumeGain`) */
  set level(level: number) {
    this.input.gain.value = volumeGain(level);
  }

  /** **いま音を `<audio>` へ流しているか。** canvas の時計の引き方が変わる (`RawEngine.clock`) */
  get through(): boolean {
    return this.passing;
  }

  /** `<audio>` を通したいか (バックグラウンド再生・小窓) */
  want(on: boolean): void {
    this.wanted = on;
    this.route();
  }

  /** 止めている・再開した。止めている間は `<audio>` も止める */
  hold(on: boolean): void {
    this.held = on;
    if (on) {
      if (this.passing) this.out?.audio.pause();
      return;
    }
    this.route();
  }

  /**
   * **音の出口を決め直す。** 通したいとき (`wanted`) は、ページから直に鳴らさず、ストリーム
   * (`createMediaStreamDestination`) にして `<audio>` で鳴らす。
   *
   * Web Audio の音を、ブラウザによっては効果音と同じに扱い、**裏へ回すと止める**
   * (テスラの車載ブラウザ。Chromium 系)。`<audio>` が鳴らしていれば「メディアの再生」で、
   * `<video>` と同じ扱いになる — ロック画面・車の操作にも「再生中」と出て、そこで押された止める・再開は
   * `remote` で伝える。
   *
   * - **Safari は通さない** — Audio Session を `playback` にすれば裏でも止まらない
   *   (`playbackSession`。iPhone で確かめてある)。iOS で MediaStream を鳴らすと、出口が
   *   通話の扱いに寄ることがあった
   * - ストリームを作れない端末は直に鳴らすまま
   * - **`play()` を断られたら (自動再生) 直に鳴らす。** 押されたら (`route` をまた呼んでもらう) また試す
   * - `<audio>` の `volume`/`muted` は触らない
   */
  route(): void {
    if (this.gone) return;
    const want = throughAudio({
      wanted: this.wanted,
      session: audioSession() !== undefined,
      streamable:
        typeof this.context.createMediaStreamDestination === "function",
    });
    if (!want) {
      this.direct();
      return;
    }
    let out = this.out;
    if (out === null) {
      try {
        out = this.out = this.makeOut();
      } catch {
        return;
      }
    }
    if (!this.passing) {
      this.tail.disconnect();
      this.tail.connect(out.destination);
      this.passing = true;
    }
    if (this.held || !out.audio.paused) return;
    const { audio } = out;
    void audio.play().catch(() => {
      // 断られた。**黙らせない** — 直に鳴らして、押されたらまた試す
      if (this.out?.audio === audio && audio.paused) this.direct();
    });
  }

  destroy(): void {
    if (this.gone) return;
    this.gone = true;
    if (this.out !== null) {
      this.out.audio.pause();
      this.out.audio.srcObject = null;
      this.out.audio.remove();
    }
  }

  /** 直に鳴らす (`route`) */
  private direct(): void {
    if (!this.passing) return;
    this.passing = false;
    this.tail.disconnect();
    this.tail.connect(this.context.destination);
    this.out?.audio.pause();
  }

  private makeOut(): Through {
    const destination = this.context.createMediaStreamDestination();
    const audio = document.createElement("audio");
    audio.setAttribute("data-testid", this.testid);
    audio.srcObject = destination.stream;
    /*
     * **外から止められた・再開されたら伝える。** こちらが止めた・再開したもの
     * (`held` と合っている) と、直に鳴らしている間のものには反応しない
     */
    const sync = () => {
      if (this.gone || !this.passing || audio.paused === this.held) return;
      this.remote(audio.paused);
    };
    audio.addEventListener("pause", sync);
    audio.addEventListener("play", sync);
    this.place(audio);
    return { audio, destination };
  }
}
