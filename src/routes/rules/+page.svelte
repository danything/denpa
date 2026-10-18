<script lang="ts">
    import { untrack } from 'svelte';
    import { submitting } from '#lib/actions.js';
    import { GENRE_TREE } from '#lib/arib.js';
    import { arming } from '#lib/arming.svelte.js';
    import ActionButton from '#lib/components/ActionButton.svelte';
    import ArmedDelete from '#lib/components/ArmedDelete.svelte';
    import Lead from '#lib/components/Lead.svelte';
    import ProgramDetail from '#lib/components/ProgramDetail.svelte';
    import Toasts, { errorNotice, type Notice } from '#lib/components/Toasts.svelte';
    import { programDetail } from '#lib/detail.svelte.js';
    import { badgeClass, CM_LABEL, COPY_NEVER_REASON, dateTime, SERVICE_TYPE_LABEL, stateLabel } from '#lib/format.js';
    import { CODEC_LABEL } from '#lib/hw.js';
    import { Paged, sentinel } from '#lib/paging.svelte.js';
    import { parseSearchFields, SEARCH_FIELD_LABEL, SEARCH_FIELDS } from '#lib/search.js';
    import { applyAction, deserialize, type SubmitFunction } from '$app/forms';
    import { afterNavigate, goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { page } from '$app/state';
    import ArrowLeft from '~icons/lucide/arrow-left';
    import type { Preview, PreviewRow } from './+page.server';

    let { data, form } = $props();

    /**
     * 下見。**書く欄を打ち直すたびに、少し待ってから数え直す** (`+page.server.ts` の `?/preview`)。
     *
     * 「何が録れるか見る」を押して GET で往復していた頃は、条件を1つ変えるたびに押して、
     * 画面ごと読み直すのを待つことになっていた。いまは書く欄の値をそのまま送り、
     * 下見のところだけ差し替える。
     *
     * **サーバに重ねて投げない。** これから先の番組を全部見るので、実データではこの画面で
     * いちばん重い。打つのが止まってから `PREVIEW_DELAY` 待って送り、返事を待つ間に変わったぶんは
     * 返ってから最後の条件で1回だけ送る。条件が前と同じなら送らない。空なら数えない
     */
    let preview = $state<Preview | null>(null);
    /** 条件が空か。null はまだ分からない (最初の描画)。分かるまでは初期値で決める */
    let blank = $state<boolean | null>(null);
    /** 数え直している途中。前の結果は薄くして残す (打つたびに消えると読めない) */
    let counting = $state(false);
    let ruleForm = $state<HTMLFormElement>();
    const PREVIEW_DELAY = 300;
    /** いま出している (または送っている) 下見の条件。同じなら送り直さない */
    let shownKey: string | null = null;
    let inflight = false;
    let queued = false;
    /** 画面の中で移るたびに増やす。移る前に送った下見の返事は捨てる (別のルールの結果を出さない) */
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function schedule(): void {
        clearTimeout(timer);
        timer = setTimeout(() => void count(), PREVIEW_DELAY);
    }

    /** 条件が空 (キーワードも局もジャンルも無い)。数えても全番組に当たるだけ */
    function empty(body: FormData): boolean {
        return (
            String(body.get('keyword') ?? '').trim() === '' &&
            ['serviceIds', 'serviceTypes', 'genres'].every((key) => body.getAll(key).length === 0)
        );
    }

    async function count(): Promise<void> {
        if (ruleForm === undefined) return;
        if (inflight) {
            queued = true;
            return;
        }
        const body = new FormData(ruleForm);
        const key = new URLSearchParams(body as unknown as Record<string, string>).toString();
        if (key === shownKey) {
            counting = false;
            return;
        }
        shownKey = key;
        if (empty(body)) {
            blank = true;
            preview = null;
            counting = false;
            return;
        }
        blank = false;
        inflight = true;
        counting = true;
        const sent = generation;
        try {
            const response = await fetch(`${resolve('rules')}?/preview`, {
                method: 'POST',
                body,
                headers: { 'x-sveltekit-action': 'true' },
            });
            const result = deserialize(await response.text());
            if (sent !== generation) {
                // 移る前の条件。次の (いまの) 条件は `queued` で送り直す
            } else if (result.type === 'success') {
                const next = (result.data as { preview: Preview | null } | undefined)?.preview ?? null;
                preview = next;
                blank = next === null;
            } else {
                throw new Error(result.type === 'failure' ? `${response.status}` : result.type);
            }
        } catch (error) {
            // 黙って空にしない。もう1度打ち直せば送り直す
            if (sent === generation) {
                preview = { total: 0, skipped: 0, programs: [], conflicts: 0, verdicts: {}, failed: String(error) };
                shownKey = null;
            }
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

    /*
     * **読み直したら数え直す。** 取消・予約・有効/無効のあとは load が走り直し、行の状態が変わる。
     * 書く欄を描き直したとき (`formKey`) も。条件が同じでも送り直す
     */
    $effect(() => {
        void data;
        void formKey;
        void ruleForm;
        shownKey = null;
        untrack(() => void count());
        return () => clearTimeout(timer);
    });

    /**
     * 下見を待っている間の枠の形。数は決め打ち (何件当たるかは届くまで分からない)。
     * 高さをばらけさせるのは、揃っていると表ではなくただの縞に見えるため
     */
    const PREVIEW_SKELETON = [2.5, 3, 2.5, 3.5, 2.5, 3, 2.5, 3.5];

    /**
     * 足した・直したあとに書く欄を描き直すための鍵。**フォームの reset では初期値に戻らない** —
     * チェックは `checked` を中身として当てているので、reset すると既定 (外れ) になり、
     * 番組名・種別・「同じ回は…」まで全部外れていた。描き直して初期値から組み直す
     */
    let formKey = $state(0);
    /**
     * 書く欄の初期値。**描き直すとき (`formKey`) にだけ読み直す。**
     *
     * 下見の行から予約・取消すると load が走り直し、`data` が新しくなる。初期値を `data.seed` から
     * `value` / `checked` でそのまま当てていると、そのたびに打ちかけの書く欄が初期値 (新しいルールなら空) に
     * 戻っていた。欄には `defaultValue` / `defaultChecked` で渡す (打った値は上書きしない)
     */
    const seed = $derived.by(() => {
        void formKey;
        return untrack(() => data.seed);
    });
    /** フォームの初期値として選んでおくチャンネルと種別 */
    const seedTypes = $derived(seed?.service_types ?? []);
    const seedServices = $derived(seed?.service_ids ?? []);
    const seedGenres = $derived(seed?.genres ?? []);
    const seedFields = $derived(parseSearchFields(seed?.search_fields));
    /*
     * **編集を押したら描き直す。** チェックは `checked` の値が変わったときしか当て直さないので、
     * 手で外したまま別のルールを開くと、同じ値 (概要にチェック) のルールでは外れたまま
     * 残っていた。画面の中で移ったら (リンク・戻る/進む・保存のあと)、その URL の値から組み直す。
     * 前の下見も捨てる (別のルールの結果を出したままにしない)。数え直しは `formKey` を見ている
     */
    let formUrl = page.url.href;
    afterNavigate(({ to }) => {
        /*
         * 同じ URL のままなら描き直さない。下見の行から予約・取消したあとの読み直しもここを通り、
         * 描き直すと打ちかけの書く欄が初期値に戻っていた。保存のあとは送信の側で描き直す
         */
        if (to === null || to.url.href === formUrl) return;
        formUrl = to.url.href;
        generation += 1;
        preview = null;
        blank = null;
        formKey += 1;
    });

    /**
     * プレビューの行から開く番組詳細 (detail.svelte.ts)。予約一覧と同じ見せ方。
     *
     * 出しているのは番組名と局と時刻だけで、**この条件で本当にこれを録りたいのか**は
     * それだけでは決められなかった。同じタイトルの再放送・傍題の違い・番組の中身は
     * 詳細にしか無く、確かめるには番組表を別に開いて探し直すことになっていた
     */
    const detail = programDetail();
    /** ルールの削除は2回押させる (録画・通知先と同じ。[arming.svelte.ts](../../lib/arming.svelte.ts)) */
    const deleting = arming('[data-testid^="rule-delete"]');
    /**
     * 一覧の行のスイッチを送るとき。**送っている間は押せなくする** (連打で何度も切り替わらない)。
     * 断られたら見た目を戻す — 一覧は読み直されないので、戻さないとスイッチだけ実際とずれる
     */
    const switched: SubmitFunction = ({ formElement }) => {
        const box = formElement.querySelector<HTMLInputElement>('input[role="switch"]');
        if (box !== null) box.disabled = true;
        return async ({ result, update }) => {
            await update();
            if (box !== null) {
                if (result.type !== 'success' && result.type !== 'redirect') box.checked = !box.checked;
                box.disabled = false;
            }
        };
    };
    /**
     * 編集中のルールを消したら、一覧の初めに戻る。`?edit=` のまま残ると、無くなったルールの
     * 画面が新しいルールの欄に化けて見える。戻る先の履歴にも残さない (戻っても無いので)。
     * 「削除しました」の通知は移ったあとに当てる
     */
    const leaveDeleted: SubmitFunction = () => async ({ result, update }) => {
        if (result.type !== 'success') return update();
        await goto(resolve('rules'), { replaceState: true });
        await applyAction(result);
    };
    /**
     * 付いていれば書く途中、という URL の鍵。編集 (`edit`)・新しいルール (`new`)・録画や番組から
     * (`recording` / `program`)・条件を URL に載せて来たとき (検索の「ルールを作る」は `keyword`。書く欄の名前ならどれでも)。
     * 計測用などの関係ない鍵では書く欄にしない
     */
    const FORM_KEYS = [
        'edit',
        'new',
        'recording',
        'program',
        'keyword',
        'ignoreKeyword',
        'searchFields',
        'serviceIds',
        'serviceTypes',
        'genres',
        'priority',
        'dedupe',
    ];
    /**
     * **狭い画面で書く欄のほうを出すか。** 上の鍵が1つでも付いていれば書く欄、無ければ一覧。
     * URL で決めるので、ブラウザの戻るで一覧に戻れる
     */
    const formView = $derived(FORM_KEYS.some((key) => page.url.searchParams.has(key)));
    /**
     * 詳細を開いている行そのもの。**`detail.current` とは別に持つ。**
     *
     * 詳細が持っているのは番組の中身 (名前・説明・ジャンル) だけで、番組ID も
     * 局も予約の状態も入っていない — 押すもの (視聴・予約) を出すのに要るのは
     * そちらなので、開いた行を覚えておく
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

    /** 局は50以上あるので種別ごとにまとめる */
    const grouped = $derived(
        ['GR', 'BS', 'CS', 'SKY']
            .map((type) => ({ type, services: data.services.filter((s) => s.type === type) }))
            .filter((g) => g.services.length > 0),
    );

    /**
     * 少しずつ出す (`paging.svelte.ts`)。
     *
     * ルールが数百に溜まると、この画面を開いた直後に一瞬止まって見える —
     * 全部の行を描き終わるまで何も動かない。最初は 1 画面ぶん少し多めだけ描き、
     * 下端に近づいたら続きを足す。
     *
     * 一覧を言葉で絞る欄は置かない。ルールを探すのはサイト全体の検索 (`/search`) の「ルール」で、
     * 行の名前は書く欄の「編集中」にも出る
     */
    const paged = new Paged(() => data.rules, 40);

    /**
     * 先頭の「新しいルール」の行を開いているか。右がいまその書く欄なら光らせる
     * (編集ではなく書く欄を出しているとき。検索の「ルールを作る」から来たときも)
     */
    const creating = $derived(data.editing === null && formView);

    /** 押した結果 */
    const notices = $derived.by<Notice[]>(() => {
        const list = errorNotice(form, 'rule-error');
        if (form?.canceled !== undefined) {
            const text = form.canceled > 0 ? `ルールを削除しました (予約 ${form.canceled} 件を取り消し)` : 'ルールを削除しました';
            list.push({ key: 'rule-deleted', kind: 'success', text });
        }
        return list;
    });
</script>


<svelte:window onclick={deleting.stand} />

<!--
    **左に一覧、真ん中に書く欄、右にその条件で録れる番組** (一覧と詳細の形)。左でルールを押せば、
    真ん中でそのまま直せて、右の下見は打つそばから変わる。

    一覧を表とカードで右に積んでいた頃は、直すたびに「編集」を探して押し、書く欄まで
    目を戻すことになっていた。いまは行そのものが `?edit=<id>` へのリンクなので、
    押すのは1回で、戻る/進むもリンクの共有もそのまま効く。

    **横に並べはじめる幅は全画面で 768px**
    ([+layout.svelte](../+layout.svelte) の `FILLED`)。768px からは一覧と書く欄の2列で、下見は書く欄の下。
    **1280px からは下見を右の列に出す** (書く欄の下に置くと、広い画面でも右が空いたまま、下見は画面の外だった)。
    並べたらページごとは動かさず、**列がそれぞれ自分で巻き取る**。列は画面の端とヘッダーの下まで寄せ、
    境目は 1px の線だけ。

    **狭い画面では一覧と書く欄を切り替える** (`formView`)。どちらを出すかは URL で決めるので、
    ブラウザの戻るで一覧に戻れる
-->
<div class="page" class:form-view={formView}>
    <Toasts {notices} source={form} />

    <aside class="side" aria-label="ルールの一覧">
        <!--
            **行は名前と小さな印だけ。** 条件 (局・ジャンル・除外) は押せば右に全部出るので、ここでは
            どれがどれか見分けられれば足りる。並べて比べたいもの (有効か・優先度・予約の数・同じ回は1度) だけ残す
        -->
        <ul class="rule-list" id="rule-list" data-testid="rule-list">
            <!--
                **先頭はいつも新しいルールの行。** 言葉から作るときは、サイト全体の検索の
                「ルールを作る」から来る (`/rules?new&keyword=`。書く欄に語が入る)
            -->
            <li class="rule-item create" class:selected={creating}>
                <a class="rule-row" href={resolve('rules?new')} data-testid="rule-new">＋ 新しいルール</a>
            </li>
            {#each paged.rows as rule (rule.id)}
                {@const selected = data.editing?.id === rule.id}
                <!--
                    **有効/無効は行のスイッチで、開かずに切り替える。** 一覧と詳細の形では、行を押して開いてから
                    押すことになり1手増えていた。スイッチは行のリンクの外 (隣) に置くので、押してもルールは開かない
                -->
                <li class="rule-item" class:selected class:off={!rule.enabled}>
                    <a
                        class="rule-row"
                        href={resolve(`rules?edit=${rule.id}`)}
                        aria-current={selected ? 'true' : undefined}
                        data-testid="rule-row"
                    >
                        <span class="rule-name">{rule.name}</span>
                        <span class="rule-marks tiny">
                            {#if !rule.enabled}<span class="tag">無効</span>{/if}
                            <span>優先度 {rule.priority}</span>
                            <span>予約 {rule.reservations} 件</span>
                            {#if rule.dedupe}
                                <span title="同じ回は最初の放送だけ録る">同じ回は1度</span>
                            {/if}
                        </span>
                    </a>
                    <form method="POST" action="?/toggle" class="row-switch" use:submitting={switched}>
                        <input type="hidden" name="id" value={rule.id} />
                        <input
                            type="checkbox"
                            role="switch"
                            aria-checked={rule.enabled}
                            checked={rule.enabled}
                            aria-label="「{rule.name}」を有効にする"
                            onchange={(event) => event.currentTarget.form?.requestSubmit()}
                            data-testid="rule-switch"
                        />
                    </form>
                </li>
            {:else}
                <!-- 1件も無いとき。まだ何も無いのか読み込み途中なのかが分かるように、次にすることも添える -->
                <li class="empty" data-testid="rule-empty">
                    <p class="bold">ルールはまだありません</p>
                    <p class="small muted">
                        「＋ 新しいルール」から、合う番組を自動で予約するルールを作れます
                    </p>
                </li>
            {/each}
            <!-- 下端に近づいたら続きを足す。まだ出していない件数を添えて、終わりではないと分かるように -->
            {#if paged.more}
                <li class="note small muted" use:sentinel={() => paged.reveal()}>残り {paged.rest} 件</li>
            {/if}
        </ul>
    </aside>

    <!--
        **書く欄と、その条件で録れる番組。** 1280px からは2つの列に分けてそれぞれ巻き取る。
        それより狭いと下見は書く欄の下に続く (`.work` ごと巻き取る)。

        有効/無効と削除は**書く欄の外**、下の行に出す。中に入れると form が入れ子になって、
        押したつもりのないルールの更新まで送ってしまう (下見の行の「取消」も同じ理由で外にある)
    -->
    <div class="work">
        <section class="main" aria-label={data.editing ? 'ルールの編集' : '新しいルール'}>
            <div class="main-inner">
                <!-- 狭い画面だけ。一覧へ戻る (ブラウザの戻ると同じ行き先) -->
                <a class="button ghost icon small back" href={resolve('rules')} title="ルール一覧へ戻る" data-testid="rule-back"
                    ><ArrowLeft aria-hidden="true" /><span class="visually-hidden">ルール一覧へ戻る</span></a
                >
                <!--
                    **新規か編集かだけを小さく。** 上のタブがもう「ルール」と言っているので、見出しは置かない。
                    編集なら**どのルールか**
                -->
                {#if data.editing}
                    <p class="mode" data-testid="rule-mode">
                        <span class="muted">編集中:</span> <span class="bold">{data.editing.name}</span>
                    </p>
                {:else}
                    <p class="mode muted" data-testid="rule-mode">新しいルール</p>
                {/if}
                <!--
                    足した・直したあと、書く欄を初期値で描き直す (`formKey`)。
                    打つたび・チェックを変えるたびに下見を数え直す (`schedule`)
                -->
                {#key formKey}
                    <form
                        method="POST"
                        class="rule-form dense"
                        id="rule-form"
                        data-testid="rule-form"
                        bind:this={ruleForm}
                        oninput={schedule}
                        onchange={schedule}
                        use:submitting={() =>
                            async ({ result, update }) => {
                                await update({ reset: false });
                                if (result.type === 'redirect') formKey += 1;
                            }}
                    >
                        <div class="form-body">
                            {#if data.origin !== null}
                                {@const what = data.origin.kind === 'recording' ? '録画' : '番組'}
                                <!--
                                    **録画・番組から来たとき。** 何を元に入れたのかと、次に何を押せばよいかを1行で。
                                    このシリーズを既に録っているルールがあれば、作らずにそちらを案内する
                                -->
                                {#if !data.origin.found}
                                    <p class="notice warning small" data-testid="rule-origin">{what}が見つかりませんでした</p>
                                {:else if data.origin.rule !== null}
                                    <p class="notice info small" data-testid="rule-origin">
                                        この番組はルール「<a href={resolve(`rules?edit=${data.origin.rule.id}`)} data-testid="rule-origin-link">{data.origin.rule.name}</a>」で録っています{data.origin.rule.enabled ? '' : ' (いまは無効)'}
                                    </p>
                                {:else if data.origin.prefilled}
                                    <p class="notice info small" data-testid="rule-origin">
                                        {what}「<span class="broadcast">{data.origin.name}</span>」から条件を入れました。下の一覧で確かめて「追加」を押してください
                                    </p>
                                {:else}
                                    <p class="notice warning small" data-testid="rule-origin">
                                        「<span class="broadcast">{data.origin.name}</span>」から番組名を読み取れませんでした。キーワードを入れてください
                                    </p>
                                {/if}
                            {/if}
                            {#if data.origin !== null && data.editing === null}
                                <!-- 足したあとも、元の録画・番組を案内し直す (`create`) -->
                                <input type="hidden" name="origin" value="{data.origin.kind}:{data.origin.id}" />
                            {/if}
                            {#if data.editing}
                                <input type="hidden" name="id" value={data.editing.id} />
                                <!-- 下見 (`?/preview`) に、条件から外れたこのルールの予約も混ぜてもらうため -->
                                <input type="hidden" name="edit" value={data.editing.id} />
                            {/if}
                            <!-- 横に並べない。左の列は 26rem までなので、並べると入力欄が潰れる -->
                            <div class="fields">
                                <!--
                                    外側は label にしない。Pico はチェックボックスを含む label を中身の幅
                                    (fit-content) に縮めるので、当てる範囲のチェックまで包むと入力欄だけ短くなっていた
                                -->
                                <div class="field">
                                    <label class="field">
                                        <span class="field-label">キーワード</span>
                                        <input
                                            name="keyword"
                                            placeholder="例: 名探偵"
                                            defaultValue={seed?.keyword ?? ''}
                                            data-testid="rule-keyword"
                                        />
                                    </label>
                                    <Lead>
                                        空白で区切ると<strong>すべて含む</strong>ものに一致します
                                        {#snippet more()}
                                            <p>これから放送される番組が対象です。ルール名はキーワードから付けます。</p>
                                        {/snippet}
                                    </Lead>
                                    <!--
                            当てる範囲。既定は番組名だけ。概要まで広げると番宣で名前が出ただけの
                            番組まで当たり、詳細まで広げると出演者でも当たる
                        -->
                                    <div class="wrap-row" data-testid="rule-search-fields">
                                        {#each SEARCH_FIELDS as field (field)}
                                            <label class="check">
                                                <input
                                                    type="checkbox"
                                                    name="searchFields"
                                                    value={field}
                                                    defaultChecked={seedFields.includes(field)}
                                                />
                                                <span class="tiny">{SEARCH_FIELD_LABEL[field]}</span>
                                            </label>
                                        {/each}
                                    </div>
                                </div>
                                <label class="field">
                                    <span class="field-label">除外キーワード</span>
                                    <input
                                        name="ignoreKeyword"
                                        placeholder="例: 再放送 総集編"
                                        defaultValue={seed?.ignore_keyword ?? ''}
                                        data-testid="rule-ignore"
                                    />
                                    <span class="hint">
                                        空白で区切ると<strong>どれか1つでも含む</strong>ものを除外します
                                    </span>
                                </label>
                                <div class="field">
                                    <!-- 外したチェックは何も送らない。「外した」と「指定なし」を分けるための隠し (`dedupeOf`) -->
                                    <input type="hidden" name="dedupe" value="0" />
                                    <label class="check">
                                        <input
                                            type="checkbox"
                                            name="dedupe"
                                            value="1"
                                            defaultChecked={seed?.dedupe ?? true}
                                            data-testid="rule-dedupe"
                                        />
                                        <span class="field-label">同じ回は最初の放送だけ録る</span>
                                    </label>
                                    <Lead class="indent">
                                        再放送や別の局の同じ回は録りません
                                        {#snippet more()}
                                            <p>
                                                同じ回かどうかは番組名のシリーズ名と話数・副題で見ます。番組名に話数や副題が無ければ番組の説明から読みます。同じ時刻に流れているなら字幕のあるもの、次に BS/CS を選びます。選んだ放送がチューナー不足で録れないときは、次の放送で録ります。話数も副題も無い番組は、同じ時刻の同時放送だけをまとめます。
                                            </p>
                                        {/snippet}
                                    </Lead>
                                </div>
                                <div class="field">
                                    <label class="field">
                                        <span class="field-label">優先度</span>
                                        <input
                                            type="number"
                                            name="priority"
                                            defaultValue={seed?.priority ?? 1}
                                            min="0"
                                            max="9"
                                            data-testid="rule-priority"
                                        />
                                    </label>
                                    <Lead>
                                        チューナーが足りないときは<strong>大きいほうを録ります</strong>
                                        {#snippet more()}
                                            <p>
                                                <strong>予約どうし</strong>の優先度です (手動予約は 2)。番組表やロゴの取得とは比べません。録画はそれらより常に優先されます。
                                            </p>
                                        {/snippet}
                                    </Lead>
                                </div>
                            </div>

                            <!--
                                **局とジャンルは枠で囲まない行に** (名前は左、いまの値と › は右)。押すと行の下に開く
                            -->
                            <div class="pickers">
                                <details class="picker">
                                    <summary data-testid="channel-summary">
                                        <span>局</span>
                                        <span class="picker-value">
                                            {seedTypes.length + seedServices.length === 0
                                                ? '全局'
                                                : `${seedTypes.length + seedServices.length} 件選択中`}
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
                                                            defaultChecked={seedTypes.includes(group.type)}
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
                                            <div class="pick-list" data-testid="rule-services">
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
                                                                        defaultChecked={seedServices.includes(
                                                                            service.id,
                                                                        )}
                                                                    />
                                                                    <span class="truncate small broadcast">{service.name}</span>
                                                                </label>
                                                            {/each}
                                                        </div>
                                                    </div>
                                                {:else}
                                                    <p class="small muted">
                                                        局がまだありません。<a href={`${resolve('settings/reception')}#channels`}>チャンネルスキャン</a>をしてください。
                                                    </p>
                                                {/each}
                                            </div>
                                        </div>
                                    </div>
                                </details>

                                <details class="picker">
                                    <summary data-testid="genre-summary">
                                        <span>ジャンル</span>
                                        <span class="picker-value">
                                            {seedGenres.length === 0 ? '全ジャンル' : `${seedGenres.length} 件選択中`}
                                        </span>
                                    </summary>
                                    <div class="box-body">
                                        <!-- 大分類だけ選べば中分類は問わない。細かく絞りたいときだけ
                                 中分類にチェックを入れる -->
                                        <div class="pick-list" data-testid="rule-genres">
                                            {#each GENRE_TREE as group (group.value)}
                                                <div>
                                                    <label class="check">
                                                        <input
                                                            type="checkbox"
                                                            name="genres"
                                                            value={group.value}
                                                            defaultChecked={seedGenres.includes(group.value)}
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
                                                                        defaultChecked={seedGenres.includes(child.value)}
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
                                録画のしかたと無料放送の扱いは<a href={resolve('settings/recording')}>設定</a
                                >で決めます ({data.defaults.codecs.map((codec) => CODEC_LABEL[codec]).join(' + ') || 'エンコードしない'}
                                / CM: {CM_LABEL[data.defaults.cmCut]}{data.defaults.freeOnly
                                    ? ' / 無料放送のみ'
                                    : ''})
                            </p>
                        </div>

                    </form>
                {/key}

                <!--
                    **押すものは下の1行に、ふつうのフォームと同じ並びで。** 右端に保存 (追加・更新)、左に
                    そのルールそのものにすること (有効/無効・削除)。条件がどれだけ長くても下に貼り付いて見えている。

                    書く欄 (`<form>`) の**外**に置き、保存のボタンは `form` 属性で書く欄に繋ぐ。中に入れると
                    有効/無効と削除の form が入れ子になって、押したつもりのないルールの更新まで送ってしまう
                -->
                <div class="form-actions">
                    {#if data.editing}
                        <div class="cluster">
                            <!--
                                有効/無効は狭い画面だけ。広い画面では左の一覧の行のスイッチが同時に見えている
                                (狭い画面の書く欄では一覧を隠すので、ここに無いと切り替えられない)
                            -->
                            <div class="narrow-only">
                                <ActionButton
                                    action="?/toggle"
                                    fields={{ id: data.editing.id }}
                                    class="small secondary"
                                    testid="rule-toggle"
                                >
                                    {data.editing.enabled ? '無効化' : '有効化'}
                                </ActionButton>
                            </div>
                            <!-- 押し間違い防止に2回押させる (録画の削除と同じ)。消したら一覧の初めに戻る -->
                            <ArmedDelete
                                {deleting}
                                armKey={data.editing.id}
                                fields={{ id: data.editing.id }}
                                submit={leaveDeleted}
                                class="small"
                                testid="rule-delete"
                            />
                        </div>
                    {/if}
                    <!-- 下見は打つそばから右 (狭い画面では下) に出るので、「見る」ためのボタンは置かない -->
                    <div class="cluster save">
                        {#if data.editing}
                            <!-- 広い画面だけ。狭い画面では上の「← ルール一覧」が同じ行き先 -->
                            <a class="button small secondary wide-only" href={resolve('rules')} data-testid="rule-cancel-edit">編集をやめる</a>
                            <button type="submit" form="rule-form" class="small" formaction="?/update" data-testid="rule-update">
                                更新
                            </button>
                        {:else}
                            <button type="submit" form="rule-form" class="small" formaction="?/create" data-testid="rule-submit">
                                追加
                            </button>
                        {/if}
                    </div>
                </div>

                <!--
                    **「今すぐ全ルールを適用」は置かない。**

                    ルールを当て直すのは番組表が動いたとき (`epg.settle`) と、ルールを
                    足した/変えた/消したとき。押す理由のある場面が残っていない。
                    番組表そのものを取得したいなら、設定の「チャンネル」の
                    「番組表をいますぐ集める」がその入口で、集め終わりに当て直しまで通る
                -->
            </div>
        </section>

        <!-- 数え直している間は前の結果を薄くして残す (`counting`)。読み上げにも数えている途中だと伝える -->
        <section class="preview-pane" aria-label="この条件で録れる番組" aria-busy={counting}>
            {#if blank ?? seed === null}
                <!-- 条件が空。全番組に当たるだけなので数えない。何を入れればよいかを出す -->
                <div class="preview" data-testid="preview-blank">
                    <h2 class="preview-title">この条件で録れる番組</h2>
                    <p class="small muted">キーワード・局・ジャンルのどれかを入れると、ここに出ます</p>
                </div>
            {:else if preview === null}
                <!--
                    下見が届くまで。**枠だけ先に置く** — 条件を打ち直すたびに
                    右の列ごと消えると、どこを見ていたか分からなくなる
                -->
                <div class="preview" role="status" aria-label="下見を数えています">
                    <div class="skeleton-title" aria-hidden="true"></div>
                    <ul class="preview-list" aria-hidden="true">
                        {#each PREVIEW_SKELETON as height, row (row)}
                            <li class="skeleton-row" style="height: {height}rem"></li>
                        {/each}
                    </ul>
                </div>
            {:else if preview.failed !== null}
                <!-- 数えられなかった。黙って空にしない (本当の理由はサーバのログ) -->
                <div class="preview">
                    <p class="muted">下見を数えられませんでした ({preview.failed})</p>
                </div>
            {:else}
                <!--
        **予約とプレビューは同じ一覧**。別々に並べていた頃は、同じ番組が2箇所に出るうえ、
        「押さえている予約」と「これから当たる番組」を頭の中で突き合わせることになっていた
    -->
                <div class="preview" class:counting data-testid="preview">
                    <!--
                        **見出しの行に全部寄せる。** 「予約済みの番組はここで取り消せます」の1行と「詳しく」の1行を
                        別に積んでいた頃は、番組が1件も見えないうちに4行ぶん下がっていた。取り消せることは行の
                        「取消」が言っているので、残すのは「詳しく」の中身だけ
                    -->
                    <div class="preview-head">
                        <h2 class="preview-title">
                            この条件で録れる番組は <span class="num">{preview.total}</span> 件
                            {#if preview.total > preview.programs.length}
                                <span class="small muted normal">
                                    (先頭 {preview.programs.length} 件)
                                </span>
                            {/if}
                            <!-- 重なりを見るのは出している分だけ (`readPreview`)。全部は見ていないと分かる書き方にする -->
                            {#if preview.skipped > 0}
                                <!-- 録らないものも行に出す。数は全体の数 (下見の 100 件の中ではない) -->
                                <span class="small muted normal" data-testid="preview-skipped">
                                    (うち同じ回の {preview.skipped} 件は録りません)
                                </span>
                            {/if}
                            {#if preview.conflicts > 0}
                                <span class="tag error outline">
                                    {preview.total > preview.programs.length ? '表示分のうち' : ''}競合 {preview.conflicts} 件
                                </span>
                            {/if}
                        </h2>
                        {#if preview.total > 0}
                            <details class="more preview-more">
                                <summary>詳しく</summary>
                                <p>取り消した番組をルールが予約し直すことはありません。</p>
                                <p>
                                    条件から外れた予約は取り消されます。手動の予約と、まもなく始まる予約は残り、
                                    <span class="tag">条件外</span> として表示します。
                                </p>
                            </details>
                        {/if}
                    </div>
                    {#if preview.total === 0}
                        <p class="small muted">
                            いまの番組表では1件も一致しません。条件を緩めてください。
                        </p>
                    {:else}
                        <ul class="preview-list">
                            {#each preview.programs as program (program.id)}
                                <li class="preview-row small" class:skipped={program.skip !== null} data-testid="preview-row" data-program-id={program.id}>
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
                                            {#if program.skip !== null}
                                                <span class="tag" data-testid="preview-skip">録らない</span>
                                            {/if}
                                            <span class="truncate broadcast">{program.name}</span>
                                        </div>
                                        <div class="tiny muted">
                                            <span class="broadcast">{program.service_name}</span> ・ {dateTime(program.start_at)}
                                        </div>
                                        <!--
                                    チューナーの取り合いは**録ろうとした時点で初めて分かる**
                                    ので、ここで先に見せる。出すのはチューナーの台数が足りなくなるものだけ
                                    (`contentions`)。ただ時間が重なっているだけのものを
                                    出していた頃は、地上波チューナーが2台あって録れる組にも、
                                    そもそも別のチューナーを使う衛星の番組にも印が付いていた。

                                    **足りなくなるものは全部出す。** 1件だけ出していた頃は、
                                    3本ぶつかっていても1本しか見えず、どれを諦めれば
                                    いいのかが読めなかった
                                -->
                                        {#if program.skip !== null}
                                            <!-- なぜ録らないのか。どの放送で録るのかまで書けば、確かめに行ける -->
                                            <div class="tiny muted" data-testid="preview-skip-reason">
                                                {#if program.skip.kind === 'copy-never'}
                                                    {COPY_NEVER_REASON}
                                                {:else if program.skip.kind === 'repeat'}
                                                    同じ回を <span class="broadcast">{program.skip.service_name}</span>
                                                    ({dateTime(program.skip.start_at)}) で録ります
                                                {:else}
                                                    同じ回は録画済みです (<span class="broadcast"
                                                        >{program.skip.service_name}</span
                                                    > ・ {dateTime(program.skip.start_at)})
                                                {/if}
                                            </div>
                                        {/if}
                                        {#if program.conflict_reason}
                                            <div class="text-error tiny">
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
                                            <div class="text-error tiny">
                                                チューナーの競合 {program.conflicts.length} 件: {program.conflicts
                                                    .slice(0, 3)
                                                    .join('、')}{program.conflicts.length > 3
                                                    ? ` ほか ${program.conflicts.length - 3} 件`
                                                    : ''}
                                            </div>
                                        {/if}
                                    </div>
                                    {#if program.reservation_id !== null}
                                        <div class="row-actions">
                                            <ActionButton
                                                action="?/cancelReservation"
                                                fields={{ reservationId: program.reservation_id }}
                                                class="small outline danger"
                                                testid="rule-pending-cancel"
                                            >
                                                取消
                                            </ActionButton>
                                        </div>
                                    {/if}
                                </li>
                            {/each}
                        </ul>
                    {/if}
                </div>
            {/if}
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
    予約済みの行は状態のバッジが出るので、押すものが増えたり減ったりしない。

    **押し方は番組表の詳細と同じ** (`guide/+page.svelte`)。同じモーダルが画面に
    よって違う出方をすると、番組表で覚えた押し方が通じない。

    **二段組の外に置く。** 中に入れると、巻き取る箱の中で開くことになる
-->
{#if detail.current}
    <ProgramDetail program={detail.current} onclose={close}>
        {#snippet status()}
            {#if opened?.reservation_state}
                <span class="tag info" data-testid="rule-detail-state">
                    {stateLabel(opened.reservation_state)}
                </span>
            {/if}
        {/snippet}
        {#snippet actions()}
            <!--
                失敗の理由は詳細の中に出す。押したのはこのモーダルの中のボタンで、
                モーダルは右下に浮かせる通知 (Toasts) より上に出るので、
                下に隠れるものを出しても読めない (番組表の詳細と同じ扱い)
            -->
            {#if form?.message}
                <div class="notice error detail-error">{form.message}</div>
            {/if}

            {#if opened !== null && opened.start_at <= clock && opened.end_at > clock && watchable.has(opened.service_id)}
                <!--
                    **いま流れている番組は、その場で観られるようにする。**
                    押した先は別の画面で、そこで選局からやり直すことになるので
                    リンクにする (モーダルの中で始めるものではない)
                -->
                <a class="button outline" href={resolve(`live?service=${opened.service_id}`)}>
                    視聴
                </a>
            {/if}

            <!-- 取り消しは行の「取消」だけ (詳細に同じものを2つ並べない) -->
            {#if opened !== null && opened.reservation_id === null && opened.reservation_state === null && opened.end_at > clock && opened.skip?.kind !== 'copy-never'}
                <!--
                    録画のしかたはここでは選ばせない。設定画面の1箇所で決める
                    (同じ選択肢を予約・ルール・設定に並べると、どれで決まったのか
                    分からなくなる)。コピー禁止の番組には出さない (押しても断るだけ。番組表と同じ)
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
                    <button type="submit" data-testid="rule-detail-reserve">予約</button>
                </form>
            {/if}
        {/snippet}
    </ProgramDetail>
{/if}

<style>
    /*
     * **広い画面では main の余白の外まで広げる。** 左の列は画面の左端とヘッダーの下に付け、
     * 高さは画面の残りいっぱい (`+layout.svelte` の `.shell.fill`)
     */
    @media (min-width: 768px) {
        .page {
            display: grid;
            grid-template-columns: 18rem minmax(0, 1fr);
            height: calc(100% + 2 * var(--dp-gutter));
            margin: calc(-1 * var(--dp-gutter));
        }
    }
    @media (min-width: 1280px) {
        .page {
            grid-template-columns: 20rem minmax(0, 1fr);
        }
    }

    /*
     * **書く欄と下見。** 768px からは2つまとめて巻き取る (下見は書く欄の下)。
     * 1280px からは2つの列に分け、それぞれが巻き取る。書く欄は 44rem で止め、残りは全部下見に回す
     * (広い画面で書く欄だけ伸ばしても、入力欄が間延びするだけ)
     */
    .work {
        min-width: 0;
    }
    @media (min-width: 768px) {
        .work {
            min-height: 0;
            overflow-y: auto;
        }
    }
    @media (min-width: 1280px) {
        .work {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            overflow: hidden;
        }
        .main,
        .preview-pane {
            min-height: 0;
            overflow-y: auto;
        }
        .preview-pane {
            border-left: 1px solid var(--dp-line);
        }
    }
    @media (min-width: 1600px) {
        .work {
            grid-template-columns: minmax(0, 44rem) minmax(0, 1fr);
        }
    }

    /* ---- 左の一覧 ---- */
    .side {
        display: flex;
        min-height: 0;
        flex-direction: column;
    }
    @media (min-width: 768px) {
        .side {
            border-right: 1px solid var(--dp-line);
        }
    }
    .rule-list {
        min-height: 0;
        margin: 0;
        padding: 0.25rem 0.375rem;
        list-style: none;
    }
    .rule-list > li {
        margin: 0;
        list-style: none;
    }
    /* 狭い画面では行の字を本文と揃える (塗りだけ余白の外へ少し出す) */
    @media (max-width: 767px) {
        .rule-list {
            margin-inline: -0.75rem;
            padding: 0;
        }
    }
    @media (min-width: 768px) {
        .rule-list {
            flex: 1 1 0%;
            padding-top: 0.75rem;
            overflow-y: auto;
        }
    }
    /*
     * **行は線で区切らない** (ドキュメントの目次と同じ作り)。左右を少し空け、選んでいる行だけ
     * 角の丸い薄い塗りで示す。触れている行はそれより薄く。印は小さく沈めた字で
     */
    .rule-item {
        display: flex;
        align-items: center;
        margin-bottom: 1px;
        border-radius: var(--dp-radius);
        transition: background-color var(--dp-duration);
    }
    .rule-item:hover {
        background: var(--dp-hover-soft);
    }
    .rule-item.selected {
        background: var(--dp-subtle);
    }
    /* スイッチはリンクの外 (行の右端) なので、押してもルールは開かない */
    .rule-row {
        display: flex;
        min-width: 0;
        flex: 1 1 0%;
        flex-direction: column;
        gap: 0.125rem;
        padding: 0.5rem 0.75rem;
        color: inherit;
        text-decoration: none;
    }
    /* 新しいルールの行は字だけ。印の行が無いぶん、ほかの行より低い */
    .create .rule-row {
        font-size: 0.875rem;
    }
    .rule-name {
        overflow-wrap: anywhere;
    }
    /* 無効のルールは名前を沈める (印の「無効」と合わせて、色だけに頼らない) */
    .rule-item.off .rule-name {
        color: var(--dp-muted);
    }
    .rule-marks {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.125rem 0.5rem;
        color: var(--dp-muted);
    }
    .row-switch {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        margin: 0;
        padding: 0.5rem 0.75rem 0.5rem 0.25rem;
    }
    .row-switch input {
        margin: 0;
    }
    .note {
        padding: 0.75rem;
        text-align: center;
    }
    .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
        padding: 2rem 1rem;
        text-align: center;
    }
    .empty p {
        margin: 0;
    }

    /* ---- 右の書く欄と下見 ---- */
    .main {
        min-width: 0;
    }
    .main-inner {
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }
    @media (min-width: 768px) {
        .main-inner {
            padding: var(--dp-gutter);
            padding-bottom: 0;
        }
    }
    /* 狭い画面は一覧か書く欄のどちらか。どちらを出すかは URL (`formView`) */
    @media (max-width: 767px) {
        .page:not(.form-view) .work,
        .page.form-view .side {
            display: none;
        }
    }
    /* 字だけのアイコンのボタン。字の頭に揃うよう、ボタンの余白ぶん左へ出す */
    .back {
        align-self: flex-start;
        margin-inline-start: calc(-0.25 * var(--dp-btn-h-sm));
    }
    .back :global(svg) {
        width: 1.125rem;
        height: 1.125rem;
    }
    @media (min-width: 768px) {
        .back,
        .narrow-only {
            display: none;
        }
    }
    @media (max-width: 767px) {
        .wide-only {
            display: none;
        }
    }
    /* 編集中のルール名。空白の無い長い名前でも欄からはみ出さない */
    .mode {
        min-width: 0;
        margin: 0;
        overflow-wrap: anywhere;
    }
    .rule-form {
        display: flex;
        flex-direction: column;
    }
    .form-body {
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }
    /* 下見を待っている間の枠。本物と同じ場所・同じ大きさ */
    .skeleton-title {
        height: 1.25rem;
        width: 60%;
        margin-bottom: 0.25rem;
        border-radius: var(--dp-radius-sm);
        background: var(--dp-line);
    }
    .skeleton-row {
        margin-bottom: 0.5rem;
        border-radius: var(--dp-radius-sm);
        background: var(--dp-subtle);
    }

    .hint {
        font-size: var(--dp-text-sm);
        color: var(--dp-muted);
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
    /*
     * 局とジャンルの行。枠の箱にはせず、行の間に線を1本 (設定の一覧と同じ顔)。
     * 名前は左、いまの値と Pico の › は右。指を乗せると淡い地
     */
    .pickers {
        display: flex;
        flex-direction: column;
        border-block: 1px solid var(--dp-line);
    }
    .picker {
        margin: 0;
    }
    .picker + .picker {
        border-top: 1px solid var(--dp-line);
    }
    .picker > summary {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        min-height: 2.75rem;
        margin: 0;
        padding: 0 0.5rem;
        border-radius: var(--dp-radius-sm);
        color: inherit;
        font-size: var(--dp-text-sm);
        line-height: 1.4;
        cursor: pointer;
        transition: background-color var(--dp-duration);
    }
    .picker > summary:hover {
        background: var(--dp-hover-soft);
    }
    .picker > summary::after {
        flex-shrink: 0;
        float: none;
        margin-inline-start: 0;
    }
    .picker-value {
        margin-inline-start: auto;
        color: var(--dp-muted);
    }
    .picker[open] > summary {
        margin-bottom: 0;
    }
    .box-body {
        padding: 0.25rem 0.5rem 1rem;
    }
    .group-title {
        margin-bottom: 0.25rem;
        font-size: 0.75rem;
        color: var(--dp-muted);
    }
    /*
     * 局とジャンルの並び。**中で別にスクロールさせない** — 書く欄の列がもうスクロールするので、
     * 入れ子にするとどちらが動くのか分かりにくい。CS の 50 局余りでも、そのぶん列が伸びるだけ
     */
    .pick-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
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
    /*
     * 押すものは下に貼り付ける。条件が長いときに「追加」まで探して降りずに済む。
     * 狭い画面では下のタブの上に (`--dp-tabbar`。タブが無い幅では 0)
     */
    .form-actions {
        position: sticky;
        bottom: var(--dp-tabbar, 0px);
        z-index: 1;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem 1rem;
        padding-block: 0.75rem;
        border-top: 1px solid var(--dp-line);
        background: var(--dp-bg);
    }
    /*
     * **下に潜る欄は、線の上で地の色に溶かす。** 貼り付いた行で欄が半分の高さで切れて見え、
     * そこで終わっているのか下に続くのかが読めなかった
     */
    .form-actions::before {
        content: '';
        position: absolute;
        inset-inline: 0;
        bottom: 100%;
        height: 1.5rem;
        background: linear-gradient(to bottom, transparent, var(--dp-bg));
        pointer-events: none;
    }
    /* 保存は右端。編集でないときも右に寄せる (左に何も無くても位置が変わらない) */
    .save {
        margin-left: auto;
    }
    /* 下見。カードにはせず、列の境目の線だけで分ける。1280px より狭いと書く欄の下に続く */
    .preview-pane {
        min-width: 0;
        padding-block: 1rem var(--dp-gutter);
    }
    @media (min-width: 768px) {
        .preview-pane {
            padding: var(--dp-gutter);
        }
    }
    .preview {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        transition: opacity var(--dp-duration) var(--dp-ease);
    }
    /* 数え直している途中。前の結果は消さずに薄くする */
    .preview.counting {
        opacity: 0.55;
    }
    /* 見出しと「詳しく」を1行に。開いたら中身は見出しの下に全幅で */
    .preview-head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.25rem 0.75rem;
    }
    .preview-more[open] {
        flex-basis: 100%;
    }
    .preview-title {
        margin: 0;
        font-size: 1rem;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.25rem 0.5rem;
    }
    .normal {
        font-weight: var(--dp-weight);
    }
    .preview-list {
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .preview-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding-block: 0.125rem;
    }
    .preview-row + .preview-row {
        border-top: 1px solid var(--dp-line);
    }
    .preview-open {
        min-width: 0;
        flex: 1 1 0%;
        /* Pico は role="button" にボタンの余白を付ける。行の字が見出しより右へずれないよう、薄く当て直す */
        padding: 0.25rem 0.5rem;
        margin-inline-start: -0.5rem;
        cursor: pointer;
        border-radius: var(--dp-radius-sm);
    }
    .preview-open:hover {
        background: var(--dp-hover);
    }
    /* 録らない行 (同じ回の2回目以降)。消さずに出すが、録るものより沈める */
    .preview-row.skipped .preview-open {
        opacity: 0.6;
    }
    .tight {
        --gap: 0.25rem 0.5rem;
    }
    .detail-error {
        flex-basis: 100%;
    }
</style>
