<script lang="ts">
  import { autosave, SaveState } from "#lib/autosave.svelte.js";
  import Lead from "#lib/components/Lead.svelte";
  import SaveNote from "#lib/components/SaveNote.svelte";
  import { NG_LENGTH, NG_MAX } from "#lib/jikkyo/ng.js";

  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const save = new SaveState();
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
              書き込みは、ライブで映像の右端の「実況に書く」から、端末が
              NX-Jikkyo
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
  </section>
</div>
