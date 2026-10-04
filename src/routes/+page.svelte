<script lang="ts">
    import { DropdownMenu } from 'bits-ui';
    import { onMount, tick, untrack } from 'svelte';
    import { submitting } from '#lib/actions.js';
    import { arming } from '#lib/arming.svelte.js';
    import ProgramDetail from '#lib/components/ProgramDetail.svelte';
    import Toasts, { errorNotice, type Notice } from '#lib/components/Toasts.svelte';
    import { type DetailSeed, programDetail } from '#lib/detail.svelte.js';
    import { startDownload } from '#lib/download.js';
    import { applyEncodeProgress, encodeLive } from '#lib/encode-live.svelte.js';
    import {
        badgeClass,
        clipNote,
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
    } from '#lib/format.js';
    import { liveUpdates } from '#lib/live-updates.svelte.js';
    import { clearFailed, offline, removeLocal, saveOffline } from '#lib/offline.svelte.js';
    import { matches } from '#lib/paging.js';
    import { Paged, sentinel } from '#lib/paging.svelte.js';
    import { encodeSource, type FileSource } from '#lib/source.js';
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';

    let { data, form } = $props();

    // 予約・録画のどちらが動いてもサーバが知らせてくる。
    // エンコードの進み具合だけは中身ごと届き、読み直さず行の数字を書き換える
    liveUpdates(['recordings', 'reservations'], { encode: applyEncodeProgress });

    const active = ['scheduled', 'conflict', 'recording'];

    /*
     * ダウンロードは押されてから期限付きの署名URLを作って始める (`#lib/download.js`)。
     * 資格情報を URL に埋めていた頃は、パスワードがダウンロード履歴に残り続けた
     */
    function download(id: number, source?: FileSource): void {
        void startDownload(id, source).then((ok) => {
            if (!ok) noteAction('error', 'ダウンロードのリンクを作れませんでした');
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

    /** リンクコピー・ダウンロードの結果。こちらもフォームではないので自前で持つ */
    let actionNote = $state<Notice | null>(null);

    function noteAction(kind: 'info' | 'error', text: string): void {
        actionNote = { key: `action-${Date.now()}`, kind, text };
    }

    /**
     * 閉じた (自分で消えた) 知らせは持ち主が捨てる。
     *
     * 持ったままにしていた頃は、**別のボタンを押すたびに前の知らせが
     * 蘇っていた** — Toasts は返事 (`form`) が変わると閉じたことを忘れる作りで
     * (同じ失敗を2回したときに2回出すため)、フォームではないこちらの知らせまで
     * 一緒に出し直していた
     */
    function dropNote(key: string): void {
        if (actionNote?.key === key) actionNote = null;
        if (offlineNote?.key === key) offlineNote = null;
    }

    /** 期限付きの再生リンクを作る (share.ts) */
    async function mintShareLink(id: number): Promise<{ url: string; expiresAt: number }> {
        const res = await fetch(resolve(`api/recordings/${id}/share`), { method: 'POST' });
        return await res.json();
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
            noteAction('info', `再生リンクをコピーしました (${hours}時間有効)`);
        } catch {
            // 貼れない繋ぎ (http) ではクリップボードが使えない (切り抜きと同じ制約)
            noteAction('error', 'コピーできませんでした。https で開いているか確かめてください');
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
        if (actionNote !== null) list.push(actionNote);
        list.push(...errorNotice(form, 'dashboard-error'));
        if (form?.reconcile) {
            /*
             * **両方向ぶん出す。** 「実体が無く削除済み」だけ出していた頃は、
             * 逆向き (行の無いファイル) を見ていないことが画面から分からなかった。
             * 動画そのものには触らないので、その数だけは出しておく
             */
            const { checked, removed, swept, strays, pruned } = form.reconcile;
            const parts = [`照合 ${checked} 件`, `ファイルが無いため削除済みにした ${removed} 件`];
            if (swept > 0) parts.push(`録画の無い付属ファイルを削除 ${swept} 件`);
            if (pruned > 0) parts.push(`空のフォルダを削除 ${pruned} 件`);
            if (strays > 0) parts.push(`DB に無い動画 ${strays} 件 (残してあります)`);
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
    /** 詳細を開いている録画。**予約から開いたときは null** (操作は recordingActions) */
    let detailRec = $state<(typeof data.recordings)[number] | null>(null);
    /**
     * 詳細を開いている予約。**録画・録り逃しから開いたときは null** (操作は reservationActions)。
     *
     * 行そのものではなく ID で持ち、いまの一覧から引き直す。知らせで読み直すと
     * 状態が変わる (予約済み → 録画中) ので、掴んだ行のままだと出す口がずれる
     */
    let detailResId = $state<number | null>(null);
    const detailRes = $derived(
        detailResId === null ? null : (data.reservations.find((res) => res.id === detailResId) ?? null),
    );

    /** 予約・録り逃しの行に出す放送の枠 */
    function airing(row: { start_at: number; end_at: number }): string {
        return `${dateTime(row.start_at)}〜${time(row.end_at)} (${duration(row.start_at, row.end_at)})`;
    }

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
        // 開いた行の操作だけ出す。録画は openRecording、予約は openReservation が入れ直す
        detailRec = null;
        detailResId = null;
        detailNotes = notes;
        detailCmNote = cmNoteWorthShowing(cmNote) ? cmNote : null;
        void detail.open(programId, row);
    }

    /** 予約の行から開く。取消を詳細の中にも出す (reservationActions) */
    function openReservation(res: (typeof data.reservations)[number]): void {
        openDetail(res.program_id, res);
        detailResId = res.id;
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
     * 焼いたものは `/watch`、焼く前は生TSを `/chase` で観る (下)。
     *
     * 消したものと、**録画そのものが失敗したもの**も外す。後者は途中まで書けた
     * ファイルが残っていることはあるが、頭からスクランブルが掛かっていたり
     * 中身が空だったりで、押しても何も映らない
     */
    function watchLink(rec: (typeof data.recordings)[number]): string | null {
        if (rec.deleted_at !== null || rec.state === 'failed') return null;
        if (rec.library_path !== null) return resolve(`watch/${rec.id}`);
        /*
         * **焼き上がる前でも観られる。** 録っている最中はもちろん、録り終えて
         * CM検出やエンコードを待っている間も、生TSはある。追っかけ再生の器
         * (`/chase`。ライブと同じくサーバが焼き直して運ぶ) で頭から観られる。
         * 以前は焼き上がるまで行が押せず、30分番組を録り終えたあと数分〜十数分
         * 「観られるのに観られない」時間があった
         */
        if (rec.ts_path !== null) return resolve(`chase/${rec.id}`);
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
    function hasFile(rec: (typeof data.recordings)[number]): boolean {
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
            res.conflict_reason ?? 'アプリが止まっていたなどの理由で、録画を始められないまま放送が終わりました';
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

    /*
     * **一覧は少しずつ出す** (`#lib/paging.svelte.js`)。
     *
     * 予約も録画も 300 件まで来る。全部を一度に描くと、この画面を開いた直後に
     * 一瞬止まって見えた (行ごとにボタンとポスターがあるので、描くのが重い)。
     * 最初は1画面と少しだけ描き、下端に近づいたら足す。
     *
     * **絞り込みは手元で。** 出していない行は Ctrl+F で探せないので、代わりに
     * 打った端から当たる欄を置く。当てる先は番組名・局・状態・ルール名。
     * 録画のほうは既にサーバ側の絞り込み (`?q=`。300 件より古いものにも届く) が
     * あるので、**同じ欄で両方やる** — 打った端から手元の 300 件を絞り、送れば
     * サーバに聞きに行く
     */
    let reservationQuery = $state('');
    const reservationRows = $derived(
        data.reservations.filter((res) =>
            matches(
                reservationQuery,
                [res.name, res.service_name, stateLabel(res.state), res.rule_name ?? '', dateTime(res.start_at)].join(' '),
            ),
        ),
    );
    const reservationPage = new Paged(() => reservationRows, 60);
    $effect(() => {
        reservationQuery;
        reservationPage.reset();
    });

    /** 録画の絞り込み。URL の `q` から始めて、打った端から効かせる (URL が変われば下の効果で追う) */
    // svelte-ignore state_referenced_locally
    let recordingQuery = $state(data.q);
    $effect(() => {
        recordingQuery = data.q;
    });

    /** 「削除済みも表示」の行き先と札。広い幅では並べ、狭い幅では「⋯」の中に出す (同じものを2か所) */
    const deletedHref = $derived(data.showDeleted ? resolve('') : `${resolve('')}?deleted=1`);
    const deletedLabel = $derived(data.showDeleted ? '削除済みを隠す' : '削除済みも表示');
    /** 録画の見出しの「⋯」。照合を送り終えたら閉じる */
    let toolsOpen = $state(false);
    /**
     * **「⋯」の中身はサーバでは描かない。** Bits UI は浮かせる枠の id を
     * プロセス全体の数え上げで振る (`bits-1`, `bits-3`, …) ので、サーバで描くと
     * 読むたびに HTML が変わり、指紋 (ETag) が合わず 304 が返らなくなる。
     * 開けるのはハイドレーションの後なので、それまで無くて困ることは無い
     */
    let mounted = $state(false);
    /** 録画の枠 (中だけスクロールする)。開いたときに一番下へ送る */
    let recordingBox: HTMLElement | undefined = $state();
    onMount(() => {
        mounted = true;
        /*
         * **録画は一番下 (いちばん古いもの) を見せて開く。** 並びは新しい順のまま。
         * 溜まった録画は古いものから片付けたいので、開くたびに下まで送らずに済むように。
         * 枠の中がスクロールするとき (広い画面で2つ並べたとき) だけ。狭い画面は
         * ページごと縦に積むので、下へ送ると上の予約が見えなくなる
         */
        /*
         * **枠の高さが決まるのを待ってから送る。** 開いた直後は枠がまだ画面の高さに縮んで
         * おらず (高さは測ってから当てる)、ここで見ると「スクロールが要らない」に見えて
         * 何もしていなかった (実機)。初めてスクロールできるようになった時点で1回だけ送る。
         * それより先に人がスクロールしていたら触らない
         */
        const box = recordingBox;
        if (box === undefined) return;
        let touched = false;
        const touch = () => {
            touched = true;
        };
        box.addEventListener('wheel', touch, { passive: true, once: true });
        box.addEventListener('touchstart', touch, { passive: true, once: true });
        box.addEventListener('keydown', touch, { once: true });
        const settle = new ResizeObserver(() => {
            if (touched) return settle.disconnect();
            if (box.scrollHeight <= box.clientHeight) return;
            settle.disconnect();
            /*
             * **先に全部描いてから送る。** 描いているのは頭の60件だけで、そのまま下へ送ると
             * 着くのは60件目。しかも下の端に着いた合図 (`sentinel`) で続きが足され、位置がずれる。
             * 出すのは新しいほうから300件まで (`+page.server.ts`) なので、全部描いても重くない
             */
            recordingPage.revealAll();
            void tick().then(() => {
                if (!touched) box.scrollTop = box.scrollHeight;
            });
        });
        settle.observe(box);
        // 中身の行が増えて高さが変わったときも気付けるよう、一覧のほうも見る
        if (box.firstElementChild !== null) settle.observe(box.firstElementChild);
        return () => settle.disconnect();
    });
    function rightText(row: RightRow): string {
        if (row.kind === 'missed') {
            const res = row.res;
            return [res.name, res.service_name, stateLabel('missed'), res.rule_name ?? '', dateTime(res.start_at)].join(' ');
        }
        const rec = row.rec;
        return [
            rec.name,
            rec.series ?? '',
            rec.subtitle ?? '',
            rec.service_name,
            rowState(rec).label,
            rec.rule_name ?? '',
            dateTime(rec.start_at),
        ].join(' ');
    }
    const recordingRows = $derived(rightRows.filter((row) => matches(recordingQuery, rightText(row))));
    const recordingPage = new Paged(() => recordingRows, 60);
    /*
     * 絞り込みの言葉が**変わったときだけ**先頭に戻す。開いた直後の1回で戻すと、
     * 一番下から見せるために全部描いたもの (`onMount` の `revealAll`) を60件に戻してしまう
     */
    let recordingQueryShown = untrack(() => recordingQuery);
    $effect(() => {
        if (recordingQuery === recordingQueryShown) return;
        recordingQueryShown = recordingQuery;
        recordingPage.reset();
    });
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
    押すものは指で押せる大きさ (既定のボタン) にしてある
-->
{#snippet title(state: string, badge: string, name: string, testid: string)}
    <div class="cluster">
        <span class="tag {badge}" data-testid={testid}>{state}</span>
        <span class="row-name">{name}</span>
    </div>
{/snippet}

<!-- 局名・放送日時・尺・サイズ。1行にまとめて、空のものは出さない -->
<!--
    局ロゴは放送波から拾ったもの (`/api/services/<id>/logo`)。**まだ拾えていない局は
    何も出さない** — ライブ画面と違って一覧は行が細く、代わりの箱を置くと局名より目立つ
-->
{#snippet meta(parts: string[], row: { service_id: number; has_logo: boolean | null })}
    <div class="row-meta">
        {#if row.has_logo}
            <img src={resolve(`api/services/${row.service_id}/logo`)} alt="" loading="lazy" class="service-logo" />
        {/if}
        <span>{parts.filter(Boolean).join(' ・ ')}</span>
    </div>
{/snippet}

<!--
    削除の2回押し (`deleting`)。
    幅が変わるとボタンが動いて押し間違えるので、どちらも2文字で揃える
-->
{#snippet armedDelete(key: number)}
    {#if deleting.armed === key}
        <button type="submit" class="danger" data-testid="delete-confirm">確定</button>
    {:else}
        <button type="button" class="outline danger" onclick={() => deleting.arm(key)} data-testid="delete-button">
            削除
        </button>
    {/if}
{/snippet}

<!--
    **何でこの1本が立ったのか。** 予約にも録画にも同じ形で出す。

    録画の側に出していなかった頃は、録れたものを見ても「どのルールが拾ったのか」が
    分からなかった。要らないものが混ざっていたときに、直す先 (どのルールの条件か)
    を探すのに番組名からルールを推し量るしかなかった。

    ルール名をそのまま入口にする。行にボタンを足すと窮屈になる
-->
{#snippet source(ruleId: number | null, ruleName: string | null, manual: boolean)}
    <div class="row-sub muted tiny" data-testid="rule-name">
        {#if manual}
            手動予約
        {:else}
            ルール:
            {#if ruleId !== null}
                <a href={resolve(`rules?edit=${ruleId}`)}>{ruleName}</a>
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
<div class="board">
    <Toasts {notices} source={form} ondismiss={dropNote} />

    <div class="board-grid">
        <section class="board-col reservations">
            <div class="board-head">
                <h2>予約</h2>
                <!--
                    「競合を再計算」は置いていない。番組表を取り直したときとルールを
                    いじったときに必ず走るので、押す機会が無かった
                -->
                <div class="cluster">
                    <input
                        type="search"
                        class="filter"
                        placeholder="番組名・局・状態で絞り込み"
                        aria-label="予約を絞り込む"
                        bind:value={reservationQuery}
                    />
                    <a class="button secondary outline small" href={data.showFinished ? resolve('') : `${resolve('')}?all=1`}>
                        {data.showFinished ? '進行中のみ' : '完了分も表示'}
                    </a>
                </div>
            </div>

            <div class="board-box">
                <div class="rows" data-testid="reservation-list">
                    {#each reservationPage.rows as res (res.id)}
                        {@const press = (event: MouseEvent | KeyboardEvent) =>
                            rowClick(event, null, () => openReservation(res))}
                        <div
                            data-testid="reservation-row"
                            data-reservation-id={res.id}
                            data-program-id={res.program_id}
                            class="row"
                            role="button"
                            tabindex="0"
                            onclick={press}
                            onkeydown={press}
                        >
                            <div class="row-inner">
                                <div class="row-body" data-testid="row-body">
                                    {@render title(
                                        stateLabel(res.state),
                                        badgeClass(res.state),
                                        res.name,
                                        'reservation-state',
                                    )}
                                    {@render meta([res.service_name, airing(res)], res)}
                                    {#if res.conflict_reason}
                                        <div class="row-sub text-error small">{res.conflict_reason}</div>
                                    {/if}
                                    <!--
                                        **譲ることになっているなら、録る前に言う。** 丸ごと
                                        落とす代わりに入るところまで録るので (`server/conflict.ts`)、
                                        黙っていると「録れたつもり」で頭が無い録画ができる
                                    -->
                                    {#if clipNote(res) !== null}
                                        <div class="row-sub text-warning small">
                                            {clipNote(res)}
                                        </div>
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

                                <div class="row-actions">
                                    {#if res.recording_id !== null}
                                        <!-- 追っかけ再生 (issue #16)。録っている最中でも頭から観られる -->
                                        <a
                                            class="button"
                                            href={resolve(`chase/${res.recording_id}`)}
                                        >
                                            追っかけ
                                        </a>
                                    {/if}
                                    {#if active.includes(res.state)}
                                        <form method="POST" action="?/cancel" use:submitting>
                                            <input type="hidden" name="id" value={res.id} />
                                            <button type="submit"
                                                class="outline danger"
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
                                            <button type="submit" class="secondary" data-testid="restore-button">戻す</button>
                                        </form>
                                    {/if}
                                </div>
                            </div>
                        </div>
                    {:else}
                        {#if reservationQuery === ''}
                            <!-- 空のときは次に何をすればよいかまで言う (下の `.empty`) -->
                            <div class="empty" data-testid="reservation-empty">
                                <p class="empty-title">予約はありません</p>
                                <p class="empty-hint">番組表から予約するか、ルールを作ると自動で入ります</p>
                                <div class="empty-actions">
                                    <a class="button small" href={resolve('guide')}>番組表を開く</a>
                                    <a class="button secondary outline small" href={resolve('rules')}>ルールを作る</a>
                                </div>
                            </div>
                        {:else}
                            <div class="empty">
                                <p class="empty-title">「{reservationQuery}」に一致する予約はありません</p>
                            </div>
                        {/if}
                    {/each}
                    <!-- 下端に近づいたら続きを足す (`sentinel`)。残りが無くなれば消える -->
                    {#if reservationPage.more}
                        <div
                            class="row-empty muted small"
                            use:sentinel={() => reservationPage.reveal()}
                            data-testid="reservation-more"
                        >
                            残り {reservationPage.rest} 件
                        </div>
                    {/if}
                    <!--
                        絞った結果の件数は**一覧の末尾に**。見出しの行に出していた頃は、
                        打つたびに右の押すものが動いてガクガクした
                    -->
                    {#if reservationQuery !== ''}
                        <div class="row-empty muted small">
                            {data.reservations.length} 件中 {reservationRows.length} 件
                        </div>
                    {/if}
                </div>
            </div>
        </section>

        <section class="board-col recordings">
            <!-- 見出しの高さと下の余白は予約側と揃える。並べたときにずれて見えるため -->
            <div class="board-head">
                <h2>録画</h2>
                <div class="cluster">
                    <!--
                        打てば手元で絞り、**Enter で `?q=` をサーバに聞く** (上の `recordingQuery`)。
                        GET なので URL に残り、共有・戻るがそのまま効く。削除済み表示は引き継ぐ。
                        押すものは置かない (予約側と同じ形) — 解くのも欄を空にして Enter
                    -->
                    <form method="GET" action={resolve('')} class="search" data-sveltekit-reset={false}>
                        {#if data.showDeleted}
                            <input type="hidden" name="deleted" value="1" />
                        {/if}
                        <input
                            type="search"
                            name="q"
                            class="filter"
                            bind:value={recordingQuery}
                            placeholder="番組名・シリーズ・副題・局で絞り込み"
                            aria-label="録画を絞り込む"
                        />
                    </form>
                    <a class="button secondary outline small wide-only" href={deletedHref}>
                        {deletedLabel}
                    </a>
                    <form method="POST" action="?/reconcile" class="wide-only" use:submitting>
                        <button type="submit" class="secondary outline small" data-testid="reconcile-button">ファイルと照合</button>
                    </form>
                    <!--
                        **狭い幅では「⋯」に畳む。** 390px の端末では「ファイルと照合」が
                        2行目に落ち、見出しの行が2段ぶんの厚さになっていた。どちらも
                        たまにしか押さないので、絞り込みの欄を削るより奥へ下げる。
                        広い列では今までどおり並べる (切り替えは列の幅。下の `@container`)

                        中身は閉じている間も DOM に置く (`forceMount`)。照合を送っている
                        途中でメニューが消えると、回るものを出す先が無くなるため。
                        閉じるのは送り終わってから (詳細の「再エンコード」と同じ)
                    -->
                    <DropdownMenu.Root bind:open={toolsOpen}>
                        <DropdownMenu.Trigger
                            class="secondary outline small narrow-only tools-trigger"
                            aria-label="その他の操作"
                            data-testid="recordings-more"
                        >
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                                <circle cx="5" cy="12" r="2" />
                                <circle cx="12" cy="12" r="2" />
                                <circle cx="19" cy="12" r="2" />
                            </svg>
                        </DropdownMenu.Trigger>
                        {#if mounted}
                            <DropdownMenu.Content forceMount align="end" sideOffset={4} collisionPadding={8}>
                                {#snippet child({ wrapperProps, props, open })}
                                    <div {...wrapperProps}>
                                        <div {...props} class="more-menu tools-menu" hidden={!open} data-testid="recordings-more-menu">
                                            <DropdownMenu.Item>
                                                {#snippet child({ props: itemProps })}
                                                    <a {...itemProps} href={deletedHref} class="menu-link">{deletedLabel}</a>
                                                {/snippet}
                                            </DropdownMenu.Item>
                                            <form
                                                method="POST"
                                                action="?/reconcile"
                                                class="menu-form"
                                                use:submitting={() => async (options) => {
                                                    await options.update();
                                                    toolsOpen = false;
                                                }}
                                            >
                                                <DropdownMenu.Item closeOnSelect={false}>
                                                    {#snippet child({ props: itemProps })}
                                                        <button
                                                            {...itemProps}
                                                            type="submit"
                                                            class="menu-button"
                                                            data-testid="reconcile-menu-button"
                                                        >
                                                            ファイルと照合
                                                        </button>
                                                    {/snippet}
                                                </DropdownMenu.Item>
                                            </form>
                                        </div>
                                    </div>
                                {/snippet}
                            </DropdownMenu.Content>
                        {/if}
                    </DropdownMenu.Root>
                </div>
            </div>

            <div class="board-box" bind:this={recordingBox}>
                <div class="rows" data-testid="recording-list">
                    {#each recordingPage.rows as row (row.key)}
                    {#if row.kind === 'missed'}
                        {@const res = row.res}
                        {@const press = (event: MouseEvent | KeyboardEvent) => rowClick(event, null, () => openMissed(res))}
                        <!--
                            録り逃し。観るものが無いので、押すと詳細だけ出す (予約の行と
                            同じ扱い)。ボタンも置かない — 放送は終わっているので、
                            この行からできることが無い (再放送は番組表から予約し直す)
                        -->
                        <div
                            data-program-id={res.program_id}
                            class="row"
                            role="button"
                            tabindex="0"
                            onclick={press}
                            onkeydown={press}
                        >
                            <div class="row-inner">
                                <div class="row-body" data-testid="row-body">
                                    {@render title(stateLabel('missed'), badgeClass('missed'), res.name, 'missed-state')}
                                    {@render meta([res.service_name, airing(res)], res)}
                                    <!-- 録画側の流儀に合わせて手動とも書く (見返すものなので) -->
                                    {@render source(res.rule_id, res.rule_name, res.manual)}
                                </div>
                                <!--
                                    確かめ終わったら畳める (録画の削除と同じ2回押し)。
                                    消すのは予約の行 (`?/deleteMissed`) — 録画の行が無いので。
                                    構えの鍵は負の値にして、録画のIDと混ざらないようにする
                                    (deleting は録画と共用で、IDの空間が別のため)
                                -->
                                <div class="row-actions">
                                    <form method="POST" action="?/deleteMissed" use:submitting>
                                        <input type="hidden" name="id" value={res.id} />
                                        {@render armedDelete(-res.id)}
                                    </form>
                                </div>
                            </div>
                        </div>
                    {:else}
                        {@const rec = row.rec}
                        {@const link = watchLink(rec)}
                        {@const press = (event: MouseEvent | KeyboardEvent) =>
                            rowClick(event, link, () => openRecording(rec))}
                        {@const canPlay = link !== null}
                        {@const shown = rowState(rec)}
                        <!-- 端末に入っているか (オフライン視聴)。行の印と、下のバーで見る -->
                        {@const held = offline.entries[rec.id]}
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
                            data-cm-ranges={rec.cm_ranges === null ? null : JSON.stringify(rec.cm_ranges)}
                            class="row playable"
                            role="button"
                            tabindex="0"
                            onclick={press}
                            onkeydown={press}
                        >
                            <div class="row-inner">
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
                                    <div class="poster" data-testid="play-hint">
                                        {#if rec.library_path !== null}
                                            <img
                                                src={resolve(`api/recordings/${rec.id}/poster`)}
                                                alt=""
                                                loading="lazy"
                                                class="poster-img"
                                                onerror={(event) => {
                                                    (event.currentTarget as HTMLImageElement).style.display =
                                                        'none';
                                                }}
                                            />
                                        {/if}
                                        <span class="poster-play" aria-hidden="true">
                                            <svg
                                                viewBox="0 0 24 24"
                                                class="poster-icon"
                                                fill="currentColor"
                                                aria-hidden="true"
                                            >
                                                <path d="M8 5v14l11-7z" />
                                            </svg>
                                        </span>
                                    </div>
                                {/if}
                                <div class="row-body" data-testid="row-body">
                                    <!--
                                        録画の状態とエンコードの状態を1つにまとめて出す
                                        (rowState)。消したもの (deleted) も録画の状態から
                                        決まるので、ここで書き分けることは何も無い
                                    -->
                                    {@render title(shown.label, shown.badge, rec.name, 'recording-state')}
                                    {#if held !== undefined}
                                        <!-- 端末に入っている印。保存中はエンコードと同じく割合を添える -->
                                        <span
                                            class="tag offline-tag {held.state === 'ready'
                                                ? 'success'
                                                : held.state === 'failed'
                                                  ? 'error'
                                                  : ''}"
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
                                        rec,
                                    )}
                                    <!--
                                        **欠けているなら、そう言う。** チューナーの取り合いで
                                        頭か尻を譲った録画は、番組の一部が入っていない
                                        (`server/conflict.ts` の「入るところまで録る」)。
                                        尺だけ見ても「短い番組」と見分けが付かないので、
                                        行に書く
                                    -->
                                    {#if clipNote(rec, true) !== null}
                                        <div class="row-sub text-warning small">
                                            {clipNote(rec, true)}
                                        </div>
                                    {/if}
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
                                        <div class="resume">
                                            <div class="resume-track">
                                                <div class="resume-fill" style="width: {frac * 100}%"></div>
                                            </div>
                                            <span class="resume-left muted tiny num">
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
                                        {@render source(rec.rule_id, rec.rule_name, rec.from_manual)}
                                    {/if}
                                    <!--
                                        失敗・削除の理由や CM の検出元は長いので行に出さず、
                                        詳細 (openRecording) に回す。状態はバッジで分かる
                                    -->
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
                                        <div class="row-sub text-warning small">
                                            ロゴでCMを判定できませんでした (無音だけで判定)
                                            <span class="muted"
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
                                        <div class="row-sub muted tiny" data-testid="encode-progress">
                                            {percent(live?.percent ?? rec.job_percent ?? 0)}
                                            {#if eta(liveEta)}・{eta(liveEta)}{/if}
                                        </div>
                                    {:else if rec.job_state === 'running' && rec.job_log}
                                        <div class="row-sub muted tiny">
                                            {rec.job_log}
                                        </div>
                                    {/if}
                                </div>

                                <!--
                                    押すものはすべて枠付きにする。枠も地も無いボタン (ghost) は
                                    行の文字と見分けが付かず、どこからどこまでが押せるのか
                                    分からなかった
                                -->
                                <div class="row-actions">
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
                                            class="secondary outline"
                                            onclick={() => openRecording(rec)}
                                            data-testid="detail-button"
                                        >
                                            詳細
                                        </button>
                                    {/if}
                                    {#if rec.deleted_at === null}
                                        <!-- ダウンロードと録り直しは詳細の中 (recordingActions) -->
                                        {#if rec.job_id !== null}
                                            <!--
                                                動いている間は中止だけ。この裏で ffmpeg が
                                                元のTSを読んでいるので、消させると道連れになる
                                            -->
                                            {#if rec.job_canceling}
                                                <!--
                                                    **畳み終わるまで回したままにする。** 押した返事は
                                                    上限 (encoder.CANCEL_WAIT_MS) で切り上げることが
                                                    あり、返事でボタンを戻すと「回るのが止まったのに
                                                    まだエンコード中」になっていた。行が消える
                                                    (畳み終わりの知らせ) までは、まだ中止の途中
                                                -->
                                                <button type="button"
                                                    class="outline danger"
                                                    disabled
                                                    aria-busy="true"
                                                    data-testid="encode-cancel"
                                                >
                                                    エンコード中止
                                                </button>
                                            {:else}
                                                <form method="POST" action="?/cancelEncode" use:submitting>
                                                    <input type="hidden" name="id" value={rec.job_id} />
                                                    <button type="submit"
                                                        class="outline danger"
                                                        data-testid="encode-cancel"
                                                    >
                                                        エンコード中止
                                                    </button>
                                                </form>
                                            {/if}
                                        {:else}
                                            <!-- サーバから消したら、端末に落としてあったコピーも片付ける -->
                                            <form
                                                method="POST"
                                                action="?/delete"
                                                use:submitting={() => async (options) => {
                                                    await options.update();
                                                    // held は使わない。use: の引数は作ったときのまま閉じ込められるので、
                                                    // あとから端末に保存した録画でも古い「無い」を見てしまう
                                                    if (options.result.type === 'success' && offline.entries[rec.id] !== undefined) {
                                                        void removeLocal(rec.id);
                                                    }
                                                }}
                                            >
                                                <input type="hidden" name="id" value={rec.id} />
                                                {@render armedDelete(rec.id)}
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
                                    class="row-bar"
                                    value={rec.job_state === 'running' && barPercent > 0
                                        ? barPercent
                                        : undefined}
                                    max="1"
                                ></progress>
                            {:else if held?.state === 'downloading'}
                                <!-- 端末への保存もエンコードと同じ見せ方。測れない間は動くだけのバー -->
                                <progress
                                    class="row-bar success"
                                    value={held.progress ?? undefined}
                                    max="1"
                                ></progress>
                            {/if}
                        </div>
                    {/if}
                    {:else}
                        {#if recordingQuery === ''}
                            <div class="empty" data-testid="recording-empty">
                                <p class="empty-title">録画はありません</p>
                                <p class="empty-hint">予約した番組は、録り終わるとここに並びます</p>
                                <div class="empty-actions">
                                    <a class="button secondary outline small" href={resolve('guide')}>番組表を開く</a>
                                </div>
                            </div>
                        {:else}
                            <div class="empty">
                                <p class="empty-title">「{recordingQuery}」に一致する録画はありません</p>
                                {#if recordingQuery !== data.q}
                                    <p class="empty-hint">Enter で古い録画まで探します</p>
                                {/if}
                            </div>
                        {/if}
                    {/each}
                    <!-- 下端に近づいたら続きを足す (`sentinel`)。残りが無くなれば消える -->
                    {#if recordingPage.more}
                        <div
                            class="row-empty muted small"
                            use:sentinel={() => recordingPage.reveal()}
                            data-testid="recording-more"
                        >
                            残り {recordingPage.rest} 件
                        </div>
                    {/if}
                    <!-- 手元で絞っているぶん (予約側と同じく末尾に)。送る前でも何件残るかが分かる -->
                    {#if recordingQuery !== data.q}
                        <div class="row-empty muted small">
                            {rightRows.length} 件中 {recordingRows.length} 件
                        </div>
                    {/if}
                    <!--
                        **300件で頭打ちなのを黙らない。** 溜まると古いものが黙って
                        消え、「消えた」ように見える。上限に当たっていたら、絞り込みへ
                        誘う一行を出す (`+page.server.ts` の LIMIT 300)
                    -->
                    {#if data.recordings.length >= 300}
                        <div class="row-empty truncated muted small">
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
        actions={detailRec !== null ? recordingActions : detailRes !== null ? reservationActions : undefined}
    />
{/if}

<!--
    予約の詳細から取り消す。**行の「取消」と同じ口** (`?/cancel`) なので、
    ルールが立てた予約でも作り直されない (戻すのは行の「戻す」から)。

    行にしか無かった頃は、詳細を開いて中身を確かめてから要らないと分かっても、
    一度閉じて行のボタンを探し直すことになっていた (番組表の詳細には前から在る)。
    **取り消せたら閉じる** — 番組表の詳細で予約・取消したときと同じ。
    取り消した行は一覧から消える (完了分を出しているときは「戻す」に変わる)
-->
{#snippet reservationActions()}
    {#if detailRes !== null && active.includes(detailRes.state)}
        <form
            method="POST"
            action="?/cancel"
            use:submitting={() =>
                async ({ result, update }) => {
                    await update();
                    if (result.type === 'success') detail.close();
                }}
        >
            <input type="hidden" name="id" value={detailRes.id} />
            <button type="submit" class="outline danger" data-testid="detail-cancel">予約を取り消す</button>
        </form>
    {/if}
    <!-- 位置を動かさないため、いつでもここが最後 -->
    <button type="button" class="secondary" onclick={() => detail.close()} data-testid="detail-close">閉じる</button>
{/snippet}

<!--
    その1本に対する操作。**一覧の行ではなくここに置く。**

    行に並べていた頃は「詳細・ダウンロード・再エンコード・削除」が横に並び、
    狭い画面では枠から流れ出していた。再生は行そのものなので、行に残すのは
    入口 (詳細) と、取り返しのつかない削除だけにしてある
-->
{#snippet recordingActions()}
    {#if detailRec !== null}
        {@const rec = detailRec}
        {#if hasFile(rec)}
            <!--
                **並べるのはよく押すものだけ** — 端末に保存。
                条件が揃うと10個のボタンが同じ見た目で並び、狭い画面では文字の
                途中で折り返していた。めったに押さないもの (落とす・リンクを
                コピー・焼き直し) は「その他…」に畳む。
            -->
            {#if offline.usable && rec.library_path !== null}
                <!--
                    **端末に保存 (オフライン視聴)。** 落とすのは焼いたもの
                    (docs/offline.md)。生TSしか無い録画はブラウザで再生できない
                    ので出さない。保存済みなら「端末から消す」に変わる —
                    こちらはサーバの録画に触らない (行の削除ボタンとは別)
                -->
                {@const held = offline.entries[rec.id]}
                {#if held === undefined || held.state === 'failed'}
                    <button type="button" class="secondary outline" onclick={() => saveToDevice(rec)}>
                        {held?.state === 'failed' ? '保存をやり直す' : '端末に保存'}
                    </button>
                {/if}
                {#if held !== undefined}
                    <button
                        type="button"
                        class="secondary outline"
                        onclick={async () => {
                            await removeLocal(rec.id);
                            detail.close();
                        }}
                    >
                        {held.state === 'downloading'
                            ? '保存を取り消す'
                            : held.state === 'failed'
                              ? '失敗した保存データを消す'
                              : '端末から消す'}
                    </button>
                {/if}
            {/if}
            <!--
                **めったに押さないものの置き場。** 上に開く (フッターは画面の
                下端に居るので、下に開くと枠から出る)。中身は上から
                「持ち出す」「渡す」「直す」の順。

                **開閉は Bits UI の DropdownMenu。** 位置は Bits UI が枠に収まるように
                ずらす (daisyUI の頃は、スマホ幅でフッターが折り返すと左へ伸びた分が
                modal-box からはみ出して切れていた)。

                **閉じている間も中身は DOM に置く (`forceMount`)。** どの口が出るかを
                開かずに確かめられるように (e2e が数を見ている)。閉じている間は
                `hidden` で消す — 見えないまま居座ってクリックを食うことが無いように
                (daisyUI の頃に実機で発覚した「見えないダウンロード」の二の舞を避ける)
            -->
            <DropdownMenu.Root>
                <DropdownMenu.Trigger class="secondary outline" data-testid="detail-more">その他…</DropdownMenu.Trigger>
                <DropdownMenu.Content forceMount side="top" align="end" sideOffset={4} collisionPadding={8}>
                    {#snippet child({ wrapperProps, props, open })}
                        <div {...wrapperProps}>
                            <div {...props} class="more-menu" hidden={!open} data-testid="detail-more-menu">
                                <!--
                                    まだエンコードしていないものや、引き継いだ未エンコードの録画は
                                    生TSしか無い。配信は library_path ?? ts_path を返すので、
                                    どちらかがあれば落とせる。形式が複数あるときはラベルに添えて
                                    並べる (「AV1」だけの札では、押すと何が起きるのか読めなかった)。
                                    **押したら閉じる** — 落とし始めたあとも詳細が残っていると、
                                    押せたのかどうかが分からない
                                -->
                                <DropdownMenu.Item
                                    onSelect={() =>
                                        download(rec.id, bothFiles(rec) || hasAlt(rec) ? 'encoded' : undefined)}
                                    data-testid="download-link"
                                >
                                    {hasAlt(rec)
                                        ? 'ダウンロード (AV1)'
                                        : bothFiles(rec)
                                          ? 'ダウンロード (エンコード済み)'
                                          : 'ダウンロード'}
                                </DropdownMenu.Item>
                                {#if hasAlt(rec)}
                                    <!-- 両方のコーデックを焼いた録画でだけ。AV1 を解けない相手はこちら -->
                                    <DropdownMenu.Item
                                        onSelect={() => download(rec.id, 'alt')}
                                        data-testid="download-alt-link"
                                    >
                                        ダウンロード (H.264)
                                    </DropdownMenu.Item>
                                {/if}
                                {#if bothFiles(rec)}
                                    <!-- 元も落とせるように。両方残っているときだけ (`bothFiles`) -->
                                    <DropdownMenu.Item
                                        onSelect={() => download(rec.id, 'ts')}
                                        data-testid="download-ts-link"
                                    >
                                        ダウンロード (生TS)
                                    </DropdownMenu.Item>
                                {/if}
                                <!--
                                    **出先のプレイヤー向けの再生リンク** (share.ts)。期限付き
                                    (SHARE_TTL) なので、他人の機器の履歴に残っても腐るだけ。
                                    押したらメニューは閉じる — 開いたままだと押せたのか分からない
                                -->
                                <DropdownMenu.Item
                                    onSelect={() => void copyShareLink(rec.id)}
                                    data-testid="share-link-button"
                                >
                                    再生リンクをコピー
                                </DropdownMenu.Item>
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
                                        class="menu-form"
                                        use:submitting={() => async (options) => {
                                            await options.update();
                                            detail.close();
                                        }}
                                    >
                                        <input type="hidden" name="id" value={rec.id} />
                                        <DropdownMenu.Item closeOnSelect={false}>
                                            {#snippet child({ props: itemProps })}
                                                <button
                                                    {...itemProps}
                                                    type="submit"
                                                    class="menu-button"
                                                    data-testid="reencode-button"
                                                >
                                                    再エンコード
                                                </button>
                                            {/snippet}
                                        </DropdownMenu.Item>
                                    </form>
                                {/if}
                            </div>
                        </div>
                    {/snippet}
                </DropdownMenu.Content>
            </DropdownMenu.Root>
        {/if}
    {/if}
    <button type="button" class="secondary" onclick={() => detail.close()} data-testid="detail-close">閉じる</button>
{/snippet}

<style>
    /*
     * 広い画面 (md = 768px 以上) では2つの一覧を横に並べ、画面の残りを丁度使い切る。
     * 畳まれる幅では素直にページごとスクロールさせる
     */
    .board-grid {
        display: grid;
        gap: 1.5rem;
    }
    .board-col {
        /* min-width: 0 が無いと、中の幅にグリッドの列が引きずられてページごとはみ出す */
        min-width: 0;
    }
    /* 1列に畳まれたときは録画を先に出す(見るのはたいてい録れたほうなので) */
    .reservations {
        order: 2;
    }
    .recordings {
        order: 1;
    }
    @media (min-width: 768px) {
        .board {
            display: flex;
            flex-direction: column;
            height: 100%;
        }
        .board-grid {
            flex: 1;
            min-height: 0;
            grid-template-columns: repeat(5, minmax(0, 1fr));
        }
        .board-col {
            display: flex;
            flex-direction: column;
            min-height: 0;
            order: 0;
        }
        .reservations {
            grid-column: span 2;
        }
        .recordings {
            grid-column: span 3;
        }
        .board-box {
            flex: 1;
            min-height: 0;
        }
    }
    .board-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        min-height: 2rem;
        margin-bottom: 0.5rem;
    }
    .board-head h2 {
        font-size: 1.125rem;
    }
    /* 絞り込みの欄。予約側と録画側で同じ形 (録画側だけ送れる form の中に居る) */
    .filter {
        width: 10rem;
        height: auto;
        padding-block: 0.3rem;
        font-size: 0.85rem;
    }
    @media (min-width: 640px) {
        .filter {
            width: 14rem;
        }
    }
    /*
     * 残りいっぱいまで伸ばして、中だけスクロールさせる。2つ並べたときに、
     * 片方が長いともう片方が下に置いていかれるため。
     * 縦の flex なのは、空の札 (`.empty`) を枠の真ん中に置くため
     */
    .board-box {
        display: flex;
        flex-direction: column;
        overflow: auto;
        border-radius: 1rem;
        background: var(--dp-surface);
        border: 1px solid var(--dp-base-300);
    }
    .rows > :global(* + *) {
        border-top: 1px solid var(--dp-base-300);
    }
    .row {
        position: relative;
        cursor: pointer;
        padding: 0.75rem;
    }
    .row:hover {
        background: color-mix(in srgb, var(--dp-base-200) 60%, transparent);
    }
    .row-inner {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        gap: 0.5rem 0.75rem;
    }
    .row-body {
        min-width: 0;
        flex: 1 1 14rem;
    }
    .row-actions {
        display: flex;
        flex-shrink: 0;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
    }
    .row-name {
        font-weight: 500;
        overflow-wrap: anywhere;
    }
    /*
        flex にしない。録画済みの行は書くことが多く (サイズ・コーデック)、flex-wrap だと
        文字のかたまりごと次の行へ送られて、ロゴだけが1行に取り残される。
        ロゴを文の中の1文字として流せば、折り返すのは文の途中になる
    */
    .row-meta {
        margin-top: 0.25rem;
        font-size: 0.875rem;
        opacity: 0.65;
        overflow-wrap: anywhere;
    }
    .row-sub {
        margin-top: 0.125rem;
    }
    .service-logo {
        display: inline-block;
        height: 1rem;
        width: auto;
        margin-right: 0.375rem;
        vertical-align: -0.1875rem;
        border-radius: 0.125rem;
        object-fit: contain;
    }
    .row-empty {
        padding: 0.75rem;
    }
    /*
     * **一覧が空のとき。** 「録画はありません」を行と同じ小さな字で左上に置いていた
     * 頃は、大きな枠の隅に一言あるだけで、壊れているのか空なのか読み取れなかった。
     * 枠の真ん中に置き、次にすること (番組表・ルール) への口を添える。
     * 畳まれる幅では枠が中身の高さなので、上下の余白だけが効く
     */
    .rows {
        display: flex;
        flex: 1 0 auto;
        flex-direction: column;
    }
    .empty {
        display: flex;
        flex: 1 0 auto;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 2.5rem 1rem;
        text-align: center;
    }
    .empty-title {
        font-weight: 600;
        overflow-wrap: anywhere;
    }
    .empty-hint {
        font-size: 0.875rem;
        opacity: 0.7;
    }
    .empty-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 0.5rem;
        margin-top: 0.5rem;
    }
    /* 録画の見出しの「⋯」。広い列では並べたほうを出し、狭い列ではこちらだけ */
    .cluster :global(.tools-trigger) {
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }
    .menu-link {
        color: inherit;
        text-decoration: none;
    }
    /*
     * 畳むかどうかは**画面の幅ではなく録画の列の幅**で決める。二段組に入ったばかりの
     * 幅 (縦の iPad など) でも列は 440px ほどしかなく、並べると同じように折り返す
     */
    .recordings {
        container: recordings / inline-size;
    }
    @container recordings (min-width: 36rem) {
        .cluster :global(.narrow-only) {
            display: none;
        }
    }
    @container recordings (max-width: 35.99rem) {
        .cluster .wide-only {
            display: none;
        }
    }
    .truncated {
        border-top: 1px solid var(--dp-base-300);
    }
    /* ポスターと再生の印。行に指を乗せると印が浮かぶ */
    .poster {
        position: relative;
        margin-top: 0.125rem;
        aspect-ratio: 16 / 9;
        width: 4rem;
        flex-shrink: 0;
        overflow: hidden;
        border-radius: 0.25rem;
        background: var(--dp-base-300);
    }
    @media (min-width: 640px) {
        .poster {
            width: 6rem;
        }
    }
    .poster-img {
        height: 100%;
        width: 100%;
        object-fit: cover;
    }
    .poster-play {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        background: rgb(0 0 0 / 0);
        transition: background-color 0.15s;
    }
    .poster-icon {
        width: 1.5rem;
        height: 1.5rem;
        opacity: 0;
        filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.5));
        transition: opacity 0.15s;
    }
    .playable:hover .poster-play {
        background: rgb(0 0 0 / 0.4);
    }
    .playable:hover .poster-icon {
        opacity: 1;
    }
    .offline-tag {
        margin-top: 0.25rem;
    }
    .resume {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-top: 0.375rem;
    }
    .resume-track {
        height: 0.25rem;
        min-width: 0;
        flex: 1;
        overflow: hidden;
        border-radius: 999px;
        background: var(--dp-base-300);
    }
    .resume-fill {
        height: 100%;
        background: var(--pico-primary-background);
    }
    .resume-left {
        flex-shrink: 0;
    }
    /* 進み具合は行の下端いっぱいに敷く */
    .row-bar {
        position: absolute;
        inset-inline: 0;
        bottom: 0;
        height: 0.25rem;
        border-radius: 0;
    }
    .row-bar.success {
        --pico-progress-color: var(--dp-ok);
    }
    /* 「その他…」の中身。項目は左寄せで縦に積む */
    .more-menu {
        display: flex;
        flex-direction: column;
        width: 16rem;
        max-width: calc(100vw - 2rem);
    }
    /* 録画の見出しの「⋯」の中身。項目が短いので細くする */
    .tools-menu {
        width: 12rem;
    }
    .menu-form {
        display: contents;
    }
    .menu-button {
        width: 100%;
        border: 0;
        background: transparent;
        color: inherit;
        text-align: left;
        font-size: inherit;
    }
</style>
