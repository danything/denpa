<script lang="ts">
    import type { SubmitFunction } from '@sveltejs/kit';
    import { untrack } from 'svelte';
    import { submitting } from '$lib/actions';
    import Toasts, { errorNotice, type Notice } from '$lib/components/Toasts.svelte';
    import { dateTime } from '$lib/format';
    import { liveUpdates } from '$lib/live-updates.svelte';
    import { measure } from '$lib/measure.svelte';
    import { EVENT_LABEL } from '$lib/webhook-events';

    let { data, form } = $props();

    liveUpdates(['migrate']);

    /** GPU で焼く印を並べる順と、その呼び名。道 (QSV が先 = 先に試す) × コーデック */
    const HW_KINDS = [
        ['qsv', 'Intel QSV'],
        ['vaapi', 'VA-API'],
    ] as const;
    const HW_CODECS = [
        ['av1', 'AV1'],
        ['h264', 'H.264'],
    ] as const;
    /** その口・道・コーデックが設定で許されているか。載っていない口は全部よい (hwenc.hwAllowed と同じ) */
    function allowed(device: string, kind: 'qsv' | 'vaapi', codec: 'av1' | 'h264'): boolean {
        const entry = data.recording.hwAllow[device];
        return entry === undefined || entry[kind].includes(codec);
    }

    const migrate = $derived(data.migrate.status);
    const done = $derived(migrate.imported + migrate.skipped + migrate.missing);

    /** 押した結果。引き継ぎの進み具合そのものは、そのカードの中に出したままにする */
    const notices = $derived.by(() => {
        const list: Notice[] = [];
        if (form?.migrate) list.push({ key: 'migrate-started', kind: 'info', text: form.migrate });
        list.push(...errorNotice(form, 'settings-error'));
        if (form?.saved) list.push({ key: 'saved-result', kind: 'success', text: '保存しました' });
        return list;
    });

    // 引き継ぎは数百GBのコピーになる。進み具合はサーバから push される

    /**
     * 画面で触る値は、サーバから来たものを写して持つ。
     *
     * `value={data...}` を直に入れていた頃は、**別のフォームを保存しただけで
     * 手元の入力が data の値に書き戻されて**いた (チェックが勝手に外れる)。
     * 写しておけば、書き戻るのは data そのものが変わったときだけになる
     */
    // untrack は「初期値としてだけ読む」印。下の $effect で追従させている
    let recording = $state(untrack(() => ({ ...data.recording })));

    /**
     * 「今の値を編集する」フォームは、保存してもフォームを reset させない。
     *
     * enhance の既定は成功後に `form.reset()` — 入力欄がデフォルト (空) に戻る。
     * バインドした状態は reset を聞かないので、**何も変えずに保存すると入力欄
     * だけが空に見える** (サーバの一覧が変わったときしか写し直さないため、
     * 書き戻しも走らない)。空にしたいのは追加系 (Webhook) だけ
     */
    const keepValues: SubmitFunction = () => async (options) => {
        await options.update({ reset: false });
    };

    /**
     * テレビの一覧も同じ写し方 (名前+ホスト+コーデックの行編集)。名前がホストと
     * 同じなのは「名前を付けていない」印なので、名前の欄は空で出す。
     *
     * **書き戻すのは、サーバの一覧そのものが変わったときだけ** (tvSeen)。
     * load はどのフォームを保存しても走り直すので、素直に写すと**別のカードを
     * 保存しただけで編集中の行が巻き戻って**いた (複数行をいじる編集では
     * パスワード欄より実害が大きい)
     */
    // ホストは `IP:ポート` で持っている (parseTargets が補うのでポートは必ず在る)。
    // 画面は欄を分けるので、ここで割って、保存 (saveVlc) がまた繋ぐ
    const tvRowsOf = () =>
        data.vlc.targets.map((t) => ({
            name: t.name === t.host ? '' : t.name,
            ip: t.host.split(':')[0],
            port: t.host.split(':')[1] ?? '8080',
            codec: t.codec,
        }));
    let tvRows = $state(untrack(tvRowsOf));
    let tvSeen = JSON.stringify(untrack(tvRowsOf));

    $effect(() => {
        recording = { ...data.recording };
    });
    $effect(() => {
        const rows = tvRowsOf();
        const key = JSON.stringify(rows);
        if (key === tvSeen) return;
        tvSeen = key;
        tvRows = rows;
    });

</script>

{#snippet checkRow(
    name: string,
    checked: boolean,
    testid: string,
    title: string,
    hint: string,
    wrap: string = '',
)}
    <!-- チェック + 見出し + 小さい説明。この画面の決まりの形 (6行が同じ骨格だった) -->
    <label class="flex cursor-pointer items-start gap-2 {wrap}">
        <input type="checkbox" {name} {checked} class="checkbox checkbox-sm mt-0.5" data-testid={testid} />
        <span class="text-sm">
            {title}
            <span class="text-base-content/60 block text-xs">{hint}</span>
        </span>
    </label>
{/snippet}

<Toasts {notices} source={form} />

<!--
    カードを縦に積むと1枚ずつが横に間延びして、下のほうは開かないと見えない。
    広い画面では**全部を2列に収める**。

    表を持つカードだけ幅いっぱいに広げていた頃は、2列の下に幅いっぱいの帯が
    続く形になり、**どこまでが左の列の続きなのかが読めなかった**。表は中で
    横に巻き取れる (`overflow-x-auto`) ので、半分の幅でも読める。

    列は grid の行ではなく独立した縦並びにしてある。行で組むと段ごとに
    高さが揃えられ、背の低いカードの隣に大きな穴が空く
-->
<div class="grid items-start gap-6 xl:grid-cols-2">
    <div class="flex min-w-0 flex-col gap-6">
        <section class="card bg-base-100 shadow">
            <div class="card-body">
                <h2 class="card-title">録画のしかた</h2>
                <p class="text-base-content/70 text-sm">
                    全部の録画に効きます。番組ごとに変えたくなることは実際にはほとんど無いので、
                    ルールにも予約にも同じ選択肢を並べず、ここ1箇所で決めます。
                </p>
                <form
                    method="POST"
                    action="?/saveRecording"
                    use:submitting={keepValues}
                    class="grid gap-4 sm:grid-cols-2"
                    data-testid="recording-form"
                >
                    <!--
                        **コーデックは複数選べる。** 両方入れると1本の録画を両方で
                        焼く — 古いテレビは AV1 を解けないので H.264 も置いておくと、
                        同じ録画をどちらの端末でも観られる。どちらも入れなければ
                        「エンコードしない」(生TSのまま)。

                        単一選択 (`<select>`) だった頃は「どちらか一方」しか持てず、
                        テレビ用に H.264 を選ぶとブラウザ用の小さい AV1 を諦めることに
                        なっていた
                    -->
                    <fieldset class="flex flex-col gap-1" data-testid="global-codec">
                        <span class="text-sm font-medium">映像コーデック</span>
                        <label class="label cursor-pointer justify-start gap-2 py-1">
                            <input
                                type="checkbox"
                                name="codecs"
                                value="av1"
                                class="checkbox checkbox-sm"
                                checked={recording.codecs.includes('av1')}
                                data-testid="codec-av1"
                            />
                            <span class="label-text">AV1 (小さい・遅い)</span>
                        </label>
                        <label class="label cursor-pointer justify-start gap-2 py-1">
                            <input
                                type="checkbox"
                                name="codecs"
                                value="h264"
                                class="checkbox checkbox-sm"
                                checked={recording.codecs.includes('h264')}
                                data-testid="codec-h264"
                            />
                            <span class="label-text">H.264 (古いテレビ向け・大きい)</span>
                        </label>
                        {#if recording.codecs.length === 0}
                            <span class="text-base-content/60 text-xs">
                                どちらも入れないと<strong>エンコードしません</strong>
                                (生TSのまま置く)。CM のチャプターも字幕トラックも付きません
                            </span>
                        {:else if recording.codecs.length === 2}
                            <span class="text-base-content/60 text-xs">
                                1本の録画を両方でエンコードします (再生・ダウンロードは既定で AV1。
                                テレビごとの設定で H.264 を渡せます)
                            </span>
                        {/if}
                    </fieldset>
                    <!--
                        **並びは話題ごとに。** 2列に流し込むので、DOM の順がそのまま
                        「どれとどれが同じ行に来るか」になる。CM の2つ (切り方・探し方) が
                        斜めに離れていた頃は、同じ話の設定に見えなかった。
                        1行目は「出来上がるもの」(コーデックと生TS)、2行目は CM。

                        生TSを残すか・無料放送だけにするかも、ここで決める。
                        画面に出していなかった頃は、保存を押すたびに未送信のチェックボックスとして
                        全部 false で上書きされていた
                    -->
                    {@render checkRow(
                        'keepOriginal',
                        recording.keepOriginal,
                        'global-keep',
                        '生TSも残す',
                        'エンコードしたあとも元のTSを消しません。容量を食います',
                        'sm:self-center',
                    )}
                    <label class="flex flex-col gap-1">
                        <span class="text-sm font-medium">CM</span>
                        <select name="cmCut" class="select select-bordered w-full" data-testid="global-cmcut">
                            <option value="chapter" selected={recording.cmCut === 'chapter'}>
                                チャプターを打つだけ (安全)
                            </option>
                            <option value="cut" selected={recording.cmCut === 'cut'}>実際に切る</option>
                            <option value="off" selected={recording.cmCut === 'off'}>何もしない</option>
                        </select>
                    </label>
                    <label class="flex flex-col gap-1">
                        <span class="text-sm font-medium">CMの探し方</span>
                        <select
                            name="cmDetector"
                            class="select select-bordered w-full"
                            data-testid="global-detector"
                        >
                            <option value="jls" selected={recording.cmDetector === 'jls'}>
                                ロゴまで見る (確実・遅い)
                            </option>
                            <option value="silence" selected={recording.cmDetector === 'silence'}>
                                無音だけ (速い)
                            </option>
                        </select>
                        <span class="text-base-content/60 text-xs">
                            ロゴまで見ると録画1本あたり数分かかります
                        </span>
                    </label>
                    <!--
                        **ロゴをどれだけ当てにするか** (JL の logo_level)。
                        ロゴが出ているコマは logoframe が別に拾っていて、それを
                        無音・シーンチェンジと突き合わせて番組の構成を推測するのが
                        join_logo_scp。その推測でロゴをどれだけ優先するかがここ。

                        数字 (1〜8) をそのまま出しても「6 は高いのか」を考えさせる
                        だけなので、言葉で選ばせる
                    -->
                    <label class="flex flex-col gap-1">
                        <span class="text-sm font-medium">ロゴをどれだけ当てにするか</span>
                        <select
                            name="logoLevel"
                            class="select select-bordered w-full"
                            data-testid="global-logo-level"
                            disabled={recording.cmDetector !== 'jls'}
                        >
                            <option value="8" selected={recording.logoLevel >= 8}> ロゴを最優先する </option>
                            <option value="6" selected={recording.logoLevel < 8 && recording.logoLevel >= 5}>
                                ふつう (おすすめ)
                            </option>
                            <option value="3" selected={recording.logoLevel < 5 && recording.logoLevel >= 2}>
                                ロゴは参考程度
                            </option>
                            <option value="1" selected={recording.logoLevel <= 1}> ロゴを使わない </option>
                        </select>
                        <span class="text-base-content/60 text-xs">
                            ロゴは合っているのにCMを取り違えるなら「最優先」側に、取り込んであるロゴ自体が怪しいなら「参考程度」側にします
                        </span>
                    </label>
                    <!--
                        コマ数 (30/60) は本編映像から実測して決める (encoder.measureSmoothMotion)。
                        放送は素材が何でも 1080i/60 で来るので、ジャンルにもTSのヘッダにも
                        本当のコマ数は入っていない。60コマに起こして同じ絵が並ぶ割合を
                        数えるのが唯一の見分け方だった (実測: アニメ 21〜55% / 生放送 71%)
                    -->
                    {@render checkRow(
                        'fpsDetect',
                        recording.fpsDetect,
                        'global-fps-detect',
                        'コマ数を映像から決める',
                        '同じ絵が並ぶ素材 (アニメなど) を 30コマでエンコードし、時間とサイズを半分にします。外すと全部 60コマになります',
                    )}
                    {@render checkRow(
                        'freeOnly',
                        recording.freeOnly,
                        'global-free-only',
                        '自動予約は無料放送だけにする',
                        '契約していない有料放送は、録画してもスクランブルのままで観られません',
                        'sm:col-span-2',
                    )}
                    <div class="sm:col-span-2">
                        <button type="submit" class="btn btn-primary" data-testid="save-recording">保存</button>
                    </div>
                </form>
            </div>
        </section>
        <!--
            **GPU は別のカード。** 口 (グラボ) が増えると行が増え、道 × コーデックの印も
            口ごとに持つ。「録画のしかた」に混ぜると、コーデックの選択と GPU の割り振りが
            同じ列に並んで読みにくかった。挿さっている機材を起動時に見つけて
            (server/hwenc.ts)、**使えるものには自動で印が付く**。外したいものだけ外す。
            使えないものの印は触れない — 押しても焼けないものにチェックを入れさせても嘘になるだけ
        -->
        <section class="card bg-base-100 shadow" data-testid="hw-card">
            <div class="card-body">
                <h2 class="card-title">GPU</h2>
                <p class="text-base-content/70 text-sm">
                    GPU (Intel QSV / VA-API) で焼くかを、口ごと・コーデックごとに決めます。
                    使えるものには自動で印が付き、両方に付いていれば QSV → VA-API → ソフトウェアの
                    順に試して、落ちたら次で焼き直します。グラボが2枚あれば「こちらは AV1、
                    あちらは H.264」のように分けられ、同じコーデックを焼ける口が複数あれば順に回します。
                </p>
                {#await data.hw}
                    <span class="text-base-content/60 text-xs" data-testid="hw-status">GPU を確認中…</span>
                {:then hw}
                    <form method="POST" action="?/saveHw" use:submitting={keepValues} data-testid="hw-form">
                        <span class="text-base-content/60 text-xs" data-testid="hw-status">{hw.message}</span>
                        {#if hw.devices.length > 0}
                            <!-- 口ごとに1枚。表にすると半分の幅で横に巻くので、縦に積む -->
                            <div class="divide-base-300 mt-2 divide-y">
                                {#each hw.devices as device (device.path)}
                                    {@const port = device.path.split('/').at(-1)}
                                    <div class="space-y-1 py-2" data-testid="hw-device" data-device={device.path}>
                                        <div class="font-mono text-sm">{device.label}</div>
                                        <div class="text-base-content/60 text-xs">{device.summary}</div>
                                        {#each HW_KINDS as [kind, kindLabel] (kind)}
                                            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                                                <span class="w-20 text-sm">{kindLabel}</span>
                                                {#each HW_CODECS as [codec, label] (codec)}
                                                    {@const usable = device[kind].includes(codec)}
                                                    <label
                                                        class="inline-flex items-center gap-1 {usable
                                                            ? 'cursor-pointer'
                                                            : 'cursor-not-allowed opacity-50'}"
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            name={`hw.${device.path}.${kind}.${codec}`}
                                                            class="checkbox checkbox-sm"
                                                            checked={usable && allowed(device.path, kind, codec)}
                                                            disabled={!usable}
                                                            data-testid={`hw-${port}-${kind}-${codec}`}
                                                        />
                                                        <span class="text-sm">{label}</span>
                                                    </label>
                                                {/each}
                                            </div>
                                        {/each}
                                    </div>
                                {/each}
                            </div>
                        {/if}
                        <div class="card-actions mt-2">
                            {#if hw.devices.length > 0}
                                <button type="submit" class="btn btn-primary btn-sm" data-testid="hw-save">保存</button>
                            {/if}
                            <button type="submit"
                                class="btn btn-ghost btn-sm"
                                formaction="?/probeHw"
                                formnovalidate
                                data-testid="hw-probe"
                            >
                                確かめ直す
                            </button>
                        </div>
                    </form>
                {/await}
            </div>
        </section>
        <section class="card bg-base-100 shadow">
            <div class="card-body">
                <h2 class="card-title">通知</h2>
                <p class="text-base-content/70 text-sm">
                    録画の開始・完了・失敗などの通知を外部に送ります。Discord や Slack の Incoming Webhook の URL
                    をそのまま入れられます。
                    録画の失敗は画面を開くまで気づけないので、少なくとも失敗だけでも入れておくと安心です。
                </p>

                {#if form?.tested}
                    <div class="alert mb-2" data-testid="webhook-tested">テスト送信の結果: {form.tested}</div>
                {/if}

                <form method="POST" action="?/addWebhook" use:submitting class="grid gap-3 sm:grid-cols-2">
                    <label class="flex flex-col gap-1 sm:col-span-2">
                        <span class="text-sm font-medium">URL</span>
                        <input
                            name="url"
                            class="input input-bordered w-full"
                            placeholder="https://..."
                            data-testid="webhook-url"
                        />
                    </label>
                    <div class="sm:col-span-2">
                        <span class="text-sm font-medium">送る通知</span>
                        <div class="mt-1 flex flex-wrap gap-4" data-testid="webhook-events">
                            {#each data.events as event (event)}
                                <label class="flex cursor-pointer items-center gap-2">
                                    <input
                                        type="checkbox"
                                        name="events"
                                        value={event}
                                        class="checkbox checkbox-sm"
                                    />
                                    <span class="text-sm">{EVENT_LABEL[event]}</span>
                                </label>
                            {/each}
                        </div>
                        <p class="text-base-content/60 mt-1 text-xs">1つも選ばなければ全部送ります</p>
                    </div>
                    <div class="sm:col-span-2">
                        <button type="submit" class="btn btn-primary" data-testid="webhook-add">追加</button>
                    </div>
                </form>

                {#if data.webhooks.length > 0}
                    <!--
                        **表ではなく行のカード** (録画一覧と同じ形)。列にしていた頃は
                        半分の幅で「送る通知」がはみ出して横に巻いていた。1件を
                        URL・送る通知・直近の結果・ボタン の順に縦に積めば、幅がいくらでも
                        横には出ない (URL だけは折らずに `truncate` で止める)
                    -->
                    <div class="divide-base-300 mt-4 divide-y" data-testid="webhook-list">
                        {#each data.webhooks as webhook (webhook.id)}
                            <div class="space-y-2 py-3" data-testid="webhook-row" data-webhook-id={webhook.id}>
                                <div class="flex items-center gap-2">
                                    <span
                                        class="badge badge-sm shrink-0 {webhook.enabled
                                            ? 'badge-success'
                                            : 'badge-ghost'}"
                                    >
                                        {webhook.enabled ? '有効' : '無効'}
                                    </span>
                                    <span class="min-w-0 truncate font-mono text-xs">{webhook.url}</span>
                                </div>
                                <div class="text-sm">
                                    <span class="text-base-content/60">送る通知:</span>
                                    {JSON.parse(webhook.events).length === 0
                                        ? 'すべて'
                                        : JSON.parse(webhook.events)
                                              .map((e: string) => EVENT_LABEL[e] ?? e)
                                              .join(', ')}
                                </div>
                                <div class="text-sm">
                                    <span class="text-base-content/60">直近の結果:</span>
                                    {#if webhook.last_sent_at}
                                        <span class={webhook.last_status === 'ok' ? '' : 'text-error'}>
                                            {webhook.last_status}
                                        </span>
                                        <span class="text-base-content/60 text-xs">
                                            {dateTime(webhook.last_sent_at)}
                                        </span>
                                    {:else}
                                        <span class="text-base-content/60">未送信</span>
                                    {/if}
                                </div>
                                <div class="flex flex-wrap gap-2">
                                    <form method="POST" action="?/testWebhook" use:submitting>
                                        <input type="hidden" name="id" value={webhook.id} />
                                        <button type="submit" class="btn btn-xs" data-testid="webhook-test">テスト送信</button>
                                    </form>
                                    <form method="POST" action="?/toggleWebhook" use:submitting>
                                        <input type="hidden" name="id" value={webhook.id} />
                                        <button type="submit" class="btn btn-xs" data-testid="webhook-toggle">
                                            {webhook.enabled ? '無効化' : '有効化'}
                                        </button>
                                    </form>
                                    <form method="POST" action="?/deleteWebhook" use:submitting>
                                        <input type="hidden" name="id" value={webhook.id} />
                                        <button type="submit"
                                            class="btn btn-xs btn-error btn-outline"
                                            data-testid="webhook-delete"
                                        >
                                            削除
                                        </button>
                                    </form>
                                </div>
                            </div>
                        {/each}
                    </div>
                {/if}
            </div>
        </section>
    </div>

    <div class="flex min-w-0 flex-col gap-6">
        <!--
            **データ放送に渡すもの。** いまは郵便番号だけ。

            テレビの初期設定で必ず訊かれるあれで、放送のアプリはこれを読んで
            天気・地域のニュース・防災情報をどこのものにするかを決める。
            受け取るのは端末の中 (NVRAM = localStorage) だが、置き場をここに
            してあるのは**端末ごとに訊き直さずに済ませる**ため
        -->
        <section class="card bg-base-100 shadow" data-testid="broadcast-card">
            <div class="card-body">
                <h2 class="card-title">データ放送</h2>
                <p class="text-base-content/70 text-sm">
                    テレビの初期設定で聞かれる郵便番号です。データ放送 (d ボタン) の
                    <strong>天気・地域のニュース・防災情報</strong>は、これでどこの分を出すかが決まります。
                    入れていないと「郵便番号が正しく設定されていません」と出て、その欄が空のままになります。
                </p>
                <form method="POST" action="?/saveBroadcast" use:submitting={keepValues} class="flex flex-wrap items-end gap-3">
                    <label class="flex flex-col gap-1">
                        <span class="text-sm font-medium">郵便番号</span>
                        <input
                            name="postalCode"
                            value={data.broadcast.postalCode}
                            class="input input-bordered w-40 font-mono"
                            placeholder="1000001"
                            inputmode="numeric"
                            data-testid="postal-code"
                        />
                    </label>
                    <!-- **空にできる。** 空は「渡さない」という選び方で、危なくない -->
                    <span class="text-base-content/60 basis-full text-xs">
                        数字7桁。ハイフンは入れても構いません。空にすると渡しません
                    </span>

                    <!--
                        **双方向。既定は切。**

                        入れると denpa のサーバが放送局のサーバへ代理で取りに
                        行きます。何に繋いでよいかの決め方 (公開の相手・http/https・
                        GET と POST) は `server/bml-network.ts` に書いてあります。
                        切っている間は「インターネットに接続されていません」と
                        放送側が案内します — **それは事実の通りなので、
                        黙って入れない**
                    -->
                    <label class="flex basis-full cursor-pointer items-start gap-2">
                        <input
                            type="checkbox"
                            name="bmlNetwork"
                            checked={data.broadcast.bmlNetwork}
                            class="checkbox checkbox-sm mt-0.5"
                            data-testid="bml-network"
                        />
                        <span class="text-sm">
                            双方向 (通信系コンテンツ) を使う
                            <span class="text-base-content/60 block text-xs">
                                入れると、denpa が<strong>放送局のサーバとの通信を代わりに行います</strong> (受け取りも送信もします)。
                                番組の応募や投票もそのまま通ります。切っていると放送側は
                                「インターネットに接続されていません」と案内します
                            </span>
                        </span>
                    </label>

                    <div class="basis-full">
                        <button type="submit" class="btn btn-primary" data-testid="save-broadcast">保存</button>
                    </div>
                </form>
            </div>
        </section>

        <!--
            **テレビの VLC で再生。** VLC for Android (3.6+) のリモートアクセスへ、
            **画面を開いている端末が** URL を投げて再生させる (server/vlc.ts は
            一覧を持つだけ)。相手の居場所だけここで決め、
            ペアリング (テレビに出る6桁のコード) は録画詳細の「テレビで再生」を
            初めて押したときにその場でやる
        -->
        <section class="card bg-base-100 shadow" data-testid="vlc-card">
            <div class="card-body">
                <h2 class="card-title">テレビで再生 (VLC)</h2>
                <p class="text-base-content/70 text-sm">
                    テレビの VLC の「リモートアクセス」に、<strong>いま開いている端末から</strong>録画を飛ばして
                    再生させます。VLC 側で <strong>その他 → リモートアクセス</strong> を有効にして、ここに
                    テレビを登録すると、録画詳細に「テレビで再生」が出ます (登録が無いと出ません)。初回だけ
                    VLC のペア設定が開きます — セキュアな接続 (自己署名の証明書) を受け入れて、
                    テレビの画面に出る6桁コードを入れると、以後は素通りです。
                    AV1 を再生できないテレビは、コーデックを H.264 や生TSにすると
                    そのテレビにだけ別のファイルを渡します。
                </p>
                <form method="POST" action="?/saveVlc" use:submitting={keepValues} class="flex flex-col gap-3">
                    {#each tvRows as row (row)}
                        <div class="flex flex-wrap items-center gap-2">
                            <input
                                name="vlcName"
                                bind:value={row.name}
                                class="input input-bordered w-40"
                                placeholder="名前 (例 リビング)"
                                data-testid="vlc-name"
                            />
                            <input
                                name="vlcIp"
                                bind:value={row.ip}
                                class="input input-bordered w-44 font-mono"
                                placeholder="IP (例 192.168.10.20)"
                                data-testid="vlc-ip"
                            />
                            <input
                                name="vlcPort"
                                bind:value={row.port}
                                class="input input-bordered w-24 font-mono"
                                placeholder="8080"
                                data-testid="vlc-port"
                            />
                            <!--
                                そのテレビに渡すファイル。おまかせ (今いいほう) が既定で、
                                AV1 を解けないテレビは H.264、エンコード済み自体が重い
                                テレビは生TS。無い形式を選んでいたら、おまかせに落ちる
                            -->
                            <select
                                name="vlcCodec"
                                bind:value={row.codec}
                                class="select select-bordered"
                                data-testid="vlc-codec"
                            >
                                <option value="auto">おまかせ</option>
                                <option value="h264">H.264</option>
                                <option value="ts">生TS</option>
                            </select>
                            <button
                                type="button"
                                class="btn btn-ghost btn-sm"
                                onclick={() => tvRows.splice(tvRows.indexOf(row), 1)}
                                data-testid="vlc-remove"
                            >
                                外す
                            </button>
                        </div>
                    {:else}
                        <p class="text-base-content/60 text-sm">まだテレビがありません</p>
                    {/each}
                    <span class="text-base-content/60 text-xs">
                        名前は空でもかまいません (IPがそのままボタンの文字になります)。
                        ポートを空にすると VLC の既定 (8080) になります
                    </span>
                    <div class="flex gap-2">
                        <button
                            type="button"
                            class="btn"
                            onclick={() => tvRows.push({ name: '', ip: '', port: '8080', codec: 'auto' })}
                            data-testid="vlc-add"
                        >
                            テレビを足す
                        </button>
                        <button type="submit" class="btn btn-primary" data-testid="save-vlc">保存</button>
                    </div>
                </form>
            </div>
        </section>

        <section class="card bg-base-100 shadow" data-testid="migrate-card">
            <div class="card-body">
                <h2 class="card-title">EPGStation からの引き継ぎ</h2>
                <p class="text-base-content/70 text-sm">
                    EPGStation のデータベースを読み、<strong>自動予約ルール・手で入れた予約・録画</strong>を
                    取り込みます。録画は denpa
                    の並びに置き直し、番組情報とサムネイルもここで作ります。何度実行しても取り込み済みのものは飛ばします。
                    ルール由来の予約は、ルールを取り込んだあと denpa が自分で立て直します。
                </p>

                {#if !data.migrate.available}
                    <div class="alert alert-warning mt-2" data-testid="migrate-unavailable">
                        引き継ぎ元 <code>{data.migrate.source}</code> が見えません。denpa の Pod に EPGStation の録画PVCをマウントしてください。
                    </div>
                {:else}
                    <form method="POST" action="?/migrate" use:submitting class="mt-2 space-y-3">
                        {@render checkRow(
                            'apply',
                            false,
                            'migrate-apply',
                            '実際に取り込む',
                            '外したままなら何が取り込まれるかを出すだけで、ファイルもデータベースも触りません',
                        )}
                        {@render checkRow(
                            'move',
                            false,
                            'migrate-move',
                            'コピーではなく移動する',
                            '既定はコピー。中身を確かめてから EPGStation 側を消せます。空き容量が足りないときだけ移動にしてください',
                        )}
                        <button type="submit"
                            class="btn btn-primary"
                            disabled={migrate.state === 'running'}
                            data-testid="migrate-run"
                        >
                            {migrate.state === 'running' ? '実行中…' : '実行する'}
                        </button>
                    </form>
                {/if}

                {#if migrate.state !== 'idle'}
                    <div class="mt-4" data-testid="migrate-progress" data-state={migrate.state}>
                        <div class="flex flex-wrap items-center gap-2 text-sm">
                            <span class="badge" data-testid="migrate-state">
                                {migrate.state === 'running'
                                    ? '実行中'
                                    : migrate.state === 'done'
                                      ? '完了'
                                      : '失敗'}
                            </span>
                            <span class="badge badge-ghost">{migrate.apply ? '取り込み' : '確認だけ (変更なし)'}</span>
                            {#if migrate.move}
                                <span class="badge badge-ghost">移動</span>
                            {/if}
                            <span data-testid="migrate-counts">
                                新規 {migrate.imported} 件 / 取り込み済み {migrate.skipped} 件 / ファイル無し {migrate.missing}
                                件
                            </span>
                            <span data-testid="migrate-rule-counts">
                                ルール {migrate.rules.imported} 件 / 対象外 {migrate.rules.skipped} 件
                            </span>
                            <span data-testid="migrate-reservation-counts">
                                予約 {migrate.reservations.imported} 件 / 対象外 {migrate.reservations.skipped} 件
                            </span>
                        </div>

                        {#if migrate.total > 0}
                            <progress
                                class="progress progress-primary mt-2 w-full"
                                value={done}
                                max={migrate.total}
                            ></progress>
                            <div class="text-base-content/60 mt-1 text-xs">
                                {done} / {migrate.total}
                                {#if migrate.current}— {migrate.current}{/if}
                            </div>
                        {/if}

                        {#if migrate.error}
                            <div class="alert alert-error mt-2" data-testid="migrate-error">{migrate.error}</div>
                        {/if}

                        {#if migrate.log.length > 0}
                            <details class="border-base-300 rounded-box mt-3 border">
                                <summary class="cursor-pointer px-4 py-2 text-sm font-medium">
                                    ログ ({migrate.log.length} 行)
                                </summary>
                                <pre
                                    class="max-h-64 overflow-auto px-4 pb-3 text-xs"
                                    data-testid="migrate-log">{migrate.log.join('\n')}</pre>
                            </details>
                        {/if}
                    </div>
                {/if}
            </div>
        </section>

        <!--
            **端末でしか出ない食い違いを、その端末で読むための口。**

            縦のはみ出し (ページごと動いてしまう) は、引っ込むアドレスバーや
            画面の切り欠きが絡むと**その端末でしか起きない**。自動運転の
            ブラウザには作れないので、手元では再現できない。

            **入り口をここに置くのは、PWA にアドレスバーが無いため。**
            `?measure` を付ければ同じものが出るが、ホーム画面から開いた
            アプリでは URL を打つところがない。
        -->
        <section class="card bg-base-100 shadow" data-testid="measure-card">
            <div class="card-body">
                <h2 class="card-title">画面の高さを見る</h2>
                <p class="text-base-content/70 text-sm">
                    右下に、その端末での高さを出します。<strong>この端末だけ</strong>の設定で、
                    サーバにも他の端末にも伝わりません。
                </p>

                <label class="label cursor-pointer justify-start gap-3">
                    <input
                        type="checkbox"
                        class="toggle"
                        checked={measure.on}
                        onchange={(event) => measure.set(event.currentTarget.checked)}
                        data-testid="measure-toggle"
                    />
                    <span class="label-text">高さの表示を出す</span>
                </label>

                <p class="text-base-content/60 text-xs">
                    出るのは「窓 / 枠 / 中身 = はみ出し」「dvh / svh / lvh / vh の実測」と、
                    <strong>はみ出している要素</strong>。はみ出しが 0 でなければページごと動きます。
                    単位の4つが同じ数なら、食い違いが原因ではありません。
                </p>
            </div>
        </section>
    </div>
</div>
