<script lang="ts">
    /**
     * 時間軸の1行 (予約・録画・録り逃し)。どれも同じ形にする: 左に時刻、(録れたものは) ポスター、
     * 時刻と番組名、局と尺、右に押すもの。行は 48px で、状態を言うときだけ下に段を足す (`RowActivity`。2段まで):
     * いま動いているもの (録画中・エンコード中・端末に保存中) と、黙っていると「録れたつもり」になるもの
     * (競合・失敗・欠ける・ロゴでCMを判定できなかった)
     */
    import { submitting } from '#lib/actions.js';
    import ActionButton from '#lib/components/ActionButton.svelte';
    import ArmedDelete from '#lib/components/ArmedDelete.svelte';
    import Menu from '#lib/components/Menu.svelte';
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
        recordingLeft,
        rowState,
        size,
        stateLabel,
    } from '#lib/format.js';
    import { offline, removeLocal } from '#lib/offline.svelte.js';
    import { type RowStatus, statusLines, toneOf } from '#lib/row-status.js';
    import type { SubmitFunction } from '$app/forms';
    import { resolve } from '$app/paths';
    import Ellipsis from '~icons/lucide/ellipsis';
    import Info from '~icons/lucide/info';
    import Play from '~icons/lucide/play';
    import Trash from '~icons/lucide/trash-2';
    import X from '~icons/lucide/x';
    import { home, type Item, type Rec, type Res } from './context';
    import Poster from './Poster.svelte';
    import RowActivity from './RowActivity.svelte';
    import RowMeta from './RowMeta.svelte';
    import RowTitle from './RowTitle.svelte';

    /** `nested` はまとめて表示の番組の中の行 (一段下げる) */
    let { item, nested = false }: { item: Item; nested?: boolean } = $props();
    const ctx = home();

    /**
     * 置き場の使用量。**主 (AV1) を先に出し、在るものだけ括弧に添える。**
     *
     * `ts_size` が持っているのは主のぶんだけなので、両方エンコードした録画では画面の
     * 数字と実際に使っている量が食い違っていた (H.264 のほうが大きいことも
     * ある)。「消していいのか、どれだけ空くのか」を1行で読めるようにする
     */
    function sizeLabel(rec: Rec): string {
        const extra = [
            rec.alt_size === null ? '' : `H.264 ${size(rec.alt_size)}`,
            rec.raw_size === null ? '' : `元のTS ${size(rec.raw_size)}`,
        ].filter((s) => s !== '');
        return extra.length === 0 ? size(rec.ts_size) : `${size(rec.ts_size)} (${extra.join('、')})`;
    }

    /** 消し終えたら、端末に落としてあったコピーも片付ける (行の削除と「⋯」の削除で同じ) */
    function afterDelete(rec: Rec): SubmitFunction {
        return () => async (options) => {
            await options.update();
            if (options.result.type === 'success' && offline.entries[rec.id] !== undefined) {
                void removeLocal(rec.id);
            }
        };
    }

    /** 欠けたぶん (チューナー不足)。録れたものは「欠けています」、これからのものは「欠けます」 */
    function clipLine(row: Parameters<typeof clipNote>[0], done = false): RowStatus[] {
        const note = clipNote(row, done);
        return note === null ? [] : [{ kind: 'clip', tone: 'warning', label: note }];
    }

    /**
     * 予約の行の段。録画中は「● 録画中・あと21分」(あと何分かは `ctx.clock` で進む)。
     * 見てほしい状態 (競合・失敗・録画しない・取り消し済み) は理由と1段に
     */
    function resLines(res: Res, live: boolean): RowStatus[] {
        const activities: RowStatus[] = live
            ? [
                  {
                      kind: 'recording',
                      tone: 'rec',
                      running: true,
                      label: stateLabel('recording'),
                      detail: recordingLeft(ctx.clock, res.end_at),
                      testid: 'reservation-state',
                  },
              ]
            : [];
        const problems: RowStatus[] =
            live || quietState(res.state)
                ? []
                : [
                      {
                          kind: res.state,
                          tone: toneOf(badgeClass(res.state)),
                          label: stateLabel(res.state),
                          detail: res.conflict_reason,
                          testid: 'reservation-state',
                      },
                  ];
        return statusLines(activities, [...problems, ...clipLine(res)]);
    }

    /**
     * 録画の行の段。動いているもの (エンコード・待ち・録画中・端末に保存中) が先、
     * 問題 (失敗・欠けた・ロゴでCMを判定できなかった・端末に保存できなかった) が後
     */
    function recLines(rec: Rec): RowStatus[] {
        const shown = rowState(rec);
        const held = offline.entries[rec.id];
        const activities: RowStatus[] = [];
        const problems: RowStatus[] = [];
        if (rec.job_state === 'queued' || rec.job_state === 'running') {
            const queued = rec.job_state === 'queued';
            const encoding = !queued && rec.job_phase === 'encode';
            activities.push({
                kind: queued ? 'queued' : 'encode',
                tone: queued ? 'wait' : 'busy',
                running: !queued,
                label: shown.label,
                detail: encoding ? encodeDetail(rec) : queued ? null : rec.job_log,
                testid: 'recording-state',
                detailTestid: encoding ? 'encode-progress' : undefined,
            });
        } else if (rec.state === 'recording') {
            activities.push({
                kind: 'recording',
                tone: 'rec',
                running: true,
                label: shown.label,
                detail: recordingLeft(ctx.clock, rec.end_at),
                testid: 'recording-state',
            });
        } else if (!shown.quiet) {
            problems.push({
                kind: rec.state,
                tone: toneOf(shown.badge),
                label: shown.label,
                // 録画の失敗は短い理由を添える。エンコードの失敗は ffmpeg の長い字なので詳細だけ
                detail: rec.state === 'failed' ? rec.error : null,
                testid: 'recording-state',
            });
        }
        if (held?.state === 'downloading') {
            activities.push({
                kind: 'download',
                tone: 'ok',
                running: true,
                label: '端末に保存中',
                detail: held.progress === null ? null : percent(held.progress),
            });
        } else if (held?.state === 'ready') {
            problems.push({ kind: 'saved', tone: 'ok', label: '端末に保存済み' });
        } else if (held?.state === 'failed') {
            problems.push({ kind: 'save-failed', tone: 'error', label: '端末に保存できませんでした', detail: '詳細からやり直せます' });
        }
        problems.push(...clipLine(rec, true));
        if (logoUnusable(rec.cm_note) && rec.deleted_at === null) {
            // 覚えたロゴは設定の「チャンネル」の「CMロゴ」で確かめられる
            problems.push({
                kind: 'logo',
                tone: 'warning',
                label: 'ロゴでCMを判定できませんでした',
                detail: '無音だけで判定。覚えたロゴは設定の「チャンネル」の「CMロゴ」で確かめられます',
            });
        }
        return statusLines(activities, problems);
    }

    /** 「45.0%・あと3分04秒」。SSE の生放送 (encode-live) があればそちら。読み直しを待たずに動く */
    function encodeDetail(rec: Rec): string {
        const live = encodeLive.entries[rec.id];
        const left = eta(live !== undefined ? live.etaMs : rec.job_eta_ms);
        const done = percent(live?.percent ?? rec.job_percent ?? 0);
        return left === '' ? done : `${done}・${left}`;
    }
</script>

<!-- 予約の行 (これから・録画中・「完了した予約も表示」で出る終わった予約) -->
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
    >
        <div class="row-body" data-testid="row-body">
            <RowTitle
                start={res.start_at}
                end={res.end_at}
                state={quietState(res.state) ? stateLabel(res.state) : undefined}
                name={res.name}
                testid="reservation-state"
                open={() => {
                    ctx.select(item.key);
                    ctx.openReservation(res);
                }}
            />
            <RowMeta service={res.service_name} parts={[duration(res.start_at, res.end_at)]} row={res} rule={res.manual ? null : res} excerpt={res.description} />
            {#each resLines(res, item.zone === 'now') as status (status.kind)}
                <RowActivity {status} />
            {/each}
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
        <!-- 録画中は、録り終わるまでの進みを行の下端に敷く (あと何分かは3段目が言う) -->
        {#if item.zone === 'now' && res.end_at > res.start_at}
            <progress
                class="row-bar rec"
                value={Math.min(1, Math.max(0, (ctx.clock - res.start_at) / (res.end_at - res.start_at)))}
                max="1"
                aria-label="録画の進み"
                data-testid="recording-progress"
            ></progress>
        {/if}
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
    >
        <span class="t-thumb" aria-hidden="true"></span>
        <div class="row-body" data-testid="row-body">
            <RowTitle
                start={res.start_at}
                end={res.end_at}
                name={res.name}
                testid="missed-state"
                open={() => {
                    ctx.select(item.key);
                    ctx.openMissed(res);
                }}
            />
            <RowMeta service={res.service_name} parts={[duration(res.start_at, res.end_at)]} row={res} rule={res.manual ? 'manual' : res} excerpt={res.description} />
            <RowActivity status={{ kind: 'missed', tone: 'warning', label: stateLabel('missed'), testid: 'missed-state' }} />
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
    {@const lines = recLines(rec)}
    {@const held = offline.entries[rec.id]}
    {@const canDelete = rec.deleted_at === null && rec.job_id === null}
    <!--
        **途中まで観たものは残りを出す。** 観た位置は続きから始めるために持っていて、末尾まで観たものは
        消えるので、残っている = まだ途中。ポスターの下端に細いバー、2段目に「残り何分」
    -->
    {@const progress = link !== null && rec.deleted_at === null ? rec.progress : null}
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
    >
        <!-- ポスター。無い録画もあるので、読めなければ画像を隠して枠だけ残す。再生の印は観られるものだけ -->
        <span class="t-thumb" data-testid={link === null ? undefined : 'play-hint'} aria-hidden="true">
            {#if rec.library_path !== null}
                <Poster id={rec.id} />
            {/if}
            {#if link !== null}
                <span class="t-play"><Play class="poster-icon" /></span>
            {/if}
            {#if progress !== null}
                <span class="t-resume" data-testid="resume"
                    ><span class="resume-fill" style="width: {(progress.length > 0 ? Math.min(1, progress.at / progress.length) : 0) * 100}%"></span
                ></span>
            {/if}
        </span>
        <div class="row-body" data-testid="row-body">
            <RowTitle
                start={rec.start_at}
                end={rec.end_at}
                state={shown.quiet ? shown.label : undefined}
                name={rec.name}
                testid="recording-state"
                open={link ??
                    (() => {
                        ctx.select(item.key);
                        ctx.openRecording(rec);
                    })}
                fresh={ctx.unwatched(rec)}
            />
            <RowMeta
                service={rec.service_name}
                parts={[
                    recordedDuration(rec),
                    sizeLabel(rec),
                    rec.deleted_at !== null ? `${date(rec.deleted_at)} に削除` : '',
                    progress === null ? '' : `残り${durationMs(Math.max(0, progress.length - progress.at))}`,
                ]}
                row={rec}
                rule={rec.from_manual === null ? null : rec.from_manual ? 'manual' : rec}
                excerpt={rec.description}
            />
            {#each lines as status (status.kind)}
                <RowActivity {status} />
            {/each}
        </div>
        <div class="row-actions">
            {#if link !== null || canDelete}
                <!--
                    **狭い画面では「⋯」1つにまとめる。** 詳細と削除のアイコンを2つ並べると、番組名が5文字ほどで
                    切れていた。中身は詳細と削除 (削除は1回目で聞き返す。行の削除と同じ構え `deleting`)
                -->
                <div class="row-more">
                    <Menu side="bottom" align="end" class="row-menu" testid="row-menu">
                        {#snippet trigger(props)}
                            <button {...props} type="button" class="ghost icon" title="操作" data-testid="row-more">
                                <Icon icon={Ellipsis} size="size-4" /><span class="visually-hidden">操作</span>
                            </button>
                        {/snippet}
                        <button
                            type="button"
                            role="menuitem"
                            class="menu-item"
                            onclick={() => {
                                ctx.select(item.key);
                                ctx.openRecording(rec);
                            }}
                            data-testid="row-menu-detail"
                        >
                            <Icon icon={Info} size="size-4" />詳細
                        </button>
                        {#if canDelete}
                            <form
                                method="POST"
                                action="?/delete"
                                class="menu-form"
                                use:submitting={(input) => {
                                    const after = afterDelete(rec)(input);
                                    return async (options) => {
                                        if (typeof after === 'function') await after(options);
                                        ctx.deleting.fire();
                                    };
                                }}
                            >
                                <input type="hidden" name="id" value={rec.id} />
                                {#if ctx.deleting.armed === rec.id}
                                    <button type="submit" role="menuitem" class="menu-item menu-danger" data-testid="row-menu-delete-confirm">
                                        <Icon icon={Trash} size="size-4" />削除を確定
                                    </button>
                                {:else}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        class="menu-item"
                                        data-keep-open
                                        onclick={() => ctx.deleting.arm(rec.id)}
                                        data-testid="row-menu-delete"
                                    >
                                        <Icon icon={Trash} size="size-4" />削除
                                    </button>
                                {/if}
                            </form>
                        {/if}
                    </Menu>
                </div>
            {/if}
            {#if link !== null}
                <!-- 行を押すと再生なので、中身を読む入口は別に置く。観られない行は行そのものが詳細の入口 -->
                <button
                    type="button"
                    class="secondary outline icon row-wide"
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
                    <!-- 動いている間は中断だけ。裏で ffmpeg が元のTSを読んでいるので、消させると道連れになる。
                        狭い画面はアイコンだけ (3段目のエンコードの進みに幅を回す。字は読み上げに残す) -->
                    {#if rec.job_canceling}
                        <button type="button" class="outline danger" disabled aria-busy="true" data-testid="encode-cancel">
                            <Icon icon={X} size="size-4" /><span class="btn-label">エンコード中断</span>
                        </button>
                    {:else}
                        <ActionButton action="?/cancelEncode" fields={{ id: rec.job_id }} class="outline danger" testid="encode-cancel">
                            <Icon icon={X} size="size-4" /><span class="btn-label">エンコード中断</span>
                        </ActionButton>
                    {/if}
                {:else}
                    <!-- サーバから消したら、端末に落としてあったコピーも片付ける。狭い画面では「⋯」の中 -->
                    <div class="row-wide">
                        <ArmedDelete
                            deleting={ctx.deleting}
                            armKey={rec.id}
                            fields={{ id: rec.id }}
                            submit={afterDelete(rec)}
                            testid="delete-button"
                            confirmTestid="delete-confirm"
                            icon
                        />
                    </div>
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
