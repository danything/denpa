<script lang="ts">
    import { submitting } from '#lib/actions.js';
    import ActionButton from '#lib/components/ActionButton.svelte';
    import JobProgress from '#lib/components/JobProgress.svelte';
    import Lead from '#lib/components/Lead.svelte';
    import { SERVICE_TYPE_LABEL, STATE_LABEL as SHARED_STATE_LABEL } from '#lib/format.js';
    import type { PageData } from './$types';

    let { data }: { data: PageData } = $props();

    const scan = $derived(data.scan);

    /**
     * スキャンする種別の選び方。値はそのまま `types` で送る (「すべて」はカンマで3つ)。
     * 入れたばかりのときに要るのは地上波だけなので、それが先頭 (衛星は最初から局が入っている)
     */
    const SCAN_CHOICES = [
        { value: 'GR', label: SERVICE_TYPE_LABEL['GR'] },
        { value: 'BS', label: SERVICE_TYPE_LABEL['BS'] },
        { value: 'CS', label: SERVICE_TYPE_LABEL['CS'] },
        { value: 'GR,BS,CS', label: 'すべて' },
    ];
    /** スキャンの状態の呼び名。共通のものに、スキャンだけの2つを足す */
    const STATE_LABEL: Record<string, string> = { ...SHARED_STATE_LABEL, canceled: '中断', idle: '待機中' };

    /*
     * 物理チャンネルと、そこに入っている局。**denpa 自身のDBから来る。**
     * エージェントにも控えはあるが、聞きに行かない (+page.server.ts)
     */
    const coverage = $derived(data.channels);
    /** 入っている局をすべて並べたもの */
    const services = $derived(coverage.flatMap((channel) => channel.services));

    /** 番組表がどこまで埋まっているか。「8/9 まで」の形で出す */
    function until(at: number): string {
        const d = new Date(at);
        return `${d.getMonth() + 1}/${d.getDate()} まで`;
    }
</script>

<!--
    **スキャンは種別を選ぶ欄とボタンの1組。** 回っている間は「中断」に替わる。
    探す範囲は決め打ち (放送で使う物理チャンネルは決まっていて、狭めても総当たりの時間が少し減るだけ)
-->
{#snippet scanControl()}
    <form method="POST" action="?/scan" use:submitting class="scan-control">
        {#if scan.state === 'running'}
            <!--
                十数分かかるので、途中で降りられるようにしてある。中断しても設定は書き換えない
                (途中までの結果で上書きすると、まだ回っていない局の定義が消える)
            -->
            <button type="submit" class="small outline danger" formaction="?/scanStop">中断</button>
        {:else}
            <select name="types" aria-label="スキャンする種別">
                {#each SCAN_CHOICES as choice (choice.value)}
                    <option value={choice.value}>{choice.label}</option>
                {/each}
            </select>
            <button type="submit" class="small" data-testid="scan-start">スキャン</button>
        {/if}
    </form>
{/snippet}

<!--
    **スキャンも、受信できるチャンネルの節の中に。** 押すものは見出しの行にまとめ (スキャン・番組表)、
    回っている間の進み具合は見出しのすぐ下。チャンネルが1つも無いときは、空の表の場所の真ん中に
    スキャンの欄を出す (局が無いときの案内 `ChannelNotice` の行き先がここ)
-->
<div class="sections">
    <section class="section" data-testid="channel-card">
        <div class="section-head spread">
            <h2>受信できるチャンネル</h2>
            {#if coverage.length > 0}
                <div class="cluster">
                    {@render scanControl()}
                    <!--
                        入れたばかりのとき用。普段の周回は録画にもスキャンにもロゴにも
                        譲るので、何か動いていると番組表がなかなか埋まらない。
                        押されている間は録画以外には譲らせて、全チューナーで回る
                    -->
                    <ActionButton
                        action="?/collectNow"
                        class="small secondary outline"
                        disabled={data.collect.boosted}
                        testid="epg-collect-now"
                    >
                        {data.collect.boosted ? '集めています…' : '番組表をいますぐ集める'}
                    </ActionButton>
                </div>
            {/if}
        </div>

        {#if coverage.length > 0}
            <!-- 番組表がもう入っている局の数。下の表の右端を全部見なくても分かるように -->
            {@const withEpg = services.filter((service) => service.programs > 0).length}
            <!--
                **入れ子になった3つの数を、その順に並べる。** チャンネル (T19, BS15_0) の中に
                局 (TOKYO MX1, MX2) があり、局ごとに番組表がある。「50 / 59 ・ 124 局」とだけ
                出していた頃は、59 と 124 が同じものの数に見えた。局はスキャンで、番組表は
                そのあと denpa が集めるもので、埋まる時期がずれる (局はあるのに番組表が空、が普通にある)
            -->
            <div class="small" data-testid="channel-coverage">
                <span class="muted">チャンネル</span>
                <strong>{coverage.length}</strong>
                <span class="faint">→</span>
                <span class="muted">局</span>
                <strong>{services.length}</strong>
                <span class="faint">→</span>
                <span class="muted">番組表のある局</span>
                <strong>{withEpg}</strong>
            </div>
        {/if}

        {#if scan.state !== 'idle'}
            <!-- 総当たりなので何分かかるか分かりにくい。どこまで進んだかを出す -->
            <div class="progress-block" data-state={scan.state}>
                <div class="cluster small">
                    <span class="tag" data-testid="scan-state">{STATE_LABEL[scan.state]}</span>
                    {#if scan.phase}
                        <span class="tag outline">{scan.phase}</span>
                    {/if}
                    <span class="num" data-testid="scan-found">見つかったチャンネル {scan.channels}</span>
                </div>
                <JobProgress done={scan.scanned} total={scan.total} unit="チャンネル" testid="scan-count" />
                {#if scan.error}
                    <div class="notice error">{scan.error}</div>
                {/if}
                {#if scan.log.length > 0}
                    <details class="log">
                        <summary class="small">ログ ({scan.log.length} 行)</summary>
                        <pre data-testid="scan-log">{scan.log.join('\n')}</pre>
                    </details>
                {/if}
            </div>
        {/if}
        {#if data.collect.running}
            <!-- 1チャンネルに数分かかる。黙っていると止まって見える -->
            <div class="progress-block" data-testid="epg-collect">
                <div class="small muted num">
                    {data.collect.boosted ? '最優先で集めています' : '番組表を集めています'}
                    ({data.collect.active.join(', ') || '準備中'}) ・ 残り {data.collect.pending} チャンネル
                </div>
                <progress
                    class="running"
                    value={data.collect.total - data.collect.pending - data.collect.active.length}
                    max={Math.max(1, data.collect.total)}
                ></progress>
                {#if data.collect.sweeping}
                    <!-- 初回だけ。番組名が先に出て、詳細があとから埋まるのを不具合と思わせない -->
                    <div class="tiny muted">
                        BS は、まず1つの中継から全局の番組名を入れています (数分)。
                        番組内容・出演者などの詳細は、そのあと中継ごとに回って足します
                    </div>
                {/if}
            </div>
        {/if}

        <!-- **説明は1つだけ。** スキャンと番組表のことは「詳しく」に畳む。まだ1つも無いときは下の1行の案内で足りる -->
        {#if coverage.length > 0}
            <Lead>
                1つのチャンネルに複数の局が入っているので、チャンネルと局の数はそろいません
                {#snippet more()}
                    <p>
                        スキャンは空いているチューナーを全部使います (録画中のチューナーは使いません)。録画中でも実行でき、
                        画面を閉じてもサーバで続きます。終わると番組表も集め直します。
                    </p>
                    <p>
                        番組表はスキャンのあと、局ごとに埋まっていきます。BS の初回は、1つの中継から全局の番組名を先に入れ (数分)、
                        番組内容などの詳細はそのあと中継ごとに回って足します。
                    </p>
                    <p>
                        待てないときは<strong>「番組表をいますぐ集める」</strong>で、録画とライブ視聴に使っていないチューナーを全部使って集められます
                        (スキャンやロゴの取得は止めます)。
                    </p>
                {/snippet}
            </Lead>
        {/if}

        {#if coverage.length === 0}
            <!-- まだ1つも無い。表の場所の真ん中に、スキャンの欄と1行の案内 -->
            <div class="empty">
                <p class="small muted">チャンネルがまだありません。種別を選んでスキャンしてください</p>
                {@render scanControl()}
            </div>
        {:else}
            <div class="table-wrap channels-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>種別</th>
                            <th>ch</th>
                            <th class="wide">局</th>
                            <th class="nowrap">番組表</th>
                        </tr>
                    </thead>
                    <tbody data-testid="channel-list">
                        {#each coverage as channel (`${channel.type}:${channel.channel}`)}
                            {@const programs = channel.services.reduce((sum, service) => sum + service.programs, 0)}
                            {@const last = Math.max(0, ...channel.services.map((service) => service.until))}
                            <tr data-testid="channel-row" data-channel={channel.channel}>
                                <td class="nowrap small">
                                    {SERVICE_TYPE_LABEL[channel.type] ?? channel.type}
                                </td>
                                <td class="mono small nowrap num">
                                    {channel.channel}
                                </td>
                                <td class="small">
                                    <div class="stations">
                                        {#each channel.services as service (service.id)}
                                            <span class="broadcast" data-service-id={service.id}>
                                                {service.name}
                                            </span>
                                        {/each}
                                    </div>
                                </td>
                                <td class="small nowrap num">
                                    {#if programs > 0}
                                        {programs} 件 <span class="tiny muted">{until(last)}</span>
                                    {:else}
                                        <span class="muted">—</span>
                                    {/if}
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}
    </section>
</div>

<style>
    /* 種別を選ぶ欄とボタンを1組に。高さは隣の小さなボタンにそろえる */
    .scan-control {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        margin: 0;
    }
    .scan-control select {
        width: auto;
        height: auto;
        margin: 0;
        padding: 0.3rem 2rem 0.3rem 0.6rem;
        font-size: var(--dp-text-sm);
    }
    .scan-control button {
        margin: 0;
    }
    .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--dp-space-3);
        padding: var(--dp-space-6) var(--dp-space-4);
        text-align: center;
    }
    .empty p {
        margin: 0;
    }
    .table-wrap {
        overflow-x: auto;
    }
    .table-wrap table {
        margin: 0;
    }
    .table-wrap th,
    .table-wrap td {
        padding: 0.35rem 0.5rem;
    }
    /*
     * 受信できるチャンネルの表は、スマートフォンの幅では欄の間を詰める。
     * 局の欄が幅を取り、右端の「10/13 まで」が枠の外へ押し出されていた
     */
    .channels-wrap {
        container-type: inline-size;
    }
    @container (max-width: 32rem) {
        .channels-wrap th,
        .channels-wrap td {
            padding-inline: 0.3rem;
        }
    }
    .wide {
        width: 100%;
    }
    .log summary {
        color: var(--dp-muted);
        cursor: pointer;
    }
    .log pre {
        max-height: 16rem;
        overflow: auto;
        margin: 0.25rem 0 0;
        padding: 0.5rem;
        border-radius: var(--dp-radius);
        background: var(--dp-subtle);
        font-family: var(--pico-font-family-monospace);
        font-size: 0.75rem;
        white-space: pre-wrap;
    }
    /* 受信できるチャンネルの局。折り返しても局名は割らない */
    .stations {
        display: flex;
        flex-wrap: wrap;
        gap: 0.15rem 0.9rem;
    }
</style>
