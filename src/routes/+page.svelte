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
    import {
        flatLines,
        GROUPED_COOKIE,
        type GroupLine,
        groupBySeries,
        groupLines,
        type SeriesGroup,
    } from '#lib/grouping.js';
    import { liveUpdates } from '#lib/live-updates.svelte.js';
    import { fadeIn } from '#lib/motion.svelte.js';
    import { clearFailed, offline, removeLocal, saveOffline } from '#lib/offline.svelte.js';
    import { matches, normalize } from '#lib/paging.js';
    import { Paged, sentinel } from '#lib/paging.svelte.js';
    import { cmRedo, encodeSource } from '#lib/source.js';
    import { resolve } from '$app/paths';
    import Check from '~icons/lucide/check';
    import ChevronDown from '~icons/lucide/chevron-down';
    import ChevronRight from '~icons/lucide/chevron-right';
    import Ellipsis from '~icons/lucide/ellipsis';
    import Info from '~icons/lucide/info';
    import ListFilter from '~icons/lucide/list-filter';
    import ListTree from '~icons/lucide/list-tree';
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

    /** 番組の中で、いちばん新しい回から遡って `test` に合う録画。無ければ null */
    function newestRec(
        group: SeriesGroup<RightRow>,
        test: (rec: (typeof data.recordings)[number]) => boolean = () => true,
    ): number | null {
        const row = group.items.findLast((row) => row.kind === 'rec' && test(row.rec));
        return row?.kind === 'rec' ? row.rec.id : null;
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
     * 右の一覧の並び。**録れたものと録り逃しを1本にして放送日順で出す。**
     *
     * 録り逃しは「これから録るもの」ではなく**録画の結果**なので、予約側では
     * なくこちらに混ぜる。ただし録画の行を持たない (始まらないまま放送が
     * 終わった — `+page.server.ts` の `missed`) ので、ここで差し込む。
     * 鍵は種類ごとに接頭辞を付ける (録画と予約でIDの空間が別のため)
     */
    type RightRow = { key: string; at: number; group: string; groupName: string } & (
        | { kind: 'rec'; rec: (typeof data.recordings)[number] }
        | { kind: 'missed'; res: (typeof data.missed)[number] }
    );

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
                (rec): RightRow => ({
                    kind: 'rec',
                    key: `rec-${rec.id}`,
                    at: rec.start_at,
                    group: rec.group_key,
                    groupName: rec.group_name,
                    rec,
                }),
            ),
            ...data.missed.map(
                (res): RightRow => ({
                    kind: 'missed',
                    key: `missed-${res.id}`,
                    at: res.start_at,
                    group: res.group_key,
                    groupName: res.group_name,
                    res,
                }),
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

    /** 「削除済みも表示」の行き先 (「表示」のメニューの項目)。入っていれば外した URL へ */
    const deletedHref = $derived(data.showDeleted ? resolve('') : `${resolve('')}?deleted=1`);
    /** 「完了分も表示」の行き先 (予約の「表示」のメニュー) */
    const finishedHref = $derived(data.showFinished ? resolve('') : `${resolve('')}?all=1`);
    /** 録画の見出しの「⋯」。照合を送り終えたら閉じる */
    let toolsOpen = $state(false);
    /** 録画の枠 (中だけスクロールする)。まとめる・まとめないを切り替えたときに置き直す */
    let recordingBox: HTMLElement | undefined = $state();
    /**
     * **「まとめて表示」(issue #480)。** 端末ごとに cookie で覚え、**サーバが読む**
     * (`+page.server.ts`)。localStorage に置いていた頃はハイドレーションの後でしか
     * 読めず、読むまで枠を隠していた (狭い画面で平らな一覧が一度出てから縮むため)
     */
    // svelte-ignore state_referenced_locally
    let grouped = $state(data.grouped);
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
    /** 絞り込みが効いているか。空白だけなら何も絞らない (`matches` と同じ読み方) */
    const filtering = $derived(normalize(recordingQuery).trim() !== '');
    /**
     * 描く行。まとめるときは番組ごとに見出しを立てる (`#lib/grouping.ts`)。
     * **絞っている間は番組を全部開く** — 当たった回が見出しの奥に隠れていると、
     * 絞った意味が無い
     */
    const recordingLines = $derived<GroupLine<RightRow>[]>(
        grouped
            ? groupLines(groupBySeries(recordingRows), (group) =>
                  filtering ? !closedWhileFiltering.has(group) : openedGroups.has(group),
              )
            : flatLines(recordingRows),
    );
    /*
     * **まとめないときは頭と尻の両方を描く** (`Paged` の `ends`)。広い画面では
     * 一番下 (いちばん古い録画) から見せるので、尻が描けていないと開いた所が空になる。
     * 狭い画面はページごと上から見るので頭が要る。サーバはどちらの幅か知らないので両方。
     * 続きは間 (「残り N 件」) に足す
     */
    const recordingPage = new Paged(() => recordingLines, 60, () => !grouped);
    /** 間に置く印。頭からだけ出すとき (まとめて表示) は末尾に来る */
    const GAP = { kind: 'gap', key: 'gap' } as const;
    /**
     * 描くもの。**1本の `each` で回す** — 頭と尻を別の `each` にすると、間が
     * 詰まったときに尻の行が全部作り直しになる
     */
    const recordingShown = $derived(
        recordingPage.more ? [...recordingPage.rows, GAP, ...recordingPage.tail] : recordingPage.rows,
    );

    /**
     * 絞っている間に閉じた番組。**絞り込みが変わったら忘れる。**
     * 絞っている間の開閉を `openedGroups` で覚えると、見た目は開いたまま
     * 覚えだけが裏返り、絞り込みを消したときに思わぬ番組が開いて (閉じて) いた
     */
    const closedWhileFiltering = new SvelteSet<string>();
    $effect(() => {
        recordingQuery;
        untrack(() => closedWhileFiltering.clear());
    });

    /**
     * まだ描いていない**録画の本数** (「残り N 件」)。`recordingPage.rest` は描く行の
     * 数で、まとめると閉じた見出し1つに何本も入っているので、そちらでは数えない
     */
    const recordingRest = $derived.by(() => {
        let shown = 0;
        for (const line of recordingShown) {
            if (line.kind === 'row') shown += 1;
            else if (line.kind === 'gap') continue;
            else if (!line.open) shown += line.group.items.length;
        }
        return Math.max(0, recordingRows.length - shown);
    });

    function toggleGroup(group: string): void {
        const set = filtering ? closedWhileFiltering : openedGroups;
        if (set.has(group)) set.delete(group);
        else set.add(group);
    }

    /**
     * まとめる・まとめないを切り替える。**開いたときと同じ位置に置き直す** —
     * まとめたら一番上 (最近の番組)、戻したら一番下 (いちばん古い録画)。
     * 前の位置のままだと、並びが丸ごと変わったあとの中途半端な所が映る
     */
    async function setGrouped(on: boolean): Promise<void> {
        grouped = on;
        // 描く数も置き直す。前の形の数 (片側 30 件など) のままにしない
        recordingPage.reset();
        // パスは接頭辞込み (`live-player.svelte.ts` の `remember` と同じ)
        document.cookie = `${GROUPED_COOKIE}=${on ? '1' : '0'}; path=${resolve('')}; max-age=31536000; samesite=lax`;
        const box = recordingBox;
        if (box === undefined) return;
        await tick();
        /*
         * まとめないときの枠は下から積む (CSS の `.from-end`) ので、0 が一番下で上へは負。
         * 端を越えた値は端に丸まるので、どちらの向きでも大きく振れば端に着く。
         * 狭い画面では枠がスクロールしないので何も起きない
         */
        box.scrollTop = on ? -box.scrollHeight : box.scrollHeight;
    }

    /*
     * 絞り込みの言葉が変わったら先頭に戻す。`reset` は `grouped` を読むので外す
     * (切り替えたときは `setGrouped` が戻す)
     */
    $effect(() => {
        recordingQuery;
        untrack(() => recordingPage.reset());
    });

    /* ===== 見本 1: 1本の時間軸 ===== */
    type Res = (typeof data.reservations)[number];
    type Rec = (typeof data.recordings)[number];
    type TItem =
        | { kind: 'res'; key: string; at: number; res: Res }
        | { kind: 'now'; key: string; at: number; res: Res }
        | { kind: 'past'; key: string; at: number; row: RightRow };
    type TLine =
        | { kind: 'day'; key: string; label: string; sub: string }
        | { kind: 'now-line'; key: string }
        | { kind: 'item'; key: string; item: TItem };

    type Chip = 'all' | 'res' | 'now' | 'unwatched' | 'failed';
    let chip = $state<Chip>('all');
    let query = $state('');
    let sheetOpen = $state(false);
    let viewOpen = $state(false);

    const nowAt = Date.now();
    const DAY = 86_400_000;
    function dayStart(ms: number): number {
        const d = new Date(ms);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }
    const today = dayStart(nowAt);
    function dayLabel(ms: number): { label: string; sub: string } {
        const diff = Math.round((dayStart(ms) - today) / DAY);
        const named = ({ [-1]: '昨日', 0: '今日', 1: '明日' } as Record<number, string>)[diff];
        return { label: named ?? date(ms), sub: named === undefined ? '' : date(ms) };
    }

    const resText = (res: Res) =>
        [res.name, res.service_name, stateLabel(res.state), res.rule_name ?? '', dateTime(res.start_at)].join(' ');
    const isFailedRow = (row: RightRow) =>
        row.kind === 'missed' || row.rec.state === 'failed' || (row.rec.encode_error ?? '') !== '';

    const futureAll = $derived(data.reservations.filter((r) => r.state !== 'recording'));
    const nowAll = $derived(data.reservations.filter((r) => r.state === 'recording'));
    const counts = $derived({
        res: futureAll.length,
        now: nowAll.length,
        unwatched: rightRows.filter((r) => r.kind === 'rec' && unwatched(r.rec)).length,
        failed: rightRows.filter(isFailedRow).length,
        all: futureAll.length + nowAll.length + rightRows.length,
    });
    const CHIPS: { id: Chip; label: string }[] = [
        { id: 'all', label: 'すべて' },
        { id: 'res', label: '予約' },
        { id: 'now', label: '録画中' },
        { id: 'unwatched', label: '未視聴' },
        { id: 'failed', label: '失敗' },
    ];

    const lines = $derived.by(() => {
        const want = (c: Chip) => chip === 'all' || chip === c;
        const future = want('res')
            ? futureAll.filter((r) => matches(query, resText(r))).sort((a, b) => b.start_at - a.start_at)
            : [];
        const live = want('now') ? nowAll.filter((r) => matches(query, resText(r))) : [];
        const past = rightRows.filter((row) => {
            if (!matches(query, rightText(row))) return false;
            if (chip === 'all') return true;
            if (chip === 'unwatched') return row.kind === 'rec' && unwatched(row.rec);
            if (chip === 'failed') return isFailedRow(row);
            return false;
        });
        const out: TLine[] = [];
        let lastDay = -1;
        const head = (at: number, zone: string) => {
            const d = dayStart(at);
            if (d === lastDay) return;
            lastDay = d;
            const l = dayLabel(at);
            out.push({ kind: 'day', key: `${zone}-${d}`, label: l.label, sub: `${l.sub}　${zone === 'f' ? '予約' : '録画'}` });
        };
        for (const res of future) {
            head(res.start_at, 'f');
            out.push({ kind: 'item', key: `res-${res.id}`, item: { kind: 'res', key: `res-${res.id}`, at: res.start_at, res } });
        }
        out.push({ kind: 'now-line', key: 'now' });
        for (const res of live) {
            out.push({ kind: 'item', key: `now-${res.id}`, item: { kind: 'now', key: `now-${res.id}`, at: res.start_at, res } });
        }
        lastDay = -1;
        for (const row of past.slice(0, 120)) {
            head(row.at, 'p');
            out.push({ kind: 'item', key: row.key, item: { kind: 'past', key: row.key, at: row.at, row } });
        }
        return out;
    });

    /** 右の枠に出すもの。指を乗せた行、無ければ「いま」に近いもの */
    let hovered = $state<TItem | null>(null);
    const defaultItem = $derived.by((): TItem | null => {
        const live = nowAll[0];
        if (live) return { kind: 'now', key: `now-${live.id}`, at: live.start_at, res: live };
        const next = [...futureAll].sort((a, b) => a.start_at - b.start_at)[0];
        if (next) return { kind: 'res', key: `res-${next.id}`, at: next.start_at, res: next };
        return null;
    });
    const focused = $derived(hovered ?? defaultItem);
    const nextRes = $derived([...futureAll].sort((a, b) => a.start_at - b.start_at)[0] ?? null);
    const upcoming = $derived([...futureAll].sort((a, b) => a.start_at - b.start_at).slice(0, 8));

    let listBox: HTMLElement | undefined = $state();
    let nowLine: HTMLElement | undefined = $state();
    /** 開いたら「いま」の線まで送る (上が予約、下が録画) */
    $effect(() => {
        if (listBox === undefined || nowLine === undefined) return;
        const box = listBox;
        const line = nowLine;
        untrack(() => {
            const nav = document.querySelector<HTMLElement>(".navbar")?.offsetHeight ?? 0;
            document.querySelector<HTMLElement>(".t-board")?.style.setProperty("--t-top", `${nav}px`);
            const narrow = box.scrollHeight <= box.clientHeight + 1;
            if (narrow) {
                // 狭い画面はページごとスクロールする
                const bar = document.querySelector<HTMLElement>(".t-toolbar")?.offsetHeight ?? 0;
                const room = innerHeight - nav - bar;
                window.scrollTo({ top: line.getBoundingClientRect().top + window.scrollY - nav - bar - room * 0.22 });
            } else {
                box.scrollTop = line.offsetTop - box.clientHeight * 0.28;
            }
        });
    });

    function pickFocus(item: TItem): void {
        hovered = item;
    }
    function relative(at: number): string {
        const min = Math.round((at - nowAt) / 60000);
        if (min < 60) return `${min}分後`;
        if (min < 24 * 60) return `${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ''}後`;
        return `${Math.floor(min / 1440)}日後`;
    }
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

<!-- 局名・放送日時・尺・サイズ。1行にまとめて、空のものは出さない -->
<!-- 局ロゴは**まだ取得できていない局では何も出さない** (ServiceLogo) -->
<!-- 局名は放送から来た字なので放送の字 (`.broadcast`)。残りはこちらで書いた字 -->
{#snippet meta(service: string, parts: string[], row: { service_id: number; has_logo: boolean | null })}
    {@const rest = parts.filter(Boolean).join(' ・ ')}
    <div class="row-meta">
        <ServiceLogo
            id={row.service_id}
            has={row.has_logo}
            style="height: 1rem; margin-right: 0.375rem; vertical-align: -0.1875rem"
        />
        <span><span class="broadcast">{service}</span>{service && rest ? ' ・ ' : ''}<span class="num">{rest}</span></span>
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

<!--
    **何でこの1本が立ったのか。** 予約にも録画にも同じ形で出し、要らないものが
    混ざっていたときに直す先 (どのルールか) が分かるようにする。
    ルール名をそのまま入口にする。行にボタンを足すと窮屈になる
-->
{#snippet source(ruleId: number | null, ruleName: string | null, manual: boolean)}
    <div class="row-sub muted tiny" data-testid="rule-name">
        {#if manual}
            手動予約
        {:else}
            ルール:
            {#if ruleId !== null}
                <a href={resolve(`rules?edit=${ruleId}`)} title={ruleName ?? undefined}>{ruleName}</a>
            {:else}
                (削除済み)
            {/if}
        {/if}
    </div>
{/snippet}

{#snippet posterImg(id: number)}
    <!-- 読めなければ画像を隠して枠だけ残す -->
    <img
        src={resolve(`api/recordings/${id}/poster`)}
        alt=""
        loading="lazy"
        class="poster-img"
        use:fadeIn
        onerror={(event) => {
            (event.currentTarget as HTMLImageElement).style.display = 'none';
        }}
    />
{/snippet}

<!--
    録画一覧の1行 (録画・録り逃し)。まとめて表示では番組の中にも同じ行を出す (`nested` で一段下げる)
-->
{#snippet rightRow(row: RightRow, nested: boolean)}
    {#if row.kind === 'missed'}
        {@const res = row.res}
        <!--
            録り逃し。観るものが無いので、押すと詳細だけ出す (予約の行と
            同じ扱い)。置くのは畳むための削除だけ (再放送は番組表から予約し直す)
        -->
        <div data-program-id={res.program_id} class="row" class:nested={nested}>
            <div class="row-inner">
                <div class="row-body" data-testid="row-body">
                    {@render title(stateLabel('missed'), badgeClass('missed'), res.name, 'missed-state', () =>
                        openMissed(res),
                    )}
                    {@render meta(res.service_name, [airing(res)], res)}
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
        </div>
    {:else}
        {@const rec = row.rec}
        {@const link = watchLink(rec)}
        {@const canPlay = link !== null}
        {@const shown = rowState(rec)}
        <!-- 端末に入っているか (オフライン視聴)。行の印と、下のバーで見る -->
        {@const held = offline.entries[rec.id]}
        <!--
            押すと再生。中身を読みたいときは行の中の「詳細」から。

            **吹き出し (title) は出さない。** 行に指を乗せると色が反転し、
            再生の印も出ているので、そこを押せば再生になることは見れば分かる。
            出していた頃は、行を読もうとするたびに文字の上へバッジが被さっていた。

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
            class:nested={nested}
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
                        **ポスターを出す。** エンコードしたときに動画の隣へ置いた
                        `-poster.jpg` (`api/.../poster`)。文字だけの行より
                        ずっと選びやすい。**無い録画もある**
                        (ポスターより前にエンコードしたもの等) ので、読めなければ画像を
                        隠して枠だけ残す (`onerror`)。枠と再生印はいつでも出す
                    -->
                    <div class="poster" data-testid="play-hint">
                        {#if rec.library_path !== null}
                            {@render posterImg(rec.id)}
                        {/if}
                        <span class="poster-play" aria-hidden="true">
                            <Play class="poster-icon" aria-hidden="true" />
                        </span>
                    </div>
                {/if}
                <div class="row-body" data-testid="row-body">
                    <!--
                        録画の状態とエンコードの状態を1つにまとめて出す
                        (rowState)。消したもの (deleted) も録画の状態から
                        決まるので、ここで書き分けることは何も無い
                    -->
                    {@render title(
                        shown.label,
                        shown.badge,
                        rec.name,
                        'recording-state',
                        link ?? (() => openRecording(rec)),
                        unwatched(rec),
                        shown.quiet,
                    )}
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
                        rec.service_name,
                        [
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
                        位置も分母も観る物差し (エンコードしたものがあればその時刻) に直したもの
                        (`progress`。覚えている位置は元の TS の物差しなので、CM を切ったものでは
                        そのまま出来上がりの尺と比べると食い違う)。分母は実際に録れた長さで、無ければ番組表の尺。
                        添える言葉は割合ではなく**あと何分か** — 「観終わるのに
                        どれだけ掛かるか」が知りたいことで、4% では換算がいる
                    -->
                    {#if canPlay && rec.deleted_at === null && rec.progress !== null}
                        {@const { at, length: span } = rec.progress}
                        {@const frac = span > 0 ? Math.min(1, at / span) : 0}
                        <div class="resume">
                            <div class="resume-track">
                                <div class="resume-fill" style="width: {frac * 100}%"></div>
                            </div>
                            <span class="resume-left muted tiny num">
                                残り{durationMs(Math.max(0, span - at))}
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
                            なるので出す。**覚えたロゴはチューナー画面で確かめられる** —
                            録画ごとではなく局ごとの話で、覚え直せば以降の全部に効く。

                            **見つけられなかったときだけではない。** ロゴには合致した
                            のに結果が使い物にならなかったとき (番組の 100% がCM判定など)
                            も、覚えているほうが怪しいので同じことを出す
                        -->
                        <div class="row-sub text-warning small">
                            ロゴでCMを判定できませんでした (無音だけで判定)
                            <span class="muted">— 覚えたロゴはチューナー画面で確かめられます</span>
                        </div>
                    {/if}
                    <!--
                        エンコード中だけ、割合と残りの見込みを添える。
                        ffmpeg が回っていない段階 (解除中・CM検出中) は
                        進み具合が取れないので、代わりに**いま何をしているか**を出す。
                    -->
                    {#if rec.job_state === 'running' && rec.job_phase === 'encode'}
                        <!-- SSE の生放送 (encode-live) があればそちら。読み直しを待たずに動く -->
                        {@const live = encodeLive.entries[rec.id]}
                        {@const liveEta = live !== undefined ? live.etaMs : rec.job_eta_ms}
                        <div class="row-sub muted tiny num" data-testid="encode-progress">
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
                    押すものは枠の無いボタンに字とアイコン (`app.css` の `.row-actions`)。
                    押せることは字の色と指を乗せたときの地で分かる。削除は控えた色で、
                    指を乗せたときだけ赤い
                -->
                <div class="row-actions">
                    <!--
                        中身を読む入口は、**行を押しても詳細にならない行だけ**に置く。
                        観られる行は押すと再生に行くので、説明やCMの位置を見たい
                        ときの別口が要る。観られない行 (録画そのものの失敗・
                        削除済み・まだ何も録れていない) は行そのものが詳細の
                        入口 (`title` の `.row-open`) なので、同じ働きのボタンを並べない
                        (録り逃しの行とも揃う)。エンコードしている最中は観られる (追っかけ)
                    -->
                    {#if canPlay}
                        <button
                            type="button"
                            class="secondary outline"
                            onclick={() => openRecording(rec)}
                            data-testid="detail-button"
                        >
                            <Icon icon={Info} size="size-4" />詳細
                        </button>
                    {/if}
                    {#if rec.deleted_at === null}
                        <!-- 録り直しは詳細の中 (recordingActions) -->
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
                                    (畳み終わりの通知) までは、まだ中止の途中
                                -->
                                <button type="button"
                                    class="outline danger"
                                    disabled
                                    aria-busy="true"
                                    data-testid="encode-cancel"
                                >
                                    エンコード中断
                                </button>
                            {:else}
                                <ActionButton
                                    action="?/cancelEncode"
                                    fields={{ id: rec.job_id }}
                                    class="outline danger"
                                    testid="encode-cancel"
                                >
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
                                    // held は使わない。use: の引数は作ったときのまま閉じ込められるので、
                                    // あとから端末に保存した録画でも古い「無い」を見てしまう
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
                    class:running={rec.job_state === 'running' && barPercent > 0}
                    value={rec.job_state === 'running' && barPercent > 0
                        ? barPercent
                        : undefined}
                    max="1"
                ></progress>
            {:else if held?.state === 'downloading'}
                <!-- 端末への保存もエンコードと同じ見せ方。測れない間は動くだけのバー -->
                <progress
                    class="row-bar success"
                    class:running={held.progress !== null}
                    value={held.progress ?? undefined}
                    max="1"
                ></progress>
            {/if}
        </div>
    {/if}
{/snippet}

<!--
    **番組の見出し** (まとめて表示)。押すと開く・閉じる。本物の button なので、
    Tab で辿れて Enter / Space で開く。開いているかは `aria-expanded` で読み上げる。
    中身は見出しのすぐ下に放送順で続く (`#lib/grouping.ts`)
-->
{#snippet groupHead(group: SeriesGroup<RightRow>, open: boolean)}
    <!-- 見出しの画像は**いちばん新しい回のポスター**。エンコードしたものが無い回 (録り逃し・削除済み・エンコードする前) は飛ばして、その前の回を探す -->
    {@const poster = newestRec(group, (rec) => rec.library_path !== null && rec.deleted_at === null)}
    <!-- 閉じたままでも、まだ観ていない回があると分かるように数を添える (行の点と同じ決め方) -->
    {@const fresh = group.items.filter((row) => row.kind === 'rec' && unwatched(row.rec)).length}
    <button
        type="button"
        class="group-head"
        aria-expanded={open}
        onclick={() => toggleGroup(group.group)}
        data-testid="recording-group"
        data-group={group.group}
    >
        <span class="group-chevron" class:open aria-hidden="true">
            <Icon icon={ChevronRight} size="size-4" />
        </span>
        <span class="poster">
            {#if poster !== null}
                {@render posterImg(poster)}
            {/if}
        </span>
        <span class="row-body">
            <span class="cluster">
                <span class="tag num" data-testid="recording-group-count">{group.items.length}本</span>
                {#if fresh > 0}
                    <span class="group-unwatched tiny" data-testid="recording-group-unwatched">
                        <span class="unwatched-dot" aria-hidden="true"></span>未視聴{fresh}
                    </span>
                {/if}
                <span class="row-name broadcast" data-testid="recording-group-name">{group.name}</span>
            </span>
            <span class="row-meta num">最新 {dateTime(group.newest.at)}</span>
        </span>
    </button>
    <!--
        開いた番組の頭に「ルールを作る」。見出しそのものは開閉のボタンなので、
        中には入れられない (押す的が入れ子になる)。中身の行と同じだけ下げて、その番組の
        ものだと分かるようにする
    -->
    <!-- ルールの元は**いちばん新しい録画** (録り逃しだけの番組には出さない) -->
    {@const source = open ? newestRec(group) : null}
    {#if source !== null}
        <div class="group-tools">
            <a class="button small secondary outline" href={ruleFrom('recording', source)} data-testid="group-rule">ルールを作る</a>
        </div>
    {/if}
{/snippet}

<!--
    広い画面では2つの一覧を横に並べ、画面の残りを丁度使い切る (全部 CSS で決める)。
    畳まれる幅 (md 未満) では素直にページごとスクロールさせる。
    **横に並べはじめる幅は全画面で `md` (768px)** ([+layout.svelte](./+layout.svelte) の `FILLED`)
-->
<!-- 見本 1: 予約と録画を1本の時間軸に。上がこれから、「いま」の線、下が録れたもの -->
{#snippet chips(sheet: boolean)}
    {#each CHIPS as c (c.id)}
        <button
            type="button"
            class="t-chip"
            class:on={chip === c.id}
            class:alert={c.id === 'failed' && counts.failed > 0}
            aria-pressed={chip === c.id}
            onclick={() => {
                chip = c.id;
                if (sheet) sheetOpen = false;
            }}
        >
            {c.label}<span class="t-count num">{counts[c.id]}</span>
        </button>
    {/each}
{/snippet}

{#snippet tRes(item: TItem & { kind: 'res' | 'now' })}
    {@const res = item.res}
    <div
        data-testid="reservation-row"
        data-reservation-id={res.id}
        data-program-id={res.program_id}
        class="row t-row"
        class:t-live={item.kind === 'now'}
        class:t-focus={focused?.key === item.key}
        onmouseenter={() => pickFocus(item)}
        onfocusin={() => pickFocus(item)}
        role="presentation"
    >
        <span class="t-time num">{time(res.start_at)}<span class="t-end">{time(res.end_at)}</span></span>
        <div class="row-body" data-testid="row-body">
            {@render title(
                stateLabel(res.state),
                badgeClass(res.state),
                res.name,
                'reservation-state',
                () => openReservation(res),
                false,
                quietState(res.state),
            )}
            {@render meta(
                res.service_name,
                [duration(res.start_at, res.end_at), res.manual ? '手動予約' : (res.rule_name ?? '')],
                res,
            )}
            {#if res.conflict_reason}
                <div class="row-sub text-error small">{res.conflict_reason}</div>
            {/if}
        </div>
        <div class="row-actions">
            {#if res.recording_id !== null}
                <a class="button" href={resolve(`chase/${res.recording_id}`)}>追っかけ</a>
            {/if}
            {#if cancelable(res)}
                <ActionButton action="?/cancel" fields={{ id: res.id }} class="outline danger" testid="cancel-button">
                    <Icon icon={X} size="size-4" />取消
                </ActionButton>
            {/if}
        </div>
    </div>
{/snippet}

{#snippet tRec(item: TItem & { kind: 'past' })}
    {@const row = item.row}
    {#if row.kind === 'missed'}
        {@const res = row.res}
        <div
            class="row t-row"
            data-program-id={res.program_id}
            class:t-focus={focused?.key === item.key}
            onmouseenter={() => pickFocus(item)}
            role="presentation"
        >
            <span class="t-time num">{time(res.start_at)}</span>
            <span class="t-thumb"></span>
            <div class="row-body" data-testid="row-body">
                {@render title(stateLabel('missed'), badgeClass('missed'), res.name, 'missed-state', () => openMissed(res))}
                {@render meta(res.service_name, [duration(res.start_at, res.end_at)], res)}
            </div>
            <div class="row-actions">
                <ArmedDelete {deleting} armKey={-res.id} action="?/deleteMissed" fields={{ id: res.id }} testid="delete-button" confirmTestid="delete-confirm" icon />
            </div>
        </div>
    {:else}
        {@const rec = row.rec}
        {@const link = watchLink(rec)}
        {@const shown = rowState(rec)}
        <div
            data-testid="recording-row"
            data-recording-id={rec.id}
            data-program-id={rec.program_id}
            class="row t-row playable"
            class:t-focus={focused?.key === item.key}
            onmouseenter={() => pickFocus(item)}
            onfocusin={() => pickFocus(item)}
            role="presentation"
        >
            <span class="t-time num">{time(rec.start_at)}</span>
            <span class="t-thumb">
                {#if rec.library_path !== null}{@render posterImg(rec.id)}{/if}
                {#if link !== null}<span class="t-play" aria-hidden="true"><Play class="poster-icon" /></span>{/if}
            </span>
            <div class="row-body" data-testid="row-body">
                {@render title(
                    shown.label,
                    shown.badge,
                    rec.name,
                    'recording-state',
                    link ?? (() => openRecording(rec)),
                    unwatched(rec),
                    shown.quiet,
                )}
                {@render meta(rec.service_name, [recordedDuration(rec), size(rec.ts_size)], rec)}
            </div>
            {#if link !== null && rec.progress !== null}
                {@const frac = rec.progress.length > 0 ? Math.min(1, rec.progress.at / rec.progress.length) : 0}
                <span class="t-resume muted tiny num" title="続きから">
                    <span class="t-resume-track"><span style="width: {frac * 100}%"></span></span>
                    残り{durationMs(Math.max(0, rec.progress.length - rec.progress.at))}
                </span>
            {/if}
            <div class="row-actions">
                {#if link !== null}
                    <button type="button" class="secondary outline" onclick={() => openRecording(rec)} data-testid="detail-button" aria-label="詳細">
                        <Icon icon={Info} size="size-4" />
                    </button>
                {/if}
                {#if rec.deleted_at === null && rec.job_id === null}
                    <ArmedDelete {deleting} armKey={rec.id} fields={{ id: rec.id }} testid="delete-button" confirmTestid="delete-confirm" icon />
                {/if}
            </div>
        </div>
    {/if}
{/snippet}

{#snippet sideTools()}
    <input type="search" class="s-search" placeholder="番組名・局で探す" aria-label="予約と録画を探す" bind:value={query} />
    <p class="s-group">絞り込み</p>
    <nav class="s-list" aria-label="絞り込み">
        {#each CHIPS as c (c.id)}
            <button
                type="button"
                class="s-item"
                class:on={chip === c.id}
                aria-pressed={chip === c.id}
                onclick={() => (chip = c.id)}
            >
                <span>{c.label}</span>
                <span class="s-sub num" class:s-alert={c.id === 'failed' && counts.failed > 0}>{counts[c.id]}</span>
            </button>
        {/each}
    </nav>
    <button type="button" class="s-group s-group-toggle" aria-expanded={viewOpen} onclick={() => (viewOpen = !viewOpen)}>
        表示の切り替え
        <span class="t-view-chevron" class:open={viewOpen}><Icon icon={ChevronDown} size="size-4" /></span>
    </button>
    {#if viewOpen}
        <div class="s-list">
            <button type="button" class="s-item" aria-pressed={grouped} onclick={() => setGrouped(!grouped)}>
                <span>まとめて表示</span><span class="s-sub">{#if grouped}<Icon icon={Check} size="size-4" />{/if}</span>
            </button>
            <a class="s-item" href={finishedHref}>
                <span>完了した予約も表示</span><span class="s-sub">{#if data.showFinished}<Icon icon={Check} size="size-4" />{/if}</span>
            </a>
            <a class="s-item" href={deletedHref}>
                <span>削除済みも表示</span><span class="s-sub">{#if data.showDeleted}<Icon icon={Check} size="size-4" />{/if}</span>
            </a>
            <form method="POST" action="?/reconcile" use:submitting class="menu-form">
                <button type="submit" class="s-item"><span>ファイルと照合</span></button>
            </form>
        </div>
    {/if}
{/snippet}

{#snippet pane(item: TItem | null)}
    <p class="s-group">今日</p>
    <div class="s-list s-stats">
        <div class="s-item s-static">
            <span>次の録画</span>
            <span class="s-sub num">{#if nextRes !== null}{time(nextRes.start_at)}・{relative(nextRes.start_at)}{:else}なし{/if}</span>
        </div>
        <div class="s-item s-static"><span>録画中</span><span class="s-sub num">{counts.now} 本</span></div>
        <div class="s-item s-static"><span>未視聴</span><span class="s-sub num">{counts.unwatched} 本</span></div>
        <div class="s-item s-static">
            <span>空き</span>
            <span class="s-sub num">{data.capacity?.free.replace('空き ', '') ?? '—'}{#if data.capacity?.hours}・{data.capacity.hours}{/if}</span>
        </div>
    </div>
    {#if item !== null}
        {@const rec = item.kind === 'past' && item.row.kind === 'rec' ? item.row.rec : null}
        {@const res = item.kind === 'past' ? (item.row.kind === 'missed' ? item.row.res : null) : item.res}
        {@const base = rec ?? res!}
        <p class="s-group">
            {#if item.kind === 'now'}いま録画中{:else if item.kind === 'res'}{relative(base.start_at)}に録画{:else}録画済み{/if}
        </p>
        <div class="t-detail">
            {#if rec !== null && rec.library_path !== null}
                <a class="t-hero" href={watchLink(rec) ?? undefined}>
                    {@render posterImg(rec.id)}
                    <span class="t-hero-play"><Play /></span>
                </a>
            {/if}
            <h2 class="t-detail-title broadcast">{base.name}</h2>
            {@render meta(base.service_name, [airing(base)], base)}
            {#if rec !== null && rec.progress !== null}
                <p class="small muted">続きから (残り{durationMs(Math.max(0, rec.progress.length - rec.progress.at))})</p>
            {/if}
            {#if base.description}<p class="t-desc small broadcast">{base.description}</p>{/if}
            <div class="t-detail-actions">
                {#if rec !== null}
                    {@const link = watchLink(rec)}
                    {#if link !== null}
                        <a class="button" href={link}><Play class="size-4" /> 再生</a>
                    {/if}
                    <button type="button" class="secondary outline" onclick={() => openRecording(rec)}>詳細</button>
                {:else if item.kind !== 'past'}
                    {#if item.res.recording_id !== null}
                        <a class="button" href={resolve(`chase/${item.res.recording_id}`)}>追っかけ</a>
                    {/if}
                    <button type="button" class="secondary outline" onclick={() => openReservation(item.res)}>詳細</button>
                    {#if cancelable(item.res)}
                        <ActionButton action="?/cancel" fields={{ id: item.res.id }} class="outline danger">予約取消</ActionButton>
                    {/if}
                {:else if res !== null}
                    <button type="button" class="secondary outline" onclick={() => openMissed(res)}>詳細</button>
                {/if}
            </div>
        </div>
    {/if}
{/snippet}

<div class="board t-board">
    <Toasts {notices} source={form} ondismiss={dropNote} />

    <div class="t-toolbar">
        <input type="search" class="t-search" placeholder="番組名・局で探す" aria-label="予約と録画を探す" bind:value={query} />
        <div class="t-chips wide">{@render chips(false)}</div>
        <button
            type="button"
            class="t-filter-btn narrow secondary outline"
            aria-label="絞り込み"
            onclick={() => (sheetOpen = true)}
        >
            <Icon icon={ListFilter} size="size-5" />
            {#if chip !== 'all'}<span class="view-dot" aria-hidden="true"></span>{/if}
        </button>
        <Menu align="end" class="view-menu" testid="t-more-menu">
            {#snippet trigger(props)}
                <button {...props} type="button" class="secondary outline small t-more" aria-label="その他の操作">
                    <Icon icon={Ellipsis} size="size-4.5" />
                </button>
            {/snippet}
            <button type="button" role="menuitemcheckbox" class="menu-item" aria-checked={grouped} onclick={() => setGrouped(!grouped)}>
                <span class="menu-check" aria-hidden="true">{#if grouped}<Icon icon={Check} size="size-4" />{/if}</span>
                まとめて表示
            </button>
            <a role="menuitemcheckbox" class="menu-item" aria-checked={data.showFinished} href={finishedHref}>
                <span class="menu-check" aria-hidden="true">{#if data.showFinished}<Icon icon={Check} size="size-4" />{/if}</span>
                完了した予約も表示
            </a>
            <a role="menuitemcheckbox" class="menu-item" aria-checked={data.showDeleted} href={deletedHref}>
                <span class="menu-check" aria-hidden="true">{#if data.showDeleted}<Icon icon={Check} size="size-4" />{/if}</span>
                削除済みも表示
            </a>
            {@render menuSubmit('?/reconcile', 'ファイルと照合', 'reconcile-button', {}, () => {})}
        </Menu>
    </div>

    <div class="t-main">
        <div class="t-list" bind:this={listBox} data-testid="timeline">
            {#each lines as line (line.key)}
                {#if line.kind === 'day'}
                    <div class="t-day"><span>{line.label}</span>{#if line.sub}<span class="muted num">{line.sub}</span>{/if}</div>
                {:else if line.kind === 'now-line'}
                    <div class="t-now" bind:this={nowLine}>
                        <span class="t-now-label num">いま {time(nowAt)}</span>
                    </div>
                {:else if line.item.kind === 'past'}
                    {@render tRec(line.item)}
                {:else}
                    {@render tRes(line.item)}
                {/if}
            {/each}
            {#if counts.now === 0 && (chip === 'all' || chip === 'now')}
                <!-- 録画中が無くても線は残す -->
            {/if}
        </div>
        <aside class="t-pane" aria-label="選んだ番組">
            {@render sideTools()}
            {@render pane(focused)}
        </aside>
    </div>

    {#if sheetOpen}
        <div class="t-scrim" role="presentation" onclick={() => (sheetOpen = false)}></div>
        <div class="t-sheet" role="dialog" aria-label="絞り込み">
            <div class="t-sheet-grip"></div>
            <p class="t-sheet-title">絞り込み</p>
            <div class="t-sheet-chips">{@render chips(true)}</div>
            <hr />
            <a class="t-sheet-link" href={finishedHref}>完了した予約も表示</a>
            <a class="t-sheet-link" href={deletedHref}>削除済みも表示</a>
        </div>
    {/if}
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
        /*
         * **下から積む。** 枠は初めから一番下を映し、JS を待たない。中身は `.rows` の
         * 1つだけなので、並びは逆にならない。行が足りなければ `.rows` が伸びて
         * (`flex: 1 0 auto`) 上から並ぶ。間に行を足しても下からの位置は変わらない —
         * Chromium・Firefox の scroll anchoring は切る (`overflow-anchor`)。間が画面の中に
         * あるとき、上の行を留めて下 (見ていた古い録画) を押し下げてしまう。
         * 狭い画面はページごと縦に積むので、ここ (広い画面) だけ
         */
        .board-box.from-end {
            flex-direction: column-reverse;
            overflow-anchor: none;
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
    /* 絞り込みの欄。予約側と録画側で同じ形 (録画側だけ送れる form の中にある) */
    .filter {
        width: 9rem;
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
     * 縦の flex なのは、空の案内 (`.empty`) を枠の真ん中に置くため
     */
    .board-box {
        display: flex;
        flex-direction: column;
        overflow: auto;
        border-radius: var(--dp-radius-lg);
        background: var(--dp-surface);
        border: 1px solid var(--dp-line);
    }
    .rows > :global(* + *) {
        border-top: 1px solid var(--dp-line);
    }
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
    /*
     * 見出しの「表示」と「⋯」。どちらも小さな枠のボタンで、字とアイコンを横に並べる。
     * 「表示」に何か入っていれば主の色の点を付ける (ふつうと違う見え方をしている)
     */
    .cluster :global(:is(.tools-trigger, .view-trigger)) {
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }
    /*
     * 畳むかどうかは**画面の幅ではなく録画の列の幅**で決める。二段組に入ったばかりの
     * 幅 (縦の iPad など) でも列は 440px ほどしかなく、並べると同じように折り返す
     */
    .recordings {
        container: recordings / inline-size;
    }
    .cluster :global(.view-trigger) {
        gap: 0.3rem;
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
    @container recordings (min-width: 36rem) {
        .menu-note {
            display: none;
        }
    }
    @container recordings (max-width: 35.99rem) {
        .capacity {
            display: none;
        }
    }
    /*
     * **空きを足しても見出しを1行に保つ。** 列が狭くなるにつれて絞り込みの欄を狭め、さらに狭ければ時間を落とす。
     * 36rem より狭い列では空きごと「⋯」の頭へ回す (上)
     */
    /* 狭い列 (36rem 未満) の欄は画面の幅で決まる (上の `.filter`)。ここで触るのは並べている間だけ */
    @container recordings (min-width: 36rem) and (max-width: 49.99rem) {
        .filter {
            width: 10rem;
        }
    }
    @container recordings (max-width: 41.99rem) {
        .capacity-hours {
            display: none;
        }
    }
    /* 見出しと空き。空きは見出しの字の並びに揃えて、小さく添える */
    .head-title {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        min-width: 0;
    }
    .capacity {
        white-space: nowrap;
    }
    /* 「⋯」の頭の空き。押せるものではないので、項目と同じ余白で字だけ置く */
    .menu-note {
        padding: 0.4rem 0.6rem;
        border-bottom: 1px solid var(--dp-line);
        white-space: nowrap;
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
    /* 行どうしの区切り線 (`.rows > * + *`) は、上で枠を外したぶん引き直す */
    .rows > .group-head:not(:first-child) {
        border-top: 1px solid var(--dp-line);
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
    .rows > .group-tools {
        padding: 0 0.75rem 0.5rem 2.25rem;
        /* 見出しとの間には線を引かない (見出しの続き) */
        border-top: 0;
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
    /* ポスターと再生の印。行に指を乗せると印が浮かぶ */
    .poster {
        position: relative;
        margin-top: 0.125rem;
        aspect-ratio: 16 / 9;
        width: 4rem;
        flex-shrink: 0;
        overflow: hidden;
        border-radius: 0.25rem;
        background: var(--dp-line);
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
        transition: background-color var(--dp-duration);
    }
    .poster-play :global(.poster-icon) {
        width: 1.5rem;
        height: 1.5rem;
        opacity: 0;
        filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.5));
        transition: opacity var(--dp-duration);
    }
    .playable:hover .poster-play {
        background: rgb(0 0 0 / 0.4);
    }
    .playable:hover :global(.poster-icon) {
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

    /* ===== 見本 1: 1本の時間軸 ===== */
    .t-board {
        display: flex;
        flex-direction: column;
    }
    .t-toolbar {
        position: sticky;
        top: var(--t-top, 0px);
        z-index: 5;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0;
        background: var(--dp-bg);
        border-bottom: 1px solid var(--dp-line, var(--dp-base-300));
    }
    .t-search {
        flex: 1 1 auto;
        min-width: 0;
        max-width: 18rem;
        height: 2.25rem;
        margin: 0;
        padding-block: 0.3rem;
        font-size: 0.875rem;
    }
    .t-chips {
        display: flex;
        flex-wrap: nowrap;
        gap: 0.375rem;
        min-width: 0;
        overflow-x: auto;
        scrollbar-width: none;
    }
    .t-chip {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        width: auto;
        margin: 0;
        padding: 0.3rem 0.75rem;
        border: 1px solid var(--dp-base-300);
        border-radius: 999px;
        background: transparent;
        color: inherit;
        font-size: 0.8125rem;
        font-weight: 500;
        white-space: nowrap;
        box-shadow: none;
    }
    .t-chip:hover {
        background: var(--dp-hover);
    }
    .t-chip.on {
        border-color: transparent;
        background: var(--pico-primary-background);
        color: var(--pico-primary-inverse);
    }
    .t-count {
        font-size: 0.75rem;
        opacity: 0.7;
    }
    .t-chip.alert:not(.on) .t-count {
        color: var(--dp-rec-text);
        opacity: 1;
        font-weight: 700;
    }
    .t-more {
        margin-left: auto;
    }
    .t-filter-btn {
        position: relative;
        display: none;
        width: 2.5rem;
        height: 2.5rem;
        padding: 0;
        align-items: center;
        justify-content: center;
    }
    .t-filter-btn .view-dot {
        position: absolute;
        top: 0.35rem;
        right: 0.35rem;
    }
    .t-main {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        min-height: 0;
        flex: 1;
    }
    .t-pane {
        display: none;
    }
    .t-list {
        position: relative;
        min-width: 0;
    }
    .t-day {
        position: sticky;
        top: calc(var(--t-top, 0px) + 3.3rem);
        z-index: 3;
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        padding: 0.6rem 0.25rem 0.3rem;
        background: var(--dp-bg);
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        border-bottom: 1px solid var(--dp-base-300);
    }
    .t-day .muted {
        font-weight: 400;
    }
    .t-now {
        position: relative;
        display: flex;
        align-items: center;
        height: 1.75rem;
        margin: 0.5rem 0 0.25rem;
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
        border-radius: 999px;
        background: var(--dp-rec);
        color: #fff;
        font-size: 0.75rem;
        font-weight: 700;
    }
    .t-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.25rem 0.25rem;
        border-bottom: 1px solid var(--dp-base-300);
        border-radius: 0;
    }
    .t-row:hover,
    .t-row.t-focus {
        background: var(--dp-hover);
    }
    .t-row.t-live {
        background: color-mix(in srgb, var(--dp-rec) 10%, transparent);
    }
    .t-row .row-body {
        flex: 1 1 auto;
    }
    .t-row .row-meta {
        margin-top: 0;
        font-size: 0.78rem;
    }
    .t-row :global(.row-actions) {
        flex-shrink: 0;
    }
    .t-time {
        display: flex;
        flex-direction: column;
        width: 3.1rem;
        white-space: nowrap;
        flex-shrink: 0;
        font-size: 0.875rem;
        font-weight: 600;
        line-height: 1.15;
    }
    .t-end {
        font-size: 0.7rem;
        font-weight: 400;
        color: var(--dp-muted);
    }
    .t-thumb {
        position: relative;
        width: 4rem;
        aspect-ratio: 16 / 9;
        flex-shrink: 0;
        overflow: hidden;
        border-radius: 0.25rem;
        background: var(--dp-base-300);
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
        transition: opacity 0.15s;
    }
    .t-play :global(svg) {
        width: 1.25rem;
        height: 1.25rem;
    }
    .playable:hover .t-play {
        opacity: 1;
    }
    .t-resume {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        flex-shrink: 0;
    }
    .t-resume-track {
        display: block;
        width: 3rem;
        height: 0.25rem;
        overflow: hidden;
        border-radius: 999px;
        background: var(--dp-base-300);
    }
    .t-resume-track > span {
        display: block;
        height: 100%;
        background: var(--pico-primary-background);
    }
    /* 行の操作は指を乗せたときだけはっきり (広い画面) */
    @media (hover: hover) and (min-width: 768px) {
        .t-row :global(.row-actions) {
            opacity: 0.35;
            transition: opacity 0.15s;
        }
        .t-row:hover :global(.row-actions),
        .t-row:focus-within :global(.row-actions) {
            opacity: 1;
        }
    }
    @media (min-width: 768px) {
        .t-board {
            height: 100%;
        }
        .t-toolbar {
            position: static;
        }
        .t-main {
            overflow: hidden;
        }
        .t-list {
            overflow: auto;
            overflow-anchor: none;
        }
        .t-day {
            top: 0;
        }
    }
    /* 広い画面: 右に選んだ行の中身と、今日のまとめ */
    @media (min-width: 1000px) {
        .t-toolbar {
            display: none;
        }
        .t-main {
            grid-template-columns: minmax(0, 1fr) 18rem;
            gap: 0;
        }
        .t-pane {
            display: flex;
            flex-direction: column;
            gap: 0.875rem;
            min-height: 0;
            overflow: auto;
            padding: 0 0 0.75rem 1.25rem;
            margin-left: 1.25rem;
            border-left: 1px solid var(--dp-base-300);
        }
    }
    .t-stats {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0.75rem;
        padding-bottom: 0.875rem;
        border-bottom: 1px solid var(--dp-base-300);
    }
    .t-stat.t-next {
        grid-column: 1 / -1;
    }
    .t-stat {
        display: flex;
        flex-direction: column;
        min-width: 0;
    }
    .t-stat-label {
        font-size: 0.7rem;
        color: var(--dp-muted);
    }
    .t-stat-value {
        font-size: 1.125rem;
        font-weight: 700;
        line-height: 1.3;
        white-space: nowrap;
    }
    .t-stat-value small {
        margin-left: 0.2rem;
        font-size: 0.7rem;
        font-weight: 400;
        color: var(--dp-muted);
    }
    .t-stat-sub {
        overflow: hidden;
        font-size: 0.7rem;
        color: var(--dp-muted);
        white-space: nowrap;
        text-overflow: ellipsis;
    }
    .t-detail {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }
    .t-detail-kicker {
        margin: 0;
    }
    .t-hero {
        position: relative;
        display: block;
        aspect-ratio: 16 / 9;
        overflow: hidden;
        border-radius: 0.5rem;
        background: var(--dp-base-300);
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
        border-radius: 999px;
        background: rgb(0 0 0 / 0.55);
        color: #fff;
    }
    .t-detail-title {
        margin: 0.25rem 0 0;
        font-size: 1.125rem;
        line-height: 1.4;
    }
    .t-desc {
        display: -webkit-box;
        margin: 0;
        overflow: hidden;
        -webkit-line-clamp: 6;
        -webkit-box-orient: vertical;
        color: var(--dp-muted);
        line-height: 1.6;
    }
    .t-detail-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-top: 0.25rem;
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
    /* 狭い画面: 探す欄と絞り込みのボタンだけ。絞り込みは下から出る */
    @media (max-width: 767px) {
        .t-chips.wide,
        .t-more {
            display: none;
        }
        .t-filter-btn.narrow {
            display: inline-flex;
        }
        .t-search {
            max-width: none;
        }
        .t-row {
            gap: 0.5rem;
        }
        .t-thumb {
            width: 3.25rem;
        }
        .t-time {
            width: 2.9rem;
            font-size: 0.8125rem;
        }
        .t-resume {
            display: none;
        }
        .t-row :global(.row-actions button:not(.danger):not([data-testid='delete-confirm'])) {
            display: none;
        }
    }
    .t-scrim {
        position: fixed;
        inset: 0;
        z-index: 50;
        background: rgb(0 0 0 / 0.45);
    }
    .t-sheet {
        position: fixed;
        inset-inline: 0;
        bottom: 0;
        z-index: 51;
        padding: 0.5rem 1rem calc(1rem + env(safe-area-inset-bottom));
        border-radius: 1rem 1rem 0 0;
        background: var(--dp-surface);
    }
    .t-sheet-grip {
        width: 2.5rem;
        height: 0.25rem;
        margin: 0 auto 0.75rem;
        border-radius: 999px;
        background: var(--dp-base-300);
    }
    .t-sheet-title {
        margin: 0 0 0.75rem;
        font-weight: 700;
    }
    .t-sheet-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
    }
    .t-sheet-chips .t-chip {
        padding: 0.5rem 1rem;
        font-size: 0.9rem;
    }
    .t-sheet hr {
        margin: 1rem 0 0.5rem;
    }
    .t-sheet-link {
        display: block;
        padding: 0.625rem 0;
        color: inherit;
        text-decoration: none;
    }
    /* 広い画面は1行に詰める (時刻・サムネ・番組名・局と尺・操作) */
    @media (min-width: 768px) {
        .t-row {
            padding-block: 0.0625rem;
        }
        .t-row .row-body {
            display: flex;
            align-items: center;
            gap: 1rem;
        }
        .t-row .row-body > :global(.title-line) {
            flex: 1 1 auto;
            min-width: 0;
        }
        .t-row .row-body > :global(.row-meta) {
            flex: 0 0 15rem;
        }
        .t-row .row-body > :global(.row-sub) {
            display: none;
        }
        .t-time {
            flex-direction: row;
            gap: 0.25rem;
            align-items: baseline;
            width: 6.25rem;
        }
        .t-end::before {
            content: '–';
            margin-right: 0.25rem;
        }
        .t-thumb {
            width: 3.5rem;
        }
    }
    .t-upcoming {
        display: flex;
        flex-direction: column;
        border-top: 1px solid var(--dp-base-300);
        padding-top: 0.75rem;
    }
    .t-upcoming h3 {
        margin: 0 0 0.375rem;
        font-size: 0.75rem;
        color: var(--dp-muted);
    }
    .t-up {
        display: flex;
        gap: 0.625rem;
        width: 100%;
        margin: 0;
        padding: 0.3rem 0.25rem;
        border: 0;
        border-radius: 0.25rem;
        background: transparent;
        color: inherit;
        font-size: 0.8125rem;
        text-align: left;
        box-shadow: none;
    }
    .t-up:hover {
        background: var(--dp-hover);
    }
    .t-up .num {
        flex-shrink: 0;
        color: var(--dp-muted);
    }
    .t-up span:last-child {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }
    /* タブレット向け: 右の列の頭に検索・絞り込み・表示の切り替え。行は指で押せる高さ */
    @media (min-width: 768px) {
        .t-row {
            min-height: 3rem;
        }
    }
    @media (min-width: 1280px) {
        .t-main {
            grid-template-columns: minmax(0, 1fr) 21rem;
        }
    }
    /* タブレットの横 (右の列あり) は、番組名の下に局と尺を置く 2 段 (高さは 48px のまま) */
    @media (min-width: 1000px) and (max-width: 1279px) {
        .t-row .row-body {
            display: block;
        }
        .t-row .row-meta {
            line-height: 1.3;
        }
        .t-resume {
            display: none;
        }
        .t-time {
            width: 3.25rem;
        }
        .t-end {
            display: none;
        }
    }
    .t-side {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding-bottom: 0.75rem;
        border-bottom: 1px solid var(--dp-base-300);
    }
    .t-side-search {
        height: 2.75rem;
        margin: 0 0 0.375rem;
        font-size: 0.9rem;
    }
    .t-labels {
        display: flex;
        flex-direction: column;
    }
    .t-label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        min-height: 2.75rem;
        margin: 0;
        padding: 0 0.75rem;
        border: 0;
        border-radius: 0.5rem;
        background: transparent;
        color: inherit;
        font-size: 0.9rem;
        font-weight: 500;
        text-align: left;
        box-shadow: none;
    }
    .t-label:hover {
        background: var(--dp-hover);
    }
    .t-label.on {
        background: color-mix(in srgb, var(--pico-primary-background) 18%, transparent);
        color: var(--pico-h1-color, inherit);
        font-weight: 700;
    }
    .t-label-count {
        font-size: 0.8125rem;
        color: var(--dp-muted);
    }
    .t-label.alert .t-label-count {
        color: var(--dp-rec-text);
        font-weight: 700;
    }
    .t-view-toggle {
        color: var(--dp-muted);
        font-size: 0.8125rem;
    }
    .t-view-chevron {
        display: inline-flex;
        transition: transform 0.15s;
    }
    .t-view-chevron.open {
        transform: rotate(180deg);
    }
    .t-view-list {
        display: flex;
        flex-direction: column;
    }
    .t-opt {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        min-height: 2.75rem;
        margin: 0;
        padding: 0 0.75rem;
        border: 0;
        border-radius: 0.5rem;
        background: transparent;
        color: inherit;
        font-size: 0.875rem;
        text-align: left;
        text-decoration: none;
        box-shadow: none;
    }
    .t-opt:hover {
        background: var(--dp-hover);
    }
    .t-pane .t-stats {
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .t-pane .t-hero {
        max-height: 9rem;
    }
    /* ===== 見本 1 (方針の更新): 枠なし・線なしの行、右は端まで寄せたサイドバー ===== */
    .t-row {
        border-bottom: 0;
        border-radius: var(--dp-radius);
        padding-inline: 0.5rem;
        margin-bottom: 1px;
        transition: background-color var(--dp-duration);
    }
    .t-row:hover {
        background: color-mix(in srgb, var(--dp-subtle) 55%, transparent);
    }
    .t-row.t-focus {
        background: var(--dp-subtle);
    }
    .t-row.t-live {
        background: color-mix(in srgb, var(--dp-rec) 12%, transparent);
    }
    .t-day {
        padding: 0.875rem 0.5rem 0.25rem;
        border-bottom: 0;
        color: var(--dp-muted);
        font-size: 0.75rem;
        font-weight: 600;
        letter-spacing: 0;
    }
    .t-day > span:first-child {
        color: var(--pico-color);
    }
    .t-toolbar {
        border-bottom: 0;
    }
    @media (min-width: 1000px) {
        .t-board {
            height: calc(100% + 2 * var(--dp-gutter));
            margin: calc(-1 * var(--dp-gutter));
        }
        .t-main {
            grid-template-columns: minmax(0, 1fr) 18rem;
        }
        .t-list {
            padding: 0.25rem calc(var(--dp-gutter) - 0.5rem) 1rem;
        }
        .t-pane {
            gap: 0;
            margin-left: 0;
            padding: 1rem 0.625rem 1.5rem;
            border-left: 1px solid var(--dp-line);
        }
    }
    @media (min-width: 1280px) {
        .t-main {
            grid-template-columns: minmax(0, 1fr) 20rem;
        }
    }
    .s-search {
        height: 2.5rem;
        margin: 0 0 0.25rem;
        font-size: 0.875rem;
    }
    .s-group {
        margin: 1rem 0 0.25rem;
        padding: 0 0.75rem;
        color: var(--dp-muted);
        font-size: 0.75rem;
        font-weight: 500;
    }
    .s-group-toggle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        min-height: 2rem;
        border: 0;
        border-radius: var(--dp-radius);
        background: transparent;
        box-shadow: none;
        text-align: left;
    }
    .s-group-toggle:hover {
        background: color-mix(in srgb, var(--dp-subtle) 55%, transparent);
    }
    .s-list {
        display: flex;
        flex-direction: column;
        gap: 1px;
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
        color: inherit;
        font-size: 0.875rem;
        font-weight: 400;
        text-align: left;
        text-decoration: none;
        box-shadow: none;
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
    .s-sub {
        display: inline-flex;
        align-items: center;
        color: var(--dp-muted);
        font-size: 0.8125rem;
        font-weight: 400;
        white-space: nowrap;
    }
    .s-sub.s-alert {
        color: var(--dp-rec-text);
        font-weight: 700;
    }
    .t-pane .t-detail {
        padding: 0 0.75rem;
    }
</style>
