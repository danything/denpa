<script lang="ts">
  import type { SubmitFunction } from "$app/forms";

  import { submitting } from "#lib/actions.js";
  import { autosave, SaveState } from "#lib/autosave.svelte.js";
  import CheckRow from "#lib/components/CheckRow.svelte";
  import Lead from "#lib/components/Lead.svelte";
  import SaveNote from "#lib/components/SaveNote.svelte";
  import Toasts, { errorNotice } from "#lib/components/Toasts.svelte";
  import {
    CODEC_LABEL,
    HW_EVERY,
    HW_SOFTWARE,
    type HwAllow,
    hwChoice,
    hwUsable,
  } from "#lib/hw.js";

  let { data, form } = $props();

  /**
   * 押した結果。**その場で保存した結果はここに出さない**。変えた欄の近く (節の見出しの横。`SaveNote`) に出す
   */
  const notices = $derived.by(() => {
    const list = errorNotice(form, "settings-error");
    if (form?.probed)
      list.push({
        key: "hw-probed",
        kind: "success",
        text: "GPU を確かめ直しました",
      });
    return list;
  });

  /**
   * 録画設定のフォームは bind せず `checked` / `selected` で初期値だけ渡す。
   * 別のフォームを保存して data が読み直されても、値が同じなら Svelte は DOM に
   * 書かない。手元で変えたまま保存していない入力はそのまま残る
   */
  const recording = $derived(data.recording);

  /**
   * 映像コーデックの行。並びは HW_CODECS と同じ (AV1 → H.265 → H.264)。
   * **H.265 は GPU でだけエンコードする**ので、H.265 をエンコードできる GPU があるときだけ行を出す (`gpuOnly`)
   */
  const CODECS = [
    { codec: "av1", label: "AV1 (小さい・遅い)", gpuOnly: false },
    { codec: "hevc", label: "H.265 (GPU だけ)", gpuOnly: true },
    { codec: "h264", label: "H.264 (古いテレビ向け・大きい)", gpuOnly: false },
  ] as const;

  /** 保存の結果 (`autosave`)。節ごとに見出しの横に出す */
  const encodingSave = new SaveState();
  const cmSave = new SaveState();
  const viewingSave = new SaveState();
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
    結果は変えた節の見出しの横に出る。値の渡し方は上の `recording`。
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
      <form
        method="POST"
        action="?/saveEncoding"
        use:autosave={encodingSave}
        class="fields setting-rows"
      >
        <!--
                    **コーデックごとに、エンコーダ (ソフトウェア・GPU) を横に置く。録画とライブで別々に選ぶ** (列の見出し「録画」「ライブ」)。
                    選べるのは、そのコーデックを GPU でエンコードできるデバイスがあるときだけ。持ち方はデバイス × 方式 × コーデックのまま
                    (`chooseHw`。録画は `hwAllow`、ライブは `liveHwAllow`)。追っかけと録画のその場の変換もライブの列を使う。チェックを外したコーデックもライブは使うので、
                    選ぶ欄はチェックと関係なく出しておく。
                    **H.265 は GPU でだけエンコードする**ので、行ごと GPU を確かめてから出し、エンコーダに
                    「ソフトウェア」を置かない (録画で外すならチェックを外す)。ライブの列は「ソフトウェア」の代わりに「使わない」を置く。
                    選ぶとライブで H.265 を出さない (`live.liveHevc`)。行を出したときだけ `codecsShown` を送る。
                    確かめている最中や GPU が無いときに保存しても、H.265 のチェックは前のまま (saveEncoding)
                -->
        {#snippet codecRow(
          codec: (typeof CODECS)[number]["codec"],
          label: string,
          gpuOnly: boolean,
        )}
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
              <!-- 狭い幅では列の見出しが出ないので、欄の前に「録画」「ライブ」を添える (`caption`) -->
              {#snippet encoder(
                prefix: string,
                caption: string,
                testid: string,
                allow: HwAllow,
                off: string | null,
              )}
                {@const choice = hwChoice(allow, hw.devices, codec)}
                {#if usable.length > 0}
                  <label class="encoder-field">
                    <span class="encoder-caption">{caption}</span>
                    <select
                      name={`${prefix}.${codec}`}
                      class="encoder"
                      aria-label={`${CODEC_LABEL[codec]} の${caption}のエンコーダ`}
                      data-testid={testid}
                    >
                      <!-- `off` はソフトウェアの欄の名前 (GPU だけのコーデックの録画は置かない。ライブは「使わない」) -->
                      {#if off !== null}
                        <option
                          value={HW_SOFTWARE}
                          selected={choice === HW_SOFTWARE}>{off}</option
                        >
                      {/if}
                      <!-- ソフトウェアの欄を置かないときに、どの GPU の印も外れていれば (前の設定) 先頭の GPU を選んで見せる -->
                      {#each usable as device, i (device.path)}
                        <option
                          value={device.path}
                          selected={choice === device.path ||
                            (off === null && choice === HW_SOFTWARE && i === 0)}
                          >{device.label}</option
                        >
                      {/each}
                      {#if usable.length > 1}
                        <option value={HW_EVERY} selected={choice === HW_EVERY}
                          >GPU を順番に使う</option
                        >
                      {/if}
                    </select>
                  </label>
                {:else if hw.devices.length > 0}
                  <span class="hint encoder-field"
                    ><span class="encoder-caption">{caption}</span
                    >ソフトウェア</span
                  >
                {/if}
              {/snippet}
              {@render encoder(
                "hw",
                "録画",
                `hw-${codec}`,
                recording.hwAllow,
                gpuOnly ? null : "ソフトウェア",
              )}
              {@render encoder(
                "liveHw",
                "ライブ",
                `live-hw-${codec}`,
                recording.liveHwAllow,
                gpuOnly ? "使わない" : "ソフトウェア",
              )}
            {/await}
          </div>
        {/snippet}
        <fieldset class="field">
          <span class="field-label">映像コーデック</span>
          <div class="codecs">
            {#await data.hw then hw}
              {#if hw.devices.length > 0}
                <span class="encoder-head"></span>
                <span class="encoder-head">録画</span>
                <span class="encoder-head">ライブ</span>
              {/if}
            {/await}
            {#each CODECS as { codec, label, gpuOnly } (codec)}
              {#if gpuOnly}
                {#await data.hw then hw}
                  {#if hwUsable(hw.devices, codec).length > 0}
                    <input type="hidden" name="codecsShown" value={codec} />
                    {@render codecRow(codec, label, gpuOnly)}
                  {/if}
                {/await}
              {:else}
                {@render codecRow(codec, label, gpuOnly)}
              {/if}
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
                <button
                  type="submit"
                  form="probe-hw"
                  class="text-button"
                  data-testid="hw-probe">確かめ直す</button
                >
                {#snippet more()}
                  <p>
                    使える GPU は Intel・AMD (VA-API)・NVIDIA (NVENC)・Rockchip
                    (MPP) です。見つかれば自動で使います。
                  </p>
                  <p>
                    GPU →
                    ソフトウェアの順に試し、失敗したら次の方法でやり直します
                    (H.265 はソフトウェアでエンコードしません)。
                  </p>
                  <p>
                    エンコーダは録画とライブで別々に選べます。追っかけと、録画を別の形式で観るときの変換もライブのエンコーダを使います
                    (チェックを外したコーデックも)。MPEG-2 のデコードまで GPU
                    でできるデバイスでは、ライブはデコードとインターレース解除も
                    GPU で行います。
                  </p>
                  <p>
                    GPU が 2 枚あれば「録画はこちら、ライブはあちら」「AV1
                    はこちら、H.264 はあちら」のように分けられます。「GPU
                    を順番に使う」では、エンコードのたびに使う GPU
                    を入れ替えます。
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
              選ばないと<strong>エンコードせず</strong>、元の TS のまま残します
              {#snippet more()}
                <p>CM のチャプターや字幕トラックも付きません。</p>
              {/snippet}
            </Lead>
          {:else if recording.codecs.length > 1}
            <Lead>
              1 本の録画を選んだコーデックの数だけエンコードします
              {#snippet more()}
                <p>
                  再生では AV1 → H.265 → H.264
                  の順に、端末で再生できるものを選びます。
                </p>
              {/snippet}
            </Lead>
          {/if}
          {#if recording.codecs.includes("hevc")}
            <Lead>
              H.265 は GPU でだけエンコードします
              {#snippet more()}
                <p>
                  GPU でエンコードできないときは H.265
                  を飛ばし、ほかに選んだコーデックだけエンコードします。H.265
                  だけを選んでいたらエンコードは失敗し、元の TS が残ります。
                </p>
                <p>ライブと追っかけは H.265 では流しません。</p>
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
          <select
            name="transcodeLimit"
            class="narrow"
            aria-label="同時に変換する本数"
          >
            <option value="" selected={recording.transcodeLimit === null}>
              自動 ({data.transcode.auto} 本)
            </option>
            {#each data.transcode.choices as n (n)}
              <option
                value={String(n)}
                selected={recording.transcodeLimit === n}>{n} 本</option
              >
            {/each}
          </select>
          <Lead>
            録画を別の形式で再生するときと、追っかけ再生で使います。ライブは数えません
            {#snippet more()}
              <p>
                自動では GPU が無ければ 2 本、あれば 4
                本です。埋まっているときにリクエストされた再生は断り、
                エンコード済みの動画か元の TS での再生を勧めます。
              </p>
            {/snippet}
          </Lead>
        </div>
        <div class="field">
          <span class="field-label">元の TS</span>
          <CheckRow
            name="keepOriginal"
            checked={recording.keepOriginal}
            title="元の TS も残す"
            hint="エンコードしたあとも元の TS を消しません。容量を多く使います"
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
            hint="アニメなどは 30 コマにして、時間とサイズを半分にします"
            detail="同じコマが続く映像 (アニメなど) を見分けて 30 コマでエンコードします。外すとすべて 60 コマになります。"
          />
        </div>
      </form>
      <!-- 「確かめ直す」が送るフォーム。ボタンは映像コーデックの下にあり、`form="probe-hw"` で指す -->
      <form
        id="probe-hw"
        method="POST"
        action="?/probeHw"
        use:submitting={keepValues}
        hidden
      ></form>
    </section>
  </div>
</div>

<!--
    視聴 (世帯の設定)。ライブの「自動」が家の中とみる名前 (`#lib/host.ts` の `indoorHost`) と、コーデックのメニューから
    H.264 と H.265 を外すか (`#lib/live-choice.ts` の `HIDDEN_CODECS`)。名前の欄は離れたときに保存する (打っている途中では送らない)
-->
<div class="part" id="viewing" data-part>
  <div class="sections readable">
    <section class="section">
      <div class="section-head">
        <h2>視聴</h2>
        <SaveNote status={viewingSave} />
      </div>
      <Lead>この世帯のすべての端末に効きます</Lead>
      <form
        method="POST"
        action="?/saveViewing"
        use:autosave={viewingSave}
        class="fields setting-rows"
      >
        <div class="field">
          <label class="field-label" for="indoor-hosts">家の中の名前</label>
          <textarea
            id="indoor-hosts"
            name="indoorHosts"
            rows="3"
            spellcheck="false"
            autocapitalize="off"
            placeholder="dp.l.example.com"
            value={recording.indoorHosts.join("\n")}
            data-testid="indoor-hosts"></textarea>
          <Lead>
            この名前で開くと、ライブの「自動」で MPEG-2 を先に選びます。1 行に 1
            つ
            {#snippet more()}
              <p>
                家の中では放送のまま (MPEG-2)
                で流すと、サーバがエンコードせずに済み、画質も放送のままです。外からは
                AV1、再生できなければ H.265 (ライブのエンコーダが GPU
                のとき)、それも駄目なら H.264 を選びます。
              </p>
              <p>
                家の中かは、開いたアドレスの名前で決めます。192.168.x.x
                のような家の中の IP アドレス・localhost・.local・.home.arpa
                で開いたときは、書かなくても家の中です。VPN のアドレス
                (100.64.0.0/10) は家の中に入れません。
              </p>
            {/snippet}
          </Lead>
        </div>
        <div class="field">
          <span class="field-label">コーデック</span>
          <CheckRow
            name="hideH264Hevc"
            checked={recording.hideH264Hevc}
            title="コーデックの選択肢に H.264 と H.265 を出さない"
            hint="AV1 を再生できない端末では、自動で H.265 か H.264 に切り替えます"
            testid="hide-h264-hevc"
          />
        </div>
      </form>
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
      <form
        method="POST"
        action="?/saveCm"
        use:autosave={cmSave}
        class="fields setting-rows"
      >
        <label class="field">
          <span class="field-label">CM の扱い</span>
          <select name="cmCut" class="narrow" data-testid="global-cmcut">
            <option value="chapter" selected={recording.cmCut === "chapter"}>
              チャプターを打つだけ (安全)
            </option>
            <option value="cut" selected={recording.cmCut === "cut"}
              >切り取る</option
            >
            <option value="off" selected={recording.cmCut === "off"}
              >何もしない</option
            >
          </select>
          <span class="hint"
            >局ロゴの消えている所を CM
            とみます。ロゴが使えなければ無音と長さで決めます</span
          >
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
      <form
        method="POST"
        action="?/saveReserve"
        use:autosave={reserveSave}
        class="fields setting-rows"
      >
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
     * **チェックと、その横のエンコーダ (録画・ライブ)。** 広い幅ではエンコーダを列にして縦に揃え、
     * 上に列の見出し (「録画」「ライブ」) を置く (行ごとに字の長さが違うので、揃えないと欄が左右にずれる)。
     * 狭い幅では見出しを出さず、チェックの文の下に「録画」「ライブ」を添えた欄を、文の頭に揃えて置く
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
  .encoder-head {
    display: none;
  }
  .encoder-field {
    display: flex;
    align-items: center;
    gap: var(--dp-space-2);
  }
  .encoder-caption,
  .encoder-head {
    font-size: var(--dp-text-sm);
    color: var(--dp-muted);
  }
  @container (min-width: 40rem) {
    .codecs {
      display: grid;
      grid-template-columns: max-content max-content max-content;
      align-items: center;
      gap: var(--dp-space-2) var(--dp-space-3);
    }
    .codec-row {
      display: contents;
    }
    /* チェックはいつも行の頭から (GPU が無くて欄が無い行が横に並ばないように) */
    .codec-row > .check {
      grid-column: 1;
    }
    .codec-row > :not(.check) {
      margin-inline-start: 0;
    }
    .encoder-head {
      display: block;
    }
    .encoder-caption {
      display: none;
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
