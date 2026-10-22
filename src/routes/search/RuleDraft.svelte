<script lang="ts" module>
    import type { Verdict } from './+page.server';

    /** 録らない理由の短い言葉 (結果の行に添える) */
    export const SKIP_LABEL: Record<Extract<Verdict, { kind: 'skip' }>['reason'], string> = {
        repeat: '同じ回',
        recorded: '録画済み',
        'copy-never': 'コピー禁止',
        declined: '取り消し済み',
        airing: '放送中',
        ignore: '除外',
        service: '局',
        genre: 'ジャンル',
        keyword: 'キーワード',
        paid: '有料放送',
        empty: '条件なし',
    };
</script>

<script lang="ts">
    import '@anyblades/blades/layered/components/accordion';
    import { untrack } from 'svelte';
    import { submitting } from '#lib/actions.js';
    import { GENRE_TREE } from '#lib/arib.js';
    import type { Arming } from '#lib/arming.svelte.js';
    import ActionButton from '#lib/components/ActionButton.svelte';
    import ArmedDelete from '#lib/components/ArmedDelete.svelte';
    import Icon from '#lib/components/player/Icon.svelte';
    import { SERVICE_TYPE_LABEL } from '#lib/format.js';
    import { parseSearchFields, SEARCH_FIELD_LABEL, SEARCH_FIELDS } from '#lib/search.js';
    import { applyAction, deserialize, type SubmitFunction } from '$app/forms';
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { page } from '$app/state';
    import X from '~icons/lucide/x';
    import type { Preview } from './+page.server';
    import type { PageData } from './$types';

    /**
     * **ルールとして保存** (検索の画面の右の列。狭い画面では下から出す)。
     *
     * 探した言葉から始めて条件を詰め、その場でルールにする。条件を変えるたびに少し待ってから
     * `?/preview` に送り、結果の一覧の行ごとに「録る / 録らない (理由) / 予約済み」を返してもらう
     * (`rule-preview.ts`。予約を立てるときと同じ判定)。返事は `preview` で画面に渡す。
     *
     * **サーバに重ねて投げない。** 送るのは打つのが止まってから `PREVIEW_DELAY` 後。返事を待つ間に
     * 変わったぶんは、返ってから最後の条件で1回だけ送る。条件が前と同じなら送らない。空なら数えない
     */
    let {
        draft,
        q,
        ids,
        refresh,
        deleting,
        preview = $bindable(null),
        open = $bindable(false),
    }: {
        draft: PageData['draft'];
        /** 探した言葉。直していないキーワードはこれに付いていく */
        q: string;
        /** 結果の一覧に出している番組。行ごとの「録るか」を聞く */
        ids: number[];
        /** 画面の読み直し (予約・取消・保存のあと)。変わったら数え直す */
        refresh: unknown;
        /** ルールの削除の2回押し (画面の `arming`) */
        deleting: Arming;
        preview?: Preview | null;
        /** 狭い画面で下から出しているか */
        open?: boolean;
    } = $props();

    // ---- 書く欄の値 ----
    let keyword = $state('');
    let ignoreKeyword = $state('');
    let searchFields = $state<string[]>(['name']);
    let serviceTypes = $state<string[]>([]);
    let serviceIds = $state<number[]>([]);
    let genres = $state<string[]>([]);
    let dedupe = $state(true);
    let priority = $state(1);
    /** キーワードを手で直したか。直すまでは探した言葉に付いていく */
    let typed = false;

    /**
     * **書く欄を初期値から組み直す鍵。** 直すルール (`?rule=`) や元の番組 (`?from=`) が変わったときだけ。
     * 予約・取消・保存のあとの読み直しでは組み直さない (打ちかけの欄が戻る)
     */
    const seedKey = $derived(`${draft.editing?.id ?? ''}|${page.url.searchParams.get('from') ?? ''}`);
    $effect(() => {
        void seedKey;
        untrack(() => {
            const seed = draft.seed;
            keyword = seed?.keyword ?? q;
            ignoreKeyword = seed?.ignore_keyword ?? '';
            searchFields = parseSearchFields(seed?.search_fields);
            serviceTypes = seed?.service_types ?? [];
            serviceIds = seed?.service_ids ?? [];
            genres = seed?.genres ?? [];
            dedupe = seed?.dedupe ?? true;
            priority = seed?.priority ?? 1;
            typed = false;
            saved = null;
        });
    });
    /**
     * 探した言葉が**変わったら**、手で直していないキーワードも付いていく (直しているルールは除く)。
     * 開いたときの値は初期値 (`draft.seed`。元の番組のシリーズ名のこともある) のまま
     */
    let followed = untrack(() => q);
    $effect(() => {
        const word = q;
        if (word === followed) return;
        followed = word;
        untrack(() => {
            if (draft.editing === null && !typed) keyword = word;
        });
    });

    const empty = $derived(
        keyword.trim() === '' && serviceTypes.length === 0 && serviceIds.length === 0 && genres.length === 0,
    );

    // ---- 下見 ----
    const PREVIEW_DELAY = 300;
    let counting = $state(false);
    let shownKey: string | null = null;
    let inflight = false;
    let queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** いまの書く欄を送る形に (`rule-form.conditionsOf` が読む名前) */
    function body(): FormData {
        const out = new FormData();
        out.set('keyword', keyword);
        out.set('ignoreKeyword', ignoreKeyword);
        for (const field of searchFields) out.append('searchFields', field);
        for (const type of serviceTypes) out.append('serviceTypes', type);
        for (const id of serviceIds) out.append('serviceIds', String(id));
        for (const genre of genres) out.append('genres', genre);
        out.append('dedupe', '0');
        if (dedupe) out.append('dedupe', '1');
        out.set('priority', String(priority));
        if (draft.editing !== null) out.set('edit', String(draft.editing.id));
        for (const id of ids) out.append('ids', String(id));
        return out;
    }

    async function count(): Promise<void> {
        if (inflight) {
            queued = true;
            return;
        }
        const sent = body();
        const key = new URLSearchParams(sent as unknown as Record<string, string>).toString();
        if (key === shownKey) {
            counting = false;
            return;
        }
        shownKey = key;
        if (empty) {
            preview = null;
            counting = false;
            return;
        }
        inflight = true;
        counting = true;
        try {
            const response = await fetch(`${resolve('search')}?/preview`, {
                method: 'POST',
                body: sent,
                headers: { 'x-sveltekit-action': 'true' },
            });
            const result = deserialize(await response.text());
            if (result.type !== 'success') {
                throw new Error(result.type === 'failure' ? `${response.status}` : result.type);
            }
            preview = (result.data as { preview: Preview | null } | undefined)?.preview ?? null;
        } catch (error) {
            // 黙って空にしない。もう1度変えれば送り直す
            preview = {
                total: 0,
                skipped: 0,
                programs: [],
                conflicts: 0,
                verdicts: {},
                failed: String(error),
            };
            shownKey = null;
        } finally {
            inflight = false;
        }
        if (queued) {
            queued = false;
            await count();
        } else {
            counting = false;
        }
    }

    /** 条件・一覧の行・読み直しのどれかが変わったら、少し待ってから数え直す */
    $effect(() => {
        void body();
        void refresh;
        clearTimeout(timer);
        timer = setTimeout(() => void count(), PREVIEW_DELAY);
        return () => clearTimeout(timer);
    });
    /** 読み直したら、条件が同じでも数え直す (行の予約の状態が変わる) */
    $effect(() => {
        void refresh;
        shownKey = null;
    });

    /** 保存すると録る数。同じ回の2回目など、録らないものは除く */
    const recordable = $derived(
        preview === null || preview.failed !== null ? null : preview.total - preview.skipped,
    );

    // ---- 保存 ----
    /** 足した・直したルール。書く欄の下にそのルールへの入口を出す */
    let saved = $state<{ id: number; name: string; created: boolean } | null>(null);
    const saving: SubmitFunction =
        () =>
        async ({ result, update }) => {
            await update({ reset: false });
            if (result.type === 'success' && result.data?.['saved']) {
                saved = result.data['saved'] as { id: number; name: string; created: boolean };
            }
        };
    /**
     * 直しているルールを消したら、`?rule=` を外して出直す。残すと、無くなったルールの画面が
     * 新しいルールの欄に化けて見える。戻る先の履歴にも残さない。「削除しました」は移ったあとに当てる
     */
    const leaveDeleted: SubmitFunction =
        () =>
        async ({ result, update }) => {
            if (result.type !== 'success') return update();
            const url = new URL(page.url.href);
            url.searchParams.delete('rule');
            await goto(url, { replaceState: true });
            await applyAction(result);
        };

    // ---- 局とジャンル ----
    /** 局は50以上あるので種別ごとにまとめる */
    const grouped = $derived(
        ['GR', 'BS', 'CS', 'SKY']
            .map((type) => ({ type, services: draft.services.filter((s) => s.type === type) }))
            .filter((g) => g.services.length > 0),
    );
    const serviceSummary = $derived.by(() => {
        if (serviceTypes.length + serviceIds.length === 0) return '全局';
        const names = [
            ...serviceTypes.map((type) => SERVICE_TYPE_LABEL[type] ?? type),
            ...serviceIds.map((id) => draft.services.find((s) => s.id === id)?.name ?? String(id)),
        ];
        return names.length <= 2 ? names.join('・') : `${names.length} 件`;
    });
</script>

<aside class="draft" class:open aria-label="ルールとして保存" data-testid="rule-draft">
    <div class="draft-head">
        <div>
            {#if draft.editing !== null}
                <p class="eyebrow small" data-testid="rule-mode">
                    <span class="muted">編集中:</span> <span class="bold">{draft.editing.name}</span>
                    {#if !draft.editing.enabled}<span class="tag">無効</span>{/if}
                </p>
                <h2>ルールを直す</h2>
            {:else}
                <p class="eyebrow small muted">この検索を</p>
                <h2>ルールとして保存</h2>
            {/if}
        </div>
        <!-- 狭い画面だけ。下から出した欄を閉じる -->
        <button
            type="button"
            class="ghost close"
            aria-label="閉じる"
            onclick={() => (open = false)}
            data-testid="rule-draft-close"
        >
            <Icon icon={X} size="size-4" />
        </button>
    </div>

    {#if draft.origin !== null}
        {@const what = draft.origin.kind === 'recording' ? '録画' : '番組'}
        <!-- 録画・番組から来たとき。このシリーズを既に録っているルールがあれば、作らずにそちらを案内する -->
        {#if !draft.origin.found}
            <p class="notice warning small" data-testid="rule-origin">{what}が見つかりませんでした</p>
        {:else if draft.origin.rule !== null}
            <p class="notice info small" data-testid="rule-origin">
                この番組はルール「<a
                    href={resolve(`search?rule=${draft.origin.rule.id}`)}
                    data-testid="rule-origin-link">{draft.origin.rule.name}</a
                >」で録っています{draft.origin.rule.enabled ? '' : ' (いまは無効)'}
            </p>
        {:else}
            <p class="notice info small" data-testid="rule-origin">
                {what}「<span class="broadcast">{draft.origin.name}</span>」のシリーズ名から始めました
            </p>
        {/if}
    {/if}

    <form
        method="POST"
        action={draft.editing === null ? '?/createRule' : '?/updateRule'}
        id="rule-draft-form"
        class="draft-body"
        data-testid="rule-form"
        use:submitting={saving}
    >
        {#if draft.editing !== null}
            <input type="hidden" name="id" value={draft.editing.id} />
        {/if}
        <label class="field">
            <span class="field-label">キーワード</span>
            <input
                name="keyword"
                bind:value={keyword}
                oninput={() => (typed = true)}
                placeholder="例: 名探偵"
                data-testid="rule-keyword"
            />
        </label>
        <!-- 当てる範囲。既定は番組名だけ。概要まで広げると番宣で名前が出ただけの番組まで当たる -->
        <div class="chips" role="group" aria-label="キーワードを探す所" data-testid="rule-search-fields">
            {#each SEARCH_FIELDS as field (field)}
                <label class="chip">
                    <input type="checkbox" name="searchFields" value={field} bind:group={searchFields} />
                    {SEARCH_FIELD_LABEL[field]}
                </label>
            {/each}
        </div>
        <label class="field">
            <span class="field-label">除外する言葉</span>
            <input
                name="ignoreKeyword"
                bind:value={ignoreKeyword}
                placeholder="例: 再放送 総集編"
                data-testid="rule-ignore"
            />
        </label>

        <!-- 局・同じ回・優先度・ジャンルは枠の無い行に (サイドバーの行と同じ形)。名前は左、いまの値は右 -->
        <div class="rows side-list">
            <details class="row picker">
                <summary class="side-item" data-testid="channel-summary">
                    <span>局</span>
                    <span class="value">{serviceSummary}</span>
                </summary>
                <div class="picker-body">
                    <div class="group-title">まとめて選ぶ</div>
                    <div class="chips" data-testid="rule-types">
                        {#each grouped as group (group.type)}
                            <label class="chip">
                                <input
                                    type="checkbox"
                                    name="serviceTypes"
                                    value={group.type}
                                    bind:group={serviceTypes}
                                />
                                {SERVICE_TYPE_LABEL[group.type] ?? group.type} ({group.services.length})
                            </label>
                        {/each}
                    </div>
                    <div class="group-title">個別に選ぶ</div>
                    <div class="pick-list" data-testid="rule-services">
                        {#each grouped as group (group.type)}
                            <div>
                                <div class="group-title">{SERVICE_TYPE_LABEL[group.type] ?? group.type}</div>
                                {#each group.services as service (service.id)}
                                    <label class="check">
                                        <input
                                            type="checkbox"
                                            name="serviceIds"
                                            value={service.id}
                                            bind:group={serviceIds}
                                        />
                                        <span class="truncate small broadcast">{service.name}</span>
                                    </label>
                                {/each}
                            </div>
                        {:else}
                            <p class="small muted">
                                局がまだありません。<a href={`${resolve('settings/reception')}#channels`}
                                    >チャンネルスキャン</a
                                >をしてください。
                            </p>
                        {/each}
                    </div>
                </div>
            </details>
            <label class="row side-item">
                <span>同じ回は最初の放送だけ</span>
                <!-- 外したスイッチは何も送らない。「外した」と「指定なし」を分けるための隠し (`rule-form.dedupeOf`) -->
                <input type="hidden" name="dedupe" value="0" />
                <input
                    type="checkbox"
                    role="switch"
                    aria-checked={dedupe}
                    name="dedupe"
                    value="1"
                    bind:checked={dedupe}
                    data-testid="rule-dedupe"
                />
            </label>
            <label class="row side-item">
                <span>優先度 <span class="tiny muted">(大きいほうを先に録る)</span></span>
                <select name="priority" bind:value={priority} data-testid="rule-priority">
                    {#each [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as value (value)}
                        <option {value}>{value}</option>
                    {/each}
                </select>
            </label>
            <!-- ジャンルは畳んでおく (シリーズ名で足りる)。データとしては残している -->
            <details class="row picker">
                <summary class="side-item" data-testid="genre-summary">
                    <span>ジャンル</span>
                    <span class="value">{genres.length === 0 ? 'すべて' : `${genres.length} 件`}</span>
                </summary>
                <div class="picker-body pick-list" data-testid="rule-genres">
                    {#each GENRE_TREE as group (group.value)}
                        <div>
                            <label class="check">
                                <input
                                    type="checkbox"
                                    name="genres"
                                    value={group.value}
                                    bind:group={genres}
                                />
                                <span class="small bold">{group.label}</span>
                                <span class="tiny muted">(すべて)</span>
                            </label>
                            {#if group.children.length > 0}
                                <div class="children">
                                    {#each group.children as child (child.value)}
                                        <label class="check">
                                            <input
                                                type="checkbox"
                                                name="genres"
                                                value={child.value}
                                                bind:group={genres}
                                            />
                                            <span class="truncate tiny">{child.label}</span>
                                        </label>
                                    {/each}
                                </div>
                            {/if}
                        </div>
                    {/each}
                </div>
            </details>
        </div>
        <p class="tiny muted">
            録画のしかた{draft.freeOnly ? 'と、無料放送だけ録ること' : ''}は<a
                href={resolve('settings/recording')}>設定</a
            >で決めます
        </p>
    </form>

    <div class="draft-foot" aria-busy={counting}>
        <p class="small muted" role="status" data-testid="rule-draft-status">
            {#if empty}
                キーワードか局を入れると、一覧の番組を録るかどうかが出ます
            {:else if preview?.failed}
                数えられませんでした ({preview.failed})
            {:else if recordable === 0}
                いまの番組表では、この条件で録る番組はありません (これから出てくる番組に当てます)
            {:else}
                一覧では、録る番組は明るく、録らない番組は薄く出ます。条件を変えるとすぐ変わります
            {/if}
        </p>
        {#if saved !== null}
            <p class="notice success small" data-testid="rule-saved">
                {saved.created ? '保存しました' : '更新しました'}:
                <a href={resolve(`search?rule=${saved.id}`)} data-testid="rule-saved-link">{saved.name}</a>
            </p>
        {/if}
        {#if draft.editing !== null}
            <div class="edit-actions">
                <ActionButton
                    action="?/toggleRule"
                    fields={{ id: draft.editing.id }}
                    class="small secondary outline"
                    testid="rule-toggle"
                >
                    {draft.editing.enabled ? '無効化' : '有効化'}
                </ActionButton>
                <ArmedDelete
                    {deleting}
                    armKey={draft.editing.id}
                    action="?/deleteRule"
                    fields={{ id: draft.editing.id }}
                    submit={leaveDeleted}
                    class="small"
                    testid="rule-delete"
                />
            </div>
            <button
                type="submit"
                form="rule-draft-form"
                class="save"
                disabled={empty}
                data-testid="rule-update">更新</button
            >
        {:else}
            <button
                type="submit"
                form="rule-draft-form"
                class="save"
                disabled={empty}
                data-testid="rule-submit"
            >
                {recordable === null || recordable === 0
                    ? 'ルールを保存'
                    : `${recordable} 件を録るルールを保存`}
            </button>
        {/if}
    </div>
</aside>
<!-- 狭い画面で下から出しているときの後ろの幕。押すと閉じる -->
{#if open}
    <button
        type="button"
        class="sheet-backdrop"
        aria-label="閉じる"
        tabindex="-1"
        onclick={() => (open = false)}
    ></button>
{/if}

<style>
    /*
     * **広い画面 (1024px から) では右の列。** 画面の右端に付け、ヘッダーの下に貼り付けて、
     * 結果の一覧を下ろしても書く欄と保存のボタンは見えたまま。一覧とは線でも地の色でも分けず、余白だけで分ける (ほかの画面のサイドバーと同じ)。狭い画面で下から出すときだけ `--dp-surface` で塗る
     */
    .draft {
        display: flex;
        flex-direction: column;
        gap: var(--dp-space-4);
        min-width: 0;
        padding: var(--dp-space-5) var(--dp-space-5) 0;
        background: var(--dp-surface);
    }
    @media (min-width: 1024px) {
        .draft {
            position: sticky;
            background: var(--dp-bg);
            top: 3.5rem;
            height: calc(100dvh - 3.5rem);
            overflow-y: auto;
            /* 上は画面の頭の余白 (`--dp-page-top`)。最初の行を左の結果やほかの画面とそろえる */
            padding-top: var(--dp-page-top);
        }
        .close {
            display: none;
        }
    }
    /*
     * **狭い画面では下から出す** (`open`)。結果の一覧の上半分は見えたままなので、条件を変えると
     * 行の「録る / 録らない」が変わるのも見える。下のタブより上に重ねる
     */
    @media (max-width: 1023.98px) {
        .draft {
            position: fixed;
            inset: auto 0 0;
            z-index: 60;
            max-height: 80dvh;
            overflow-y: auto;
            border-top: 1px solid var(--dp-line);
            border-radius: var(--dp-radius-lg) var(--dp-radius-lg) 0 0;
            box-shadow: var(--dp-shadow-pop);
            padding-bottom: env(safe-area-inset-bottom);
            transform: translateY(100%);
            visibility: hidden;
            transition:
                transform var(--dp-duration) var(--dp-ease),
                visibility 0s linear var(--dp-duration);
        }
        .draft.open {
            transform: none;
            visibility: visible;
            transition: transform var(--dp-duration) var(--dp-ease);
        }
        .sheet-backdrop {
            position: fixed;
            inset: 0;
            z-index: 59;
            margin: 0;
            padding: 0;
            border: 0;
            border-radius: 0;
            background: var(--dp-backdrop);
        }
    }
    .draft-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--dp-space-3);
    }
    .draft-head h2 {
        margin: 0;
        font-size: var(--dp-text-lg);
    }
    .eyebrow {
        margin: 0 0 0.125rem;
        overflow-wrap: anywhere;
    }
    .close {
        width: auto;
        margin: 0;
        padding: var(--dp-space-1);
    }
    .draft-body {
        display: flex;
        flex-direction: column;
        gap: var(--dp-space-3);
        margin: 0;
    }
    .field {
        display: flex;
        flex-direction: column;
        gap: var(--dp-space-1);
        margin: 0;
    }
    .field-label {
        font-size: var(--dp-text-sm);
        color: var(--dp-muted);
    }
    .field input {
        margin: 0;
    }
    /*
     * 局・同じ回・優先度・ジャンル。枠の箱にも線にもせず、サイドバーの行 (`app.css` の `.side-item`) と同じ形。
     * 行の塗りは左右に字の余白ぶんはみ出し、字の頭は上の欄の頭にそろえる
     */
    .rows {
        margin-inline: -0.75rem;
        padding: 0;
    }
    .row {
        margin: 0;
    }
    label.row,
    .row > summary {
        cursor: pointer;
    }
    .row > summary::after {
        flex-shrink: 0;
        float: none;
        margin-inline-start: 0;
    }
    .chips .chip {
        width: auto;
    }
    .value {
        margin-inline-start: auto;
        color: var(--dp-muted);
        text-align: end;
    }
    label.row input[role='switch'] {
        margin: 0;
    }
    label.row select {
        width: auto;
        margin: 0;
        padding-block: 0.25rem;
        border: 0;
        background-color: transparent;
        color: var(--dp-muted);
        text-align: end;
    }
    .picker-body {
        display: flex;
        flex-direction: column;
        gap: var(--dp-space-2);
        padding: var(--dp-space-1) 0.75rem var(--dp-space-3);
    }
    .group-title {
        font-size: var(--dp-text-xs);
        color: var(--dp-muted);
    }
    .pick-list {
        display: flex;
        flex-direction: column;
        gap: var(--dp-space-2);
    }
    .pick-list .check {
        display: flex;
        margin: 0.125rem 0;
    }
    .children {
        margin-inline-start: 1.5rem;
    }
    /* 保存は列の下に貼り付ける。条件が長くても探して降りずに済む */
    .draft-foot {
        position: sticky;
        bottom: 0;
        display: flex;
        flex-direction: column;
        gap: var(--dp-space-3);
        margin-top: auto;
        padding-block: var(--dp-space-3) var(--dp-space-5);
        background: var(--dp-surface);
    }
    @media (min-width: 1024px) {
        .draft-foot {
            background: var(--dp-bg);
        }
    }
    /*
     * **数えている間 (`aria-busy`) も形を変えない。** Pico の `aria-busy` は1行の字に回るものを付ける前提で、
     * `white-space: nowrap` と `::before` の回るものを足す。ここは字の段落とボタンを縦に並べた箱なので、
     * 案内の字が1行に伸びて列の幅からはみ出し (列が横にスクロールできてしまう)、回るものも1行ぶん場所を取る。
     * 開いた直後の1回目の下見でも、数え終わるまでの一瞬だけ崩れて見えていた
     */
    .draft-foot[aria-busy='true'] {
        white-space: normal;
    }
    .draft-foot[aria-busy='true']::before {
        display: none;
    }
    .draft-foot p {
        margin: 0;
    }
    .edit-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--dp-space-2);
    }
    .save {
        width: 100%;
        margin: 0;
        border-radius: var(--dp-radius-full);
    }
</style>
