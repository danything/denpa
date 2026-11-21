/**
 * **字幕の受け口 (3 画面で同じ)。** 出し入れと言語を端末ごとに覚え (`caption-pref.ts`)、再生位置に合う 1 枚を
 * 放送の置き場所のまま canvas に描く (`caption-draw.ts` の `CaptionPainter`)。
 *
 * 文字の配置 (`Cue`) の受け取り方は出どころで違う。ライブと追っかけは WebSocket で 1 つずつ届く (`insert`。
 * 字幕のほうが映像より先に届くので、出し終えたぶんを片付ける `sweep`)。観る画面は `captions.json` を 1 回取って
 * 全部を渡す (`load`)。どちらも時刻は映像と同じ物差し
 */

import type {
  CaptionLanguage,
  CaptionPage,
} from "@danything/arib/caption-text";

import { CaptionPainter } from "#lib/components/player/caption-draw.js";
import {
  CAPTION_LANGUAGE_KEY,
  CAPTION_ON_KEY,
  pickLanguage,
  storedCaptionsOn,
} from "#lib/components/player/caption-pref.js";
import { read, write } from "#lib/keep.js";
import {
  type Cue,
  currentCue,
  insertCue,
  showing,
  trimCues,
} from "#lib/ts/captions.js";

export class CaptionLayer {
  /** 字幕を出すか。既定は出す。**押して切り替えられる** (テレビの字幕ボタン) */
  on = $state(true);
  /** 載っている言語。分かるまでは空 */
  languages = $state.raw<CaptionLanguage[]>([]);
  /** 出している言語 (`CaptionLanguage.index`) */
  language = $state(1);
  /** 文字の配置。時刻の順 */
  #cues: Cue[] = [];
  /** いま描いている 1 枚。同じものを描き直さない */
  #shown: CaptionPage | null = null;
  #painter: CaptionPainter | null = null;

  /** いま描いている 1 枚 (切り抜きに文字を添える)。出していなければ null */
  get shown(): CaptionPage | null {
    return this.#shown;
  }

  /** 覚えている出し入れを読む。**開いた端末で決まる**ので、サーバで組むときではなく開いてから呼ぶ */
  restore(): void {
    this.on = storedCaptionsOn(read(CAPTION_ON_KEY));
  }

  /** 出す・消す。端末ごとに覚える */
  setOn(on: boolean): void {
    this.on = on;
    write(CAPTION_ON_KEY, on ? "1" : "0");
  }

  /** 言語 `index` を端末に覚える (言語の名前 ISO 639 で。番組ごとに第何言語かが違う) */
  remember(index: number): void {
    const code = this.languages.find((l) => l.index === index)?.code ?? "";
    if (code !== "") write(CAPTION_LANGUAGE_KEY, code);
  }

  /** `languages` のうち覚えている言語の番号。載っていなければ第 1 言語 */
  preferred(languages: CaptionLanguage[]): number {
    return pickLanguage(languages, read(CAPTION_LANGUAGE_KEY));
  }

  /** 描く先の canvas を預かる。前に預かったものは閉じる */
  attach(canvas: HTMLCanvasElement): void {
    this.#painter?.close();
    this.#painter = new CaptionPainter(canvas);
  }

  /** 描く先を閉じる */
  close(): void {
    this.#painter?.close();
    this.#painter = null;
  }

  /**
   * 位置 `at` (秒) に合う 1 枚を描く。描き替えたら true。消しているなら何も描かない。
   * `before` は描き替えるときだけ、描く前に呼ぶ (観る画面が canvas を映像に重ね直す `place`)
   */
  paint(at: number, before?: () => void): boolean {
    if (this.#painter === null) return false;
    const next = this.on ? showing(currentCue(this.#cues, at), at) : null;
    if (next === this.#shown) return false;
    this.#shown = next;
    before?.();
    this.#painter.show(next);
    return true;
  }

  /** 描いている 1 枚を消す。文字の配置は持ったまま (次の `paint` でまた描く) */
  hide(): void {
    this.#shown = null;
    this.#painter?.show(null);
  }

  /** 届いた 1 つを時刻の順に入れる (ライブと追っかけ) */
  insert(cue: Cue): void {
    this.#cues = insertCue(this.#cues, cue);
  }

  /** `at` より前に出し終えたぶんを片付ける。**`at` で出す 1 枚は残す** (出しっぱなしのため) */
  sweep(at: number): void {
    const kept = trimCues(this.#cues, at);
    if (kept.length !== this.#cues.length) this.#cues = kept;
  }

  /** 文字の配置を全部入れ替える (観る画面の `captions.json`・言語を替えたとき) */
  load(cues: Cue[]): void {
    this.#cues = cues;
  }

  /** 持っている文字の配置を捨てて、描いている 1 枚も消す (再エンコードのたび・局を替えたとき) */
  reset(): void {
    this.#cues = [];
    this.hide();
  }
}
