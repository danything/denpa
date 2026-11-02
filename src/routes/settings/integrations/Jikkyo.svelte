<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { onMount } from "svelte";

  import { autosave, SaveState } from "#lib/autosave.svelte.js";
  import ActionButton from "#lib/components/ActionButton.svelte";
  import Lead from "#lib/components/Lead.svelte";
  import SaveNote from "#lib/components/SaveNote.svelte";
  import { dateTime } from "#lib/format.js";
  import { NG_LENGTH, NG_MAX } from "#lib/jikkyo/ng.js";
  import { homeHost } from "#lib/niconico.js";

  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const save = new SaveState();
  /** 連携を始めるリンク (サーバが hub へ送る。`niconico/link`) */
  const linkHref = resolve("/settings/integrations/niconico/link");

  /** 連携を始められなかったとき (リンクの移動なので、理由は URL に載って戻ってくる) */
  const linkError = $derived(page.url.searchParams.get("niconico_error"));
  /**
   * 名前で開いている (`tv.example.com` など) か。hub はそこへ結果を返さないので、LAN のアドレスで開き直すよう案内する。
   * 止めはしない (hub を置く人が名前を足していれば通る)。サーバで描くときは分からないので、開いてから見る
   */
  let named = $state(false);
  onMount(() => {
    named = !homeHost(location.hostname);
  });
</script>

<!--
    **実況のコメント (世帯の設定。既定はオフ)。** オンにすると、端末の ⚙ に「実況」の行が出る
    (端末ごとのオン・オフはそちら)。コメントは denpa のサーバを通らず、端末が NX-Jikkyo と
    過去ログ API に直接繋ぐ。相手に何が見えるかと、書き込んだものが公開されて消せないことは説明の頭に出す (隠さない。docs/architecture.md)
-->
<div class="sections readable">
  <section class="section">
    <div class="section-head">
      <h2>実況</h2>
      <SaveNote status={save} />
    </div>
    <form
      method="POST"
      action="?/saveJikkyo"
      use:autosave={save}
      class="fields setting-rows"
    >
      <div class="check-item">
        <label class="check-row">
          <input
            type="checkbox"
            name="jikkyo"
            checked={data.jikkyo}
            data-testid="jikkyo-setting"
          />
          <span>ニコニコ実況のコメントを流せるようにする</span>
        </label>
        <Lead class="indent">
          オンにすると、実況をオンにした端末が外のサービスに直接繋ぎます。<strong
            >相手には端末の IP と、どの局をいつ観ているかが見えます</strong
          >。ライブでは NX-Jikkyo に書き込めます。<strong
            >書いたものは公開され、消せません</strong
          >
          {#snippet more()}
            <p>
              ライブと録画に、ニコニコ実況のコメントを流せるようにします。流すかどうかは、端末ごとに再生の設定
              (⚙) の「実況」で決めます。
            </p>
            <p>
              コメントは denpa のサーバを通りません。端末が NX-Jikkyo
              (tsukumijima さんが運営する非公式のサービス) とニコニコ実況
              過去ログ API に直接繋ぎます。相手と、その前に立つ Cloudflare
              には、端末の IP・ブラウザの種類・denpa のアドレス
              (ホスト名)・どの局をいつ観ているかが見えます。録画の一覧やログインの情報は出ません。
            </p>
            <p>
              ライブの局の一覧の「実況」タブ (勢いの順) だけは、denpa のサーバが
              NX-Jikkyo から勢いを読んで渡します (端末の IP は見えません)。
            </p>
            <p>
              書き込みは、ライブで映像の右端の「コメントの一覧」で開く一覧の下
              (全画面では同じボタンの「実況に書く」) から、端末が NX-Jikkyo
              に直接送ります。ニコニコのアカウントは使わず匿名ですが、書き込みには
              NX-Jikkyo が端末の IP とブラウザの種類などから作る ID
              が付くので、同じ端末から書いたものは結び付けられます。
            </p>
          {/snippet}
        </Lead>
      </div>
      <!-- NG ワード。1 行に 1 語。欄を離れたときに保存する (打っている途中では送らない) -->
      <label class="field">
        <span class="field-label">NG ワード</span>
        <textarea
          name="jikkyoNg"
          rows="4"
          spellcheck="false"
          value={data.jikkyoNg.join("\n")}
          data-testid="jikkyo-ng"></textarea>
        <span class="hint"
          >1 行に 1
          語。含むコメントは流しません。全角・半角、英字の大小、ひらがな・カタカナの違いは区別しません
          ({NG_MAX}
          語まで・1 語 {NG_LENGTH} 文字まで)</span
        >
      </label>
    </form>
    <!--
        ニコニコのアカウントとの連携 (世帯で 1 つ。`server/niconico.ts`)。トークンは denpa のサーバだけが持つ。
        連携は denpa-hub が中継し、結果は `niconico/return` に戻る。外すのは手元のトークンを消すだけで、
        ニコニコの側の許可はニコニコのアカウント設定から取り消す (ニコニコに失効のエンドポイントが無い)
    -->
    <div class="fields niconico" data-testid="niconico">
      <span class="field-label">ニコニコのアカウント</span>
      {#if data.niconico.state === "linked"}
        <div class="niconico-row">
          <span class="small grow" data-testid="niconico-state"
            >連携中・ユーザー ID {data.niconico.userId}・{dateTime(
              data.niconico.linkedAt,
            )} から</span
          >
          <ActionButton
            action="?/unlinkNiconico"
            class="small outline danger"
            testid="niconico-unlink"
          >
            連携を外す
          </ActionButton>
        </div>
      {:else}
        {#if data.niconico.state === "lost"}
          <div class="notice error" data-testid="niconico-state">
            連携が切れました。ニコニコで許可が取り消されたか、更新できなくなったためです。もう一度連携してください
          </div>
        {/if}
        <div class="niconico-row">
          <a
            class="button small outline"
            href={linkHref}
            data-sveltekit-reload
            data-testid="niconico-link">ニコニコと連携</a
          >
        </div>
        <span class="hint"
          >ニコニコのアカウントで実況に書き込むための連携です (世帯で 1
          つ)。トークンは denpa のサーバだけが持ち、端末には渡しません</span
        >
        {#if named}
          <span class="hint" data-testid="niconico-named"
            >いまの名前で開いていると、連携の結果が戻ってこないことがあります。LAN
            のアドレス (http://192.168.1.20:3000 など)
            で開いてから押してください</span
          >
        {/if}
      {/if}
      {#if linkError !== null}
        <div class="notice error" data-testid="niconico-error">
          {linkError}
        </div>
      {/if}
    </div>
  </section>
</div>

<style>
  .niconico {
    margin-top: var(--dp-space-3);
  }
  .niconico-row {
    display: flex;
    align-items: center;
    gap: var(--dp-space-3);
  }
</style>
