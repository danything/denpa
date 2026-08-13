<script lang="ts">
    import { untrack } from 'svelte';
    import { submitting } from '$lib/actions';
    import Toasts, { errorNotice, type Notice } from '$lib/components/Toasts.svelte';
    import { dateTime } from '$lib/format';
    import { liveUpdates } from '$lib/live-updates.svelte';
    import { measure } from '$lib/measure.svelte';
    import { EVENT_LABEL } from '$lib/webhook-events';

    let { data, form } = $props();

    liveUpdates(['migrate']);

    const migrate = $derived(data.migrate.status);
    const done = $derived(migrate.imported + migrate.skipped + migrate.missing);

    /** 押した結果。引き継ぎの進み具合そのものは、そのカードの中に出したままにする */
    const notices = $derived.by(() => {
        const list: Notice[] = [];
        if (form?.migrate) list.push({ key: 'migrate-started', kind: 'info', text: form.migrate });
        list.push(...errorNotice(form, 'settings-error'));
        if (form?.saved) list.push({ key: 'saved-result', kind: 'success', text: '保存しました。' });
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
    let password = $state('');
    let revealed = $state(false);
    let copied = $state(false);
    // untrack は「初期値としてだけ読む」印。下の $effect で追従させている
    let recording = $state(untrack(() => ({ ...data.recording })));

    $effect(() => {
        password = data.auth.password;
    });
    $effect(() => {
        recording = { ...data.recording };
    });

    async function copy(): Promise<void> {
        try {
            await navigator.clipboard.writeText(password);
            copied = true;
            setTimeout(() => (copied = false), 2000);
        } catch {
            // 平文の http では clipboard API が使えない。そのときは表示して手で選んでもらう
            revealed = true;
        }
    }
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
                    use:submitting
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
                                1本の録画を両方で焼きます (再生・ダウンロードは既定で AV1、
                                テレビからは H.264 を選べます)
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
                                ロゴまで見る (確か・遅い)
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
                        <span class="text-sm font-medium">ロゴの当てにしかた</span>
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
                            ロゴは合っているのにCMを取り違えるなら上げ、覚えたロゴが怪しいなら下げます
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
                        '同じ絵が並ぶ素材 (アニメなど) を 30コマで焼き、時間とサイズを半分にします。外すと全部 60コマで焼きます',
                    )}
                    {@render checkRow(
                        'freeOnly',
                        recording.freeOnly,
                        'global-free-only',
                        '自動予約は無料放送だけにする',
                        '有料放送は契約していないと中身が入りません',
                        'sm:col-span-2',
                    )}
                    <div class="sm:col-span-2">
                        <button type="submit" class="btn btn-primary" data-testid="save-recording">保存</button>
                    </div>
                </form>
            </div>
        </section>
        <section class="card bg-base-100 shadow">
            <div class="card-body">
                <h2 class="card-title">通知</h2>
                <p class="text-base-content/70 text-sm">
                    録画の節目を外部に飛ばします。Discord や Slack の Incoming Webhook の URL
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
                        **折らずに、はみ出したぶんだけ横に流す。** 列が半分の
                        幅になったので、詰めさせると「送る通知」が1文字ずつ
                        縦に折れて読めなくなる (URL だけは `truncate` で止める)
                    -->
                    <div class="mt-4 overflow-x-auto">
                        <table class="table-zebra table whitespace-nowrap">
                            <thead>
                                <tr>
                                    <th>URL</th>
                                    <th>送る通知</th>
                                    <th>直近の結果</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody data-testid="webhook-list">
                                {#each data.webhooks as webhook (webhook.id)}
                                    <tr data-testid="webhook-row" data-webhook-id={webhook.id}>
                                        <td class="max-w-md">
                                            <div class="truncate font-mono text-xs">{webhook.url}</div>
                                            <span
                                                class="badge badge-sm {webhook.enabled
                                                    ? 'badge-success'
                                                    : 'badge-ghost'}"
                                            >
                                                {webhook.enabled ? '有効' : '無効'}
                                            </span>
                                        </td>
                                        <td class="text-sm">
                                            {JSON.parse(webhook.events).length === 0
                                                ? 'すべて'
                                                : JSON.parse(webhook.events)
                                                      .map((e: string) => EVENT_LABEL[e] ?? e)
                                                      .join(', ')}
                                        </td>
                                        <td class="text-sm">
                                            {#if webhook.last_sent_at}
                                                <span class={webhook.last_status === 'ok' ? '' : 'text-error'}>
                                                    {webhook.last_status}
                                                </span>
                                                <span class="text-base-content/60 block text-xs">
                                                    {dateTime(webhook.last_sent_at)}
                                                </span>
                                            {:else}
                                                <span class="text-base-content/60">未送信</span>
                                            {/if}
                                        </td>
                                        <td class="flex flex-wrap gap-2">
                                            <form method="POST" action="?/testWebhook" use:submitting>
                                                <input type="hidden" name="id" value={webhook.id} />
                                                <button type="submit" class="btn btn-xs" data-testid="webhook-test"
                                                    >テスト送信</button
                                                >
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
                                        </td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                {/if}
            </div>
        </section>
    </div>

    <div class="flex min-w-0 flex-col gap-6">
        <section class="card bg-base-100 shadow">
            <div class="card-body">
                <h2 class="card-title">ベーシック認証</h2>
                <p class="text-base-content/70 text-sm">
                    プレイヤーは、画面の前段に置くリダイレクト型の認証を扱えません。
                    プレイヤーが録画を取りに来る口は、これで守ります。
                    <strong>起動時に無ければ作る</strong>ので、常に掛かっています。
                </p>
                <form method="POST" action="?/saveAuth" use:submitting class="grid gap-4 sm:grid-cols-3">
                    <div class="flex flex-col gap-1">
                        <span class="text-sm font-medium">ユーザー名</span>
                        <!--
                            変えられるようにしていたが、変えて嬉しいことが無い。
                            プレイヤー側にも同じものを入れる必要があるだけで、
                            忘れると全部の端末がつながらなくなる。denpa で固定する
                        -->
                        <div
                            class="input input-bordered flex w-full items-center font-mono"
                            data-testid="auth-user"
                        >
                            denpa
                        </div>
                        <span class="text-base-content/60 text-xs">固定です</span>
                    </div>
                    <!--
                        **2列ぶん取る。** 適用範囲の選択を消したときに3列目が空いて、
                        ユーザー名の右に何も無い隙間ができていた。24文字が入る欄なので、
                        広げるほうが読みやすくもなる
                    -->
                    <label class="flex flex-col gap-1 sm:col-span-2">
                        <span class="text-sm font-medium">パスワード</span>
                        <!--
                            いま入っているものを出す。プレイヤーに登録するときに要るのに
                            隠していると、思い出せないたびに作り直すことになり、
                            そのたびに登録済みの端末が全部つながらなくなる
                        -->
                        <div class="join w-full">
                            <input
                                type={revealed ? 'text' : 'password'}
                                name="basicAuthPassword"
                                class="input input-bordered join-item w-full font-mono"
                                bind:value={password}
                                data-testid="auth-password"
                            />
                            <button
                                type="button"
                                class="btn join-item"
                                onclick={() => (revealed = !revealed)}
                                data-testid="auth-reveal"
                                title={revealed ? '隠す' : '表示する'}
                            >
                                {revealed ? '🙈' : '👁'}
                            </button>
                        </div>
                        <div class="flex flex-wrap gap-2">
                            <!--
                                作って保存まで1回で済ませる。考えて入れるものではないし、
                                入れたものを保存し忘れると、そのつもりで居るのに掛かっていない
                            -->
                            <button type="submit"
                                class="btn btn-xs"
                                formaction="?/newPassword"
                                title={data.auth.oidc
                                    ? '作り直すと、登録済みのプレイヤーは入れ直しが要ります'
                                    : '作り直すと、この画面もいったん入れなくなります (新しいものは起動ログにも出ます)'}
                                data-testid="auth-generate"
                            >
                                作り直して保存
                            </button>
                            <button
                                type="button"
                                class="btn btn-xs"
                                onclick={copy}
                                disabled={password === ''}
                                data-testid="auth-copy"
                            >
                                {copied ? 'コピーしました' : 'コピー'}
                            </button>
                        </div>
                    </label>
                    <!--
                        **適用範囲は選ばせない。** 以前は「配信と WebDAV だけ / 画面も
                        含めて全部」を選べたが、既定のままだと画面が誰にでも開き、
                        しかも掛かっているつもりでいられた
                    -->
                    <div class="sm:col-span-3">
                        <div class="alert alert-info mb-3" data-testid="auth-scope-note">
                            {#if data.auth.oidc}
                                <span>
                                    <strong>画面は OIDC で守っています。</strong>
                                    ベーシック認証が効くのは、プレイヤーが録画を取りに来る口 (<code
                                        >/api/recordings/…/file</code
                                    >
                                    と <code>/dav</code>) です — リダイレクトを扱えないため。
                                </span>
                            {:else}
                                <span>
                                    <strong>画面も配信も WebDAV も、まとめて守ります。</strong>
                                    範囲は選べません。画面だけ外すと、再生リンクのURLに埋めた パスワードが誰にでも見えてしまいます。
                                </span>
                            {/if}
                        </div>
                        <button type="submit" class="btn btn-primary" data-testid="save-auth">保存</button>
                    </div>
                </form>
            </div>
        </section>

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
                    テレビの初期設定で訊かれる郵便番号です。データ放送 (d ボタン) の
                    <strong>天気・地域のニュース・防災情報</strong>は、これでどこの分を出すかが決まります。
                    入れていないと「郵便番号が正しく設定されていません」と出て、その欄が空のままになります。
                </p>
                <form method="POST" action="?/saveBroadcast" use:submitting class="flex flex-wrap items-end gap-3">
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
                                入れると、この denpa が<strong>放送局のサーバへ代理で取りに行き、送りもします</strong>。
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
                        引き継ぎ元 <code>{data.migrate.source}</code> が見えません。 denpa の Pod に EPGStation の録画PVCをマウントしてください。
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
                            <span class="badge badge-ghost">{migrate.apply ? '取り込み' : '下見'}</span>
                            {#if migrate.move}
                                <span class="badge badge-ghost">移動</span>
                            {/if}
                            <span data-testid="migrate-counts">
                                録画 {migrate.imported} 件 / 取り込み済み {migrate.skipped} 件 / ファイル無し {migrate.missing}
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
                                    記録 ({migrate.log.length} 行)
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
                    <span class="label-text">高さの札を出す</span>
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
