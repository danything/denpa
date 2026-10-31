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
   * - 広い形は右のサイドバーに言葉・カレンダー・ライブか録画か・局・使っている量。スマホの形は下のタブのすぐ上に
   *   絞り込みの1行 (言葉と「絞り込み」のメニュー)
   * - 1枚を開くと暗い全画面。右端の縦の列に閉じる・この場面から観る・字幕とコメントの出し入れ (撮ったときに出していたものだけ)・
   *   端末に保存・削除 (2回押し。いちばん下)。
   *   列は観る画面と同じ部品 (`ControlBar`・`ControlButton`)
   * - まとめて消すときは「選んで削除」で選ぶ形に入り、選んだぶんを2回押しで消す
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
      // 打っている欄のフォーカスと、読んでいる位置はそのまま
      reset: false,
    });
  }

  /** 言葉は打つそばから (少し待ってから) 探す */
  // svelte-ignore state_referenced_locally
  let words = $state(data.query.q ?? "");
  let typing: ReturnType<typeof setTimeout> | undefined;
  function onwords(): void {
    clearTimeout(typing);
    typing = setTimeout(() => apply({ q: words.trim() || undefined }), 300);
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
    selected.clear();
    selecting = false;
    await invalidateAll();
  }

  /*
   * ---- 選んで削除 ----
   */
  let selecting = $state(false);
  const selected = new SvelteSet<number>();
  function toggleSelecting(): void {
    selecting = !selecting;
    selected.clear();
    deleting.fire();
  }
  function press(clip: Clip): void {
    if (!selecting) {
      open(clip);
      return;
    }
    if (selected.has(clip.id)) selected.delete(clip.id);
    else selected.add(clip.id);
  }
  /** まとめて消すボタンの聞き返しの id (1つだけなので 0) */
  const MANY = 0;

  let filterOpen = $state(false);
</script>

<svelte:head><title>切り抜き - denpa</title></svelte:head>
<svelte:window onclick={deleting.stand} />

{#snippet search(testid: string)}
  <input
    type="search"
    class="c-search"
    placeholder="番組名・局名・字幕で探す"
    aria-label="切り抜きを言葉で探す"
    bind:value={words}
    oninput={onwords}
    data-testid={testid}
  />
{/snippet}

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

<!-- まとめて消す。選ぶ形の間だけ、選んだ数と2回押しの削除 -->
{#snippet selectTools()}
  <span class="small num c-picked" data-testid="clip-picked"
    >{selected.size} 枚を選択</span
  >
  {#if deleting.armed === MANY}
    <button
      type="button"
      class="danger small"
      disabled={selected.size === 0}
      onclick={() => void remove([...selected])}
      data-testid="clip-delete-many-confirm">削除を確定</button
    >
  {:else}
    <button
      type="button"
      class="outline danger small"
      disabled={selected.size === 0}
      onclick={() => deleting.arm(MANY)}
      data-testid="clip-delete-many">削除</button
    >
  {/if}
  <button
    type="button"
    class="ghost small"
    onclick={toggleSelecting}
    data-testid="clip-select-end">やめる</button
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
      {#if selecting}
        <!-- 広い形の選ぶ形の操作 (スマホの形では下の1行が替わる) -->
        <div class="c-select-wide" role="group" aria-label="選んで削除">
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
        <ul class="c-grid">
          {#each group.clips as clip (clip.id)}
            <li>
              <button
                type="button"
                class="c-card"
                aria-pressed={selecting ? selected.has(clip.id) : undefined}
                onclick={() => press(clip)}
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
                {#if selecting}
                  <span class="c-check" aria-hidden="true"
                    ><Icon icon={CHECK} size="size-4" /></span
                  >
                {/if}
                <span class="c-name truncate broadcast" data-testid="clip-name"
                  >{title(clip)}</span
                >
                <span class="c-meta tiny muted num"
                  >{time(clip.takenAt)}{#if clip.programName !== ""}
                    ・ <span class="broadcast">{clip.serviceName}</span
                    >{/if}</span
                >
              </button>
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
      <h2 class="side-label">言葉</h2>
      <div class="c-search-side">{@render search("clip-search")}</div>

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
      {#if data.facets.count > 0 && !selecting}
        <div class="side-list">
          <button
            type="button"
            class="side-item"
            onclick={toggleSelecting}
            data-testid="clip-select">選んで削除</button
          >
        </div>
      {/if}
    </aside>
  </div>

  <!-- スマホの形の絞り込みの1行 (下のタブのすぐ上)。選ぶ形の間は選んだぶんの操作に替わる -->
  <div class="c-bar" data-testid="clip-bar">
    {#if selecting}
      {@render selectTools()}
    {:else}
      {@render search("clip-search-bar")}
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
        {#if data.facets.count > 0}
          <div class="side-list">
            <button
              type="button"
              class="side-item"
              onclick={() => {
                toggleSelecting();
                filterOpen = false;
              }}
              data-testid="clip-select-bar">選んで削除</button
            >
          </div>
        {/if}
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
  .c-search-side {
    padding-inline-start: 0.75rem;
  }
  .c-search {
    width: 100%;
    margin: 0;
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
    min-width: 0;
    margin: 0;
    list-style: none;
  }
  .c-card {
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
  /* 選ぶ形の印。選んだものは主の色の円にレ点、選んでいないものは淡い円 (塗るのは印だけ) */
  .c-check {
    position: absolute;
    top: 0.375rem;
    left: 0.375rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--dp-video) 55%, transparent);
    color: transparent;
    box-shadow: inset 0 0 0 2px var(--dp-on-video);
  }
  .c-card[aria-pressed="true"] .c-check {
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
  :global(html[data-phone]) .c-bar .c-search {
    flex: 1;
    min-width: 0;
    height: var(--dp-btn-h-sm);
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

  /* 1枚を開いた所。テーマにかかわらず黒い舞台 (映像の上と同じ色の決まり) */
  .viewer {
    width: 100vw;
    max-width: none;
    height: 100svh;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    background: var(--dp-video);
    color: var(--dp-on-video);
  }
  .viewer::backdrop {
    background: var(--dp-video);
  }
  .v-stage {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
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
