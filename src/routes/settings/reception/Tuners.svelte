<script lang="ts">
    import '@anyblades/blades/layered/content/table';
    import { arming } from '#lib/arming.svelte.js';
    import { autosave, SaveState } from '#lib/autosave.svelte.js';
    import Lead from '#lib/components/Lead.svelte';
    import Icon from '#lib/components/player/Icon.svelte';
    import SaveNote from '#lib/components/SaveNote.svelte';
    import { SERVICE_TYPE_LABEL, splitReaderName } from '#lib/format.js';
    import { held } from '#lib/live-updates.svelte.js';
    import type { CardReaderState } from '#lib/server/scramble.js';
    import { CHANNEL_TYPES } from '#lib/types.js';
    import Ellipsis from '~icons/lucide/ellipsis';
    import type { PageData } from './$types';

    let { data }: { data: PageData } = $props();

    /** チューナーの設定の保存の様子 (その場で保存する。`autosave`) */
    const configSave = new SaveState();
    /** チューナーの行の削除は 2 回押し (ほかの画面の削除と同じ。`arming`) */
    const deleting = arming('[data-testid^="tuner-delete"]');

    /**
     * 衛星の給電の選び方。値はエージェントが読む字のまま (小文字。`agent/Denpa.Agent/Tuning.cs`)。
     * 設定ファイルに手で書いた別の値は、消さずに選べるものとして足す (`lnbChoices`)
     */
    const LNB_CHOICES = [
        { value: '', label: 'なし' },
        { value: '15v', label: '15V' },
        { value: '11v', label: '11V' },
    ];
    function lnbChoices(lnb: string) {
        return LNB_CHOICES.some((choice) => choice.value === lnb) ? LNB_CHOICES : [...LNB_CHOICES, { value: lnb, label: lnb }];
    }
    /**
     * チューナーの表の骨組みの行の高さ (rem)。本物の行 (名前とデバイスの2行で 2.9rem) から行の間 (0.4rem) を
     * 引いたもの。台数は届くまで分からないので、よくある4台ぶん
     */
    const TUNER_SKELETON = [2.5, 2.5, 2.5, 2.5];

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

    /**
     * 「⋯」で開いている行 (名前・デバイス・LNB・削除)。開くのは1行だけ。
     * **閉じていても欄は消さずに隠すだけ** — 送る値は全部の行の欄から作るので
     * (`tuners.server.ts`)、欄を消すとその行ごとチューナーが消える
     */
    let opened = $state<number | null>(null);
    /** 「追加」で出す欄。足せたら (台数が増えたら) 閉じる。断られたら打った字を残したまま */
    let adding = $state(false);
    let lastCount = 0;
    $effect(() => {
        const count = shownTuners.value?.list.length ?? 0;
        if (count > lastCount) adding = false;
        if (count < lastCount) opened = null;
        lastCount = count;
    });

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
    **チューナーは1つの表。** いまの様子 (空き・使っているもの) と設定 (種別・使うか) を同じ行に並べる。
    空きの表と設定の表を分けていた頃は、名前と種別と無効が2つの表に2度ずつ出ていた。
    名前・デバイス・LNB・削除は入れたときしか触らないので、行の「⋯」の中。
    カードリーダーも同じ機材の話なので、同じ節の下に置く
-->
<div class="sections">
<section class="section" data-testid="tuner-section">
    <div class="section-head">
        <h2>チューナー</h2>
        <SaveNote status={configSave} />
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
    {#await data.detected then detected}
        {#if detected}
            <Lead>
                いまは<strong>挿さっているチューナーを自動で見つけて</strong>使っています。
                どれかを変えると、この内容に固定します
            </Lead>
        {/if}
    {/await}

    {#if shownTuners.value === undefined}
        <!--
            エージェントの答え待ち。**本物の表と同じ形・同じ高さの枠を先に置く** (番組表・ルールの
            下見と同じ骨組み)。字だけ出していた頃は、届いた拍子に表が出て下の節が押し下げられた
        -->
        <div class="skeleton" role="status" aria-label="チューナーを確認しています">
            <div class="skeleton-head" aria-hidden="true"></div>
            {#each TUNER_SKELETON as height, row (row)}
                <div class="skeleton-block" style="height: {height}rem" aria-hidden="true"></div>
            {/each}
        </div>
    {:else if shownTuners.value.error !== null}
        <!--
            繋がらなかったときに空の一覧だけ出すと「1台も無い」と
            見分けが付かない。理由をそのまま出す
        -->
        <div class="notice error small">
            チューナーエージェントに繋がりません: {shownTuners.value.error}
        </div>
    {:else}
        {@const tuners = shownTuners.value.list}
        <!--
            **変えたらその場で保存する** (`autosave`。設定のほかの節と同じ)。文字の欄は離れたとき、
            チェック・スイッチ・選択は変えたとき。
            名前は空にできない (断って元に戻す)。行を消すのは「⋯」の中の 2 回押し。
            **行の追加はボタンで** — 足すための欄は、名前を打っている途中や
            デバイスを入れる前に送らない (`data-no-autosave`)。自動検出に戻すのもボタン
        -->
        <form method="POST" action="?/tuners" use:autosave={configSave}>
            {#if tuners.length === 0}
                <p class="small muted">チューナーがありません。「追加」から足してください。</p>
            {:else}
                <div class="table-wrap tuners-wrap">
                    <table class="tuners">
                        <thead>
                            <tr>
                                <th>チューナー</th>
                                <th>受信できる種別</th>
                                <th class="wide">状態</th>
                                <th>使う</th>
                                <th><span class="visually-hidden">詳しく</span></th>
                            </tr>
                        </thead>
                        <tbody data-testid="tuner-list">
                            {#each tuners as tuner, index (tuner.index)}
                                {@const detailId = `tuner-detail-${index}`}
                                <tr class="main" class:off={tuner.disabled} data-testid="tuner-row">
                                    <td class="name-cell">
                                        <div class="truncate">{tuner.name}</div>
                                        {#if tuner.device !== null}
                                            <div class="tiny muted mono truncate" data-testid="tuner-device">{tuner.device}</div>
                                        {/if}
                                    </td>
                                    <td class="types-cell" data-label="受信できる種別">
                                        <div class="chips types">
                                            {#each CHANNEL_TYPES as type (type)}
                                                <label class="chip">
                                                    <input
                                                        type="checkbox"
                                                        name={`type.${index}.${type}`}
                                                        checked={tuner.types.includes(type)}
                                                    />
                                                    {SERVICE_TYPE_LABEL[type]}
                                                </label>
                                            {/each}
                                        </div>
                                    </td>
                                    <td class="state-cell small">
                                        <!--
                                            空き・使用中と、使っているもの。**数字を出さない。** 何に使っているか
                                            (録画・ライブ視聴・番組表…) が出ていれば、どちらが譲るかは用途で決まる
                                            (上の「詳しく」に順番)。ルールの「優先度」(0〜9) と同じ名前の別の
                                            物差しが並ぶと、ルールの 2 が番組表の 3 に負けるように読めていた。
                                            数は調べるとき用に `data-priority` にだけ残す。
                                            目印は番号で。同じ用途が2つ乗ることはあり、字を目印にすると落ちる
                                        -->
                                        <div class="cluster state">
                                            {#if tuner.disabled}
                                                <span class="tag">無効</span>
                                            {:else if tuner.channel !== null}
                                                <span class="tag warning">使用中</span>
                                                <span class="mono">{tuner.channel.channel}</span>
                                            {:else}
                                                <span class="tag success">空き</span>
                                            {/if}
                                        </div>
                                        {#each tuner.users as user, i (i)}
                                            <div class="truncate" data-testid="tuner-user" data-priority={user.priority}>
                                                {user.label}
                                            </div>
                                        {/each}
                                        {#if tuner.error !== null && tuner.channel === null}
                                            <div class="text-error tiny" data-testid="tuner-error">{tuner.error}</div>
                                        {/if}
                                    </td>
                                    <td class="use-cell">
                                        <!-- 使わないチューナーは選局しない (ほかのソフトに残すとき。docs/switch.md) -->
                                        <label class="hit">
                                            <input
                                                type="checkbox"
                                                role="switch"
                                                name={`use.${index}`}
                                                checked={!tuner.disabled}
                                                aria-checked={!tuner.disabled}
                                                aria-label={`${tuner.name} を使う`}
                                                data-testid="tuner-use"
                                            />
                                        </label>
                                    </td>
                                    <td class="more-cell">
                                        <button
                                            type="button"
                                            class="ghost more-button"
                                            aria-label={`${tuner.name} の名前・デバイス・LNB`}
                                            aria-expanded={opened === index}
                                            aria-controls={detailId}
                                            onclick={() => (opened = opened === index ? null : index)}
                                            data-testid="tuner-more"
                                        >
                                            <Icon icon={Ellipsis} size="size-4" />
                                        </button>
                                    </td>
                                </tr>
                                <tr class="detail" class:open={opened === index} id={detailId} data-testid="tuner-detail">
                                    <td colspan="5">
                                        <div class="detail-body">
                                            <label class="field">
                                                <span>名前</span>
                                                <input class="w-name" name={`name.${index}`} value={tuner.name} />
                                            </label>
                                            <label class="field grow">
                                                <span>デバイス</span>
                                                <input
                                                    class="mono"
                                                    name={`device.${index}`}
                                                    value={tuner.device ?? ''}
                                                    placeholder="/dev/dvb/adapter0/frontend0"
                                                />
                                            </label>
                                            <!--
                                                **選ばせる。打たせない。** エージェントが読むのは小文字の
                                                `15v` / `11v` だけで (`Tuning.cs`)、`15V` と打つと黙って
                                                給電されない。見せる字は大文字 (電圧の書き方)
                                            -->
                                            <label class="field">
                                                <span>LNB</span>
                                                <select class="w-lnb" name={`lnb.${index}`}>
                                                    {#each lnbChoices(tuner.lnb ?? '') as choice (choice.value)}
                                                        <option value={choice.value} selected={choice.value === (tuner.lnb ?? '')}>
                                                            {choice.label}
                                                        </option>
                                                    {/each}
                                                </select>
                                            </label>
                                            <div class="delete-slot">
                                                {#if deleting.armed === index}
                                                    <!--
                                                        2 回目。この行を除いて保存する。構えを下ろすのは送り出したあと —
                                                        押した場で下ろすと、送る前にこのボタンが消えて何も送られない
                                                    -->
                                                    <button
                                                        type="submit"
                                                        name="delete"
                                                        value={index}
                                                        class="small danger"
                                                        onclick={() => setTimeout(() => deleting.fire())}
                                                        data-testid="tuner-delete-confirm"
                                                    >
                                                        削除を確定
                                                    </button>
                                                {:else}
                                                    <button
                                                        type="button"
                                                        class="small outline danger"
                                                        onclick={() => deleting.arm(index)}
                                                        data-testid="tuner-delete"
                                                    >
                                                        削除
                                                    </button>
                                                {/if}
                                            </div>
                                        </div>
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            {/if}

            {#if adding}
                <!--
                    足すための欄。名前は番号の代わりに `add` (`name.add` …) で、「追加」のボタン (`add`) で送ったときだけサーバが読む。
                    ほかの行を変えたときの保存にも乗るが、そこでは読まれない (`tuners.server.ts`)
                -->
                <div class="add" data-no-autosave data-testid="tuner-add">
                    <input type="hidden" name="use.add" value="on" />
                    <label class="field">
                        <span>名前</span>
                        <input class="w-name" name="name.add" />
                    </label>
                    <label class="field grow">
                        <span>デバイス</span>
                        <input class="mono" name="device.add" placeholder="/dev/dvb/adapter0/frontend0" />
                    </label>
                    <div class="field">
                        <span>受信できる種別</span>
                        <div class="chips types">
                            {#each CHANNEL_TYPES as type (type)}
                                <label class="chip">
                                    <input type="checkbox" name={`type.add.${type}`} />
                                    {SERVICE_TYPE_LABEL[type]}
                                </label>
                            {/each}
                        </div>
                    </div>
                    <label class="field">
                        <span>LNB</span>
                        <select class="w-lnb" name="lnb.add">
                            {#each LNB_CHOICES as choice (choice.value)}
                                <option value={choice.value}>{choice.label}</option>
                            {/each}
                        </select>
                    </label>
                </div>
            {/if}
            <div class="cluster actions">
                {#if adding}
                    <button type="submit" name="add" value="1" class="small" data-testid="tuner-add-submit">追加</button>
                    <button type="button" class="small ghost" onclick={() => (adding = false)}>やめる</button>
                {:else}
                    <button type="button" class="small secondary outline" onclick={() => (adding = true)} data-testid="tuner-add-open">
                        追加
                    </button>
                {/if}
                <button type="submit" class="small ghost" formaction="?/tunersAuto">自動検出に戻す</button>
            </div>
        </form>
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
                <div class="skeleton-block" style="height: 2.35rem" aria-hidden="true"></div>
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
</div>

<style>
    /*
     * **チューナーの表は線で区切らない行** (ルールの一覧と同じ)。触れると淡い地、
     * 「⋯」で開いた中身は行のすぐ下に淡い地で。表 (`<table>`) のままにして、見出しと欄の縦を揃える。
     * 広い画面では横に巻かせない — 状態の列 (`.wide`) が余った幅を取り、ほかは中身の幅
     */
    .tuners-wrap {
        container-type: inline-size;
    }
    .tuners {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
    }
    .tuners th {
        border: 0;
        font-size: var(--dp-text-xs);
        font-weight: var(--dp-weight);
        color: var(--dp-muted);
        white-space: nowrap;
    }
    .tuners td {
        border: 0;
        background: transparent;
        vertical-align: middle;
        transition: background-color var(--dp-duration);
    }
    /* 「⋯」の中。閉じていても欄は送るので、消さずに隠す */
    .detail:not(.open) {
        display: none;
    }
    .detail td {
        padding-top: 0;
        background: var(--dp-hover-soft);
        border-end-start-radius: var(--dp-radius);
        border-end-end-radius: var(--dp-radius);
    }
    .tuners .main:hover td,
    .tuners .main:has(+ .detail.open) td {
        background: var(--dp-hover-soft);
    }
    .tuners .main td:first-child {
        border-start-start-radius: var(--dp-radius);
        border-end-start-radius: var(--dp-radius);
    }
    .tuners .main td:last-child {
        border-start-end-radius: var(--dp-radius);
        border-end-end-radius: var(--dp-radius);
    }
    .tuners .main:has(+ .detail.open) td {
        border-end-start-radius: 0;
        border-end-end-radius: 0;
    }
    /* 使わないチューナーは名前と状態を沈める (印の「無効」と合わせて、色だけに頼らない) */
    .tuners .main.off :is(.name-cell, .state-cell) {
        opacity: 0.55;
    }
    .name-cell {
        max-width: 16rem;
        font-size: var(--dp-text-sm);
    }
    .types {
        flex-wrap: nowrap;
    }
    .state {
        gap: var(--dp-space-2);
    }
    .use-cell,
    .more-cell {
        width: 1%;
        white-space: nowrap;
    }
    /* スイッチと「⋯」は押す的を広く取る (指で押す端末では 44px 角) */
    .hit {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 2.25rem;
        min-height: 2rem;
        margin: 0;
        cursor: pointer;
    }
    .hit input {
        margin: 0;
    }
    .more-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 2rem;
        min-height: 2rem;
        margin: 0;
        padding: 0.25rem;
        color: var(--dp-muted);
    }
    .more-button[aria-expanded='true'] {
        color: inherit;
    }
    .detail-body,
    .add {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: var(--dp-space-2) var(--dp-space-3);
        padding: var(--dp-space-2) 0 var(--dp-space-1);
    }
    .detail-body .field,
    .add .field {
        margin: 0;
    }
    .detail-body .grow,
    .add .grow {
        flex: 1 1 14rem;
        min-width: 0;
    }
    :is(.detail-body, .add) :is(input:not([type='checkbox']), select) {
        margin: 0;
    }
    .w-name {
        width: 9rem;
    }
    .w-lnb {
        width: 6rem;
    }
    .delete-slot {
        margin-inline-start: auto;
    }
    .delete-slot button,
    .actions button {
        margin: 0;
    }
    .add {
        margin-top: var(--dp-space-2);
    }
    .actions {
        margin-top: var(--dp-space-2);
    }
    @media (pointer: coarse) {
        .hit,
        .more-button {
            min-width: 2.75rem;
            min-height: 2.75rem;
        }
        .tuners .chip,
        .add .chip,
        .delete-slot button,
        .actions button {
            min-height: 2.75rem;
        }
        .tuners .chip,
        .add .chip {
            padding-inline: 0.75rem;
        }
    }
    /*
     * **狭い幅 (スマートフォン) では、1台を2〜3段の行にする。** 1段目に名前とスイッチ・「⋯」、
     * 2段目に状態、3段目に受信できる種別。見出しの行は隠し、種別にだけ欄の名前を書く
     */
    @container (max-width: 36rem) {
        .tuners,
        .tuners tbody,
        .tuners td {
            display: block;
        }
        .tuners thead {
            display: none;
        }
        .tuners .main {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto auto;
            grid-template-areas:
                'name use more'
                'state state state'
                'types types types';
            align-items: center;
            gap: var(--dp-space-1) var(--dp-space-2);
            padding: var(--dp-space-2) var(--dp-space-2);
            border-radius: var(--dp-radius);
        }
        .tuners .main:has(+ .detail.open) {
            border-end-start-radius: 0;
            border-end-end-radius: 0;
            background: var(--dp-hover-soft);
        }
        /* 開いた行の中身。行 (.main) の td より先に置く (別の行なので並びで効き方は変わらない) */
        .detail td {
            padding: 0 var(--dp-space-2) var(--dp-space-2);
        }
        .tuners .main td,
        .tuners .main:hover td,
        .tuners .main:has(+ .detail.open) td {
            padding: 0;
            border-radius: 0;
            background: transparent;
        }
        .tuners .main:hover {
            background: var(--dp-hover-soft);
        }
        .name-cell {
            grid-area: name;
            max-width: none;
        }
        .use-cell {
            grid-area: use;
            width: auto;
        }
        .more-cell {
            grid-area: more;
            width: auto;
        }
        .state-cell {
            grid-area: state;
        }
        .types-cell {
            grid-area: types;
        }
        .types {
            flex-wrap: wrap;
        }
        .tuners .detail.open {
            display: block;
        }
        .detail-body .field,
        .add .field {
            flex: 1 1 100%;
        }
        .detail-body :is(.w-name, .w-lnb),
        .add :is(.w-name, .w-lnb) {
            width: 100%;
        }
        .delete-slot {
            margin-inline-start: 0;
        }
    }

    /*
     * **カードリーダーは、スマートフォンの幅では表をやめて1行ずつのカードにする**。
     * **名前を `.stack` にしない。** app.css の `.stack` (縦に積む flex) が広い画面でも表に当たり、
     * 表が flex になって見出しと行が別々に詰められ、列がずれていた (#651 で入れたとき)。
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
    }
    @container (max-width: 36rem) {
        .types-cell[data-label]::before {
            content: attr(data-label);
            display: block;
            margin-bottom: 0.25rem;
            font-size: 0.8rem;
            color: var(--dp-muted);
        }
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
    /* リーダーの表もチューナーの表と同じく、線で区切らない行。見出しは小さく淡く */
    .reader :is(th, td) {
        border: 0;
    }
    .reader th {
        font-size: var(--dp-text-xs);
        font-weight: var(--dp-weight);
        color: var(--dp-muted);
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
     * 答え待ちの骨組み (色と光の筋は `app.css` の `.skeleton`。番組表と同じ)。見出しの行だけ濃い。
     * 高さは本物の表と同じにしてある (届いた拍子に下の節が動かない)
     */
    .skeleton {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    }
    .skeleton-head {
        height: 1.8rem;
    }
    .skeleton-tag {
        display: inline-block;
        width: 2.5rem;
        height: 1.1rem;
        border-radius: var(--dp-radius-full);
        background: var(--dp-subtle);
    }
</style>
