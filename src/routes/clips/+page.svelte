<script lang="ts">
  import { goto, invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { untrack } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import ListFilter from "~icons/lucide/list-filter";

  import { arming } from "#lib/arming.svelte.js";
  import {
    type Clip,
    CLIP_LAYERS,
    type ClipKind,
    type ClipLayer,
    type ClipLayers,
    type ClipQuery,
    clipSearch,
    clipVersionQuery,
  } from "#lib/clips.js";
  import HomeCalendar from "#lib/components/home/HomeCalendar.svelte";
  import Menu from "#lib/components/Menu.svelte";
  import ControlBar from "#lib/components/player/ControlBar.svelte";
  import ControlButton from "#lib/components/player/ControlButton.svelte";
  import Icon from "#lib/components/player/Icon.svelte";
  import {
    CAPTION,
    CHECK,
    CLOSE,
    COPY,
    DOWNLOAD,
    JIKKYO,
    OVERLAY,
    OVERLAY_BTN,
    OVERLAY_ROUND,
    PLAY,
    TRASH,
  } from "#lib/components/player/icons.js";
  import { SAVED_MS } from "#lib/components/player/shot.svelte.js";
  import {
    canCopyImage,
    copyImage,
    keepOnDevice,
    pngFromImage,
    shotName,
  } from "#lib/components/player/snapshot.js";
  import Toasts, { type Notice } from "#lib/components/Toasts.svelte";
  import { dateTime, fullDate, size, time } from "#lib/format.js";
  import { liveUpdates } from "#lib/live-updates.svelte.js";
  import { sentinel } from "#lib/paging.svelte.js";
  import { dayName, dayStart } from "#lib/timeline.js";

  /**
   * **切り抜き** (`/clips`)。観る画面・追っかけ・ライブで押した 1 コマ (字幕・コメントごと) を、撮った日の見出しの下に平らなグリッドで並べる。
   *
   * - 条件は URL で持つ (`GET /api/clips` と同じ名前。`#lib/clips.ts`)。最初の 60 枚は load、続きは下端で API から足す
   * - 広い形は右のサイドバーにカレンダー・ライブか録画か・局・使っている量。スマホの形は下のタブのすぐ上に
   *   「絞り込み」のメニュー。言葉で探すのはヘッダーの検索で、その結果の「切り抜き」から `?q=` 付きで来たときは
   *   一覧の上に探した言葉と外すボタンを出す
   * - 1 枚を開くと一覧の上に浮かぶ箱。右端の縦の列に閉じる・この場面から観る・字幕とコメントの出し入れ (撮ったときに出していたものだけ)・
   *   クリップボードにコピー・端末に保存・削除 (2 回押し。いちばん下)。
   *   列は観る画面と同じ部品 (`ControlBar`・`ControlButton`)
   * - 選び方は写真のサービスと同じ。マウスでは乗せた 1 枚の左上に丸が出て、押すと選ぶ形に入る。指の端末は長押しで入る。
   *   選ぶ形の間は 1 枚を押すと選ぶ・外す (開かない)。Shift を押しながらなら、前に押した 1 枚までをまとめて選ぶ。
   *   選んだぶんは 2 回押しで消す。Esc か「選択をやめる」で抜け、全部外しても抜ける
   */
  let { data } = $props();

  // 切り抜きが増えた・消えた・切り替えたら読み直す (`api/events` の `clips`)
  liveUpdates(["clips"]);

  /**
   * 下端で足した続き。load が回り直したら最初から作り直す。**条件が変わったときだけ捨てる**。
   * ほかの端末で撮った・消した (`clips` の通知) ときは、読み進めていたぶんまで取り直して、位置を引き戻さない
   */
  let more = $state<Clip[]>([]);
  // svelte-ignore state_referenced_locally
  let next = $state<number | null>(data.next);
  /** 読み直しの世代。古い世代で取った続きは足さない (取っている間に読み直したとき) */
  let generation = 0;
  let shownQuery = "";
  $effect(() => {
    void data.clips;
    const query = String(clipSearch(data.query));
    const keep = query === shownQuery ? untrack(() => more.length) : 0;
    shownQuery = query;
    generation++;
    more = [];
    next = data.next;
    if (keep > 0) untrack(() => void refill(keep));
  });
  const clips = $derived([...data.clips, ...more]);

  /** 続きを 1 ページ取る。世代が替わっていたら捨てる */
  async function fetchMore(): Promise<boolean> {
    if (next === null) return false;
    const mine = generation;
    const params = clipSearch(data.query);
    params.set("before", String(next));
    const res = await fetch(`${resolve("api/clips")}?${params}`);
    if (!res.ok || mine !== generation) return false;
    const body = (await res.json()) as {
      clips: Clip[];
      next: number | null;
    };
    if (mine !== generation) return false;
    more = [...more, ...body.clips];
    next = body.next;
    return true;
  }

  let loading = false;
  async function loadMore(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      await fetchMore();
    } finally {
      loading = false;
    }
  }

  /** 読み直したあと、読み進めていたぶん (`count` 枚) まで続きを取り直す */
  async function refill(count: number): Promise<void> {
    loading = true;
    try {
      while (more.length < count && (await fetchMore()));
    } finally {
      loading = false;
    }
  }

  /** 撮った日ごとに分ける (新しい順のまま) */
  const days = $derived.by(() => {
    const out: { day: number; clips: Clip[] }[] = [];
    for (const clip of clips) {
      const day = dayStart(clip.takenAt);
      const last = out.at(-1);
      if (last?.day === day) last.clips.push(clip);
      else out.push({ day, clips: [clip] });
    }
    return out;
  });
  const now = Date.now();
  function dayLabel(day: number): string {
    return dayName(day, now) ?? fullDate(day);
  }

  /** 条件を替える。URL を書き換えて load を回し直す (戻るボタンの履歴は積まない) */
  function apply(change: {
    [K in keyof ClipQuery]?: ClipQuery[K] | undefined;
  }): void {
    const merged: Record<string, unknown> = { ...data.query, ...change };
    for (const [key, value] of Object.entries(merged))
      if (value === undefined) delete merged[key];
    const params = clipSearch(merged as ClipQuery);
    void goto(`${resolve("clips")}${params.size === 0 ? "" : `?${params}`}`, {
      replace: true,
      // 読んでいる位置はそのまま
      reset: false,
    });
  }

  /** `YYYY-MM-DD` ⇔ その日の 0 時 (端末の時計) */
  function dayOf(key: string): number {
    const [y, m, d] = key.split("-").map(Number) as [number, number, number];
    return new Date(y, m - 1, d).getTime();
  }
  function keyOf(day: number): string {
    const d = new Date(day);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const marks = $derived(
    new Map(data.facets.days.map(({ day, count }) => [dayOf(day), count])),
  );
  const picked = $derived(
    data.query.day === undefined ? null : dayOf(data.query.day),
  );
  /** 日を押した。選んでいる日をもう一度押せば外す */
  function pickDay(day: number): void {
    apply({ day: day === picked ? undefined : keyOf(day) });
  }
  function describeDay(day: number): string {
    const d = new Date(day);
    const count = marks.get(day) ?? 0;
    return `${d.getMonth() + 1}月${d.getDate()}日、${count === 0 ? "なし" : `切り抜き ${count} 枚`}`;
  }

  const KINDS: { id: ClipKind | undefined; label: string }[] = [
    { id: undefined, label: "すべて" },
    { id: "live", label: "ライブ" },
    { id: "recorded", label: "録画" },
  ];
  const filtered = $derived(
    data.query.q !== undefined ||
      data.query.service !== undefined ||
      data.query.day !== undefined ||
      data.query.kind !== undefined ||
      data.query.recording !== undefined,
  );

  /*
   * ---- 1 枚を開く ----
   */
  let dialog = $state<HTMLDialogElement>();
  let viewing = $state<Clip | null>(null);
  function open(clip: Clip): void {
    viewing = clip;
    if (dialog !== undefined && !dialog.open) dialog.showModal();
  }
  function close(): void {
    dialog?.close();
  }
  /** ← → で前後の 1 枚へ (並びの順。左が新しい) */
  function step(by: number): void {
    if (viewing === null) return;
    const index = clips.findIndex((clip) => clip.id === viewing?.id);
    const to = clips[index + by];
    if (to !== undefined) viewing = to;
  }
  function onviewerkey(event: KeyboardEvent): void {
    if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowRight") step(1);
  }
  /** 「この場面から観る」の行き先。録画が無い (ライブで録っていなかった・消した)・番組を引けなかったものは無し */
  function sceneHref(clip: Clip): string | null {
    if (clip.recordingId === null || clip.offsetMs === null) return null;
    return `${resolve(`watch/${clip.recordingId}`)}?at=${Math.max(0, clip.offsetMs / 1000).toFixed(1)}`;
  }
  function title(clip: Clip): string {
    return clip.programName || clip.serviceName || "切り抜き";
  }

  let notice = $state<Notice | null>(null);
  const notices = $derived(notice === null ? [] : [notice]);

  /**
   * いま見せている重ねの 1 枚 (サーバが重ねた AVIF)。出し入れを送っている途中なら、済むのを待ってから取る
   * (先に取ると、押す前の重ねの画像が来る)
   */
  async function shownImage(clip: Clip): Promise<Blob> {
    await sending.get(clip.id);
    const shown = { layers: layersShown(clip) };
    const res = await fetch(
      `${resolve(`api/clips/${clip.id}/image`)}${clipVersionQuery(shown)}`,
    );
    if (!res.ok) throw new Error(String(res.status));
    return res.blob();
  }

  /**
   * 「クリップボードにコピー」を出すか。画像を置けるブラウザなら指の端末にも出す。撮ったときに PC でだけコピーするのは
   * 押した人に聞かずに置くからで (`shot.svelte.ts`)、このボタンは置きたい人が押すもの
   */
  const copyable = canCopyImage();
  /** コピーできた直後の 1 枚 (ボタンを一瞬チェックの形にする。長さは撮るボタンと同じ) */
  let copiedId = $state<number | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * いま見せている重ねの 1 枚を PNG にしてクリップボードに置く (置けるのは PNG だけ)。
   * Safari は押した直後の `clipboard.write` しか通さないので、画像を取る前に書き始め、中身は後から渡す。
   * うまくいったときはこの画面の保存・削除と同じくトーストを出さず (ボタンがチェックになるだけ)、失敗だけ通知する
   */
  function copy(clip: Clip): void {
    void copyImage(shownImage(clip).then(pngFromImage)).then((ok) => {
      if (ok) {
        copiedId = clip.id;
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => (copiedId = null), SAVED_MS);
        return;
      }
      notice = {
        key: `clip-copy-${Date.now()}`,
        kind: "error",
        text: "コピーできませんでした",
      };
    });
  }

  /**
   * 端末に保存 (指の端末は共有シート、PC はファイル)。名前は `番組名_YYYYMMDD-HHMMSS.avif`。
   * 保存するのはいま見せている重ねの AVIF (`shownImage`)
   */
  async function save(clip: Clip): Promise<void> {
    try {
      await keepOnDevice(
        await shownImage(clip),
        shotName(title(clip), new Date(clip.takenAt), "avif"),
      );
    } catch {
      notice = {
        key: `clip-save-${Date.now()}`,
        kind: "error",
        text: "画像を取得できませんでした",
      };
    }
  }

  /**
   * 字幕・コメントの出し入れ。開いた 1 枚は元の画像 (`/layer/*`) を重ねて見せているので、**見せ方はすぐ替える**
   * (`shownLayers`)。残すのは `PATCH /api/clips/<id>` で、サーバが一覧・保存用の AVIF を重ね直す (1 秒ほど) のは待たない。
   * 送るのは 1 枚ごとに順に (押した順にサーバへ届く)。断られたらその切り替えを戻して知らせる。
   * 送り終えたら読み直し、一覧の小さい画像も新しい重ね (`?v=`) にする
   */
  const shownLayers = new SvelteMap<number, ClipLayers>();
  /** 1 枚ごとの送っている途中の列 (済めば消す)。保存はこれを待つ */
  const sending = new Map<number, Promise<void>>();
  function layersShown(clip: Clip): ClipLayers {
    return shownLayers.get(clip.id) ?? clip.layers;
  }
  function toggleLayer(clip: Clip, layer: ClipLayer): void {
    const on = layersShown(clip)[layer] !== true;
    shownLayers.set(clip.id, { ...layersShown(clip), [layer]: on });
    const task = (sending.get(clip.id) ?? Promise.resolve())
      .then(async () => {
        const res = await fetch(resolve(`api/clips/${clip.id}`), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ [layer]: on }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const changed = (await res.json()) as Clip;
        if (viewing?.id === changed.id) viewing = changed;
      })
      .catch(() => {
        // 後から押し直していなければ戻す
        const now = shownLayers.get(clip.id);
        if (now?.[layer] === on)
          shownLayers.set(clip.id, { ...now, [layer]: !on });
        notice = {
          key: `clip-layer-${Date.now()}`,
          kind: "error",
          text: `${layer === "captions" ? "字幕" : "コメント"}の表示を切り替えられませんでした`,
        };
      });
    sending.set(clip.id, task);
    void task.then(async () => {
      if (sending.get(clip.id) !== task) return; // 後に続きが並んでいる
      sending.delete(clip.id);
      try {
        await invalidateAll();
      } finally {
        if (!sending.has(clip.id)) shownLayers.delete(clip.id);
      }
    });
  }

  const deleting = arming('[data-testid^="clip-delete"]');
  async function remove(ids: number[]): Promise<void> {
    deleting.fire();
    const res = await fetch(`${resolve("api/clips")}?ids=${ids.join(",")}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      notice = {
        key: `clip-delete-${Date.now()}`,
        kind: "error",
        text: "削除できませんでした",
      };
      return;
    }
    if (viewing !== null && ids.includes(viewing.id)) close();
    endSelecting();
    await invalidateAll();
  }

  /*
   * ---- 選ぶ (写真のサービスと同じ形) ----
   */
  const selected = new SvelteSet<number>();
  /** 選ぶ形。1 枚でも選んでいる間だけ (全部外したら抜ける) */
  const selecting = $derived(selected.size > 0);
  /** Shift でまとめて選ぶときの起点 (最後に押した 1 枚) */
  let anchor: number | null = null;
  function endSelecting(): void {
    selected.clear();
    anchor = null;
    deleting.fire();
  }
  // 読み直して並びから無くなったもの (ほかの端末で消した・条件を替えた) は、選んだぶんから外す
  $effect(() => {
    const shown = new Set(clips.map((clip) => clip.id));
    for (const id of untrack(() => [...selected]))
      if (!shown.has(id)) selected.delete(id);
  });
  /** 1 枚を選ぶ・外す。Shift を押していれば、起点からその 1 枚までを選ぶ (並びの順) */
  function pick(clip: Clip, event: MouseEvent): void {
    const from =
      event.shiftKey && anchor !== null
        ? clips.findIndex((c) => c.id === anchor)
        : -1;
    if (from >= 0) {
      const to = clips.findIndex((c) => c.id === clip.id);
      const [lo, hi] = from < to ? [from, to] : [to, from];
      for (const c of clips.slice(lo, hi + 1)) selected.add(c.id);
    } else if (selected.has(clip.id)) selected.delete(clip.id);
    else selected.add(clip.id);
    anchor = clip.id;
  }
  function press(clip: Clip, event: MouseEvent): void {
    // 長押しで選んだあとの押し (指を離したときの click) は、もう選んだので何もしない
    if (held) {
      held = false;
      return;
    }
    if (selecting) pick(clip, event);
    else open(clip);
  }
  /** Esc で選ぶ形を抜ける (1 枚を開いている間はダイアログが閉じるほう) */
  function onkey(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !selecting || dialog?.open === true) return;
    event.preventDefault();
    endSelecting();
  }

  /**
   * 指の端末は長押しで選ぶ (乗せる操作が無く、左上の丸が出ないので)。長さは OS の長押しと同じくらい
   * (Android の既定は 400〜500ms)。指が動いた (巻いている) ら取りやめる
   */
  const HOLD_MS = 500;
  /** これより動いたら長押しではない (px) */
  const HOLD_SLOP = 10;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let held = false;
  let holdFrom = { x: 0, y: 0 };
  function onholdstart(clip: Clip, event: PointerEvent): void {
    held = false;
    clearTimeout(hold);
    hold = undefined;
    if (event.pointerType === "mouse") return;
    holdFrom = { x: event.clientX, y: event.clientY };
    hold = setTimeout(() => {
      held = true;
      selected.add(clip.id);
      anchor = clip.id;
    }, HOLD_MS);
  }
  function onholdmove(event: PointerEvent): void {
    if (
      Math.hypot(event.clientX - holdFrom.x, event.clientY - holdFrom.y) >
      HOLD_SLOP
    )
      onholdend();
  }
  function onholdend(): void {
    clearTimeout(hold);
    hold = undefined;
  }
  /** まとめて消すボタンの確認の id (1 つだけなので 0) */
  const MANY = 0;

  let filterOpen = $state(false);
</script>

<svelte:head><title>切り抜き - denpa</title></svelte:head>
<svelte:window onclick={deleting.stand} onkeydown={onkey} />

{#snippet kinds(done?: () => void)}
  {#each KINDS as kind (kind.label)}
    <button
      type="button"
      class="side-item"
      aria-pressed={data.query.kind === kind.id}
      onclick={() => {
        apply({ kind: kind.id });
        done?.();
      }}
      data-testid="clip-kind"
      data-kind={kind.id ?? "all"}>{kind.label}</button
    >
  {/each}
{/snippet}

{#snippet services(done?: () => void)}
  <button
    type="button"
    class="side-item"
    aria-pressed={data.query.service === undefined}
    onclick={() => {
      apply({ service: undefined });
      done?.();
    }}
    data-testid="clip-service"
  >
    <span>すべての局</span>
    <span class="side-sub num">{data.facets.count}</span>
  </button>
  {#each data.facets.services as service (service.id)}
    <button
      type="button"
      class="side-item"
      aria-pressed={data.query.service === service.id}
      onclick={() => {
        apply({ service: service.id });
        done?.();
      }}
      data-testid="clip-service"
      data-service={service.id}
    >
      <span class="truncate broadcast">{service.name || "局名なし"}</span>
      <span class="side-sub num">{service.count}</span>
    </button>
  {/each}
{/snippet}

<!-- 選ぶ形の間だけ、選んだ数と 2 回押しの削除 -->
{#snippet selectTools()}
  <span class="small num c-picked" data-testid="clip-picked"
    >{selected.size} 枚を選択中</span
  >
  {#if deleting.armed === MANY}
    <button
      type="button"
      class="danger small"
      onclick={() => void remove([...selected])}
      data-testid="clip-delete-many-confirm">削除を確定</button
    >
  {:else}
    <button
      type="button"
      class="outline danger small"
      onclick={() => deleting.arm(MANY)}
      data-testid="clip-delete-many">削除</button
    >
  {/if}
  <button
    type="button"
    class="ghost small"
    onclick={endSelecting}
    data-testid="clip-select-end">選択をやめる</button
  >
{/snippet}

<div class="clips" data-testid="clips">
  <Toasts {notices} ondismiss={() => (notice = null)} />
  <h1 class="visually-hidden">切り抜き</h1>

  <div class="c-main with-side">
    <section class="c-list" aria-label="切り抜き">
      {#if data.recording !== null}
        <!-- 録画から来たとき。どの録画で絞っているかと、外すボタン -->
        <p class="c-scope small">
          <span class="truncate broadcast"
            >「{data.recording.name}」の切り抜き</span
          >
          <button
            type="button"
            class="ghost small"
            onclick={() => apply({ recording: undefined })}
            data-testid="clip-recording-clear">絞り込みを外す</button
          >
        </p>
      {/if}
      {#if data.query.q !== undefined}
        <!-- ヘッダーの検索の結果から来たとき。探した言葉と、外すボタン -->
        <p class="c-scope small" data-testid="clip-query">
          <span class="truncate">「{data.query.q}」で探した切り抜き</span>
          <button
            type="button"
            class="ghost small"
            onclick={() => apply({ q: undefined })}
            data-testid="clip-query-clear">絞り込みを外す</button
          >
        </p>
      {/if}
      {#if selecting}
        <!-- 広い形の選ぶ形の操作 (スマホの形では下の 1 行が替わる) -->
        <div class="c-select-wide" role="group" aria-label="選んだ切り抜き">
          {@render selectTools()}
        </div>
      {/if}

      {#each days as group (group.day)}
        <h2 class="day-head" data-testid="clip-day">
          <span class="day-head-chip">
            <span class="day-head-name">{dayLabel(group.day)}</span>
            {#if dayName(group.day, now) !== null}<span
                class="day-head-date num">{fullDate(group.day)}</span
              >{/if}
          </span>
        </h2>
        <ul class="c-grid" data-selecting={selecting ? "" : undefined}>
          {#each group.clips as clip (clip.id)}
            <li>
              <button
                type="button"
                class="c-card"
                aria-pressed={selecting ? selected.has(clip.id) : undefined}
                onclick={(event) => press(clip, event)}
                onpointerdown={(event) => onholdstart(clip, event)}
                onpointermove={onholdmove}
                onpointerup={onholdend}
                onpointercancel={onholdend}
                onpointerleave={onholdend}
                oncontextmenu={(event) => {
                  // 指の長押しで出る画像のメニューは出さない (長押しは選ぶ操作)
                  if (held || hold !== undefined) event.preventDefault();
                }}
                data-testid="clip-card"
                data-clip-id={clip.id}
              >
                <img
                  class="c-thumb"
                  src="{resolve(`api/clips/${clip.id}/small`)}{clipVersionQuery(
                    clip,
                  )}"
                  alt=""
                  width={clip.width}
                  height={clip.height}
                  loading="lazy"
                  decoding="async"
                />
                <span class="c-name truncate broadcast" data-testid="clip-name"
                  >{title(clip)}</span
                >
                <span class="c-meta small muted num"
                  >{time(clip.takenAt)}{#if clip.programName !== ""}・<span
                      class="broadcast">{clip.serviceName}</span
                    >{/if}</span
                >
              </button>
              <!-- 選ぶ丸。マウスで乗せた・キーボードで触った・選ぶ形の間だけ見える -->
              <button
                type="button"
                class="c-check"
                aria-pressed={selected.has(clip.id)}
                aria-label="選ぶ: {title(clip)}"
                title="選ぶ"
                onclick={(event) => pick(clip, event)}
                data-testid="clip-check"
                ><span class="c-check-mark"
                  ><Icon icon={CHECK} size="size-4" /></span
                ></button
              >
            </li>
          {/each}
        </ul>
      {/each}

      {#if next !== null}
        <div
          class="c-more small muted"
          use:sentinel={() => void loadMore()}
          data-testid="clip-more"
        >
          読み込んでいます…
        </div>
      {/if}

      {#if clips.length === 0}
        {#if filtered}
          <div class="empty-state">
            <p class="bold">当てはまるものはありません</p>
          </div>
        {:else}
          <!-- まだ何も無いときは、どうすれば並ぶかまで言う -->
          <div class="empty-state glow" data-testid="clip-empty">
            <p class="bold">切り抜きはまだありません</p>
            <p class="small muted">
              観ている画面のカメラのボタンを押すと、その場面がここに並びます
            </p>
          </div>
        {/if}
      {/if}
    </section>

    <!-- 広い形だけ。並びは録画のサイドバーと同じ部品 (`app.css` の `.side-panel`) -->
    <aside
      class="c-side side-panel side-column"
      aria-label="絞り込み"
      data-testid="clip-side"
    >
      <HomeCalendar
        {marks}
        today={dayStart(now)}
        pinned={picked}
        onpick={pickDay}
        describe={describeDay}
      />

      <h2 class="side-label">種類</h2>
      <div class="side-list" role="group" aria-label="ライブか録画か">
        {@render kinds()}
      </div>

      {#if data.facets.services.length > 0}
        <h2 class="side-label">局</h2>
        <div class="side-list" role="group" aria-label="局">
          {@render services()}
        </div>
      {/if}

      <h2 class="side-label">使っている量</h2>
      <p class="c-usage small muted num" data-testid="clip-usage">
        {data.facets.count} 枚・{size(data.facets.bytes)}
      </p>
    </aside>
  </div>

  <!-- スマホの形の絞り込み (下のタブのすぐ上)。選ぶ形の間は選んだぶんの操作の 1 行に替わる -->
  <div
    class="c-bar dock"
    data-selecting={selecting ? "" : undefined}
    data-testid="clip-bar"
  >
    {#if selecting}
      {@render selectTools()}
    {:else}
      <Menu
        bind:open={filterOpen}
        side="top"
        align="end"
        class="c-filter-menu"
        testid="clip-filter-menu"
      >
        {#snippet trigger(props)}
          <button
            {...props}
            type="button"
            class="ghost icon"
            title="絞り込み"
            data-on={data.query.kind !== undefined ||
            data.query.service !== undefined ||
            data.query.day !== undefined
              ? ""
              : undefined}
            data-testid="clip-filter"
          >
            <Icon icon={ListFilter} size="size-5" /><span
              class="visually-hidden">絞り込み</span
            >
          </button>
        {/snippet}
        <div class="c-menu-head small muted">種類</div>
        <div class="side-list" role="group" aria-label="ライブか録画か">
          {@render kinds(() => (filterOpen = false))}
        </div>
        {#if data.facets.services.length > 0}
          <div class="c-menu-head small muted">局</div>
          <div class="side-list" role="group" aria-label="局">
            {@render services(() => (filterOpen = false))}
          </div>
        {/if}
        {#if data.query.day !== undefined}
          <div class="side-list">
            <button
              type="button"
              class="side-item"
              onclick={() => {
                apply({ day: undefined });
                filterOpen = false;
              }}>{fullDate(dayOf(data.query.day))} の絞り込みを外す</button
            >
          </div>
        {/if}
        <div class="c-menu-head small muted num">
          {data.facets.count} 枚・{size(data.facets.bytes)}
        </div>
      </Menu>
    {/if}
  </div>
</div>

<!-- 1 枚を開いた所 (並びは冒頭の説明、形は下の `.viewer`) -->
<dialog
  class="viewer"
  bind:this={dialog}
  onclose={() => {
    viewing = null;
    deleting.fire();
  }}
  onkeydown={onviewerkey}
  onclick={(event) => {
    // 箱の外 (幕) を押したら閉じる。箱の中の押しは箱の要素に当たるので、ここに来るのは幕だけ
    if (event.target === dialog) close();
  }}
  aria-label={viewing === null ? "切り抜き" : title(viewing)}
  data-testid="clip-viewer"
>
  {#if viewing !== null}
    {@const clip = viewing}
    {@const href = sceneHref(clip)}
    {@const shown = layersShown(clip)}
    <div class="v-stage">
      {#if Object.keys(clip.layers).length === 0}
        <img
          class="v-image"
          src="{resolve(`api/clips/${clip.id}/image`)}{clipVersionQuery(clip)}"
          alt={title(clip)}
          data-testid="clip-image"
        />
      {:else}
        <!--
          重ねを持つものは元の画像を重ねて見せる (観る画面の字幕・コメントと同じく画面で重ねる)。3 枚は同じ縦横なので、
          映像の形の箱に重ねればぴったり合う。出し入れは隠すだけ (隠した重ねも先に読んでおく)
        -->
        <div
          class="v-layers"
          style:--v-ratio="{clip.width} / {clip.height}"
          data-testid="clip-layers"
        >
          <img
            src={resolve(`api/clips/${clip.id}/layer/frame`)}
            alt={title(clip)}
            data-testid="clip-image"
          />
          {#each CLIP_LAYERS as layer (layer)}
            {#if clip.layers[layer] !== undefined}
              <img
                src={resolve(`api/clips/${clip.id}/layer/${layer}`)}
                alt=""
                hidden={shown[layer] !== true}
                data-testid="clip-layer-image-{layer}"
              />
            {/if}
          {/each}
        </div>
      {/if}
      <div class="v-info" aria-live="polite">
        <p class="v-title broadcast" data-testid="clip-viewer-title">
          {title(clip)}
        </p>
        <p class="v-meta small num">
          {dateTime(clip.takenAt)}{#if clip.programName !== ""}・<span
              class="broadcast">{clip.serviceName}</span
            >{/if}・{clip.place === "live" ? "ライブ" : "録画"}
        </p>
        {#if clip.captions !== ""}
          <p class="v-captions small broadcast">{clip.captions}</p>
        {/if}
      </div>
      <ControlBar side testid="clip-side-bar">
        <ControlButton
          icon={CLOSE}
          label="閉じる"
          testid="clip-close"
          onclick={close}
        />
        {#if href !== null}
          <a
            class="{OVERLAY_BTN} {OVERLAY_ROUND} {OVERLAY}"
            {href}
            aria-label="この場面から観る"
            title="この場面から観る"
            data-testid="clip-watch"
          >
            <Icon icon={PLAY} />
          </a>
        {/if}
        <!-- 字幕・コメントの出し入れ。撮ったときに出していたもの (分けて送られたもの) だけ -->
        {#if shown.captions !== undefined}
          <ControlButton
            icon={CAPTION}
            label="字幕"
            on={shown.captions}
            testid="clip-layer-captions"
            onclick={() => toggleLayer(clip, "captions")}
          />
        {/if}
        {#if shown.comments !== undefined}
          <ControlButton
            icon={JIKKYO}
            label="コメント"
            on={shown.comments}
            testid="clip-layer-comments"
            onclick={() => toggleLayer(clip, "comments")}
          />
        {/if}
        {#if copyable}
          <ControlButton
            icon={copiedId === clip.id ? CHECK : COPY}
            label="クリップボードにコピー"
            testid="clip-copy"
            onclick={() => copy(clip)}
          />
        {/if}
        <ControlButton
          icon={DOWNLOAD}
          label="端末に保存"
          testid="clip-save"
          onclick={() => void save(clip)}
        />
        {#if deleting.armed === clip.id}
          <ControlButton
            icon={CHECK}
            label="削除を確定"
            danger
            testid="clip-delete-confirm"
            onclick={() => void remove([clip.id])}
          />
        {:else}
          <ControlButton
            icon={TRASH}
            label="削除"
            testid="clip-delete"
            onclick={() => deleting.arm(clip.id)}
          />
        {/if}
      </ControlBar>
    </div>
  {/if}
</dialog>

<style>
  /*
   * 並べ方は録画の一覧 (`home.css` の `.board`) と同じ: ページごと巻き、広い形は右のサイドバーをヘッダーの下に貼り付ける。
   * スマホの形は絞り込みの 1 行を下のタブのすぐ上に浮かせる (docs/design.md の「浮かせ方」)
   */
  .clips {
    display: flex;
    flex-direction: column;
  }
  @media (min-width: 768px) {
    .clips {
      margin: 0 calc(-1 * var(--dp-gutter)) calc(-1 * var(--dp-gutter));
    }
    .c-list {
      padding: 0 calc(var(--dp-gutter) - var(--dp-space-2)) var(--dp-space-4);
    }
  }
  .c-list {
    min-width: 0;
    padding-bottom: var(--dp-space-4);
  }
  .c-usage {
    margin: var(--dp-space-1) 0 var(--dp-space-1) var(--dp-space-3);
  }

  /* 日付の見出しは録画の一覧と同じ (`app.css` の `.day-head`)。下のグリッドとは少し離す */
  .c-list > .day-head {
    margin-bottom: 0.375rem;
  }
  .c-list > .day-head:first-of-type {
    margin-top: 0;
  }

  /*
     * 平らなグリッド。件の面には乗せず、画像と字だけ (docs/design.md の「ふだんは平らに」)。
     * 1 枚の幅は 16rem から (11rem では何が写っているか読めなかった)。スマホの幅では 1 列に並ぶ
     */
  .c-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
    gap: var(--dp-space-4) var(--dp-space-3);
    margin: 0 0 var(--dp-space-4);
    padding: 0;
    list-style: none;
  }
  .c-grid > li {
    position: relative;
    min-width: 0;
    margin: 0;
    list-style: none;
  }
  .c-card {
    /* 長押しは選ぶ操作。字を選ぶ・画像のメニュー (iOS) を出さない */
    -webkit-touch-callout: none;
    user-select: none;
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    width: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: var(--dp-radius);
    background: transparent;
    box-shadow: none;
    color: var(--pico-color);
    text-align: start;
  }
  /* 乗せたときはほかの件と同じく淡い地 (`--dp-hover-soft`)。画像の明るさは変えない */
  .c-card:hover {
    background: var(--dp-hover-soft);
  }
  .c-thumb {
    width: 100%;
    height: auto;
    aspect-ratio: 16 / 9;
    margin-bottom: var(--dp-space-1);
    border-radius: var(--dp-radius);
    background: var(--dp-video);
    object-fit: cover;
  }
  /* 1 段目は本文、2 段目 (`.c-meta`) は控えた字 (`.small`)。どの一覧も同じ (docs/design.md) */
  .c-name {
    font-size: var(--dp-text-base);
    font-weight: var(--dp-weight-bold);
  }
  .c-meta {
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /*
   * 選ぶ丸 (画像の左上)。押せる所は 40px、見える丸は 28px。ふだんは隠し、マウスで乗せた・キーボードで触った・
   * 選ぶ形の間だけ出す (指の端末は乗せる操作が無いので長押しで入る)。
   * 選んだものは主の色の輪とレ点、選んでいないものは白い輪 (どちらも塗らない)
   */
  .c-check {
    position: absolute;
    top: 0;
    left: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    box-shadow: none;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--dp-duration) var(--dp-ease);
  }
  .c-check:focus-visible,
  .c-grid[data-selecting] .c-check {
    opacity: 1;
    pointer-events: auto;
  }
  @media (hover: hover) {
    .c-grid > li:hover .c-check {
      opacity: 1;
      pointer-events: auto;
    }
  }
  .c-check-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--dp-video) 55%, transparent);
    color: transparent;
    box-shadow: inset 0 0 0 2px var(--dp-on-video);
    transition:
      box-shadow var(--dp-duration) var(--dp-ease),
      color var(--dp-duration) var(--dp-ease);
  }
  /* 乗せたら、押せば選べることをレ点で先に見せる */
  .c-check:hover .c-check-mark {
    color: var(--dp-on-video);
  }
  /*
   * 選んだものも塗らない。輪とレ点を主の色にする (画像の上でも読めるよう、地の暗い円はそのまま)。
   * 印はこの輪 1 つだけで、名前の字の色は変えない (同じものに印を 2 つ付けない。docs/design.md)
   */
  .c-check[aria-pressed="true"] .c-check-mark {
    color: var(--pico-primary);
    box-shadow: inset 0 0 0 2px var(--pico-primary);
  }
  .c-more {
    padding: var(--dp-space-4) 0;
    text-align: center;
  }
  .c-scope {
    display: flex;
    align-items: center;
    gap: var(--dp-space-2);
    margin: 0 0 var(--dp-space-2);
  }
  .c-scope > button,
  .c-select-wide > :global(button) {
    width: auto;
    margin: 0;
  }
  /* 浮いた 1 行なので、中の主のボタン (削除を確定) は浮かせず太字だけ (docs/design.md の「3 つの層」。`app.css` の `.dock` と同じ値) */
  .c-select-wide {
    --dp-btn-solid: transparent;
    --dp-btn-solid-hover: var(--dp-btn-tonal-hover);
    --dp-btn-lift: none;
    position: sticky;
    top: var(--dp-header-space, 0px);
    z-index: var(--dp-z-pagebar);
    display: flex;
    align-items: center;
    gap: var(--dp-space-2);
    width: fit-content;
    margin-bottom: var(--dp-space-2);
    padding: var(--dp-space-1) var(--dp-space-2) var(--dp-space-1)
      var(--dp-space-4);
    border-radius: var(--dp-radius-full);
    background: var(--dp-float);
    box-shadow: var(--dp-shadow-pop);
  }
  :global(html[data-phone]) .c-select-wide {
    display: none;
  }
  .c-picked {
    white-space: nowrap;
  }
  /* スマホの形の絞り込みの 1 行。ほかの画面の操作の 1 行と同じく、下のタブのすぐ上にカプセルで浮かせる (`app.css` の `.dock`) */
  .c-bar {
    display: none;
  }
  :global(html[data-phone]) .c-bar {
    position: sticky;
    order: 2;
    z-index: var(--dp-z-pagebar);
    display: flex;
    align-items: center;
    gap: var(--dp-space-1);
    height: 2.75rem;
    margin-inline: calc(var(--dp-dock-inset) - var(--dp-gutter, 1rem));
    padding-inline: var(--dp-space-2);
  }
  /* ラベルのあるボタンは中身の幅。アイコンのボタン (絞り込み) は決まりの大きさのまま (auto にすると横に潰れる) */
  :global(html[data-phone]) .c-bar > :global(button) {
    margin: 0;
  }
  :global(html[data-phone]) .c-bar > :global(button:not(.icon)) {
    width: auto;
  }
  /* ふだんは「絞り込み」のボタンだけなので、右端に丸く寄せる (言葉で探すのはヘッダーの検索) */
  :global(html[data-phone]) .c-bar:not([data-selecting]) {
    align-self: flex-end;
    width: fit-content;
    padding-inline: 0;
  }
  @media (min-width: 768px) {
    :global(html[data-phone]) .c-bar {
      margin-inline: var(--dp-dock-inset);
    }
  }
  :global(html[data-phone]) .c-main {
    order: 1;
  }
  /* 少なくても絞り込みの 1 行が下のタブのすぐ上に来るよう、ページの高さいっぱいまで伸ばす */
  :global(html[data-phone]) .clips {
    min-height: calc(
      100svh - env(safe-area-inset-top, 0px) - var(--dp-page-top, 0.5rem) -
        var(--dp-tabbar, 0px)
    );
    margin-bottom: calc(-1 * var(--dp-gutter, 1rem));
  }
  .c-menu-head {
    padding: var(--dp-space-2) var(--dp-space-3) var(--dp-space-1);
  }
  :global(.c-filter-menu) {
    width: 16rem;
    max-width: calc(100vw - 2rem);
    max-height: 70svh;
    overflow-y: auto;
  }

  /*
   * 1 枚を開いた所。**画面を覆わず、一覧の上に浮かぶ箱** (ダイアログと同じく後ろは幕 `--dp-backdrop`、幕を押すと閉じる)。
   * 箱は 16:9 の黒い舞台 (テーマにかかわらず。映像の上と同じ色の決まり) で、画面に収まる大きさまで。
   * 縦は右端の列 (7 つ) が 1 列に収まる高さ (48px の丸 7 つ、8px の間 6 つ、上下の余白 8px ずつで 25rem) を下限にする。スマホの縦の 16:9 では低すぎて列が折り返す。
   * 並べ方 (真ん中に置く) は Pico の dialog のまま。ここで `display` を書くと閉じた幕が消えずに一覧を塞ぐ。
   * 開き方もダイアログの箱と同じ (少し縮んだ姿からばねで。app.css の `dialog > article`)
   */
  .viewer {
    padding: var(--dp-space-4);
    color: var(--dp-on-video);
  }
  .v-stage {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: min(calc(100vw - 2rem), calc((100svh - 2rem) * 16 / 9), 80rem);
    aspect-ratio: 16 / 9;
    min-height: min(25rem, calc(100svh - 2rem));
    overflow: hidden;
    container-type: size;
    border-radius: var(--dp-radius-lg);
    background: var(--dp-video);
    box-shadow: var(--dp-shadow-pop);
    transition: transform var(--dp-duration-exit) var(--dp-ease-exit);
  }
  /* スマホの形は画面の横幅いっぱい (左右の余白と角の丸みを無くす) */
  :global(html[data-phone]) .viewer {
    padding: 0;
  }
  :global(html[data-phone]) .v-stage {
    width: min(100vw, 100svh * 16 / 9);
    border-radius: 0;
  }
  .viewer:not([open]) .v-stage {
    transform: translateY(0.5rem) scale(0.95);
  }
  .viewer[open] .v-stage {
    transition-duration: var(--dp-duration-enter);
    transition-timing-function: var(--dp-ease-spring);
  }
  @starting-style {
    .viewer[open] .v-stage {
      transform: translateY(0.5rem) scale(0.95);
    }
  }
  .v-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  /* 重ねる箱。舞台に収まる最大の、映像の形の箱 (舞台の縦横は `cqw`・`cqh` で見る) */
  .v-layers {
    position: relative;
    width: min(100cqw, 100cqh * var(--v-ratio));
    aspect-ratio: var(--v-ratio);
  }
  .v-layers > img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  /* 読みものは左下。右端の列に掛からないよう右を空け、明るい画像の上でも読めるよう下から影を敷く */
  .v-info {
    position: absolute;
    inset: auto 5rem 0 0;
    padding: 2.5rem var(--dp-space-4) var(--dp-space-4);
    background: linear-gradient(
      to top,
      color-mix(in srgb, var(--dp-video) 82%, transparent),
      transparent
    );
    pointer-events: none;
  }
  .v-info p {
    margin: 0;
  }
  .v-title {
    font-weight: var(--dp-weight-bold);
  }
  .v-meta,
  .v-captions {
    color: var(--dp-on-video-muted);
  }
  .v-captions {
    margin-top: var(--dp-space-1);
  }
</style>
