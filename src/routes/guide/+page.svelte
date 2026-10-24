<script lang="ts">
  import { untrack } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import { dragScroll, submitting } from "#lib/actions.js";
  import { GENRE_TREE } from "#lib/arib.js";
  import ChannelNotice from "#lib/components/ChannelNotice.svelte";
  import { guideNavigation } from "#lib/components/GuidePending.svelte";
  import Menu from "#lib/components/Menu.svelte";
  import NowLine from "#lib/components/NowLine.svelte";
  import ProgramDetail from "#lib/components/ProgramDetail.svelte";
  import Icon from "#lib/components/player/Icon.svelte";
  import ServiceLogo from "#lib/components/ServiceLogo.svelte";
  import {
    channelNumber,
    date,
    SERVICE_TYPE_LABEL,
    stateLabel,
    time,
  } from "#lib/format.js";
  import { skeletonMask } from "#lib/guide-skeleton.js";
  import { reload } from "#lib/reload.svelte.js";
  import {
    cellsOf,
    columnsOf,
    mainOf,
    SUBCHANNELS_COOKIE,
    splitOf,
  } from "#lib/subchannels.js";
  import {
    CHANNEL_TYPES,
    type ProgramDetail as Facts,
    type GridProgram,
    type GuideSheet,
  } from "#lib/types.js";
  import type { SubmitFunction } from "$app/forms";
  import { preloadData } from "$app/navigation";
  import { resolve } from "$app/paths";
  import Ellipsis from "~icons/lucide/ellipsis";
  import Layers from "~icons/lucide/layers";
  import Palette from "~icons/lucide/palette";

  let { data, form } = $props();

  /**
   * 表のマス。**外枠より後から届く** (`+page.ts`。`/api/guide`)。
   * 局名の行と時刻の列は外枠と一緒に届くので本物を先に出し、マスのところだけ骨組みにしておく。
   *
   * **通知で読み直したときに骨組みへ戻さない。** 番組表は録画やエンコードの
   * 通知が来るたびに読み直すので、そのたびマスが消えては現れるとちらつく。
   * 同じ日・同じ放送波なら前のものを出したままにして、届いたら差し替える
   * (`live-updates.svelte.ts` の `held` と同じ考え方)。
   * **別の日・別の放送波へ移ったときだけ**捨てる — 選び直したのに前のマスが
   * 残っていると、タブと中身が食い違って見える
   */
  let sheet = $state<GuideSheet | null>(null);
  let shownKey = "";
  $effect(() => {
    const key = `${data.type}:${data.start}`;
    const coming = data.sheet;
    if (key !== shownKey) sheet = null;
    // サーバで描くときだけ null (取るのはブラウザ。`+page.ts`)
    if (coming === null) return;
    // 追い越しがあると古いほうで上書きしてしまう
    let stale = false;
    void coming.then((next) => {
      if (stale) return;
      /*
       * **一度きりの失敗で、見えている表を消さない。** 通知のたびに
       * 読み直すので、そのうち1回が転んだだけで番組表が消えるのは割に
       * 合わない (`held` と同じ考え方)。まだ何も出していないときと、
       * 別の日・別の放送波へ移ったあと (`sheet` は null に戻してある) は、
       * 出すものが無いので理由を出す
       */
      if (next.failed !== null && sheet !== null && sheet.failed === null)
        return;
      // 骨組みから表に変わる回か、見えている表の差し替えか
      const fresh = shownKey !== key;
      sheet = next;
      shownKey = key;
      if (fresh) drawGradually(cells.length);
      else drawAll();
    });
    return () => {
      stale = true;
    };
  });

  /**
   * **押した先の日・放送波を待っている間も、マスは骨組みにする。**
   *
   * 外枠 (局の並び) が届くまでは前の表がそのまま残り、押しても何も起きていないように見えた。
   * 押したらすぐマスを骨組みに替え、放送波が変わるなら局名の行も骨組みにする
   * (同じ放送波の別の日なら局の並びはほぼ同じなので、そのまま残す)
   */
  const toGuide = guideNavigation();
  /** 押した先の放送波。今と同じ日・同じ放送波 (読み直し・同じリンク) なら null */
  const switching = $derived.by(() => {
    const to = toGuide.to;
    if (to === null) return null;
    const type = to.searchParams.get("type") ?? "GR";
    // start の無いリンク (狭い画面の「今日」) は今日へ行く (`+page.server.ts`)
    const start = Number(to.searchParams.get("start") ?? data.today);
    if (type === data.type && start === data.start) return null;
    return { type };
  });
  /** マスを出すか (届いていて、ほかの日・放送波へ移る途中でもない) */
  const showCells = $derived(
    sheet !== null && sheet.failed === null && switching === null,
  );
  /** 局名の行を骨組みにするか (別の放送波へ移る途中) */
  const headSkeleton = $derived(
    switching !== null && switching.type !== data.type,
  );

  const services = $derived(data.services);
  const programs = $derived<GridProgram[]>(sheet?.programs ?? []);

  /**
   * サブチャンネル (テレ東2・3、Eテレ2・3、BS朝日2・3 など) の列を出すか。**既定は出す**
   * (分割放送のあるサブだけ。`#lib/subchannels.ts`)。切ったら端末ごとに cookie で覚える
   */
  let subchannels = $state(untrack(() => data.subchannels));
  const main = $derived(mainOf(services));
  /** サブチャンネルの分割放送 (マスを組むのに使う)。ずっと本チャンネルと同じ番組のサブは入らない */
  const split = $derived(splitOf(programs, main));
  /**
   * 分割放送のあるサブ (外枠と一緒に届く。`+page.server.ts` の `split`)。**列はこちらで立てる** —
   * マスを待たずに局名の行を出すため
   */
  const splitColumns = $derived(new Map(data.split.map((id) => [id, []])));
  /**
   * 切り替えは、その日に分割放送があるときだけ出す。無ければ出しても列が増えない
   * (ずっと本チャンネルと同じ番組のサブは列を立てない。CS・SKY は束ねないので出ない)
   */
  const canSplit = $derived(data.split.length > 0);
  const columns = $derived(
    columnsOf(services, main, subchannels ? splitColumns : null),
  );
  /** 表のマス。本チャンネルと同じ番組を流しているサブの列には本チャンネルのマスが伸びてくる */
  const cells = $derived(cellsOf(columns, programs, main, split));

  function setSubchannels(on: boolean): void {
    subchannels = on;
    // 列が増減するだけなので、少しずつ描き直さない (`drawAll`)
    drawAll();
    // パスは接頭辞込み (録画一覧の「まとめて表示」と同じ)
    document.cookie = `${SUBCHANNELS_COOKIE}=${on ? "1" : "0"}; path=${resolve("")}; max-age=31536000; samesite=lax`;
  }

  /**
   * 一度に描くマスの数。BS/CS は24時間ぶんで数千個の `<button>` になり、一度に描くと表が届いた瞬間に止まって見えた。
   * 先頭から数百個ずつ描画の合間 (`requestAnimationFrame`) に足せば、描いている最中もスクロールやタブの切り替えができる。
   * 地上波 (500〜700 マス) なら1〜2コマで済む数。画面の外のマスは中身を組まない (`.cell` の `content-visibility`)
   */
  const CELL_CHUNK = 600;
  /** いま描いているマスの数。`Infinity` なら全部 */
  let shownCells = $state(Number.POSITIVE_INFINITY);
  let drawFrame = 0;

  /**
   * **骨組みから表に変わるときだけ**少しずつ描く。
   *
   * 位置は `grid-row` / `grid-column` で決めているので、途中まででも
   * マスの場所は崩れない。いま (`nowMark`) の線はマスと独立に描くので、
   * 「いま」へのスクロールは最初のコマで済む
   */
  function drawGradually(total: number): void {
    cancelAnimationFrame(drawFrame);
    shownCells = Math.min(CELL_CHUNK, total);
    const step = (): void => {
      if (shownCells >= total) return;
      shownCells = Math.min(total, shownCells + CELL_CHUNK);
      drawFrame = requestAnimationFrame(step);
    };
    if (shownCells < total) drawFrame = requestAnimationFrame(step);
  }

  /**
   * **見えている表の差し替えは一度に。** 通知のたびに読み直すので、
   * そのたび少しずつ描き直すとマスが消えて現れてちらつく
   */
  function drawAll(): void {
    cancelAnimationFrame(drawFrame);
    shownCells = Number.POSITIVE_INFINITY;
  }

  $effect(() => () => cancelAnimationFrame(drawFrame));

  /** まだ描き終えていない。`aria-busy` で外から分かるようにする */
  const drawing = $derived(shownCells < cells.length);
  const visibleCells = $derived(drawing ? cells.slice(0, shownCells) : cells);

  /**
   * **マスは局ごとの箱 (`.station`) に入れて置く。** 箱は本チャンネルとそのサブの列をまとめたもの
   * (サブの列へ横に伸びるマスがあるので、列ごとには分けられない)。
   *
   * 箱に `content-visibility: auto` を付けると、横に外れた局は箱ごと見た目の計算とレイアウトを飛ばせる
   * (マスにだけ付けていた頃は、地上波 658 マスで表が届いてからの 1 回の処理が 190ms ほどかかっていた)。
   * 縦に外れたマスは、マスごとの `content-visibility` で飛ばす。
   *
   * 箱の中は自前の grid。行は外の表と同じ 5 分 × `SLOT_HEIGHT`、列は箱の幅を等分する
   * (外の列はどれも同じ幅なので揃う)。`subgrid` は使えない — `content-visibility` が付けるレイアウトの
   * 封じ込め (layout containment) があると subgrid にならない決まり。
   * 位置と行数はここで先に出しておき、マークアップは書き写すだけにする
   */
  interface PlacedCell {
    key: string;
    program: GridProgram;
    /** 箱の中の位置 (`grid-column` / `grid-row`) と、入る字の行数 (`--lines`) */
    style: string;
  }
  const stations = $derived.by(() => {
    const groups: {
      key: number;
      first: number;
      width: number;
      cells: PlacedCell[];
    }[] = [];
    const groupOf: number[] = [];
    columns.forEach((service, i) => {
      const head = groups.at(-1);
      if (
        head !== undefined &&
        (main.get(service.id) ?? service.id) === head.key
      )
        head.width++;
      else groups.push({ key: service.id, first: i, width: 1, cells: [] });
      groupOf.push(groups.length - 1);
    });
    for (const cell of visibleCells) {
      const group = groups[groupOf[cell.column] ?? -1];
      if (group === undefined) continue;
      const from = Math.max(0, Math.floor((cell.start_at - data.start) / SLOT));
      const to = Math.min(
        slots,
        Math.ceil((Math.min(cell.end_at, end) - data.start) / SLOT),
      );
      const span = Math.max(1, to - from);
      group.cells.push({
        key: cell.key,
        program: cell.program,
        // `--s` / `--e` は番組の頭と尻のマスの位置 (端数つき)。過ぎた所を暗くするのに使う (`.program::before`)
        style: `grid-column: ${cell.column - group.first + 1} / span ${cell.span}; grid-row: ${from + 1} / span ${span}; --lines: ${lines(span)}; --s: ${(cell.start_at - data.start) / SLOT}; --e: ${(cell.end_at - data.start) / SLOT};`,
      });
    }
    return groups;
  });

  /** クリックした番組。詳細を出してから予約するかどうか決める */
  let selected = $state<GridProgram | null>(null);

  /**
   * 開いた番組の中身 (出演者・あらすじ・音声…)。**表は持っていない**
   * (`GridProgram`) ので、開くときに 1 件だけ取る。
   */
  let facts = $state<Facts | null>(null);
  /** 続けて別のマスを押したとき、遅れて届いた前の結果で上書きしない */
  let opening = 0;

  /**
   * **押したらすぐ出す。足りない分 (出演者・あらすじ・音声…) は届いてから足す。**
   *
   * 前は 1 件ぶんの取得が届くまで待ってから出していた。同じホストなら数十 ms でも、
   * 車のタブレットのように遠い回線では押してから一拍以上何も起きず、もたついて見えた。
   * 表が持っている分 (タイトル・時刻・概要) で先に出し、届いたら差し替える。
   * 取れなければ (番組表から消えた) 表の分のまま。
   *
   * **マスから広げる動き (View Transitions) はやめた。** 写しを撮る前後で `<html>` の印を
   * 付け外しするたびに文書ぜんぶの見た目を計算し直していて、番組の多い表では
   * 押してから箱が出るまでの大半がそれだった (箱はほかの画面と同じく、少し縮んだ姿から出る)
   */
  function open(program: GridProgram): void {
    const token = ++opening;
    const seed: Facts = {
      name: program.name,
      service_name: serviceName(program.service_id),
      start_at: program.start_at,
      end_at: program.end_at,
      description: program.description,
      extended: null,
      genre_detail: null,
      audios: null,
      video_type: null,
      video_resolution: null,
      is_free: true,
      copy_never: program.copy_never,
    };
    facts = seed;
    selected = program;
    void fetch(resolve(`api/programs/${program.id}`))
      .then(async (res) => (res.ok ? ((await res.json()) as Facts) : null))
      .catch(() => null)
      .then((detail) => {
        // 閉じた・別のマスを開いたあとに届いたものは捨てる
        if (detail === null || token !== opening) return;
        facts = { ...seed, ...detail };
      });
  }

  function close(): void {
    opening++;
    selected = null;
    facts = null;
  }

  /** 予約・取消を送ったあと。失敗したときは開いたままにして、中に理由を出す */
  const closeOnSuccess: SubmitFunction =
    () =>
    async ({ result, update }) => {
      await update();
      if (result.type === "success") close();
    };

  const serviceName = (id: number) =>
    services.find((s) => s.id === id)?.name ?? "";

  /**
   * いまライブで選べる局。詳細の「視聴」を出すかどうかに使う。
   *
   * **決めているのはサーバ** (`+page.server.ts` の `watchable`)。ライブ画面と
   * 同じ決め方でないと、押した先で別の局が映る
   */
  const watchable = $derived(new Set(data.watchable));

  const HOUR = 60 * 60 * 1000;
  /** 5分を1マスにする。細かすぎると行数が増えるだけ、粗いと短い番組が潰れる */
  const SLOT = 5 * 60 * 1000;
  /** 1 マスの高さ。表の行と今の線の送り (`nowSlots`) の両方がこれを使う */
  const SLOT_HEIGHT = "0.75rem";

  const slots = $derived((data.hours * HOUR) / SLOT);

  /**
   * マスに入る字の行数。**行の途中で切らず、入りきらない行は「…」で止める** (`.clamp`)。
   * 字は 0.75rem・行の高さ 1.25 (1 行 0.9375rem)、上下の余白はマスと button で 0.5rem。
   * どれも rem なので、字の大きさを変えても行数は変わらない。1 マス (5 分) でも 1 行は出す
   */
  function lines(span: number): number {
    return Math.max(1, Math.floor((span * 0.75 - 0.5) / 0.9375));
  }

  /** いま何時か。番組表に現在位置の線を出すため、1分ごとに進める */
  let clock = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (clock = Date.now()), 60_000);
    return () => clearInterval(timer);
  });

  /**
   * 表示中の日にいまが含まれていれば、表の頭 (4:00) から何マスぶん下か (端数つき)。
   *
   * **線は 1 マス (5 分) ごとに飛ばさず、分の位置へ `translate` で送る。** 行 (`grid-row`) で
   * 置いていた頃は 5 分ごとに 1 マスずつ飛んでいた。1 分ごとの移りは短い transition でなめらかに
   * (`.now`。動かさない設定ではすぐ移る)
   */
  const nowSlots = $derived(
    clock >= data.start && clock < data.start + data.hours * HOUR
      ? (clock - data.start) / SLOT
      : null,
  );
  /**
   * **過ぎた所を暗くする位置** (表の頭から何マスぶん。マスの `--s` / `--e` と比べる。`.program::before`)。
   * 前の日は全部、先の日は何も暗くしないよう、表の外は端の外へ寄せる。2,000 を超えるマスを毎分書き直さないよう、表に 1 つだけ持つ
   */
  const elapsedSlots = $derived(
    Math.min(Math.max((clock - data.start) / SLOT, -1), slots + 1),
  );

  let grid = $state<HTMLElement | null>(null);
  let nowMark = $state<HTMLElement | null>(null);
  /**
   * 局名の行の高さ。時刻を下ろしてくるときの上端に使う。
   * 決め打ちの値だと、局ロゴが入ったり字の大きさが変わったりしたときに
   * 数字が見出しの裏へ潜る
   */
  let headHeight = $state(0);

  /**
   * 時刻の列の幅。**数字と「いま」のラベルが入るぶんだけ。**
   *
   * 出しているのは「13」のような時だけなので、3.5rem は要らなかった。
   * 狭くしたぶんは番組の列に回る (横に並ぶ局が増える)
   */
  const TIME_COLUMN = "2.5rem";

  /*
   * 開いたときに「いま」が見えている状態にする。24時間ぶん出るので、
   * 先頭(4:00)のままだと毎回スクロールさせることになる。
   *
   * 位置は offsetTop では測れない (親が body になり、ナビや見出しの高さまで足し込まれる)。見えている位置の差から出す (`nowTop`)。
   *
   * **マスを待たずに動かす。** 局名の行と時刻の列は先に出ていて、行の高さも決まっているので、
   * 骨組みのうちに「いま」の位置まで送っておける (届いたときに動かない)。
   * 放送波や日を選び直しても表の枠は作り直さないので、縦位置 (時刻) はそのまま残る
   */
  let scrolledBox: HTMLElement | null = null;
  $effect(() => {
    if (grid === null || nowMark === null || scrolledBox === grid) return;
    scrolledBox = grid;

    const target = grid;
    const mark = nowMark;
    const place = () => {
      target.scrollTop = Math.max(0, nowTop(target, mark));
    };

    place();
    let frames = 0;
    const settle = () => {
      place();
      // 画像(局ロゴ)やバッジが入って高さが変わることがあるので数回追う
      if (++frames < 5) requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  });

  const end = $derived(data.start + data.hours * HOUR);

  const hourMarks = $derived(
    Array.from({ length: data.hours }, (_, i) => ({
      at: data.start + i * HOUR,
      row: (i * HOUR) / SLOT + 2,
      span: HOUR / SLOT,
    })),
  );

  function href(params: Record<string, string>): string {
    const query = new URLSearchParams({ type: data.type, ...params });
    return resolve(`guide?${query}`);
  }

  /** 表の日付 (`10/18(日)`) を月と日に分ける */
  const shownDate = $derived(date(data.start));
  const month = $derived(shownDate.slice(0, shownDate.indexOf("/") + 1));
  const day = $derived(shownDate.slice(month.length));

  const prevHref = $derived(
    href({ start: String(data.start - data.hours * HOUR) }),
  );
  const nextHref = $derived(
    href({ start: String(data.start + data.hours * HOUR) }),
  );

  /**
   * 日付の並び (広い画面)。**番組の残っている前の日 → 今日 → 番組表の届いている日** (`+page.server.ts` の `daysOf`)。
   * 前の日は字を控える (`past`)。番組の無い日も並べて押せなくする。並びの外の日を見ているときは、その日を端に足す
   * (選んでいる日が並びに無いと、どこを見ているのか分からない)
   */
  const days = $derived.by(() => {
    const entry = (day: { start: number; has: boolean }) => ({
      ...day,
      label: dayLabel(day.start),
      name: `${day.start === data.today ? "今日 " : ""}${date(day.start)}`,
      weekday: weekday(day.start),
      today: day.start === data.today,
      past: day.start < data.today,
    });
    const list = data.days.map(entry);
    const chosen = entry({ start: data.start, has: true });
    if (data.start < (list[0]?.start ?? data.start)) list.unshift(chosen);
    // 並びより先の日 (手で書いた URL・古いリンク) も末尾に足す
    else if (data.start > (list.at(-1)?.start ?? data.start)) list.push(chosen);
    return list;
  });

  /** 「18(日)」。今日はこの前に小さく「今日」を添える (マークアップの `.today-mark`)。土日は字の色 (`.sat`・`.sun`) */
  function dayLabel(start: number): string {
    const text = date(start);
    return text.slice(text.indexOf("/") + 1);
  }

  function weekday(start: number): "sat" | "sun" | "" {
    const day = new Date(start).getDay();
    return day === 6 ? "sat" : day === 0 ? "sun" : "";
  }

  /**
   * **並びが入りきらないときだけ、両端に ← → を出す** (どちらも1日ずつ送る)。入るなら日を直接押せば済む。
   *
   * 測るのは並び (`strip`) の中身の幅と、出せる幅。矢印を出すと並びが狭くなるので、
   * 出しているときは矢印のぶんも出せる幅に足して比べる (出したり消したりを繰り返さない)
   */
  let strip = $state<HTMLElement | null>(null);
  let prevArrow = $state<HTMLElement | null>(null);
  let nextArrow = $state<HTMLElement | null>(null);
  let crowded = $state(false);
  $effect(() => {
    const box = strip;
    if (box === null) return;
    const measure = () => {
      if (box.clientWidth === 0) return;
      const arrows = crowded
        ? (prevArrow?.offsetWidth ?? 0) + (nextArrow?.offsetWidth ?? 0)
        : 0;
      crowded = box.scrollWidth > box.clientWidth + arrows + 1;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    measure();
    return () => observer.disconnect();
  });

  /*
   * **選んでいる日を並びの左のほうに見せる** (並びは横に流れる)。前の日を並べたぶん、今日が右へ押し出されて
   * 隠れないように。1つ前の日だけは左に覗かせて、まだ戻れることが分かるようにする
   */
  $effect(() => {
    data.start;
    crowded;
    const box = strip;
    const chosen = box?.querySelector<HTMLElement>('[aria-current="date"]');
    if (box == null || chosen == null || box.clientWidth === 0) return;
    const left =
      chosen.getBoundingClientRect().left -
      box.getBoundingClientRect().left +
      box.scrollLeft;
    const peek =
      (chosen.previousElementSibling as HTMLElement | null)?.offsetWidth ?? 0;
    box.scrollLeft = Math.max(0, left - peek);
  });

  /**
   * 時刻へ送るボタン。**その日のその時刻を表の上端 (局名の行のすぐ下) に持ってくる。**
   * 「今」はいまの線を開いたときと同じ高さ (画面の4分の1) に置く。今日を見ているときだけ押せる
   */
  const JUMPS = [
    { key: "6", label: "朝", hour: 6, title: "6:00 へ" },
    { key: "12", label: "昼", hour: 12, title: "12:00 へ" },
    { key: "19", label: "夜", hour: 19, title: "19:00 へ" },
    { key: "23", label: "深夜", hour: 23, title: "23:00 へ" },
  ] as const;

  let scrollFrame = 0;

  /**
   * 表を縦に送る。**動きは `--dp-duration` (80ms)**。動かさない設定ではその値が 0 になり、すぐ移る。
   * ブラウザの `behavior: 'smooth'` は長さを決められず、数百ms かかる
   */
  function scrollGrid(top: number): void {
    const box = grid;
    if (box === null) return;
    cancelAnimationFrame(scrollFrame);
    const target = Math.max(
      0,
      Math.min(top, box.scrollHeight - box.clientHeight),
    );
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--dp-duration")
      .trim();
    const duration = raw.endsWith("ms")
      ? Number.parseFloat(raw)
      : Number.parseFloat(raw) * 1000;
    const from = box.scrollTop;
    if (!(duration > 0) || from === target) {
      box.scrollTop = target;
      return;
    }
    const begin = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - begin) / duration);
      box.scrollTop = from + (target - from) * (1 - (1 - t) ** 3);
      if (t < 1) scrollFrame = requestAnimationFrame(step);
    };
    scrollFrame = requestAnimationFrame(step);
  }

  $effect(() => () => cancelAnimationFrame(scrollFrame));

  function jumpTo(hour: number): void {
    const rem = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    // 表の頭は 4:00。5分で1マス
    const slot = (((hour - 4 + 24) % 24) * HOUR) / SLOT;
    scrollGrid(slot * Number.parseFloat(SLOT_HEIGHT) * rem);
  }

  /**
   * 「いま」を表の4分の1あたりに置く縦位置。上端ちょうどに置くと直前の番組が見えず、
   * 放送中のものが頭から切れて分かりにくい
   */
  function nowTop(box: HTMLElement, mark: HTMLElement): number {
    const top =
      mark.getBoundingClientRect().top - box.getBoundingClientRect().top;
    return box.scrollTop + top - box.clientHeight / 4;
  }

  function jumpNow(): void {
    if (grid !== null && nowMark !== null) scrollGrid(nowTop(grid, nowMark));
  }

  /**
   * ジャンルの色の見本と、1つだけ目立たせる切り替え。色の決め方は下の `.program[data-genre]` と同じ規則
   * (見本も同じセレクタで `--tint` を受ける)。色の付くのは 0〜11 だけ
   */
  const GENRES = GENRE_TREE.filter((genre) => Number(genre.value) <= 11).map(
    (genre) => ({
      id: Number(genre.value),
      label: genre.label,
    }),
  );
  /** 目立たせているジャンル。ほかのマスを淡くする。端末をまたいで覚えるほどのものではない */
  let highlight = $state<number | null>(null);

  /** 狭い画面では操作の1行が下にあるので、メニューは上へ開く */
  const narrowQuery = new MediaQuery("max-width: 767px");
  const narrow = $derived(narrowQuery.current);
  const menuSide = $derived(narrow ? "top" : "bottom");

  /*
   * 放送波を切り替えたら横位置を先頭へ戻す。
   *
   * 同じ画面のまま中身だけ入れ替わるので、DOM は使い回され、横スクロールの
   * 位置がそのまま残る。地上波で右のほうを見ていたあと BS を開くと、
   * 局の並びは別物なのに同じ位置から始まり、左端の局が隠れていた。
   * 縦(時刻)はどの放送波でも同じ意味なので、そのままにする
   */
  $effect(() => {
    data.type;
    if (grid !== null) grid.scrollLeft = 0;
  });

  /*
   * 前日・翌日を先に取り寄せておく。`data-sveltekit-preload-data="hover"` は指を乗せてからなので、狙って押すと間に合わない。
   *
   * **マスを描き終わってから** (`drawing` が下りてから) 取得する。表が届いた時点で投げていた頃は、BS で 1 件 1 MB 超の
   * 応答の解読が描画と取り合っていた。描き終わった直後もレイアウトが走っているので、少し置いて (`PREFETCH_DELAY`)
   * 空いたとき (`requestIdleCallback`。Safari には無いので置くだけ) に投げる。
   * 同じ日・同じ放送波の読み直しでは取り直さない (`prefetchedFor`)
   */
  const PREFETCH_DELAY = 1000;
  let prefetchedFor = "";
  $effect(() => {
    const soon = prevHref;
    const later = nextHref;
    if (!showCells || drawing) return;
    const key = `${data.type}:${data.start}`;
    if (prefetchedFor === key) return;
    const fetchBoth = () => {
      prefetchedFor = key;
      void preloadData(soon);
      void preloadData(later);
    };
    if (typeof requestIdleCallback !== "function") {
      const timer = setTimeout(fetchBoth, PREFETCH_DELAY);
      return () => clearTimeout(timer);
    }
    let handle = 0;
    const timer = setTimeout(() => {
      handle = requestIdleCallback(fetchBoth, { timeout: 3000 });
    }, PREFETCH_DELAY);
    return () => {
      clearTimeout(timer);
      cancelIdleCallback(handle);
    };
  });

  /** 予約を取り消せるのはこれから録るものだけ。録り終わったものに出しても何も起きない */
  const CANCELABLE = ["scheduled", "conflict", "skipped", "recording"];
</script>

<!--
    **表は画面の残りをぜんぶ使う。** 枠 (カード) で囲まず、本文の余白も打ち消して
    端から端まで表にする (`app.css` の `.guide-frame`)。1画面に入る局と時間を増やすため
-->
<div class="guide-frame">
  <!--
        **どこを見るかは表の外の細い1行にまとめる** (種別・日付・時刻・サブch・ジャンル)。縦は表に回す。

        表の中 (左上の角・局名の行) には入れない。角は時刻の列の幅 (2.5rem) しか無く、
        入れるならメニューに畳むことになり、種別や日を変えるたびに1回多く押す。
        局名の行に入れると、操作の幅のぶん局名が隠れる。表の外の1行なら、
        隠れるものも押す回数も増えない。

        **狭い画面では表の下、下のタブのすぐ上に置く** (親指が届く。`.guide-bar` の `order`)。
        DOM の順 (種別 → 日付 → 時刻 → …) は読み上げの順なので変えない。
        入りきらない幅では、時刻のボタンを「⋯」に、さらに狭いと日付のメニューに移す
    -->
  <div class="toolbar guide-bar" data-testid="guide-toolbar">
    <div role="group" class="types segmented" data-testid="type-tabs">
      {#each CHANNEL_TYPES as type (type)}
        <a
          class="button small {data.type === type ? '' : 'secondary outline'}"
          aria-current={data.type === type ? "page" : undefined}
          href={href({ type, start: String(data.start) })}
          data-testid="type-{type}"
        >
          <span class="seg-label">{SERVICE_TYPE_LABEL[type]}</span>
        </a>
      {/each}
    </div>

    <!--
            日付は種別のすぐ隣。どちらも「表のどこを見るか」の操作なので離さない。
            広い画面は日付を並べて直接押す (`.strip`。前の日は今日の左に控えた字で)。← → は入りきらないときだけ。
            狭い画面は ← 日付 → で、日付を押すと1週間ぶんと時刻のメニューが開く
        -->
    <div class="days" class:crowded>
      <a
        class="button small secondary outline arrow prev"
        href={prevHref}
        aria-label="前日"
        data-testid="prev-day"
        bind:this={prevArrow}>←</a
      >
      <nav class="strip" aria-label="日付" bind:this={strip}>
        {#each days as day (day.start)}
          {@const selected = day.start === data.start}
          {#if day.has || selected}
            <a
              class="day-chip {day.weekday}"
              class:selected
              class:present={day.today}
              class:past={day.past}
              href={href({ start: String(day.start) })}
              aria-current={selected ? "date" : undefined}
              aria-label={day.name}
              data-testid="guide-day"
              data-start={day.start}
              >{#if day.today}<span class="today-mark">今日</span
                >{/if}{day.label}</a
            >
          {:else}
            <!-- 番組がまだ届いていない日。並びの幅を保つために置いて、押せなくする -->
            <span
              class="day-chip disabled {day.weekday}"
              title="番組表がまだありません"
              data-testid="guide-day"
              data-start={day.start}
              aria-disabled="true"
              >{day.label}<span class="visually-hidden">
                (番組表なし)</span
              ></span
            >
          {/if}
        {/each}
      </nav>
      <Menu side={menuSide} class="guide-menu" testid="guide-date-menu">
        {#snippet trigger(props)}
          <!-- 日本の番組表の慣習で、1日は4時から翌4時まで (読み上げと title で) -->
          <button
            {...props}
            type="button"
            class="small secondary outline date-label"
            title="{shownDate} (4:00〜翌4:00)"
            data-testid="guide-date">{day}</button
          >
        {/snippet}
        {#each days as day (day.start)}
          {@const selected = day.start === data.start}
          {#if day.has || selected}
            <a
              class="menu-item {day.weekday}"
              class:selected
              class:past={day.past}
              role="menuitem"
              href={href({ start: String(day.start) })}
              aria-current={selected ? "date" : undefined}>{day.name}</a
            >
          {:else}
            <button
              type="button"
              class="menu-item {day.weekday}"
              role="menuitem"
              aria-disabled="true"
              data-disabled
              >{date(day.start)} <span class="muted">番組表なし</span></button
            >
          {/if}
        {/each}
        <hr />
        {@render jumpItems()}
      </Menu>
      <a
        class="button small secondary outline arrow next"
        href={nextHref}
        aria-label="翌日"
        data-testid="next-day"
        bind:this={nextArrow}>→</a
      >
      <!-- 狭い画面だけ。今日を見ているときは出さない (押しても同じ表のまま) -->
      {#if nowSlots === null}
        <a
          class="button small secondary outline today"
          href={href({})}
          data-testid="guide-today">今日</a
        >
      {/if}
    </div>

    <!-- 時刻へ送る (広い画面)。入りきらない幅では右の「⋯」に移す -->
    <div role="group" class="jumps" aria-label="時刻へ移動">
      <button
        type="button"
        class="small secondary outline"
        disabled={nowSlots === null || grid === null}
        title={nowSlots === null ? "今日を見ているときだけ" : "いまの時刻へ"}
        onclick={jumpNow}
        data-testid="guide-jump-now">今</button
      >
      {#each JUMPS as jump (jump.key)}
        <button
          type="button"
          class="small secondary outline"
          disabled={grid === null}
          title={jump.title}
          onclick={() => jumpTo(jump.hour)}
          data-testid="guide-jump-{jump.key}">{jump.label}</button
        >
      {/each}
    </div>
    <div class="more">
      <Menu
        side={menuSide}
        align="end"
        class="guide-menu"
        testid="guide-more-menu"
      >
        {#snippet trigger(props)}
          <button
            {...props}
            type="button"
            class="small secondary outline icon"
            aria-label="時刻へ移動"
            data-testid="guide-more"
          >
            <Icon icon={Ellipsis} size="size-4" />
          </button>
        {/snippet}
        {@render jumpItems()}
      </Menu>
    </div>

    <div class="end">
      <!--
                **サブチャンネルを出すか** (issue #509)。テレビの番組表の「サブチャンネル表示」と同じ。
                見え方の好みなので設定画面ではなくここに置き、端末ごとに覚える。
                入っているかは aria-pressed と地の色で (録画一覧の「まとめて表示」と同じ形)。
                その日に分割放送が無ければ出さない (押しても列が増えない)
            -->
      {#if canSplit}
        <button
          type="button"
          class="small subch {subchannels ? '' : 'secondary outline'}"
          aria-pressed={subchannels}
          title={subchannels
            ? "サブチャンネルを表示中 (押すと隠します)"
            : "サブチャンネルも表示"}
          aria-label="サブチャンネル表示"
          onclick={() => setSubchannels(!subchannels)}
        >
          <!-- 狭い画面では印だけ (字のままだと1行に収まらない)。名前は aria-label で -->
          <span class="icon-only" aria-hidden="true"
            ><Icon icon={Layers} size="size-4" /></span
          >
          <span class="word">サブch</span>
        </button>
      {/if}

      <!--
                **ジャンルの色の見本。** 押すとそのジャンルだけ目立たせる (ほかのマスを淡く)。もう一度押すか
                「すべて」で戻す。見本の色はマスと同じ規則 (`:is(.program, .swatch)[data-genre]`) から
            -->
      <Menu
        side={menuSide}
        align="end"
        class="guide-menu genre-menu"
        testid="guide-genre-menu"
      >
        {#snippet trigger(props)}
          <button
            {...props}
            type="button"
            class="small secondary outline genre-button"
            aria-label={narrow && canSplit
              ? "サブチャンネルとジャンルの色"
              : "ジャンルの色"}
            data-testid="guide-genres"
          >
            {#if highlight !== null}
              <span class="swatch" data-genre={highlight} aria-hidden="true"
              ></span>
            {:else}
              <span class="icon-only" aria-hidden="true">
                <Icon
                  icon={narrow && canSplit ? Ellipsis : Palette}
                  size="size-4"
                />
              </span>
            {/if}
            <span class="word">ジャンル</span>
          </button>
        {/snippet}
        {#if narrow && canSplit}
          <!-- 狭い画面ではサブch もここに入れる (ボタン2つぶんの幅が1行に入らない) -->
          <button
            type="button"
            class="menu-item"
            role="menuitemcheckbox"
            aria-checked={subchannels}
            onclick={() => setSubchannels(!subchannels)}
            data-testid="subch-item"
          >
            <Icon icon={Layers} size="size-4" />サブチャンネルも表示
          </button>
          <hr />
        {/if}
        <button
          type="button"
          class="menu-item"
          role="menuitemradio"
          aria-checked={highlight === null}
          onclick={() => (highlight = null)}
          data-testid="genre-all"
        >
          <span class="swatch all" aria-hidden="true"></span>すべて
        </button>
        {#each GENRES as genre (genre.id)}
          <button
            type="button"
            class="menu-item"
            role="menuitemradio"
            aria-checked={highlight === genre.id}
            onclick={() =>
              (highlight = highlight === genre.id ? null : genre.id)}
            data-testid="genre-{genre.id}"
          >
            <span class="swatch" data-genre={genre.id} aria-hidden="true"
            ></span>{genre.label}
          </button>
        {/each}
      </Menu>
    </div>
  </div>

  {#if services.length === 0}
    <div class="panel empty" data-testid="empty-grid">
      {#if data.typeEmpty}
        <!-- 局がまだ無い。上の案内と同じ文とボタンを、表の場所の真ん中に (上の案内はこのとき出さない) -->
        <ChannelNotice
          kind="all"
          variant="center"
          text={`${SERVICE_TYPE_LABEL[data.type]}のチャンネルがありません。チャンネルスキャンをしてください`}
        />
      {:else}
        <!-- 局はあるが、いま流している番組が無い (番組表を集めている途中など) -->
        <p class="muted">
          {SERVICE_TYPE_LABEL[
            data.type
          ]}の番組表はまだありません。集まるまでお待ちください
        </p>
      {/if}
    </div>
  {:else if sheet !== null && sheet.failed !== null && switching === null}
    <!--
            組めなかった。**骨組みのまま放っておかない** — 読み込み中と区別が
            付かず、いつまでも待たせることになる。本当の理由はサーバのログに出る
        -->
    <div class="panel empty">
      <p class="muted">番組表を読み込めませんでした ({sheet.failed})</p>
      <button type="button" class="small secondary outline" onclick={reload}
        >読み直す</button
      >
    </div>
  {:else}
    <!--
            **見出しの裏を「見えている」に数えない** (`scroll-padding`)。

            局名の行と時刻の列は `sticky` で表の上に重なっている。そのままだと、
            キーボードでマスへ移ったとき (`focus`) や `scrollIntoView` のスクロールが、
            見出しの裏に半分隠れたマスを見えているとみなして動かない (e2e では 3時台に
            翌日の 4:00 のマスを押すと、真ん中が見出しに当たって詳細が開かなかった)
        -->
    <div
      class="grid-box"
      style="scroll-padding: {headHeight}px 0 0 {TIME_COLUMN};"
      use:dragScroll
      bind:this={grid}
      data-testid="guide-grid"
      aria-busy={!showCells || drawing ? "true" : undefined}
    >
      <!--
            **横幅を列の合計にしておく。** 外側の枠が画面の幅のままだと、`sticky` の時刻の列は枠から出られず、
            「画面の幅 − 列の幅」ぶん送ったところで置いていかれた。局が少ないときは min-width で伸ばし、余りは 1fr が分け合う
        -->
      <div
        class="rows"
        style="grid-template-columns: {TIME_COLUMN} repeat({columns.length}, minmax(11rem, 1fr)); grid-template-rows: auto repeat({slots}, {SLOT_HEIGHT}); width: calc({TIME_COLUMN} + {columns.length} * 11rem); min-width: 100%; --now: {elapsedSlots};"
        data-testid="guide-rows"
        data-highlight={highlight}
      >
        <!-- 左上の角。時刻列とチャンネル行の交点で、どちらにも追従させる -->
        <div
          class="corner"
          style="grid-column: 1; grid-row: 1;"
          bind:clientHeight={headHeight}
        ></div>
        {#each columns as service, i (service.id)}
          <div
            class="service"
            style="grid-column: {i + 2}; grid-row: 1;"
            title={headSkeleton ? undefined : service.name}
            data-testid={headSkeleton
              ? "guide-service-skeleton"
              : "guide-service"}
          >
            {#if headSkeleton}
              <!-- 別の放送波へ移る途中。局の並びが届くまで名前は出さない (上の `switching`) -->
              <span class="skeleton-head head-skeleton" aria-hidden="true"
              ></span>
            {:else}
              <!--
                        ロゴを持たない局もあるので、有るものだけ出す。場所は
                        どちらでも空けておく — 局名の頭が列ごとにずれると、
                        横に並べたときにどれがどの局か追いにくい
                    -->
              <ServiceLogo
                id={service.id}
                has={service.has_logo}
                style="display: block; width: 2rem; height: 1.25rem"
                fallback=""
              />
              <!-- テレビに出ている番号。ラベルの形はライブの一覧と同じ (format.ts の channelNumber) -->
              {#if channelNumber(service) !== null}
                <span class="tag ch-number">{channelNumber(service)}</span>
              {/if}
              <span class="truncate broadcast">{service.name}</span>
            {/if}
          </div>
        {/each}

        <!--
                時刻の列。**横にも縦にも追従させる。** 横は列を `sticky` (`left: 0`) に。1時間を1つのグリッド領域にしているので、
                数字は中でもう一段 `sticky` にして、時間の途中まで下ろしても領域の中で下りてくるようにする。
                上端は局名の行のぶんだけ空ける (高さは実測。決め打ちだと1pxずれて数字が見出しの裏へ潜る)
            -->
        {#each hourMarks as mark (mark.at)}
          <div
            class="hour"
            style="grid-column: 1; grid-row: {mark.row} / span {mark.span};"
          >
            <span class="hour-label num" style="top: {headHeight}px;">
              {new Date(mark.at).getHours()}
            </span>
          </div>
        {/each}

        {#if nowSlots !== null}
          <!--
                        「いま」の線 (ホームと同じ `NowLine` の `overlay`)。ホームのような一言は添えない。
                        **時刻は時刻の列の中に置く** — 列の外へ出すと番組名に被る。同じ時の数字とは重なるが、
                        時刻に地の色を敷いて隠す。`sticky` (`left: 0`) で横に流しても左端に残る
                        (`absolute` だと枠 `grid-column: 1 / -1` の左端に付いて流れていく)
                    -->
          <NowLine
            layout="overlay"
            class="now"
            time={time(clock)}
            labelWidth={TIME_COLUMN}
            style="grid-column: 1 / -1; grid-row: 2; translate: 0 calc({nowSlots} * {SLOT_HEIGHT});"
            bind:element={nowMark}
            data-testid="now-line"
          />
        {/if}

        <!--
                    少しずつ足していく (`drawGradually`)。全部出るまで `aria-busy` が付いている。
                    本チャンネルと同じ番組を流しているサブチャンネルの列へは本チャンネルのマスを横に伸ばす (`span`)。
                    分割放送の前後で幅が変わると、同じ番組が上下2つのマスになる (`cell.key`)
                -->
        {#if !showCells}
          <!--
                        **マスのところだけ骨組み。** 局名の行と時刻の列は本物で、骨組みは同じ列 (`subgrid`) に
                        24 時間ぶん敷く — 画面の下の端まで埋まり、どこまで送っても切れない。
                        桝は 1 つずつ置かず、列ごとに 1 枚の板を `mask` で切り抜く (局が多いと数千個になる)
                    -->
          <div
            class="skeleton cells-skeleton"
            style="grid-column: 2 / -1; grid-row: 2 / -1;"
            data-testid="guide-skeleton"
            role="status"
            aria-label="番組表を読み込んでいます"
          >
            {#each columns as service, i (service.id)}
              <div
                class="cells-skeleton-column"
                style:mask-image={skeletonMask(i)}
                aria-hidden="true"
              ></div>
            {/each}
          </div>
        {:else}
          {#each stations as station (station.key)}
            <div
              class="station"
              style="grid-column: {station.first +
                2} / span {station.width}; grid-row: 2 / -1; grid-template-columns: repeat({station.width}, minmax(0, 1fr)); grid-template-rows: repeat({slots}, {SLOT_HEIGHT});"
            >
              {#each station.cells as cell (cell.key)}
                {@const program = cell.program}
                <div
                  class="cell"
                  style={cell.style}
                  data-testid="grid-program"
                  data-program-id={program.id}
                  data-service-id={program.service_id}
                  data-start-at={program.start_at}
                >
                  <!--
                                    マスは上ぞろえ。button は中身を縦中央に置くので、短い番組と
                                    長い番組で開始時刻の高さが揃わず、横に目で追えなかった。
                                    縦の flex にして上から積む (色の決め方は下の `.program`)。
                                    淡くする (ジャンルを1つ目立たせる) のは CSS で決める (`.rows[data-highlight]`)
                                -->
                  <button
                    type="button"
                    class="program"
                    data-state={program.reservation_state}
                    data-genre={program.genres?.[0]}
                    onclick={() => open(program)}
                    data-testid="program-button"
                  >
                    <span class="clamp">
                      <span class="title">
                        <!-- 時は左の時の列にあるので、目に見えるのは分だけ (読み上げには時まで渡す) -->
                        <span class="num"
                          ><span class="visually-hidden"
                            >{time(program.start_at).slice(0, 3)}</span
                          >{time(program.start_at).slice(3)}</span
                        >
                        <span class={program.name ? "broadcast" : "faint"}
                          >{program.name || "(番組情報なし)"}</span
                        >
                        {#if program.copy_never}
                          <!-- 録らない番組。控えめに添えるだけ (理由は詳細で) -->
                          <span class="copy-never" data-testid="grid-copy-never"
                            >コピー禁止</span
                          >
                        {/if}
                      </span>
                      <!-- 予約してあれば説明の代わりに状態。`{#if}` にしないのは、マスごとの描く手間を増やさないため (名前の有無も同じ) -->
                      <span
                        class={program.reservation_state
                          ? "state"
                          : "desc broadcast"}
                        >{program.reservation_state
                          ? stateLabel(program.reservation_state)
                          : program.description}</span
                      >
                    </span>
                  </button>
                </div>
              {/each}
            </div>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>

<!-- 時刻へ送るメニューの項目 (「⋯」と、狭い画面の日付のメニュー) -->
{#snippet jumpItems()}
  {@const off = nowSlots === null || grid === null}
  <button
    type="button"
    class="menu-item"
    role="menuitem"
    aria-disabled={off ? "true" : undefined}
    data-disabled={off ? "" : undefined}
    onclick={() => !off && jumpNow()}
    >今 <span class="muted">{off ? "(今日だけ)" : time(clock)}</span></button
  >
  {#each JUMPS as jump (jump.key)}
    <button
      type="button"
      class="menu-item"
      role="menuitem"
      aria-disabled={grid === null ? "true" : undefined}
      data-disabled={grid === null ? "" : undefined}
      onclick={() => grid !== null && jumpTo(jump.hour)}
      >{jump.label} <span class="muted">{jump.hour}:00</span></button
    >
  {/each}
{/snippet}

<!-- 番組の中身。**二段組の外に置く** (中に入れると巻き取る箱の中で開くことになる) -->
{#if selected && facts}
  {@const program = selected}
  <!-- 録れているなら、録画一覧へ戻らずここからそのまま観られるようにする (一覧の `hasFile` と同じ判定) -->
  {@const canPlay =
    program.recording_id !== null &&
    program.recording_state !== "failed" &&
    (program.library_path ?? program.ts_path) !== null}
  {@const canWatch =
    program.start_at <= clock &&
    program.end_at > clock &&
    watchable.has(program.service_id)}
  {@const canCancel =
    CANCELABLE.includes(program.reservation_state ?? "") &&
    !(program.reservation_state === "skipped" && program.end_at <= clock)}
  {@const canReserve =
    !canCancel &&
    program.reservation_state === null &&
    program.end_at > clock &&
    !program.copy_never}
  <!-- **主は 1 つだけ。** 予約できるなら予約、録れていれば再生、いま流れていれば視聴 -->
  {@const primary = canReserve
    ? "reserve"
    : canPlay
      ? "play"
      : canWatch
        ? "watch"
        : null}
  <ProgramDetail program={facts} onclose={close}>
    {#snippet status()}
      {#if program.reservation_state}
        <span class="tag info" data-testid="detail-state">
          {stateLabel(program.reservation_state)}
        </span>
      {:else if program.end_at <= clock}
        <!--
                    もう終わった番組。予約ボタンを出しても、押した先で
                    「放送が終わっています」と断られるだけ (reservations.reserve)
                -->
        <span class="tag" data-testid="detail-ended">放送終了</span>
      {/if}
    {/snippet}
    {#snippet actions()}
      <!--
                失敗の理由は詳細の中に出す。番組表にインラインで足すと、その分だけ
                グリッドが下にずれてスクロールバーが出る。

                **ここだけ Toasts に寄せていない。** 他の画面の通知は右下に浮かせて
                いるが、押したのはこのモーダルの中のボタンで、モーダルは浮かせた表示より
                上に出る。下に隠れるものを出しても読めないので、押したボタンの隣に置く
            -->
      {#if form?.message}
        <div class="notice error guide-error">{form.message}</div>
      {/if}

      <!--
                **並びは控えから主へ。** 主 (クラスの無いボタン) はいちばん右 (狭い画面ではいちばん上)。
                閉じるは右上の × (`ProgramDetail`)
            -->

      <!--
                **ルールを作る。** 予約・録画の詳細と同じ入口
                (`search/+page.server.ts`。`rule-form.originOf`)。毎回録りたい番組を番組表で
                見つけたとき、検索で探し直さずに済む
            -->
      <a
        class="button secondary"
        href={resolve(`search?from=program:${program.id}`)}
        data-testid="detail-rule"
      >
        ルールを作る
      </a>

      {#if canCancel}
        <!-- 予約したあと番組表から止められないと、わざわざ予約一覧まで行くことになる -->
        <form method="POST" action="?/cancel" use:submitting={closeOnSuccess}>
          <input type="hidden" name="programId" value={program.id} />
          <button
            type="submit"
            class="danger outline"
            data-testid="detail-cancel">予約取消</button
          >
        </form>
      {/if}

      {#if canWatch}
        <!--
                    **いま流れている番組は、その場で観られるようにする** (ライブ画面で同じ局を探し直させない)。
                    **ライブ画面が持っている局にだけ出す** (`watchable`)。マスは名前の無い枠でも出るので、そのまま出すと
                    押した先で別の局が映る (分割放送をしていない間のサブチャンネル)。選局は押した先でやり直すのでリンクにする
                -->
        <a
          class="button"
          class:secondary={primary !== "watch"}
          href={resolve(`live?service=${program.service_id}`)}
          data-testid="detail-watch"
        >
          視聴
        </a>
      {/if}

      {#if canPlay}
        <!-- 録っている最中なら観る画面が追っかけ (`/chase`) へ送る -->
        <a
          class="button"
          class:secondary={primary !== "play"}
          href={resolve(`watch/${program.recording_id}`)}
        >
          再生
        </a>
      {/if}

      {#if canReserve}
        <!--
                    録画のしかたはここでは選ばせない。設定画面の1箇所で決める
                    (同じ選択肢を予約・ルール・設定に並べると、どれで決まったのか
                    分からなくなる)。コピー禁止の番組には出さない — 押しても断るだけ
                    (`reservations.reserve`)。理由は詳細の「コピー禁止」に添えてある
                -->
        <form method="POST" action="?/reserve" use:submitting={closeOnSuccess}>
          <input type="hidden" name="programId" value={program.id} />
          <button type="submit" data-testid="detail-reserve">予約</button>
        </form>
      {/if}
    {/snippet}
  </ProgramDetail>
{/if}

<style>
  /*
     * 外枠と操作の1行の形は `app.css` の `.guide-frame`・`.guide-bar`。
     * 入りきらないぶんは日付の並びが縮んで横に流れ、時刻は「⋯」へ (下の幅ごとの決まり)
     */
  .days {
    display: flex;
    flex: 0 1 auto;
    align-items: center;
    gap: var(--dp-space-1);
    min-width: 0;
  }
  .arrow {
    flex: none;
  }
  /*
     * 日付の並び。**中身の幅だけ取り、入りきらなければ縮んで横に流れる** (流す印は出さない。両端の ← → で送れる)
     */
  .strip {
    display: flex;
    flex: 0 1 auto;
    gap: 2px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .strip::-webkit-scrollbar {
    display: none;
  }
  /*
     * 日付の1つ。ふだんは字だけ (押せることは字の濃さと、指を乗せたときの地で)。
     * **選んでいる日は主の色の下線と字・太字** (ほかの選んでいるものと同じ。塗らない)。土日は土日の字の色のまま
     */
  .day-chip {
    position: relative;
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    min-height: var(--dp-btn-h-sm);
    padding-inline: 0.55rem;
    border-radius: var(--dp-btn-radius);
    color: var(--pico-secondary);
    font-size: var(--dp-text-sm);
    font-variant-numeric: tabular-nums;
    text-decoration: none;
    white-space: nowrap;
  }
  a.day-chip:hover {
    background: var(--dp-btn-tonal);
    color: var(--pico-secondary-hover);
  }
  .day-chip.selected {
    color: var(--dp-primary-text);
    font-weight: var(--dp-weight-bold);
  }
  .day-chip.selected::after {
    content: "";
    position: absolute;
    inset-inline: 0.55rem;
    bottom: 0.2rem;
    height: 2px;
    border-radius: 1px;
    background: var(--pico-primary);
    pointer-events: none;
  }
  /*
     * **今日は日付の前に小さく「今日」** (主の色の字・太字)。選んでいる日の下線とは別の印なので、
     * 前の日を見ているときも今日がどれか分かる
     */
  .today-mark {
    margin-inline-end: 0.3rem;
    color: var(--dp-primary-text);
    font-size: var(--dp-text-xs);
    font-weight: var(--dp-weight-bold);
  }
  /* 前の日は字を控える (土日は土日の色のまま) */
  .past {
    color: var(--dp-muted);
  }
  /*
     * **土日は字の色で。** 土曜は主の色の字、日曜は録画の赤の字 (どちらも淡い地の上で 4.5:1 以上になる段。`app.css`)。
     * 日付のメニューの中も同じ
     */
  .sat {
    color: var(--dp-primary-text);
  }
  .sun {
    color: var(--dp-rec-text);
  }
  a.day-chip.sat:hover,
  .day-chip.selected.sat {
    color: var(--dp-primary-text);
  }
  a.day-chip.sun:hover,
  .day-chip.selected.sun {
    color: var(--dp-rec-text);
  }
  /* 番組表がまだ届いていない日。並びに置くだけで押せない */
  .day-chip.disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  /*
     * 矢印は広い画面では「入りきらないとき」(`crowded`) だけ。
     * 日付のメニューと「今日」は狭い画面だけ
     */
  .days:not(.crowded) :is(.prev, .next),
  .days .date-label,
  .days .today {
    display: none;
  }
  .jumps {
    display: none;
    flex: none;
    width: auto;
  }
  .jumps > button {
    padding-inline: 0.6rem;
  }
  .more {
    flex: none;
  }
  /* 右端に寄せる (サブch・ジャンル) */
  .end {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--dp-space-2);
    margin-inline-start: auto;
  }
  .icon-only {
    display: none;
  }
  .genre-button {
    gap: 0.4rem;
  }
  /* 時刻のボタンが入る幅。サブch が出ていても 1180px で1行に収まる (実測は PR に) */
  @media (min-width: 1180px) {
    .jumps {
      display: flex;
    }
    .more {
      display: none;
    }
  }
  /*
     * **狭い画面は表の下に置く** (下のタブのすぐ上。親指が届く)。中身は ← 日付 → (日付を押すと1週間ぶんと時刻) と、
     * 印だけのボタン1つ (ジャンル。サブch があればそれも中に)。日付の並びと時刻のボタンは出さない (日付のメニューに入っている)。
     * それでも入りきらない幅 (360px で今日以外を見ているとき) は横に流す
     */
  @media (max-width: 767px) {
    .toolbar {
      gap: var(--dp-space-1);
      overflow-x: auto;
      scrollbar-width: none;
    }
    .days > a.button,
    .date-label {
      padding-inline: 0.4rem;
    }
    /* サブch はジャンルのメニューに入れる (2つ並べると、今日以外を見ているときに 390px で入りきらない) */
    .strip,
    .more,
    .word,
    .subch {
      display: none;
    }
    .toolbar .days .prev,
    .toolbar .days .next,
    .toolbar .days .date-label,
    .toolbar .days .today {
      display: inline-flex;
    }
    .icon-only {
      display: inline-flex;
    }
    .end {
      gap: var(--dp-space-1);
    }
    .end > button {
      width: var(--dp-btn-h-sm);
      padding-inline: 0;
    }
  }
  /* メニュー (枠は `Menu` の中なので :global)。日付・時刻・ジャンルで共通 */
  :global(.guide-menu) {
    width: max-content;
    min-width: 11rem;
    max-width: calc(100vw - 1rem);
  }
  /* 「ドキュメンタリー／教養」も1行で (狭い画面で幅を詰められて、名前が3行に割れていた) */
  :global(.guide-menu) .menu-item {
    white-space: nowrap;
  }
  :global(.guide-menu) .menu-item.selected {
    font-weight: var(--dp-weight-bold);
  }
  /* 入っている項目は塗らず、ほかのメニューの選んでいる項目と同じく左の縦線と主の色の太字 */
  :global(.guide-menu) .menu-item[aria-checked="true"] {
    box-shadow: inset 2px 0 0 var(--pico-primary);
    color: var(--dp-primary-text);
    font-weight: var(--dp-weight-bold);
  }
  .menu-item .muted {
    margin-inline-start: auto;
  }
  /*
     * ジャンルの見本。**マスの時刻の前の点と同じ** (色は下の `:is(.program, .swatch)[data-genre]` からマスと同じ値を受ける)。
     * 「すべて」は色の無い点
     */
  .swatch {
    --tint: var(--dp-line-strong);
    flex: none;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--tint);
  }
  .empty {
    margin: var(--dp-gutter);
    padding: 1.5rem;
    text-align: center;
  }

  /* 表は枠で囲まない。操作の1行の下から画面の端まで (上のコメント)。地はページの地のまま (マスだけが面) */
  .grid-box {
    flex: 1 1 0%;
    min-height: 0;
    overflow: auto;
    cursor: grab;
    background: var(--dp-bg);
  }
  /*
     * **Pico の回るもの (`[aria-busy]::before`) は出さない。** 表の頭に 1 行ぶん差し込まれ、
     * マスを待つ間だけ表が下にずれて、届いた瞬間に跳ねていた。待っていることは骨組みで見せる
     */
  .grid-box[aria-busy="true"]::before {
    display: none;
  }
  .grid-box:active {
    cursor: grabbing;
  }
  .rows {
    display: grid;
  }
  /*
     * **局名の行と時の列は操作の層。** 表を巻くとマスがその裏を流れるので、ヘッダーと同じ半透明の面 (`--dp-float`) と影で浮かせる
     * (docs/design.md の「浮かせ方」)。線は引かない。影はマスの側にだけ落とす (行は下、列は右。隣の局名の上に重ねない)
     */
  .corner,
  .service,
  .hour {
    background: var(--dp-float);
    box-shadow: var(--dp-shadow-pop);
  }
  .service {
    clip-path: inset(0 0 -1.5rem 0);
  }
  .hour {
    clip-path: inset(0 -1.5rem 0 0);
  }
  .corner {
    clip-path: inset(0 -1.5rem -1.5rem 0);
  }
  @media (prefers-reduced-transparency: reduce) {
    .corner,
    .service,
    .hour {
      background: var(--dp-pop);
    }
  }
  .corner {
    position: sticky;
    top: 0;
    left: 0;
    z-index: 30;
  }
  .service {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    overflow: hidden;
    white-space: nowrap;
    padding: 0.5rem;
    font-size: 0.875rem;
    /* 行の高さ (= 時刻の数字が止まる位置 headHeight) は 36px */
    line-height: 1.25rem;
    font-weight: var(--dp-weight);
  }
  .ch-number {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
  .hour {
    position: sticky;
    left: 0;
    z-index: 10;
    padding-inline: 0.25rem;
    font-size: 0.75rem;
    /* 数字の行の高さは 1rem に揃える。高いと、前の時間の数字が枠の下に残って次の時間の数字と並んで見える */
    line-height: 1rem;
  }
  .hour-label {
    position: sticky;
    display: block;
  }
  /* 「いま」の時刻 (`NowLine`)。時の列 (`.hour`) より上に。1 分ごとの移りを飛ばさずに (上の `nowSlots`) */
  .rows :global(.now) {
    z-index: 10;
    transition: translate var(--dp-duration) var(--dp-ease);
  }
  /*
     * マスのところの骨組み。列は表と同じ (`subgrid`)。光の筋は `app.css` の `.skeleton`。
     * 時刻の列・局名の行・いまの線は `z-index` を持つので、この上に重なる
     */
  .cells-skeleton {
    display: grid;
    grid-template-columns: subgrid;
  }
  .cells-skeleton-column {
    margin-inline: 0.125rem;
    background: var(--dp-subtle);
  }
  /* 別の放送波へ移る途中の局名 (高さは局名の字の行と同じ) */
  .head-skeleton {
    display: block;
    width: 70%;
    height: 1.25rem;
  }
  /*
     * 局ごとの箱 (上の `stations`)。横に外れた局は箱ごと飛ばす。
     * 大きさは外の表の track で決まる (`contain-intrinsic-size` は中身を組まないときの仮の値)
     */
  .station {
    display: grid;
    content-visibility: auto;
    contain-intrinsic-size: auto 11rem auto 216rem;
  }
  /*
     * **画面の外のマスは中身を組まない** (`content-visibility: auto`)。BS 60 局・2,171 マスで、マスを足すたびの
     * Layout が 1 回 450ms × 7 回かかり、描き終わりまで 12 秒だった (付けて 3.4 秒)。
     * 大きさは grid の track で決まるので、中身を組まなくてもマスの場所は変わらない
     * (`contain-intrinsic-size` は中身が無いときの仮の大きさ)
     */
  .cell {
    overflow: hidden;
    padding: 0.125rem;
    content-visibility: auto;
    contain-intrinsic-size: auto 11rem auto 0.75rem;
  }
  /*
     * 色はジャンル(大分類)ごと。**色は時刻の前の小さな点で見せ、下地はごく淡く敷くだけ。**
     * 左の太い線は使わない (左の縦線は「選んでいる」の印。docs/design.md の「印の意味」)。
     * 下地を 15% 塗っていた頃は、明るいテーマでマスが桃色や水色のブロックになり、
     * 上に乗る小さい字が地に溶けて読みにくかった。下地は地の色 (--dp-surface) に
     * ジャンルの色を少しだけ混ぜる。暗いテーマは混ぜても沈みやすいので少し多めにする。
     * 字は本文と同じ濃さのまま。
     *
     * 予約の状態は枠や塗りではなく、説明の代わりに出す状態の言葉 (`.state`) と印で示す。
     * 塗るのはいま動いている録画中だけ (録画の赤をごく淡く)
     */
  .program {
    --tint: var(--dp-line);
    --wash: 10%;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    height: 100%;
    width: 100%;
    overflow: hidden;
    margin: 0;
    padding: 0.125rem 0.25rem;
    border: 0;
    border-radius: var(--dp-radius-sm);
    background: var(--dp-subtle);
    color: inherit;
    text-align: left;
    font-weight: var(--dp-weight);
    line-height: normal;
  }
  /*
     * **放送が過ぎた所は、マスの上から暗くしていく** (赤い線を表に引く代わり)。終わった番組はマス全体、放送中の番組は頭からいまの位置まで。
     * 割合は表の `--now` とマスの `--s` / `--e` から CSS だけで出す (毎分書き直すのは表の 1 つだけ)。
     * 覆いは字の下に敷く (`isolation` の中で `z-index: -1`)。字は読めたまま、面だけが沈む
     */
  .program {
    position: relative;
    isolation: isolate;
  }
  .program::before {
    /* 長さ 0 の番組で 0 で割らないよう、分母に下限を置く */
    --past: clamp(
      0,
      (var(--now) - var(--s)) / max(var(--e) - var(--s), 0.001),
      1
    );
    content: "";
    position: absolute;
    inset: 0 0 auto;
    z-index: -1;
    height: calc(var(--past) * 100%);
    border-radius: inherit;
    background: color-mix(in srgb, var(--dp-bg) 78%, transparent);
    pointer-events: none;
    transition: height var(--dp-duration-move) var(--dp-ease);
  }
  :global([data-theme="dark"]) :is(.program, .swatch) {
    --wash: 14%;
  }
  .program:hover {
    background: var(--dp-hover);
  }
  .program[data-genre] {
    background: color-mix(in srgb, var(--tint) var(--wash), var(--dp-surface));
  }
  .program[data-genre]:hover {
    background: color-mix(
      in srgb,
      var(--tint) calc(var(--wash) + 10%),
      var(--dp-surface)
    );
  }
  /*
     * ジャンルの色は **色みだけを変えて、濃さと鮮やかさは全部同じ** にする
     * (hsl の S と L を固定)。集めてきた色を12個並べていた頃は、黄色のマスだけが
     * 前に出て紺色のマスが沈み、番組表を眺めると明るいマスに目が吸われていた。
     * 濃さが揃っていれば、色は「種類が違う」ことだけを伝える。
     * ジャンルの見本 (`.swatch`) も同じ規則で受ける (値を2か所に書かない)
     */
  :is(.program, .swatch)[data-genre="0"] {
    --tint: hsl(210 62% 55%);
  } /* ニュース/報道 */
  :is(.program, .swatch)[data-genre="1"] {
    --tint: hsl(145 62% 55%);
  } /* スポーツ */
  :is(.program, .swatch)[data-genre="2"] {
    --tint: hsl(190 62% 55%);
  } /* 情報/ワイドショー */
  :is(.program, .swatch)[data-genre="3"] {
    --tint: hsl(350 62% 55%);
  } /* ドラマ */
  :is(.program, .swatch)[data-genre="4"] {
    --tint: hsl(280 62% 55%);
  } /* 音楽 */
  :is(.program, .swatch)[data-genre="5"] {
    --tint: hsl(25 62% 55%);
  } /* バラエティ */
  :is(.program, .swatch)[data-genre="6"] {
    --tint: hsl(250 62% 55%);
  } /* 映画 */
  :is(.program, .swatch)[data-genre="7"] {
    --tint: hsl(310 62% 55%);
  } /* アニメ/特撮 */
  :is(.program, .swatch)[data-genre="8"] {
    --tint: hsl(45 62% 55%);
  } /* ドキュメンタリー/教養 */
  :is(.program, .swatch)[data-genre="9"] {
    --tint: hsl(325 62% 55%);
  } /* 劇場/公演 */
  :is(.program, .swatch)[data-genre="10"] {
    --tint: hsl(95 62% 55%);
  } /* 趣味/教育 */
  :is(.program, .swatch)[data-genre="11"] {
    --tint: hsl(170 62% 55%);
  } /* 福祉 */
  /*
     * ジャンルを1つ目立たせているときの、ほかのマス (`highlight`)。押せるまま淡くするだけ。
     * **表の側の印 (`data-highlight`) と CSS で決める** — マスごとに持たせると、切り替えるたびに全部のマスを書き直す
     */
  .rows[data-highlight="0"] .program:not([data-genre="0"]),
  .rows[data-highlight="1"] .program:not([data-genre="1"]),
  .rows[data-highlight="2"] .program:not([data-genre="2"]),
  .rows[data-highlight="3"] .program:not([data-genre="3"]),
  .rows[data-highlight="4"] .program:not([data-genre="4"]),
  .rows[data-highlight="5"] .program:not([data-genre="5"]),
  .rows[data-highlight="6"] .program:not([data-genre="6"]),
  .rows[data-highlight="7"] .program:not([data-genre="7"]),
  .rows[data-highlight="8"] .program:not([data-genre="8"]),
  .rows[data-highlight="9"] .program:not([data-genre="9"]),
  .rows[data-highlight="10"] .program:not([data-genre="10"]),
  .rows[data-highlight="11"] .program:not([data-genre="11"]) {
    opacity: 0.3;
  }
  /*
     * **録画中だけ、地を録画の赤でごく淡く塗る** (いま動いているもの。`app.css` の色の決まり)。
     * 予約済み・競合は塗らず枠も引かず、状態の言葉 (`.state`) とその前の印で示す
     */
  .program[data-state="recording"] {
    background: color-mix(
      in srgb,
      var(--dp-rec) calc(var(--wash) + 6%),
      var(--dp-surface)
    );
  }
  .program[data-state="recording"]:hover {
    background: color-mix(
      in srgb,
      var(--dp-rec) calc(var(--wash) + 14%),
      var(--dp-surface)
    );
  }
  /* ジャンルの点。時刻の前に置く (色は上の `[data-genre]` の `--tint`) */
  .program[data-genre] .num::before {
    content: "";
    display: inline-block;
    width: 0.4375rem;
    height: 0.4375rem;
    margin-inline-end: 0.25rem;
    border-radius: 50%;
    background: var(--tint);
    vertical-align: 0.0625rem;
  }
  /*
     * **字は行の切れ目で止める。** マスの高さで切ると、最後の行が上半分だけ見えていた。
     * 番組名と説明 (または予約の状態) をまとめて数え、入る行数 (`lines()`) の最後の行を「…」で終える
     */
  .clamp {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: var(--lines);
    line-clamp: var(--lines);
    overflow: hidden;
  }
  .title,
  .state,
  .desc {
    display: block;
    font-size: 0.75rem;
    line-height: 1.25;
    font-weight: var(--dp-weight);
  }
  /*
     * 予約の状態。説明の代わりに太字で出す。印は時刻のすぐ後ろに添える (色だけに頼らない。説明の行が切れる短いマスでも見える):
     * 予約済みは主の色の ✓、録画中は録画の赤の ●、競合は赤い ⚠ (一覧の競合と同じ印)。
     * **競合は予約済みと同じ青にしない** — 青だと「録れる」に見え、チューナーが足りずに落ちる番組を見落とす
     */
  .state {
    font-weight: var(--dp-weight-bold);
    color: var(--dp-primary-text);
  }
  .program:is([data-state="recording"], [data-state="conflict"]) .state {
    color: var(--dp-rec-text);
  }
  .program[data-state="scheduled"] .num::after,
  .program[data-state="recording"] .num::after,
  .program[data-state="conflict"] .num::after {
    margin-inline-start: 0.25rem;
    color: var(--dp-primary-text);
    font-weight: var(--dp-weight-bold);
  }
  .program[data-state="scheduled"] .num::after {
    content: "✓";
  }
  .program[data-state="recording"] .num::after {
    content: "●";
    color: var(--dp-rec-text);
  }
  .program[data-state="conflict"] .num::after {
    content: "⚠";
    color: var(--dp-rec-text);
  }
  /*
     * **録らないと決めた予約 (コピー禁止) は予約済みの青にしない** — 青だと「録れる」に見える。
     * 待っているだけで手を止めてほしいものでもないので、字を控えるだけにする
     */
  .program[data-state="skipped"] .state {
    color: inherit;
    opacity: 0.8;
  }
  .copy-never {
    font-size: 0.625rem;
    font-weight: var(--dp-weight);
    opacity: 0.7;
    white-space: nowrap;
  }
  /* 説明は番組名より一段だけ控える。0.6 まで落とすと淡い下地の上で字が溶けた */
  .desc {
    opacity: 0.8;
  }
  /* 押すものの並び (`.modal-actions`) の中で、1行まるごと使う */
  .guide-error {
    flex-basis: 100%;
    margin: 0;
  }
</style>
