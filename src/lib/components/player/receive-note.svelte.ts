import { dataReceiveNote } from "./data-receive";

/** 出しておく長さ (ms)。観る画面の「CM を飛ばしました」と同じ */
const SHOWN_FOR = 2500;

/**
 * データ放送を自動で受信するかを切り替えたときの短い通知 (`dataReceiveNote`)。ライブと観る画面で同じ。
 * 舞台の通知の列 (`PlayerStage` の `notes`) に `text` を積む。続けて切り替えたら、最後のものを出し直す
 */
export function receiveNote(): {
  readonly text: string;
  show: (on: boolean) => void;
} {
  let text = $state("");
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    get text() {
      return text;
    },
    show(on: boolean) {
      text = dataReceiveNote(on);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        text = "";
        timer = null;
      }, SHOWN_FOR);
    },
  };
}
