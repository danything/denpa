<script lang="ts">
    /**
     * **右のサイドバー「今やること・観るもの」** (1000px 以上)。ウィンドウの端まで寄せ、1px の線で分けて、
     * 一覧とは別に巻き取る。並びはドキュメントの目次と同じ作り (小さく沈めた見出し・線の無い行)。
     *
     * 1. 続きから観る … 途中まで観た・まだ観ていない録画を新しい順に。押せばその場で続きから
     * 2. 録画中 … いま録っているものと「追っかけ」
     * 3. 見てほしいこと … 競合・失敗・CM の判定ができなかったもの。押すと一覧をそれで絞る。無ければ節ごと出さない
     * 4. 状態 … エンコードの進み (あと何分か)・次の録画・空き (あと何時間録れるか)
     *
     * 中身はホームが読んだものから作る (問い合わせは足さない)。指を乗せたときだけ出るものは置かない
     */
    import Icon from '#lib/components/player/Icon.svelte';
    import { encodeLive } from '#lib/encode-live.svelte.js';
    import { eta, percent, time } from '#lib/format.js';
    import type { Filter } from '#lib/timeline.js';
    import { resolve } from '$app/paths';
    import ChevronRight from '~icons/lucide/chevron-right';
    import { home, type Rec, type Res, watchLeft } from './context';
    import Poster from './Poster.svelte';

    let {
        watchNext,
        recording,
        attention,
        encoding,
        nextRes,
        capacity,
        setFilter,
    }: {
        /** 続きから観る録画 (新しい順。多くて 6 本) */
        watchNext: Rec[];
        /** 録画中の予約 */
        recording: Res[];
        /** 見てほしいことの件数 (`countFilters` の `attention`・`conflict`・`failed`・`cmlogo`) */
        attention: { all: number; conflict: number; failed: number; cmlogo: number };
        /** エンコードを待っている・している録画 */
        encoding: Rec[];
        nextRes: Res | null;
        capacity: { free: string; hours: string | null } | null;
        setFilter: (next: Filter) => void;
    } = $props();
    const ctx = home();
</script>

<aside class="t-side" aria-label="今やること・観るもの" data-testid="sidebar">
    {#if watchNext.length > 0}
        <h2 class="s-group s-first">続きから観る</h2>
        <ul class="s-list a-watch">
            {#each watchNext as rec (rec.id)}
                <li>
                    <a class="s-item a-watch-item" href={ctx.watchLink(rec)} data-testid="continue-item">
                        <span class="a-poster" aria-hidden="true">
                            {#if rec.library_path !== null}<Poster id={rec.id} />{/if}
                            {#if rec.progress !== null && rec.progress.length > 0}
                                <span class="t-resume"
                                    ><span class="resume-fill" style="width: {Math.min(1, rec.progress.at / rec.progress.length) * 100}%"></span
                                ></span>
                            {/if}
                        </span>
                        <span class="a-text">
                            <span class="a-title broadcast">{rec.name}</span>
                            <span class="a-sub num">{watchLeft(rec)}</span>
                        </span>
                    </a>
                </li>
            {/each}
        </ul>
    {/if}

    {#if recording.length > 0}
        <h2 class="s-group">録画中 <span class="a-count num">{recording.length}</span></h2>
        <ul class="s-list">
            {#each recording as res (res.id)}
                <li class="s-item a-static">
                    <span class="a-text">
                        <span class="a-title broadcast"><span class="rec-dot" aria-hidden="true"></span> {res.name}</span>
                        <span class="a-sub num">{time(res.start_at)}–{time(res.end_at)}</span>
                    </span>
                    {#if res.recording_id !== null}
                        <a class="button small" href={resolve(`chase/${res.recording_id}`)} data-testid="aside-chase">追っかけ</a>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}

    {#if attention.all > 0}
        <h2 class="s-group">見てほしいこと <span class="a-count alert num" data-testid="attention-count">{attention.all}</span></h2>
        <ul class="s-list">
            {#each [{ id: 'conflict', label: '競合している予約', n: attention.conflict }, { id: 'failed', label: '失敗・録り逃し', n: attention.failed }, { id: 'cmlogo', label: 'ロゴで CM を判定できなかった', n: attention.cmlogo }] as const as row (row.id)}
                {#if row.n > 0}
                    <li>
                        <button
                            type="button"
                            class="s-item"
                            onclick={() => setFilter(row.id)}
                            data-testid="attention-item"
                            data-filter={row.id}
                        >
                            <span>{row.label}</span>
                            <span class="a-sub num">{row.n}<Icon icon={ChevronRight} size="size-4" /></span>
                        </button>
                    </li>
                {/if}
            {/each}
        </ul>
    {/if}

    <h2 class="s-group">状態</h2>
    <dl class="s-list a-state" data-testid="summary">
        {#each encoding as rec (rec.id)}
            {@const live = encodeLive.entries[rec.id]}
            {@const left = live !== undefined ? live.etaMs : rec.job_eta_ms}
            <div class="s-item a-static">
                <dt class="a-title broadcast">{rec.name}</dt>
                <dd class="a-sub num" data-testid="aside-encode">
                    {#if rec.job_state === 'running'}
                        {percent(live?.percent ?? rec.job_percent ?? 0)}{#if eta(left)}・{eta(left)}{/if}
                    {:else}
                        エンコード待ち
                    {/if}
                </dd>
            </div>
        {/each}
        <div class="s-item a-static">
            <dt>次の録画</dt>
            <dd class="a-sub num">{nextRes === null ? 'なし' : `${time(nextRes.start_at)}・${ctx.untilLabel(nextRes.start_at)}`}</dd>
        </div>
        {#if capacity !== null}
            <div class="s-item a-static">
                <dt>空き</dt>
                <dd class="a-sub num" data-testid="recordings-capacity">
                    {capacity.free.replace(/^空き\s*/, '')}{capacity.hours === null ? '' : `・${capacity.hours}`}
                </dd>
            </div>
        {/if}
    </dl>
</aside>
