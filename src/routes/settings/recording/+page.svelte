<script lang="ts">
    import { submitting } from '#lib/actions.js';
    import { autosave, SaveState } from '#lib/autosave.svelte.js';
    import CheckRow from '#lib/components/CheckRow.svelte';
    import Lead from '#lib/components/Lead.svelte';
    import SaveNote from '#lib/components/SaveNote.svelte';
    import Toasts, { errorNotice, type Notice } from '#lib/components/Toasts.svelte';
    import { CODEC_LABEL, HW_EVERY, HW_SOFTWARE, hwChoice, hwUsable } from '#lib/hw.js';
    import type { SubmitFunction } from '$app/forms';

    let { data, form } = $props();

    /**
     * 押した結果。**その場で保存した結果はここに出さない** — 変えた欄の近く (節の見出しの横。`SaveNote`) に出す
     */
    const notices = $derived.by(() => {
        const list: Notice[] = [];
        list.push(...errorNotice(form, 'settings-error'));
        if (form?.probed) list.push({ key: 'hw-probed', kind: 'success', text: 'GPU を確かめ直しました' });
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

    /** 保存の結果 (`autosave`)。節ごとに見出しの横に出す */
    const encodingSave = new SaveState();
    const cmSave = new SaveState();
    const reserveSave = new SaveState();

    /**
     * 「確かめ直す」は今の値を見せている画面のまま送る。enhance の既定 (成功後に `form.reset()`) だと、
     * 何も変えずに押しただけで欄が初期値に戻って見える
     */
    const keepValues: SubmitFunction = () => async (options) => {
        await options.update({ reset: false });
    };
</script>

<Toasts {notices} source={form} />

<!--
    **節ごとにフォームを分け、変えたらその場で保存する** (`autosave`)。保存のボタンは置かない。
    結果は変えた節の見出しの横に出る。値は bind せず `checked` / `selected` で渡す
    (別の節を保存して読み直しても、同じ値なら DOM に書かない)。
    どの節もすべての録画に効く。ルールや予約ごとには変えられない
-->
<div class="part" id="encoding" data-part>
    <div class="sections readable">
        <section class="section">
            <div class="section-head">
                <h2>エンコード</h2>
                <SaveNote status={encodingSave} />
            </div>
            <Lead>すべての録画に効きます。ルールや予約ごとには変えられません</Lead>
            <form method="POST" action="?/saveEncoding" use:autosave={encodingSave} class="fields setting-rows">
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
                                        <p data-testid="hw-device">
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
                    <select name="transcodeLimit" class="narrow" aria-label="同時に変換する本数">
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
                    <CheckRow
                        name="keepOriginal"
                        checked={recording.keepOriginal}
                        title="元のTSも残す"
                        hint="エンコードしたあとも元のTSを消しません。容量を多く使います"
                    />
                </div>
                <!--
                    コマ数 (30/60) は本編映像のフィールドを比べて決める (`server/fps.ts`)。
                    放送は素材が何でも 1080i/60 で来るので、ジャンルにもTSのヘッダにも
                    本当のコマ数は入っていない
                -->
                <div class="field">
                    <span class="field-label">コマ数</span>
                    <CheckRow
                        name="fpsDetect"
                        checked={recording.fpsDetect}
                        title="コマ数を映像から決める"
                        hint="アニメなどは 30コマにして、時間とサイズを半分にします"
                        detail="同じコマが続く映像 (アニメなど) を見分けて 30コマでエンコードします。外すとすべて 60コマになります。"
                    />
                </div>
            </form>
            <!-- 「確かめ直す」が送るフォーム。ボタンは映像コーデックの下にあり、`form="probe-hw"` で指す -->
            <form id="probe-hw" method="POST" action="?/probeHw" use:submitting={keepValues} hidden></form>
        </section>
    </div>
</div>

<div class="part" id="cm" data-part>
    <div class="sections readable">
        <section class="section">
            <div class="section-head">
                <h2>CM</h2>
                <SaveNote status={cmSave} />
            </div>
            <form method="POST" action="?/saveCm" use:autosave={cmSave} class="fields setting-rows">
                <label class="field">
                    <span class="field-label">CMの扱い</span>
                    <select name="cmCut" class="narrow" data-testid="global-cmcut">
                        <option value="chapter" selected={recording.cmCut === 'chapter'}>
                            チャプターを打つだけ (安全)
                        </option>
                        <option value="cut" selected={recording.cmCut === 'cut'}>切り取る</option>
                        <option value="off" selected={recording.cmCut === 'off'}>何もしない</option>
                    </select>
                    <span class="hint">局ロゴの消えている所をCMとみます。ロゴが使えなければ無音と長さで決めます</span>
                </label>
            </form>
        </section>
    </div>
</div>

<div class="part" id="reserve" data-part>
    <div class="sections readable">
        <section class="section">
            <div class="section-head">
                <h2>自動予約</h2>
                <SaveNote status={reserveSave} />
            </div>
            <form method="POST" action="?/saveReserve" use:autosave={reserveSave} class="fields setting-rows">
                <div class="field">
                    <span class="field-label">有料放送</span>
                    <CheckRow
                        name="freeOnly"
                        checked={recording.freeOnly}
                        title="自動予約は無料放送だけにする"
                        hint="契約していない有料放送は、録画してもスクランブルのままで観られません"
                    />
                </div>
            </form>
        </section>
    </div>
</div>

<style>
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
    @container (min-width: 30rem) {
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
</style>
