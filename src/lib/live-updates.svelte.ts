import { invalidateAll } from '$app/navigation';

/**
 * サーバからの通知を受けて画面を読み直す。
 *
 * 短時間に何度も来ることがある(録画開始とエンコード投入など)ので、
 * 少しまとめてから1回だけ読み直す。
 *
 * ## 戻ってきたら繋ぎ直す
 *
 * **ホーム画面から開いたアプリ (PWA) は、閉じても捨てられない。** 端末は画面を
 * 凍らせて残しておき、次に開いたときそのまま見せる。凍っている間に
 * `EventSource` は切られるが、**これは自分では戻ってこない** — 繋ぎ直すのは
 * ブラウザが切ったときだけで、凍結からの復帰は `CLOSED` のまま止まる。
 * 結果、**開き直しても知らせが二度と来ない**状態になり、リロードするまで
 * 古い一覧を見せ続けていた。
 *
 * 見えるようになったら、閉じていようがいまいが開き直す。閉じていなければ
 * 何も起きない安い判定なので、迷わず毎回見る。読み直しそのものは土台側
 * (`+layout.svelte`) がやる — あちらは知らせを使っていない画面 (番組表・
 * ルール) も同じように古いままだった
 *
 * ## 取りこぼしは「繋ぎ直したら1回読み直す」で埋める
 *
 * イベントは「変わったよ」の1ビットで、真実は毎回取りに行く。だから
 * 切れていた間に何が起きていても、**繋がり直した瞬間に1回読み直せば
 * 完全に追いつく** — 再送も Last-Event-ID も要らない。
 *
 * 切れたことに気付く道は3つ:
 * - **番犬** … サーバは25秒おきに `ping` を送ってくる (`api/events`)。
 *   60秒何も届かなければ、開いているつもりで死んだ繋ぎ (遅い回線で TCP が
 *   黙って死ぬ) とみなして作り直す
 * - **`error`** … EventSource が自分で諦めた (`CLOSED`)。プロキシが一瞬
 *   エラーを返したときなど。少し置いて作り直す
 * - **`online`** … 回線が戻った合図。待たずにすぐ作り直す
 *
 * @param events 名前が届いたら読み直すイベント
 * @param handlers 中身 (payload) を運ぶイベント。読み直さず、届いた中身を渡す
 */
export function liveUpdates(
    events: string[],
    handlers: Record<string, (payload: unknown) => void> = {},
): void {
    $effect(() => {
        let source: EventSource | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let retry: ReturnType<typeof setTimeout> | null = null;
        let lastSeen = Date.now();
        let everOpened = false;

        const refresh = () => {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => void invalidateAll(), 200);
        };

        const connect = () => {
            source?.close();
            lastSeen = Date.now(); // 新しい繋ぎに60秒の猶予をやる
            source = new EventSource('/api/events');
            source.addEventListener('open', () => {
                lastSeen = Date.now();
                // 繋ぎ直しは、切れていた間のことを知らない。1回読み直して追いつく。
                // 最初の1回は要らない — 画面を組んだばかりで、もう新しい
                if (everOpened) refresh();
                everOpened = true;
            });
            source.addEventListener('ping', () => {
                lastSeen = Date.now();
            });
            source.addEventListener('error', () => {
                // 途中の揺れは EventSource が自分で繋ぎ直す。諦めたときだけ引き取る
                if (source?.readyState !== EventSource.CLOSED) return;
                if (retry !== null) clearTimeout(retry);
                retry = setTimeout(connect, 3000);
            });
            for (const event of events) {
                source.addEventListener(event, () => {
                    lastSeen = Date.now();
                    refresh();
                });
            }
            for (const [event, handle] of Object.entries(handlers)) {
                source.addEventListener(event, (raw) => {
                    lastSeen = Date.now();
                    try {
                        handle(JSON.parse((raw as MessageEvent).data));
                    } catch {
                        // 読めない中身は捨てる。次の知らせで追いつく
                    }
                });
            }
        };
        connect();

        // 番犬。ping (25秒おき) が2回続けて見えなければ、死んだ繋ぎとみなす
        const watchdog = setInterval(() => {
            if (document.visibilityState !== 'visible') return; // 裏のタブで空騒ぎしない
            if (Date.now() - lastSeen > 60_000) connect();
        }, 15_000);

        // 凍らされている間に切られた繋ぎは、開き直しても黙ったまま (上の説明)
        const revive = () => {
            if (document.visibilityState !== 'visible') return;
            if (source === null || source.readyState === EventSource.CLOSED) connect();
        };
        document.addEventListener('visibilitychange', revive);
        // Android の Chrome は凍らせた画面を `resume` で戻す。凍って戻るだけの
        // 往復では `visibilitychange` が出ないことがある (`+layout.svelte`)
        document.addEventListener('resume', revive);
        window.addEventListener('pageshow', revive);
        // 回線が戻ったら、番犬の周期を待たずにすぐ
        const online = () => connect();
        window.addEventListener('online', online);

        return () => {
            if (timer !== null) clearTimeout(timer);
            if (retry !== null) clearTimeout(retry);
            clearInterval(watchdog);
            document.removeEventListener('visibilitychange', revive);
            document.removeEventListener('resume', revive);
            window.removeEventListener('pageshow', revive);
            window.removeEventListener('online', online);
            source?.close();
        };
    });
}

/** 前に届いた中身を持ったままの入れ物 */
export interface Held<T> {
    /** 最後に届いた中身。まだ一度も届いていないときだけ undefined */
    readonly value: T | undefined;
}

/**
 * 読み直している間、**前に届いた中身を出したままにする**。
 *
 * 相手待ちの読み込みは promise のまま画面へ渡している (`load` の戻り値)。
 * `{#await}` に直に食わせると、読み直すたびに新しい promise に変わって
 * 待ち状態へ戻るので、**中身がいったん消えてから同じものが描き直される**。
 * チューナー画面は知らせが来るたびに読み直すので、表が数百ミリ秒ごとに
 * 消えては現れ、目に見えてちらついていた。
 *
 * 中身を持っておいて、新しいものが届いたときだけ差し替える。表の行は
 * キー付きで並べてあるので、同じ中身なら Svelte は何も描き直さない
 * (= 変わったところだけが変わる)。
 */
export function held<T>(source: () => Promise<T>): Held<T> {
    let value = $state<T | undefined>(undefined);

    $effect(() => {
        const promise = source();
        // 追い越しがあると古いほうで上書きしてしまう
        let stale = false;
        promise.then(
            (next) => {
                if (!stale) value = next;
            },
            // 失敗しても前の中身をそのまま出しておく。握り潰さないと未処理の
            // 拒否になって、画面と関係のないところで落ちる
            () => {},
        );
        return () => {
            stale = true;
        };
    });

    return {
        get value() {
            return value;
        },
    };
}
