<script lang="ts">
  import { autosave, SaveState } from "#lib/autosave.svelte.js";
  import Lead from "#lib/components/Lead.svelte";
  import SaveNote from "#lib/components/SaveNote.svelte";
  import { dateTime } from "#lib/format.js";

  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const save = new SaveState();
</script>

<!--
  **番組ランキング (世帯の設定。既定はオフ)。** オンにすると、サーバが denpa-hub からトークンを受け取り、
  終わっていない予約を 6 時間ごとに送る (`server/ranking.ts`)。何を送り、何を送らないかは説明の 1 行目に出す (隠さない)。
  順位は検索を言葉なしで開いたときの節「人気の番組」に出す (`search/+page.svelte`)
-->
<div class="sections readable">
  <section class="section">
    <div class="section-head">
      <h2>番組ランキング</h2>
      <SaveNote status={save} />
    </div>
    <form
      method="POST"
      action="?/saveRanking"
      use:autosave={save}
      class="fields setting-rows"
    >
      <div class="check-item">
        <label class="check-row">
          <input
            type="checkbox"
            role="switch"
            name="ranking"
            checked={data.ranking.state === "on"}
            data-testid="ranking-setting"
          />
          <span>番組ランキングに参加する</span>
        </label>
        <Lead class="indent">
          予約した番組を denpa-hub (Doa が動かすサーバ)
          に送り、ほかの家と合わせた順位を見られるようにします。家のアドレスや名前は送りません
          {#snippet more()}
            <p>
              送るのは、終わっていない地上波・BS・CS の予約
              (予約済みと競合。録画中も)
              の、局と番組の識別・始まりの時刻と長さ・番組名・局名・ジャンルだけです。有料放送の番組も送ります。ルールの条件
              (キーワードなど)・予約した時刻・家のアドレス・利用者の名前は送りません。ケーブルの自主放送とスカパー！プレミアムの局の予約は送りません
            </p>
            <p>
              送るのは 6
              時間ごとで、前に送ってから変わった分だけです。時刻は家ごとにずらしてあり、毎回少しずつ揺らします。送れなかったときは次の送信にまとめます
            </p>
            <p>
              オフにすると、送った予約を denpa-hub
              で取り消してから、参加に使っていたトークンを消します。denpa-hub
              に届かなかったときも手元は消し、送った予約は放送が終わると
              denpa-hub から消えます
            </p>
            <p>
              denpa-hub
              は家ごとの予約の組み合わせを残さず、番組ごとに家の数を数えるだけです。予約した家が少ない番組は順位に出しません。作りは
              <a
                href="https://github.com/danything/denpa-hub/blob/main/docs/ranking.md"
                target="_blank"
                rel="noreferrer">denpa-hub の docs/ranking.md</a
              > にあります
            </p>
          {/snippet}
        </Lead>
      </div>
      {#if data.ranking.state === "on"}
        {#if data.ranking.failure === "disabled"}
          <div class="notice error" data-testid="ranking-state">
            denpa-hub
            が番組ランキングを受け付けていません。次の送信で再試行します
          </div>
        {:else if data.ranking.failure === "unreachable"}
          <div class="notice error" data-testid="ranking-state">
            denpa-hub に届きませんでした。次の送信で再試行します
          </div>
        {:else}
          <span class="hint" data-testid="ranking-state"
            >{data.ranking.sentAt === null
              ? "まだ送っていません"
              : `最後に送った時刻: ${dateTime(data.ranking.sentAt)}`}</span
          >
        {/if}
      {/if}
    </form>
  </section>
</div>
