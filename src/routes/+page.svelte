<script lang="ts">
    import { goto } from '$app/navigation';
    import { submitting } from '$lib/actions';
    import { arming } from '$lib/arming.svelte';
    import ProgramDetail from '$lib/components/ProgramDetail.svelte';
    import Toasts, { errorNotice, type Notice } from '$lib/components/Toasts.svelte';
    import { type DetailSeed, programDetail } from '$lib/detail.svelte';
    import { startDownload } from '$lib/download';
    import { applyEncodeProgress, encodeLive } from '$lib/encode-live.svelte';
    import {
        badgeClass,
        cmNoteWorthShowing,
        date,
        dateTime,
        duration,
        durationMs,
        eta,
        logoUnusable,
        percent,
        recordedDuration,
        rowState,
        size,
        stateLabel,
        time,
    } from '$lib/format';
    import { forget, forgetPrefix, read, write } from '$lib/keep';
    import { liveUpdates } from '$lib/live-updates.svelte';
    import { clearFailed, offline, removeLocal, saveOffline } from '$lib/offline.svelte';
    import { encodeSource, type FileSource } from '$lib/source';

    let { data, form } = $props();

    // 予約・録画のどちらが動いてもサーバが知らせてくる。
    // エンコードの進み具合だけは中身ごと届き、読み直さず行の数字を書き換える
    liveUpdates(['recordings', 'reservations'], { encode: applyEncodeProgress });

    const active = ['scheduled', 'conflict', 'recording'];

    /*
     * ダウンロードは押されてから期限付きの署名URLを作って始める (`$lib/download`)。
     * 資格情報を URL に埋めていた頃は、パスワードがダウンロード履歴に残り続けた
     */
    function download(id: number, source?: FileSource): void {
        void startDownload(id, source).then((ok) => {
            if (!ok) noteVlc('error', 'ダウンロードのリンクを作れませんでした');
        });
        detail.close();
    }

    /** もう一方のコーデック (H.264) も焼いてあるか。両方焼いた録画でだけ在る */
    function hasAlt(rec: (typeof data.recordings)[number]): boolean {
        return rec.job_id === null && rec.alt_path !== null;
    }

    /**
     * 置き場の使用量。**主 (AV1) を先に出し、在るものだけ括弧に添える。**
     *
     * `ts_size` が持っているのは主のぶんだけなので、両方焼いた録画では画面の
     * 数字と実際に使っている量が食い違っていた (H.264 のほうが大きいことも
     * ある)。「消していいのか、どれだけ空くのか」を1行で読めるようにする
     */
    function sizeLabel(rec: (typeof data.recordings)[number]): string {
        const extra = [
            rec.alt_size === null ? '' : `H.264 ${size(rec.alt_size)}`,
            rec.raw_size === null ? '' : `生TS ${size(rec.raw_size)}`,
        ].filter((s) => s !== '');
        return extra.length === 0 ? size(rec.ts_size) : `${size(rec.ts_size)} (${extra.join('、')})`;
    }

    /**
     * 焼いたものと生TSが**両方とも残っている**か。
     *
     * 「生TSも残す」で録ると、焼き上がったあとも元が消えずに残る。そのとき
     * 落とす口が1つだと、寄越されるのは焼いたほうだけで、**元には手が届かない**
     * (画質を落としていない元が欲しい場面はある)。
     *
     * **焼いている最中は数えない。** その間の配信は生TSのほうを返すので
     * (`api/recordings/[id]/file`)、2つ並べると押した先が同じものになる
     */
    function bothFiles(rec: (typeof data.recordings)[number]): boolean {
        return rec.job_id === null && rec.library_path !== null && rec.ts_path !== null;
    }

    /** 端末への保存の結果。フォームではないので自前で持つ */
    let offlineNote = $state<Notice | null>(null);

    /** テレビ再生・リンクコピーの結果。こちらもフォームではないので自前で持つ */
    let vlcNote = $state<Notice | null>(null);
    // 旧版が端末に覚えていた出先のIP (詳細のIP入力ごとやめた)。残りは掃除する
    forget('vlc-other-host');
    // 旧版の「飛ばしたことがある」印。ペア設定を経ずに立つことがあり、当てにならない
    forgetPrefix('vlc-fired:');

    function noteVlc(kind: 'info' | 'error', text: string): void {
        vlcNote = { key: `vlc-${Date.now()}`, kind, text };
    }

    /**
     * 期限付きの再生リンクを作る (share.ts)。テレビへ飛ばすのもコピーするのも同じ1本。
     * `source` を渡すと、そのファイル (`?source=` の名指し) を指すリンクになる —
     * テレビごとのコーデック設定 (settings) の実現手段
     */
    async function mintShareLink(
        id: number,
        source?: 'ts' | 'alt',
    ): Promise<{ url: string; expiresAt: number }> {
        const query = source === undefined ? '' : `?source=${source}`;
        const res = await fetch(`/api/recordings/${id}/share${query}`, { method: 'POST' });
        return (await res.json()) as { url: string; expiresAt: number };
    }

    /**
     * テレビの VLC へ、**この端末から**直接飛ばす。
     *
     * VLC のリモートアクセスの `/play` はただの GET なので、`http://<テレビ>:8080/
     * play?id=0&path=<再生URL>` を**トップレベルで開けば**そのまま再生が始まる。
     * fetch だと混在コンテンツ・自己署名・CORS・Cookie の4つに塞がれるが、
     * ページ遷移にはどれも掛からず、SameSite=Lax の合鍵 Cookie も付く。
     * サーバから叩く形は落とした — 家のサーバからは出先のテレビに届かない
     * (`server/vlc.ts` の先頭に経緯)。
     *
     * **初回はペア設定 (ログイン) の画面そのものを開く。** ペア前に `/play` を叩いても
     * VLC は素の 401 ページを返すだけで、ログインへは誘導しない (作りがそう)。
     * ログインは VLC の画面が https (自己署名・ポート8443) へ誘導するので、
     * 証明書を受け入れてテレビの画面の6桁コードを入れる。できた Cookie (約1年) に
     * Secure は付いておらず、以後は http の `/play` にもそのまま乗る。
     *
     * **窓は押した瞬間に開けておく。** リンク先はトークンを取ってから入れる —
     * await の後の window.open はポップアップ扱いで塞がれることがある。
     * 応答 (OK だけの白いタブ) は中身が読めない (別オリジン) ので、数秒で畳む
     */
    async function playOnTv(
        tv: (typeof data.vlcTargets)[number],
        rec: (typeof data.recordings)[number],
    ): Promise<void> {
        const host = tv.host;
        if (read(`vlc-paired:${host}`) !== '1') {
            window.open(`http://${host}/`, '_blank');
            write(`vlc-paired:${host}`, '1');
            noteVlc(
                'info',
                '初回はテレビとのペア設定です。開いたタブで「セキュアな接続を使用」に進んで証明書を受け入れ、テレビの画面に出る6桁コードを入れたら、もう一度同じボタンを押してください',
            );
            return;
        }
        const win = window.open('about:blank', '_blank');
        /*
         * そのテレビのコーデック設定 (settings のテレビ一覧) をファイルの名指しに写す。
         * H.264 は両方焼いた録画の H.264 のほう (`alt`)、生TSは残っていれば `ts`。
         * 指した形式が無い録画では黙っておまかせ (今いいほう) に落ちる —
         * 押した人がテレビの前で選び直せるものではない
         */
        const source =
            tv.codec === 'h264' && hasAlt(rec)
                ? ('alt' as const)
                : tv.codec === 'ts' && rec.ts_path !== null
                  ? ('ts' as const)
                  : undefined;
        let shareUrl: string;
        try {
            ({ url: shareUrl } = await mintShareLink(rec.id, source));
        } catch {
            win?.close();
            noteVlc('error', '再生リンクを作れませんでした');
            return;
        }
        const play = `http://${host}/play?id=0&path=${encodeURIComponent(shareUrl)}`;
        if (win === null) {
            // ポップアップを塞がれた。同じタブで開くしかない (戻るで帰れる)
            location.href = play;
            return;
        }
        win.location.href = play;
        setTimeout(() => win.close(), 1500);
        noteVlc('info', 'テレビへ飛ばしました');
        detail.close();
    }

    /**
     * 期限付きの再生リンクを作ってクリップボードへ (`share.ts`)。
     * 出先のプレイヤー (VLC 等) に貼るためのもの。パスワードは入っていない
     */
    async function copyShareLink(id: number): Promise<void> {
        try {
            const { url, expiresAt } = await mintShareLink(id);
            await navigator.clipboard.writeText(url);
            // 有効な長さはサーバの決めごと (share.ts の SHARE_TTL)。文字で固定しない
            const hours = Math.round((expiresAt - Date.now()) / 3_600_000);
            noteVlc('info', `再生リンクをコピーしました (${hours}時間有効)`);
        } catch {
            // 貼れない繋ぎ (http) ではクリップボードが使えない (切り抜きと同じ制約)
            noteVlc('error', 'コピーできませんでした。https で開いているか確かめてください');
        }
    }

    /** 裏で失敗した保存 (Background Fetch)。黙って消えると「無かったことになった」ように見える */
    $effect(() => {
        if (offline.failed === null) return;
        offlineNote = {
            key: `offline-failed-${offline.failed}`,
            kind: 'error',
            text: '端末への保存に失敗しました。もう一度試してください',
        };
        clearFailed();
    });

    /** 押した結果。出す場所と消え方は Toasts が持っている */
    const notices = $derived.by(() => {
        const list: Notice[] = [];
        if (offlineNote !== null) list.push(offlineNote);
        if (vlcNote !== null) list.push(vlcNote);
        list.push(...errorNotice(form, 'dashboard-error'));
        if (form?.reconcile) {
            /*
             * **両方向ぶん出す。** 「実体が無く削除済み」だけ出していた頃は、
             * 逆向き (行の無いファイル) を見ていないことが画面から分からなかった。
             * 動画そのものには触らないので、その数だけは出しておく
             */
            const { checked, removed, swept, strays, pruned } = form.reconcile;
            const parts = [`照合 ${checked} 件`, `ファイルが無く削除済みにした ${removed} 件`];
            if (swept > 0) parts.push(`持ち主の居ない付属ファイルを削除 ${swept} 件`);
            if (pruned > 0) parts.push(`空のフォルダを削除 ${pruned} 件`);
            if (strays > 0) parts.push(`DBに無い動画 ${strays} 件 (消していません)`);
            list.push({ key: 'reconcile-result', kind: 'info', text: parts.join(' / ') });
        }
        return list;
    });

    /**
     * 端末に保存する ([docs/offline.md](../../docs/offline.md))。落とすものは
     * `saveOffline` が決める (既定 AV1、端末が解けなければ H.264)。
     * Background Fetch ならタブを閉じても続くので、押したら詳細は閉じる
     */
    async function saveToDevice(rec: (typeof data.recordings)[number]): Promise<void> {
        try {
            await saveOffline(rec);
            offlineNote = {
                key: `offline-save-${rec.id}`,
                kind: 'info',
                text: `端末への保存を始めました: ${rec.name}`,
            };
        } catch (error) {
            offlineNote = {
                key: `offline-save-${rec.id}`,
                kind: 'error',
                text: error instanceof Error ? error.message : '端末に保存できませんでした',
            };
        }
        detail.close();
    }

    /** 行から開いた番組詳細。番組表と同じ見せ方をする (detail.svelte.ts) */
    const detail = programDetail();
    /** その行が失敗・削除された理由。詳細の中で見せる */
    let detailNotes = $state<{ title: string; text: string }[]>([]);
    /**
     * 何で検出したか。ロゴが効いているかどうかがここで分かる。
     * うまくいったときは持たない (`cmNoteWorthShowing`)
     */
    let detailCmNote = $state<string | null>(null);
    /**
     * 詳細を開いている録画。**予約から開いたときは null。**
     *
     * ダウンロードと録り直しはここから出す。一覧の行に並べていた頃は、
     * 1行あたり4つも5つもボタンが並んで、狭い画面では横に流れていた。
     * どちらもその1本に対する操作なので、中身を見ている場所にある
     */
    let detailRec = $state<(typeof data.recordings)[number] | null>(null);

    /**
     * 行を押したら番組詳細を出す。中身の出し方は `detail` が持っている。
     * ここで決めるのは、その行に添える札 (失敗の理由・CMの判定) だけ。
     */
    function openDetail(
        programId: number | null,
        row: DetailSeed,
        notes: { title: string; text: string }[] = [],
        cmNote: string | null = null,
    ): void {
        // 予約から開いたときは録画のボタンを出さない (openRecording が入れ直す)
        detailRec = null;
        detailNotes = notes;
        detailCmNote = cmNoteWorthShowing(cmNote) ? cmNote : null;
        void detail.open(programId, row);
    }

    /** 削除は2回押させる。挙動は3画面共通 ([arming.svelte.ts](../lib/arming.svelte.ts)) */
    const deleting = arming('[data-testid="delete-button"], [data-testid="delete-confirm"]');

    /**
     * 行のどこを押しても、その行でいちばんやりたいことをする。
     * ボタンやリンクを押したときは邪魔しない。
     *
     * 録画なら**観る画面へ** (`/watch/<id>`)。一覧を開くのは観るためなので、
     * そこを1回で通す。中身を読みたいときは行の中の「詳細」から。
     * 予約は観るものが無いので、そのまま詳細を出す。
     *
     * 跳ぶのは `goto` で — `location.href` だと**文書ごと読み込み直しになり、
     * 押した勢い (user activation) がそこで切れる**。観る画面は開いた時点で
     * 再生と全画面を始めるので (`watch/[id]`)、そこが切れると
     * 「押したのに何も起きない」になる
     */
    function rowClick(event: MouseEvent | KeyboardEvent, watch: string | null, open: () => void): void {
        if (event instanceof KeyboardEvent && event.key !== 'Enter') return;
        if ((event.target as HTMLElement).closest('a, button, input, label')) return;
        if (watch !== null) void goto(watch);
        else open();
    }

    /**
     * その録画を観る画面。**観られないものには無い。**
     *
     * **観られるのは焼いたものだけ。** 生TSは MPEG-2 で、ブラウザに復号器が
     * 無い (docs/stream.md §5.5)。焼き上がるまでは詳細から落として観てもらう。
     *
     * 消したものと、**録画そのものが失敗したもの**も外す。後者は途中まで書けた
     * ファイルが残っていることはあるが、頭からスクランブルが掛かっていたり
     * 中身が空だったりで、押しても何も映らない
     */
    function watchLink(rec: (typeof data.recordings)[number]): string | null {
        if (rec.deleted_at !== null || rec.state === 'failed') return null;
        if (rec.library_path !== null) return `/watch/${rec.id}`;
        /*
         * **焼き上がる前でも観られる。** 録っている最中はもちろん、録り終えて
         * CM検出やエンコードを待っている間も、生TSはある。追っかけ再生の器
         * (`/chase`。ライブと同じくサーバが焼き直して運ぶ) で頭から観られる。
         * 以前は焼き上がるまで行が押せず、30分番組を録り終えたあと数分〜十数分
         * 「観られるのに観られない」時間があった
         */
        if (rec.ts_path !== null) return `/chase/${rec.id}`;
        return null;
    }

    /**
     * ファイルを持っているか。**落とす口を出すかどうか。**
     *
     * **エンコードの失敗はここに出てこない。** 落ちたのは焼き直しのほうで
     * 生TSは無事なので、落とせるし録り直しもできる。エンコードで落ちると
     * 録画の状態まで 'failed' にしていた頃は、中身のあるTSを持っているのに
     * ダウンロードまで消えていた
     */
    function playable(rec: (typeof data.recordings)[number]): boolean {
        if (rec.deleted_at !== null) return false;
        if ((rec.library_path ?? rec.ts_path) === null) return false;
        return rec.state !== 'failed';
    }

    /**
     * 録画の詳細。
     *
     * 失敗の理由は**ここでしか出さない**。一覧の行に生のエラーを並べていた頃は、
     * 数行ぶんの高さを1行が占めて、他の録画が画面から押し出されていた。
     *
     * 理由は3種類あって、それぞれ別物。見出しを付けて分けて渡す。
     * 「エンコードに失敗しました」で全部まとめていた頃は、録画そのものが
     * 失敗した行を開いても嘘の見出しが出ていた
     */
    function openRecording(rec: (typeof data.recordings)[number]): void {
        const notes: { title: string; text: string }[] = [];
        // error 列に入るのは**録画そのものの失敗だけ**。エンコードの理由は encode_error
        if (rec.state === 'failed' && rec.error) {
            notes.push({ title: '録画に失敗しました', text: rec.error });
        }
        if (rec.deleted_at !== null && rec.error) {
            notes.push({ title: '削除された理由', text: rec.error });
        }
        if (rec.encode_error) {
            notes.push({ title: 'エンコードに失敗しました', text: rec.encode_error });
        }
        openDetail(rec.program_id, rec, notes, rec.cm_note);
        detailRec = rec;
    }

    /**
     * 右の一覧の並び。**録れたものと録り逃しを1本にして放送日順で出す。**
     *
     * 録り逃しは「これから録るもの」ではなく**録画の結果**なので、予約側では
     * なくこちらに混ぜる。ただし録画の行を持たない (始まらないまま放送が
     * 終わった — `+page.server.ts` の `missed`) ので、ここで差し込む。
     * 鍵は種類ごとに接頭辞を付ける (録画と予約でIDの空間が別のため)
     */
    type RightRow =
        | { kind: 'rec'; key: string; at: number; rec: (typeof data.recordings)[number] }
        | { kind: 'missed'; key: string; at: number; res: (typeof data.missed)[number] };

    /**
     * 録り逃しの詳細。**失敗した録画と同じ形**で、開いたときに理由を出す。
     * チューナー不足で落とされたものは予約が理由を持っている (conflict_reason)
     */
    function openMissed(res: (typeof data.missed)[number]): void {
        const text =
            res.conflict_reason ?? 'アプリが止まっていた等で、録り始めないまま放送が終わりました';
        openDetail(res.program_id, res, [{ title: '録り逃しました', text }]);
    }
    const rightRows = $derived(
        [
            ...data.recordings.map(
                (rec) => ({ kind: 'rec', key: `rec-${rec.id}`, at: rec.start_at, rec }) as RightRow,
            ),
            ...data.missed.map(
                (res) => ({ kind: 'missed', key: `missed-${res.id}`, at: res.start_at, res }) as RightRow,
            ),
        ].sort((a, b) => b.at - a.at),
    );
</script>

<!-- 聞き返しは他所を触ったら取り下げる (`stand`) -->
<svelte:window onclick={deleting.stand} />

<!--
    予約も録画も、行の形を揃える。

    以前は列に分けた表だった。状態も日時もサイズも1列ずつ持たせていたので、
    タブレットくらいの幅で表そのものが横スクロールになり、番組名が隠れていた。
    列を減らすと今度は画面ごとに出るものが違ってしまう。

    そこで**どの幅でも同じ1つの形**にした。左に「状態 + 番組名 + その他ぜんぶ」、
    右に押すもの。狭いところでは押すものが下へ回り込むだけで、出るものは変わらない。
    押すものは指で押せる大きさ (既定の btn) にしてある
-->
{#snippet title(state: string, badge: string, name: string, testid: string)}
    <div class="flex flex-wrap items-center gap-2">
        <span class="badge whitespace-nowrap {badge}" data-testid={testid}>{state}</span>
        <span class="font-medium break-words">{name}</span>
    </div>
{/snippet}

<!-- 局名・放送日時・尺・サイズ。1行にまとめて、空のものは出さない -->
<!--
    局ロゴは放送波から拾ったもの (`/api/services/<id>/logo`)。**まだ拾えていない局は
    何も出さない** — ライブ画面と違って一覧は行が細く、代わりの箱を置くと局名より目立つ
-->
{#snippet meta(parts: string[], logo: { serviceId: number; has: boolean } | null = null)}
    <div class="text-base-content/60 mt-1 flex flex-wrap items-center gap-x-1.5 text-sm break-words">
        {#if logo?.has}
            <img
                src="/api/services/{logo.serviceId}/logo"
                alt=""
                loading="lazy"
                class="inline-block h-4 w-auto shrink-0 rounded-xs object-contain"
                data-testid="service-logo"
            />
        {/if}
        <span>{parts.filter(Boolean).join(' ・ ')}</span>
    </div>
{/snippet}

<!--
    **何でこの1本が立ったのか。** 予約にも録画にも同じ形で出す。

    録画の側に出していなかった頃は、録れたものを見ても「どのルールが拾ったのか」が
    分からなかった。要らないものが混ざっていたときに、直す先 (どのルールの条件か)
    を探すのに番組名からルールを推し量るしかなかった。

    ルール名をそのまま入口にする。行にボタンを足すと窮屈になる
-->
{#snippet source(ruleId: number | null, ruleName: string | null, manual: boolean)}
    <div class="text-base-content/60 mt-0.5 text-xs" data-testid="rule-name">
        {#if manual}
            手動予約
        {:else}
            ルール:
            {#if ruleId !== null}
                <a class="link" href="/rules?edit={ruleId}">{ruleName}</a>
            {:else}
                (削除済み)
            {/if}
        {/if}
    </div>
{/snippet}

<!--
    広い画面では2つの一覧を横に並べ、画面の残りを丁度使い切る。
    高さをJSで測って入れていた頃は、測る前の当ての値で一度描かれるので
    読み込むたびに一覧が縮んだ状態から伸びて見えた。ここは全部 CSS で決める。

    畳まれる幅 (md 未満) では素直にページごとスクロールさせる。
    小さい画面で中だけスクロールさせると、指の届く範囲が二重になって使いづらい。

    **横に並べはじめる幅は全画面で `md` (768px)**
    ([+layout.svelte](./+layout.svelte) の `FILLED`)。画面ごとに違えていた頃は、
    同じ幅なのに画面によって1段だったり2段だったりした
-->
<div class="md:flex md:h-full md:flex-col">
    <Toasts {notices} source={form} />

    <div class="grid gap-6 md:min-h-0 md:flex-1 md:grid-cols-5">
        <!--
        min-w-0 が無いと、中の表の幅にグリッドの列が引きずられてページごとはみ出す。
        1列に畳まれたときは録画を先に出す(見るのはたいてい録れたほうなので)
    -->
        <section class="order-2 min-w-0 md:order-none md:col-span-2 md:flex md:min-h-0 md:flex-col">
            <div class="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-2">
                <h2 class="text-lg font-bold">予約</h2>
                <!--
                    「競合を再計算」は置いていない。番組表を取り直したときとルールを
                    いじったときに必ず走るので、押す機会が無かった
                -->
                <a class="btn btn-sm" href={data.showFinished ? '/' : '/?all=1'}>
                    {data.showFinished ? '進行中のみ' : '完了分も表示'}
                </a>
            </div>

            <!--
            残りいっぱいまで伸ばして、中だけスクロールさせる。2つ並べたときに、
            片方が長いともう片方が下に置いていかれるため
        -->
            <div class="overflow-auto rounded-box bg-base-100 shadow md:min-h-0 md:flex-1">
                <div class="divide-base-300 divide-y" data-testid="reservation-list">
                    {#each data.reservations as res (res.id)}
                        <!-- 行を押すと番組表と同じ詳細が出る -->
                        <div
                            data-testid="reservation-row"
                            data-reservation-id={res.id}
                            data-program-id={res.program_id}
                            class="hover:bg-base-200/60 relative cursor-pointer p-3"
                            role="button"
                            tabindex="0"
                            onclick={(event) => rowClick(event, null, () => openDetail(res.program_id, res))}
                            onkeydown={(event) =>
                                rowClick(event, null, () => openDetail(res.program_id, res))}
                        >
                            <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
                                <div class="min-w-0 flex-1 basis-56" data-testid="row-body">
                                    {@render title(
                                        stateLabel(res.state),
                                        badgeClass(res.state),
                                        res.name,
                                        'reservation-state',
                                    )}
                                    {@render meta(
                                        [
                                            res.service_name,
                                            `${dateTime(res.start_at)}〜${time(res.end_at)} (${duration(res.start_at, res.end_at)})`,
                                        ],
                                        { serviceId: res.service_id, has: res.has_logo === 1 },
                                    )}
                                    {#if res.conflict_reason}
                                        <div class="text-error mt-0.5 text-sm">{res.conflict_reason}</div>
                                    {/if}
                                    <!--
                                        手動なら何も出さない。既定と違うときだけ言う。
                                        **録画の側では手動とも書く** — 録れたものは後から
                                        見返すので、「ルールではない」ことにも意味がある
                                    -->
                                    {#if !res.manual}
                                        {@render source(res.rule_id, res.rule_name, false)}
                                    {/if}
                                    <!--
                                        **焼き方の札は出さない。**

                                        予約の行にも「TSのみ」「生TSも残す」が写して
                                        あったが、それは予約を立てた時点の値で、実際に
                                        効くのは**焼くときの設定** (settings)。
                                        設定を変えても札は昔のまま残るので、画面が
                                        嘘をついていた。決まるところは設定画面ひとつ
                                    -->
                                </div>

                                <div class="flex shrink-0 flex-wrap items-center gap-2">
                                    {#if res.recording_id !== null}
                                        <!-- 追っかけ再生 (issue #16)。録っている最中でも頭から観られる -->
                                        <a
                                            class="btn btn-primary"
                                            href="/chase/{res.recording_id}"
                                            data-testid="chase-button"
                                        >
                                            追っかけ
                                        </a>
                                    {/if}
                                    {#if active.includes(res.state)}
                                        <form method="POST" action="?/cancel" use:submitting>
                                            <input type="hidden" name="id" value={res.id} />
                                            <button type="submit"
                                                class="btn btn-error btn-outline"
                                                data-testid="cancel-button"
                                            >
                                                取消
                                            </button>
                                        </form>
                                    {:else if res.state === 'canceled' && res.end_at > Date.now()}
                                        <!--
                                            取り消した予約はルールが作り直さないので、
                                            気が変わったときに戻せるのはここだけ
                                        -->
                                        <form method="POST" action="?/restore" use:submitting>
                                            <input type="hidden" name="id" value={res.id} />
                                            <button type="submit" class="btn" data-testid="restore-button">戻す</button>
                                        </form>
                                    {/if}
                                </div>
                            </div>
                        </div>
                    {:else}
                        <div class="text-base-content/60 p-3">予約はありません</div>
                    {/each}
                </div>
            </div>
        </section>

        <section class="order-1 min-w-0 md:order-none md:col-span-3 md:flex md:min-h-0 md:flex-col">
            <!-- 見出しの高さと下の余白は予約側と揃える。並べたときにずれて見えるため -->
            <div class="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-2">
                <h2 class="text-lg font-bold">録画</h2>
                <div class="flex flex-wrap items-center gap-2">
                    <!--
                        **絞り込み。** 溜まると300件フラットは指のリモコンで辿れない。
                        番組名・シリーズ・副題・局にかかる (`+page.server.ts`)。GET なので
                        URL に残り、共有・戻るがそのまま効く。削除済み表示は引き継ぐ
                    -->
                    <form method="GET" action="/" class="join" data-sveltekit-keepfocus>
                        {#if data.showDeleted}
                            <input type="hidden" name="deleted" value="1" />
                        {/if}
                        <input
                            type="search"
                            name="q"
                            value={data.q}
                            placeholder="番組名・シリーズ・副題・局で絞り込み"
                            aria-label="録画を絞り込む"
                            class="input input-sm input-bordered join-item w-40 sm:w-56"
                            data-testid="recording-search"
                        />
                        <button type="submit" class="btn btn-sm join-item">絞り込む</button>
                    </form>
                    {#if data.q !== ''}
                        <a
                            class="btn btn-sm btn-ghost"
                            href={data.showDeleted ? '/?deleted=1' : '/'}
                            data-testid="recording-search-clear"
                        >
                            解除
                        </a>
                    {/if}
                    <a class="btn btn-sm" href={data.showDeleted ? '/' : '/?deleted=1'}>
                        {data.showDeleted ? '削除済みを隠す' : '削除済みも表示'}
                    </a>
                    <form method="POST" action="?/reconcile" use:submitting>
                        <button type="submit" class="btn btn-sm" data-testid="reconcile-button">ファイルと照合</button>
                    </form>
                </div>
            </div>

            <!--
            残りいっぱいまで伸ばして、中だけスクロールさせる。2つ並べたときに、
            片方が長いともう片方が下に置いていかれるため
        -->
            <div class="overflow-auto rounded-box bg-base-100 shadow md:min-h-0 md:flex-1">
                <div class="divide-base-300 divide-y" data-testid="recording-list">
                    {#each rightRows as row (row.key)}
                    {#if row.kind === 'missed'}
                        {@const res = row.res}
                        <!--
                            録り逃し。観るものが無いので、押すと詳細だけ出す (予約の行と
                            同じ扱い)。ボタンも置かない — 放送は終わっているので、
                            この行からできることが無い (再放送は番組表から予約し直す)
                        -->
                        <div
                            data-testid="missed-row"
                            data-program-id={res.program_id}
                            class="hover:bg-base-200/60 relative cursor-pointer p-3"
                            role="button"
                            tabindex="0"
                            onclick={(event) => rowClick(event, null, () => openMissed(res))}
                            onkeydown={(event) => rowClick(event, null, () => openMissed(res))}
                        >
                            <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
                                <div class="min-w-0 flex-1 basis-56" data-testid="row-body">
                                    {@render title(stateLabel('missed'), badgeClass('missed'), res.name, 'missed-state')}
                                    {@render meta(
                                        [
                                            res.service_name,
                                            `${dateTime(res.start_at)}〜${time(res.end_at)} (${duration(res.start_at, res.end_at)})`,
                                        ],
                                        { serviceId: res.service_id, has: res.has_logo === 1 },
                                    )}
                                    <!-- 録画側の流儀に合わせて手動とも書く (見返すものなので) -->
                                    {@render source(res.rule_id, res.rule_name, res.manual === 1)}
                                </div>
                                <!--
                                    確かめ終わったら畳める (録画の削除と同じ2回押し)。
                                    消すのは予約の行 (`?/deleteMissed`) — 録画の行が無いので。
                                    構えの鍵は負の値にして、録画のIDと混ざらないようにする
                                    (deleting は録画と共用で、IDの空間が別のため)
                                -->
                                <div class="flex shrink-0 flex-wrap items-center gap-2">
                                    <form method="POST" action="?/deleteMissed" use:submitting>
                                        <input type="hidden" name="id" value={res.id} />
                                        {#if deleting.armed === -res.id}
                                            <button type="submit" class="btn btn-error" data-testid="delete-confirm">
                                                確定
                                            </button>
                                        {:else}
                                            <button
                                                type="button"
                                                class="btn btn-error btn-outline"
                                                onclick={() => deleting.arm(-res.id)}
                                                data-testid="delete-button"
                                            >
                                                削除
                                            </button>
                                        {/if}
                                    </form>
                                </div>
                            </div>
                        </div>
                    {:else}
                        {@const rec = row.rec}
                        <!--
                            録り直しの元になるのは生TS。エンコード済みを元にしても画質は
                            戻らないので、生TSがあるときだけ出す。
                            録画中は元がまだ書かれている最中なので触らせない
                        -->
                        {@const link = watchLink(rec)}
                        {@const canPlay = link !== null}
                        {@const shown = rowState(rec)}
                        <!--
                            押すと再生。中身を読みたいときは行の中の「詳細」から。

                            **吹き出し (title) は出さない。** 行に指を乗せると色が反転し、
                            再生の印も出ているので、そこを押せば再生になることは見れば分かる。
                            出していた頃は、行を読もうとするたびに文字の上へ札が被さっていた。

                            置き場と尺と**切ったCMの位置**は属性にだけ持たせる。普段は見ない
                            もので (CM の位置はチャプターとして動画に入っている)、
                            画面に並べると番組名を押し出すが、確かめる手段は残しておきたい
                        -->
                        <div
                            data-testid="recording-row"
                            data-recording-id={rec.id}
                            data-program-id={rec.program_id}
                            data-library-path={rec.library_path}
                            data-alt-path={rec.alt_path}
                            data-duration-ms={rec.duration_ms}
                            data-cm-ranges={rec.cm_ranges}
                            class="group hover:bg-base-200/60 relative cursor-pointer p-3"
                            role="button"
                            tabindex="0"
                            onclick={(event) => rowClick(event, link, () => openRecording(rec))}
                            onkeydown={(event) => rowClick(event, link, () => openRecording(rec))}
                        >
                            <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
                                <!--
                                    再生の印。**押すもの (button) にはしない。**
                                    行そのものが再生なので、同じ働きの的を二重に置くと
                                    「印を外すと再生されない」ように見える。
                                    行に指を乗せると色が反転して、押す先がここだと分かる
                                -->
                                {#if canPlay}
                                    <!--
                                        **ポスターを出す。** 焼いたときに動画の隣へ置いた
                                        `-poster.jpg` (`api/.../poster`)。文字だけの行より
                                        ずっと選びやすい。**無い録画もある**
                                        (ポスターより前に焼いたもの等) ので、読めなければ絵を
                                        隠して枠だけ残す (`onerror`)。枠と再生印はいつでも出す
                                    -->
                                    <div
                                        class="bg-base-300 relative mt-0.5 aspect-video w-16 shrink-0 overflow-hidden rounded sm:w-24"
                                        data-testid="play-hint"
                                    >
                                        {#if rec.library_path !== null}
                                            <img
                                                src="/api/recordings/{rec.id}/poster"
                                                alt=""
                                                loading="lazy"
                                                class="h-full w-full object-cover"
                                                onerror={(event) => {
                                                    (event.currentTarget as HTMLImageElement).style.display =
                                                        'none';
                                                }}
                                            />
                                        {/if}
                                        <span
                                            class="text-primary-content absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/40"
                                            aria-hidden="true"
                                        >
                                            <svg
                                                viewBox="0 0 24 24"
                                                class="size-6 opacity-0 drop-shadow transition-opacity group-hover:opacity-100"
                                                fill="currentColor"
                                                aria-hidden="true"
                                            >
                                                <path d="M8 5v14l11-7z" />
                                            </svg>
                                        </span>
                                    </div>
                                {/if}
                                <div class="min-w-0 flex-1 basis-56" data-testid="row-body">
                                    <!--
                                        録画の状態とエンコードの状態を1つにまとめて出す
                                        (rowState)。消したもの (deleted) も録画の状態から
                                        決まるので、ここで書き分けることは何も無い
                                    -->
                                    {@render title(shown.label, shown.badge, rec.name, 'recording-state')}
                                    {#if offline.entries[rec.id] !== undefined}
                                        {@const held = offline.entries[rec.id]}
                                        <!-- 端末に入っている印。保存中はエンコードと同じく割合を添える -->
                                        <span
                                            class="badge badge-sm mt-1 {held.state === 'ready'
                                                ? 'badge-success'
                                                : held.state === 'failed'
                                                  ? 'badge-error'
                                                  : 'badge-ghost'}"
                                            data-testid="offline-badge"
                                        >
                                            {held.state === 'ready'
                                                ? '端末に保存済み'
                                                : held.state === 'failed'
                                                  ? '端末に保存できませんでした — 詳細からやり直せます'
                                                  : `端末に保存中${held.progress === null ? '…' : ` ${percent(held.progress)}`}`}
                                        </span>
                                    {/if}
                                    <!--
                                        放送日時・尺・サイズは1行にまとめる。列に分けていた頃は、
                                        画面が狭いと表ごと横スクロールになって番組名まで隠れていた。
                                        ファイルの置き場所は普段は見ないので出さない (data-library-path)
                                    -->
                                    {@render meta(
                                        [
                                            rec.service_name,
                                            // 番組表の尺ではなく実際に録れた長さ。
                                            // 途中で止めたときやCMを切ったときは合わない
                                            `${dateTime(rec.start_at)} (${recordedDuration(rec)})`,
                                            // 在るものは全部出す (`sizeLabel`)。片方しか
                                            // 出していなかった頃は、消していいのか・
                                            // どれだけ空くのかが画面から分からなかった
                                            sizeLabel(rec),
                                            rec.deleted_at !== null ? `${date(rec.deleted_at)} に削除` : '',
                                        ],
                                        { serviceId: rec.service_id, has: rec.has_logo === 1 },
                                    )}
                                    <!--
                                        **途中まで観たものは残りを出す。** 観た位置
                                        (`resume_ms`) は続きから始めるために持っていて、末尾まで
                                        観たものは消える (`api/.../resume`) ので、**残っている =
                                        まだ途中**。押せば `/watch` が続きから始める。
                                        分母は実際に録れた長さ。無ければ番組表の尺で代用する。
                                        添える言葉は割合ではなく**あと何分か** — 「観終わるのに
                                        どれだけ掛かるか」が知りたいことで、4% では換算がいる
                                    -->
                                    {#if canPlay && rec.deleted_at === null && rec.resume_ms !== null && rec.resume_ms > 0}
                                        {@const total = rec.duration_ms ?? rec.end_at - rec.start_at}
                                        {@const frac =
                                            total > 0 ? Math.min(1, rec.resume_ms / total) : 0}
                                        <div
                                            class="mt-1.5 flex items-center gap-2"
                                            data-testid="recording-progress"
                                        >
                                            <div
                                                class="bg-base-300 h-1 min-w-0 flex-1 overflow-hidden rounded-full"
                                            >
                                                <div
                                                    class="bg-primary h-full"
                                                    style="width: {frac * 100}%"
                                                ></div>
                                            </div>
                                            <span
                                                class="text-base-content/60 shrink-0 text-xs tabular-nums"
                                            >
                                                残り{durationMs(Math.max(0, total - rec.resume_ms))}
                                            </span>
                                        </div>
                                    {/if}
                                    <!--
                                        何で録れた1本か。**予約から来たものだけ**。
                                        取り込んだ録画 (EPGStation から引き継いだもの) には
                                        予約が無いので、何も出さない
                                    -->
                                    {#if rec.from_manual !== null}
                                        {@render source(rec.rule_id, rec.rule_name, rec.from_manual === 1)}
                                    {/if}
                                    <!--
                                        失敗や削除の理由は行に出さない。生のエラーは数行あって、
                                        1行がその高さを占めると他の録画が画面から押し出される。
                                        状態はバッジで分かるので、中身は「詳細」に回す (openRecording)
                                    -->
                                    <!-- CM をどこで検出したかは行に出さない。長くて場所を食う割に
                                         普段は見ないので、行を押したときの詳細に回す -->
                                    {#if logoUnusable(rec.cm_note) && rec.deleted_at === null}
                                        <!--
                                            ロゴでの判定が使えなかったので、無音だけでCMを判定している。
                                            精度が落ちているのを黙っていると「なぜか切れていない」に
                                            なるので出す。**位置を教える口はチューナー画面にある** —
                                            録画ごとではなく局ごとの話で、教えれば以降の全部に効く。

                                            **見つけられなかったときだけではない。** ロゴには合致した
                                            のに結果が使い物にならなかったとき (番組の 100% がCM判定など)
                                            も、覚えているほうが怪しいので同じ口を出す
                                        -->
                                        <div class="text-warning mt-0.5 text-sm" data-testid="logo-missing">
                                            ロゴでのCM判定に失敗 (無音のみで判定)
                                            <span class="text-base-content/60"
                                                >— チューナー画面でロゴの位置を教えられます</span
                                            >
                                        </div>
                                    {/if}
                                    <!--
                                        エンコード中だけ、割合と残りの見込みを添える。
                                        ffmpeg が回っていない段階 (解除中・CM検出中) は
                                        進み具合が取れないので、代わりに**いま何をしているか**を出す。
                                        CM検出は中で3つの道具を数分ずつ回すので、
                                        段階の名前だけだと止まっているように見えていた
                                    -->
                                    {#if rec.job_state === 'running' && rec.job_phase === 'encode'}
                                        <!-- SSE の生放送 (encode-live) があればそちら。読み直しを待たずに動く -->
                                        {@const live = encodeLive.entries[rec.id]}
                                        {@const liveEta = live !== undefined ? live.etaMs : rec.job_eta_ms}
                                        <div
                                            class="text-base-content/60 mt-0.5 text-xs"
                                            data-testid="encode-progress"
                                        >
                                            {percent(live?.percent ?? rec.job_percent ?? 0)}
                                            {#if eta(liveEta)}・{eta(liveEta)}{/if}
                                        </div>
                                    {:else if rec.job_state === 'running' && rec.job_log}
                                        <div
                                            class="text-base-content/60 mt-0.5 text-xs"
                                            data-testid="encode-step"
                                        >
                                            {rec.job_log}
                                        </div>
                                    {/if}
                                </div>

                                <!--
                                    押すものはすべて枠付きにする。btn-ghost は枠も背景も
                                    無いので、行の文字と見分けが付かず、どこからどこまでが
                                    押せるのか分からなかった
                                -->
                                <div class="flex shrink-0 flex-wrap items-center gap-2">
                                    <!--
                                        中身を読む入口は、**行を押しても詳細にならない行だけ**に置く。
                                        観られる行は押すと再生に行くので、説明やCMの位置を見たい
                                        ときの別口が要る。観られない行 (録画そのものの失敗・
                                        削除済み・まだ何も録れていない) は行そのものが詳細の
                                        入口 (rowClick) なので、同じ働きのボタンを並べない
                                        (録り逃しの行とも揃う)。焼いている最中は観られる (追っかけ)
                                    -->
                                    {#if canPlay}
                                        <button
                                            type="button"
                                            class="btn btn-outline"
                                            onclick={() => openRecording(rec)}
                                            data-testid="detail-button"
                                        >
                                            詳細
                                        </button>
                                    {/if}
                                    {#if rec.deleted_at === null}
                                        <!--
                                            **ダウンロードと録り直しは詳細の中に置いてある。**
                                            行に並べていた頃は1行に4つも5つもボタンが載って、
                                            狭い画面では横に流れていた。行そのものが再生なので、
                                            ここに残すのは「詳細」と、取り返しのつかない削除だけ
                                        -->
                                        {#if rec.job_id !== null}
                                            <!--
                                                動いている間は中止だけ。この裏で ffmpeg が
                                                元のTSを読んでいるので、消させると道連れになる
                                            -->
                                            <form method="POST" action="?/cancelEncode" use:submitting>
                                                <input type="hidden" name="id" value={rec.job_id} />
                                                <button type="submit"
                                                    class="btn btn-error btn-outline"
                                                    data-testid="encode-cancel"
                                                >
                                                    エンコード中止
                                                </button>
                                            </form>
                                        {:else}
                                            <!-- サーバから消したら、端末に落としてあったコピーも片付ける -->
                                            <form
                                                method="POST"
                                                action="?/delete"
                                                use:submitting={() => async (options) => {
                                                    await options.update();
                                                    if (
                                                        options.result.type === 'success' &&
                                                        offline.entries[rec.id] !== undefined
                                                    ) {
                                                        void removeLocal(rec.id);
                                                    }
                                                }}
                                            >
                                                <input type="hidden" name="id" value={rec.id} />
                                                {#if deleting.armed === rec.id}
                                                    <!-- 幅が変わるとボタンが動いて押し間違える。2文字で揃える -->
                                                    <button type="submit"
                                                        class="btn btn-error"
                                                        data-testid="delete-confirm"
                                                    >
                                                        確定
                                                    </button>
                                                {:else}
                                                    <button
                                                        type="button"
                                                        class="btn btn-error btn-outline"
                                                        onclick={() => deleting.arm(rec.id)}
                                                        data-testid="delete-button"
                                                    >
                                                        削除
                                                    </button>
                                                {/if}
                                            </form>
                                        {/if}
                                    {/if}
                                </div>
                            </div>

                            <!--
                                進み具合は行の下端いっぱいに敷く。別の行に分けていた頃は、
                                行と行の間に隙間ができて、どの録画のものか分かりにくかった。

                                ffmpeg が回っていない段階でも割合を出すようにしたが、
                                取れないものもあるので、そのときは動いているだけのバーにする
                            -->
                            {#if rec.job_id !== null}
                                {@const barPercent = encodeLive.entries[rec.id]?.percent ?? rec.job_percent ?? 0}
                                <progress
                                    class="progress progress-primary absolute inset-x-0 bottom-0 h-1 w-full rounded-none"
                                    value={rec.job_state === 'running' && barPercent > 0
                                        ? barPercent
                                        : undefined}
                                    max="1"
                                    data-testid="encode-bar"
                                ></progress>
                            {:else if offline.entries[rec.id]?.state === 'downloading'}
                                <!-- 端末への保存もエンコードと同じ見せ方。測れない間は動くだけのバー -->
                                <progress
                                    class="progress progress-success absolute inset-x-0 bottom-0 h-1 w-full rounded-none"
                                    value={offline.entries[rec.id].progress ?? undefined}
                                    max="1"
                                    data-testid="offline-bar"
                                ></progress>
                            {/if}
                        </div>
                    {/if}
                    {:else}
                        <div class="text-base-content/60 p-3">
                            {data.q === '' ? '録画はありません' : `「${data.q}」に一致する録画はありません`}
                        </div>
                    {/each}
                    <!--
                        **300件で頭打ちなのを黙らない。** 溜まると古いものが黙って
                        消え、「消えた」ように見える。上限に当たっていたら、絞り込みへ
                        誘う一行を出す (`+page.server.ts` の LIMIT 300)
                    -->
                    {#if data.recordings.length >= 300}
                        <div
                            class="text-base-content/60 border-base-300 border-t p-3 text-sm"
                            data-testid="recording-truncated"
                        >
                            新しい順に300件まで表示しています。古いものは絞り込みで探してください。
                        </div>
                    {/if}
                </div>
            </div>
        </section>
    </div>
</div>

{#if detail.current}
    <ProgramDetail
        program={detail.current}
        notes={detailNotes}
        cmNote={detailCmNote}
        onclose={() => detail.close()}
        fps={detailRec?.fps ?? null}
        actions={detailRec === null ? undefined : recordingActions}
    />
{/if}

<!--
    その1本に対する操作。**一覧の行ではなくここに置く。**

    行に並べていた頃は「詳細・ダウンロード・再エンコード・削除」が横に並び、
    狭い画面では枠から流れ出していた。再生は行そのものなので、行に残すのは
    入口 (詳細) と、取り返しのつかない削除だけにしてある
-->
{#snippet recordingActions()}
    {#if detailRec !== null}
        {@const rec = detailRec}
        {#if rec.deleted_at === null && playable(rec)}
            <!--
                **並べるのはよく押すものだけ** — テレビへ飛ばすのと、端末に保存。
                条件が揃うと10個のボタンが同じ見た目で並び、狭い画面では文字の
                途中で折り返していた。めったに押さないもの (落とす・リンクを
                コピー・焼き直し) は「その他…」に畳む。
            -->
            <!--
                **テレビの VLC に、この端末から飛ばして再生させる** (`playOnTv`)。
                渡すのは期限付きの再生リンクなので、テレビ側にパスワードは残らない。
                出るのは設定に並べたテレビだけ — 1台も無ければボタンごと出ない。
                詳細でIPをその場入力する口も置いていた (自動で設定に載せる) が、
                めったに使わないので落とした。テレビは設定で並べる
            -->
            {#each data.vlcTargets as tv (tv.host)}
                <button
                    type="button"
                    class="btn btn-outline"
                    onclick={() => playOnTv(tv, rec)}
                    data-testid="vlc-play-button"
                >
                    ▶ {data.vlcTargets.length === 1 ? 'テレビで再生' : tv.name}
                </button>
            {/each}
            {#if offline.usable && rec.library_path !== null}
                <!--
                    **端末に保存 (オフライン視聴)。** 落とすのは焼いたもの
                    (docs/offline.md)。生TSしか無い録画はブラウザで再生できない
                    ので出さない。保存済みなら「端末から消す」に変わる —
                    こちらはサーバの録画に触らない (行の削除ボタンとは別)
                -->
                {#if offline.entries[rec.id] === undefined || offline.entries[rec.id].state === 'failed'}
                    <button
                        type="button"
                        class="btn btn-outline"
                        onclick={() => saveToDevice(rec)}
                        data-testid="offline-save-button"
                    >
                        {offline.entries[rec.id]?.state === 'failed' ? '保存をやり直す' : '端末に保存'}
                    </button>
                {/if}
                {#if offline.entries[rec.id] !== undefined}
                    <button
                        type="button"
                        class="btn btn-outline"
                        onclick={async () => {
                            await removeLocal(rec.id);
                            detail.close();
                        }}
                        data-testid="offline-remove-button"
                    >
                        {offline.entries[rec.id].state === 'downloading'
                            ? '保存を取り消す'
                            : offline.entries[rec.id].state === 'failed'
                              ? '失敗した保存データを消す'
                              : '端末から消す'}
                    </button>
                {/if}
            {/if}
            <!--
                **めったに押さないものの置き場。** 上に開く (フッターは画面の
                下端に居るので、下に開くと枠から出る)。中身は上から
                「持ち出す」「渡す」「直す」の順。

                **開閉は focus 任せ** (daisyUI の dropdown)。トリガーを button に
                すると Safari がクリックで focus を入れず開かないので、
                role="button" の div にしてある。

                **`static` で、メニューの基準をボタンから枠 (modal-action) に移す。**
                ボタン基準だとメニュー (w-64) はボタンの右端から左へ伸びる。
                スマホ幅でフッターが折り返してボタンが真ん中あたりに来ると、
                左へ伸びた分が modal-box からはみ出して切れていた
            -->
            <div class="dropdown dropdown-top dropdown-end static">
                <div tabindex="0" role="button" class="btn btn-outline" data-testid="detail-more">その他…</div>
                <!--
                    **dropdown-content 自身に display 系のクラスを載せない。**
                    daisyUI は閉じている間を display:none にするが、Tailwind の
                    `flex` はそれより強く効いて (utilities 直下 > daisyui のサブレイヤー)
                    **常時 display:flex** になる。opacity は 0 のままなので、
                    「その他…」の真上に見えないメニューが居座って、押すと見えない
                    「ダウンロード」が発火していた (実機で発覚)。縦積みは内側の div で
                -->
                <div
                    class="dropdown-content bg-base-100 rounded-box border-base-300 z-10 mb-1 w-64 max-w-full border p-2 shadow-lg"
                >
                    <div class="flex flex-col">
                    <!--
                        まだエンコードしていないものや、引き継いだ未エンコードの録画は
                        生TSしか無い。配信は library_path ?? ts_path を返すので、
                        どちらかがあれば落とせる。形式が複数あるときはラベルに添えて
                        並べる (「AV1」だけの札では、押すと何が起きるのか読めなかった)。
                        **押したら閉じる** — 落とし始めたあとも詳細が残っていると、
                        押せたのかどうかが分からない
                    -->
                    <button
                        type="button"
                        class="btn btn-ghost justify-start"
                        onclick={() => download(rec.id, bothFiles(rec) || hasAlt(rec) ? 'encoded' : undefined)}
                        data-testid="download-link"
                    >
                        {hasAlt(rec)
                            ? 'ダウンロード (AV1)'
                            : bothFiles(rec)
                              ? 'ダウンロード (エンコード済み)'
                              : 'ダウンロード'}
                    </button>
                    {#if hasAlt(rec)}
                        <!-- 両方のコーデックを焼いた録画でだけ。AV1 を解けない相手はこちら -->
                        <button
                            type="button"
                            class="btn btn-ghost justify-start"
                            onclick={() => download(rec.id, 'alt')}
                            data-testid="download-alt-link"
                        >
                            ダウンロード (H.264)
                        </button>
                    {/if}
                    {#if bothFiles(rec)}
                        <!-- 元も落とせるように。両方残っているときだけ (`bothFiles`) -->
                        <button
                            type="button"
                            class="btn btn-ghost justify-start"
                            onclick={() => download(rec.id, 'ts')}
                            data-testid="download-ts-link"
                        >
                            ダウンロード (生TS)
                        </button>
                    {/if}
                    <!--
                        **出先のプレイヤー向けの再生リンク** (share.ts)。24時間で
                        切れるので、他人の機器の履歴に残っても腐るだけ。
                        コピーしたら畳む (blur) — 開いたままだと押せたのか分からない
                    -->
                    <button
                        type="button"
                        class="btn btn-ghost justify-start"
                        onclick={(event) => {
                            (event.currentTarget as HTMLElement).blur();
                            void copyShareLink(rec.id);
                        }}
                        data-testid="share-link-button"
                    >
                        再生リンクをコピー
                    </button>
                    {#if rec.job_id === null && encodeSource(rec) !== null}
                        <!--
                            録り直しの元になるのは生TS。エンコード済みを元にしても
                            画質は戻らないので、生TSがあるときだけ出す。

                            **閉じるのは投げ終わってから。** 先に閉じると、断られた
                            ときの知らせ (Toasts) が出る前に画面が変わってしまう
                        -->
                        <form
                            method="POST"
                            action="?/reencode"
                            class="contents"
                            use:submitting={() => async (options) => {
                                await options.update();
                                detail.close();
                            }}
                        >
                            <input type="hidden" name="id" value={rec.id} />
                            <button type="submit" class="btn btn-ghost justify-start" data-testid="reencode-button">
                                再エンコード
                            </button>
                        </form>
                    {/if}
                    </div>
                </div>
            </div>
        {/if}
    {/if}
    <button type="button" class="btn" onclick={() => detail.close()} data-testid="detail-close">閉じる</button>
{/snippet}
