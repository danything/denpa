<script lang="ts">
    /**
     * 時間軸の1行 (予約・録画・録り逃し)。どれも同じ形にする: 左に時刻、(録れたものは) ポスター、
     * 状態と番組名と局・尺、右に押すもの。行は 48px で、言うことがあるときだけ下に1段足す
     * (黙っていると「録れたつもり」になるもの: 競合・欠ける・ロゴでCMを判定できなかった)
     */
    import ActionButton from '#lib/components/ActionButton.svelte';
    import ArmedDelete from '#lib/components/ArmedDelete.svelte';
    import Icon from '#lib/components/player/Icon.svelte';
    import { encodeLive } from '#lib/encode-live.svelte.js';
    import {
        badgeClass,
        clipNote,
        date,
        duration,
        durationMs,
        eta,
        logoUnusable,
        percent,
        quietState,
        recordedDuration,
        rowState,
        stateLabel,
        time,
    } from '#lib/format.js';
    import { offline, removeLocal } from '#lib/offline.svelte.js';
    import { resolve } from '$app/paths';
    import Info from '~icons/lucide/info';
    import Play from '~icons/lucide/play';
    import X from '~icons/lucide/x';
    import { home, type Item, pickOn } from './context';
    import Poster from './Poster.svelte';
    import RowMeta from './RowMeta.svelte';
    import RowTitle from './RowTitle.svelte';

    /** `nested` はまとめて表示の番組の中の行 (一段下げる) */
    let { item, nested = false }: { item: Item; nested?: boolean } = $props();
    const ctx = home();
</script>

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
        class:picked={ctx.pickedKey === item.key}
        {@attach pickOn(ctx, item.key)}
    >
        {@render clockCell(res, true)}
        <div class="row-body" data-testid="row-body">
            <RowTitle
                state={stateLabel(res.state)}
                badge={badgeClass(res.state)}
                name={res.name}
                testid="reservation-state"
                open={() => {
                    ctx.select(item.key);
                    ctx.openReservation(res);
                }}
                quiet={quietState(res.state)}
            />
            <RowMeta service={res.service_name} parts={[duration(res.start_at, res.end_at)]} row={res} rule={res.manual ? null : res} />
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
            {#if ctx.cancelable(res)}
                <ActionButton action="?/cancel" fields={{ id: res.id }} class="outline danger" testid="cancel-button">
                    <Icon icon={X} size="size-4" /><span class="btn-label">取消</span>
                </ActionButton>
            {:else if res.state === 'canceled' && res.end_at > ctx.clock}
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
        class:picked={ctx.pickedKey === item.key}
        {@attach pickOn(ctx, item.key)}
    >
        {@render clockCell(res, false)}
        <span class="t-thumb" aria-hidden="true"></span>
        <div class="row-body" data-testid="row-body">
            <RowTitle
                state={stateLabel('missed')}
                badge={badgeClass('missed')}
                name={res.name}
                testid="missed-state"
                open={() => {
                    ctx.select(item.key);
                    ctx.openMissed(res);
                }}
            />
            <RowMeta service={res.service_name} parts={[duration(res.start_at, res.end_at)]} row={res} rule={res.manual ? 'manual' : res} />
        </div>
        <div class="row-actions">
            <!-- 構えの鍵は負の値にして、録画のIDと混ざらないようにする (deleting は録画と共用) -->
            <ArmedDelete
                deleting={ctx.deleting}
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
    {@const link = ctx.watchLink(rec)}
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
        class:picked={ctx.pickedKey === item.key}
        {@attach pickOn(ctx, item.key)}
    >
        {@render clockCell(rec, false)}
        <!-- ポスター。無い録画もあるので、読めなければ画像を隠して枠だけ残す。再生の印は観られるものだけ -->
        <span class="t-thumb" data-testid={link === null ? undefined : 'play-hint'} aria-hidden="true">
            {#if rec.library_path !== null}
                <Poster id={rec.id} />
            {/if}
            {#if link !== null}
                <span class="t-play"><Play class="poster-icon" /></span>
            {/if}
        </span>
        <div class="row-body" data-testid="row-body">
            <RowTitle
                state={shown.label}
                badge={shown.badge}
                name={rec.name}
                testid="recording-state"
                open={link ??
                    (() => {
                        ctx.select(item.key);
                        ctx.openRecording(rec);
                    })}
                fresh={ctx.unwatched(rec)}
                quiet={shown.quiet}
            />
            <RowMeta
                service={rec.service_name}
                parts={[
                    recordedDuration(rec),
                    ctx.sizeLabel(rec),
                    rec.deleted_at !== null ? `${date(rec.deleted_at)} に削除` : '',
                ]}
                row={rec}
                rule={rec.from_manual === null ? null : rec.from_manual ? 'manual' : rec}
            />
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
                        ctx.select(item.key);
                        ctx.openRecording(rec);
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
                        deleting={ctx.deleting}
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

{@render itemRow(item, nested)}
