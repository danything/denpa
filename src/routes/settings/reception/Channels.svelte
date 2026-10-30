<script lang="ts">
  import "@anyblades/blades/content/table";
  import "@anyblades/blades/components/accordion";
  import "@anyblades/blades/components/progress";
  import { resolve } from "$app/paths";

  import { submitting } from "#lib/actions.js";
  import ActionButton from "#lib/components/ActionButton.svelte";
  import JobProgress from "#lib/components/JobProgress.svelte";
  import Lead from "#lib/components/Lead.svelte";
  import LogoZoom from "#lib/components/LogoZoom.svelte";
  import ServiceLogo from "#lib/components/ServiceLogo.svelte";
  import { SERVICE_TYPE_LABEL, stateLabel } from "#lib/format.js";

  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  /**
   * 局ごとのロゴ (`logos.server.ts`)。局ロゴの具合 (`logo`) と、CM検出のロゴを覚えた時刻 (`cm`)。
   * 表は物理チャンネルごとに並ぶので、局の id で引く
   */
  const logoOf = $derived(
    new Map(data.stations.map((station) => [station.id, station])),
  );

  /**
   * 大きく見ているロゴ (`LogoZoom`)。持つのは局と種類だけで、中身は表の行から引く —
   * 「覚え直す」でCMロゴが消えたら、そのまま閉じる。**「覚え直す」は窓の中だけ** (行を低く保つ)
   */
  let zoom = $state<{ id: number; kind: "station" | "cm" } | null>(null);
  const zoomTarget = $derived.by(() => {
    if (zoom === null) return null;
    const { id, kind } = zoom;
    const station = logoOf.get(id);
    if (station === undefined) return null;
    if (kind === "cm" && station.cm === null) return null;
    if (kind === "station" && station.logo !== "have") return null;
    return {
      id,
      name: station.name,
      kind,
      learnedAt: kind === "cm" ? station.cm : null,
    };
  });

  /** 局ロゴの大きさ。放送のロゴは 16:9 (64x36) */
  const LOGO_SIZE = "width: 2.4rem; height: 1.35rem";

  const scan = $derived(data.scan);

  /**
   * スキャンする種別の選び方。値はそのまま `types` で送る (「すべて」はカンマで3つ)。
   * 入れたばかりのときに要るのは地上波だけなので、それが先頭 (衛星は最初から局が入っている)
   */
  const SCAN_CHOICES = [
    { value: "GR", label: SERVICE_TYPE_LABEL["GR"] },
    // CATV の周波数変換パススルー。UHF に加えて C13〜C63 も回す (`scan.ts` の `SCAN_KINDS`)
    { value: "CATV", label: `${SERVICE_TYPE_LABEL["GR"]} (CATV)` },
    { value: "BS", label: SERVICE_TYPE_LABEL["BS"] },
    { value: "CS", label: SERVICE_TYPE_LABEL["CS"] },
    { value: "GR,BS,CS", label: "すべて" },
  ];
  /*
   * 物理チャンネルと、そこに入っている局。**denpa 自身のDBから来る。**
   * エージェントにも控えはあるが、聞きに行かない (`channels.server.ts`)
   */
  const coverage = $derived(data.channels);
  /** 入っている局をすべて並べたもの */
  const services = $derived(coverage.flatMap((channel) => channel.services));

  /** 番組表がどこまで埋まっているか。「8/9 まで」の形で出す */
  function until(at: number): string {
    const d = new Date(at);
    return `${d.getMonth() + 1}/${d.getDate()} まで`;
  }
</script>

<!--
    **スキャンは種別を選ぶ欄とボタンの1組。** 回っている間は「中断」に替わる。
    探す範囲は決め打ち (放送で使う物理チャンネルは決まっていて、狭めても総当たりの時間が少し減るだけ)
-->
{#snippet scanControl()}
  <form method="POST" action="?/scan" use:submitting class="scan-control">
    {#if scan.state === "running"}
      <!--
                十数分かかるので、途中で降りられるようにしてある。中断しても設定は書き換えない
                (途中までの結果で上書きすると、まだ回っていない局の定義が消える)
            -->
      <button type="submit" class="small outline danger" formaction="?/scanStop"
        >中断</button
      >
    {:else}
      <select name="types" aria-label="スキャンする種別">
        {#each SCAN_CHOICES as choice (choice.value)}
          <option value={choice.value}>{choice.label}</option>
        {/each}
      </select>
      <button type="submit" class="small" data-testid="scan-start"
        >スキャン</button
      >
    {/if}
  </form>
{/snippet}

<!--
    **スキャンも、受信できるチャンネルの節の中に。** 押すものは見出しの行にまとめ (スキャン・番組表。スマホの形では下のタブの上)、
    回っている間の進み具合は見出しのすぐ下。チャンネルが1つも無いときは、空の表の場所の真ん中に
    スキャンの欄を出す (局が無いときの案内 `ChannelNotice` の行き先がここ)
-->
<div class="sections">
  <section class="section" data-testid="channel-section">
    <div class="section-head spread">
      <h2>受信できるチャンネル</h2>
      {#if coverage.length > 0}
        <div class="cluster section-bar" data-testid="channel-actions">
          {@render scanControl()}
          <!--
                        入れたばかりのとき用。普段の周回は録画にもスキャンにもロゴにも
                        譲るので、何か動いていると番組表がなかなか埋まらない。
                        押されている間は録画以外には譲らせて、全チューナーで回る
                    -->
          <ActionButton
            action="?/collectNow"
            class="small secondary outline"
            disabled={data.collect.boosted}
            testid="epg-collect-now"
          >
            {data.collect.boosted ? "集めています…" : "番組表をいますぐ集める"}
          </ActionButton>
          <!--
                        取得するものが無ければボタンも出さない。押しても「もう全部持っています」と
                        断るだけになる。**走っている最中でも押せる** — 押されたほうが譲る作りなので、
                        使えなくすると「BSを取っている間ずっと押せない」に逆戻りする
                    -->
          {#if data.logos.pending > 0}
            <ActionButton
              action="?/logoSweep"
              class="small secondary outline"
              testid="logo-sweep"
            >
              {data.logoSweep.running
                ? "ロゴを集めています…"
                : "ロゴをいますぐ集める"}
            </ActionButton>
          {/if}
        </div>
      {/if}
    </div>

    {#if coverage.length > 0}
      <!-- 番組表がもう入っている局の数。下の表の右端を全部見なくても分かるように -->
      {@const withEpg = services.filter(
        (service) => service.programs > 0,
      ).length}
      <!--
                **入れ子になった3つの数を、その順に並べる。** チャンネル (T19, BS15_0) の中に
                局 (TOKYO MX1, MX2) があり、局ごとに番組表がある。「50 / 59 ・ 124 局」とだけ
                出していた頃は、59 と 124 が同じものの数に見えた。局はスキャンで、番組表は
                そのあと denpa が集めるもので、埋まる時期がずれる (局はあるのに番組表が空、が普通にある)
            -->
      <div class="small" data-testid="channel-coverage">
        <span class="muted">チャンネル</span>
        <strong>{coverage.length}</strong>
        <span class="faint">→</span>
        <span class="muted">局</span>
        <strong>{services.length}</strong>
        <span class="faint">→</span>
        <span class="muted">番組表のある局</span>
        <strong>{withEpg}</strong>
        <!--
                    ロゴの数も同じ行に、ほかの数と同じ形で (事実はバッジにしない。docs/design.md の「印の意味」)。
                    取れないぶんは下の行で断る。CMロゴはCM検出のために覚えたもので、局ロゴとは別物 (logo-data.ts)
                -->
        <span class="logo-counts">
          <span class="muted">局ロゴ</span>
          <strong class="num" data-testid="status-logos">
            {data.logos.have} / {data.logos.total} 局
          </strong>
          <span class="muted">CMロゴ</span>
          <strong class="num" data-testid="status-cm-logos">
            {data.cmLogoStats.have} / {data.cmLogoStats.total} 局
          </strong>
        </span>
      </div>
      {#if data.logos.unavailable > 0}
        <!--
                    取れないものを「まだ取れていない」と出し続けると、こちらの不具合と見分けが付かない。
                    **中継にロゴが無いことでは数えない。** CS の中継にはロゴが流れていないが、
                    CS のロゴは BS の中継から降ってくる
                -->
        <div class="tiny muted" data-testid="logo-unavailable">
          <span class="num">{data.logos.unavailable}</span> 局はロゴが放送に載っていないため取れません
          (1週間後にまた確かめます)
        </div>
      {/if}
    {/if}

    <!-- ロゴの取得は1チャンネルに数分かかる。出さないと押しても何も起きていないように見える -->
    {#if data.logoSweep.startedAt !== null}
      <div class="progress-block" data-testid="logo-sweep-progress">
        <JobProgress
          done={data.logoSweep.done}
          total={data.logoSweep.total}
          unit="チャンネル"
        >
          ・ ロゴ <strong>{data.logoSweep.found} 局</strong>
          {#if data.logoSweep.channels.length > 0}
            ・ 受信中 {data.logoSweep.channels.join(", ")}
          {/if}
        </JobProgress>
        {#if data.logoSweep.message !== ""}
          <div class="tiny muted" data-testid="logo-sweep-done">
            {data.logoSweep.message}
          </div>
        {/if}
      </div>
    {/if}

    {#if scan.state !== "idle"}
      <!-- 総当たりなので何分かかるか分かりにくい。どこまで進んだかを出す -->
      <div class="progress-block" data-state={scan.state}>
        <div class="cluster small">
          <span class="tag" data-testid="scan-state"
            >{scan.state === "canceled" ? "中断" : stateLabel(scan.state)}</span
          >
          {#if scan.phase}
            <span class="muted">{scan.phase}</span>
          {/if}
          <span class="num" data-testid="scan-found"
            >見つかったチャンネル {scan.channels}</span
          >
        </div>
        <JobProgress
          done={scan.scanned}
          total={scan.total}
          unit="チャンネル"
          testid="scan-count"
        />
        {#if scan.error}
          <div class="notice error">{scan.error}</div>
        {/if}
        {#if scan.log.length > 0}
          <details class="log">
            <summary class="small">ログ ({scan.log.length} 行)</summary>
            <pre data-testid="scan-log">{scan.log.join("\n")}</pre>
          </details>
        {/if}
      </div>
    {/if}
    {#if data.collect.running}
      <!-- 1チャンネルに数分かかる。黙っていると止まって見える -->
      <div class="progress-block" data-testid="epg-collect">
        <div class="small muted num">
          {data.collect.boosted
            ? "最優先で集めています"
            : "番組表を集めています"}
          ({data.collect.active.join(", ") || "準備中"}) ・ 残り {data.collect
            .pending} チャンネル
        </div>
        <progress
          class="running"
          value={data.collect.total -
            data.collect.pending -
            data.collect.active.length}
          max={Math.max(1, data.collect.total)}
        ></progress>
        {#if data.collect.sweeping}
          <!-- 初回だけ。番組名が先に出て、詳細があとから埋まるのを不具合と思わせない -->
          <div class="tiny muted">
            BS は、まず1つの中継から全局の番組名を入れています (数分)。
            番組内容・出演者などの詳細は、そのあと中継ごとに回って足します
          </div>
        {/if}
      </div>
    {/if}

    <!-- **説明は1つだけ。** スキャンと番組表のことは「詳しく」に畳む。まだ1つも無いときは下の1行の案内で足りる -->
    {#if coverage.length > 0}
      <Lead>
        1つのチャンネルに複数の局が入っているので、チャンネルと局の数はそろいません
        {#snippet more()}
          <p>
            スキャンは空いているチューナーを全部使います
            (録画中のチューナーは使いません)。録画中でも実行でき、
            画面を閉じてもサーバで続きます。終わると番組表も集め直します。
          </p>
          <p>
            番組表はスキャンのあと、局ごとに埋まっていきます。BS
            の初回は、1つの中継から全局の番組名を先に入れ (数分)、
            番組内容などの詳細はそのあと中継ごとに回って足します。
          </p>
          <p>
            待てないときは<strong>「番組表をいますぐ集める」</strong
            >で、録画とライブ視聴に使っていないチューナーを全部使って集められます
            (スキャンやロゴの取得は止めます)。
          </p>
          <!-- 局ロゴ。放送波から取得するしかない。番組表に出ないとき、取れていないのか出し方が悪いのかをここで見分ける -->
          <p>
            <strong>局ロゴ</strong
            >は番組表と一覧に出すもので、番組表を集めるときにあわせて取得します。
            放送波に流れるのは数十秒〜数分に一度、<strong
              >衛星は十数分に一度</strong
            >で、取れたロゴも1週間ごとに取り直します。
            点線の枠は、まだ取れていない局です。
          </p>
          <p>
            「ロゴをいますぐ集める」では衛星の分も集めます。<strong
              >BS と CS のロゴは同じ1つの中継で流れる</strong
            >ため、そこだけ最大20分かかります (他の中継は数秒で終わります)。
          </p>
          <p>
            <strong>CMロゴ</strong
            >は、CM検出のために録画から覚えたロゴの位置と形です。録画をエンコードするときに自動で覚えます。
            ロゴを押すと大きく見られます。ロゴの形になっていなければ、そこで「覚え直す」で消すと、次の録画で覚え直します。
          </p>
        {/snippet}
      </Lead>
    {/if}

    {#if coverage.length === 0}
      <!-- まだ1つも無い。表の場所の真ん中に、スキャンの欄と1行の案内 -->
      <div class="empty glow">
        <p class="small muted">
          チャンネルがまだありません。種別を選んでスキャンしてください
        </p>
        {@render scanControl()}
      </div>
    {:else}
      <div class="table-wrap channels-wrap">
        <table>
          <thead>
            <tr>
              <th>種別</th>
              <th>ch</th>
              <th class="wide">局</th>
              <th class="nowrap logo-col">局ロゴ</th>
              <th class="nowrap logo-col">CMロゴ</th>
              <th class="nowrap">番組表</th>
            </tr>
          </thead>
          <!--
                        **1行に1局。** 種別と ch はチャンネルの局の数だけ縦につなぐ (`rowspan`)。
                        ロゴは局ごとのものなので、局の行に1つずつ置く (チャンネルの行に並べると、どれがどの局か読めない)
                    -->
          <tbody data-testid="channel-list">
            {#each coverage as channel (`${channel.type}:${channel.channel}`)}
              {#each channel.services as service, index (service.id)}
                {@const logo = logoOf.get(service.id)}
                <tr
                  data-testid="channel-row"
                  data-channel={channel.channel}
                  data-service-id={service.id}
                  data-logo={logo?.logo}
                >
                  {#if index === 0}
                    <td class="nowrap small" rowspan={channel.services.length}>
                      {SERVICE_TYPE_LABEL[channel.type] ?? channel.type}
                    </td>
                    <td
                      class="mono small nowrap num"
                      rowspan={channel.services.length}
                    >
                      {channel.channel}
                    </td>
                  {/if}
                  <td class="small">
                    <span class="station">
                      <!-- 狭い幅では、ロゴの列をたたんで局名の前に出す -->
                      <span class="inline-logos">
                        {@render stationLogo(service.id, service.name, false)}
                        {@render cmLogo(service.id, service.name, false)}
                      </span>
                      <span class="broadcast">{service.name}</span>
                    </span>
                  </td>
                  <td class="logo-col"
                    >{@render stationLogo(service.id, service.name, true)}</td
                  >
                  <!-- まだ覚えていない局と、CM検出の対象でない局 (サブチャンネルなど) は空けておく -->
                  <td class="logo-col"
                    >{@render cmLogo(service.id, service.name, true)}</td
                  >
                  <td class="small nowrap num">
                    {#if service.programs > 0}
                      {service.programs} 件
                      <span class="tiny muted until"
                        >{until(service.until)}</span
                      >
                    {:else}
                      <span class="muted">—</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</div>

<LogoZoom target={zoomTarget} onclose={() => (zoom = null)} />

<!--
    局ロゴ。押すと大きく見る (`LogoZoom`)。まだのものは点線の枠、放送に載っていないものは列では「—」。
    `column` が偽のものは狭い幅で局名の前に出す写し (テスト ID は列のほうにだけ付ける)
-->
{#snippet stationLogo(id: number, name: string, column: boolean)}
  {@const state = logoOf.get(id)?.logo}
  {#if state === "have"}
    <button
      type="button"
      class="zoom"
      onclick={() => (zoom = { id, kind: "station" })}
      aria-label={`${name} のロゴを大きく見る`}
      data-testid={column ? "logo-zoom-station" : undefined}
    >
      <ServiceLogo {id} has style={LOGO_SIZE} />
    </button>
  {:else if state === "missing"}
    <span class="logo-slot" title="ロゴはまだ取れていません">
      <span class="visually-hidden">ロゴはまだ取れていません</span>
    </span>
  {:else if column}
    <span class="muted small" title="ロゴは放送に載っていません">—</span>
  {:else}
    <!-- 局名の頭がずれないよう、場所だけ空けておく -->
    <span class="logo-space"></span>
  {/if}
{/snippet}

<!--
    CM検出のために覚えたロゴ。線の向きがどのコマでも揃うところを白く出した画像で、ロゴの形になっていれば合っている。
    書き直すたびに URL を変えて、古い画像を出し続けないようにする。覚えていなければ何も出さない
-->
{#snippet cmLogo(id: number, name: string, column: boolean)}
  {@const at = logoOf.get(id)?.cm ?? null}
  {#if at !== null}
    <button
      type="button"
      class="zoom"
      onclick={() => (zoom = { id, kind: "cm" })}
      aria-label={`${name} のCMロゴを大きく見る`}
      data-testid={column ? "logo-zoom-cm" : undefined}
    >
      <img
        src={resolve(`api/services/${id}/logo-data?at=${at}`)}
        alt=""
        class="learned-image"
      />
    </button>
  {/if}
{/snippet}

<style>
  /* 種別を選ぶ欄とボタンを1組に。高さは隣の小さなボタンにそろえる */
  .scan-control {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
  }
  .scan-control select {
    width: auto;
    height: auto;
    margin: 0;
    padding: 0.3rem 2rem 0.3rem 0.6rem;
    font-size: var(--dp-text-sm);
  }
  .scan-control button {
    margin: 0;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--dp-space-3);
    padding: var(--dp-space-6) var(--dp-space-4);
    text-align: center;
  }
  .empty p {
    margin: 0;
  }
  /*
     * 受信できるチャンネルの表は、スマートフォンの幅では欄の間を詰める。
     * 局の欄が幅を取り、右端の「10/13 まで」が枠の外へ押し出されていた
     */
  .channels-wrap {
    container-type: inline-size;
  }
  @container (max-width: 32rem) {
    .channels-wrap th,
    .channels-wrap td {
      padding-inline: 0.3rem;
    }
  }
  /* ロゴの数は、チャンネル → 局 → 番組表の数のあとに少し離して並べる */
  .logo-counts {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    margin-left: var(--dp-space-3);
  }
  /*
     * **行は低く保つ。** 1行に1局で、ロゴは局名の字の高さほど (局ロゴ 1.35rem)。
     * 同じチャンネルの局は、種別と ch を縦につないでまとめて見せる
     */
  .channels-wrap td {
    padding-block: 0.3rem;
    vertical-align: middle;
  }
  .channels-wrap td[rowspan] {
    vertical-align: top;
  }
  .station {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  /* 局名は欄の幅で折り返す (全角の英数が続く局名でも) */
  .station .broadcast {
    overflow-wrap: anywhere;
  }
  /* 狭い幅で局名の前に出すロゴ。広い幅では列に出すので隠す */
  .inline-logos {
    display: none;
    align-items: center;
    gap: 0.25rem;
  }
  /* ロゴそのものを押して大きく見る (`LogoZoom`)。ボタンの地や余白は付けない */
  .zoom {
    display: inline-flex;
    width: auto;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: var(--dp-radius-sm);
    background: none;
    vertical-align: middle;
    cursor: zoom-in;
  }
  /* まだ取れていない局ロゴの場所。取れたロゴと同じ大きさの点線の枠 */
  .logo-slot,
  .logo-space {
    display: block;
    flex-shrink: 0;
    width: 2.4rem;
    height: 1.35rem;
  }
  .logo-slot {
    border: 1px dashed var(--dp-line-strong);
    border-radius: var(--dp-radius-sm);
  }
  /* CM検出のロゴ。縁を白で出すので、下地は暗いほうに寄せた枠色 */
  .learned-image {
    height: 1.35rem;
    max-width: 4.8rem;
    border-radius: var(--dp-radius-sm);
    object-fit: contain;
    image-rendering: pixelated;
    background: var(--dp-line);
  }
  /* **狭い幅ではロゴの列をたたみ、局名の前に出す** (表が横にはみ出さないように) */
  @container (max-width: 36rem) {
    .channels-wrap .logo-col {
      display: none;
    }
    .inline-logos {
      display: inline-flex;
    }
    /* 局の欄に余りを全部渡す指定 (`.wide`) を外す。100% の列があると、ほかの列の幅のぶん表が枠からはみ出す */
    .channels-wrap .wide {
      width: auto;
    }
    /* 「10/26 まで」は件数の下へ。横に並べると局名の欄が押されて、表が枠の外へはみ出す */
    .until {
      display: block;
    }
  }
</style>
