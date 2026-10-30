<script lang="ts" module>
  import { SvelteSet } from "svelte/reactivity";

  /**
   * 「まとめて表示」で開いている番組 (まとめる鍵)。**その場かぎり覚える** —
   * モジュールに置くので、観る画面へ行って戻っても開いたまま。読み込み直すと閉じる
   */
  const openedGroups = new SvelteSet<string>();
</script>

<script lang="ts">
  import { tick, untrack } from "svelte";

  import { submitting } from "#lib/actions.js";
  import { arming } from "#lib/arming.svelte.js";
  import {
    type HomeControls,
    type Item,
    type Missed,
    type Rec,
    type Res,
    setHome,
  } from "#lib/components/home/context.js";
  import Menu from "#lib/components/Menu.svelte";
  import ProgramDetail from "#lib/components/ProgramDetail.svelte";
  import Toasts, {
    errorNotice,
    type Notice,
  } from "#lib/components/Toasts.svelte";
  import "#lib/components/home/home.css";
  import { resolve } from "$app/paths";

  import { markDays } from "#lib/calendar.js";
  import HomeAside from "#lib/components/home/HomeAside.svelte";
  import {
    alignTop,
    holdPlace,
    placeTimeline,
    restoreRow,
    showDay,
    topDay,
    topRow,
  } from "#lib/components/home/placement.js";
  import TimelineBar from "#lib/components/home/TimelineBar.svelte";
  import TimelineEntry from "#lib/components/home/TimelineEntry.svelte";
  import { type DetailSeed, programDetail } from "#lib/detail.svelte.js";
  import { applyEncodeProgress } from "#lib/encode-live.svelte.js";
  import {
    cmNoteWorthShowing,
    date,
    logoUnusable,
    nowStatus,
  } from "#lib/format.js";
  import { GROUPED_COOKIE } from "#lib/grouping.js";
  import { liveUpdates } from "#lib/live-updates.svelte.js";
  import {
    clearFailed,
    offline,
    removeLocal,
    saveOffline,
  } from "#lib/offline.svelte.js";
  import { Paged, sentinel } from "#lib/paging.svelte.js";
  import { cmRedo, encodeSource } from "#lib/source.js";
  import {
    blocks,
    catchUp,
    countFilters,
    dayName,
    dayStart,
    type Filter,
    lineIndex,
    mergeRecorded,
    pageStart,
    passes,
    sections,
    timelineLines,
    type Traits,
    type Zone,
  } from "#lib/timeline.js";

  let { data, form } = $props();

  // 予約・録画のどちらが動いてもサーバが知らせてくる。
  // エンコードの進み具合だけは中身ごと届き、読み直さず行の数字を書き換える
  liveUpdates(["recordings", "reservations"], { encode: applyEncodeProgress });

  const active = ["scheduled", "conflict", "skipped", "recording"];
  /** 取り消せるか。録画しない (`skipped`) は放送が終われば履歴なので出さない */
  const cancelable = (res: { state: string; end_at: number }) =>
    active.includes(res.state) &&
    !(res.state === "skipped" && res.end_at <= Date.now());

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
      kind: "error",
      text: "端末への保存に失敗しました。もう一度試してください",
    };
    clearFailed();
  });

  /** 押した結果。出す場所と消え方は Toasts が持っている */
  const notices = $derived.by(() => {
    const list: Notice[] = [];
    if (offlineNote !== null) list.push(offlineNote);
    list.push(...errorNotice(form, "dashboard-error"));
    if (form?.reconcile) {
      /*
       * **両方向ぶん出す。** 「実体が無く削除済み」だけ出していた頃は、
       * 逆向き (行の無いファイル) を見ていないことが画面から分からなかった。
       * 動画そのものには触らないので、その数だけは出しておく
       */
      const { checked, removed, swept, strays, pruned } = form.reconcile;
      const parts = [
        `照合 ${checked} 件`,
        `ファイルが無いため削除済みにした ${removed} 件`,
      ];
      if (swept > 0) parts.push(`録画の無い付属ファイルを削除 ${swept} 件`);
      if (pruned > 0) parts.push(`空のフォルダを削除 ${pruned} 件`);
      if (strays > 0) parts.push(`DB に無い動画 ${strays} 件 (残してあります)`);
      list.push({
        key: "reconcile-result",
        kind: "info",
        text: parts.join(" / "),
      });
    }
    return list;
  });

  /**
   * 端末に保存する ([docs/offline.md](../../docs/offline.md))。落とすものは
   * `saveOffline` が決める (既定 AV1、端末がデコードできなければ H.264)。
   * Background Fetch ならタブを閉じても続くので、押したら詳細は閉じる
   */
  async function saveToDevice(rec: Rec): Promise<void> {
    try {
      await saveOffline(rec);
      offlineNote = {
        key: `offline-save-${rec.id}`,
        kind: "info",
        text: `端末への保存を始めました: ${rec.name}`,
      };
    } catch (error) {
      offlineNote = {
        key: `offline-save-${rec.id}`,
        kind: "error",
        text:
          error instanceof Error ? error.message : "端末に保存できませんでした",
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
  let detailRec = $state<Rec | null>(null);
  /**
   * 詳細を開いている予約。**録画・録り逃しから開いたときは null** (操作は reservationActions)。
   *
   * 行そのものではなく ID で持ち、いまの一覧から引き直す。通知で読み直すと
   * 状態が変わる (予約済み → 録画中) ので、覚えた行のままだと出す操作がずれる
   */
  let detailResId = $state<number | null>(null);
  const detailRes = $derived(
    detailResId === null
      ? null
      : (data.reservations.find((res) => res.id === detailResId) ?? null),
  );

  /**
   * 行を押したら番組詳細を出す。中身の出し方は `detail` が持っている。
   * ここで決めるのは、その行に添える注記 (失敗の理由・CMの判定) だけ。
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
  function openReservation(res: Res): void {
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
  function watchLink(rec: Rec): string | null {
    if (rec.deleted_at !== null || rec.state === "failed") return null;
    if (rec.library_path !== null) return resolve(`watch/${rec.id}`);
    /*
     * **エンコードが終わる前でも観られる。** 録り終えて CM検出やエンコードを待っている間 (失敗したときも) は
     * 観る画面がサーバに元の TS をその場で変換させて流す (`server/playback.ts`)。録っている最中だけ
     * 追っかけ再生の画面 (`/chase`。伸びている TS を追い読みする)
     */
    if (rec.ts_path !== null)
      return resolve(
        rec.finished_at !== null ? `watch/${rec.id}` : `chase/${rec.id}`,
      );
    return null;
  }

  /**
   * **まだ観ていない** (一覧の点)。観終えた時刻 (`watched_at`) が無く、続きの位置も無いもの。
   * 途中まで観たものは進捗バーのほうで分かるので点は付けない。観られないものにも付けない
   */
  function unwatched(rec: Rec): boolean {
    return (
      rec.watched_at === null &&
      rec.resume_ms === null &&
      watchLink(rec) !== null
    );
  }

  /** 録画・番組からルールを作る入口。検索の画面の「ルールとして保存」へ直接行く (`search/+page.server.ts` の `?from=`) */
  function ruleFrom(kind: "recording" | "program", id: number): string {
    return resolve(`search?${new URLSearchParams({ from: `${kind}:${id}` })}`);
  }

  /**
   * ファイルを持っているか。**端末に保存と「その他…」を出すかどうか。**
   * エンコードの失敗はここに出てこない — 落ちたのは再エンコードのほうで、元のTSは無事なので観られる
   */
  function hasFile(rec: Rec): boolean {
    if (rec.deleted_at !== null) return false;
    if ((rec.library_path ?? rec.ts_path) === null) return false;
    return rec.state !== "failed";
  }

  /**
   * 録画の詳細。
   *
   * 失敗の理由は**ここでしか出さない** (一覧の行の高さを揃えるため)。
   * 理由は3種類あって、それぞれ別物なので見出しを付けて分けて渡す
   */
  function openRecording(rec: Rec): void {
    const notes: { title: string; text: string }[] = [];
    // error 列に入るのは**録画そのものの失敗だけ**。エンコードの理由は encode_error
    if (rec.state === "failed" && rec.error) {
      notes.push({ title: "録画に失敗しました", text: rec.error });
    }
    if (rec.deleted_at !== null && rec.error) {
      notes.push({ title: "削除された理由", text: rec.error });
    }
    if (rec.encode_error) {
      notes.push({ title: "エンコードに失敗しました", text: rec.encode_error });
    }
    openDetail(rec.program_id, rec, notes, rec.cm_note);
    detailRec = rec;
  }

  /**
   * 録り逃しの詳細。**失敗した録画と同じ形**で、開いたときに理由を出す。
   * チューナー不足で落とされたものは予約が理由を持っている (conflict_reason)
   */
  function openMissed(res: Missed): void {
    const text =
      res.conflict_reason ??
      "アプリが止まっていたなどの理由で、録画を始められないまま放送が終わりました";
    openDetail(res.program_id, res, [{ title: "録り逃しました", text }]);
  }

  /*
   * ---- 1本の時間軸 (`#lib/timeline.ts`) ----
   *
   * 予約・録画・録り逃しを1つの一覧に並べる。上が録れたものと録画中、「いま」の線、
   * 下がこれからの予約 (下へ行くほど時間が進む)。行の形 (`Item`) は部品と分け合う (`#lib/components/home/context.ts`)
   */

  /**
   * 予約をどの側に置くか。録画中は線のすぐ上、放送が終わっていないものは線の下 (これからの予約)。
   * 「完了した予約も表示」で出る終わった予約 (完了・失敗・取り消し) は録れたものの側
   */
  function zoneOf(res: Res, now: number): Zone {
    if (res.state === "recording") return "now";
    return res.end_at > now ? "future" : "past";
  }

  /** 描いた時刻。「いま」の線と予約の側分けの物差し。読み直すたびに取り直す */
  const clock = $derived.by(() => {
    void data;
    return Date.now();
  });

  /** 終わった予約と、それで録れた録画を 1 本に (`mergeRecorded`)。録画の行が代わりに立つ */
  const merged = $derived(
    mergeRecorded(data.reservations, data.recordings, clock),
  );

  const items = $derived<Item[]>([
    ...merged.reservations.map((res): Item => ({
      kind: "res",
      key: `res-${res.id}`,
      at: res.start_at,
      zone: zoneOf(res, clock),
      group: res.group_key,
      groupName: res.group_name,
      res,
    })),
    ...data.recordings.map((rec): Item => ({
      kind: "rec",
      key: `rec-${rec.id}`,
      at: rec.start_at,
      zone: "past",
      group: rec.group_key,
      groupName: rec.group_name,
      // 予約にしか無かった副題は予約の名前で (`mergeRecorded` の `names`)
      rec: merged.names.has(rec.id)
        ? { ...rec, name: merged.names.get(rec.id) ?? rec.name }
        : rec,
    })),
    ...data.missed.map((res): Item => ({
      kind: "missed",
      key: `missed-${res.id}`,
      at: res.start_at,
      zone: "past",
      group: res.group_key,
      groupName: res.group_name,
      res,
    })),
  ]);

  /**
   * **観終えていない録画** (未視聴の点か、続きのバーが出ているもの)。「未視聴」の絞り込みと、
   * 開いたときに映す録画 (`catchUp`) に使う。観られないもの (消したものも) は入れない (`watchLink`)
   */
  function unfinished(item: Item): boolean {
    return (
      item.kind === "rec" &&
      item.rec.watched_at === null &&
      watchLink(item.rec) !== null
    );
  }

  function traitsOf(item: Item): Traits {
    return {
      unfinished: unfinished(item),
      failed:
        item.kind === "rec" &&
        (item.rec.state === "failed" || (item.rec.encode_error ?? "") !== ""),
      missed: item.kind === "missed",
      conflict: item.kind === "res" && item.res.state === "conflict",
      cmlogo:
        item.kind === "rec" &&
        item.rec.deleted_at === null &&
        logoUnusable(item.rec.cm_note),
    };
  }

  /** 絞り込みのボタン (`Filter`)。その場かぎり */
  let filter = $state<Filter>("all");
  /** 件数はボタンごとに数える (押す前に、押すと何件になるかが分かる) */
  const counts = $derived(countFilters(items, traitsOf));
  const shownItems = $derived(
    items.filter((item) => passes(filter, item, traitsOf(item))),
  );
  const parts = $derived(sections(shownItems));

  /** 「削除済みも表示」「完了した予約も表示」の行き先。入っていれば外した URL へ (ほかの指定は残す) */
  function toggleHref(name: "deleted" | "all", on: boolean): string {
    const params = new URLSearchParams();
    if (name === "all" ? !on : data.showFinished) params.set("all", "1");
    if (name === "deleted" ? !on : data.showDeleted) params.set("deleted", "1");
    const search = params.toString();
    return search === "" ? resolve("") : `${resolve("")}?${search}`;
  }
  const deletedHref = $derived(toggleHref("deleted", data.showDeleted));
  const finishedHref = $derived(toggleHref("all", data.showFinished));

  /**
   * **「まとめて表示」(issue #480)。** 端末ごとに cookie で覚え、**サーバが読む**
   * (`+page.server.ts`)。予約にも録画にも効き、同じ番組でも線の上と下で別の見出しになる
   */
  // svelte-ignore state_referenced_locally
  let grouped = $state(data.grouped);
  /** 開いた番組の鍵。側ごとに分けて覚える (`future:アニメ`) */
  const openKey = (zone: "future" | "past", group: string) =>
    `${zone}:${group}`;
  function isOpen(zone: "future" | "past", group: string): boolean {
    return openedGroups.has(openKey(zone, group));
  }
  function toggleGroup(zone: "future" | "past", group: string): void {
    const key = openKey(zone, group);
    if (openedGroups.has(key)) openedGroups.delete(key);
    else openedGroups.add(key);
  }
  function setGrouped(on: boolean): void {
    grouped = on;
    pastPage.reset();
    fillSoon();
    // パスは接頭辞込み (`live-player.svelte.ts` の `remember` と同じ)
    document.cookie = `${GROUPED_COOKIE}=${on ? "1" : "0"}; path=${resolve("")}; max-age=31536000; samesite=lax`;
  }

  const lines = $derived(timelineLines(parts, { now: clock, grouped, isOpen }));
  /** 開いた瞬間に作る行数 (線の上と下それぞれ)。1 画面に収まるくらい。残りは表示したあとで足す (`fillSoon`) */
  const FIRST_ROWS = 15;
  /** 映したい行の上に余分に作る行数 (見出しの貼り付きと、上に少し送ったときのため) */
  const FIRST_MARGIN = 4;
  /*
   * **線より上 (録れたもの) だけ少しずつ描く** (`#lib/paging.svelte.js`)。300 件を一度に描くと、
   * 開いた直後に一瞬止まって見えた。描くのは線の側 (新しいほう) から `pastPage.shown` 行で、
   * 古いほうは一覧の頭に近づいたら上へ足す。足しても読んでいる所は動かさない (`holdPlace`)。
   * 録画中と線より下 (予約) は全部描く
   */
  const pastPage = new Paged(() => lines.past, 60, FIRST_ROWS);
  /**
   * 線より下 (予約) を何行描くか。**開いた瞬間は頭の数行だけ** — 残りは表示したあとで足す (`fillSoon`)。
   * 予約が多いと、画面の外の行まで作るぶん開くのが一コマ重くなっていた
   */
  let futureShown = $state(FIRST_ROWS);
  const futureRows = $derived(
    lines.future.length <= futureShown
      ? lines.future
      : lines.future.slice(0, futureShown),
  );
  /** 描く頭の行。見出しの途中から描かないよう、見出しまで戻す (`pageStart`) */
  const pastStart = $derived(pageStart(lines.past, pastPage.shown));
  const pastRows = $derived(lines.past.slice(pastStart));
  /** 描く行を見出しごとに包む (`blocks`)。今日の包みは線と今日の予約まで抱える */
  const shownBlocks = $derived(
    blocks([...pastRows, ...lines.now, ...futureRows]),
  );
  /**
   * 線の側から数えて、その行まで描く (開いたとき・絞り込みを替えたときに映したい行)。**切り上げない** —
   * 映す行の上に何行か余分に作るだけで、残りは表示したあとで足す (`fillSoon`)
   */
  function showPastUpTo(key: string): void {
    const index = lineIndex(lines.past, key);
    if (index >= 0 && index < pastStart)
      pastPage.showAtLeast(lines.past.length - index + FIRST_MARGIN);
  }

  /**
   * 開いた瞬間に作らなかった行を足す。**表示した次のコマで** — 開くのを一コマで済ませ、画面の外の行は後から作る。
   * 上に足すぶん読んでいる所は動かさない (`holdPlace`)
   */
  let filling = 0;
  // 画面を離れたら取り消す。onDestroy はサーバで描くときにも呼ばれる (そこに cancelAnimationFrame は無い) ので、effect の後片付けで
  $effect(() => () => cancelAnimationFrame(filling));
  function fillSoon(): void {
    if (filling !== 0) return;
    filling = requestAnimationFrame(() => {
      filling = 0;
      if (listBox === undefined) return;
      const restore = holdPlace(listBox);
      pastPage.fill();
      futureShown = Number.POSITIVE_INFINITY;
      void tick().then(restore);
    });
  }

  /**
   * まだ描いていない**録れたものの本数** (「残り N 件」)。閉じた見出し1つに何本も入っているので、
   * 描く行の数では数えない
   */
  const pastRest = $derived.by(() => {
    let shown = 0;
    for (const line of pastRows) {
      if (line.kind === "row") shown += 1;
      else if (line.kind === "head" && !line.open)
        shown += line.group.items.length;
    }
    return Math.max(0, parts.past.length - shown);
  });

  /** エンコードを待っている・している録画 (動いているものが先) */
  const encoding = $derived(
    data.recordings
      .filter((rec) => rec.job_id !== null && rec.deleted_at === null)
      .sort(
        (a, b) =>
          Number(b.job_state === "running") - Number(a.job_state === "running"),
      ),
  );
  /** 次の録画 (「いま」の線の一言)。絞り込みに関係なく、いまより後に始まる予約のうちいちばん早いもの */
  const nextRes = $derived.by(() => {
    let next: Res | null = null;
    for (const item of items) {
      if (
        item.kind !== "res" ||
        item.zone !== "future" ||
        !cancelable(item.res)
      )
        continue;
      if (item.res.state === "skipped" || item.res.start_at <= clock) continue;
      if (next === null || item.res.start_at < next.start_at) next = item.res;
    }
    return next;
  });
  /** 「いま」の線に添える一言。次の録画まで (絞り込みに関係なく。録画中のあと何分かは行の3段目) */
  const lineStatus = $derived(nowStatus(clock, nextRes));
  /** 日付の見出しの字。今日・明日・昨日は言葉で、ほかは日付 */
  function dayLabel(at: number): string {
    return dayName(at, clock) ?? date(at);
  }

  /*
   * ---- 開いたときの位置 ----
   *
   * **観終えていない録画があれば、いちばん古いものを映す** — 溜まったぶんを古い順に片付けられるように。
   * 無ければ「いま」の線。まだ描いていない所にあれば、そこまで描いてから送る。
   * 並べ替えや絞り込みのたびには動かさない (開いたときの1回だけ)
   */
  let listBox: HTMLElement | undefined = $state();
  let placed = false;
  async function place(): Promise<void> {
    const target = catchUp(parts.past, unfinished);
    if (target !== null) showPastUpTo(target.key);
    await tick();
    if (listBox === undefined) return;
    const list = listBox;
    placeTimeline(list, target?.key ?? null);
    // 字 (放送の字は後から届く) とポスターで行の高さが変わると、映した行がずれ、見出しの下で行が半分に切れる。
    // 届いてから、映した行 (無ければ線) を元の高さに戻して合わせ直す。その間に自分で動かしていたら触らない (動かした所を奪わない)
    const before = window.scrollY;
    const restore = holdPlace(list, target?.key ?? null);
    await document.fonts.ready;
    requestAnimationFrame(() => {
      if (Math.abs(window.scrollY - before) < 1) {
        restore();
        alignTop(list);
      }
      ready = true;
      fillSoon();
    });
  }

  /**
   * **絞り込みを替えても、見ていた行をその場に残す。** 替える前に見えている所のいちばん上の行を覚え、
   * 替えたあともその行があれば同じ高さに戻す (無くなっていれば「いま」)。
   * 絞り込みは画面の中だけで替える (URL も読み込みも動かさない)。広い画面はページの位置合わせを自分でする
   * (`overflow-anchor: none`) ので、何もしないと「すべて」に戻したとき頭まで飛んでいた
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
    // 予約の行は戻さない (深く送っているときに、見ていた行が一度消えて位置が飛ぶ)
    if (anchor !== null) showPastUpTo(anchor.key);
    await tick();
    if (listBox !== undefined) restoreRow(listBox, anchor);
    fillSoon();
  }

  /**
   * 古い録画を上へ足す (一覧の頭の「残り N 件」が見えたとき)。**開いたときの位置に送り終えるまでは足さない** —
   * 送っている途中に足すと、送った先がずれる。待っている間も印は見張り直すので、送り終えたら足す (`sentinel`)
   */
  let ready = false;
  let revealing = false;
  async function revealOlder(): Promise<void> {
    if (!ready || revealing || listBox === undefined) return;
    revealing = true;
    const restore = holdPlace(listBox);
    pastPage.reveal();
    await tick();
    restore();
    revealing = false;
  }
  $effect(() => {
    if (listBox === undefined || placed) return;
    placed = true;
    untrack(() => void place());
  });

  /*
   * ---- サイドバーのカレンダー (`HomeCalendar`・`#lib/calendar.ts`) ----
   *
   * 押せる日は**一覧に出ている行** (絞り込みの後) で決める。頭に貼り付いている日 (`pinned`) は送るたびに読み直し、
   * カレンダーで下線を引く。日を押したらその日の見出しへ送る
   */
  const today = $derived(dayStart(clock));
  const dayMarks = $derived(markDays(shownItems, today));
  let pinned = $state<number | null>(null);
  let pinFrame = 0;
  /** 頭の日を読み直す。送っている間は1コマに1回だけ */
  function trackPinned(): void {
    if (pinFrame !== 0) return;
    pinFrame = requestAnimationFrame(() => {
      pinFrame = 0;
      if (listBox !== undefined) pinned = topDay(listBox);
    });
  }
  // 描く行が替わったとき (足した・絞った・読み直した) も読み直す
  $effect(() => {
    void shownBlocks;
    if (listBox !== undefined) untrack(trackPinned);
  });

  /**
   * その日の見出しを頭に送る。**まだ描いていない古い日なら、そこまで描いてから** (`showPastUpTo` と同じ数え方)。
   * 足すのは上なので、足す間は読んでいる所を動かさず (`holdPlace`)、描き終えてから送る — 足したぶん飛んでから送り直す、
   * という2段の動きを見せない
   */
  async function pickDay(day: number): Promise<void> {
    if (listBox === undefined) return;
    const index = lines.past.findIndex(
      (line) => line.kind === "day" && line.at === day,
    );
    if (index >= 0 && index < pastStart) {
      const restore = holdPlace(listBox);
      pastPage.showUpTo(lines.past.length - index);
      await tick();
      restore();
    }
    showDay(listBox, day);
  }
  const calendar = $derived({
    marks: dayMarks,
    today,
    pinned,
    onpick: (day: number) => void pickDay(day),
  });
  /** 頭の1行 (`TimelineBar`) とサイドバー (`HomeAside`) が同じものを受ける */
  const controls = $derived<HomeControls>({
    filter,
    setFilter,
    counts,
    grouped,
    setGrouped,
    finishedHref,
    deletedHref,
    showFinished: data.showFinished,
    showDeleted: data.showDeleted,
    capacity: data.capacity,
    encoding,
  });

  setHome({
    get clock() {
      return clock;
    },
    get nowStatus() {
      return lineStatus;
    },
    get firstLiveKey() {
      // バー (と時刻) を出せる最初の行。長さの分からない予約はバーが無いので飛ばす (無ければ線を見せる)
      return (
        parts.now.find(
          (item) => item.kind === "res" && item.res.end_at > item.res.start_at,
        )?.key ?? null
      );
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
  });
</script>

<!-- 聞き返しは他所を触ったら取り下げる (`stand`)。巻いたらカレンダーの頭の日を読み直す (`trackPinned`) -->
<svelte:window onclick={deleting.stand} onscroll={trackPinned} />

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
    <button
      type="submit"
      role="menuitem"
      class="menu-item"
      data-keep-open
      data-testid={testid}>{label}</button
    >
  </form>
{/snippet}

<div class="board">
  <Toasts {notices} source={form} ondismiss={dropNote} />

  <TimelineBar {...controls} />

  <div class="t-main">
    <section
      class="t-list"
      bind:this={listBox}
      aria-label="予約と録画"
      data-testid="timeline"
    >
      <!--
                **300件で頭打ちなのを黙らない。** 溜まると古いものが黙って消え、「消えた」ように見える。
                上限に当たっていたら、いちばん古い録画の上 (一覧の頭) に検索へ誘う一行を出す (`+page.server.ts` の `.limit(300)`)
            -->
      {#if data.recordings.length >= 300 && pastStart === 0}
        <div class="row-empty muted small">
          新しい順に300件まで表示しています。古いものは検索で探してください。
        </div>
      {/if}
      {#if pastStart > 0}
        <!-- 頭に近づいたら古いほうを上へ足す (`sentinel`・`revealOlder`)。残りが無くなれば消える -->
        <div
          class="row-empty muted small num"
          use:sentinel={() => void revealOlder()}
          data-testid="recording-more"
        >
          残り {pastRest} 件
        </div>
      {/if}
      <!--
                見出しごとに包む。見出しは包みの中だけで貼り付くので、前の日の見出しが次の日に残らない。
                今日の包みは線と今日の予約まで抱えるので、線をまたいでも「今日」が頭に残る
            -->
      <div class="t-rows">
        {#each shownBlocks as block (block.key)}
          <div class="t-block" data-block={block.key}>
            {#each block.lines as entry (entry.key)}
              <TimelineEntry {entry} />
            {/each}
          </div>
        {/each}
      </div>
      {#if shownItems.length === 0}
        {#if items.length === 0}
          <!-- 空のときは次に何をすればよいかまで言う -->
          <div class="empty glow">
            <p class="empty-title">予約も録画もありません</p>
            <p class="empty-hint">
              番組表から予約するか、ルールを作ると自動で入ります
            </p>
            <div class="empty-actions">
              <a class="button small" href={resolve("guide")}>番組表を開く</a>
              <a class="button secondary outline small" href={resolve("search")}
                >ルールを作る</a
              >
            </div>
          </div>
        {:else}
          <div class="empty">
            <p class="empty-title">当てはまるものはありません</p>
          </div>
        {/if}
      {/if}
      <!-- 絞った結果の件数は一覧の末尾に -->
      {#if filter !== "all"}
        <div class="row-empty muted small num" data-testid="timeline-matched">
          {items.length} 件中 {shownItems.length} 件
        </div>
      {/if}
    </section>

    <HomeAside {...controls} {calendar} />
  </div>
</div>

{#if detail.current}
  <ProgramDetail
    program={detail.current}
    notes={detailNotes}
    cmNote={detailCmNote}
    onclose={() => detail.close()}
    fps={detailRec?.fps ?? null}
    actions={detailRec !== null
      ? recordingActions
      : detailRes !== null
        ? reservationActions
        : undefined}
  />
{/if}

<!--
    予約の詳細から取り消す。**行の「取消」と同じアクション** (`?/cancel`) なので、
    ルールが立てた予約でも作り直されない (戻すのは行の「戻す」から)。

    行にしか無かった頃は、詳細を開いて中身を確かめてから要らないと分かっても、
    一度閉じて行のボタンを探し直すことになっていた (番組表の詳細には前からある)。
    **取り消せたら閉じる** — 番組表の詳細で予約・取消したときと同じ。
    取り消した行は一覧から消える (完了した予約も出しているときは「戻す」に変わる)
-->
{#snippet reservationActions()}
  {#if detailRes !== null}
    <!-- 録画の詳細と同じ入口。予約は番組を指しているので番組から作る -->
    <a
      class="button secondary outline"
      href={ruleFrom("program", detailRes.program_id)}
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
          if (result.type === "success") detail.close();
        }}
    >
      <input type="hidden" name="id" value={detailRes.id} />
      <button type="submit" class="outline danger" data-testid="detail-cancel"
        >予約取消</button
      >
    </form>
  {/if}
{/snippet}

<!--
    その1本に対する操作。**一覧の行ではなくここに置く** (行に並べていた頃は狭い画面で枠から流れ出した)。
    行に残すのは入口 (詳細) と削除だけ
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
        {#if held === undefined || held.state === "failed"}
          <button
            type="button"
            class="secondary outline"
            onclick={() => saveToDevice(rec)}
          >
            {held?.state === "failed" ? "保存をやり直す" : "端末に保存"}
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
            {held.state === "downloading"
              ? "保存を取り消す"
              : held.state === "failed"
                ? "失敗した保存データを消す"
                : "端末から消す"}
          </button>
        {/if}
      {/if}
    {/if}
    <!--
            **ルールを作る。** 検索の画面の「ルールとして保存」へ、シリーズ名を入れた下書きを
            持って行く (保存はあちらで確かめてから)。既にこの番組を録っているルールが
            あれば、あちらがそのルールを案内する
        -->
    <a
      class="button secondary outline"
      href={ruleFrom("recording", rec.id)}
      data-testid="detail-rule"
    >
      ルールを作る
    </a>
    {#if (data.clipCounts[rec.id] ?? 0) > 0}
      <!-- この録画で撮った切り抜き。録画で絞った切り抜きの画面へ -->
      <a
        class="button secondary outline"
        href={resolve(`clips?recording=${rec.id}`)}
        data-testid="detail-clips"
      >
        この録画の切り抜き <span class="num">({data.clipCounts[rec.id]})</span>
      </a>
    {/if}
    {#if hasFile(rec)}
      <!--
                **めったに押さないものの置き場。** 上に開く (フッターは画面の下端にある)。中身は上から
                視聴済みの付け外し、直すもの (再エンコード・CM検出) の順。
                閉じている間も中身は DOM に置く (どの項目が出るかを e2e が開かずに数えている)
            -->
      <Menu side="top" align="end" class="more-menu" testid="detail-more-menu">
        {#snippet trigger(props)}
          <button
            {...props}
            type="button"
            class="secondary outline"
            data-testid="detail-more">その他…</button
          >
        {/snippet}
        <!--
                    **未視聴の印を付け外しする** (`?/watched`)。末尾まで観れば勝手に外れる
                    ので、押すのは観直したいときか、よそで観たときくらい。どちらも続きの位置は消す
                    (残すと進捗バーが残って、押した結果が一覧に出ない)。
                    詳細は開いたときの行を持っているので、送ったら閉じる (`menuSubmit`)
                -->
        {@render menuSubmit(
          "?/watched",
          rec.watched_at === null ? "視聴済みにする" : "未視聴に戻す",
          "watched-button",
          { id: rec.id, watched: rec.watched_at === null ? "1" : "0" },
          detail.close,
        )}
        {#if rec.job_id === null && encodeSource(rec) !== null}
          <!--
                        再エンコードの元になるのは元のTS。エンコード済みを元にしても
                        画質は戻らないので、元のTSがあるときだけ出す
                    -->
          {@render menuSubmit(
            "?/reencode",
            "再エンコード",
            "reencode-button",
            { id: rec.id },
            detail.close,
          )}
        {/if}
        {#if rec.job_id === null && cmRedo(rec).state !== "hidden"}
          {@const redo = cmRedo(rec)}
          <!--
                        **CM 検出だけやり直す** (再エンコードしない。encoder.runCmJob)。元のTSがあれば元のTSから、
                        無ければエンコードしたものから読み、チャプターを書き直す。CM を切ってエンコードしたものは戻せないので、
                        元のTSがあれば押したときに再エンコードを促し (サーバが断る)、無ければ理由を出して押せない。
                        閉じるのは投げ終わってから (再エンコードと同じ)
                    -->
          {#if redo.state === "disabled"}
            <div
              role="menuitem"
              class="menu-item"
              aria-disabled="true"
              data-disabled
              tabindex="-1"
              data-testid="cm-redo-button"
            >
              CM検出をやり直す
            </div>
            <div class="menu-note muted small">{redo.reason}</div>
          {:else}
            {@render menuSubmit(
              "?/redetectCm",
              "CM検出をやり直す",
              "cm-redo-button",
              { id: rec.id },
              detail.close,
            )}
          {/if}
        {/if}
      </Menu>
    {/if}
    {@const watch = watchLink(rec)}
    {#if watch !== null}
      <!-- **主のボタンは再生だけ** (並びのいちばん右・狭い画面ではいちばん上) -->
      <a class="button" href={watch} data-testid="detail-play">再生</a>
    {/if}
  {/if}
{/snippet}

<style>
  /*
     * 一覧・行・頭の1行の見た目は部品と分け合うので `#lib/components/home/home.css` (`.board` の下だけに効く)。
     * ここに残すのは、一覧の外 (番組の詳細) に出るものだけ。送るだけの項目を包むフォーム (`.menu-form`) は `app.css`
     */
  /* 「その他…」の中身 (枠は `Menu` の中なので :global)。項目は左寄せで縦に積む (`app.css` の `.menu`) */
  :global(.more-menu) {
    width: 16rem;
    max-width: calc(100vw - 2rem);
  }
  /* 押せない項目のすぐ下に出す理由 (CM検出をやり直せないわけ)。項目と同じ字下げで、次の項目とは余白で分ける */
  .menu-note {
    padding: 0.25rem 0.75rem 0.5rem;
    white-space: nowrap;
  }
</style>
