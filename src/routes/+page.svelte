<script lang="ts" module>
    import { SvelteSet } from 'svelte/reactivity';

    /**
     * 「まとめて表示」で開いている番組 (まとめる鍵)。**その場かぎり覚える** —
     * モジュールに置くので、観る画面へ行って戻っても開いたまま。読み込み直すと閉じる
     */
    const openedGroups = new SvelteSet<string>();
</script>

<script lang="ts">
    import { tick, untrack } from 'svelte';
    import { submitting } from '#lib/actions.js';
    import { arming } from '#lib/arming.svelte.js';
    import { type Item, type Res, setHome } from '#lib/components/home/context.js';
    import Menu from '#lib/components/Menu.svelte';
    import ProgramDetail from '#lib/components/ProgramDetail.svelte';
    import Toasts, { errorNotice, type Notice } from '#lib/components/Toasts.svelte';
    import '#lib/components/home/home.css';
    import HomeAside from '#lib/components/home/HomeAside.svelte';
    import { alignTop, placeTimeline, restoreRow, topRow } from '#lib/components/home/placement.js';
    import TimelineBar from '#lib/components/home/TimelineBar.svelte';
    import TimelineEntry from '#lib/components/home/TimelineEntry.svelte';
    import { type DetailSeed, programDetail } from '#lib/detail.svelte.js';
    import { applyEncodeProgress } from '#lib/encode-live.svelte.js';
    import { cmNoteWorthShowing, date, logoUnusable } from '#lib/format.js';
    import { GROUPED_COOKIE } from '#lib/grouping.js';
    import { liveUpdates } from '#lib/live-updates.svelte.js';
    import { clearFailed, offline, removeLocal, saveOffline } from '#lib/offline.svelte.js';
    import { Paged, sentinel } from '#lib/paging.svelte.js';
    import { cmRedo, encodeSource } from '#lib/source.js';
    import {
        catchUp,
        countFilters,
        dayName,
        type Filter,
        lineIndex,
        mergeRecorded,
        passes,
        sections,
        type Traits,
        timelineLines,
        type Zone,
    } from '#lib/timeline.js';
    import { resolve } from '$app/paths';

    let { data, form } = $props();

    // 予約・録画のどちらが動いてもサーバが知らせてくる。
    // エンコードの進み具合だけは中身ごと届き、読み直さず行の数字を書き換える
    liveUpdates(['recordings', 'reservations'], { encode: applyEncodeProgress });

    const active = ['scheduled', 'conflict', 'skipped', 'recording'];
    /** 取り消せるか。録画しない (`skipped`) は放送が終われば履歴なので出さない */
    const cancelable = (res: { state: string; end_at: number }) =>
        active.includes(res.state) && !(res.state === 'skipped' && res.end_at <= Date.now());

    /** 端末への保存の結果。フォームではないので自前で持つ */
    let offlineNote = $state<Notice | null>(null);

    /**
     * 閉じた (自分で消えた) 通知は持ち主が捨てる。Toasts は返事 (`form`) が変わると
     * 閉じたことを忘れるので、持ったままだと別のボタンを押すたびに蘇る
     */
    function dropNote(key: string): void {
        if (offlineNote?.key === key) offlineNote = null;
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
     * `saveOffline` が決める (既定 AV1、端末がデコードできなければ H.264)。
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
     * 行そのものではなく ID で持ち、いまの一覧から引き直す。通知で読み直すと
     * 状態が変わる (予約済み → 録画中) ので、覚えた行のままだと出す操作がずれる
     */
    let detailResId = $state<number | null>(null);
    const detailRes = $derived(
        detailResId === null ? null : (data.reservations.find((res) => res.id === detailResId) ?? null),
    );

    /**
     * 行を押したら番組詳細を出す。中身の出し方は `detail` が持っている。
     * ここで決めるのは、その行に添えるバッジ (失敗の理由・CMの判定) だけ。
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

    /** 削除は2回押させる。挙動はほかの画面と共通 ([arming.svelte.ts](../lib/arming.svelte.ts)) */
    const deleting = arming(
        '[data-testid="delete-button"], [data-testid="delete-confirm"], [data-testid="row-menu-delete"], [data-testid="row-menu-delete-confirm"]',
    );

    /**
     * その録画を観る画面。**観られないものには無い。**
     * 録り終えたものは `/watch`、録っている最中は元のTSを `/chase` で観る (下)。
     *
     * 消したものと、**録画そのものが失敗したもの**も外す。後者は途中まで書けた
     * ファイルが残っていることはあるが、頭からスクランブルが掛かっていたり
     * 中身が空だったりで、押しても何も映らない
     */
    function watchLink(rec: (typeof data.recordings)[number]): string | null {
        if (rec.deleted_at !== null || rec.state === 'failed') return null;
        if (rec.library_path !== null) return resolve(`watch/${rec.id}`);
        /*
         * **エンコードが終わる前でも観られる。** 録り終えて CM検出やエンコードを待っている間 (失敗したときも) は
         * 観る画面がサーバに元の TS をその場で変換させて流す (`server/playback.ts`)。録っている最中だけ
         * 追っかけ再生の画面 (`/chase`。伸びている TS を追い読みする)
         */
        if (rec.ts_path !== null)
            return resolve(rec.finished_at !== null ? `watch/${rec.id}` : `chase/${rec.id}`);
        return null;
    }

    /**
     * **まだ観ていない** (一覧の点)。観終えた時刻 (`watched_at`) が無く、続きの位置も無いもの。
     * 途中まで観たものは進捗バーのほうで分かるので点は付けない。観られないものにも付けない
     */
    function unwatched(rec: (typeof data.recordings)[number]): boolean {
        return rec.watched_at === null && rec.resume_ms === null && watchLink(rec) !== null;
    }

    /** 録画・番組からルールを作る入口。`/rules` が検索の画面の「ルールとして保存」へ送る (`rules/+page.server.ts` の `movedTo`) */
    function ruleFrom(kind: 'recording' | 'program', id: number): string {
        return resolve(`rules?${kind}=${id}`);
    }

    /**
     * ファイルを持っているか。**端末に保存と「その他…」を出すかどうか。**
     * エンコードの失敗はここに出てこない — 落ちたのは再エンコードのほうで、元のTSは無事なので観られる
     */
    function hasFile(rec: (typeof data.recordings)[number]): boolean {
        if (rec.deleted_at !== null) return false;
        if ((rec.library_path ?? rec.ts_path) === null) return false;
        return rec.state !== 'failed';
    }

    /**
     * 録画の詳細。
     *
     * 失敗の理由は**ここでしか出さない** (一覧の行の高さを揃えるため)。
     * 理由は3種類あって、それぞれ別物なので見出しを付けて分けて渡す
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
     * 録り逃しの詳細。**失敗した録画と同じ形**で、開いたときに理由を出す。
     * チューナー不足で落とされたものは予約が理由を持っている (conflict_reason)
     */
    function openMissed(res: (typeof data.missed)[number]): void {
        const text =
            res.conflict_reason ?? 'アプリが止まっていたなどの理由で、録画を始められないまま放送が終わりました';
        openDetail(res.program_id, res, [{ title: '録り逃しました', text }]);
    }

    /*
     * ---- 1本の時間軸 (`#lib/timeline.ts`) ----
     *
     * 予約・録画・録り逃しを1つの一覧に並べる。上がこれからの予約、「いま」の線と録画中、
     * 下が録れたもの。行の形 (`Item`) は部品と分け合う (`#lib/components/home/context.ts`)
     */

    /**
     * 予約をどの側に置くか。録画中は線の下、放送が終わっていないものは線の上。
     * 「完了した予約も表示」で出る終わった予約 (完了・失敗・取り消し) は録れたものの側
     */
    function zoneOf(res: Res, now: number): Zone {
        if (res.state === 'recording') return 'now';
        return res.end_at > now ? 'future' : 'past';
    }

    /** 描いた時刻。「いま」の線と予約の側分けの物差し。読み直すたびに取り直す */
    const clock = $derived.by(() => {
        void data;
        return Date.now();
    });

    /** 終わった予約と、それで録れた録画を 1 本に (`mergeRecorded`)。録画の行が代わりに立つ */
    const merged = $derived(mergeRecorded(data.reservations, data.recordings, clock));

    const items = $derived<Item[]>([
        ...merged.reservations.map(
            (res): Item => ({
                kind: 'res',
                key: `res-${res.id}`,
                at: res.start_at,
                zone: zoneOf(res, clock),
                group: res.group_key,
                groupName: res.group_name,
                res,
            }),
        ),
        ...data.recordings.map(
            (rec): Item => ({
                kind: 'rec',
                key: `rec-${rec.id}`,
                at: rec.start_at,
                zone: 'past',
                group: rec.group_key,
                groupName: rec.group_name,
                // 予約にしか無かった副題は予約の名前で (`mergeRecorded` の `names`)
                rec: merged.names.has(rec.id) ? { ...rec, name: merged.names.get(rec.id) ?? rec.name } : rec,
            }),
        ),
        ...data.missed.map(
            (res): Item => ({
                kind: 'missed',
                key: `missed-${res.id}`,
                at: res.start_at,
                zone: 'past',
                group: res.group_key,
                groupName: res.group_name,
                res,
            }),
        ),
    ]);

    /**
     * **観終えていない録画** (未視聴の点か、続きのバーが出ているもの)。「未視聴」の絞り込みと、
     * 開いたときに映す録画 (`catchUp`) に使う。観られないもの・消したものは入れない
     */
    function unfinished(item: Item): boolean {
        if (item.kind !== 'rec') return false;
        const rec = item.rec;
        return rec.deleted_at === null && rec.watched_at === null && watchLink(rec) !== null;
    }

    function traitsOf(item: Item): Traits {
        return {
            unfinished: unfinished(item),
            failed:
                (item.kind === 'rec' && (item.rec.state === 'failed' || (item.rec.encode_error ?? '') !== '')),
            missed: item.kind === 'missed',
            conflict: item.kind === 'res' && item.res.state === 'conflict',
            cmlogo: item.kind === 'rec' && item.rec.deleted_at === null && logoUnusable(item.rec.cm_note),
        };
    }

    /** 絞り込みのボタン (すべて・予約・録画中・未視聴・失敗)。その場かぎり */
    let filter = $state<Filter>('all');
    /** 件数はボタンごとに数える (押す前に、押すと何件になるかが分かる) */
    const counts = $derived(countFilters(items, traitsOf));
    const shownItems = $derived(items.filter((item) => passes(filter, item, traitsOf(item))));
    const parts = $derived(sections(shownItems));

    /** 「削除済みも表示」「完了した予約も表示」の行き先。入っていれば外した URL へ (ほかの指定は残す) */
    function toggleHref(name: 'deleted' | 'all', on: boolean): string {
        const params = new URLSearchParams();
        if (name === 'all' ? !on : data.showFinished) params.set('all', '1');
        if (name === 'deleted' ? !on : data.showDeleted) params.set('deleted', '1');
        const search = params.toString();
        return search === '' ? resolve('') : `${resolve('')}?${search}`;
    }
    const deletedHref = $derived(toggleHref('deleted', data.showDeleted));
    const finishedHref = $derived(toggleHref('all', data.showFinished));

    /**
     * **「まとめて表示」(issue #480)。** 端末ごとに cookie で覚え、**サーバが読む**
     * (`+page.server.ts`)。予約にも録画にも効き、同じ番組でも線の上と下で別の見出しになる
     */
    // svelte-ignore state_referenced_locally
    let grouped = $state(data.grouped);
    /** 開いた番組の鍵。側ごとに分けて覚える (`future:アニメ`) */
    const openKey = (zone: 'future' | 'past', group: string) => `${zone}:${group}`;
    function isOpen(zone: 'future' | 'past', group: string): boolean {
        return openedGroups.has(openKey(zone, group));
    }
    function toggleGroup(zone: 'future' | 'past', group: string): void {
        const key = openKey(zone, group);
        if (openedGroups.has(key)) openedGroups.delete(key);
        else openedGroups.add(key);
    }
    function setGrouped(on: boolean): void {
        grouped = on;
        pastPage.reset();
        // パスは接頭辞込み (`live-player.svelte.ts` の `remember` と同じ)
        document.cookie = `${GROUPED_COOKIE}=${on ? '1' : '0'}; path=${resolve('')}; max-age=31536000; samesite=lax`;
    }

    const lines = $derived(timelineLines(parts, { grouped, isOpen }));
    /** 線より上を、予約 (`ahead`) と「いま」の線から下 (`current`。線と録画中) に分ける */
    const nowAt = $derived(lines.above.findIndex((line) => line.kind === 'now'));
    const ahead = $derived(lines.above.slice(0, nowAt));
    const current = $derived(lines.above.slice(nowAt));
    /*
     * **線より下 (録れたもの) だけ少しずつ描く** (`#lib/paging.svelte.js`)。300 件を一度に描くと、
     * 開いた直後に一瞬止まって見えた。線より上 (予約) は全部描く — 上へ足すと、位置合わせの無い
     * ブラウザ (iPad の Safari) では読んでいる所が跳ねる
     */
    const pastPage = new Paged(() => lines.below, 60);

    /**
     * まだ描いていない**録れたものの本数** (「残り N 件」)。閉じた見出し1つに何本も入っているので、
     * 描く行の数 (`pastPage.rest`) では数えない
     */
    const pastRest = $derived.by(() => {
        let shown = 0;
        for (const line of pastPage.rows) {
            if (line.kind === 'row') shown += 1;
            else if (line.kind === 'head' && !line.open) shown += line.group.items.length;
        }
        return Math.max(0, parts.past.length - shown);
    });

    /** 最後に詳細を開いた行 (薄く塗って、どれを開いていたかを見せる) */
    let selectedKey = $state<string | null>(null);
    /** エンコードを待っている・している録画 (動いているものが先) */
    const encoding = $derived(
        data.recordings
            .filter((rec) => rec.job_id !== null && rec.deleted_at === null)
            .sort((a, b) => Number(b.job_state === 'running') - Number(a.job_state === 'running')),
    );
    /** 次の録画 (頭の1行・サイドバーのまとめ)。絞り込みに関係なく、これからの予約のうちいちばん早いもの */
    const nextRes = $derived.by(() => {
        let next: Res | null = null;
        for (const item of items) {
            if (item.kind !== 'res' || item.zone !== 'future' || !cancelable(item.res)) continue;
            if (item.res.state === 'skipped') continue;
            if (next === null || item.res.start_at < next.start_at) next = item.res;
        }
        return next;
    });
    /** 「あと 25 分」。1日より先は日数で */
    function untilLabel(at: number): string {
        const min = Math.max(0, Math.round((at - clock) / 60_000));
        if (min < 60) return `あと${min}分`;
        if (min < 24 * 60) return `あと${Math.floor(min / 60)}時間${min % 60 === 0 ? '' : `${min % 60}分`}`;
        return `あと${Math.floor(min / (24 * 60))}日`;
    }
    /** 日付の見出しの字。今日・明日・昨日は言葉で、ほかは日付 */
    function dayLabel(at: number): string {
        return dayName(at, clock) ?? date(at);
    }

    /*
     * ---- 開いたときの位置 ----
     *
     * **観終えていない録画があれば、いちばん古いものを映す** — 溜まったぶんを古い順に片付けられるように。
     * 無ければ「いま」の線。描いていない所 (60 件より先) にあれば、そこまで描いてから送る。
     * 並べ替えや絞り込みのたびには動かさない (開いたときの1回だけ)
     */
    let listBox: HTMLElement | undefined = $state();
    let placed = false;
    async function place(): Promise<void> {
        const target = catchUp(parts.past, unfinished);
        if (target !== null) {
            const index = lineIndex(lines.below, target.key);
            if (index >= pastPage.shown) pastPage.showUpTo(index + 1);
        }
        await tick();
        if (listBox === undefined) return;
        const list = listBox;
        placeTimeline(list, target?.key ?? null);
        // 字 (放送の字は後から届く) とポスターで行の高さが変わると、見出しの下で行が半分に切れる。届いてから合わせ直す。
        // その間に自分で動かしていたら触らない (動かした所を奪わない)
        const where = () => (getComputedStyle(list).overflowY === 'auto' ? list.scrollTop : window.scrollY);
        const before = where();
        await document.fonts.ready;
        requestAnimationFrame(() => {
            if (Math.abs(where() - before) < 1) alignTop(list);
        });
    }

    /**
     * **絞り込みを替えても、見ていた行をその場に残す。** 替える前に見えている所のいちばん上の行を覚え、
     * 替えたあともその行があれば同じ高さに戻す (無くなっていれば「いま」の線)。
     * 絞り込みは画面の中だけで替える (URL も読み込みも動かさない)。一覧の枠は位置合わせを自分でする
     * (`overflow-anchor: none`) ので、何もしないと「すべて」に戻したとき頭まで跳んでいた
     */
    let filtering: Promise<void> = Promise.resolve();
    /** 続けて押されたら順に替える (前の位置合わせが済んでから、次の「見ていた行」を覚える) */
    function setFilter(next: Filter): Promise<void> {
        filtering = filtering.then(() => applyFilter(next));
        return filtering;
    }
    async function applyFilter(next: Filter): Promise<void> {
        if (next === filter) return;
        const anchor = listBox === undefined ? null : topRow(listBox);
        filter = next;
        pastPage.reset();
        if (anchor !== null) {
            const index = lineIndex(lines.below, anchor.key);
            if (index >= pastPage.shown) pastPage.showUpTo(index + 1);
        }
        await tick();
        if (listBox !== undefined) restoreRow(listBox, anchor);
    }
    $effect(() => {
        if (listBox === undefined || placed) return;
        placed = true;
        untrack(() => void place());
    });


    setHome({
        get clock() {
            return clock;
        },
        get pickedKey() {
            return selectedKey;
        },
        select(key) {
            selectedKey = key;
        },
        deleting,
        cancelable,
        watchLink,
        unwatched,
        ruleFrom,
        openReservation,
        openRecording,
        openMissed,
        toggleGroup,
        dayLabel,
        untilLabel,
    });
</script>

<!-- 聞き返しは他所を触ったら取り下げる (`stand`) -->
<svelte:window onclick={deleting.stand} />

<!--
    「その他…」の中の、送るだけの項目。**閉じるのは送り終わってから** (`done`) — 先に閉じると、
    断られたときの通知 (Toasts) が出る前に画面が変わってしまう
-->
{#snippet menuSubmit(
    action: string,
    label: string,
    testid: string,
    fields: Record<string, string | number>,
    done: () => void,
)}
    <form
        method="POST"
        {action}
        class="menu-form"
        use:submitting={() => async (options) => {
            await options.update();
            done();
        }}
    >
        {#each Object.entries(fields) as [name, value] (name)}
            <input type="hidden" {name} {value} />
        {/each}
        <button type="submit" role="menuitem" class="menu-item" data-keep-open data-testid={testid}>{label}</button>
    </form>
{/snippet}

<div class="board">
    <Toasts {notices} source={form} ondismiss={dropNote} />

    <TimelineBar
        {filter}
        {setFilter}
        {counts}
        {grouped}
        {setGrouped}
        {finishedHref}
        {deletedHref}
        showFinished={data.showFinished}
        showDeleted={data.showDeleted}
        capacity={data.capacity}
        {nextRes}
        {encoding}
    />

    <div class="t-main">
        <section class="t-list" bind:this={listBox} aria-label="予約と録画" data-testid="timeline">
            <!--
                側ごとに包む。日付の見出しは包みの中だけで貼り付くので、録れたものを読んでいる間に
                予約の見出しが頭に残らない
            -->
            <div class="t-rows">
                <div class="t-zone" data-zone="future">
                    {#each ahead as entry (entry.key)}
                        <TimelineEntry {entry} />
                    {/each}
                </div>
                {#each current as entry (entry.key)}
                    <TimelineEntry {entry} />
                {/each}
                <div class="t-zone" data-zone="past">
                    {#each pastPage.rows as entry (entry.key)}
                        <TimelineEntry {entry} />
                    {/each}
                </div>
            </div>
            {#if pastPage.more}
                <!-- 下端に近づいたら続きを足す (`sentinel`)。残りが無くなれば消える -->
                <div class="row-empty muted small num" use:sentinel={() => pastPage.reveal()} data-testid="recording-more">
                    残り {pastRest} 件
                </div>
            {/if}
            {#if shownItems.length === 0}
                {#if items.length === 0}
                    <!-- 空のときは次に何をすればよいかまで言う -->
                    <div class="empty">
                        <p class="empty-title">予約も録画もありません</p>
                        <p class="empty-hint">番組表から予約するか、ルールを作ると自動で入ります</p>
                        <div class="empty-actions">
                            <a class="button small" href={resolve('guide')}>番組表を開く</a>
                            <a class="button secondary outline small" href={resolve('rules')}>ルールを作る</a>
                        </div>
                    </div>
                {:else}
                    <div class="empty">
                        <p class="empty-title">当てはまるものはありません</p>
                    </div>
                {/if}
            {/if}
            <!-- 絞った結果の件数は一覧の末尾に -->
            {#if filter !== 'all'}
                <div class="row-empty muted small num" data-testid="timeline-matched">
                    {items.length} 件中 {shownItems.length} 件
                </div>
            {/if}
            <!--
                **300件で頭打ちなのを黙らない。** 溜まると古いものが黙って消え、「消えた」ように見える。
                上限に当たっていたら、検索へ誘う一行を出す (`+page.server.ts` の LIMIT 300)
            -->
            {#if data.recordings.length >= 300}
                <div class="row-empty truncated muted small">
                    新しい順に300件まで表示しています。古いものは検索で探してください。
                </div>
            {/if}
        </section>

        <HomeAside
            {filter}
            {setFilter}
            {counts}
            {grouped}
            {setGrouped}
            {finishedHref}
            {deletedHref}
            showFinished={data.showFinished}
            showDeleted={data.showDeleted}
            {encoding}
            {nextRes}
            capacity={data.capacity}
        />
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
    予約の詳細から取り消す。**行の「取消」と同じアクション** (`?/cancel`) なので、
    ルールが立てた予約でも作り直されない (戻すのは行の「戻す」から)。

    行にしか無かった頃は、詳細を開いて中身を確かめてから要らないと分かっても、
    一度閉じて行のボタンを探し直すことになっていた (番組表の詳細には前から在る)。
    **取り消せたら閉じる** — 番組表の詳細で予約・取消したときと同じ。
    取り消した行は一覧から消える (完了した予約も出しているときは「戻す」に変わる)
-->
{#snippet reservationActions()}
    {#if detailRes !== null}
        <!-- 録画の詳細と同じ入口。予約は番組を指しているので番組から作る -->
        <a
            class="button secondary outline"
            href={ruleFrom('program', detailRes.program_id)}
            data-testid="detail-rule"
        >
            ルールを作る
        </a>
    {/if}
    {#if detailRes !== null && cancelable(detailRes)}
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
            <button type="submit" class="outline danger" data-testid="detail-cancel">予約取消</button>
        </form>
    {/if}
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
                **並べるのはよく押すものだけ** — 端末に保存・ルールを作る。
                条件が揃うと10個のボタンが同じ見た目で並び、狭い画面では文字の
                途中で折り返していた。めったに押さないもの (視聴済みの付け外し・
                再エンコード) は「その他…」に畳む。
            -->
            {#if offline.usable && rec.library_path !== null}
                <!--
                    **端末に保存 (オフライン視聴)。** 落とすのはエンコードしたもの
                    (docs/offline.md)。元のTSしか無い録画はブラウザで再生できない
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
        {/if}
        <!--
            **ルールを作る。** 検索の画面の「ルールとして保存」へ、シリーズ名を入れた下書きを
            持って行く (保存はあちらで確かめてから)。既にこの番組を録っているルールが
            あれば、あちらがそのルールを案内する
        -->
        <a class="button secondary outline" href={ruleFrom('recording', rec.id)} data-testid="detail-rule">
            ルールを作る
        </a>
        {#if hasFile(rec)}
            <!--
                **めったに押さないものの置き場。** 上に開く (フッターは画面の
                下端にあるので、下に開くと枠から出る)。中身は上から
                視聴済みの付け外し、直すもの (再エンコード・CM検出) の順。

                **開け閉めは `Menu` (popover)。** 位置は画面に収まるようにずらす。

                **閉じている間も中身は DOM に置く。** どの項目が出るかを
                開かずに確かめられるように (e2e が数を見ている)。閉じた popover は
                `display: none` — 見えないまま居座ってクリックを食うことが無い
            -->
            <Menu side="top" align="end" class="more-menu" testid="detail-more-menu">
                {#snippet trigger(props)}
                    <button {...props} type="button" class="secondary outline" data-testid="detail-more">その他…</button>
                {/snippet}
                <!--
                    **未視聴の印を付け外しする** (`?/watched`)。末尾まで観れば勝手に外れる
                    ので、押すのは観直したいときか、よそで観たときくらい。どちらも続きの位置は消す
                    (残すと進捗バーが残って、押した結果が一覧に出ない)。
                    詳細は開いたときの行を持っているので、送ったら閉じる (`menuSubmit`)
                -->
                {@render menuSubmit(
                    '?/watched',
                    rec.watched_at === null ? '視聴済みにする' : '未視聴に戻す',
                    'watched-button',
                    { id: rec.id, watched: rec.watched_at === null ? '1' : '0' },
                    detail.close,
                )}
                {#if rec.job_id === null && encodeSource(rec) !== null}
                    <!--
                        録り直しの元になるのは元のTS。エンコード済みを元にしても
                        画質は戻らないので、元のTSがあるときだけ出す
                    -->
                    {@render menuSubmit('?/reencode', '再エンコード', 'reencode-button', { id: rec.id }, detail.close)}
                {/if}
                {#if rec.job_id === null && cmRedo(rec).state !== 'hidden'}
                    {@const redo = cmRedo(rec)}
                    <!--
                        **CM 検出だけやり直す** (再エンコードしない。encoder.runCmJob)。元のTSがあれば元のTSから、
                        無ければエンコードしたものから読み、チャプターを書き直す。CM を切ってエンコードしたものは戻せないので、
                        元のTSがあれば押したときに再エンコードを促し (サーバが断る)、無ければ理由を出して押せない。
                        閉じるのは投げ終わってから (再エンコードと同じ)
                    -->
                    {#if redo.state === 'disabled'}
                        <div role="menuitem" class="menu-item" aria-disabled="true" data-disabled tabindex="-1" data-testid="cm-redo-button">
                            CM検出をやり直す
                        </div>
                        <div class="menu-note muted small">{redo.reason}</div>
                    {:else}
                        {@render menuSubmit('?/redetectCm', 'CM検出をやり直す', 'cm-redo-button', { id: rec.id }, detail.close)}
                    {/if}
                {/if}
            </Menu>
        {/if}
        {@const watch = watchLink(rec)}
        {#if watch !== null}
            <!-- **主のボタンは再生だけ** (塗る。並びのいちばん右・狭い画面ではいちばん上) -->
            <a class="button" href={watch} data-testid="detail-play">再生</a>
        {/if}
    {/if}
{/snippet}

<style>
    /*
     * 一覧・行・頭の1行の見た目は部品と分け合うので `#lib/components/home/home.css` (`.board` の下だけに効く)。
     * ここに残すのは、一覧の外 (番組の詳細) に出るものだけ
     */
    /* 「その他…」の中身 (枠は `Menu` の中なので :global)。項目は左寄せで縦に積む (`app.css` の `.menu`) */
    :global(.more-menu) {
        width: 16rem;
        max-width: calc(100vw - 2rem);
    }
    .menu-form {
        display: contents;
    }
    /* 押せない項目のすぐ下に出す理由 (CM検出をやり直せないわけ)。項目と同じ字下げで、次の項目と線で分ける */
    .menu-note {
        padding: 0.4rem 0.6rem;
        border-bottom: 1px solid var(--dp-line);
        white-space: nowrap;
    }
</style>
