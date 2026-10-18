<script lang="ts">
    import { onMount } from 'svelte';
    import { submitting } from '#lib/actions.js';
    import { arming } from '#lib/arming.svelte.js';
    import { autosave, SaveState } from '#lib/autosave.svelte.js';
    import { canvasVideo, chooseCanvas, seeDriveNotice, teslaBrowser } from '#lib/canvas-video.js';
    import ActionButton from '#lib/components/ActionButton.svelte';
    import ArmedDelete from '#lib/components/ArmedDelete.svelte';
    import DriveNotice from '#lib/components/DriveNotice.svelte';
    import JobProgress from '#lib/components/JobProgress.svelte';
    import Lead from '#lib/components/Lead.svelte';
    import SaveNote from '#lib/components/SaveNote.svelte';
    import Toasts, { errorNotice, type Notice } from '#lib/components/Toasts.svelte';
    import { dateTime, stateLabel } from '#lib/format.js';
    import { CODEC_LABEL, HW_EVERY, HW_SOFTWARE, hwChoice, hwUsable } from '#lib/hw.js';
    import { liveUpdates } from '#lib/live-updates.svelte.js';
    import { measure } from '#lib/measure.svelte.js';
    import { PREFECTURE_UNSET, PREFECTURES } from '#lib/prefecture.js';
    import { type CanvasSupport, canvasSupport } from '#lib/raw/support.js';
    import { EVENT_LABEL } from '#lib/webhook-events.js';
    import type { SubmitFunction } from '$app/forms';

    let { data, form } = $props();

    liveUpdates(['migrate']);

    const migrate = $derived(data.migrate.status);
    const done = $derived(migrate.imported + migrate.skipped + migrate.missing);

    /**
     * 押した結果。引き継ぎの進み具合そのものは、その節の中に出したままにする。
     * **その場で保存した結果はここに出さない** — 変えた欄の近く (節の見出しの横。`SaveNote`) に出す
     */
    const notices = $derived.by(() => {
        const list: Notice[] = [];
        if (form?.migrate) list.push({ key: 'migrate-started', kind: 'info', text: form.migrate });
        list.push(...errorNotice(form, 'settings-error'));
        if (form?.probed) list.push({ key: 'hw-probed', kind: 'success', text: 'GPU を確かめ直しました' });
        if (form?.webhookAdded) list.push({ key: 'webhook-added', kind: 'success', text: '通知先を追加しました' });
        if (form?.tested) {
            list.push({
                key: 'webhook-tested',
                kind: form.tested === 'ok' ? 'success' : 'error',
                // 届いたら `ok` が返る (`server/webhook.ts`)。英語のまま出さない
                text: form.tested === 'ok' ? 'テスト送信が届きました' : `テスト送信に失敗しました: ${form.tested}`,
            });
        }
        return list;
    });

    /**
     * 録画設定のフォームは bind せず `checked` / `selected` で初期値だけ渡す。
     * 別のフォームを保存して data が読み直されても、値が同じなら Svelte は DOM に
     * 書かない — 手元で変えたまま保存していない入力はそのまま残る
     */
    const recording = $derived(data.recording);

    /** 映像コーデックの行。並びは HW_CODECS と同じ (AV1 が先) */
    const CODECS = [
        { codec: 'av1', label: 'AV1 (小さい・遅い)' },
        { codec: 'h264', label: 'H.264 (古いテレビ向け・大きい)' },
    ] as const;

    /** 節ごとの保存の結果 (`autosave`)。見出しの横に出す */
    const saves = {
        recording: new SaveState(),
        broadcast: new SaveState(),
    };

    /**
     * 「今の値を編集する」フォームは、保存してもフォームを reset させない。
     *
     * enhance の既定は成功後に `form.reset()` — 入力欄がデフォルト (空) に戻る。
     * 今の値を見せている欄が、**何も変えずに保存しただけで空に見える**。
     * 空にしたいのは追加系 (Webhook) だけ
     */
    const keepValues: SubmitFunction = () => async (options) => {
        await options.update({ reset: false });
    };

    /** 通知先の削除は2回押させる (録画・ルールと同じ。[arming.svelte.ts](../../lib/arming.svelte.ts)) */
    const deleting = arming('[data-testid^="webhook-delete"]');

    /*
     * **互換モード** (動画を canvas に描く。`canvas-video.ts`)。端末ごとの設定なので、読むのは画面に
     * 出てから (localStorage・UA・VideoDecoder はサーバでは読めない)
     */
    let compat = $state(false);
    let tesla = $state(false);
    let support = $state<CanvasSupport | null>(null);
    /** 入れようとしている (運転中の注意を出している) */
    let confirming = $state(false);
    onMount(() => {
        compat = canvasVideo();
        tesla = teslaBrowser();
        void canvasSupport().then((found) => (support = found));
    });

    /** 入れるときは運転中の注意を先に出し、「わかりました」で入れる。切るのはその場で */
    function setCompat(on: boolean): void {
        if (on) {
            confirming = true;
            return;
        }
        chooseCanvas(false);
        compat = false;
    }

    function acceptCompat(): void {
        seeDriveNotice();
        chooseCanvas(true);
        compat = true;
        confirming = false;
    }
</script>

<svelte:window onclick={deleting.stand} />

{#snippet checkRow(name: string, checked: boolean, testid: string, title: string, hint: string, detail: string = '')}
    <!--
        チェック + 見出し + 1行の要点。この画面の決まりの形。
        要点と「詳しく」は label の外に置く — label の中に開け閉めを入れると、
        「詳しく」を押したつもりでチェックまで切り替わりかねない
    -->
    <div class="check-item">
        <label class="check-row">
            <input type="checkbox" {name} {checked} data-testid={testid} />
            <span>{title}</span>
        </label>
        {#if detail === ''}
            <Lead class="indent">{hint}</Lead>
        {:else}
            <Lead class="indent">
                {hint}
                {#snippet more()}
                    <p>{detail}</p>
                {/snippet}
            </Lead>
        {/if}
    </div>
{/snippet}

<Toasts {notices} source={form} />

<!--
    **1 列に、読みやすい幅で並べる。** 広い画面で 2 列に積んでいた頃は、目が左右を
    行き来して、どこまで読んだのか分からなくなった。サイドバーは作らない (押すものが増える)。
    節は枠で囲まず、見出しと細い線で区切る。よく使う節を上に、たまにしか触らない節は「その他」の下に
-->
<div class="settings">
    <section class="setting">
        <div class="setting-head">
            <h2>録画のしかた</h2>
            <SaveNote status={saves.recording} />
        </div>
        <Lead>すべての録画に効きます。ルールや予約ごとには変えられません</Lead>
        <!--
            **変えたらその場で保存する** (`autosave`)。保存のボタンは置かない。
            値は bind せず `checked` / `selected` で渡す (保存して読み直しても、同じ値なら DOM に書かない)
        -->
        <form method="POST" action="?/saveRecording" use:autosave={saves.recording} class="fields setting-rows">
            <!--
                **コーデックごとに、エンコーダ (ソフトウェア・GPU) を横に置く。** 選べるのは、そのコーデックを
                GPU でエンコードできるデバイスがあるときだけ。持ち方はデバイス × 方式 × コーデックのまま
                (`chooseHw`)。チェックを外したコーデックも、ライブと追っかけはこのエンコーダを使うので、
                選ぶ欄はチェックと関係なく出しておく
            -->
            <fieldset class="field">
                <span class="field-label">映像コーデック</span>
                <div class="codecs">
                    {#each CODECS as { codec, label } (codec)}
                        <div class="codec-row">
                            <label class="check">
                                <input
                                    type="checkbox"
                                    name="codecs"
                                    value={codec}
                                    checked={recording.codecs.includes(codec)}
                                    data-testid={`codec-${codec}`}
                                />
                                <span>{label}</span>
                            </label>
                            {#await data.hw then hw}
                                {@const usable = hwUsable(hw.devices, codec)}
                                {@const choice = hwChoice(recording.hwAllow, hw.devices, codec)}
                                {#if usable.length > 0}
                                    <select
                                        name={`hw.${codec}`}
                                        class="encoder"
                                        aria-label={`${CODEC_LABEL[codec]} のエンコーダ`}
                                        data-testid={`hw-${codec}`}
                                    >
                                        <option value={HW_SOFTWARE} selected={choice === HW_SOFTWARE}>ソフトウェア</option>
                                        {#each usable as device (device.path)}
                                            <option value={device.path} selected={choice === device.path}>{device.label}</option>
                                        {/each}
                                        {#if usable.length > 1}
                                            <option value={HW_EVERY} selected={choice === HW_EVERY}>GPU を順番に使う</option>
                                        {/if}
                                    </select>
                                {:else if hw.devices.length > 0}
                                    <span class="hint">ソフトウェア</span>
                                {/if}
                            {/await}
                        </div>
                    {/each}
                </div>
                <!-- 列の右側 (欄の下) に置くため、要点の行は div で包む -->
                <div class="hw-line">
                    {#await data.hw}
                        <span class="hint" data-testid="hw-status">GPU を確認中…</span>
                    {:then hw}
                        <Lead>
                            <span data-testid="hw-status">{hw.message}</span>
                            <!--
                                一度だけの操作なので、その場で保存する欄とは別のフォーム (下の `probe-hw`) で送る。
                                `form` で指すので、この節の保存には混ざらない
                            -->
                            <button type="submit" form="probe-hw" class="text-button" data-testid="hw-probe">確かめ直す</button>
                            {#snippet more()}
                                <p>使える GPU は Intel QSV / VA-API です。見つかれば自動で使います。</p>
                                <p>QSV → VA-API → ソフトウェアの順に試し、失敗したら次の方法でやり直します。</p>
                                <p>
                                    ライブと追っかけも、ここで選んだエンコーダを使います (チェックを外したコーデックも)。MPEG-2
                                    のデコードまで GPU でできるデバイスでは、デコードとインターレース解除も GPU で行います。
                                </p>
                                <p>
                                    GPU が2枚あれば「AV1 はこちら、H.264 はあちら」のように分けられます。「GPU を順番に使う」では、
                                    エンコードのたびに使う GPU を入れ替えます。
                                </p>
                                {#each hw.devices as device (device.path)}
                                    <p data-testid="hw-device" data-device={device.path}>
                                        <span class="mono">{device.label}</span>: {device.summary}
                                    </p>
                                {/each}
                            {/snippet}
                        </Lead>
                    {/await}
                </div>
                {#if recording.codecs.length === 0}
                    <Lead>
                        選ばないと<strong>エンコードせず</strong>、元のTSのまま残します
                        {#snippet more()}
                            <p>CM のチャプターや字幕トラックも付きません。</p>
                        {/snippet}
                    </Lead>
                {:else if recording.codecs.length === 2}
                    <Lead>
                        1本の録画を両方でエンコードします
                        {#snippet more()}
                            <p>再生は既定で AV1 です。テレビごとの設定で H.264 を渡せます。</p>
                        {/snippet}
                    </Lead>
                {/if}
            </fieldset>
            <!--
                その場で変換する本数の上限 (`server/transcode.ts`)。既定が GPU の有無で変わるので、
                エンコーダのすぐ下に置く
            -->
            <div class="field">
                <span class="field-label">同時に変換する本数</span>
                <select name="transcodeLimit" class="narrow" aria-label="同時に変換する本数" data-testid="transcode-limit">
                    <option value="" selected={recording.transcodeLimit === null}>
                        自動 ({data.transcode.auto}本)
                    </option>
                    {#each data.transcode.choices as n (n)}
                        <option value={String(n)} selected={recording.transcodeLimit === n}>{n}本</option>
                    {/each}
                </select>
                <Lead>
                    録画を別の形式で再生するときと、追っかけ再生で使います。ライブは数えません
                    {#snippet more()}
                        <p>
                            自動では GPU が無ければ 2本、あれば 4本です。埋まっているときにリクエストされた再生は断り、
                            エンコード済みの動画か元のTSでの再生を勧めます。
                        </p>
                    {/snippet}
                </Lead>
            </div>
            <div class="field">
                <span class="field-label">元のTS</span>
                {@render checkRow(
                    'keepOriginal',
                    recording.keepOriginal,
                    'global-keep',
                    '元のTSも残す',
                    'エンコードしたあとも元のTSを消しません。容量を多く使います',
                )}
            </div>
            <label class="field">
                <span class="field-label">CM</span>
                <select name="cmCut" class="narrow" data-testid="global-cmcut">
                    <option value="chapter" selected={recording.cmCut === 'chapter'}>
                        チャプターを打つだけ (安全)
                    </option>
                    <option value="cut" selected={recording.cmCut === 'cut'}>切り取る</option>
                    <option value="off" selected={recording.cmCut === 'off'}>何もしない</option>
                </select>
                <span class="hint">局ロゴの消えている所をCMとみます。ロゴが使えなければ無音と長さで決めます</span>
            </label>
            <!--
                コマ数 (30/60) は本編映像から実測して決める (encoder.measureSmoothMotion)。
                放送は素材が何でも 1080i/60 で来るので、ジャンルにもTSのヘッダにも
                本当のコマ数は入っていない。60コマに起こして同じフレームが並ぶ割合を
                数えるのが唯一の見分け方だった (実測: アニメ 21〜55% / 生放送 71%)
            -->
            <div class="field">
                <span class="field-label">コマ数</span>
                {@render checkRow(
                    'fpsDetect',
                    recording.fpsDetect,
                    'global-fps-detect',
                    'コマ数を映像から決める',
                    'アニメなどは 30コマにして、時間とサイズを半分にします',
                    '同じコマが続く映像 (アニメなど) を見分けて 30コマでエンコードします。外すとすべて 60コマになります。',
                )}
            </div>
            <div class="field">
                <span class="field-label">自動予約</span>
                {@render checkRow(
                    'freeOnly',
                    recording.freeOnly,
                    'global-free-only',
                    '自動予約は無料放送だけにする',
                    '契約していない有料放送は、録画してもスクランブルのままで観られません',
                )}
            </div>
        </form>
        <!-- 「確かめ直す」が送るフォーム。ボタンは映像コーデックの下にあり、`form="probe-hw"` で指す -->
        <form id="probe-hw" method="POST" action="?/probeHw" use:submitting={keepValues} hidden></form>
    </section>

    <!--
        **データ放送に渡すもの。** 郵便番号と都道府県。
        テレビの初期設定で必ず訊かれるあれで、放送のアプリはこれを読んで
        天気・地域のニュース・防災情報をどこのものにするかを決める。
        置き場をサーバにしてあるのは**端末ごとに訊き直さずに済ませる**ため。
        郵便番号から都道府県を引くことはしない (表を抱えることになる)。並べて置いて、両方入れてもらう。
        郵便番号は欄を離れたとき・Enter で保存する (打っている途中では送らない)
    -->
    <section class="setting">
        <div class="setting-head">
            <h2>データ放送</h2>
            <SaveNote status={saves.broadcast} />
        </div>
        <Lead>
            データ放送 (d ボタン) の地域を、郵便番号と都道府県で決めます
            {#snippet more()}
                <p>
                    テレビの初期設定で入れる郵便番号と都道府県です。データ放送の
                    <strong>天気・地域のニュース・防災情報</strong>は、これで地域が決まります。
                </p>
                <p>郵便番号が未設定だと「郵便番号が正しく設定されていません」と表示され、その欄は空のままです。</p>
                <p>都道府県で地域の情報を出し分ける局もあります。</p>
            {/snippet}
        </Lead>
        <form method="POST" action="?/saveBroadcast" use:autosave={saves.broadcast} class="fields setting-rows">
            <div class="wrap-row">
                <label class="field">
                    <span class="field-label">郵便番号</span>
                    <input
                        name="postalCode"
                        value={data.broadcast.postalCode}
                        class="mono w-postal"
                        placeholder="1000001"
                        inputmode="numeric"
                        enterkeyhint="done"
                        data-testid="postal-code"
                    />
                </label>
                <!-- 値は ARIB の番号 (JIS の都道府県コードではない。`#lib/prefecture.ts`) -->
                <label class="field">
                    <span class="field-label">都道府県</span>
                    <select name="prefecture" data-testid="prefecture">
                        <option value={PREFECTURE_UNSET} selected={data.broadcast.prefecture === PREFECTURE_UNSET}>
                            未設定
                        </option>
                        {#each PREFECTURES as prefecture (prefecture.code)}
                            <option value={prefecture.code} selected={data.broadcast.prefecture === prefecture.code}>
                                {prefecture.name}
                            </option>
                        {/each}
                    </select>
                </label>
            </div>
            <!-- **空にできる。** 空は「渡さない」という選び方で、危なくない -->
            <span class="hint">郵便番号は数字7桁 (ハイフンは有っても無くても可)。空にすると設定しません</span>

            <!--
                **双方向。既定はオン** (テレビと同じく、データ放送の通信の項目が開く)。
                オンだと denpa のサーバが放送局のサーバと代わりに通信します。
                何に繋いでよいかの決め方は `server/bml-network.ts`。視聴の記録が送られうることは
                説明の1行目に出す (隠さない)
            -->
            <div class="check-item">
                <label class="check-row">
                    <input type="checkbox" name="bmlNetwork" checked={data.broadcast.bmlNetwork} data-testid="bml-network" />
                    <span>双方向 (通信系コンテンツ) を使う</span>
                </label>
                <Lead class="indent">
                    オンのときは放送局のサーバと通信し、<strong
                        >応募や投票、視聴の記録が放送局へ送られることがあります</strong
                    >
                    {#snippet more()}
                        <p>
                            オンにすると、denpa が放送局のサーバと代わりに通信します (受信も送信も)。
                            データ放送の通信の項目が開き、放送の画面から送る応募や投票、利用状況の調査
                            (どの番組のデータ放送を見たか) もそのまま送られます。
                        </p>
                        <p>オフのときは、放送側に「インターネットに接続されていません」と表示されます。</p>
                    {/snippet}
                </Lead>
            </div>
        </form>
    </section>

    <section class="setting">
        <div class="setting-head">
            <h2>通知</h2>
        </div>
        <Lead>
            録画の開始・完了・失敗などを外部に通知します
            {#snippet more()}
                <p>Discord や Slack の Incoming Webhook の URL をそのまま入れられます。</p>
                <p>録画の失敗は画面を開くまで気づけないので、せめて「録画失敗」は送っておくと安心です。</p>
            {/snippet}
        </Lead>

        <!-- 新しく足す操作なので「追加」のボタンのまま (その場では保存しない) -->
        <form method="POST" action="?/addWebhook" use:submitting class="fields setting-rows">
            <label class="field">
                <span class="field-label">URL</span>
                <input name="url" placeholder="https://..." data-testid="webhook-url" />
            </label>
            <div class="field">
                <span class="field-label">送る通知</span>
                <div class="events" data-testid="webhook-events">
                    {#each data.events as event (event)}
                        <label class="check">
                            <input type="checkbox" name="events" value={event} />
                            <span class="small">{EVENT_LABEL[event]}</span>
                        </label>
                    {/each}
                </div>
                <span class="hint">1つも選ばなければ全部送ります</span>
            </div>
            <div>
                <button type="submit" class="small" data-testid="webhook-add">追加</button>
            </div>
        </form>

        {#if data.webhooks.length > 0}
            <!--
                1件を URL・送る通知・直近の結果・ボタン の順に縦に積む。幅がいくらでも横には出ない
                (URL だけは `text-overflow: ellipsis` で止める)
            -->
            <div class="rows webhooks" data-testid="webhook-list">
                {#each data.webhooks as webhook (webhook.id)}
                    <div class="row webhook" data-testid="webhook-row" data-webhook-id={webhook.id}>
                        <div class="url-line">
                            <span class="tag {webhook.enabled ? 'success' : ''}">
                                {webhook.enabled ? '有効' : '無効'}
                            </span>
                            <span class="truncate mono tiny">{webhook.url}</span>
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
                                    {webhook.last_status === 'ok' ? '成功' : webhook.last_status}
                                </span>
                                <span class="muted tiny">
                                    {dateTime(webhook.last_sent_at)}
                                </span>
                            {:else}
                                <span class="muted">未送信</span>
                            {/if}
                        </div>
                        <div class="cluster row-actions">
                            <ActionButton action="?/testWebhook" fields={{ id: webhook.id }} class="small secondary" testid="webhook-test">
                                テスト送信
                            </ActionButton>
                            <ActionButton action="?/toggleWebhook" fields={{ id: webhook.id }} class="small secondary" testid="webhook-toggle">
                                {webhook.enabled ? '無効化' : '有効化'}
                            </ActionButton>
                            <!-- 押し間違い防止に2回押させる (録画・ルールの削除と同じ) -->
                            <ArmedDelete
                                {deleting}
                                armKey={webhook.id}
                                action="?/deleteWebhook"
                                fields={{ id: webhook.id }}
                                class="small"
                                testid="webhook-delete"
                            />
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
    </section>

    <!--
        テレビのアプリ (danything/denpa-tv) に渡したアクセストークン。家の外から OIDC 越しに使うテレビは
        QR でペアリングしてアクセストークンを持つ (信頼するネットワークの中なら要らない)。
        なくしたテレビ・手放したテレビはここで止める
    -->
    <section class="setting" data-testid="devices-card">
        <div class="setting-head">
            <h2>テレビのアプリ</h2>
        </div>
        <Lead>QR でペアリングしたテレビです。取り消すと、そのテレビはペアリングし直しになります</Lead>
        <!-- 使ってよいのは同じ世帯の中だけ (README「使ってよい範囲」・docs/auth.md) -->
        <Lead>ログインのアカウントもペアリングするテレビも、同じ世帯の人の分だけにしてください</Lead>
        {#if data.devices.length === 0}
            <p class="small muted">まだありません</p>
        {:else}
            <div class="rows" data-testid="device-list">
                {#each data.devices as device (device.id)}
                    <div class="row device device-line" data-testid="device-row">
                        <div class="grow">
                            <div class="small"><strong>{device.name}</strong></div>
                            <div class="tiny muted">
                                ペアリング {dateTime(device.created_at)} ・ 最後に使った
                                {device.last_used_at === null ? 'まだ' : dateTime(device.last_used_at)}
                            </div>
                        </div>
                        <div class="row-actions">
                            <ActionButton action="?/revokeDevice" fields={{ id: device.id }} class="small outline danger" testid="device-revoke">
                                取消
                            </ActionButton>
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
    </section>

    <!-- **たまにしか触らないもの。** 引っ越しのとき・端末の困りごとを調べるときだけ使う -->
    <h2 class="group-title">その他</h2>

    <section class="setting">
        <div class="setting-head">
            <h2>EPGStation からの引き継ぎ</h2>
        </div>
        <Lead>
            EPGStation から<strong>ルール・手動予約・録画</strong>を取り込みます
            {#snippet more()}
                <p>
                    EPGStation のデータベースから読みます。録画は denpa のフォルダ構成に置き直し、
                    番組情報とサムネイルも作ります。
                </p>
                <p>
                    何度実行しても、取り込み済みのものは飛ばします。ルールによる予約は、取り込んだルールから
                    denpa が作り直します。
                </p>
            {/snippet}
        </Lead>

        {#if !data.migrate.available}
            <div class="notice warning" data-testid="migrate-unavailable">
                引き継ぎ元 <code>{data.migrate.source}</code> が見つかりません。denpa の Pod に EPGStation の録画PVCをマウントしてください。
            </div>
        {:else}
            <!-- 実行の条件なので、変えても保存しない。「実行」で送る -->
            <form method="POST" action="?/migrate" use:submitting class="fields">
                {@render checkRow(
                    'apply',
                    false,
                    'migrate-apply',
                    '取り込む',
                    '外したままなら下見だけで、何も変えません',
                    '何が取り込まれるかを表示するだけで、ファイルにもデータベースにも触りません。',
                )}
                {@render checkRow(
                    'move',
                    false,
                    'migrate-move',
                    'コピーではなく移動する',
                    '空き容量が足りないときだけ移動にしてください',
                    '既定はコピーです。中身を確かめてから EPGStation 側を消せます。',
                )}
                <div>
                    <button type="submit" class="small" disabled={migrate.state === 'running'} data-testid="migrate-run">
                        {migrate.state === 'running' ? '実行中…' : '実行'}
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
                    <JobProgress {done} total={migrate.total}>
                        {#if migrate.current}— {migrate.current}{/if}
                    </JobProgress>
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
        **端末でしか出ない食い違いを、その端末で読むための入口。** 縦のはみ出しは、引っ込む
        アドレスバーや画面の切り欠きが絡むと**その端末でしか起きない**。入り口をここに置くのは、
        PWA にアドレスバーが無いため (`?measure` を打つところがない)
    -->
    <section class="setting">
        <div class="setting-head">
            <h2>画面の高さを見る</h2>
        </div>
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
        <Lead class="indent">
            右下に、この端末での画面の高さを出します
            {#snippet more()}
                <p><strong>この端末だけ</strong>の設定で、サーバにも他の端末にも伝わりません。</p>
                <p>
                    出るのは「窓 / 枠 / 中身 = はみ出し」「dvh / svh / lvh / vh の実測」と、
                    <strong>はみ出している要素</strong>。はみ出しが 0 でなければページごと動きます。
                    単位の4つが同じ数なら、食い違いが原因ではありません。
                </p>
            {/snippet}
        </Lead>
    </section>

    <!--
        **互換モード** (`canvas-video.ts`)。`<video>` の再生が止まる端末 (テスラの車載ブラウザ) のため、
        ライブ・追っかけ・録画の動画を canvas に描く。端末ごとの設定。
        入れるときは運転中の注意を出し、「わかりました」で入る (`DriveNotice`)。
        canvas・WebCodecs といった言葉は画面に出さない (docs/writing.md「画面の言葉」)
    -->
    <section class="setting" data-testid="canvas-video">
        <div class="setting-head">
            <h2>互換モードで再生</h2>
        </div>
        <label class="check">
            <input
                type="checkbox"
                role="switch"
                aria-checked={compat || confirming}
                checked={compat || confirming}
                onchange={(event) => setCompat(event.currentTarget.checked)}
                data-testid="canvas-video-toggle"
            />
            <span>互換モードで再生する</span>
        </label>
        <Lead class="indent">
            動画が止まってしまう端末 (テスラの車載ブラウザなど) 向け
            {#snippet more()}
                <p>
                    <strong>この端末だけ</strong>の設定で、サーバにも他の端末にも伝わりません。
                    テスラの車載ブラウザでは、触らなくても入っています。
                </p>
                <p>
                    ライブ・追っかけ再生・録画を、動画が止まりにくい方法で再生します。使えない画質は選べなくなります。
                    速さは変えられません。ライブはさかのぼって見ることができません。
                </p>
            {/snippet}
        </Lead>
        <ul class="support small" data-testid="canvas-video-support">
            <li>H.264: {support === null ? '確認中' : support.h264 ? '使えます' : '使えません'}</li>
            <li>AV1: {support === null ? '確認中' : support.av1 ? '使えます' : '使えません'}</li>
            <li>テスラの車載ブラウザ: {tesla ? 'はい' : 'いいえ'}</li>
        </ul>
    </section>
</div>

<DriveNotice open={confirming} onaccept={acceptCompat} oncancel={() => (confirming = false)} />

<style>
    /* **1 列・最大 720px で真ん中に。** 文の行が長すぎると読みにくく、2 列では目が左右に飛ぶ */
    .settings {
        display: flex;
        flex-direction: column;
        max-width: 45rem;
        margin-inline: auto;
    }
    /* 節は枠で囲まず、上の細い線で区切る (いちばん上と「その他」の直後は線を引かない) */
    .setting {
        display: flex;
        flex-direction: column;
        gap: var(--dp-space-3);
        padding-block: var(--dp-space-5);
        border-top: 1px solid var(--dp-line);
    }
    .setting:first-child,
    .group-title + .setting {
        padding-top: var(--dp-space-2);
        border-top: 0;
    }
    .setting-head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: var(--dp-space-1) var(--dp-space-3);
    }
    .setting-head h2 {
        font-size: var(--dp-text-lg);
    }
    /* 「その他」の見出し。節の見出しより控えめに、上に余白を取って下の群れを分ける */
    .group-title {
        margin-top: var(--dp-space-6);
        padding-bottom: var(--dp-space-2);
        border-bottom: 1px solid var(--dp-line);
        color: var(--dp-muted);
        font-size: var(--dp-text-sm);
        font-weight: var(--dp-weight-bold);
    }
    .fields {
        display: flex;
        flex-direction: column;
        gap: var(--dp-space-4);
    }
    .hint {
        display: block;
        font-size: var(--dp-text-sm);
        color: var(--dp-muted);
    }
    /* 選ぶ欄は中身の幅で足りる。横いっぱいに伸ばすと、どこまでが欄なのか読みにくい */
    .narrow {
        max-width: 20rem;
    }
    .wrap-row {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: var(--dp-space-3);
    }
    .w-postal {
        width: 10rem;
    }
    /* 互換モードで使えるもの。点は付けずに詰めて並べる */
    .support {
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .support li {
        margin: 0;
        list-style: none;
    }
    .check-item {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
    }
    /* チェックの下の要点と「詳しく」は、チェックの横の文に揃える (箱の幅 1.25rem + 間 0.5rem) */
    .setting :global(.lead.indent),
    .check-item :global(.more-body) {
        margin-inline-start: 1.75rem;
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
    .rows > .row + .row {
        border-top: 1px solid var(--dp-line);
    }
    .device {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding-block: 0.5rem;
    }
    .device-line {
        flex-direction: row;
        align-items: center;
        gap: var(--dp-space-3);
    }
    /*
     * **チェックと、その横のエンコーダ。** 広い幅ではエンコーダを縦に揃える (行ごとに字の長さが違うので、
     * 揃えないと欄が左右にずれる)。狭い幅ではチェックの文の下に、文の頭に揃えて置く
     */
    .codecs {
        display: flex;
        flex-direction: column;
        gap: var(--dp-space-2);
    }
    .codec-row {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.25rem;
    }
    .codec-row > :not(.check) {
        margin-inline-start: 1.75rem;
    }
    @media (min-width: 30rem) {
        .codecs {
            display: grid;
            grid-template-columns: max-content max-content;
            align-items: center;
            gap: var(--dp-space-2) var(--dp-space-3);
        }
        .codec-row {
            display: contents;
        }
        .codec-row > :not(.check) {
            margin-inline-start: 0;
        }
    }
    .encoder {
        width: auto;
        max-width: 100%;
        padding-block: 0.3rem;
        font-size: var(--dp-text-sm);
    }
    .hw-line {
        margin-top: 0.25rem;
    }
    /* 文の続きとして読める小さなボタン (Lead の「詳しく」と同じ見た目) */
    .text-button {
        display: inline;
        width: auto;
        margin: 0 0 0 0.25rem;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: none;
        box-shadow: none;
        color: var(--dp-muted);
        font: inherit;
        text-decoration: underline;
        text-decoration-color: var(--dp-line-strong);
        text-underline-offset: 0.2em;
        cursor: pointer;
    }
    .text-button:hover {
        color: var(--pico-color);
        text-decoration-color: currentColor;
    }
    .events {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem 1rem;
        margin-top: 0.25rem;
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
    .log {
        border: 1px solid var(--dp-line);
        border-radius: var(--dp-radius-lg);
    }
    .log summary {
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
