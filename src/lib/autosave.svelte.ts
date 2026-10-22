import { submitting } from "#lib/actions.js";

/**
 * **変えたらその場で保存する** (設定の画面)。
 *
 * 「保存」のボタンを押させていた頃は、チェックを変えただけで画面を離れて
 * 「変えたはずが戻っている」になっていた。節ごとのフォームはそのままに、
 * 中のどれかが変わったら (`change`) 節ごと送る。文字を入れる欄は、欄を離れたときか
 * Enter で `change` が来るので、打っている途中では送らない。
 *
 * - 送っている間にまた変わったら、返事を待ってからもう1度送る (後から来た古い返事で
 *   新しい値を上書きしない)。「保存しました」は**最後の返事のあとだけ**出す
 * - 断られたら、最後に保存できた値に**戻して**理由を出す。画面とサーバの値を食い違わせない
 * - 送るだけの欄ではないもの (その場の操作のボタンなど) は `data-no-autosave` で外す
 */
export class SaveState {
  state = $state<"idle" | "saving" | "saved" | "error">("idle");
  message = $state("");
}

type Snapshot = Map<
  HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  string | boolean
>;

function take(form: HTMLFormElement): Snapshot {
  const values: Snapshot = new Map();
  for (const element of form.elements) {
    if (element instanceof HTMLInputElement) {
      values.set(
        element,
        element.type === "checkbox" || element.type === "radio"
          ? element.checked
          : element.value,
      );
    } else if (
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    ) {
      values.set(element, element.value);
    }
  }
  return values;
}

function restore(values: Snapshot): void {
  for (const [element, value] of values) {
    if (typeof value === "boolean" && element instanceof HTMLInputElement)
      element.checked = value;
    else if (typeof value === "string") element.value = value;
  }
}

/** 「保存しました」を出しておく長さ。読めるだけ出したら引っ込める */
export const SAVED_FOR = 2500;

export function autosave(node: HTMLFormElement, status: SaveState) {
  let snapshot = take(node);
  let inFlight = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const send = (): void => {
    clearTimeout(timer);
    status.state = "saving";
    status.message = "";
    if (inFlight) {
      pending = true;
      return;
    }
    // 検証 (required・pattern など) に落ちると requestSubmit は submit を起こさず、
    // inFlight が戻らないまま以降の変更が送られなくなる。先に見て、落ちたら知らせて止める
    if (!node.checkValidity()) {
      node.reportValidity();
      status.state = "idle";
      return;
    }
    inFlight = true;
    node.requestSubmit();
  };

  const onChange = (event: Event): void => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-no-autosave]") !== null
    )
      return;
    send();
  };
  node.addEventListener("change", onChange);

  const enhanced = submitting(node, () => async (options) => {
    inFlight = false;
    if (pending) {
      // 返事を待つ間に変わった。今の値でもう1度送る (この返事では画面を書き換えない)
      pending = false;
      send();
      return;
    }
    if (options.result.type === "success") {
      await options.update({ reset: false });
      snapshot = take(node);
      status.state = "saved";
      timer = setTimeout(() => {
        if (status.state === "saved") status.state = "idle";
      }, SAVED_FOR);
      return;
    }
    restore(snapshot);
    const data =
      options.result.type === "failure" ? options.result.data : undefined;
    const message =
      typeof data?.["message"] === "string" ? data["message"] : "";
    status.state = "error";
    status.message = message;
  });

  return {
    destroy() {
      clearTimeout(timer);
      node.removeEventListener("change", onChange);
      enhanced.destroy?.();
    },
  };
}
