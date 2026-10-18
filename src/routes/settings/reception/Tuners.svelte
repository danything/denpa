<script lang="ts">
    import { arming } from '#lib/arming.svelte.js';
    import { autosave, SaveState } from '#lib/autosave.svelte.js';
    import Lead from '#lib/components/Lead.svelte';
    import Icon from '#lib/components/player/Icon.svelte';
    import SaveNote from '#lib/components/SaveNote.svelte';
    import { SERVICE_TYPE_LABEL, splitReaderName } from '#lib/format.js';
    import { held } from '#lib/live-updates.svelte.js';
    import type { CardReaderState } from '#lib/server/scramble.js';
    import X from '~icons/lucide/x';
    import type { PageData } from './$types';

    let { data }: { data: PageData } = $props();

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
    /**
     * チューナーの表の骨組みの行の高さ (rem)。本物の行 (1.8rem) から行の間 (0.4rem) を引いたもの。
     * 台数は届くまで分からないので、よくある4台ぶん
     */
    const TUNER_SKELETON = [1.4, 1.4, 1.4, 1.4];

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
</script>

<svelte:window onclick={deleting.stand} />

<!--
    **チューナーの空き → チューナーの設定** の順。いまの様子を先に、入れたときしか触らない設定を後に。
    カードリーダーも同じ機材の話なので、空きの節に並べる
-->
<div class="sections">
    <!--
        録るのも番組表を集めるのもここの取り合いで、スキャン中に見たいのも「いま何台使っているか」
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
            <!--
                エージェントの答え待ち。**本物の表と同じ形・同じ高さの枠を先に置く** (番組表・ルールの
                下見と同じ骨組み)。字だけ出していた頃は、届いた拍子に表が出て下の節が押し下げられた
            -->
            <div class="skeleton" role="status" aria-label="チューナーを確認しています">
                <div class="skeleton-head" aria-hidden="true"></div>
                {#each TUNER_SKELETON as height, row (row)}
                    <div class="skeleton-row" style="height: {height}rem" aria-hidden="true"></div>
                {/each}
            </div>
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
                    チューナーがありません。下の「チューナーの設定」から追加してください。
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
                                <tr data-testid="tuner-row">
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
                    <!-- 答え待ち。「正常」「エラー」のバッジと同じ大きさの枠 -->
                    <span class="skeleton skeleton-tag" data-testid="status-card-reader" aria-hidden="true"></span>
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
            {#if shownCard.value === undefined}
                <!-- リーダーの表も同じ形の枠を先に置く (リーダーは1つのことが多い。名前と場所の2行) -->
                <div class="skeleton" role="status" aria-label="カードリーダーを確認しています">
                    <div class="skeleton-head" aria-hidden="true"></div>
                    <div class="skeleton-row" style="height: 2.35rem" aria-hidden="true"></div>
                </div>
            {:else}
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
                **変えたらその場で保存する** (`autosave`。設定のほかの節と同じ)。文字の欄は離れたとき、
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
                    <button type="submit" class="small secondary outline">追加</button>
                    <button type="submit" class="small ghost" formaction="?/tunersAuto">
                        自動検出に戻す
                    </button>
                </div>
            </form>
        {/if}
    </section>
</div>

<style>
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
    .wide {
        width: 100%;
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
    /*
     * 答え待ちの骨組み (番組表・ルールの下見と同じ形と色)。見出しの行だけ濃く、光の筋が横に流れる。
     * 高さは本物の表と同じにしてある (届いた拍子に下の節が動かない)
     */
    .skeleton {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        overflow: hidden;
    }
    .skeleton-head,
    .skeleton-row {
        border-radius: var(--dp-radius-sm);
        background: var(--dp-subtle);
    }
    .skeleton-head {
        height: 1.8rem;
        background: var(--dp-line);
    }
    .skeleton-tag {
        display: inline-block;
        width: 2.5rem;
        height: 1.1rem;
        border-radius: var(--dp-radius-full);
        background: var(--dp-subtle);
    }
    .skeleton::after {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(90deg, transparent 0%, rgb(255 255 255 / 0.06) 50%, transparent 100%);
        transform: translateX(-100%);
        animation: skeleton-sweep var(--dp-shine) ease-in-out infinite;
    }
    @keyframes skeleton-sweep {
        to {
            transform: translateX(100%);
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .skeleton::after {
            animation: none;
        }
    }
</style>
