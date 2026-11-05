/**
 * 観ている間、**画面を暗くさせない**。3 画面 (ライブ・追っかけ・観る画面) で同じもの。
 *
 * 端末は「触られていない」と見ると明るさを落とし、やがて消す。動画は触らずに
 * 見るものなので、**再生中こそいちばん落とされる**。出先で読めなくなる原因の
 * 半分はこれ。
 *
 * **止めている間も掛けたまま。** 再生中だけにしていた頃は、一時停止して映像を
 * 見ている・番組の中身を読んでいる間に暗くなって消えました。観る画面は観る
 * ためだけに開くもので、追っかけは止めるところから始まります。
 *
 * **オン/オフは置かない。観ている間は常に掛ける。** 輝度そのものはブラウザから触れない
 * (そういう API はどのブラウザにも無い) ので、できるのは落とさせないことだけ。
 *
 * `navigator.wakeLock` は Chrome/Edge/Android と Safari 16.4 から。
 * **無ければ何もしない**。無いことで壊れるものは無い。
 *
 * **裏に回ると OS が勝手に外す。** 戻ってきたときに取り直す (`visibilitychange`)。
 * 取り直さないと、一度タブを離れただけで効かなくなる
 *
 * **Safari は、ユーザーが操作した直後でないと取らせない** (iOS・iPadOS・macOS の 27.2。#2209)。
 * ライブを URL で直に開いたときや、PWA を起こし直して前のライブに戻ったときは、操作の前に
 * 要求するので断られ、設定した時間で画面が消えていた。番組表から移ってきたときは、
 * 移るためのクリックの直後なので取れていた。**取れていない間は、画面のクリック・キー・タッチの
 * たびに取り直す** (その操作の中で呼ぶ。後回しにすると操作の直後と見なされない)。取れたら何もしない
 */
export interface Awake {
  /** 起こしておきたいか。呼ぶ側が入れる (たいていは「その画面を開いている間」) */
  on: boolean;
}

export function screenAwake(): Awake {
  let want = $state(false);

  $effect(() => {
    const api = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock;
    if (!want || api === undefined) return;

    let lock: WakeLockSentinel | null = null;
    let asking = false;
    let dropped = false;

    const grab = (): void => {
      if (
        dropped ||
        lock !== null ||
        asking ||
        document.visibilityState !== "visible"
      )
        return;
      asking = true;
      void api
        .request("screen")
        .then((next) => {
          if (dropped) void next.release().catch(() => undefined);
          else {
            lock = next;
            // OS が外したら覚えておく。次に戻ったとき・次に触ったときに取り直せる
            next.addEventListener("release", () => (lock = null));
          }
        })
        // 断られた (Safari で操作の前に呼んだ)。次の操作で取り直す
        .catch(() => undefined)
        .finally(() => (asking = false));
    };

    // 操作の直後と見なされる出来事。押し始め (pointerdown) は Safari では数えないことがあるので、押し終わりで見る
    const GESTURES = ["click", "keydown", "touchend"] as const;
    grab();
    document.addEventListener("visibilitychange", grab);
    for (const type of GESTURES)
      document.addEventListener(type, grab, { capture: true, passive: true });
    return () => {
      dropped = true;
      document.removeEventListener("visibilitychange", grab);
      for (const type of GESTURES)
        document.removeEventListener(type, grab, { capture: true });
      void lock?.release().catch(() => undefined);
      lock = null;
    };
  });

  return {
    get on(): boolean {
      return want;
    },
    set on(value: boolean) {
      want = value;
    },
  };
}
