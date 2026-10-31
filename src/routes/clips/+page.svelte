<script lang="ts">
  import { goto, invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import ListFilter from "~icons/lucide/list-filter";

  import { arming } from "#lib/arming.svelte.js";
  import {
    type Clip,
    type ClipKind,
    type ClipLayer,
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
    DOWNLOAD,
    JIKKYO,
    OVERLAY,
    OVERLAY_BTN,
    OVERLAY_ROUND,
    PLAY,
    TRASH,
  } from "#lib/components/player/icons.js";
  import { keepOnDevice, shotName } from "#lib/components/player/snapshot.js";
  import Toasts, { type Notice } from "#lib/components/Toasts.svelte";
  import { date, dateTime, size, time } from "#lib/format.js";
  import { liveUpdates } from "#lib/live-updates.svelte.js";
  import { sentinel } from "#lib/paging.svelte.js";
  import { dayName, dayStart } from "#lib/timeline.js";

  /**
   * **切り抜き** (`/clips`)。観る画面・追っかけ・ライブで押した1コマ (字幕・コメントごと) を、撮った日の見出しの下に平らなグリッドで並べる。
   *
   * - 条件は URL で持つ (`GET /api/clips` と同じ名前。`#lib/clips.ts`)。最初の 60 枚は load、続きは下端で API から足す
   * - 広い形は右のサイドバーにカレンダー・ライブか録画か・局・使っている量。スマホの形は下のタブのすぐ上に
   *   「絞り込み」のメニュー。言葉で探すのはヘッダーの検索で、その結果の「切り抜き」から `?q=` 付きで来たときは
   *   一覧の上に探した言葉と外すボタンを出す
   * - 1枚を開くと暗い全画面。右端の縦の列に閉じる・この場面から観る・字幕とコメントの出し入れ (撮ったときに出していたものだけ)・
   *   端末に保存・削除 (2回押し。いちばん下)。
   *   列は観る画面と同じ部品 (`ControlBar`・`ControlButton`)
   * - 選び方は写真のサービスと同じ。マウスでは乗せた1枚の左上に丸が出て、押すと選ぶ形に入る。指の端末は長押しで入る。
   *   選ぶ形の間は1枚を押すと選ぶ・外す (開かない)。Shift を押しながらなら、前に押した1枚までをまとめて選ぶ。
   *   選んだぶんは2回押しで消す。Esc か「選択をやめる」で抜け、全部外しても抜ける
   */
  let { data } = $props();

  // 切り抜きが増えた・消えた・切り替えたら読み直す (`api/events` の `clips`)
  liveUpdates(["clips"]);

  /**
   * 下端で足した続き。load が回り直したら頭から作り直す。**条件が変わったときだけ捨てる** —
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

  /** 続きを1ページ取る。世代が替わっていたら捨てる */
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
    return dayName(day, now) ?? date(day);
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
    return `${d.getMonth() + 1}月${d.getDate()}日、${count === 0 ? "なし" : `切り抜き ${count}枚`}`;
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
   * ---- 1枚を開く ----
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
  /** ← → で前後の1枚へ (並びの順。左が新しい) */
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

  /** 端末に保存 (指の端末は共有シート、PC はファイル)。名前は `番組名_YYYYMMDD-HHMMSS.avif` */
  async function save(clip: Clip): Promise<void> {
    try {
      const res = await fetch(
        `${resolve(`api/clips/${clip.id}/image`)}${clipVersionQuery(clip)}`,
      );
      if (!res.ok) throw new Error(String(res.status));
      await keepOnDevice(
        await res.blob(),
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
   * 字幕・コメントを出し入れする (`PATCH /api/clips/<id>`)。サーバが元の画像から重ね直すので1秒ほど待つ。
   * その間は画像を薄くし、ほかの切り替えは受けない。画像の URL は重ねの版 (`?v=`) で替わる
   */
  let layering = $state<number | null>(null);
  async function toggleLayer(clip: Clip, layer: ClipLayer): Promise<void> {
    if (layering !== null) return;
    layering = clip.id;
    try {
      const res = await fetch(resolve(`api/clips/${clip.id}`), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [layer]: clip.layers[layer] !== true }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const changed = (await res.json()) as Clip;
      if (viewing?.id === changed.id) viewing = changed;
    } catch {
      notice = {
        key: `clip-layer-${Date.now()}`,
        kind: "error",
        text: "切り替えられませんでした",
      };
    } finally {
      layering = null;
    }
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
  /** 選ぶ形。1枚でも選んでいる間だけ (全部外したら抜ける) */
  const selecting = $derived(selected.size > 0);
  /** Shift でまとめて選ぶときの起点 (最後に押した1枚) */
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
  /** 1枚を選ぶ・外す。Shift を押していれば、起点からその1枚までを選ぶ (並びの順) */
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
  /** Esc で選ぶ形を抜ける (1枚を開いている間はダイアログが閉じるほう) */
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
  /** まとめて消すボタンの聞き返しの id (1つだけなので 0) */
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

<!-- 選ぶ形の間だけ、選んだ数と2回押しの削除 -->
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

  <div class="c-main">
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
            data-testid="clip-recording-clear">すべて表示</button
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
        <!-- 広い形の選ぶ形の操作 (スマホの形では下の1行が替わる) -->
        <div class="c-select-wide" role="group" aria-label="選んだ切り抜き">
          {@render selectTools()}
        </div>
      {/if}

      {#each days as group (group.day)}
        <h2 class="c-day" data-testid="clip-day">
          <span class="c-day-chip">
            <span class="c-day-name">{dayLabel(group.day)}</span>
            {#if dayName(group.day, now) !== null}<span class="c-day-date num"
                >{date(group.day)}</span
              >{/if}
          </span>
        </h2>
        <ul class="c-grid" data-selecting={selecting ? "" : undefined}>
          {#each group.clips as clip (clip.id)}
            <li class="c-item">
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
                <span class="c-meta tiny muted num"
                  >{time(clip.takenAt)}{#if clip.programName !== ""}
                    ・ <span class="broadcast">{clip.serviceName}</span
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
          <div class="c-empty">
            <p class="c-empty-title">当てはまるものはありません</p>
          </div>
        {:else}
          <!-- まだ何も無いときは、どうすれば並ぶかまで言う -->
          <div class="c-empty glow" data-testid="clip-empty">
            <p class="c-empty-title">切り抜きはまだありません</p>
            <p class="c-empty-hint">
              観ている画面のカメラのボタンを押すと、その場面がここに並びます
            </p>
          </div>
        {/if}
      {/if}
    </section>

    <!-- 広い形だけ。並びは録画のサイドバーと同じ部品 (`app.css` の `.side-panel`) -->
    <aside
      class="c-side side-panel"
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
        {data.facets.count} 枚 ・ {size(data.facets.bytes)}
      </p>
    </aside>
  </div>

  <!-- スマホの形の絞り込み (下のタブのすぐ上)。選ぶ形の間は選んだぶんの操作の1行に替わる -->
  <div
    class="c-bar"
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
        <div class="side-list">{@render kinds(() => (filterOpen = false))}</div>
        {#if data.facets.services.length > 0}
          <div class="c-menu-head small muted">局</div>
          <div class="side-list">
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
              }}>{date(dayOf(data.query.day))} の絞り込みを外す</button
            >
          </div>
        {/if}
        <div class="c-menu-head small muted num">
          {data.facets.count} 枚 ・ {size(data.facets.bytes)}
        </div>
      </Menu>
    {/if}
  </div>
</div>

<!--
    1枚を開いた所。暗い全画面 (映像の上と同じく、テーマにかかわらず黒い舞台)。右端の縦の列は観る画面と同じ部品で、
    上から閉じる・この場面から観る・字幕・コメント・端末に保存・削除 (2回押し。いちばん下)
-->
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
    <div class="v-stage">
      <img
        class="v-image"
        src="{resolve(`api/clips/${clip.id}/image`)}{clipVersionQuery(clip)}"
        alt={title(clip)}
        aria-busy={layering === clip.id}
        data-testid="clip-image"
      />
      <div class="v-info" aria-live="polite">
        <p class="v-title broadcast" data-testid="clip-viewer-title">
          {title(clip)}
        </p>
        <p class="v-meta small num">
          {dateTime(clip.takenAt)}{#if clip.programName !== ""}
            ・ <span class="broadcast">{clip.serviceName}</span>{/if}
          ・ {clip.place === "live" ? "ライブ" : "録画"}
        </p>
        {#if clip.captions !== ""}
          <p class="v-captions small broadcast">{clip.captions}</p>
        {/if}
        {#if layering === clip.id}
          <p class="v-meta small" data-testid="clip-layering">
            切り替えています…
          </p>
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
        {#if clip.layers.captions !== undefined}
          <ControlButton
            icon={CAPTION}
            label="字幕"
            on={clip.layers.captions}
            testid="clip-layer-captions"
            onclick={() => void toggleLayer(clip, "captions")}
          />
        {/if}
        {#if clip.layers.comments !== undefined}
          <ControlButton
            icon={JIKKYO}
            label="コメント"
            on={clip.layers.comments}
            testid="clip-layer-comments"
            onclick={() => void toggleLayer(clip, "comments")}
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
   * スマホの形は絞り込みの1行を下のタブのすぐ上に浮かせる (docs/design.md の「浮かせ方」)
   */
  .clips {
    --c-day-gap: 0.5rem;
    display: flex;
    flex-direction: column;
  }
  @media (min-width: 768px) {
    .clips {
      margin: 0 calc(-1 * var(--dp-gutter)) calc(-1 * var(--dp-gutter));
    }
    .c-list {
      padding: 0 calc(var(--dp-gutter) - 0.5rem) 1rem;
    }
  }
  .c-main {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    flex: 1;
    min-height: 0;
  }
  .c-list {
    min-width: 0;
    padding-bottom: 1rem;
  }
  .c-side {
    display: none;
  }
  :global(html:not([data-phone])) .c-main {
    grid-template-columns: minmax(0, 1fr) 20rem;
  }
  :global(html:not([data-phone])) .c-side {
    display: flex;
    padding-top: 0.25rem;
  }
  .c-usage {
    margin: 0.25rem 0 0.25rem 0.75rem;
  }

  /* 日付の見出し。ふだんは平ら、貼り付いて行がその裏を流れるときだけ浮く (録画の一覧と同じ) */
  .c-day {
    position: sticky;
    top: var(--c-day-gap);
    z-index: 3;
    width: fit-content;
    margin: 0.5rem 0 0.375rem;
    color: var(--dp-muted);
    font-size: 0.75rem;
    font-weight: var(--dp-weight-bold);
    container-type: scroll-state;
  }
  .c-list > .c-day:first-of-type {
    margin-top: 0;
  }
  .c-day-chip {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.25rem 0.75rem;
    border-radius: var(--dp-radius-full);
    background: var(--dp-float);
    box-shadow: var(--dp-shadow-pop);
    transition:
      background-color var(--dp-duration-enter) var(--dp-ease),
      box-shadow var(--dp-duration-enter) var(--dp-ease);
  }
  @supports (container-type: scroll-state) {
    .c-day-chip {
      background: transparent;
      box-shadow: none;
    }
    @container scroll-state(stuck: top) {
      .c-day-chip {
        background: var(--dp-float);
        box-shadow: var(--dp-shadow-pop);
      }
    }
  }
  .c-day-name {
    color: var(--pico-color);
  }
  .c-day-date {
    font-weight: var(--dp-weight);
  }
  :global(html:not([data-phone])) .clips {
    --c-day-gap: var(--dp-bar-gap);
  }
  :global(html:not([data-phone])) .c-day {
    top: calc(var(--dp-header-bottom) + var(--c-day-gap));
  }
  :global(html[data-phone]) .c-day {
    top: calc(env(safe-area-inset-top, 0px) + var(--c-day-gap));
  }

  /*
     * 平らなグリッド。件の面には乗せず、画像と字だけ (docs/design.md の「ふだんは平らに」)。
     * 1枚の幅は 16rem から (11rem では何が写っているか読めなかった)。電話では1列に並ぶ
     */
  .c-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
    gap: 1rem 0.75rem;
    margin: 0 0 1rem;
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
  .c-card:hover .c-thumb {
    filter: brightness(1.08);
  }
  .c-thumb {
    width: 100%;
    height: auto;
    aspect-ratio: 16 / 9;
    margin-bottom: 0.25rem;
    border-radius: var(--dp-radius);
    background: var(--dp-video);
    object-fit: cover;
    transition: filter var(--dp-duration);
  }
  .c-name {
    font-size: var(--dp-text-sm);
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
   * 選んだものは主の色の円にレ点、選んでいないものは淡い円 (塗るのは印だけ)
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
      background-color var(--dp-duration) var(--dp-ease),
      color var(--dp-duration) var(--dp-ease);
  }
  /* 乗せたら、押せば選べることをレ点で先に見せる */
  .c-check:hover .c-check-mark {
    color: var(--dp-on-video);
  }
  .c-check[aria-pressed="true"] .c-check-mark {
    background: var(--pico-primary);
    color: var(--pico-primary-inverse);
    box-shadow: none;
  }
  .c-card[aria-pressed="true"] .c-name {
    color: var(--dp-primary-text);
  }
  .c-more {
    padding: 1rem 0;
    text-align: center;
  }
  .c-scope {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 0.5rem;
  }
  .c-scope > button,
  .c-select-wide > :global(button) {
    width: auto;
    margin: 0;
  }
  .c-select-wide {
    position: sticky;
    top: calc(var(--dp-header-bottom, 0px) + var(--dp-bar-gap, 0.25rem));
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: fit-content;
    margin-bottom: 0.5rem;
    padding: 0.25rem 0.5rem 0.25rem 1rem;
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
  .c-empty {
    padding: 3rem 1rem;
    text-align: center;
  }
  .c-empty-title {
    margin: 0;
    font-weight: var(--dp-weight-bold);
  }
  .c-empty-hint {
    margin: 0.5rem 0 0;
    color: var(--dp-muted);
    font-size: var(--dp-text-sm);
  }

  /* スマホの形の絞り込みの1行。ほかの画面の操作の1行と同じく、下のタブのすぐ上にカプセルで浮かせる */
  .c-bar {
    display: none;
  }
  :global(html[data-phone]) .c-bar {
    position: sticky;
    order: 2;
    bottom: calc(var(--dp-tabbar, 0px) + 0.375rem);
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    height: 2.75rem;
    margin-inline: calc(0.75rem - var(--dp-gutter, 1rem));
    padding-inline: 0.5rem;
    border-radius: var(--dp-radius-full);
    background: var(--dp-float);
    box-shadow: var(--dp-shadow-pop);
    transition: transform var(--dp-duration-move) var(--dp-ease-spring);
  }
  :global(html[data-phone]) .c-bar > :global(button) {
    width: auto;
    margin: 0;
  }
  /* ふだんは「絞り込み」のボタンだけなので、右端に丸く寄せる (言葉で探すのはヘッダーの検索) */
  :global(html[data-phone]) .c-bar:not([data-selecting]) {
    align-self: flex-end;
    width: fit-content;
    padding-inline: 0;
  }
  @media (min-width: 768px) {
    :global(html[data-phone]) .c-bar {
      margin-inline: 0.75rem;
    }
  }
  :global(html[data-phone] [data-retract]) .c-bar:not(:has(:focus-visible)) {
    transform: translateY(calc(var(--dp-tabbar, 0px) + 0.375rem + 100%));
  }
  :global(html[data-phone]) .c-main {
    order: 1;
  }
  /* 少なくても絞り込みの1行が下のタブのすぐ上に来るよう、ページの高さいっぱいまで伸ばす */
  :global(html[data-phone]) .clips {
    min-height: calc(
      100svh - env(safe-area-inset-top, 0px) - var(--dp-page-top, 0.5rem) -
        var(--dp-tabbar, 0px)
    );
    margin-bottom: calc(-1 * var(--dp-gutter, 1rem));
  }
  .c-menu-head {
    padding: 0.5rem 0.75rem 0.25rem;
  }
  :global(.c-filter-menu) {
    width: 16rem;
    max-width: calc(100vw - 2rem);
    max-height: 70svh;
    overflow-y: auto;
  }

  /*
   * 1枚を開いた所。**画面を覆わず、一覧の上に浮かぶ箱** (ダイアログと同じく後ろは幕 `--dp-backdrop`、幕を押すと閉じる)。
   * 箱は 16:9 の黒い舞台 (テーマにかかわらず。映像の上と同じ色の決まり) で、画面に収まる大きさまで。
   * 縦は右端の列 (6 つ) が1列に収まる高さを下限にする (スマホの縦の 16:9 では低すぎて列が折り返す)。
   * 並べ方 (真ん中に置く) は Pico の dialog のまま。ここで `display` を書くと閉じた幕が消えずに一覧を塞ぐ。
   * 開き方もダイアログの箱と同じ (少し縮んだ姿からばねで。app.css の `dialog > article`)
   */
  .viewer {
    padding: 1rem;
    color: var(--dp-on-video);
  }
  .v-stage {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: min(calc(100vw - 2rem), calc((100svh - 2rem) * 16 / 9), 80rem);
    aspect-ratio: 16 / 9;
    min-height: min(24rem, calc(100svh - 2rem));
    overflow: hidden;
    border-radius: var(--dp-radius-lg);
    background: var(--dp-video);
    box-shadow: var(--dp-shadow-pop);
    transition: transform var(--dp-duration-exit) var(--dp-ease-exit);
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
    transition: opacity var(--dp-duration);
  }
  /* 字幕・コメントを切り替えている間 (サーバが重ね直している) */
  .v-image[aria-busy="true"] {
    opacity: 0.5;
  }
  /* 読みものは左下。右端の列に掛からないよう右を空け、明るい画像の上でも読めるよう下から影を敷く */
  .v-info {
    position: absolute;
    inset: auto 5rem 0 0;
    padding: 2.5rem 1rem 1rem;
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
    margin-top: 0.25rem;
  }
</style>
