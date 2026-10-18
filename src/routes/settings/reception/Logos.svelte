<script lang="ts">
    import ActionButton from '#lib/components/ActionButton.svelte';
    import JobProgress from '#lib/components/JobProgress.svelte';
    import Lead from '#lib/components/Lead.svelte';
    import LearnedLogo from '#lib/components/LearnedLogo.svelte';
    import LogoZoom from '#lib/components/LogoZoom.svelte';
    import ServiceLogo from '#lib/components/ServiceLogo.svelte';
    import { SERVICE_TYPE_LABEL } from '#lib/format.js';
    import type { PageData } from './$types';

    let { data }: { data: PageData } = $props();

    /** 局ロゴの大きさ。放送のロゴは 16:9 (64x36) */
    const LOGO_SIZE = 'width: 2.4rem; height: 1.35rem';

    /**
     * 大きく見ているロゴ (`LogoZoom`)。持つのは局と種類だけで、中身は表の行から引く —
     * 「覚え直す」でCMロゴが消えたら、そのまま閉じる
     */
    let zoom = $state<{ id: number; kind: 'station' | 'cm' } | null>(null);
    const zoomTarget = $derived.by(() => {
        if (zoom === null) return null;
        const { id, kind } = zoom;
        const station = data.stations.find((s) => s.id === id);
        if (station === undefined) return null;
        if (kind === 'cm' && station.cm === null) return null;
        if (kind === 'station' && station.logo !== 'have') return null;
        return { id, name: station.name, kind, learnedAt: kind === 'cm' ? station.cm : null };
    });
</script>

<!--
    **局ロゴとCMロゴを局ごとに1行で並べる。** 中身は別物 (番組表に出す局ロゴは放送波から取得し、
    CMロゴは録画から覚える) だが、確かめたいのはどちらも「この局のロゴが取れているか・合っているか」。
    受信できるチャンネルの表の中に出していた頃は、局名の前後に画像とボタンが詰まって表が読みにくかった
-->
<div class="sections">
    <section class="section" data-testid="logo-card">
        <div class="section-head spread">
            <h2>ロゴ</h2>
            <!--
                取得するものが無ければボタンも出さない。押しても「もう全部持っています」と
                断るだけになる。**走っている最中でも押せる** — 押されたほうが譲る作りなので、
                使えなくすると「BSを取っている間ずっと押せない」に逆戻りする
            -->
            {#if data.logos.pending > 0}
                <ActionButton action="?/logoSweep" class="small secondary outline" testid="logo-sweep">
                    {data.logoSweep.running ? 'ロゴを集めています…' : 'ロゴをいますぐ集める'}
                </ActionButton>
            {/if}
        </div>
        <!-- 1チャンネルに数分かかる。出さないと押しても何も起きていないように見える -->
        {#if data.logoSweep.startedAt !== null}
            <div class="progress-block" data-testid="logo-sweep-progress">
                <JobProgress done={data.logoSweep.done} total={data.logoSweep.total} unit="チャンネル">
                    ・ ロゴ <strong>{data.logoSweep.found} 局</strong>
                    {#if data.logoSweep.channels.length > 0}
                        ・ 受信中 {data.logoSweep.channels.join(', ')}
                    {/if}
                </JobProgress>
                {#if data.logoSweep.message !== ''}
                    <div class="tiny muted" data-testid="logo-sweep-done">
                        {data.logoSweep.message}
                    </div>
                {/if}
            </div>
        {/if}
        <!-- 取れないぶんを除いて揃っていれば「揃った」の色 -->
        <div class="small cluster">
            <span>
                <span class="muted">局ロゴ</span>
                <span
                    class="tag num {data.logos.have + data.logos.unavailable >= data.logos.total ? 'success' : ''}"
                    data-testid="status-logos"
                >
                    {data.logos.have} / {data.logos.total} 局
                </span>
            </span>
            <!-- CM検出のために覚えたロゴ。局ロゴとは別物 (logo-data.ts) -->
            <span>
                <span class="muted">CMロゴ</span>
                <span class="tag num" data-testid="status-cm-logos">
                    {data.cmLogoStats.have} / {data.cmLogoStats.total} 局
                </span>
            </span>
        </div>
        {#if data.logos.unavailable > 0}
            <!--
                取れないものを「まだ取れていない」と出し続けると、こちらの不具合と見分けが付かない。
                **中継にロゴが無いことでは数えない。** CS の中継にはロゴが流れていないが、
                CS のロゴは BS の中継から降ってくる
            -->
            <div class="tiny muted" data-testid="logo-unavailable">
                <span class="num">{data.logos.unavailable}</span> 局はロゴが放送に載っていないため取れません (1週間後にまた確かめます)
            </div>
        {/if}
        <Lead>
            局ロゴは番組表と一覧に出すもの、CMロゴはCM検出のために録画から覚えたものです
            {#snippet more()}
                <!-- 局ロゴ。放送波から取得するしかない。番組表に出ないとき、取れていないのか出し方が悪いのかをここで見分ける -->
                <p>
                    局ロゴは番組表を集めるときに、あわせて取得します。放送波に流れるのは数十秒〜数分に一度、
                    <strong>衛星は十数分に一度</strong>で、取れたロゴも1週間ごとに取り直します。
                    点線の枠は、まだ取れていない局です。
                </p>
                <p>
                    「ロゴをいますぐ集める」では衛星の分も集めます。<strong>BS と CS のロゴは同じ1つの中継で流れる</strong>ため、
                    そこだけ最大20分かかります (他の中継は数秒で終わります)。
                </p>
                <p>
                    CMロゴは、CM検出のために録画から覚えたロゴの位置と形です。録画をエンコードするときに自動で覚えます。
                    ロゴの形になっていなければ「覚え直す」で消すと、次の録画で覚え直します。
                </p>
            {/snippet}
        </Lead>
        {#if data.stations.length === 0}
            <p class="small muted">まだ局がありません。チャンネルスキャンのあとに出ます。</p>
        {:else}
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>種別</th>
                            <th class="wide">局</th>
                            <th class="nowrap">局ロゴ</th>
                            <th class="nowrap">CMロゴ</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each data.stations as station (station.id)}
                            <tr data-testid="logo-row" data-service-id={station.id} data-logo={station.logo}>
                                <td class="nowrap small">{SERVICE_TYPE_LABEL[station.type] ?? station.type}</td>
                                <td class="small broadcast">{station.name}</td>
                                <td>
                                    <!-- まだのものは点線の枠、放送に載っていないものは「—」 -->
                                    {#if station.logo === 'have'}
                                        <button
                                            type="button"
                                            class="zoom"
                                            onclick={() => (zoom = { id: station.id, kind: 'station' })}
                                            aria-label={`${station.name} のロゴを大きく見る`}
                                            data-testid="logo-zoom-station"
                                        >
                                            <ServiceLogo id={station.id} has style={LOGO_SIZE} />
                                        </button>
                                    {:else if station.logo === 'missing'}
                                        <span class="logo-slot" title="ロゴはまだ取れていません">
                                            <span class="visually-hidden">まだ</span>
                                        </span>
                                    {:else}
                                        <span class="muted small" title="ロゴは放送に載っていません">—</span>
                                    {/if}
                                </td>
                                <td class="nowrap">
                                    <!-- まだ覚えていない局と、CM検出の対象でない局 (サブチャンネルなど) は空けておく -->
                                    {#if station.cm !== null}
                                        <LearnedLogo
                                            serviceId={station.id}
                                            serviceName={station.name}
                                            learnedAt={station.cm}
                                            onzoom={() => (zoom = { id: station.id, kind: 'cm' })}
                                        />
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

<LogoZoom target={zoomTarget} onclose={() => (zoom = null)} />

<style>
    .table-wrap th,
    .table-wrap td {
        vertical-align: middle;
    }
    /* 局ロゴそのものを押して大きく見る (`LogoZoom`)。ボタンの地や余白は付けない */
    .zoom {
        display: inline-flex;
        width: auto;
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: var(--dp-radius-sm);
        background: none;
        cursor: zoom-in;
    }
    /* まだ取れていない局ロゴの場所。取れたロゴと同じ大きさの点線の枠 */
    .logo-slot {
        display: block;
        width: 2.4rem;
        height: 1.35rem;
        border: 1px dashed var(--dp-line-strong);
        border-radius: var(--dp-radius-sm);
    }
</style>
