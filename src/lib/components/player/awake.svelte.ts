/**
 * 観ている間、**画面を暗くさせない**。3画面 (ライブ・追っかけ・観る画面) で同じもの。
 *
 * 端末は「触られていない」と見ると明るさを落とし、やがて消す。動画は触らずに
 * 見るものなので、**再生中こそいちばん落とされる**。出先で読めなくなる原因の
 * 半分はこれ。
 *
 * **入り切りは置かない。観ている間は常に掛ける。** 輝度を選ばせるボタンを
 * 一度作ったが、**輝度そのものはブラウザから触れない** (そういう API は
 * どのブラウザにも無い) ので、できたのは絵に色を足すことだけだった —
 * 名前に嘘があるものは消した。落とさせないことだけができる。
 *
 * `navigator.wakeLock` は Chrome/Edge/Android と Safari 16.4 から。
 * **無ければ何もしない** — 無いことで壊れるものは無い。
 *
 * **裏に回ると OS が勝手に外す。** 戻ってきたときに取り直す (`visibilitychange`)。
 * 取り直さないと、一度タブを離れただけで効かなくなる
 */
export interface Awake {
    /** 起こしておきたいか。呼ぶ側が入れる (たいていは「再生中か」) */
    on: boolean;
}

export function screenAwake(): Awake {
    let want = $state(false);

    $effect(() => {
        const api = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock;
        if (!want || api === undefined) return;

        let lock: WakeLockSentinel | null = null;
        let dropped = false;

        const grab = (): void => {
            if (dropped || lock !== null || document.visibilityState !== 'visible') return;
            void api
                .request('screen')
                .then((next) => {
                    if (dropped) void next.release().catch(() => undefined);
                    else {
                        lock = next;
                        // OS が外したら覚えておく。次に戻ったときに取り直せる
                        next.addEventListener('release', () => (lock = null));
                    }
                })
                .catch(() => undefined);
        };

        grab();
        document.addEventListener('visibilitychange', grab);
        return () => {
            dropped = true;
            document.removeEventListener('visibilitychange', grab);
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
