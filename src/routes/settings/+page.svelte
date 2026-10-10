<script lang="ts">
    import { submitting } from '#lib/actions.js';
    import { arming } from '#lib/arming.svelte.js';
    import ActionButton from '#lib/components/ActionButton.svelte';
    import ArmedDelete from '#lib/components/ArmedDelete.svelte';
    import JobProgress from '#lib/components/JobProgress.svelte';
    import Toasts, { errorNotice, type Notice } from '#lib/components/Toasts.svelte';
    import { dateTime, stateLabel } from '#lib/format.js';
    import { CODEC_LABEL, HW_CODECS, HW_KIND_LABEL, HW_KINDS, hwAllowed } from '#lib/hw.js';
    import { liveUpdates } from '#lib/live-updates.svelte.js';
    import { measure } from '#lib/measure.svelte.js';
    import { EVENT_LABEL } from '#lib/webhook-events.js';
    import type { SubmitFunction } from '$app/forms';

    let { data, form } = $props();

    liveUpdates(['migrate']);

    const migrate = $derived(data.migrate.status);
    const done = $derived(migrate.imported + migrate.skipped + migrate.missing);

    /** 押した結果。引き継ぎの進み具合そのものは、そのカードの中に出したままにする */
    const notices = $derived.by(() => {
        const list: Notice[] = [];
        if (form?.migrate) list.push({ key: 'migrate-started', kind: 'info', text: form.migrate });
        list.push(...errorNotice(form, 'settings-error'));
        if (form?.saved) list.push({ key: 'saved-result', kind: 'success', text: '保存しました' });
        if (form?.probed) list.push({ key: 'hw-probed', kind: 'success', text: 'GPU を確かめ直しました' });
        if (form?.webhookAdded) list.push({ key: 'webhook-added', kind: 'success', text: '通知先を追加しました' });
        if (form?.tested) {
            list.push({
                key: 'webhook-tested',
                kind: form.tested === 'ok' ? 'success' : 'error',
                text: `テスト送信の結果: ${form.tested}`,
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
</script>

<svelte:window onclick={deleting.stand} />

{#snippet checkRow(
    name: string,
    checked: boolean,
    testid: string,
    title: string,
    hint: string,
    more: string = '',
)}
    <!--
        チェック + 見出し + 1行の要点。この画面の決まりの形 (6行が同じ骨格だった)。
        続きの説明 (`more`) は畳んで、label の外に置く — label の中に details を
        入れると、「詳しく」を押したつもりでチェックまで切り替わりかねない
    -->
    <div class="check-item">
        <label class="check-row">
            <input type="checkbox" {name} {checked} data-testid={testid} />
            <span class="small">
                {title}
                <span class="hint">{hint}</span>
            </span>
        </label>
        {#if more !== ''}
            <details class="more">
                <summary>詳しく</summary>
                <p>{more}</p>
            </details>
        {/if}
    </div>
{/snippet}

<Toasts {notices} source={form} />

<!--
    広い画面では**全部を2列に収める**。列は grid の行ではなく独立した縦並びにしてある
    (行で組むと段ごとに高さが揃えられ、背の低いカードの隣に大きな穴が空く)
-->
<div class="columns">
    <div class="column">
        <section class="panel card">
            <h2>録画のしかた</h2>
            <p class="small soft">
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
                    「エンコードしない」(生TSのまま)
                -->
                <fieldset class="field">
                    <span class="field-label">映像コーデック</span>
                    <label class="check">
                        <input
                            type="checkbox"
                            name="codecs"
                            value="av1"
                            checked={recording.codecs.includes('av1')}
                            data-testid="codec-av1"
                        />
                        <span class="small">AV1 (小さい・遅い)</span>
                    </label>
                    <label class="check">
                        <input
                            type="checkbox"
                            name="codecs"
                            value="h264"
                            checked={recording.codecs.includes('h264')}
                            data-testid="codec-h264"
                        />
                        <span class="small">H.264 (古いテレビ向け・大きい)</span>
                    </label>
                    {#if recording.codecs.length === 0}
                        <span class="hint">
                            選ばないと<strong>エンコードせず</strong>、生TSのまま残します
                        </span>
                        <details class="more">
                            <summary>詳しく</summary>
                            <p>CM のチャプターや字幕トラックも付きません。</p>
                        </details>
                    {:else if recording.codecs.length === 2}
                        <span class="hint">1本の録画を両方でエンコードします</span>
                        <details class="more">
                            <summary>詳しく</summary>
                            <p>
                                再生・ダウンロードは既定で AV1 です。テレビごとの設定で H.264 を渡せます。
                            </p>
                        </details>
                    {/if}
                </fieldset>
                <!--
                    **並びは話題ごとに。** 2列に流し込むので、DOM の順がそのまま
                    「どれとどれが同じ行に来るか」になる。
                    1行目は「出来上がるもの」(コーデックと生TS)、2行目は焼く前に映像を読んで
                    決めるもの (CM とコマ数)。どの升目も「小さい見出し → 中身 → 要点 → 詳しく」の形にそろえる
                -->
                <div class="field">
                    <span class="field-label">元のTS</span>
                    {@render checkRow(
                        'keepOriginal',
                        recording.keepOriginal,
                        'global-keep',
                        '生TSも残す',
                        'エンコードしたあとも元のTSを消しません。容量を多く使います',
                    )}
                </div>
                <label class="field">
                    <span class="field-label">CM</span>
                    <select name="cmCut" data-testid="global-cmcut">
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
                    本当のコマ数は入っていない。60コマに起こして同じ絵が並ぶ割合を
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
                <div class="field span-2">
                    <span class="field-label">自動予約</span>
                    {@render checkRow(
                        'freeOnly',
                        recording.freeOnly,
                        'global-free-only',
                        '自動予約は無料放送だけにする',
                        '契約していない有料放送は、録画してもスクランブルのままで観られません',
                    )}
                </div>
                <div class="span-2">
                    <button type="submit" data-testid="save-recording">保存</button>
                </div>
            </form>
        </section>

        <!--
            テレビのアプリ (danything/denpa-tv) に渡した鍵。家の外から OIDC 越しに使うテレビは
            QR でペアリングして鍵を持つ (信頼するネットワークの中なら鍵は要らない)。
            なくしたテレビ・手放したテレビはここで止める
        -->
        <section class="panel card" data-testid="devices-card">
            <h2>テレビのアプリ</h2>
            <p class="small soft">QR でペアリングしたテレビです。取り消すと、そのテレビはペアリングし直しになります</p>
            {#if data.devices.length === 0}
                <p class="small muted">まだありません</p>
            {:else}
                <div class="rows" data-testid="device-list">
                    {#each data.devices as device (device.id)}
                        <div class="row device" data-testid="device-row">
                            <div class="small"><strong>{device.name}</strong></div>
                            <div class="tiny muted">
                                ペアリング {dateTime(device.created_at)} ・ 最後に使った
                                {device.last_used_at === null ? 'まだ' : dateTime(device.last_used_at)}
                            </div>
                            <ActionButton action="?/revokeDevice" fields={{ id: device.id }} class="xs outline danger" testid="device-revoke">
                                取り消す
                            </ActionButton>
                        </div>
                    {/each}
                </div>
            {/if}
        </section>

        <section class="panel card">
            <h2>通知</h2>
            <p class="small soft">録画の開始・完了・失敗などを外部に通知します</p>
            <details class="more">
                <summary>詳しく</summary>
                <p>Discord や Slack の Incoming Webhook の URL をそのまま入れられます。</p>
                <p>
                    録画の失敗は画面を開くまで気づけないので、せめて「録画失敗」は送っておくと安心です。
                </p>
            </details>

            <form method="POST" action="?/addWebhook" use:submitting class="two-col">
                <label class="field span-2">
                    <span class="field-label">URL</span>
                    <input name="url" placeholder="https://..." data-testid="webhook-url" />
                </label>
                <div class="span-2">
                    <span class="field-label">送る通知</span>
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
                    **表ではなく行のカード** (録画一覧と同じ形)。1件を URL・送る通知・直近の結果・ボタン の順に
                    縦に積めば、幅がいくらでも横には出ない (URL だけは `text-overflow: ellipsis` で止める)
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
                                <ActionButton action="?/testWebhook" fields={{ id: webhook.id }} class="xs secondary" testid="webhook-test">
                                    テスト送信
                                </ActionButton>
                                <ActionButton action="?/toggleWebhook" fields={{ id: webhook.id }} class="xs secondary" testid="webhook-toggle">
                                    {webhook.enabled ? '無効化' : '有効化'}
                                </ActionButton>
                                <!-- 押し間違い防止に2回押させる (録画・ルールの削除と同じ) -->
                                <ArmedDelete
                                    {deleting}
                                    armKey={webhook.id}
                                    action="?/deleteWebhook"
                                    fields={{ id: webhook.id }}
                                    class="xs"
                                    testid="webhook-delete"
                                />
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
            <p class="small soft">データ放送 (d ボタン) の地域を、郵便番号で決めます</p>
            <details class="more">
                <summary>詳しく</summary>
                <p>
                    テレビの初期設定で入れる郵便番号です。データ放送の
                    <strong>天気・地域のニュース・防災情報</strong>は、これで地域が決まります。
                </p>
                <p>未設定だと「郵便番号が正しく設定されていません」と表示され、その欄は空のままです。</p>
            </details>
            <form method="POST" action="?/saveBroadcast" use:submitting={keepValues} class="wrap-form">
                <label class="field">
                    <span class="field-label">郵便番号</span>
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
                <div class="check-item full">
                    <label class="check-row">
                        <input
                            type="checkbox"
                            name="bmlNetwork"
                            checked={data.broadcast.bmlNetwork}
                            data-testid="bml-network"
                        />
                        <span class="small">
                            双方向 (通信系コンテンツ) を使う
                            <span class="hint">
                                番組の<strong>応募や投票も放送局へ送られます</strong>
                            </span>
                        </span>
                    </label>
                    <details class="more">
                        <summary>詳しく</summary>
                        <p>
                            オンにすると、denpa が放送局のサーバと代わりに通信します (受信も送信も)。
                            番組の応募や投票もそのまま送られます。
                        </p>
                        <p>オフのときは、放送側に「インターネットに接続されていません」と表示されます。</p>
                    </details>
                </div>

                <div class="full">
                    <button type="submit" data-testid="save-broadcast">保存</button>
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
            <p class="small soft">GPU でエンコードするかを、デバイスとコーデックごとに選びます</p>
            <details class="more">
                <summary>詳しく</summary>
                <p>
                    使える GPU は Intel QSV / VA-API です。使えるものには自動で印が付きます。
                </p>
                <p>
                    両方に付いていれば QSV → VA-API → ソフトウェアの順に試し、失敗したら次の方法でやり直します。
                </p>
                <p>
                    ライブと追っかけも、印の付いたコーデックは GPU でエンコードします。MPEG-2
                    の復号まで GPU でできるデバイスでは、復号とインタレ解除も GPU で行います。
                </p>
                <p>
                    GPU が2枚あれば「こちらは AV1、あちらは H.264」のように分けられ、
                    同じコーデックを扱えるデバイスが複数あれば順番に使います。
                </p>
            </details>
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
            <h2>EPGStation からの引き継ぎ</h2>
            <p class="small soft">
                EPGStation から<strong>ルール・手動予約・録画</strong>を取り込みます
            </p>
            <details class="more">
                <summary>詳しく</summary>
                <p>
                    EPGStation のデータベースから読みます。録画は denpa のフォルダ構成に置き直し、
                    番組情報とサムネイルも作ります。
                </p>
                <p>
                    何度実行しても、取り込み済みのものは飛ばします。ルールによる予約は、取り込んだルールから
                    denpa が作り直します。
                </p>
            </details>

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
            **端末でしか出ない食い違いを、その端末で読むための口。**

            縦のはみ出し (ページごと動いてしまう) は、引っ込むアドレスバーや
            画面の切り欠きが絡むと**その端末でしか起きない**。自動運転の
            ブラウザには作れないので、手元では再現できない。

            **入り口をここに置くのは、PWA にアドレスバーが無いため。**
            `?measure` を付ければ同じものが出るが、ホーム画面から開いた
            アプリでは URL を打つところがない。
        -->
        <section class="panel card">
            <h2>画面の高さを見る</h2>
            <p class="small soft">右下に、この端末での画面の高さを出します</p>

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

            <details class="more">
                <summary>詳しく</summary>
                <p>
                    <strong>この端末だけ</strong>の設定で、サーバにも他の端末にも伝わりません。
                </p>
                <p>
                    出るのは「窓 / 枠 / 中身 = はみ出し」「dvh / svh / lvh / vh の実測」と、
                    <strong>はみ出している要素</strong>。はみ出しが 0 でなければページごと動きます。
                    単位の4つが同じ数なら、食い違いが原因ではありません。
                </p>
            </details>
        </section>
    </div>
</div>

<style>
    /* 要点の1行と「詳しく」は1つの話。カードの段の間隔 (0.75rem) で離さない */
    .soft + .more {
        margin-top: -0.5rem;
    }
    .hint {
        display: block;
        font-size: 0.8rem;
        opacity: 0.7;
    }
    /* 升目は上でそろえる。背の違う升目を真ん中に寄せると、隣と頭が合わずに浮く */
    .two-col {
        display: grid;
        align-items: start;
        gap: 1.25rem 1.5rem;
    }
    @media (min-width: 640px) {
        .two-col {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .span-2 {
            grid-column: span 2;
        }
    }
    .check-item {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }
    /* 「詳しく」はチェックの横の文に揃える (箱の幅 1.25rem + 間 0.5rem) */
    .check-item > .more {
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
    .log {
        border: 1px solid var(--dp-base-300);
        border-radius: 1rem;
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
