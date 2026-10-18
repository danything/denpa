<script lang="ts">
    import { submitting } from '#lib/actions.js';
    import { arming } from '#lib/arming.svelte.js';
    import { autosave, SaveState } from '#lib/autosave.svelte.js';
    import ActionButton from '#lib/components/ActionButton.svelte';
    import JobProgress from '#lib/components/JobProgress.svelte';
    import Lead from '#lib/components/Lead.svelte';
    import LearnedLogo from '#lib/components/LearnedLogo.svelte';
    import Icon from '#lib/components/player/Icon.svelte';
    import SaveNote from '#lib/components/SaveNote.svelte';
    import ServiceLogo from '#lib/components/ServiceLogo.svelte';
    import Toasts, { errorNotice, type Notice } from '#lib/components/Toasts.svelte';
    import { SERVICE_TYPE_LABEL, STATE_LABEL as SHARED_STATE_LABEL, splitReaderName } from '#lib/format.js';
    import { held, liveUpdates } from '#lib/live-updates.svelte.js';
    import type { CardReaderState } from '#lib/server/scramble.js';
    import X from '~icons/lucide/x';

    let { data, form } = $props();

    // スキャンは数十分かかることがある。進み具合はサーバから push される。
    // 局の取り込みも1回では終わらないので、増えるたびに描き直す。
    // ロゴ取得も1チャンネルに数分かかるので、同じように流してもらう
    // 番組表を集めている最中の様子も 'tuners' で流れてくる
    liveUpdates(['scan', 'services', 'logos', 'tuners', 'programs']);
    const scan = $derived(data.scan);
    /**
     * CM検出のロゴ。**覚えていない局を先に、でも全部並べる。**
     *
     * 覚えていない局だけ出していた頃は、**覚えているロゴを確かめる場所が
     * どこにも無かった**。自動探索はロゴでない縁を検出することもあるので、
     * 「当たらない」と思ったときに映像を見られることのほうが要る。
     * 局は畳んであり、まだの局と覚えた局に分けて (`CM_GROUPS`)、何列にも詰めて並べる
     */
    const cmLogos = $derived(data.cmLogos);
    /** CM検出のロゴの一覧の分け方。まだの局が先 */
    const CM_GROUPS = [
        { learned: false, label: 'まだ' },
        { learned: true, label: '覚えました' },
    ];
    /** まだ覚えていない局の数。畳んだ一覧の見出しの横に出す */
    const cmLogosPending = $derived(cmLogos.filter((service) => service.learned_at === null).length);
    /** チューナーの設定の保存の様子 (その場で保存する。`autosave`) */
    const configSave = new SaveState();
    /** チューナーの行の削除は 2 回押し (ほかの画面の削除と同じ。`arming`) */
    const deleting = arming('[data-testid^="tuner-delete"]');

    /** チューナーが受けられる種別。設定の表で並べる順 */
    const TYPES = ['GR', 'BS', 'CS'] as const;
    /**
     * 衛星の給電の選び方。値はエージェントが読む字のまま (小文字。`agent/Denpa.Agent/Tuning.cs`)。
     * 設定ファイルに手で書いた別の値は、消さずに選べるものとして足す (表の `lnbChoices`)
     */
    const LNB_CHOICES = [
        { value: '', label: 'なし' },
        { value: '15v', label: '15V' },
        { value: '11v', label: '11V' },
    ];
    /** スキャンの状態の呼び名。共通のものに、スキャンだけの2つを足す */
    const STATE_LABEL: Record<string, string> = { ...SHARED_STATE_LABEL, canceled: '中断', idle: '待機中' };

    /*
     * 物理チャンネルと、そこに入っている局。**denpa 自身のDBから来る。**
     * エージェントにも控えはあるが、聞きに行かない (+page.server.ts)
     */
    const coverage = $derived(data.channels);
    /** 表の局名の前に出す局ロゴの大きさ。放送のロゴは 16:9 (64x36) */
    const LOGO_SIZE = 'width: 1.6rem; height: 0.9rem';
    /** 入っている局をすべて並べたもの */
    const services = $derived(coverage.flatMap((channel) => channel.services));

    /*
     * **読み直しの間も前の中身を出したままにする。**
     *
     * 通知が来るたびに読み直しているが、相手待ちのものは promise のまま
     * 渡ってくるので、`{#await}` に直に食わせると読み直すたびに待ち状態へ戻り、
     * 表がいったん消えてから同じものが描き直されていた (目に見えてちらつく)。
     * 中身を持っておけば、実際に変わった行だけが変わる
     */
    const shownTuners = held(() => data.tuners);
    const shownCard = held(() => data.card);

    /** カードリーダーの行の呼び名。`unknown` は前の版のエージェント (名前しか返さない) */
    const READER_STATE: Record<CardReaderState, { label: string; tone: string }> = {
        active: { label: '使用中', tone: 'success' },
        standby: { label: '予備', tone: '' },
        empty: { label: 'カードなし', tone: '' },
        error: { label: 'エラー', tone: 'error' },
        unknown: { label: '—', tone: '' },
    };

    /** 番組表がどこまで埋まっているか。「8/9 まで」の形で出す */
    function until(at: number): string {
        const d = new Date(at);
        return `${d.getMonth() + 1}/${d.getDate()} まで`;
    }

    /** 押した結果。スキャンの経過そのものは下のカードに出したままにする */
    const notices = $derived.by(() => {
        const list: Notice[] = [];
        list.push(...errorNotice(form, 'tuner-error'));
        if (form?.scan) list.push({ key: 'tuner-notice', kind: 'info', text: form.scan });
        /*
         * 済んだこと (ロゴの位置・チューナーの保存)。**`message` に載せない** —
         * あれは fail の言葉として赤で出す欄 (`errorNotice`) なので、載せていた頃は
         * ロゴの位置を受け取れても失敗の赤で出ていた (チューナーの保存は何も出なかった)
         */
        if (form?.done) list.push({ key: 'tuner-done', kind: 'success', text: form.done });
        return list;
    });
</script>

<svelte:window onclick={deleting.stand} />

<Toasts {notices} source={form} />

<!--
    **1 列に並べ、節は見出しと細い線で区切る** (設定の画面と同じ形。`app.css` の `.sections`)。
    2 列にカードを積んでいた頃は、目が左右を行き来した。表は幅を使うので、設定の画面より広く取る。

    並びは「いまの様子」から: 空きとカードリーダー → 受信できるチャンネル → たまに回すスキャン →
    入れたときしか触らないチューナーの設定 → CM検出のロゴ。局ロゴは局ごとの話なので、受信できるチャンネルの表に出す
-->
<div class="sections tuners">
    <!--
        **いちばん上に置く。** 録るのも番組表を集めるのもここの取り合いで、
        スキャン中に見たいのも「いま何台使っているか」。カードリーダーの
        具合も同じ機材の話なので、同じ節に並べる
    -->
    <section class="section" data-testid="tuner-card">
        <div class="section-head">
            <h2>チューナーの空き</h2>
        </div>
        <!-- 譲り合う順は数字ではなく用途の並びで言う (順番は config.priority から) -->
        <Lead>
            足りないときにどれが譲るかは、使い方で決まります
            {#snippet more()}
                <p>チューナーが足りないときは、上にあるものが先に使い、下のものが譲ります。</p>
                <ol data-testid="tuner-yield-order">
                    {#each data.yieldOrder as use (use)}
                        <li>{use}</li>
                    {/each}
                </ol>
                <p>ルールの「優先度」は予約どうしを比べるもので、この順とは別です。</p>
            {/snippet}
        </Lead>
        {#if shownTuners.value === undefined}
            <p class="small muted">確認中…</p>
        {:else}
            {@const tuners = shownTuners.value.list}
            {@const failure = shownTuners.value.error}
            {#if failure !== null}
                <!--
                    繋がらなかったときに空の一覧だけ出すと「1台も無い」と
                    見分けが付かない。理由をそのまま出す
                -->
                <div class="notice error small">
                    チューナーエージェントに繋がりません: {failure}
                </div>
            {:else if tuners.length === 0}
                <p class="small muted">
                    チューナーがありません。「チューナーの設定」から追加してください。
                </p>
            {:else}
                <div class="table-wrap row-cards-wrap">
                    <table class="row-cards">
                        <thead>
                            <tr>
                                <th>名前</th>
                                <th>種別</th>
                                <th>状態</th>
                                <th class="wide">使っているもの</th>
                            </tr>
                        </thead>
                        <tbody data-testid="tuner-list">
                            {#each tuners as tuner (tuner.index)}
                                <tr data-testid="tuner-row" data-tuner-index={tuner.index}>
                                    <td class="nowrap" data-label="名前">{tuner.name}</td>
                                    <td class="nowrap small" data-label="種別">
                                        {tuner.types.map((t) => SERVICE_TYPE_LABEL[t] ?? t).join('/')}
                                    </td>
                                    <td class="nowrap" data-label="状態">
                                        <!-- 何を使っているかも出す。空き/使用中だけでは追えない -->
                                        {#if tuner.disabled}
                                            <span class="tag">無効</span>
                                        {:else if tuner.channel !== null}
                                            <span class="tag warning num">
                                                {tuner.channel.channel}
                                            </span>
                                        {:else}
                                            <span class="tag success">空き</span>
                                        {/if}
                                        {#if tuner.error !== null && tuner.channel === null}
                                            <div class="text-error tiny" data-testid="tuner-error">
                                                {tuner.error}
                                            </div>
                                        {/if}
                                    </td>
                                    <td class="small span" data-label="使っているもの">
                                        <!--
                                            **数字を出さない。** 何に使っているか (録画・ライブ視聴・番組表…)
                                            が出ていれば、どちらが譲るかは用途で決まる (上の「詳しく」に順番)。
                                            ルール画面の「優先度」(0〜9) と同じ名前の別の物差しが並ぶと、
                                            ルールの 2 が番組表の 3 に負けるように読めていた。
                                            数は調べるとき用に `data-priority` にだけ残す。
                                            目印は番号で。同じ用途が2つ乗ることはあり、字を目印にすると落ちる
                                        -->
                                        {#each tuner.users as user, i (i)}
                                            <div class="truncate" data-testid="tuner-user" data-priority={user.priority}>
                                                {user.label}
                                            </div>
                                        {:else}
                                            <span class="muted">—</span>
                                        {/each}
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            {/if}
        {/if}

        <!--
            カードリーダー。**同じ機材の話**なのでここに置く。
            掛かったまま録れてしまうのを避けるには、録る前に気づけること。

            **使うカードは1枚** (エージェントの Card.cs)。どのチューナーもその1枚の鍵で
            復号するので、「使っているチューナー」は使用中の行にだけ並ぶ。他のリーダーは予備で、
            使用中のカードが答えなくなったら繋ぎ直すときに使われる
        -->
        <div class="reader">
            <div class="cluster">
                <h3>カードリーダー</h3>
                {#if shownCard.value === undefined}
                    <span class="tag" data-testid="status-card-reader">確認中</span>
                {:else}
                    {@const card = shownCard.value}
                    <span class="tag {card.ok ? 'success' : 'error'}" data-testid="status-card-reader">
                        {card.ok ? '正常' : 'エラー'}
                    </span>
                    {#if card.source === 'remote'}
                        <!-- CARD_URL。手元のリーダーは使わず、鍵だけ貰っている -->
                        <span class="small">
                            別の拠点 <span class="mono break">{card.remote ?? '?'}</span> から鍵を受け取っています
                            {#if card.ids.length > 0}
                                <span class="mono">({card.ids.join(' / ')})</span>
                            {/if}
                            {#if card.tuners.length > 0}
                                — {card.tuners.join('、')}
                            {/if}
                        </span>
                    {/if}
                {/if}
            </div>
            {#if shownCard.value !== undefined}
                {@const card = shownCard.value}
                <!-- 困っているときだけ。名前と番号は表に出る -->
                {#if card.message !== ''}
                    <div class={card.ok ? 'tiny muted' : 'notice error small'} data-testid="card-message">
                        {card.message}
                    </div>
                {/if}
                {#if card.readers.length > 0}
                    <div class="table-wrap row-cards-wrap">
                        <table class="row-cards">
                            <thead>
                                <tr>
                                    <th>カードリーダー</th>
                                    <th>カード (番号)</th>
                                    <th>状態</th>
                                    <th class="wide">使っているチューナー</th>
                                </tr>
                            </thead>
                            <tbody>
                                <!-- 同じ型のリーダーを2つ挿すと名前が並ぶ。目印は番号で -->
                                {#each card.readers as reader, i (i)}
                                    {@const label = splitReaderName(reader.name)}
                                    <tr data-testid="card-reader-row" data-state={reader.state}>
                                        <!--
                                            場所 (「usb 4-11」) は2行目に小さく。**文字の途中で折らない** —
                                            break-all にしていた頃は、狭い列で「Gempl / us US / B Sma…」と
                                            1文字ずつ折れて読めなかった。折るのは単語の区切りで
                                        -->
                                        <td class="reader-name span" data-label="カードリーダー">
                                            <span data-testid="card-reader-name">{label.name}</span>
                                            {#if label.where !== null}
                                                <div class="tiny muted mono" data-testid="card-reader-where">
                                                    {label.where}
                                                </div>
                                            {/if}
                                        </td>
                                        <td class="nowrap small mono" data-label="カード (番号)">
                                            {#if reader.ids.length > 0}
                                                {reader.ids.join(' / ')}
                                            {:else}
                                                <span class="muted">—</span>
                                            {/if}
                                        </td>
                                        <td class="nowrap" data-label="状態">
                                            <span class="tag {READER_STATE[reader.state].tone}">
                                                {READER_STATE[reader.state].label}
                                            </span>
                                            {#if reader.error !== undefined}
                                                <div class="text-error tiny">
                                                    {reader.error}
                                                </div>
                                            {/if}
                                        </td>
                                        <td class="small span" data-label="使っているチューナー">
                                            {#if reader.tuners.length > 0}
                                                {reader.tuners.join('、')}
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
            {/if}
        </div>
    </section>

    <section class="section" data-testid="channel-card">
        <!--
            **説明を3つ重ねない。** 数を先に出して、注は1つだけ (数がそろわない理由)。
            上のボタンが何をするものかは「詳しく」に畳む
        -->
        <div class="section-head spread">
            <h2>受信できるチャンネル</h2>
            <div class="cluster">
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
        </div>
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
                    <div class="tiny muted" data-testid="epg-sweeping">
                        BS は、まず1つの中継から全局の番組名を入れています (数分)。
                        番組内容・出演者などの詳細は、そのあと中継ごとに回って足します
                    </div>
                {/if}
            </div>
        {/if}
        <!-- ロゴも1チャンネルに数分かかる。出さないと押しても何も起きていないように見える -->
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
        {#if coverage.length === 0}
            <p class="small muted">
                まだ1つもありません。チャンネルスキャンを実行してください。
            </p>
        {:else}
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
                <!--
                    局ロゴも局ごとの話なので、ここに並べる (別の節に分けていた頃は、説明が細い列に
                    押し込まれて読みにくかった)。取れないぶんを除いて揃っていれば「揃った」の色
                -->
                <span class="faint">・</span>
                <span class="muted">ロゴ</span>
                <span
                    class="tag num {data.logos.have + data.logos.unavailable >= data.logos.total ? 'success' : ''}"
                    data-testid="status-logos"
                >
                    {data.logos.have} / {data.logos.total} 局
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
                1つのチャンネルに複数の局が入っているので、チャンネルと局の数はそろいません
                {#snippet more()}
                    <p>番組表はスキャンのあと、局ごとに埋まっていきます。</p>
                    <p>
                        BS の初回は、1つの中継から全局の番組名を先に入れ (数分)、番組内容などの詳細は
                        そのあと中継ごとに回って足します。詳細は各局が自分の中継にしか流していないためです。
                        CS は詳細を流していないので、いつも1つの中継で全局ぶんを集めます。
                    </p>
                    <p>
                        待てないときは<strong>「番組表をいますぐ集める」</strong>で、録画とライブ視聴に使っていないチューナーを全部使って集められます
                        (スキャンやロゴの取得は止めます)。
                    </p>
                    <!-- 局ロゴ。放送波から取得するしかない。番組表に出ないとき、取れていないのか出し方が悪いのかをここで見分ける -->
                    <p>
                        局ロゴは番組表を集めるときに、あわせて取得します。放送波に流れるのは数十秒〜数分に一度、
                        <strong>衛星は十数分に一度</strong>で、取れたロゴも1週間ごとに取り直します。
                        表の局名の前に出ていないものは、まだ取れていない局です。
                    </p>
                    <p>
                        「ロゴをいますぐ集める」では衛星の分も集めます。<strong>BS と CS のロゴは同じ1つの中継で流れる</strong>ため、
                        そこだけ最大20分かかります (他の中継は数秒で終わります)。
                    </p>
                {/snippet}
            </Lead>
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
                                    <!--
                                        局ごとに、取れている局ロゴを名前の前に出す。まだのものは点線の枠、
                                        放送に載っていないものは何も置かない (場所だけ空けて頭を揃える)
                                    -->
                                    <div class="stations">
                                        {#each channel.services as service (service.id)}
                                            <span
                                                class="station"
                                                data-testid="channel-service"
                                                data-service-id={service.id}
                                                data-logo={service.logo}
                                            >
                                                {#if service.logo === 'have'}
                                                    <ServiceLogo id={service.id} has style={LOGO_SIZE} />
                                                {:else}
                                                    <span
                                                        class="logo-slot {service.logo}"
                                                        aria-hidden="true"
                                                        title={service.logo === 'missing' ? 'ロゴはまだ取れていません' : 'ロゴは放送に載っていません'}
                                                    ></span>
                                                {/if}
                                                <span class="broadcast">{service.name}</span>
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

    <section class="section" data-testid="scan-card">
        <div class="section-head">
            <h2>チャンネルスキャン</h2>
        </div>
        <!-- 何分もかかって空きチューナーを全部使う。そこは畳まずに見せておく -->
        <Lead>
            <strong>空いているチューナーを全部使います</strong>。録画中でも実行できます。
            始めたら、画面を移ったり閉じたりしてもかまいません (サーバで続きます)
            {#snippet more()}
                <p>受信できるチャンネルを選局して探します (録画中のチューナーは使いません)。</p>
                <p>見つかったチャンネルは保存し、終わると番組表も集め直します。</p>
            {/snippet}
        </Lead>

        <!--
            探す範囲は決め打ち。放送で使う物理チャンネルは決まっていて、
            狭めても総当たりの時間が少し減るだけ。狭めた結果 見つからない局が出るほうが困る
        -->
        <form method="POST" action="?/scan" use:submitting class="setting-rows scan-form">
            <div class="field">
                <span class="field-label">種別</span>
                <!--
                    **選ぶものと押すものを1行に。** ボタンを種別の下の段に置いていた頃は、
                    どの欄にも付かない浮いたボタンに見えた。狭い幅では折り返す
                -->
                <div class="cluster scan-controls">
                    <div class="chips" data-testid="scan-types">
                        {#each TYPES as type (type)}
                            <label class="chip">
                                <input type="checkbox" name="types" value={type} checked={type === 'GR'} />
                                {SERVICE_TYPE_LABEL[type]}
                            </label>
                        {/each}
                    </div>
                    <button type="submit" class="small" disabled={scan.state === 'running'} data-testid="scan-start">
                        {scan.state === 'running' ? '実行中…' : '開始'}
                    </button>
                    {#if scan.state === 'running'}
                        <!--
                            十数分かかるので、途中で降りられるようにしてある。
                            中断しても設定は書き換えない (途中までの結果で上書きすると、
                            まだ回っていない局の定義が消える)
                        -->
                        <button type="submit" class="small outline danger" formaction="?/scanStop">
                            中断
                        </button>
                    {/if}
                </div>
            </div>
        </form>

        {#if scan.state !== 'idle'}
            <div class="progress-block" data-state={scan.state}>
                <div class="cluster small">
                    <span class="tag" data-testid="scan-state">{STATE_LABEL[scan.state]}</span>
                    {#if scan.phase}
                        <span class="tag outline">{scan.phase}</span>
                    {/if}
                    <span class="num" data-testid="scan-found">見つかったチャンネル {scan.channels}</span>
                </div>

                <!-- 総当たりなので何分かかるか分かりにくい。どこまで進んだかを出す -->
                <JobProgress done={scan.scanned} total={scan.total} unit="チャンネル" testid="scan-count" />

                {#if scan.error}
                    <div class="notice error">{scan.error}</div>
                {/if}
                {#if scan.log.length > 0}
                    <pre class="log" data-testid="scan-log">{scan.log.join('\n')}</pre>
                {/if}
            </div>
        {/if}
    </section>

    <section class="section" data-testid="tuner-config-card">
        <div class="section-head">
            <h2>チューナーの設定</h2>
            <SaveNote status={configSave} />
        </div>
        {#await data.detected then detected}
            {#if detected}
                <Lead>
                    いまは<strong>挿さっているチューナーを自動で見つけて</strong>使っています。
                    どれかを変えると、この内容に固定します
                </Lead>
            {/if}
        {/await}

        {#if shownTuners.value !== undefined}
            {@const rows = [...shownTuners.value.list, null]}
            <!--
                **変えたらその場で保存する** (`autosave`。設定の画面と同じ)。文字の欄は離れたとき、
                チェックと選択は変えたとき。
                名前は空にできない (断って元に戻す)。行を消すのは右端の「×」の 2 回押し。
                **行の追加はボタンで** — 足すための空の行は、名前を打っている途中や
                デバイスを入れる前に送らない (`data-no-autosave`)。自動検出に戻すのもボタン
            -->
            <form method="POST" action="?/tuners" use:autosave={configSave}>
                <div class="table-wrap config-wrap row-cards-wrap">
                    <table class="config row-cards">
                        <thead>
                            <tr>
                                <th>名前</th>
                                <th class="device-col">デバイス</th>
                                <th>受信できる種別</th>
                                <th>LNB</th>
                                <th>無効</th>
                                <th><span class="visually-hidden">削除</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each rows as tuner, index (index)}
                                {@const lnb = tuner?.lnb ?? ''}
                                {@const lnbChoices = LNB_CHOICES.some((choice) => choice.value === lnb)
                                    ? LNB_CHOICES
                                    : [...LNB_CHOICES, { value: lnb, label: lnb }]}
                                <tr data-testid="tuner-config-row" data-no-autosave={tuner === null ? '' : undefined}>
                                    <td class="span" data-label="名前">
                                        <input
                                            class="w-name"
                                            aria-label="名前"
                                            name={`name.${index}`}
                                            value={tuner?.name ?? ''}
                                            placeholder={tuner === null ? '名前を入れて追加' : ''}
                                        />
                                    </td>
                                    <td class="span" data-label="デバイス">
                                        <input
                                            class="w-device mono tiny"
                                            aria-label="デバイス"
                                            name={`device.${index}`}
                                            value={tuner?.device ?? ''}
                                            placeholder="/dev/dvb/adapter0/frontend0"
                                        />
                                    </td>
                                    <td class="span" data-label="受信できる種別">
                                        <div class="chips types-cell">
                                            {#each TYPES as type (type)}
                                                <label class="chip">
                                                    <input
                                                        type="checkbox"
                                                        name={`type.${index}.${type}`}
                                                        checked={tuner?.types.includes(type) ?? false}
                                                    />
                                                    {SERVICE_TYPE_LABEL[type]}
                                                </label>
                                            {/each}
                                        </div>
                                    </td>
                                    <td data-label="LNB">
                                        <!--
                                            **選ばせる。打たせない。** エージェントが読むのは小文字の
                                            `15v` / `11v` だけで (`Tuning.cs`)、`15V` と打つと黙って
                                            給電されない。見せる字は大文字 (電圧の書き方)
                                        -->
                                        <select class="w-lnb" name={`lnb.${index}`} aria-label="LNB">
                                            {#each lnbChoices as choice (choice.value)}
                                                <option value={choice.value} selected={choice.value === lnb}>{choice.label}</option>
                                            {/each}
                                        </select>
                                    </td>
                                    <td data-label="無効">
                                        <input
                                            type="checkbox"
                                            name={`disabled.${index}`}
                                            checked={tuner?.disabled ?? false}
                                            aria-label="無効"
                                        />
                                    </td>
                                    <td class="delete-cell" data-label="">
                                        {#if tuner === null}
                                            <!-- 足すための空の行。名前が空なら送っても足さない (サーバの `new`) -->
                                            <input type="hidden" name="new" value={index} />
                                        {:else if deleting.armed === index}
                                            <!--
                                                2 回目。この行を除いて保存する。構えを下ろすのは送り出したあと —
                                                押した場で下ろすと、送る前にこのボタンが消えて何も送られない
                                            -->
                                            <button
                                                type="submit"
                                                name="delete"
                                                value={index}
                                                class="xs danger"
                                                onclick={() => setTimeout(() => deleting.fire())}
                                                data-testid="tuner-delete-confirm"
                                            >
                                                削除を確定
                                            </button>
                                        {:else}
                                            <button
                                                type="button"
                                                class="xs ghost delete-button"
                                                aria-label={`${tuner.name} を削除`}
                                                title="削除"
                                                onclick={() => deleting.arm(index)}
                                                data-testid="tuner-delete"
                                            >
                                                <Icon icon={X} size="size-4" />
                                            </button>
                                        {/if}
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
                <div class="cluster config-actions">
                    <button type="submit" class="small secondary outline" data-testid="tuner-config-add">追加</button>
                    <button type="submit" class="small ghost" formaction="?/tunersAuto">
                        自動検出に戻す
                    </button>
                </div>
            </form>
        {/if}
    </section>

    <!--
        CM検出のロゴ。**番組表に出す局ロゴとは別物** (logo-data.ts)。
        こちらは「画面のどこにロゴが出ているか」を録画から覚えたもの。
        **録画ごとの話ではなく局ごとの話**で、覚えたものは以降その局の全部に効く。
        番組表に出す局ロゴは「受信できるチャンネル」に局ごとに出す
    -->
    <section class="section" data-testid="logo-card">
        <div class="section-head">
            <h2>CM検出のロゴ</h2>
            <span class="tag num" data-testid="status-cm-logos">{data.cmLogoStats.have} / {data.cmLogoStats.total} 局</span>
        </div>
        <Lead>
            録画をエンコードするときに、その録画から自動で覚えます
            {#snippet more()}
                <p>
                    画面の隅で線の向きがどのコマでも揃うところをロゴとして覚え、エンコードのたびに精度を上げます。
                    違うものを覚えていたら、下の一覧から消せば次の録画で覚え直します。
                </p>
            {/snippet}
        </Lead>
        <!--
            **局ごとの一覧は畳んでおく。** 100 局を超えると、開いたままでは画面がそれだけで埋まる。
            覚えていない局があれば、その数だけ見出しの横に出す (開かなくても要るかどうか分かる)
        -->
        {#if cmLogos.length > 0}
            <details class="cm-logo-list" data-testid="cm-logo-list">
                <summary>
                    局ごとの一覧
                    {#if cmLogosPending > 0}
                        <span class="tag num" data-testid="cm-logo-pending">まだ {cmLogosPending} 局</span>
                    {/if}
                </summary>
                <!--
                    **まだの局と覚えた局を分けて、詰めて並べる。** 1局ずつ枠で囲んだ行を縦に積んでいた頃は、
                    100局を超えると長く巻かないと見終わらなかった。開いた局だけ1段を使って中身を出す
                -->
                {#each CM_GROUPS as group (group.learned)}
                    {@const list = cmLogos.filter((service) => (service.learned_at !== null) === group.learned)}
                    {#if list.length > 0}
                        <div class="cm-group" data-testid={group.learned ? 'cm-logo-learned' : 'cm-logo-waiting'}>
                            <h3 class="tiny muted">{group.label} <span class="num">({list.length})</span></h3>
                            <div class="cm-logos">
                                {#each list as service (service.id)}
                                    <details class="cm-logo" data-learned={service.learned_at !== null}>
                                        <summary class="small">
                                            <!-- 覚えたかどうかは畳んだまま分かるようにする (色だけにしない。字は読み上げ用) -->
                                            <span class="state-dot" aria-hidden="true"></span>
                                            <span class="visually-hidden">{group.label}:</span>
                                            <span class="broadcast truncate">{service.name}</span>
                                        </summary>
                                        <LearnedLogo
                                            serviceId={service.id}
                                            serviceName={service.name}
                                            learnedAt={service.learned_at}
                                        />
                                    </details>
                                {/each}
                            </div>
                        </div>
                    {/if}
                {/each}
            </details>
        {/if}
    </section>
</div>

<style>
    /* 表を幅いっぱいに使うので、設定の画面 (720px) より広く取る */
    .tuners {
        max-width: 64rem;
    }
    .table-wrap {
        overflow-x: auto;
    }
    /*
     * **チューナーの設定は、広い画面で横に巻かせない。** 欄の幅を決め打ちしていた
     * 頃は表が 784px より縮まず、1920px の画面でも Windows の拡大 125% (= 1536px)
     * では列が 675px しかなく、中に横スクロールが出ていた。
     * デバイスの欄だけを伸び縮みさせて、余った幅を全部そこにあげる。
     * それでも入らない幅 (スマートフォン) は、行を1枚ずつのカードにする (下の 32rem)
     */
    .config-wrap {
        container-type: inline-size;
    }
    .config {
        width: 100%;
    }
    .device-col {
        width: 100%;
    }
    /* 受信できる種別は小さな切り替え (`.chip`) を横に並べる。行の高さを 1 段に保つ */
    .types-cell {
        flex-wrap: nowrap;
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
    .log {
        max-height: 16rem;
        overflow: auto;
        margin: 0;
        padding: 0.5rem;
        border-radius: var(--dp-radius);
        background: var(--dp-subtle);
        font-family: var(--pico-font-family-monospace);
        font-size: 0.75rem;
        white-space: pre-wrap;
    }
    .config :is(input:not([type='checkbox']), select) {
        height: auto;
        margin: 0;
        padding: 0.25rem 0.5rem;
        font-size: 0.85rem;
    }
    .config select {
        padding-inline-end: 2rem;
    }
    /*
     * **スマートフォンの幅では、表をやめて1行ずつのカードにする**。
     * **名前を `.stack` にしない。** app.css の `.stack` (縦に積む flex) が広い画面でも表に当たり、
     * 表が flex になって見出しと行が別々に詰められ、列がずれていた (#651 で入れたとき)。
     * 横に巻かせていた頃は、チューナーの設定の受信できる種別・LNB・無効、空きの「使っているもの」、
     * カードリーダーの状態が枠の外にあって、横になぞらないと見えなかった (デバイスも途中で切れていた)。
     * 見出しの行は隠し、欄ごとに見出しを上に書く (`data-label`)。
     * 2つずつ並べ、長いもの (`.span`) は1段を使う
     */
    .row-cards-wrap {
        container-type: inline-size;
    }
    @container (max-width: 32rem) {
        .row-cards,
        .row-cards tbody,
        .row-cards td {
            display: block;
        }
        .row-cards thead {
            display: none;
        }
        .row-cards tr {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 0.5rem 0.75rem;
            padding-block: 0.75rem;
            border-top: 1px solid var(--dp-line);
        }
        .row-cards tr:first-child {
            border-top: 0;
        }
        .table-wrap .row-cards td {
            padding: 0;
            border: 0;
            background: transparent;
        }
        .row-cards td::before {
            content: attr(data-label);
            display: block;
            margin-bottom: 0.25rem;
            font-size: 0.8rem;
            font-weight: var(--dp-weight);
            color: var(--dp-muted);
        }
        .row-cards .span {
            grid-column: 1 / -1;
        }
        .config :is(.w-name, .w-device) {
            width: 100%;
            min-width: 0;
        }
        .types-cell {
            flex-wrap: wrap;
        }
    }
    .w-name {
        width: 8rem;
    }
    .w-device {
        width: 100%;
        min-width: 11rem;
    }
    .w-lnb {
        width: 5rem;
    }
    /* 行の「×」。押す的は小さくても 2rem 角。2 回目の「削除を確定」は同じ場所に出る */
    .delete-cell {
        width: 1%;
        white-space: nowrap;
    }
    .delete-button {
        min-width: 2rem;
        min-height: 2rem;
        padding: 0.25rem;
        color: var(--dp-muted);
    }
    .config-actions {
        margin-top: 0.5rem;
    }
    .reader {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        margin-top: 0.5rem;
    }
    .reader h3 {
        font-size: var(--dp-text-base);
    }
    .break {
        word-break: break-all;
    }
    /* 名前の列は潰させない。長すぎる1語だけはその中で折る (他の語は区切りで折る) */
    .reader-name {
        min-width: 12rem;
        overflow-wrap: break-word;
    }
    /* 種別の切り替え (`.chip`) と同じ高さにして、1行に並べる */
    .scan-controls button {
        padding: 0.15rem 0.75rem;
        font-size: var(--dp-text-xs);
        line-height: 1.6;
    }
    /* 受信できるチャンネルの局。ロゴと名前を1組にして、折り返しても組は割らない */
    .stations {
        display: flex;
        flex-wrap: wrap;
        gap: 0.15rem 0.9rem;
    }
    .station {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
    }
    /* ロゴの無い局の場所。まだ取れていないものは点線の枠、取れないものは空けるだけ */
    .logo-slot {
        flex-shrink: 0;
        width: 1.6rem;
        height: 0.9rem;
        border-radius: 0.25rem;
    }
    .logo-slot.missing {
        border: 1px dashed var(--dp-line-strong);
    }
    /* 局ごとの一覧 (畳んである) */
    .cm-logo-list > summary {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        font-size: var(--dp-text-sm);
    }
    .cm-group {
        margin-top: var(--dp-space-3);
    }
    .cm-group h3 {
        margin-bottom: 0.25rem;
        font-weight: var(--dp-weight);
    }
    /* 枠で囲まず、何列にも詰める。開いた局だけ1段を使う */
    .cm-logos {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
        gap: 0 var(--dp-space-2);
    }
    .cm-logo {
        min-width: 0;
        margin: 0;
    }
    .cm-logo[open] {
        grid-column: 1 / -1;
        padding-bottom: 0.5rem;
    }
    .cm-logo > summary {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        margin: 0;
        padding: 0.2rem 0.35rem;
        border-radius: var(--dp-radius);
        line-height: 1.5;
        list-style: none;
        transition: background-color var(--dp-duration) var(--dp-ease);
    }
    .cm-logo > summary::-webkit-details-marker,
    .cm-logo > summary::after {
        display: none;
    }
    .cm-logo > summary:hover,
    .cm-logo[open] > summary {
        background: var(--dp-subtle);
    }
    /* 覚えたかどうかの小さな点。まだは枠だけ、覚えたものは成功の色で塗る */
    .state-dot {
        flex-shrink: 0;
        width: 0.5rem;
        height: 0.5rem;
        border: 1px solid var(--dp-line-strong);
        border-radius: var(--dp-radius-full);
    }
    .cm-logo[data-learned='true'] .state-dot {
        border-color: var(--dp-ok);
        background: var(--dp-ok);
    }
</style>
