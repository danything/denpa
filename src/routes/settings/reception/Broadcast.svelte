<script lang="ts">
  import { autosave, SaveState } from "#lib/autosave.svelte.js";
  import Lead from "#lib/components/Lead.svelte";
  import SaveNote from "#lib/components/SaveNote.svelte";
  import { PREFECTURE_UNSET, PREFECTURES } from "#lib/prefecture.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  /** 保存の結果 (`autosave`)。見出しの横に出す */
  const save = new SaveState();
</script>

<!--
    **データ放送に渡すもの。** 郵便番号と都道府県。
    テレビの初期設定で必ず訊かれるあれで、放送のアプリはこれを読んで
    天気・地域のニュース・防災情報をどこのものにするかを決める。
    置き場をサーバにしてあるのは**端末ごとに訊き直さずに済ませる**ため。
    郵便番号から都道府県を引くことはしない (表を抱えることになる)。並べて置いて、両方入れてもらう。
    郵便番号は欄を離れたとき・Enter で保存する (打っている途中では送らない)
-->
<div class="sections readable">
  <section class="section">
    <div class="section-head">
      <h2>データ放送</h2>
      <SaveNote status={save} />
    </div>
    <Lead>
      データ放送 (d ボタン) の地域を、郵便番号と都道府県で決めます
      {#snippet more()}
        <p>
          テレビの初期設定で入れる郵便番号と都道府県です。データ放送の
          <strong>天気・地域のニュース・防災情報</strong
          >は、これで地域が決まります。
        </p>
        <p>
          郵便番号が未設定だと「郵便番号が正しく設定されていません」と表示され、その欄は空のままです。
        </p>
        <p>都道府県で地域の情報を出し分ける局もあります。</p>
      {/snippet}
    </Lead>
    <form
      method="POST"
      action="?/saveBroadcast"
      use:autosave={save}
      class="fields setting-rows"
    >
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
            <option
              value={PREFECTURE_UNSET}
              selected={data.broadcast.prefecture === PREFECTURE_UNSET}
            >
              未設定
            </option>
            {#each PREFECTURES as prefecture (prefecture.code)}
              <option
                value={prefecture.code}
                selected={data.broadcast.prefecture === prefecture.code}
              >
                {prefecture.name}
              </option>
            {/each}
          </select>
        </label>
      </div>
      <!-- **空にできる。** 空は「渡さない」という選び方で、危なくない -->
      <span class="hint"
        >郵便番号は数字7桁
        (ハイフンは有っても無くても可)。空にすると設定しません</span
      >

      <!--
                **双方向。既定はオン** (テレビと同じく、データ放送の通信の項目が開く)。
                オンだと denpa のサーバが放送局のサーバと代わりに通信します。
                何に繋いでよいかの決め方は `server/bml-network.ts`。視聴の記録が送られうることは
                説明の1行目に出す (隠さない)
            -->
      <div class="check-item">
        <label class="check-row">
          <input
            type="checkbox"
            name="bmlNetwork"
            checked={data.broadcast.bmlNetwork}
            data-testid="bml-network"
          />
          <span>双方向 (通信系コンテンツ) を使う</span>
        </label>
        <Lead class="indent">
          オンのときは放送局のサーバと通信し、<strong
            >応募や投票、視聴の記録が放送局へ送られることがあります</strong
          >
          {#snippet more()}
            <p>
              オンにすると、denpa が放送局のサーバと代わりに通信します
              (受信も送信も)。
              データ放送の通信の項目が開き、放送の画面から送る応募や投票、利用状況の調査
              (どの番組のデータ放送を見たか) もそのまま送られます。
            </p>
            <p>
              オフのときは、放送側に「インターネットに接続されていません」と表示されます。
            </p>
          {/snippet}
        </Lead>
      </div>
    </form>
  </section>
</div>

<style>
  .wrap-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--dp-space-3);
  }
  .w-postal {
    width: 10rem;
  }
</style>
