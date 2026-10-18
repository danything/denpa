<script lang="ts" module>
    import { SvelteSet } from 'svelte/reactivity';
    import { fadeIn } from '#lib/motion.svelte.js';

    /**
     * 「まとめて表示」で開いている番組 (まとめる鍵)。**その場かぎり覚える** —
     * モジュールに置くので、観る画面へ行って戻っても開いたまま。読み込み直すと閉じる
     */
    const openedGroups = new SvelteSet<string>();

    /**
     * ポスターに付ける (`{@attach}`)。読み込めたらふわっと出し (`fadeIn`)、読めなかったら隠して枠だけ残す
     * (ポスターの無い録画もある)。ハイドレーションの前に失敗していたらイベントはもう来ないので、付けた時点の様子も見る。
     *
     * **`use:` や `onerror` にしない。** `<img>` にそれを書くと、Svelte はサーバの HTML に
     * `onerror="this.__e=event"` を足す (ハイドレーション前のイベントを拾うため)。インラインのハンドラなので
     * CSP に止められる (`script-src-attr`)。`{@attach}` には足さない
     */
    function poster(img: HTMLImageElement): () => void {
        fadeIn(img);
        const hide = () => {
            img.style.display = 'none';
        };
        if (img.complete && img.naturalWidth === 0 && img.currentSrc !== '') hide();
        img.addEventListener('error', hide);
        return () => img.removeEventListener('error', hide);
    }
</script>

<script lang="ts">
    import { tick, untrack } from 'svelte';
    import { submitting } from '#lib/actions.js';
    import { arming } from '#lib/arming.svelte.js';
    import ActionButton from '#lib/components/ActionButton.svelte';
    import ArmedDelete from '#lib/components/ArmedDelete.svelte';
    import Menu from '#lib/components/Menu.svelte';
    import ProgramDetail from '#lib/components/ProgramDetail.svelte';
    import Icon from '#lib/components/player/Icon.svelte';
    import ServiceLogo from '#lib/components/ServiceLogo.svelte';
    import Toasts, { errorNotice, type Notice } from '#lib/components/Toasts.svelte';
    import { type DetailSeed, programDetail } from '#lib/detail.svelte.js';
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
        quietState,
        recordedDuration,
        rowState,
        size,
        stateLabel,
        time,
    } from '#lib/format.js';
    import { GROUPED_COOKIE, type SeriesGroup } from '#lib/grouping.js';
    import { liveUpdates } from '#lib/live-updates.svelte.js';
    import { clearFailed, offline, removeLocal, saveOffline } from '#lib/offline.svelte.js';
    import { Paged, sentinel } from '#lib/paging.svelte.js';
    import { cmRedo, encodeSource } from '#lib/source.js';
    import {
        catchUp,
        countFilters,
        dayName,
        FILTERS,
        type Filter,
        lineIndex,
        passes,
        sections,
        type TimelineItem,
        type TimelineLine,
        type Traits,
        timelineLines,
        type Zone,
    } from '#lib/timeline.js';
    import { resolve } from '$app/paths';
    import Check from '~icons/lucide/check';
    import ChevronRight from '~icons/lucide/chevron-right';
    import Info from '~icons/lucide/info';
    import ListFilter from '~icons/lucide/list-filter';
    import Play from '~icons/lucide/play';
    import X from '~icons/lucide/x';

    let { data, form } = $props();

    // 予約・録画のどちらが動いてもサーバが知らせてくる。
    // エンコードの進み具合だけは中身ごと届き、読み直さず行の数字を書き換える
    liveUpdates(['recordings', 'reservations'], { encode: applyEncodeProgress });

    const active = ['scheduled', 'conflict', 'skipped', 'recording'];
    /** 取り消せるか。録画しない (`skipped`) は放送が終われば履歴なので出さない */
    const cancelable = (res: { state: string; end_at: number }) =>
        active.includes(res.state) && !(res.state === 'skipped' && res.end_at <= Date.now());

    /**
     * 置き場の使用量。**主 (AV1) を先に出し、在るものだけ括弧に添える。**
     *
     * `ts_size` が持っているのは主のぶんだけなので、両方エンコードした録画では画面の
     * 数字と実際に使っている量が食い違っていた (H.264 のほうが大きいことも
     * ある)。「消していいのか、どれだけ空くのか」を1行で読めるようにする
     */
    function sizeLabel(rec: (typeof data.recordings)[number]): string {
        const extra = [
            rec.alt_size === null ? '' : `H.264 ${size(rec.alt_size)}`,
            rec.raw_size === null ? '' : `元のTS ${size(rec.raw_size)}`,
        ].filter((s) => s !== '');
        return extra.length === 0 ? size(rec.ts_size) : `${size(rec.ts_size)} (${extra.join('、')})`;
    }

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

    /** 予約・録り逃しの行に出す放送の枠 */
    function airing(row: { start_at: number; end_at: number }): string {
        return `${dateTime(row.start_at)}〜${time(row.end_at)} (${duration(row.start_at, row.end_at)})`;
    }

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

    /** 削除は2回押させる。挙動は3画面共通 ([arming.svelte.ts](../lib/arming.svelte.ts)) */
    const deleting = arming('[data-testid="delete-button"], [data-testid="delete-confirm"]');

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

    /** 録画・番組からルールを作る入口 (`rules/+page.server.ts` の `originOf`) */
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
     * 下が録れたもの。鍵は種類ごとに接頭辞を付ける (録画と予約でIDの空間が別のため)
     */
    type Res = (typeof data.reservations)[number];
    type Rec = (typeof data.recordings)[number];
    type Missed = (typeof data.missed)[number];
    type Item = TimelineItem &
        ({ kind: 'res'; res: Res } | { kind: 'rec'; rec: Rec } | { kind: 'missed'; res: Missed });

    /**
     * 予約をどの側に置くか。録画中は線の下、放送が終わっていないものは線の上。
     * 「完了分も表示」で出る終わった予約 (完了・失敗・取り消し) は録れたものの側
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

    const items = $derived<Item[]>([
        ...data.reservations.map(
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
                rec,
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
                item.kind === 'missed' ||
                (item.kind === 'rec' && (item.rec.state === 'failed' || (item.rec.encode_error ?? '') !== '')),
        };
    }

    /** 絞り込みのボタン (すべて・予約・録画中・未視聴・失敗)。その場かぎり */
    let filter = $state<Filter>('all');
    const filterLabel = $derived(FILTERS.find((f) => f.id === filter)?.label ?? '');
    /** 件数はボタンごとに数える (押す前に、押すと何件になるかが分かる) */
    const counts = $derived(countFilters(items, traitsOf));
    const shownItems = $derived(items.filter((item) => passes(filter, item, traitsOf(item))));
    const parts = $derived(sections(shownItems));

    /** 「削除済みも表示」「完了分も表示」の行き先。入っていれば外した URL へ (ほかの指定は残す) */
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
    $effect(() => {
        filter;
        untrack(() => pastPage.reset());
    });

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

    /**
     * **サイドバーに出す1本。** 指を乗せた行・焦点のある行・最後に開いた行。何も選んでいなければ
     * 「いま」にいちばん近いもの (録画中、無ければ次の予約)。指で触る端末には乗せる操作が無いので、
     * 押して開いた行を覚えておく
     */
    let selectedKey = $state<string | null>(null);
    /**
     * 行に付ける (`{@attach}`)。指を乗せたとき・焦点が入ったときに、その行をサイドバーに出す。
     * 行そのものは押すものではない (押す的は中の入口とボタン) ので、属性のハンドラにはしない
     */
    function pickOn(key: string) {
        return (row: HTMLElement) => {
            const pick = () => {
                selectedKey = key;
            };
            row.addEventListener('mouseenter', pick);
            row.addEventListener('focusin', pick);
            return () => {
                row.removeEventListener('mouseenter', pick);
                row.removeEventListener('focusin', pick);
            };
        };
    }
    const selected = $derived.by((): Item | null => {
        const chosen = selectedKey === null ? undefined : items.find((item) => item.key === selectedKey);
        if (chosen !== undefined) return chosen;
        return parts.now[0] ?? parts.future.at(-1) ?? null;
    });
    /** 次の録画 (今日のまとめ)。絞り込みに関係なく、これからの予約のうちいちばん早いもの */
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
    /** 広い画面は一覧の枠が、狭い画面はページごとスクロールする */
    function scroller(): HTMLElement | null {
        if (listBox === undefined) return null;
        return getComputedStyle(listBox).overflowY === 'auto' ? listBox : null;
    }
    /** 一覧の上に被さるもの (狭い画面の検索の段・日付の見出し) の高さ */
    function coverOf(): number {
        const bar = document.querySelector<HTMLElement>('[data-testid="timeline-toolbar"]');
        return (bar !== null && getComputedStyle(bar).display !== 'none' ? bar.offsetHeight : 0) + 32;
    }
    /** 要素の上端が、見えている所の上から `offset` の位置に来るよう送る */
    function scrollToTop(element: HTMLElement, offset: number): void {
        const box = scroller();
        if (box !== null) {
            box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top - offset;
        } else {
            window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top - offset });
        }
    }
    async function place(): Promise<void> {
        const target = catchUp(parts.past, unfinished);
        if (target !== null) {
            const index = lineIndex(lines.below, target.key);
            if (index >= pastPage.shown) pastPage.showUpTo(index + 1);
        }
        await tick();
        const now = listBox?.querySelector<HTMLElement>('[data-testid="timeline-now"]');
        if (now === null || now === undefined) return;
        const box = scroller();
        const height = box !== null ? box.clientHeight : window.innerHeight;
        const cover = coverOf();
        // 線は見えている所の 3 割ほどの高さに。上に次の予約、下に新しい録画が入る
        scrollToTop(now, cover + (height - cover) * 0.25);
        if (target === null) return;
        const row =
            listBox?.querySelector<HTMLElement>(`[data-key="${target.key}"]`) ??
            listBox?.querySelector<HTMLElement>(`[data-group-rows~="${target.key}"]`);
        if (row === null || row === undefined) return;
        const bottom = box !== null ? box.getBoundingClientRect().bottom : window.innerHeight;
        // 線のまま見えているならそのまま。見えなければ、その行が下の端に来るまで送る
        if (row.getBoundingClientRect().bottom > bottom - 8) {
            scrollToTop(row, height - row.offsetHeight - 16 - (box === null ? tabbarHeight() : 0));
        }
    }
    function tabbarHeight(): number {
        return document.querySelector<HTMLElement>('[data-testid="tabbar"]')?.offsetHeight ?? 0;
    }
    $effect(() => {
        if (listBox === undefined || placed) return;
        placed = true;
        untrack(() => void place());
    });

    /** 絞り込みの下からの一枚 (狭い画面)。`<dialog>` なので焦点は中に閉じ込められ、Esc で閉じる */
    let sheet: HTMLDialogElement | undefined = $state();
    /** 一枚を開いているか。中身は開いている間だけ描く (サイドバーと同じ項目が二重に並ばないように) */
    let sheetOpen = $state(false);
    async function openSheet(): Promise<void> {
        sheetOpen = true;
        await tick();
        sheet?.showModal();
    }
    /** 表示の切り替え (サイドバー)。開け閉めはその場かぎり */
    let viewOpen = $state(false);
</script>

<!-- 聞き返しは他所を触ったら取り下げる (`stand`) -->
<svelte:window onclick={deleting.stand} />

<!--
    予約も録画も、**どの幅でも同じ1つの行の形**にする。左に「状態 + 番組名 + その他ぜんぶ」、
    右に押すもの。狭いところでは押すものが下へ回り込むだけで、出るものは変わらない。
    押すものは指で押せる大きさ (既定のボタン) にしてある
-->
<!--
    `fresh` はまだ観ていない録画 (`unwatched`)。番組名の頭に小さな点を置く。
    バッジ (「NEW」など) にしないのは、番組名に入っている [新] と紛れるのと、
    状態のバッジと2つ並ぶと番組名が押し出されるため
-->
<!--
    **行のどこを押しても、その行でいちばんやりたいことをする。** 入口は番組名で、押せる範囲を
    `::after` で行いっぱいに広げる (`.row-open`)。

    録画なら**観る画面へ** (`/watch/<id>`) のリンク (`<a>`)。一覧を開くのは観るためなので、
    そこを1回で通す。中身を読みたいときは行の中の「詳細」から。予約・録り逃し・観られない録画は
    詳細を開くボタン。リンクは SvelteKit が文書を読み込み直さずに遷移するので、
    **押した勢い (user activation) が切れない** — 観る画面は開いた時点で再生と全画面を
    始めるので (`watch/[id]`)、`location.href` で飛ぶと「押したのに何も起きない」になる。

    行の `<div>` を丸ごと `role="button"` にしていた頃は、押せるものの中に「詳細」「削除」の
    ボタンが入れ子になっていて (読み上げでは中身が平たく1つのボタンに潰れる)、
    リンクでもないので中クリックで別のタブにも開けなかった。行の中のボタンとルール名の
    リンクは広げた範囲より上に置く (`.row-actions` など)
-->
{#snippet title(
    state: string,
    badge: string,
    name: string,
    testid: string,
    open: string | (() => void),
    fresh = false,
    quiet = false,
)}
    <div class="cluster title-line">
        <!-- ふつうの状態 (`quietState`) はラベルを出さず、読み上げにだけ渡す -->
        <!-- 塗ったバッジ (録画中など、いま動いているもの) には、ゆっくり脈打つ点を添える (`app.css` の `.rec-dot`) -->
        <span class={quiet ? 'visually-hidden' : `tag ${badge}`} data-testid={testid}
            >{#if !quiet && badge.includes('solid')}<span class="rec-dot" aria-hidden="true"></span>{/if}{state}</span
        >
        {#if typeof open === 'string'}
            <!-- 行いっぱいが的なので、先読みは押したときだけ (一覧を撫でるだけで何本も読みに行かない) -->
            <a
                class="row-name row-open broadcast"
                href={open}
                data-sveltekit-preload-data="tap"
                data-testid="row-open"
            >
                {#if fresh}
                    <span class="unwatched-dot" role="img" aria-label="未視聴" data-testid="recording-unwatched"></span>
                {/if}
                {name}
            </a>
        {:else}
            <button type="button" class="row-name row-open broadcast" onclick={open} data-testid="row-open">
                {name}
            </button>
        {/if}
    </div>
{/snippet}

<!-- 局名・尺・サイズ。1行にまとめて、空のものは出さない -->
<!-- 局ロゴは**まだ取得できていない局では何も出さない** (ServiceLogo) -->
<!-- 局名は放送から来た字なので放送の字 (`.broadcast`)。残りはこちらで書いた字 -->
<!--
    **何でこの1本が立ったのか** (`rule`)。要らないものが混ざっていたときに直す先 (どのルールか) が分かるよう、
    ルール名をそのままルールの編集への入口にする。手動予約は、録れたもの (後から見返すもの) にだけ書く
-->
{#snippet meta(
    service: string,
    parts: string[],
    row: { service_id: number; has_logo: boolean | null },
    rule: { rule_id: number | null; rule_name: string | null } | 'manual' | null,
)}
    {@const rest = parts.filter(Boolean).join(' ・ ')}
    <div class="row-meta">
        <ServiceLogo
            id={row.service_id}
            has={row.has_logo}
            style="height: 1rem; margin-right: 0.375rem; vertical-align: -0.1875rem"
        />
        <span><span class="broadcast">{service}</span>{service && rest ? ' ・ ' : ''}<span class="num">{rest}</span></span>
        {#if rule === 'manual'}
            <span class="t-rule"> ・ <span data-testid="rule-name">手動予約</span></span>
        {:else if rule !== null}
            <span class="t-rule">
                ・
                <span data-testid="rule-name">
                    ルール:
                    {#if rule.rule_id !== null}
                        <a href={resolve(`rules?edit=${rule.rule_id}`)} title={rule.rule_name ?? undefined}>{rule.rule_name}</a>
                    {:else}
                        (削除済み)
                    {/if}
                </span>
            </span>
        {/if}
    </div>
{/snippet}

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

{#snippet posterImg(id: number)}
    <!-- 読めなければ画像を隠して枠だけ残す (`poster`) -->
    <img
        src={resolve(`api/recordings/${id}/poster`)}
        alt=""
        loading="lazy"
        class="poster-img"
        {@attach poster}
    />
{/snippet}

<!--
    **時刻の列。** 予約は始まりと終わり、録れたものは始まりだけ (日付は見出しにある)
-->
{#snippet clockCell(row: { start_at: number; end_at: number }, withEnd: boolean)}
    <span class="t-time num" aria-hidden="true">
        {time(row.start_at)}{#if withEnd}<span class="t-end">{time(row.end_at)}</span>{/if}
    </span>
{/snippet}

<!--
    **行の中の注意。** 行は 48px の 1 段 (広い画面) か 2 段 (狭い画面) にそろえ、言うことがあるときだけ
    下に 1 段足す。黙っていると「録れたつもり」になるもの (競合・欠ける・ロゴでCMを判定できなかった) だけ
-->

<!-- 予約の行 (これから・録画中・「完了分も表示」で出る終わった予約) -->
{#snippet resRow(item: Item & { kind: 'res' }, nested: boolean)}
    {@const res = item.res}
    <div
        data-testid="reservation-row"
        data-reservation-id={res.id}
        data-program-id={res.program_id}
        data-key={item.key}
        class="row t-row"
        class:nested
        class:live={item.zone === 'now'}
        class:picked={selected?.key === item.key}
        {@attach pickOn(item.key)}
    >
        {@render clockCell(res, true)}
        <div class="row-body" data-testid="row-body">
            {@render title(
                stateLabel(res.state),
                badgeClass(res.state),
                res.name,
                'reservation-state',
                () => {
                    selectedKey = item.key;
                    openReservation(res);
                },
                false,
                quietState(res.state),
            )}
            {@render meta(res.service_name, [duration(res.start_at, res.end_at)], res, res.manual ? null : res)}
            {#if res.conflict_reason}
                <div class="row-sub text-error small">{res.conflict_reason}</div>
            {/if}
            {#if clipNote(res) !== null}
                <div class="row-sub text-warning small">{clipNote(res)}</div>
            {/if}
        </div>
        <div class="row-actions">
            {#if res.recording_id !== null}
                <!-- 追っかけ再生 (issue #16)。録っている最中でも頭から観られる -->
                <a class="button" href={resolve(`chase/${res.recording_id}`)} data-testid="chase-button">追っかけ</a>
            {/if}
            {#if cancelable(res)}
                <ActionButton action="?/cancel" fields={{ id: res.id }} class="outline danger" testid="cancel-button">
                    <Icon icon={X} size="size-4" /><span class="btn-label">取消</span>
                </ActionButton>
            {:else if res.state === 'canceled' && res.end_at > clock}
                <!-- 取り消した予約はルールが作り直さないので、気が変わったときに戻せるのはここだけ -->
                <ActionButton action="?/restore" fields={{ id: res.id }} class="secondary" testid="restore-button">
                    戻す
                </ActionButton>
            {/if}
        </div>
    </div>
{/snippet}

<!-- 録り逃しの行。観るものが無いので、押すと詳細だけ出す。置くのは畳むための削除だけ -->
{#snippet missedRow(item: Item & { kind: 'missed' }, nested: boolean)}
    {@const res = item.res}
    <div
        data-testid="missed-row"
        data-program-id={res.program_id}
        data-key={item.key}
        class="row t-row"
        class:nested
        class:picked={selected?.key === item.key}
        {@attach pickOn(item.key)}
    >
        {@render clockCell(res, false)}
        <span class="t-thumb" aria-hidden="true"></span>
        <div class="row-body" data-testid="row-body">
            {@render title(stateLabel('missed'), badgeClass('missed'), res.name, 'missed-state', () => {
                selectedKey = item.key;
                openMissed(res);
            })}
            {@render meta(res.service_name, [duration(res.start_at, res.end_at)], res, res.manual ? 'manual' : res)}
        </div>
        <div class="row-actions">
            <!-- 構えの鍵は負の値にして、録画のIDと混ざらないようにする (deleting は録画と共用) -->
            <ArmedDelete
                {deleting}
                armKey={-res.id}
                action="?/deleteMissed"
                fields={{ id: res.id }}
                testid="delete-button"
                confirmTestid="delete-confirm"
                icon
            />
        </div>
    </div>
{/snippet}

<!--
    録画の行。押すと再生 (録っている最中は追っかけ)。中身を読みたいときは行の「詳細」から。
    置き場と尺と切ったCMの位置は属性にだけ持たせる (確かめる手段は残しておきたい)
-->
{#snippet recRow(item: Item & { kind: 'rec' }, nested: boolean)}
    {@const rec = item.rec}
    {@const link = watchLink(rec)}
    {@const shown = rowState(rec)}
    {@const held = offline.entries[rec.id]}
    <div
        data-testid="recording-row"
        data-recording-id={rec.id}
        data-program-id={rec.program_id}
        data-library-path={rec.library_path}
        data-alt-path={rec.alt_path}
        data-duration-ms={rec.duration_ms}
        data-cm-ranges={rec.cm_ranges === null ? null : JSON.stringify(rec.cm_ranges)}
        data-key={item.key}
        class="row t-row playable"
        class:nested
        class:picked={selected?.key === item.key}
        {@attach pickOn(item.key)}
    >
        {@render clockCell(rec, false)}
        <!-- ポスター。無い録画もあるので、読めなければ画像を隠して枠だけ残す。再生の印は観られるものだけ -->
        <span class="t-thumb" data-testid={link === null ? undefined : 'play-hint'} aria-hidden="true">
            {#if rec.library_path !== null}
                {@render posterImg(rec.id)}
            {/if}
            {#if link !== null}
                <span class="t-play"><Play class="poster-icon" /></span>
            {/if}
        </span>
        <div class="row-body" data-testid="row-body">
            {@render title(
                shown.label,
                shown.badge,
                rec.name,
                'recording-state',
                link ??
                    (() => {
                        selectedKey = item.key;
                        openRecording(rec);
                    }),
                unwatched(rec),
                shown.quiet,
            )}
            {@render meta(
                rec.service_name,
                [
                    recordedDuration(rec),
                    sizeLabel(rec),
                    rec.deleted_at !== null ? `${date(rec.deleted_at)} に削除` : '',
                ],
                rec,
                rec.from_manual === null ? null : rec.from_manual ? 'manual' : rec,
            )}
            {#if clipNote(rec, true) !== null}
                <div class="row-sub text-warning small">{clipNote(rec, true)}</div>
            {/if}
            {#if logoUnusable(rec.cm_note) && rec.deleted_at === null}
                <!-- ロゴでの判定が使えず、無音だけでCMを判定している。覚えたロゴはチューナー画面で確かめられる -->
                <div class="row-sub text-warning small">
                    ロゴでCMを判定できませんでした (無音だけで判定)
                    <span class="muted">— 覚えたロゴはチューナー画面で確かめられます</span>
                </div>
            {/if}
            {#if held !== undefined}
                <div class="row-sub small" data-testid="offline-state">
                    <span class="tag offline-tag {held.state === 'ready' ? 'success' : held.state === 'failed' ? 'error' : ''}">
                        {held.state === 'ready'
                            ? '端末に保存済み'
                            : held.state === 'failed'
                              ? '端末に保存できませんでした — 詳細からやり直せます'
                              : `端末に保存中${held.progress === null ? '…' : ` ${percent(held.progress)}`}`}
                    </span>
                </div>
            {/if}
            {#if rec.job_state === 'running' && rec.job_phase === 'encode'}
                <!-- SSE の生放送 (encode-live) があればそちら。読み直しを待たずに動く -->
                {@const live = encodeLive.entries[rec.id]}
                {@const liveEta = live !== undefined ? live.etaMs : rec.job_eta_ms}
                <div class="row-sub muted tiny num" data-testid="encode-progress">
                    {percent(live?.percent ?? rec.job_percent ?? 0)}
                    {#if eta(liveEta)}・{eta(liveEta)}{/if}
                </div>
            {:else if rec.job_state === 'running' && rec.job_log}
                <div class="row-sub muted tiny">{rec.job_log}</div>
            {/if}
        </div>
        <!--
            **途中まで観たものは残りを出す。** 観た位置は続きから始めるために持っていて、末尾まで観たものは
            消えるので、残っている = まだ途中。添える言葉は割合ではなく「あと何分か」
        -->
        {#if link !== null && rec.deleted_at === null && rec.progress !== null}
            {@const { at, length: span } = rec.progress}
            {@const frac = span > 0 ? Math.min(1, at / span) : 0}
            <span class="resume" data-testid="resume">
                <span class="resume-track"><span class="resume-fill" style="width: {frac * 100}%"></span></span>
                <span class="resume-left muted tiny num">残り{durationMs(Math.max(0, span - at))}</span>
            </span>
        {/if}
        <div class="row-actions">
            {#if link !== null}
                <!-- 行を押すと再生なので、中身を読む入口は別に置く。観られない行は行そのものが詳細の入口 -->
                <button
                    type="button"
                    class="secondary outline icon"
                    onclick={() => {
                        selectedKey = item.key;
                        openRecording(rec);
                    }}
                    aria-label="詳細"
                    title="詳細"
                    data-testid="detail-button"
                >
                    <Icon icon={Info} size="size-4" />
                </button>
            {/if}
            {#if rec.deleted_at === null}
                {#if rec.job_id !== null}
                    <!-- 動いている間は中断だけ。裏で ffmpeg が元のTSを読んでいるので、消させると道連れになる -->
                    {#if rec.job_canceling}
                        <button type="button" class="outline danger" disabled aria-busy="true" data-testid="encode-cancel">
                            エンコード中断
                        </button>
                    {:else}
                        <ActionButton action="?/cancelEncode" fields={{ id: rec.job_id }} class="outline danger" testid="encode-cancel">
                            エンコード中断
                        </ActionButton>
                    {/if}
                {:else}
                    <!-- サーバから消したら、端末に落としてあったコピーも片付ける -->
                    <ArmedDelete
                        {deleting}
                        armKey={rec.id}
                        fields={{ id: rec.id }}
                        submit={() => async (options) => {
                            await options.update();
                            if (options.result.type === 'success' && offline.entries[rec.id] !== undefined) {
                                void removeLocal(rec.id);
                            }
                        }}
                        testid="delete-button"
                        confirmTestid="delete-confirm"
                        icon
                    />
                {/if}
            {/if}
        </div>
        <!-- 進み具合は行の下端いっぱいに敷く。取れないときは動いているだけのバー -->
        {#if rec.job_id !== null}
            {@const barPercent = encodeLive.entries[rec.id]?.percent ?? rec.job_percent ?? 0}
            <progress
                class="row-bar"
                class:running={rec.job_state === 'running' && barPercent > 0}
                value={rec.job_state === 'running' && barPercent > 0 ? barPercent : undefined}
                max="1"
            ></progress>
        {:else if held?.state === 'downloading'}
            <progress class="row-bar success" class:running={held.progress !== null} value={held.progress ?? undefined} max="1"></progress>
        {/if}
    </div>
{/snippet}

{#snippet itemRow(item: Item, nested: boolean)}
    {#if item.kind === 'res'}
        {@render resRow(item, nested)}
    {:else if item.kind === 'missed'}
        {@render missedRow(item, nested)}
    {:else}
        {@render recRow(item, nested)}
    {/if}
{/snippet}

<!--
    **番組の見出し** (まとめて表示)。押すと開く・閉じる。本物の button なので、Tab で辿れて Enter / Space で開く。
    同じ番組でも線の上 (予約) と下 (録画) で別の見出し (`#lib/timeline.ts`)
-->
{#snippet groupHead(group: SeriesGroup<Item>, zone: 'future' | 'past', open: boolean)}
    {@const posterRec = group.items.findLast(
        (item) => item.kind === 'rec' && item.rec.library_path !== null && item.rec.deleted_at === null,
    )}
    {@const fresh = group.items.filter((item) => item.kind === 'rec' && unwatched(item.rec)).length}
    {@const next = zone === 'future' ? (group.items[0] ?? group.newest) : group.newest}
    <button
        type="button"
        class="group-head"
        aria-expanded={open}
        onclick={() => toggleGroup(zone, group.group)}
        data-testid="recording-group"
        data-zone={zone}
        data-group={group.group}
        data-group-rows={group.items.map((item) => item.key).join(' ')}
    >
        <span class="group-chevron" class:open aria-hidden="true">
            <Icon icon={ChevronRight} size="size-4" />
        </span>
        <span class="t-thumb" aria-hidden="true">
            {#if posterRec?.kind === 'rec'}
                {@render posterImg(posterRec.rec.id)}
            {/if}
        </span>
        <span class="row-body">
            <span class="cluster title-line">
                <span class="tag num" data-testid="recording-group-count">{group.items.length}本</span>
                {#if fresh > 0}
                    <span class="group-unwatched tiny" data-testid="recording-group-unwatched">
                        <span class="unwatched-dot" aria-hidden="true"></span>未視聴{fresh}
                    </span>
                {/if}
                <span class="row-name broadcast" data-testid="recording-group-name">{group.name}</span>
            </span>
            <span class="row-meta num">
                {zone === 'future' ? `次 ${dateTime(next.at)}` : `最新 ${dateTime(group.newest.at)}`}
            </span>
        </span>
    </button>
    <!--
        開いた番組の頭に「ルールを作る」。見出しは開閉のボタンなので中には入れられない (押す的が入れ子になる)。
        元は録画ならいちばん新しい録画、予約なら次の回の番組
    -->
    {#if open}
        {@const recSource = group.items.findLast((item) => item.kind === 'rec')}
        {@const href =
            recSource?.kind === 'rec'
                ? ruleFrom('recording', recSource.rec.id)
                : next.kind === 'res' && next.res.program_id !== null
                  ? ruleFrom('program', next.res.program_id)
                  : null}
        {#if href !== null}
            <div class="group-tools">
                <a class="button small secondary outline" {href} data-testid="group-rule">ルールを作る</a>
            </div>
        {/if}
    {/if}
{/snippet}

{#snippet line(entry: TimelineLine<Item>)}
    {#if entry.kind === 'day'}
        <!-- 日付の見出し。見出しなので読み上げの見出し移動で辿れる。予約か録画かも言う -->
        <h2 class="t-day" data-testid="timeline-day" data-zone={entry.zone}>
            <span class="t-day-name">{dayLabel(entry.at)}</span>
            {#if dayName(entry.at, clock) !== null}<span class="t-day-date num">{date(entry.at)}</span>{/if}
            <span class="t-day-zone">{entry.zone === 'future' ? '予約' : '録画'}</span>
        </h2>
    {:else if entry.kind === 'side'}
        <h2 class="t-day" data-testid="timeline-side" data-zone={entry.zone}>
            <span class="t-day-name">{entry.zone === 'future' ? 'これからの予約' : '録画'}</span>
        </h2>
    {:else if entry.kind === 'now'}
        <!-- 「いま」の線。見出しにして、見出し移動でここへ来られるようにする (読み上げは「いま 14:32」) -->
        <h2 class="t-now" data-testid="timeline-now">
            <span class="t-now-label num">いま {time(clock)}</span>
        </h2>
    {:else if entry.kind === 'head'}
        {@render groupHead(entry.group, entry.zone, entry.open)}
    {:else}
        {@render itemRow(entry.item, entry.nested)}
    {/if}
{/snippet}

<!-- 絞り込みの並び。サイドバーと、狭い画面の下からの一枚で同じもの -->
{#snippet filterList(onpick: () => void)}
    <div class="s-list" role="group" aria-label="絞り込み">
        {#each FILTERS as f (f.id)}
            <button
                type="button"
                class="s-item"
                class:on={filter === f.id}
                aria-pressed={filter === f.id}
                onclick={() => {
                    filter = f.id;
                    onpick();
                }}
                data-testid="filter"
                data-filter={f.id}
            >
                <span>{f.label}</span>
                <span class="s-sub num" class:alert={f.id === 'failed' && counts.failed > 0} data-testid="filter-count">
                    {counts[f.id]}
                </span>
            </button>
        {/each}
    </div>
{/snippet}

<!-- 表示の切り替え。オン・オフの印 (`aria-pressed`) 付き。サイドバーと下からの一枚で同じもの -->
{#snippet viewList(done: () => void)}
    <div class="s-list" role="group" aria-label="表示の切り替え">
        <button
            type="button"
            class="s-item"
            aria-pressed={grouped}
            onclick={() => setGrouped(!grouped)}
            data-testid="recordings-group-toggle"
        >
            <span>まとめて表示</span>
            <span class="s-sub">{#if grouped}<Icon icon={Check} size="size-4" />{/if}</span>
        </button>
        <!-- URL で切り替えるのでリンク。入っているかは印と、読み上げには「オン」で -->
        <a class="s-item" href={finishedHref} data-testid="reservations-finished-toggle" data-on={data.showFinished}>
            <span>完了した予約も表示</span>
            <span class="s-sub">
                {#if data.showFinished}<Icon icon={Check} size="size-4" /><span class="visually-hidden">オン</span>{/if}
            </span>
        </a>
        <a class="s-item" href={deletedHref} data-testid="recordings-deleted-toggle" data-on={data.showDeleted}>
            <span>削除済みも表示</span>
            <span class="s-sub">
                {#if data.showDeleted}<Icon icon={Check} size="size-4" /><span class="visually-hidden">オン</span>{/if}
            </span>
        </a>
        <!-- 照合は送り終えてから閉じる (先に閉じると、結果の通知が出る前に一枚が消える) -->
        <form
            method="POST"
            action="?/reconcile"
            class="menu-form"
            use:submitting={() => async (options) => {
                await options.update();
                done();
            }}
        >
            <button type="submit" class="s-item" data-testid="reconcile-button"><span>ファイルと照合</span></button>
        </form>
    </div>
{/snippet}

<div class="board">
    <Toasts {notices} source={form} ondismiss={dropNote} />

    <!--
        狭い画面 (1000px 未満) の頭。絞り込みの一枚を開くボタン。いま効いている絞り込みと件数を添える
        (番組名で探すのは全体の検索。ホームには欄を置かない)
    -->
    <div class="t-toolbar" data-testid="timeline-toolbar">
        <button
            type="button"
            class="secondary outline t-filter-open"
            aria-haspopup="dialog"
            onclick={openSheet}
            data-testid="filter-open"
        >
            <Icon icon={ListFilter} size="size-5" />
            <span class="visually-hidden">絞り込みと表示:</span>
            <span>{filterLabel}</span>
            <span class="muted num">{counts[filter]}</span>
            {#if filter !== 'all' || grouped || data.showDeleted || data.showFinished}
                <span class="view-dot" aria-hidden="true"></span>
            {/if}
        </button>
    </div>

    <div class="t-main">
        <section class="t-list" bind:this={listBox} aria-label="予約と録画" data-testid="timeline">
            <!--
                側ごとに包む。日付の見出しは包みの中だけで貼り付くので、録れたものを読んでいる間に
                予約の見出しが頭に残らない
            -->
            <div class="t-rows">
                <div class="t-zone" data-zone="future">
                    {#each ahead as entry (entry.key)}
                        {@render line(entry)}
                    {/each}
                </div>
                {#each current as entry (entry.key)}
                    {@render line(entry)}
                {/each}
                <div class="t-zone" data-zone="past">
                    {#each pastPage.rows as entry (entry.key)}
                        {@render line(entry)}
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
                    <div class="empty" data-testid="timeline-empty">
                        <p class="empty-title">予約も録画もありません</p>
                        <p class="empty-hint">番組表から予約するか、ルールを作ると自動で入ります</p>
                        <div class="empty-actions">
                            <a class="button small" href={resolve('guide')}>番組表を開く</a>
                            <a class="button secondary outline small" href={resolve('rules')}>ルールを作る</a>
                        </div>
                    </div>
                {:else}
                    <div class="empty" data-testid="timeline-empty">
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

        <!--
            **右のサイドバー** (1000px 以上)。ウィンドウの端まで寄せ、1px の線で分けて、一覧とは別にスクロールする。
            上から絞り込み・表示の切り替え、今日のまとめ、選んだ番組
        -->
        <aside class="t-side" aria-label="絞り込みと選んだ番組" data-testid="sidebar">
            <h2 class="s-group s-first">絞り込み</h2>
            {@render filterList(() => {})}
            <h2 class="s-group">
                <button
                    type="button"
                    class="s-group-toggle"
                    aria-expanded={viewOpen}
                    onclick={() => (viewOpen = !viewOpen)}
                    data-testid="view-toggle"
                >
                    表示の切り替え
                    {#if grouped || data.showDeleted || data.showFinished}<span class="view-dot" aria-hidden="true"></span>{/if}
                    <span class="group-chevron" class:open={viewOpen} aria-hidden="true">
                        <Icon icon={ChevronRight} size="size-4" />
                    </span>
                </button>
            </h2>
            {#if viewOpen}
                {@render viewList(() => {})}
            {/if}

            <h2 class="s-group">今日</h2>
            <dl class="s-list s-stats" data-testid="summary">
                <div class="s-item s-static">
                    <dt>次の録画</dt>
                    <dd class="s-sub num">{nextRes === null ? 'なし' : `${time(nextRes.start_at)}・${untilLabel(nextRes.start_at)}`}</dd>
                </div>
                <div class="s-item s-static">
                    <dt>録画中</dt>
                    <dd class="s-sub num">{counts.recording} 本</dd>
                </div>
                <div class="s-item s-static">
                    <dt>未視聴</dt>
                    <dd class="s-sub num">{counts.unfinished} 本</dd>
                </div>
                {#if data.capacity !== null}
                    <!-- 空きと、あと何時間録れるか (issue #505。`disk.capacity`) -->
                    <div class="s-item s-static">
                        <dt>空き</dt>
                        <dd class="s-sub num" data-testid="recordings-capacity">
                            {data.capacity.free.replace(/^空き\s*/, '')}{data.capacity.hours === null ? '' : `・${data.capacity.hours}`}
                        </dd>
                    </div>
                {/if}
            </dl>

            {#if selected !== null}
                {@render selectedDetail(selected)}
            {/if}
        </aside>
    </div>

    <!-- 狭い画面の絞り込み。下から出る一枚 -->
    <dialog
        class="t-sheet"
        bind:this={sheet}
        aria-label="絞り込みと表示"
        data-testid="filter-sheet"
        onclose={() => (sheetOpen = false)}
    >
        <!-- 一枚の外 (背景) を押したら閉じる (番組の詳細と同じ作り) -->
        <button type="button" class="t-sheet-backdrop" tabindex="-1" aria-label="閉じる" onclick={() => sheet?.close()}></button>
        {#if sheetOpen}
            <div class="t-sheet-body">
            <div class="t-sheet-grip" aria-hidden="true"></div>
            <h2 class="s-group">絞り込み</h2>
            {@render filterList(() => sheet?.close())}
            <h2 class="s-group">表示の切り替え</h2>
            {@render viewList(() => sheet?.close())}
            {#if data.capacity !== null}
                <p class="s-note muted small num" data-testid="recordings-capacity-menu">
                    {data.capacity.free}{data.capacity.hours === null ? '' : `・${data.capacity.hours}`}
                </p>
            {/if}
            <button type="button" class="secondary t-sheet-close" onclick={() => sheet?.close()}>閉じる</button>
            </div>
        {/if}
    </dialog>
</div>

<!-- サイドバーの「選んだ番組」。再生・追っかけ・予約取消をその場に置く -->
{#snippet selectedDetail(item: Item)}
    {@const rec = item.kind === 'rec' ? item.rec : null}
    {@const base = item.kind === 'rec' ? item.rec : item.res}
    <h2 class="s-group">
        {#if item.zone === 'now'}いま録画中{:else if item.zone === 'future'}{untilLabel(base.start_at)}に録画{:else if item.kind === 'missed'}録り逃し{:else}録画済み{/if}
    </h2>
    <div class="t-detail" data-testid="selected-detail" data-key={item.key}>
        {#if rec !== null && rec.library_path !== null}
            {@const link = watchLink(rec)}
            {#if link !== null}
                <a class="t-hero" href={link} tabindex="-1" aria-label="再生">
                    {@render posterImg(rec.id)}
                    <span class="t-hero-play"><Play /></span>
                </a>
            {/if}
        {/if}
        <p class="t-detail-title broadcast">{base.name}</p>
        {@render meta(base.service_name, [airing(base)], base, null)}
        {#if rec !== null && rec.progress !== null && watchLink(rec) !== null}
            <p class="small muted num">続きから (残り{durationMs(Math.max(0, rec.progress.length - rec.progress.at))})</p>
        {/if}
        {#if base.description}
            <p class="t-desc small broadcast">{base.description}</p>
        {/if}
        <div class="t-detail-actions">
            {#if item.kind === 'rec'}
                {@const link = watchLink(item.rec)}
                {#if link !== null}
                    <a class="button" href={link} data-testid="selected-play"><Icon icon={Play} size="size-4" />再生</a>
                {/if}
                <button type="button" class="secondary outline" onclick={() => openRecording(item.rec)}>詳細</button>
            {:else if item.kind === 'res'}
                {#if item.res.recording_id !== null}
                    <a class="button" href={resolve(`chase/${item.res.recording_id}`)}>追っかけ</a>
                {/if}
                <button type="button" class="secondary outline" onclick={() => openReservation(item.res)}>詳細</button>
                {#if cancelable(item.res)}
                    <ActionButton action="?/cancel" fields={{ id: item.res.id }} class="outline danger" testid="selected-cancel">
                        予約取消
                    </ActionButton>
                {/if}
            {:else}
                <button type="button" class="secondary outline" onclick={() => openMissed(item.res)}>詳細</button>
            {/if}
        </div>
    </div>
{/snippet}

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
    取り消した行は一覧から消える (完了分を出しているときは「戻す」に変わる)
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
            **ルールを作る。** ルールの画面へ、シリーズ名を入れた下書きを
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
                        <div class="menu-note muted small" data-testid="cm-redo-reason">{redo.reason}</div>
                    {:else}
                        {@render menuSubmit('?/redetectCm', 'CM検出をやり直す', 'cm-redo-button', { id: rec.id }, detail.close)}
                    {/if}
                {/if}
            </Menu>
        {/if}
    {/if}
    <button type="button" class="secondary" onclick={() => detail.close()} data-testid="detail-close">閉じる</button>
{/snippet}

<style>
    .row {
        position: relative;
        cursor: pointer;
        padding: 0.75rem;
    }
    .row:hover {
        background: var(--dp-hover);
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
        gap: 0.125rem;
    }
    .row-name {
        font-weight: var(--dp-weight);
        overflow-wrap: anywhere;
    }
    /*
     * 行の入口 (上の `title`)。**見た目は番組名の字のまま** — リンクの色も下線も、
     * Pico のボタンの地・枠・余白も付けない。押せる範囲は `::after` で行
     * (`.row` は `position: relative`) いっぱいに広げる
     */
    .row-open {
        display: inline;
        width: auto;
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: none;
        box-shadow: none;
        color: inherit;
        /* 字の形は `.broadcast` に任せる (`font` でまとめて戻すと放送の字が外れる) */
        font-size: inherit;
        font-weight: var(--dp-weight);
        line-height: inherit;
        text-align: inherit;
        text-decoration: none;
        cursor: pointer;
    }
    /*
     * **重なりの順を数で書く。** 書かないと、薄くした字 (`.muted`・`.row-meta` の
     * `opacity`) が広げた範囲より上に描かれ、そこを押しても何も起きなかった
     * (`opacity` は重なりの層を作り、後に並ぶものが上に来る)。
     * 行 (`.row`) で層を閉じるので、隣の行や見出しには響かない
     */
    .row {
        isolation: isolate;
    }
    .row-open::after {
        content: '';
        position: absolute;
        inset: 0;
        z-index: 1;
    }
    /* 焦点の線は名前ではなく行のまわりに。外へ出すと一覧の枠で切れるので内側に引く */
    .row-open:focus-visible {
        outline: none;
    }
    .row-open:focus-visible::after {
        outline: 2px solid var(--pico-primary);
        outline-offset: -2px;
    }
    /*
     * 広げた範囲より上に置く。行の中のボタンとリンク (ルール名) はそれぞれの働きのまま押せる。
     * **リンクそのものではなく、それを包む段ごと上げる** — ルール名の段は薄くしてある
     * (`.muted` の `opacity`) ので、そこで重なりの層が閉じ、中のリンクにいくら大きい
     * `z-index` を付けても段ごと広げた範囲の下に潜っていた
     */
    .row-actions,
    .row-sub:has(:global(a)),
    .row-sub:has(:global(button)) {
        position: relative;
        z-index: 2;
    }
    /*
        flex にしない。録画済みの行は書くことが多く (サイズ・コーデック)、flex-wrap だと
        文字のかたまりごと次の行へ送られて、ロゴだけが1行に取り残される。
        ロゴを文の中の1文字として流せば、折り返すのは文の途中になる
    */
    .row-meta {
        margin-top: 0.25rem;
        font-size: 0.875rem;
        color: var(--dp-muted);
        overflow-wrap: anywhere;
    }
    .row-sub {
        margin-top: 0.125rem;
    }
    /*
     * **番組名・局と日時・ルール名は1行ずつで切る。** 折り返すとタイトルの長さで行の高さが
     * 変わり、並んだ「詳細」「削除」の位置が行ごとにずれて押しにくかった。はみ出す分は
     * 「…」で省く。全部は詳細 (番組名・局) と、押した先のルールの編集・title (ルール名) で読める。
     * 押せる範囲 (`.row-open::after`) は `.row` を基準に置いているので、ここで切っても欠けない
     */
    .title-line {
        flex-wrap: nowrap;
        min-width: 0;
    }
    .title-line > .tag {
        flex-shrink: 0;
    }
    .title-line .row-name,
    div.row-meta,
    .row-sub[data-testid='rule-name'] {
        display: block;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .row-empty {
        padding: 0.75rem;
    }
    /*
     * **一覧が空のとき。** 「録画はありません」を行と同じ小さな字で左上に置いていた
     * 頃は、大きな枠の隅に一言あるだけで、壊れているのか空なのか読み取れなかった。
     * 枠の真ん中に置き、次にすること (番組表・ルール) へのリンクを添える。
     * 畳まれる幅では枠が中身の高さなので、上下の余白だけが効く
     */
    .t-rows {
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
        font-weight: var(--dp-weight-bold);
        overflow-wrap: anywhere;
    }
    .empty-hint {
        font-size: 0.875rem;
        color: var(--dp-muted);
    }
    .empty-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 0.5rem;
        margin-top: 0.5rem;
    }
    .view-dot {
        width: 0.4rem;
        height: 0.4rem;
        border-radius: var(--dp-radius-full);
        background: var(--pico-primary-background);
    }
    /* オン・オフの印の場所。外れているときも幅を取って、字の頭を揃える */
    .menu-check {
        display: inline-flex;
        width: 1rem;
        flex-shrink: 0;
        color: var(--pico-primary);
    }
    /* まだ観ていない録画の点 (`unwatched`)。続きのバーと同じ主の色 */
    .unwatched-dot {
        display: inline-block;
        width: 0.5rem;
        height: 0.5rem;
        margin-right: 0.3rem;
        border-radius: var(--dp-radius-full);
        background: var(--pico-primary-background);
        vertical-align: 0.1em;
    }
    .group-unwatched {
        display: inline-flex;
        align-items: center;
        white-space: nowrap;
    }
    .truncated {
        border-top: 1px solid var(--dp-line);
    }
    /*
     * 番組の見出し。**行と同じ形** (左にポスター、右に名前と日付) にして、
     * 1本だけの番組 (まとめずに混ぜる行) と並んでも浮かないようにする。
     * 押すものなので button だが、ボタンの見た目 (地・枠・中寄せ) は外す
     */
    .group-head {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem 0.75rem;
        width: 100%;
        margin: 0;
        padding: 0.75rem;
        border: 0;
        border-radius: 0;
        box-shadow: none;
        background: transparent;
        color: inherit;
        font-size: inherit;
        font-weight: inherit;
        text-align: left;
        cursor: pointer;
    }
    .group-head:hover {
        background: var(--dp-hover);
    }
    .group-head:focus-visible {
        outline: 2px solid var(--pico-primary-background);
        outline-offset: -2px;
    }
    .group-head .row-body,
    .group-head .row-meta {
        display: block;
    }
    .group-chevron {
        display: inline-flex;
        align-self: center;
        transition: transform var(--dp-duration);
    }
    .group-chevron.open {
        transform: rotate(90deg);
    }
    /* 開いた番組の頭の押すもの。中身の行と同じだけ下げる */
    .t-zone > .group-tools {
        padding: 0 0.75rem 0.5rem 2.25rem;
    }
    /* 番組の中の行。一段下げて、左に線を引いてどの見出しの中かを見せる */
    .row.nested {
        padding-left: 2.25rem;
        background: color-mix(in srgb, var(--dp-subtle) 30%, transparent);
    }
    .row.nested::before {
        content: '';
        position: absolute;
        inset-block: 0;
        left: 1.25rem;
        width: 2px;
        background: var(--dp-line);
    }
    .poster-img {
        height: 100%;
        width: 100%;
        object-fit: cover;
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
        border-radius: var(--dp-radius-full);
        background: var(--dp-line);
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
    /* 「その他…」の中身 (枠は `Menu` の中なので :global)。項目は左寄せで縦に積む (`app.css` の `.menu`) */
    :global(.more-menu) {
        width: 16rem;
        max-width: calc(100vw - 2rem);
    }
    /* 録画の見出しの「⋯」と「表示」の中身。項目が短いので細くする */
    :global(.tools-menu),
    :global(.view-menu) {
        width: 12rem;
    }
    .menu-form {
        display: contents;
    }
    /*
     * ---- 1本の時間軸 ----
     *
     * **広い画面 (768px 以上) では main の余白の外まで広げ、一覧とサイドバーがそれぞれ自分で巻き取る**
     * (ルール・観る画面と同じ。`+layout.svelte` の `FILLED`)。サイドバーは 1000px 以上で、右の端まで寄せて
     * 1px の線で分ける。狭い画面はページごとスクロールし、頭の検索の段だけ上に貼り付く
     */
    .board {
        display: flex;
        flex-direction: column;
    }
    @media (min-width: 768px) {
        .board {
            height: calc(100% + 2 * var(--dp-gutter));
            margin: calc(-1 * var(--dp-gutter));
        }
    }
    .t-main {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        flex: 1;
        min-height: 0;
    }
    .t-list {
        position: relative;
        min-width: 0;
    }
    @media (min-width: 768px) {
        .t-list {
            overflow-y: auto;
            /* 足した行で読んでいる所が動かないように、位置合わせは自分でする (開いたときの `place`) */
            overflow-anchor: none;
            padding: 0 calc(var(--dp-gutter) - 0.5rem) 1rem;
        }
    }
    .t-side {
        display: none;
    }
    @media (min-width: 1000px) {
        .t-main {
            grid-template-columns: minmax(0, 1fr) 18rem;
        }
        .t-side {
            display: flex;
            flex-direction: column;
            min-height: 0;
            overflow-y: auto;
            padding: 1rem 0.625rem 1.5rem;
            border-left: 1px solid var(--dp-line);
        }
    }
    @media (min-width: 1280px) {
        .t-main {
            grid-template-columns: minmax(0, 1fr) 20rem;
        }
    }

    /* 狭い画面の頭。検索と絞り込みのボタン。ページごと動くので上に貼り付ける */
    .t-toolbar {
        position: sticky;
        top: 0;
        z-index: 5;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0;
        background: var(--dp-bg);
    }
    @media (min-width: 768px) {
        .t-toolbar {
            position: static;
            padding: 0.75rem var(--dp-gutter) 0.25rem;
        }
    }
    .t-filter-open {
        position: relative;
        display: inline-flex;
        flex-shrink: 0;
        align-items: center;
        gap: 0.5rem;
        width: auto;
        height: 2.75rem;
        margin: 0;
        padding: 0 1rem 0 0.75rem;
        font-size: 0.875rem;
    }
    .t-filter-open .view-dot {
        position: absolute;
        top: 0.4rem;
        right: 0.4rem;
    }
    /* サイドバーのある幅では、検索と絞り込みはサイドバーの頭に置く */
    @media (min-width: 1000px) {
        .t-toolbar {
            display: none;
        }
    }

    /* 日付の見出し。小さく沈めた字で、一覧の頭に貼り付く */
    .t-day {
        position: sticky;
        top: 0;
        z-index: 3;
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        margin: 0;
        padding: 0.875rem 0.5rem 0.25rem;
        background: var(--dp-bg);
        color: var(--dp-muted);
        font-size: 0.75rem;
        font-weight: 600;
    }
    .t-day-name {
        color: var(--pico-color);
    }
    .t-day-date,
    .t-day-zone {
        font-weight: 400;
    }
    /* 狭い画面は頭の検索の段の下に貼り付く */
    @media (max-width: 767px) {
        .t-day {
            top: 3.75rem;
        }
    }

    /* 「いま」の線 */
    .t-now {
        position: relative;
        display: flex;
        align-items: center;
        height: 1.75rem;
        margin: 0.5rem 0 0.25rem;
        font-size: inherit;
    }
    .t-now::before {
        content: '';
        position: absolute;
        inset-inline: 0;
        top: 50%;
        height: 2px;
        background: var(--dp-rec);
    }
    .t-now-label {
        position: relative;
        padding: 0.1rem 0.6rem;
        border-radius: var(--dp-radius-full);
        background: var(--dp-rec);
        color: #fff;
        font-size: 0.75rem;
        font-weight: 700;
    }

    /*
     * **行。** 線も枠も無く地の上に直に並べ、触れると薄い塗り、選んでいる行 (サイドバーに出ている行) は
     * もう少し濃い塗り (ルールの一覧と同じ作り)。高さは指で押せる 48px。広い画面は 1 段、
     * サイドバーと並んで狭くなる幅 (1000〜1279px) と狭い画面は、番組名の下に局と尺を置く 2 段
     */
    .t-rows {
        display: flex;
        flex-direction: column;
    }
    .t-zone {
        display: flex;
        flex-direction: column;
    }
    /* 狭い画面では、途中まで観たものの残りは出さない (番組名に幅を回す) */
    @media (max-width: 767px) {
        .t-row .resume {
            display: none;
        }
    }
    .t-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0 0.75rem;
        min-height: 3rem;
        margin-bottom: 1px;
        padding: 0.25rem 0.5rem;
        border-radius: var(--dp-radius);
        transition: background-color var(--dp-duration);
    }
    .t-row:hover {
        background: color-mix(in srgb, var(--dp-subtle) 55%, transparent);
    }
    .t-row.picked {
        background: var(--dp-subtle);
    }
    .t-row.live {
        background: color-mix(in srgb, var(--dp-rec) 12%, transparent);
    }
    .t-row .row-body {
        flex: 1 1 0%;
        min-width: 0;
    }
    .t-row .row-meta {
        margin-top: 0;
        font-size: 0.78rem;
    }
    .t-row .row-actions {
        gap: 0.25rem;
    }
    /* 注意の段は時刻の列のぶん下げる (行の幅いっぱいに折り返す) */
    .t-row .row-sub {
        margin-top: 0.125rem;
    }
    .t-time {
        display: flex;
        flex-direction: column;
        flex-shrink: 0;
        width: 2.9rem;
        font-size: 0.8125rem;
        font-weight: 600;
        line-height: 1.15;
        white-space: nowrap;
    }
    .t-end {
        color: var(--dp-muted);
        font-size: 0.7rem;
        font-weight: 400;
    }
    .t-thumb {
        position: relative;
        flex-shrink: 0;
        width: 3.25rem;
        aspect-ratio: 16 / 9;
        overflow: hidden;
        border-radius: var(--dp-radius-sm);
        background: var(--dp-subtle);
    }
    .t-play {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        opacity: 0;
        background: rgb(0 0 0 / 0.45);
        transition: opacity var(--dp-duration);
    }
    .t-play :global(.poster-icon) {
        width: 1.25rem;
        height: 1.25rem;
    }
    .playable:hover .t-play {
        opacity: 1;
    }
    /* ルール名は局と尺の後ろに添える。狭い画面では外す (詳細とサイドバーで見られる) */
    .t-rule a {
        position: relative;
        z-index: 2;
    }
    @media (max-width: 767px) {
        .t-rule,
        .resume {
            display: none;
        }
        /* 狭い画面の行の操作はアイコンだけ (字は読み上げにだけ渡す)。番組名に幅を回す */
        .t-row .row-actions :global(button:not([data-testid="delete-confirm"]) .btn-label) {
            position: absolute;
            width: 1px;
            height: 1px;
            overflow: hidden;
            clip-path: inset(50%);
            white-space: nowrap;
        }
        .t-row .row-actions :global(:is(button, a.button)) {
            padding-inline: 0.5rem;
        }
    }
    @media (min-width: 768px) {
        .t-time {
            flex-direction: row;
            align-items: baseline;
            gap: 0.25rem;
            width: 6.25rem;
            font-size: 0.875rem;
        }
        .t-end::before {
            content: '–';
            margin-right: 0.25rem;
        }
        .t-thumb {
            width: 3.5rem;
        }
    }
    /* 1 段にする幅 (サイドバーの無いタブレットの縦と、1280px 以上) */
    @media (min-width: 768px) and (max-width: 999px), (min-width: 1280px) {
        .t-row .row-body {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(0, 17rem);
            align-items: center;
            column-gap: 1rem;
        }
        .t-row .row-body > .row-sub,
        .t-row .row-body > :global(.row-sub) {
            grid-column: 1 / -1;
        }
    }
    @media (min-width: 1000px) and (max-width: 1279px) {
        .t-time {
            width: 3.25rem;
        }
        .t-end,
        .resume {
            display: none;
        }
    }
    .resume {
        display: inline-flex;
        flex-shrink: 0;
        align-items: center;
        gap: 0.4rem;
        margin: 0;
    }
    .resume-track {
        width: 3rem;
        flex: none;
    }

    /* 番組の見出し (まとめて表示)。行と同じ作り */
    .group-head {
        min-height: 3rem;
        margin-bottom: 1px;
        padding: 0.25rem 0.5rem;
        border-radius: var(--dp-radius);
        align-items: center;
    }
    .group-head:hover {
        background: color-mix(in srgb, var(--dp-subtle) 55%, transparent);
    }
    .t-zone > .group-tools {
        padding: 0 0.5rem 0.5rem 2.25rem;
    }
    .row.nested {
        padding-left: 2.25rem;
        background: transparent;
    }
    .row.nested::before {
        left: 1.25rem;
    }

    /*
     * ---- サイドバーの並び ----
     * ドキュメントの目次と同じ作り: 小さく沈めた見出し、線も枠も無い行、選んでいる行だけ角の丸い薄い塗り、
     * 件数などは小さく沈めた字
     */
    .s-group {
        display: flex;
        align-items: center;
        margin: 1rem 0 0.25rem;
        padding: 0 0.75rem;
        color: var(--dp-muted);
        font-size: 0.75rem;
        font-weight: 500;
    }
    .s-group.s-first {
        margin-top: 0.25rem;
    }
    .s-group-toggle {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        width: calc(100% + 1.5rem);
        min-height: 2rem;
        margin: 0 -0.75rem;
        padding: 0 0.75rem;
        border: 0;
        border-radius: var(--dp-radius);
        background: transparent;
        box-shadow: none;
        color: inherit;
        font-size: inherit;
        font-weight: inherit;
        text-align: left;
    }
    .s-group-toggle .group-chevron {
        margin-left: auto;
    }
    .s-group-toggle:hover {
        background: color-mix(in srgb, var(--dp-subtle) 55%, transparent);
    }
    .s-list {
        display: flex;
        flex-direction: column;
        gap: 1px;
        margin: 0;
    }
    .s-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        width: 100%;
        min-height: 2.5rem;
        margin: 0;
        padding: 0 0.75rem;
        border: 0;
        border-radius: var(--dp-radius);
        background: transparent;
        box-shadow: none;
        color: inherit;
        font-size: 0.875rem;
        font-weight: 400;
        text-align: left;
        text-decoration: none;
        transition: background-color var(--dp-duration);
    }
    .s-item:hover {
        background: color-mix(in srgb, var(--dp-subtle) 55%, transparent);
    }
    .s-item.on {
        background: var(--dp-subtle);
        font-weight: 600;
    }
    .s-static {
        min-height: 2rem;
    }
    .s-static:hover {
        background: transparent;
    }
    .s-stats dt,
    .s-stats dd {
        margin: 0;
        font-weight: 400;
    }
    .s-sub {
        display: inline-flex;
        align-items: center;
        color: var(--dp-muted);
        font-size: 0.8125rem;
        white-space: nowrap;
    }
    .s-sub.alert {
        color: var(--dp-rec-text);
        font-weight: 700;
    }
    .s-note {
        margin: 0.75rem 0.75rem 0;
    }

    /* 選んだ番組 */
    .t-detail {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0 0.75rem;
    }
    .t-hero {
        position: relative;
        display: block;
        aspect-ratio: 16 / 9;
        max-height: 9rem;
        overflow: hidden;
        border-radius: var(--dp-radius);
        background: var(--dp-subtle);
    }
    .t-hero-play {
        position: absolute;
        right: 0.75rem;
        bottom: 0.75rem;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2.75rem;
        height: 2.75rem;
        border-radius: var(--dp-radius-full);
        background: rgb(0 0 0 / 0.55);
        color: #fff;
    }
    .t-detail-title {
        margin: 0;
        font-size: 1.0625rem;
        font-weight: 700;
        line-height: 1.4;
    }
    .t-detail .row-meta {
        white-space: normal;
    }
    .t-desc {
        display: -webkit-box;
        margin: 0;
        overflow: hidden;
        -webkit-line-clamp: 6;
        line-clamp: 6;
        -webkit-box-orient: vertical;
        color: var(--dp-muted);
        line-height: 1.6;
    }
    .t-detail-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
    }
    .t-detail-actions :global(:is(button, a.button)) {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        width: auto;
        margin: 0;
        padding: 0.45rem 0.9rem;
        font-size: 0.875rem;
    }

    /* 狭い画面の絞り込み。下から出る一枚 (`<dialog>`) */
    .t-sheet {
        position: fixed;
        inset: 0;
        width: 100%;
        max-width: none;
        height: 100%;
        max-height: none;
        margin: 0;
        padding: 0;
        border: 0;
        background: transparent;
        color: inherit;
    }
    .t-sheet[open] {
        display: flex;
        align-items: flex-end;
        justify-content: center;
    }
    .t-sheet::backdrop {
        background: transparent;
    }
    .t-sheet-backdrop {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: var(--dp-backdrop);
        box-shadow: none;
        cursor: default;
    }
    .t-sheet-body {
        position: relative;
        width: 100%;
        max-width: 32rem;
        max-height: 85%;
        overflow-y: auto;
        padding: 0.5rem 0.75rem calc(1rem + env(safe-area-inset-bottom));
        border-radius: var(--dp-radius-lg) var(--dp-radius-lg) 0 0;
        background: var(--dp-surface);
    }
    .t-sheet-grip {
        width: 2.5rem;
        height: 0.25rem;
        margin: 0 auto 0.5rem;
        border-radius: var(--dp-radius-full);
        background: var(--dp-line);
    }
    .t-sheet .s-item {
        min-height: 2.75rem;
    }
    .t-sheet-close {
        width: 100%;
        margin: 1rem 0 0;
    }
</style>
