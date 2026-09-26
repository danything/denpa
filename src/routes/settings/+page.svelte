<script lang="ts">
    import type { SubmitFunction } from '@sveltejs/kit';
    import { untrack } from 'svelte';
    import { submitting } from '$lib/actions';
    import Toasts, { errorNotice, type Notice } from '$lib/components/Toasts.svelte';
    import { dateTime, stateLabel } from '$lib/format';
    import { CODEC_LABEL, HW_CODECS, HW_KIND_LABEL, HW_KINDS, hwAllowed } from '$lib/hw';
    import { liveUpdates } from '$lib/live-updates.svelte';
    import { measure } from '$lib/measure.svelte';
    import { rawSetting } from '$lib/raw/setting.svelte';
    import { rawUnsupported } from '$lib/raw/support';
    import { EVENT_LABEL } from '$lib/webhook-events';

    let { data, form } = $props();

    liveUpdates(['migrate']);

    /**
     * この端末で生の TS を解けるか (`raw/support.ts`)。**入れる前に分かるように出す** —
     * 入れても解けなければ焼いたものになるので、スイッチだけ見ても効くか分からない
     */
    let rawProblem = $state<string | null | undefined>(undefined);
    $effect(() => {
        void rawUnsupported().then((problem) => {
            rawProblem = problem;
        });
    });


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

    /**
     * 録画設定のフォームは bind せず `checked` / `selected` で初期値だけ渡す。
     * 別のフォームを保存して data が読み直されても、値が同じなら Svelte は DOM に
     * 書かない — 手元で変えたまま保存していない入力はそのまま残る
     */
    const recording = $derived(data.recording);

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
    <label class="check-row {wrap}">
        <input type="checkbox" {name} {checked} data-testid={testid} />
        <span class="small">
            {title}
            <span class="hint">{hint}</span>
        </span>
    </label>
{/snippet}

<Toasts {notices} source={form} />

<!--
    カードを縦に積むと1枚ずつが横に間延びして、下のほうは開かないと見えない。
    広い画面では**全部を2列に収める**。

    表を持つカードだけ幅いっぱいに広げていた頃は、2列の下に幅いっぱいの帯が
    続く形になり、**どこまでが左の列の続きなのかが読めなかった**。表は中で
    横に巻き取れる (`overflow-x: auto`) ので、半分の幅でも読める。

    列は grid の行ではなく独立した縦並びにしてある。行で組むと段ごとに
    高さが揃えられ、背の低いカードの隣に大きな穴が空く
-->
<div class="columns">
    <div class="column">
        <section class="panel card">
            <h2>録画のしかた</h2>
            <p class="small lead">
                すべての録画に効きます。ルールや予約ごとには変えられません。
            </p>
            <form
                method="POST"
                action="?/saveRecording"
                use:submitting={keepValues}
                class="two-col"
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
                <fieldset class="field">
                    <span class="label">映像コーデック</span>
                    <label class="check">
                        <input
                            type="checkbox"
                            name="codecs"
                            value="av1"
                            checked={recording.codecs.includes('av1')}
                            data-testid="codec-av1"
                        />
                        <span>AV1 (小さい・遅い)</span>
                    </label>
                    <label class="check">
                        <input
                            type="checkbox"
                            name="codecs"
                            value="h264"
                            checked={recording.codecs.includes('h264')}
                            data-testid="codec-h264"
                        />
                        <span>H.264 (古いテレビ向け・大きい)</span>
                    </label>
                    {#if recording.codecs.length === 0}
                        <span class="hint">
                            どちらも選ばないと<strong>エンコードせず</strong>、
                            生TSのまま残します。CM のチャプターや字幕トラックも付きません
                        </span>
                    {:else if recording.codecs.length === 2}
                        <span class="hint">
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
                    'エンコードしたあとも元のTSを消しません。容量を多く使います',
                    'self-center',
                )}
                <label class="field">
                    <span class="label">CM</span>
                    <select name="cmCut" data-testid="global-cmcut">
                        <option value="chapter" selected={recording.cmCut === 'chapter'}>
                            チャプターを打つだけ (安全)
                        </option>
                        <option value="cut" selected={recording.cmCut === 'cut'}>切り取る</option>
                        <option value="off" selected={recording.cmCut === 'off'}>何もしない</option>
                    </select>
                </label>
                <label class="field">
                    <span class="label">CMの探し方</span>
                    <select name="cmDetector">
                        <option value="jls" selected={recording.cmDetector === 'jls'}>
                            ロゴまで見る (確実・遅い)
                        </option>
                        <option value="silence" selected={recording.cmDetector === 'silence'}>
                            無音だけ (速い)
                        </option>
                    </select>
                    <span class="hint">ロゴまで見ると録画1本あたり数分かかります</span>
                </label>
                <!--
                    **ロゴをどれだけ当てにするか** (JL の logo_level)。
                    ロゴが出ているコマは logoframe が別に拾っていて、それを
                    無音・シーンチェンジと突き合わせて番組の構成を推測するのが
                    join_logo_scp。その推測でロゴをどれだけ優先するかがここ。

                    数字 (1〜8) をそのまま出しても「6 は高いのか」を考えさせる
                    だけなので、言葉で選ばせる
                -->
                <label class="field">
                    <span class="label">ロゴの重み</span>
                    <select
                        name="logoLevel"
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
                    <span class="hint">
                        ロゴは合っているのにCMを取り違えるなら「最優先」寄りに、覚えたロゴ自体が怪しいなら「参考程度」寄りにしてください
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
                    '同じコマが続く映像 (アニメなど) は 30コマでエンコードし、時間とサイズを半分にします。外すとすべて 60コマになります',
                )}
                {@render checkRow(
                    'freeOnly',
                    recording.freeOnly,
                    'global-free-only',
                    '自動予約は無料放送だけにする',
                    '契約していない有料放送は、録画してもスクランブルのままで観られません',
                    'span-2',
                )}
                <div class="span-2">
                    <button type="submit" data-testid="save-recording">保存</button>
                </div>
            </form>
        </section>
        <!--
            **GPU は別のカード。** 口 (グラボ) が増えると行が増え、道 × コーデックの印も
            口ごとに持つ。「録画のしかた」に混ぜると読みにくかった。使えないものの印は
            触れない — 押しても焼けないものにチェックを入れさせても嘘になるだけ
        -->
        <section class="panel card">
            <h2>GPU</h2>
            <p class="small lead">
                GPU (Intel QSV / VA-API) でエンコードするかを、デバイスごと・コーデックごとに選びます。
                使えるものには自動で印が付きます。両方に付いていれば QSV → VA-API → ソフトウェアの
                順に試し、失敗したら次の方法でやり直します。GPU が2枚あれば「こちらは AV1、
                あちらは H.264」のように分けられ、同じコーデックを扱えるデバイスが複数あれば順番に使います。
            </p>
            {#await data.hw}
                <span class="hint" data-testid="hw-status">GPU を確認中…</span>
            {:then hw}
                <form method="POST" action="?/saveHw" use:submitting={keepValues}>
                    <span class="hint" data-testid="hw-status">{hw.message}</span>
                    {#if hw.devices.length > 0}
                        <!-- 口ごとに1枚。表にすると半分の幅で横に巻くので、縦に積む -->
                        <div class="rows">
                            {#each hw.devices as device (device.path)}
                                <div class="row device" data-testid="hw-device" data-device={device.path}>
                                    <div class="mono small">{device.label}</div>
                                    <div class="hint">{device.summary}</div>
                                    {#each HW_KINDS as kind (kind)}
                                        <div class="kind-row">
                                            <span class="kind small">{HW_KIND_LABEL[kind]}</span>
                                            {#each HW_CODECS as codec (codec)}
                                                {@const usable = device[kind].includes(codec)}
                                                <label class="check" class:unusable={!usable}>
                                                    <input
                                                        type="checkbox"
                                                        name={`hw.${device.path}.${kind}.${codec}`}
                                                        checked={usable &&
                                                            hwAllowed(data.recording.hwAllow, device.path, kind, codec)}
                                                        disabled={!usable}
                                                        data-testid={`hw-${device.port}-${kind}-${codec}`}
                                                    />
                                                    <span class="small">{CODEC_LABEL[codec]}</span>
                                                </label>
                                            {/each}
                                        </div>
                                    {/each}
                                </div>
                            {/each}
                        </div>
                    {/if}
                    <div class="cluster actions">
                        {#if hw.devices.length > 0}
                            <button type="submit" class="small" data-testid="hw-save">保存</button>
                        {/if}
                        <button
                            type="submit"
                            class="small ghost"
                            formaction="?/probeHw"
                            formnovalidate
                            data-testid="hw-probe"
                        >
                            確かめ直す
                        </button>
                    </div>
                </form>
            {/await}
        </section>
        <section class="panel card">
            <h2>通知</h2>
            <p class="small lead">
                録画の開始・完了・失敗などを外部に通知します。Discord や Slack の Incoming Webhook の URL
                をそのまま入れられます。
                録画の失敗は画面を開くまで気づけないので、せめて「録画失敗」は送っておくと安心です。
            </p>

            {#if form?.tested}
                <div class="notice" data-testid="webhook-tested">テスト送信の結果: {form.tested}</div>
            {/if}

            <form method="POST" action="?/addWebhook" use:submitting class="two-col">
                <label class="field span-2">
                    <span class="label">URL</span>
                    <input name="url" placeholder="https://..." data-testid="webhook-url" />
                </label>
                <div class="span-2">
                    <span class="label">送る通知</span>
                    <div class="events" data-testid="webhook-events">
                        {#each data.events as event (event)}
                            <label class="check">
                                <input type="checkbox" name="events" value={event} />
                                <span class="small">{EVENT_LABEL[event]}</span>
                            </label>
                        {/each}
                    </div>
                    <p class="hint">1つも選ばなければ全部送ります</p>
                </div>
                <div class="span-2">
                    <button type="submit" data-testid="webhook-add">追加</button>
                </div>
            </form>

            {#if data.webhooks.length > 0}
                <!--
                    **表ではなく行のカード** (録画一覧と同じ形)。列にしていた頃は
                    半分の幅で「送る通知」がはみ出して横に巻いていた。1件を
                    URL・送る通知・直近の結果・ボタン の順に縦に積めば、幅がいくらでも
                    横には出ない (URL だけは折らずに `text-overflow: ellipsis` で止める)
                -->
                <div class="rows webhooks" data-testid="webhook-list">
                    {#each data.webhooks as webhook (webhook.id)}
                        <div class="row webhook" data-testid="webhook-row" data-webhook-id={webhook.id}>
                            <div class="url-line">
                                <span class="tag {webhook.enabled ? 'success' : ''}">
                                    {webhook.enabled ? '有効' : '無効'}
                                </span>
                                <span class="url mono tiny">{webhook.url}</span>
                            </div>
                            <div class="small">
                                <span class="muted">送る通知:</span>
                                {webhook.events.length === 0
                                    ? 'すべて'
                                    : webhook.events.map((e) => EVENT_LABEL[e] ?? e).join(', ')}
                            </div>
                            <div class="small">
                                <span class="muted">直近の結果:</span>
                                {#if webhook.last_sent_at}
                                    <span class={webhook.last_status === 'ok' ? '' : 'text-error'}>
                                        {webhook.last_status}
                                    </span>
                                    <span class="muted tiny">
                                        {dateTime(webhook.last_sent_at)}
                                    </span>
                                {:else}
                                    <span class="muted">未送信</span>
                                {/if}
                            </div>
                            <div class="cluster">
                                <form method="POST" action="?/testWebhook" use:submitting>
                                    <input type="hidden" name="id" value={webhook.id} />
                                    <button type="submit" class="xs secondary" data-testid="webhook-test">テスト送信</button>
                                </form>
                                <form method="POST" action="?/toggleWebhook" use:submitting>
                                    <input type="hidden" name="id" value={webhook.id} />
                                    <button type="submit" class="xs secondary" data-testid="webhook-toggle">
                                        {webhook.enabled ? '無効化' : '有効化'}
                                    </button>
                                </form>
                                <form method="POST" action="?/deleteWebhook" use:submitting>
                                    <input type="hidden" name="id" value={webhook.id} />
                                    <button type="submit" class="xs outline danger" data-testid="webhook-delete">
                                        削除
                                    </button>
                                </form>
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}
        </section>
    </div>

    <div class="column">
        <!--
            **データ放送に渡すもの。** いまは郵便番号だけ。

            テレビの初期設定で必ず訊かれるあれで、放送のアプリはこれを読んで
            天気・地域のニュース・防災情報をどこのものにするかを決める。
            受け取るのは端末の中 (NVRAM = localStorage) だが、置き場をここに
            してあるのは**端末ごとに訊き直さずに済ませる**ため
        -->
        <section class="panel card">
            <h2>データ放送</h2>
            <p class="small lead">
                テレビの初期設定で入れる郵便番号です。データ放送 (d ボタン) の
                <strong>天気・地域のニュース・防災情報</strong>は、これで地域が決まります。
                未設定だと「郵便番号が正しく設定されていません」と表示され、その欄は空のままです。
            </p>
            <form method="POST" action="?/saveBroadcast" use:submitting={keepValues} class="wrap-form">
                <label class="field">
                    <span class="label">郵便番号</span>
                    <input
                        name="postalCode"
                        value={data.broadcast.postalCode}
                        class="mono w-postal"
                        placeholder="1000001"
                        inputmode="numeric"
                        data-testid="postal-code"
                    />
                </label>
                <!-- **空にできる。** 空は「渡さない」という選び方で、危なくない -->
                <span class="hint full">数字7桁 (ハイフンは有っても無くても可)。空にすると設定しません</span>

                <!--
                    **双方向。既定は切。**

                    入れると denpa のサーバが放送局のサーバへ代理で取りに
                    行きます。何に繋いでよいかの決め方 (公開の相手・http/https・
                    GET と POST) は `server/bml-network.ts` に書いてあります。
                    切っている間は「インターネットに接続されていません」と
                    放送側が案内します — **それは事実の通りなので、
                    黙って入れない**
                -->
                <label class="check-row full">
                    <input
                        type="checkbox"
                        name="bmlNetwork"
                        checked={data.broadcast.bmlNetwork}
                        data-testid="bml-network"
                    />
                    <span class="small">
                        双方向 (通信系コンテンツ) を使う
                        <span class="hint">
                            オンにすると、denpa が<strong>放送局のサーバと代わりに通信します</strong> (受信も送信も)。
                            番組の応募や投票もそのまま送られます。オフのときは、放送側に
                            「インターネットに接続されていません」と表示されます
                        </span>
                    </span>
                </label>

                <div class="full">
                    <button type="submit" data-testid="save-broadcast">保存</button>
                </div>
            </form>
        </section>

        <!--
            **テレビの VLC で再生。** VLC for Android (3.6+) のリモートアクセスへ、
            **画面を開いている端末が** URL を投げて再生させる (server/vlc.ts は
            一覧を持つだけ)。相手の居場所だけここで決め、
            ペアリング (テレビに出る6桁のコード) は録画詳細の「テレビで再生」を
            初めて押したときにその場でやる
        -->
        <section class="panel card" data-testid="vlc-card">
            <h2>テレビで再生 (VLC)</h2>
            <p class="small lead">
                テレビの VLC の「リモートアクセス」を使い、<strong>いま開いている端末から</strong>録画を
                テレビで再生します。VLC で <strong>その他 → リモートアクセス</strong> を有効にして、ここに
                テレビを登録すると、録画詳細に「テレビで再生」が出ます。初回だけ
                VLC のペア設定が開きます。セキュアな接続 (自己署名の証明書) を受け入れ、
                テレビに出る6桁のコードを入れれば、次からはそのまま再生できます。
                AV1 を再生できないテレビは、コーデックを H.264 か生TSにすると、
                そのテレビにだけ別のファイルを渡します。
            </p>
            <form method="POST" action="?/saveVlc" use:submitting={keepValues} class="stack">
                {#each tvRows as row (row)}
                    <div class="tv-row">
                        <input
                            name="vlcName"
                            bind:value={row.name}
                            class="w-name"
                            placeholder="名前 (例 リビング)"
                            data-testid="vlc-name"
                        />
                        <input
                            name="vlcIp"
                            bind:value={row.ip}
                            class="mono w-ip"
                            placeholder="IP (例 192.168.10.20)"
                            data-testid="vlc-ip"
                        />
                        <input
                            name="vlcPort"
                            bind:value={row.port}
                            class="mono w-port"
                            placeholder="8080"
                            data-testid="vlc-port"
                        />
                        <!--
                            そのテレビに渡すファイル。おまかせ (今いいほう) が既定で、
                            AV1 を解けないテレビは H.264、エンコード済み自体が重い
                            テレビは生TS。無い形式を選んでいたら、おまかせに落ちる
                        -->
                        <select name="vlcCodec" bind:value={row.codec} data-testid="vlc-codec">
                            <option value="auto">おまかせ</option>
                            <option value="h264">H.264</option>
                            <option value="ts">生TS</option>
                        </select>
                        <button
                            type="button"
                            class="small ghost"
                            onclick={() => tvRows.splice(tvRows.indexOf(row), 1)}
                            data-testid="vlc-remove"
                        >
                            外す
                        </button>
                    </div>
                {:else}
                    <p class="small muted">まだテレビがありません</p>
                {/each}
                <span class="hint">
                    名前が空ならボタンに IP を表示します。
                    ポートが空なら VLC の既定 (8080) を使います
                </span>
                <div class="cluster">
                    <button
                        type="button"
                        class="secondary"
                        onclick={() => tvRows.push({ name: '', ip: '', port: '8080', codec: 'auto' })}
                        data-testid="vlc-add"
                    >
                        テレビを追加
                    </button>
                    <button type="submit" data-testid="save-vlc">保存</button>
                </div>
            </form>
        </section>

        <section class="panel card">
            <h2>EPGStation からの引き継ぎ</h2>
            <p class="small lead">
                EPGStation のデータベースから、<strong>ルール・手動予約・録画</strong>を
                取り込みます。録画は denpa
                のフォルダ構成に置き直し、番組情報とサムネイルも作ります。何度実行しても、取り込み済みのものは飛ばします。
                ルールによる予約は、取り込んだルールから denpa が作り直します。
            </p>

            {#if !data.migrate.available}
                <div class="notice warning" data-testid="migrate-unavailable">
                    引き継ぎ元 <code>{data.migrate.source}</code> が見つかりません。denpa の Pod に EPGStation の録画PVCをマウントしてください。
                </div>
            {:else}
                <form method="POST" action="?/migrate" use:submitting class="stack">
                    {@render checkRow(
                        'apply',
                        false,
                        'migrate-apply',
                        '取り込む',
                        '外したままだと、何が取り込まれるかを表示するだけで、ファイルにもデータベースにも触りません',
                    )}
                    {@render checkRow(
                        'move',
                        false,
                        'migrate-move',
                        'コピーではなく移動する',
                        '既定はコピーです。中身を確かめてから EPGStation 側を消せます。空き容量が足りないときだけ移動にしてください',
                    )}
                    <div>
                        <button type="submit" disabled={migrate.state === 'running'} data-testid="migrate-run">
                            {migrate.state === 'running' ? '実行中…' : '実行する'}
                        </button>
                    </div>
                </form>
            {/if}

            {#if migrate.state !== 'idle'}
                <div class="progress-block" data-testid="migrate-progress" data-state={migrate.state}>
                    <div class="cluster small">
                        <span class="tag" data-testid="migrate-state">
                            {stateLabel(migrate.state)}
                        </span>
                        <span class="tag outline">{migrate.apply ? '取り込み' : '下見 (変更なし)'}</span>
                        {#if migrate.move}
                            <span class="tag outline">移動</span>
                        {/if}
                        <span>
                            新規 {migrate.imported} 件 / 取り込み済み {migrate.skipped} 件 / ファイル無し {migrate.missing}
                            件
                        </span>
                        <span>
                            ルール {migrate.rules.imported} 件 / 対象外 {migrate.rules.skipped} 件
                        </span>
                        <span>
                            予約 {migrate.reservations.imported} 件 / 対象外 {migrate.reservations.skipped} 件
                        </span>
                    </div>

                    {#if migrate.total > 0}
                        <progress value={done} max={migrate.total}></progress>
                        <div class="hint">
                            {done} / {migrate.total}
                            {#if migrate.current}— {migrate.current}{/if}
                        </div>
                    {/if}

                    {#if migrate.error}
                        <div class="notice error" data-testid="migrate-error">{migrate.error}</div>
                    {/if}

                    {#if migrate.log.length > 0}
                        <details class="log">
                            <summary class="small bold">
                                ログ ({migrate.log.length} 行)
                            </summary>
                            <pre data-testid="migrate-log">{migrate.log.join('\n')}</pre>
                        </details>
                    {/if}
                </div>
            {/if}
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
        <!--
            **ライブを生で見る** (docs/stream.md §5.5)。端末ごとの設定で既定は切。
            サーバに置かないのは、決め手が端末の側 (解ける CPU があるか・電池か) にあるため
        -->
        <section class="panel card" data-testid="raw-card">
            <h2>ライブを生で見る</h2>
            <p class="small lead">
                サーバで焼かずに、放送そのまま (MPEG-2) をこの端末で解きます。<strong>この端末だけ</strong>の設定です。
            </p>

            <label class="check">
                <input
                    type="checkbox"
                    role="switch"
                    aria-checked={rawSetting.on}
                    checked={rawSetting.on}
                    onchange={(event) => rawSetting.set(event.currentTarget.checked)}
                    data-testid="raw-toggle"
                />
                <span>家の中 (LAN) では生で見る</span>
            </label>

            <p class="hint">
                焼くのに掛かっていた 0.5〜1 秒が縮み、サーバはほとんど働かなくなります。そのかわり
                <strong>1局 15〜17 Mbit/s</strong> がずっと流れ、この端末が MPEG-2 を解きます (電池を使います)。
                止めて再開すると放送の今からになり、5分戻ったり追っかけの速さを選んだりはできません。
                家の外からや、解くのが間に合わないときは、いつもの焼いたものに自動で戻ります。
            </p>
            {#if rawProblem}
                <p class="hint" data-testid="raw-unsupported">この端末では使えません: {rawProblem}</p>
            {/if}
        </section>

        <section class="panel card">
            <h2>画面の高さを見る</h2>
            <p class="small lead">
                右下に、その端末での高さを出します。<strong>この端末だけ</strong>の設定で、
                サーバにも他の端末にも伝わりません。
            </p>

            <label class="check">
                <input
                    type="checkbox"
                    role="switch"
                    aria-checked={measure.on}
                    checked={measure.on}
                    onchange={(event) => measure.set(event.currentTarget.checked)}
                    data-testid="measure-toggle"
                />
                <span>高さの表示を出す</span>
            </label>

            <p class="hint">
                出るのは「窓 / 枠 / 中身 = はみ出し」「dvh / svh / lvh / vh の実測」と、
                <strong>はみ出している要素</strong>。はみ出しが 0 でなければページごと動きます。
                単位の4つが同じ数なら、食い違いが原因ではありません。
            </p>
        </section>
    </div>
</div>

<style>
    .columns {
        display: grid;
        align-items: start;
        gap: 1.5rem;
    }
    @media (min-width: 1280px) {
        .columns {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
    }
    .column {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 1.5rem;
    }
    .card {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 1.5rem;
        box-shadow: 0 1px 3px rgb(0 0 0 / 0.2);
    }
    .card h2 {
        font-size: 1.15rem;
    }
    .lead {
        opacity: 0.7;
    }
    .label {
        font-size: 0.875rem;
        font-weight: 500;
    }
    .hint {
        display: block;
        font-size: 0.75rem;
        opacity: 0.6;
    }
    .mono {
        font-family: var(--pico-font-family-monospace);
    }
    .two-col {
        display: grid;
        gap: 1rem;
    }
    @media (min-width: 640px) {
        .two-col {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .span-2 {
            grid-column: span 2;
        }
        .self-center {
            align-self: center;
        }
    }
    .check-row {
        display: flex;
        cursor: pointer;
        align-items: flex-start;
        gap: 0.5rem;
    }
    .check-row input {
        margin: 0.15rem 0 0;
        flex-shrink: 0;
    }
    fieldset.field {
        border: 0;
        padding: 0;
    }
    .rows > .row + .row {
        border-top: 1px solid var(--dp-base-300);
    }
    .rows {
        margin-top: 0.5rem;
    }
    .device {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding-block: 0.5rem;
    }
    .kind-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.25rem 0.75rem;
    }
    .kind {
        width: 5rem;
    }
    .unusable {
        cursor: not-allowed;
        opacity: 0.5;
    }
    .actions {
        margin-top: 0.5rem;
    }
    .events {
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        margin-top: 0.25rem;
    }
    .webhooks {
        margin-top: 1rem;
    }
    .webhook {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding-block: 0.75rem;
    }
    .url-line {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }
    .url-line .tag {
        flex-shrink: 0;
    }
    .url {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .wrap-form {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: 0.75rem;
    }
    .wrap-form .full {
        flex-basis: 100%;
    }
    .w-postal {
        width: 10rem;
    }
    .tv-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
    }
    .tv-row select {
        width: auto;
    }
    .tv-row input.w-name {
        width: 10rem;
    }
    .tv-row input.w-ip {
        width: 11rem;
    }
    .tv-row input.w-port {
        width: 6rem;
    }
    .progress-block {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        margin-top: 1rem;
    }
    .log {
        border: 1px solid var(--dp-base-300);
        border-radius: 1rem;
    }
    .log summary {
        cursor: pointer;
        padding: 0.5rem 1rem;
    }
    .log pre {
        max-height: 16rem;
        overflow: auto;
        margin: 0;
        padding: 0 1rem 0.75rem;
        font-size: 0.75rem;
    }
</style>
