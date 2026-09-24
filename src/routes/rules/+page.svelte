<script lang="ts">
    import { page } from '$app/state';
    import { submitting } from '$lib/actions';
    import { GENRE_TREE, genreName } from '$lib/arib';
    import ProgramDetail from '$lib/components/ProgramDetail.svelte';
    import Toasts, { errorNotice, type Notice } from '$lib/components/Toasts.svelte';
    import { programDetail } from '$lib/detail.svelte';
    import { badgeClass, CM_LABEL, dateTime, SERVICE_TYPE_LABEL, stateLabel } from '$lib/format';
    import { matches, Paged, sentinel } from '$lib/paging.svelte';
    import { parseSearchFields, SEARCH_FIELD_LABEL, SEARCH_FIELDS, searchFieldLabel } from '$lib/search';
    import type { Preview, PreviewRow } from './+page.server';

    let { data, form } = $props();

    /**
     * 下見。**器より後から届く** (`+page.server.ts` の `previewOf`)。
     *
     * これから先の番組を全部見るので、実データではこの画面でいちばん待つところ。
     * 条件の枠とルールの一覧は先に出して、ここだけ読み込み中にしておけば、
     * **打ち直しも取り消しも待たずにできる**。番組表と同じ作り
     * (`guide/+page.svelte` の `sheet`)
     */
    let preview = $state<Preview | null>(null);
    let shownKey = '';
    $effect(() => {
        const key = page.url.search;
        const coming = data.preview;
        if (coming === null) {
            preview = null;
            shownKey = key;
            return;
        }
        // 条件が変わったら前の下見は捨てる (別の条件の結果を出したままにしない)
        if (key !== shownKey) preview = null;
        let stale = false;
        void coming.then((next) => {
            if (stale) return;
            preview = next;
            shownKey = key;
        });
        return () => {
            stale = true;
        };
    });

    /**
     * 下見を待っている間の枠の形。数は決め打ち (何件当たるかは届くまで分からない)。
     * 高さをばらけさせるのは、揃っていると表ではなくただの縞に見えるため
     */
    const PREVIEW_SKELETON = [2.5, 3, 2.5, 3.5, 2.5, 3, 2.5, 3.5];

    /** フォームの初期値として選んでおくチャンネルと種別 */
    const seedTypes = $derived(data.seed?.service_types ?? []);
    const seedServices = $derived(data.seed?.service_ids ?? []);
    const seedGenres = $derived(data.seed?.genres ?? []);
    const seedFields = $derived(parseSearchFields(data.seed?.search_fields));


    /**
     * プレビューの行から開く番組詳細 (detail.svelte.ts)。予約一覧と同じ見せ方。
     *
     * 出しているのは番組名と局と時刻だけで、**この条件で本当にこれを録りたいのか**は
     * それだけでは決められなかった。同じ題名の再放送・傍題の違い・番組の中身は
     * 詳細にしか無く、確かめるには番組表を別に開いて探し直すことになっていた
     */
    const detail = programDetail();
    /**
     * 詳細を開いている行そのもの。**`detail.current` とは別に持つ。**
     *
     * 詳細が持っているのは番組の中身 (名前・説明・ジャンル) だけで、番組ID も
     * 局も予約の状態も入っていない — 押すもの (視聴・予約) を出すのに要るのは
     * そちらなので、開いた行を掴んでおく
     */
    let opened = $state<PreviewRow | null>(null);

    function show(program: PreviewRow): void {
        opened = program;
        void detail.open(program.id, program);
    }

    function close(): void {
        opened = null;
        detail.close();
    }

    /**
     * いま放送中かどうかの判定に使う時計。**分で刻む。**
     *
     * 番組表と同じ (`guide/+page.svelte`)。開きっぱなしのまま番組が終わっても
     * 「視聴」が出たままになるのを防ぐ
     */
    let clock = $state(Date.now());
    $effect(() => {
        const timer = setInterval(() => (clock = Date.now()), 60_000);
        return () => clearInterval(timer);
    });

    /** ライブ画面が持っている局。**決めているのはサーバ** (`epg.watchableServices`) */
    const watchable = $derived(new Set(data.watchable));

    function channels(rule: { service_types: string[] | null; service_ids: number[] | null }): string {
        const parts = [
            ...(rule.service_types ?? []).map((t) => SERVICE_TYPE_LABEL[t] ?? t),
            ...(rule.service_ids ?? []).map((id) => data.services.find((s) => s.id === id)?.name ?? String(id)),
        ];
        return parts.length === 0 ? '全局' : parts.join(', ');
    }

    /** 絞り込んでいるジャンル。条件のうち一番見落としやすいので、名前と並べず条件の行に出す */
    function genres(rule: { genres: string[] | null }): string {
        const parts = (rule.genres ?? []).map(genreName);
        return parts.length === 0 ? '全ジャンル' : parts.join(', ');
    }

    /** チャンネルは50局以上あるので種別ごとにまとめる */
    const grouped = $derived(
        ['GR', 'BS', 'CS', 'SKY']
            .map((type) => ({ type, services: data.services.filter((s) => s.type === type) }))
            .filter((g) => g.services.length > 0),
    );

    /**
     * 一覧の絞り込み。**Ctrl+F の代わり。**
     *
     * 一覧は少しずつしか描かない (下の `paged`) ので、画面に無い行はブラウザの
     * 検索では見つからない。名前だけでなく、条件に出しているもの (キーワード・
     * 除外・チャンネル・ジャンル・有効かどうか) も当てる — 「NHK のルールは
     * どれだったか」で探せるように。読み方はルールのキーワードと同じ
     * (空白で区切った語をすべて含む)
     */
    let filter = $state('');
    const filtered = $derived(
        data.rules.filter((rule) =>
            matches(
                filter,
                [
                    rule.name,
                    rule.keyword,
                    rule.ignore_keyword,
                    channels(rule),
                    genres(rule),
                    rule.enabled ? '有効' : '無効',
                ].join(' '),
            ),
        ),
    );

    /**
     * 少しずつ出す (`paging.svelte.ts`)。
     *
     * ルールが数百に溜まると、この画面を開いた直後に一瞬止まって見える —
     * 全部の行を描き終わるまで何も動かない。最初は 1 画面ぶん少し多めだけ描き、
     * 下端に近づいたら続きを足す。**絞り込みが変わったら先頭に戻す**
     * (絞ったあとの一覧が前と同じ長さとは限らない)
     */
    const paged = new Paged(() => filtered, 40);
    $effect(() => {
        void filter;
        paged.reset();
    });

    /** 押した結果 */
    const notices = $derived<Notice[]>(errorNotice(form, 'rule-error'));

</script>

<!--
    **左に書く欄、右に一覧。** 縦に積んでいた頃は、条件をいじるたびに
    一覧まで押し下げられて、**何が録れるようになったかを見るのに毎回
    スクロールで戻る**ことになっていた。広い画面では横がまるまる余っていて、
    キーワード1つの入力欄が 600px あるのに一覧は画面の外、という形だった。

    **横に並べはじめる幅は全画面で 768px**
    ([+layout.svelte](../+layout.svelte) の `FILLED`)。並べたらページごとは
    動かさず、**左右がそれぞれ自分で巻き取る** — 書いている欄と一覧の
    どちらも画面から出ていかない
-->
<div class="page">
    <Toasts {notices} source={form} />

    <div class="layout">
        <!--
            **書く欄。** 中身を浮かせて枠に高さを持たせないことで、右の一覧と
            同じ高さに収まる (観る画面と同じ作り。`watch/[id]/+page.svelte`)
        -->
        <section class="form-col">
            <div class="panel form-card">
                <!--
                    **押すものは巻き取られる中身の外に貼り付ける。** 条件が長い
                    ときに「追加」まで探して降りることになるので、`<form>` 自身を
                    縦の入れ物にして、上だけを巻き取る
                -->
                <form method="POST" use:submitting class="rule-form">
                    <div class="form-scroll" data-testid="rule-form">
                        <div class="heading">
                            <h2>
                                {data.editing ? 'ルールを編集' : 'ルールを追加'}
                            </h2>
                            <p class="small lead">
                                条件に合う番組を、これから放送されるものから自動で予約します。ルール名はキーワードから付きます。
                            </p>
                        </div>
                        {#if data.editing}
                            <input type="hidden" name="id" value={data.editing.id} />
                            <!-- 「この条件で何が録れるか見る」は GET でこの画面に戻ってくる。
                     どのルールを編集していたかを持ち回らないと、追加の画面に戻ってしまう -->
                            <input type="hidden" name="edit" value={data.editing.id} />
                        {/if}
                        <!--
                チェックを外した状態は GET だと「キー自体が無い」になって、
                番組表から keyword だけ渡されたときと見分けが付かない。
                この印があるときはチェックボックスの状態をそのまま信じる
            -->
                        <input type="hidden" name="form" value="rules" />

                        <!-- 横に並べない。左の列は 26rem までなので、並べると入力欄が潰れる -->
                        <div class="fields">
                            <label class="field">
                                <span class="label">キーワード</span>
                                <input
                                    name="keyword"
                                    placeholder="例: 名探偵"
                                    value={data.seed?.keyword ?? ''}
                                    data-testid="rule-keyword"
                                />
                                <span class="hint">
                                    空白で区切ると<strong>すべて含む</strong>ものに当たります
                                </span>
                                <!--
                        当てる範囲。既定は番組名だけ。概要まで広げると番宣で名前が出ただけの
                        番組を拾い、詳細まで広げると出演者でも拾える
                    -->
                                <div class="wrap-row" data-testid="rule-search-fields">
                                    {#each SEARCH_FIELDS as field (field)}
                                        <label class="check">
                                            <input
                                                type="checkbox"
                                                name="searchFields"
                                                value={field}
                                                checked={seedFields.includes(field)}
                                            />
                                            <span class="tiny">{SEARCH_FIELD_LABEL[field]}</span>
                                        </label>
                                    {/each}
                                </div>
                            </label>
                            <label class="field">
                                <span class="label">除外キーワード</span>
                                <input
                                    name="ignoreKeyword"
                                    placeholder="例: 再放送 総集編"
                                    value={data.seed?.ignore_keyword ?? ''}
                                    data-testid="rule-ignore"
                                />
                                <span class="hint">
                                    空白区切りは<strong>どれか1つでも含む</strong>ものを除外
                                </span>
                            </label>
                            <label class="field">
                                <span class="label">優先度</span>
                                <input
                                    type="number"
                                    name="priority"
                                    value={data.seed?.priority ?? 1}
                                    min="0"
                                    max="9"
                                    data-testid="rule-priority"
                                />
                                <!--
                        **比べる相手は予約だけ。** チューナー画面に出ている「掴む強さ」
                        (番組表 3 / スキャン 5 …) とは別の物差しで、そちらとは比べない。
                        録画は必ずいちばん強い値で掴むので、番組表集めに負けることはない
                    -->
                                <span class="hint">
                                    <strong>予約どうし</strong>を比べる数です。チューナーが足りないとき<strong
                                        >大きいほうを残します</strong
                                    >
                                    (手動予約は 2)。番組表集めやロゴ集めとは比べません — 録画は必ずそれらより強く掴みます。
                                </span>
                            </label>
                        </div>

                        <div class="fields">
                            <details class="box">
                                <summary class="small bold" data-testid="channel-summary">
                                    チャンネル
                                    <span class="muted">
                                        ({seedTypes.length + seedServices.length === 0
                                            ? '全局'
                                            : `${seedTypes.length + seedServices.length} 件選択中`})
                                    </span>
                                </summary>
                                <div class="box-body stack">
                                    <div>
                                        <div class="group-title bold">まとめて選ぶ</div>
                                        <div class="wrap-row" data-testid="rule-types">
                                            {#each grouped as group (group.type)}
                                                <label class="check">
                                                    <input
                                                        type="checkbox"
                                                        name="serviceTypes"
                                                        value={group.type}
                                                        checked={seedTypes.includes(group.type)}
                                                    />
                                                    <span class="small">
                                                        {SERVICE_TYPE_LABEL[group.type] ?? group.type}
                                                        <span class="muted">
                                                            ({group.services.length})
                                                        </span>
                                                    </span>
                                                </label>
                                            {/each}
                                        </div>
                                    </div>
                                    <div>
                                        <div class="group-title bold">個別に選ぶ</div>
                                        <div class="scroll-list services" data-testid="rule-services">
                                            {#each grouped as group (group.type)}
                                                <div>
                                                    <div class="group-title">
                                                        {SERVICE_TYPE_LABEL[group.type] ?? group.type}
                                                    </div>
                                                    <div class="grid-2">
                                                        {#each group.services as service (service.id)}
                                                            <label class="check">
                                                                <input
                                                                    type="checkbox"
                                                                    name="serviceIds"
                                                                    value={service.id}
                                                                    checked={seedServices.includes(
                                                                        service.id,
                                                                    )}
                                                                />
                                                                <span class="truncate small">{service.name}</span>
                                                            </label>
                                                        {/each}
                                                    </div>
                                                </div>
                                            {:else}
                                                <p class="small muted">
                                                    チャンネルがまだありません。チューナー画面でチャンネルスキャンを実行してください。
                                                </p>
                                            {/each}
                                        </div>
                                    </div>
                                </div>
                            </details>

                            <details class="box">
                                <summary class="small bold" data-testid="genre-summary">
                                    ジャンル
                                    <span class="muted">
                                        ({seedGenres.length === 0
                                            ? '全ジャンル'
                                            : `${seedGenres.length} 件選択中`})
                                    </span>
                                </summary>
                                <div class="box-body">
                                    <!-- 大分類だけ選べば中分類は問わない。細かく絞りたいときだけ
                             中分類にチェックを入れる -->
                                    <div class="scroll-list genres" data-testid="rule-genres">
                                        {#each GENRE_TREE as group (group.value)}
                                            <div>
                                                <label class="check">
                                                    <input
                                                        type="checkbox"
                                                        name="genres"
                                                        value={group.value}
                                                        checked={seedGenres.includes(group.value)}
                                                    />
                                                    <span class="small bold">{group.label}</span>
                                                    <span class="tiny muted">(すべて)</span>
                                                </label>
                                                {#if group.children.length > 0}
                                                    <div class="grid-2 children">
                                                        {#each group.children as child (child.value)}
                                                            <label class="check">
                                                                <input
                                                                    type="checkbox"
                                                                    name="genres"
                                                                    value={child.value}
                                                                    checked={seedGenres.includes(child.value)}
                                                                />
                                                                <span class="truncate tiny">{child.label}</span>
                                                            </label>
                                                        {/each}
                                                    </div>
                                                {/if}
                                            </div>
                                        {/each}
                                    </div>
                                </div>
                            </details>
                        </div>

                        <p class="small muted">
                            エンコードのしかたと無料放送の扱いは<a href="/settings">設定</a
                            >で決めます ({data.defaults.codec.toUpperCase()}
                            / CM: {CM_LABEL[data.defaults.cmCut]}{data.defaults.freeOnly
                                ? ' / 無料放送のみ'
                                : ''})
                        </p>
                    </div>

                    <!-- 巻き取られる中身の外。条件がどれだけ長くても見えている -->
                    <div class="form-actions cluster">
                        <button
                            type="submit"
                            class="small secondary"
                            formmethod="GET"
                            formaction="/rules"
                            data-testid="rule-preview"
                        >
                            何が録れるか見る
                        </button>
                        {#if data.editing}
                            <button type="submit" class="small" formaction="?/update" data-testid="rule-update">
                                更新
                            </button>
                            <a class="button small secondary" href="/rules" data-testid="rule-cancel-edit">編集をやめる</a>
                        {:else}
                            <button type="submit" class="small" formaction="?/create" data-testid="rule-submit">
                                追加
                            </button>
                        {/if}
                    </div>
                </form>
            </div>
        </section>

        <!--
            **右は結果。** この条件で何が録れるか (プレビュー) と、いまあるルール。
            ここだけが巻き取られるので、左で条件をいじっても書いている欄は
            動かない。

            このルールが押さえている予約は**フォームの外**に出してある。中に
            入れると form が入れ子になって、1件取り消すつもりでルールの更新まで
            送ってしまう。条件を狭めても既に立った予約は残る (意図して個別に
            残していることがあるので勝手には消さない) ので、要らないものだけ
            ここで外す
        -->
        <section class="result-col">
            {#if data.preview !== null && preview === null}
                <!--
                    下見が届くまで。**枠だけ先に置く** — 条件を打ち直すたびに
                    右の列ごと消えると、どこを見ていたか分からなくなる
                -->
                <div class="panel preview" data-testid="preview-skeleton" role="status" aria-label="下見を数えています">
                    <div class="skeleton-title" aria-hidden="true"></div>
                    <ul class="preview-list" aria-hidden="true">
                        {#each PREVIEW_SKELETON as height, row (row)}
                            <li class="skeleton-row" style="height: {height}rem"></li>
                        {/each}
                    </ul>
                </div>
            {:else if preview !== null && preview.failed !== null}
                <!-- 数えられなかった。黙って空にしない (本当の理由はサーバのログ) -->
                <div class="panel preview" data-testid="preview-failed">
                    <p class="muted">下見を数えられませんでした ({preview.failed})</p>
                </div>
            {:else if data.preview !== null && preview !== null}
                <!--
        **予約とプレビューは同じ一覧**。別々に並べていた頃は、同じ番組が2箇所に出るうえ、
        「押さえている予約」と「これから当たる番組」を頭の中で突き合わせることになっていた
    -->
                <div class="panel preview" data-testid="preview">
                    <h2 class="preview-title">
                        この条件で録れる番組は {preview.total} 件
                        {#if preview.total > preview.programs.length}
                            <span class="small muted normal">
                                (先頭 {preview.programs.length} 件)
                            </span>
                        {/if}
                        <!-- 重なりを見るのは出している分だけ (`readPreview`)。全部は見ていないと分かる書き方にする -->
                        {#if preview.conflicts > 0}
                            <span class="tag error outline" data-testid="preview-conflicts">
                                {preview.total > preview.programs.length ? '表示分に' : ''}競合 {preview.conflicts} 件
                            </span>
                        {/if}
                    </h2>
                    {#if preview.total === 0}
                        <p class="small muted">
                            いまの番組表では1件も当たりません。条件を緩めてください。
                        </p>
                    {:else}
                        <p class="tiny muted">
                            予約済みのものはここで取り消せます
                            (取り消した番組をルールがもう一度予約することはありません)。
                            条件を変えても既に入っている予約は残るので、条件から外れたものも
                            <span class="tag">条件外</span> として並べます。
                        </p>
                        <ul class="preview-list" data-testid="preview-list">
                            {#each preview.programs as program (program.id)}
                                <li class="preview-row small" data-testid="preview-row" data-program-id={program.id}>
                                    <!--
                                押すと番組詳細が出る。予約一覧・番組表と同じもの。

                                **押せるのは中身のところだけ。** 行ごと押せるようにすると
                                取消ボタンまで詳細を開く的の中に入り、押し間違えたときに
                                何が起きたのか分からなくなる
                            -->
                                    <div
                                        class="preview-open"
                                        data-testid="preview-open"
                                        role="button"
                                        tabindex="0"
                                        onclick={() => show(program)}
                                        onkeydown={(event) => event.key === 'Enter' && show(program)}
                                    >
                                        <div class="cluster tight">
                                            {#if program.reservation_state}
                                                <span
                                                    class="tag {badgeClass(program.reservation_state)}"
                                                    data-testid="preview-state"
                                                >
                                                    {stateLabel(program.reservation_state)}
                                                </span>
                                            {/if}
                                            {#if !program.matched}
                                                <span class="tag">条件外</span>
                                            {/if}
                                            <span class="truncate">{program.name}</span>
                                        </div>
                                        <div class="tiny muted">
                                            {program.service_name} ・ {dateTime(program.start_at)}
                                        </div>
                                        <!--
                                    チューナーの取り合いは**録ろうとした時点で初めて分かる**
                                    ので、ここで先に見せる。出すのは本数が足りなくなるものだけ
                                    (`contending`)。ただ時間が重なっているだけのものを
                                    出していた頃は、地上波チューナーが2本あって録れる組にも、
                                    そもそも別のチューナーを使う衛星の番組にも印が付いていた。

                                    **足りなくなるものは全部出す。** 1件だけ出していた頃は、
                                    3本ぶつかっていても1本しか見えず、どれを諦めれば
                                    いいのかが読めなかった
                                -->
                                        {#if program.conflict_reason}
                                            <div class="text-error tiny" data-testid="preview-conflict">
                                                {program.conflict_reason}
                                            </div>
                                        {/if}
                                        {#if program.conflicts.length > 0}
                                            <!--
                                        件数は本当の数、名前は先頭だけ。ゆるい条件だと
                                        1つの番組に何十本もぶつかることがあり、全部並べると
                                        1行が画面何個ぶんにもなる (件数さえ合っていれば
                                        「多すぎる」ことは伝わる)
                                    -->
                                            <div class="text-error tiny" data-testid="preview-conflict">
                                                チューナーの競合 {program.conflicts.length} 件: {program.conflicts
                                                    .slice(0, 3)
                                                    .join('、')}{program.conflicts.length > 3
                                                    ? ` ほか ${program.conflicts.length - 3} 件`
                                                    : ''}
                                            </div>
                                        {/if}
                                    </div>
                                    {#if program.reservation_id !== null}
                                        <form method="POST" action="?/cancelReservation" use:submitting>
                                            <input type="hidden" name="reservationId" value={program.reservation_id} />
                                            <button type="submit" class="xs outline danger" data-testid="rule-pending-cancel">
                                                取消
                                            </button>
                                        </form>
                                    {/if}
                                </li>
                            {/each}
                        </ul>
                    {/if}
                </div>
            {/if}

            <!--
    **「今すぐ全ルールを適用」は置かない。**

    ルールを当て直すのは番組表が動いたとき (`epg.settle`) と、ルールを
    足した/変えた/消したとき。押す理由のある場面が残っていない。
    番組表そのものを取りに行きたいなら、チューナー画面の
    「番組表をいますぐ集める」がその口で、集め終わりに当て直しまで通る
-->
            <!--
                **表ではなく行のカード** (録画一覧と同じ形)。7列の表にしていた頃は、
                タブレットの幅で「チャンネル」「ジャンル」が1文字ずつ折れて読めなかった。
                1件を 名前と札 → 条件 → 押すもの の順に縦に積めば、幅がいくらでも横には出ない
            -->
            <div class="panel rule-list" data-testid="rule-list">
                <!--
                    絞り込みの欄は一覧の頭に貼り付ける。巻き取るのは一覧のほうなので、
                    下のほうまで来てから絞り直したくなっても、上へ戻らずに済む。
                    ルールが1件も無いときは出さない (絞るものが無い)
                -->
                {#if data.rules.length > 0}
                    <div class="filter-bar">
                        <input
                            type="search"
                            class="small"
                            placeholder="一覧を絞り込む (名前・キーワード・チャンネル・ジャンル)"
                            aria-label="ルールの一覧を絞り込む"
                            bind:value={filter}
                            data-testid="rule-filter"
                        />
                    </div>
                {/if}
                {#each paged.rows as rule (rule.id)}
                    <div class="rule-row" data-testid="rule-row" data-rule-id={rule.id}>
                        <div class="cluster">
                            <span class="bold">{rule.name}</span>
                            <span class="tag {rule.enabled ? 'success' : ''}">
                                {rule.enabled ? '有効' : '無効'}
                            </span>
                            <!-- 優先度と予約数は札で。列にしていた頃は見出しが無いと何の数か分からなかった -->
                            <span class="tag">優先度 {rule.priority}</span>
                            <span class="tag">予約 {rule.reservations} 件</span>
                        </div>
                        <div class="conditions small">
                            <!-- どこを見て当たったのか分からないと、絞り込みの直しようがない -->
                            {#if rule.keyword}
                                <span data-testid="rule-search-scope">{searchFieldLabel(rule.search_fields)}から</span>
                            {/if}
                            {#if rule.ignore_keyword}
                                <span class="text-error">除外: {rule.ignore_keyword}</span>
                            {/if}
                            <span data-testid="rule-channels">チャンネル: {channels(rule)}</span>
                            <span data-testid="rule-genres-label">ジャンル: {genres(rule)}</span>
                        </div>
                        <div class="cluster">
                            <a class="button small secondary" href="/rules?edit={rule.id}" data-testid="rule-edit">編集</a>
                            <form method="POST" action="?/toggle" use:submitting>
                                <input type="hidden" name="id" value={rule.id} />
                                <button type="submit" class="small secondary" data-testid="rule-toggle">
                                    {rule.enabled ? '無効化' : '有効化'}
                                </button>
                            </form>
                            <form method="POST" action="?/delete" use:submitting>
                                <input type="hidden" name="id" value={rule.id} />
                                <button type="submit" class="small outline danger" data-testid="rule-delete">
                                    削除
                                </button>
                            </form>
                        </div>
                    </div>
                {:else}
                    <div class="rule-row small muted">
                        {data.rules.length === 0 ? 'ルールはまだありません' : '当たるルールはありません'}
                    </div>
                {/each}
                <!-- 下端に近づいたら続きを足す。まだ出していない件数を添えて、終わりではないと分かるように -->
                {#if paged.more}
                    <div class="rule-row small muted more" use:sentinel={() => paged.reveal()} data-testid="rule-more">
                        あと {paged.rest} 件…
                    </div>
                {/if}
                <!-- 絞った結果の件数は末尾に。入力欄の隣に出すと、打つたびに欄の幅が変わる -->
                {#if filter !== ''}
                    <div class="rule-row small muted more" data-testid="rule-filter-count">
                        {data.rules.length} 件中 {filtered.length} 件
                    </div>
                {/if}
            </div>
        </section>
    </div>
</div>

<!--
    プレビューの行から開いた番組詳細。

    **押すものは「視聴」「予約する」「閉じる」。** ここに出しているのは
    *その番組そのもの* にできることで、ルールの条件には触れない。条件を詰めて
    いる途中で「これは録っておきたい」に行き当たったとき、番組表を開いて同じ
    番組を探し直すことになっていた。

    **取り消しはここに出さない** — 行のほうに置いてある (`rule-pending-cancel`)。
    予約済みの行は状態の札が出るので、押すものが増えたり減ったりしない。

    **押し方は番組表の詳細と同じ** (`guide/+page.svelte`)。同じモーダルが画面に
    よって違う出方をすると、番組表で覚えた押し方が通じない。

    **二段組の外に置く。** 中に入れると、巻き取る箱の中で開くことになる
-->
{#if detail.current}
    <ProgramDetail program={detail.current} onclose={close}>
        {#snippet actions()}
            <!--
                失敗の理由は詳細の中に出す。押したのはこのモーダルの中のボタンで、
                モーダルは右下に浮かせる知らせ (Toasts) より上に出るので、
                下に隠れるものを出しても読めない (番組表の詳細と同じ扱い)
            -->
            {#if form?.message}
                <div class="notice error detail-error" data-testid="rule-detail-error">{form.message}</div>
            {/if}
            {#if opened?.reservation_state}
                <span class="tag info detail-state" data-testid="rule-detail-state">
                    {stateLabel(opened.reservation_state)}
                </span>
            {/if}

            {#if opened !== null && opened.start_at <= clock && opened.end_at > clock && watchable.has(opened.service_id)}
                <!--
                    **いま流れている番組は、その場で観られるようにする。**
                    押した先は別の画面で、そこで選局からやり直すことになるので
                    リンクにする (モーダルの中で始めるものではない)
                -->
                <a class="button outline" href="/live?service={opened.service_id}" data-testid="rule-detail-watch">
                    視聴
                </a>
            {/if}

            {#if opened !== null && opened.reservation_state === null && opened.end_at > clock}
                <!--
                    録画のしかたはここでは選ばせない。設定画面の1箇所で決める
                    (同じ選択肢を予約・ルール・設定に並べると、どれで決まったのか
                    分からなくなる)
                -->
                <form
                    method="POST"
                    action="?/reserve"
                    use:submitting={() =>
                        async ({ result, update }) => {
                            await update();
                            // 失敗したときは開いたままにして、中に理由を出す
                            if (result.type === 'success') close();
                        }}
                >
                    <input type="hidden" name="programId" value={opened.id} />
                    <button type="submit" data-testid="rule-detail-reserve">予約する</button>
                </form>
            {/if}

            <!-- 位置を動かさないため、いつでもここが最後 -->
            <button type="button" class="secondary" onclick={close} data-testid="detail-close">閉じる</button>
        {/snippet}
    </ProgramDetail>
{/if}

<style>
    @media (min-width: 768px) {
        .page {
            display: flex;
            height: 100%;
            flex-direction: column;
        }
    }
    .layout {
        display: grid;
        gap: 1rem;
    }
    @media (min-width: 768px) {
        .layout {
            min-height: 0;
            flex: 1 1 0%;
            grid-template-columns: minmax(20rem, 26rem) 1fr;
        }
    }
    .form-col {
        display: flex;
        flex-direction: column;
    }
    @media (min-width: 768px) {
        .form-col {
            position: relative;
            min-height: 0;
        }
    }
    .form-card {
        display: flex;
        min-height: 0;
        flex: 1 1 0%;
        padding: 0;
        box-shadow: 0 1px 3px rgb(0 0 0 / 0.2);
    }
    @media (min-width: 768px) {
        .form-card {
            position: absolute;
            inset: 0;
        }
    }
    .rule-form {
        display: flex;
        min-height: 0;
        flex: 1 1 0%;
        flex-direction: column;
    }
    .form-scroll {
        display: flex;
        min-height: 0;
        flex: 1 1 0%;
        flex-direction: column;
        gap: 1rem;
        overflow-y: auto;
        padding: 1rem;
    }
    .heading {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }
    /* 下見を待っている間の枠 (`preview-skeleton`)。本物と同じ場所・同じ大きさ。
       **見出し (`.heading h2`) をここに繋がない** — 繋いでいた頃は「ルールを追加」が
       灰色の箱になっていた */
    .skeleton-title {
        height: 1.5rem;
        width: 60%;
        margin-bottom: 0.75rem;
        border-radius: 0.375rem;
        background: var(--dp-base-300);
    }
    .skeleton-row {
        margin-bottom: 0.5rem;
        border-radius: 0.375rem;
        background: var(--dp-base-200);
        list-style: none;
    }

    .preview-title {
        font-size: 1rem;
    }
    .lead {
        opacity: 0.7;
    }
    .label {
        font-size: 0.875rem;
        font-weight: 500;
    }
    .hint {
        font-size: 0.75rem;
        opacity: 0.6;
    }
    .fields {
        display: grid;
        align-items: start;
        gap: 1rem;
    }
    .wrap-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem 1rem;
        margin-top: 0.25rem;
    }
    .box {
        border: 1px solid var(--dp-base-300);
        border-radius: 1rem;
    }
    .box summary {
        cursor: pointer;
        padding: 0.75rem 1rem;
    }
    .box-body {
        padding: 0 1rem 1rem;
    }
    .group-title {
        margin-bottom: 0.25rem;
        font-size: 0.75rem;
        opacity: 0.6;
    }
    .scroll-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        overflow-y: auto;
    }
    .services {
        max-height: 12rem;
    }
    .genres {
        max-height: 16rem;
    }
    .grid-2 {
        display: grid;
        gap: 0.25rem 1rem;
    }
    @media (min-width: 640px) {
        .grid-2 {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
    }
    .children {
        margin: 0.25rem 0 0 1.5rem;
    }
    .truncate {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .form-actions {
        flex-shrink: 0;
        padding: 1rem;
        border-top: 1px solid var(--dp-base-300);
    }
    .result-col {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 1rem;
    }
    @media (min-width: 768px) {
        .result-col {
            min-height: 0;
        }
        /*
         * **巻き取るのは札の中。** 列ごと巻き取っていた頃は、上へ抜けていく札が列の縁で
         * 真っ直ぐに切られ、**動かすと角丸が消えて**見えた (タブレット)。札はその場に居て
         * 中身だけ動けば、角はいつも丸い。プレビューが長いときは、そちらも自分で巻き取り、
         * 一覧の場所は半分は残す
         */
        .preview {
            min-height: 0;
            max-height: 50%;
            overflow-y: auto;
        }
        .rule-list {
            min-height: 0;
            flex: 1 1 0%;
            overflow-y: auto;
        }
    }
    .preview {
        display: flex;
        flex-shrink: 0;
        flex-direction: column;
        gap: 0.5rem;
        padding: 1.5rem;
        box-shadow: 0 1px 3px rgb(0 0 0 / 0.2);
    }
    .preview-title {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
    }
    .normal {
        font-weight: normal;
    }
    .preview-list {
        margin: 0.25rem 0 0;
        padding: 0;
        list-style: none;
    }
    .preview-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.25rem 0.75rem;
        padding-block: 0.375rem;
        list-style: none;
    }
    .preview-row + .preview-row {
        border-top: 1px solid var(--dp-base-300);
    }
    .preview-open {
        min-width: 0;
        flex: 1 1 16rem;
        cursor: pointer;
        border-radius: 0.25rem;
    }
    .preview-open:hover {
        background: color-mix(in srgb, var(--dp-base-200) 60%, transparent);
    }
    .tight {
        --gap: 0.25rem 0.5rem;
    }
    .rule-list {
        flex-shrink: 0;
        padding: 0;
        box-shadow: 0 1px 3px rgb(0 0 0 / 0.2);
    }
    .rule-row {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.75rem;
    }
    .rule-row + .rule-row {
        border-top: 1px solid var(--dp-base-300);
    }
    .filter-bar {
        position: sticky;
        top: 0;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid var(--dp-base-300);
        /* 下を流れる行が透けないように。札と同じ地の色 */
        background: var(--pico-card-background-color);
        border-radius: var(--pico-border-radius) var(--pico-border-radius) 0 0;
    }
    .filter-bar input {
        flex: 1 1 auto;
        min-width: 0;
        margin: 0;
    }
    .more {
        text-align: center;
    }
    .conditions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem 1rem;
        opacity: 0.7;
    }
    .detail-error {
        flex-basis: 100%;
    }
    .detail-state {
        margin-right: auto;
    }
</style>
