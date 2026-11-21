<script lang="ts">
  import { autosave, SaveState } from "#lib/autosave.svelte.js";
  import Lead from "#lib/components/Lead.svelte";
  import SaveNote from "#lib/components/SaveNote.svelte";
  import { dateTime } from "#lib/format.js";
  import { RANKING_CONSENT } from "#lib/ranking.js";

  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const save = new SaveState();
</script>

<!--
  **番組ランキング (世帯の設定。既定はオフ)。** オンにすると、サーバが denpa-hub からトークンを受け取り、
  予約と、終わった番組の録画・ライブ・録画の再生を 6 時間ごとに送る (`server/ranking.ts`・`server/ranking-watch.ts`)。
  何を送り、何を送らないかと、集計の数を外部に示すことがあることは説明の 1 行目に出す (隠さない。同意の文。`#lib/ranking.ts`)。
  順位は検索を言葉なしで開いたときの節「人気の番組」に出す (`search/+page.svelte`)。まだ決めていない家には、同じ場所に参加の案内を出す
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
          {RANKING_CONSENT}
          {#snippet more()}
            <p>
              送るのは、地上波・BS・CS
              の番組の、局と番組の識別・始まりの時刻と長さ・番組名・局名・ジャンルと、その番組を予約したか・ライブで観たか・録画したか・録画で観たかだけです。ライブで観たと録画で観たは、合わせて
              5 分以上 (10 分より短い番組は長さの半分)
              観たものだけで、観た時刻と長さは送りません。録画で観たは、追っかけと、放送が終わって
              7 日以内の再生です。有料放送の番組も送ります。ルールの条件
              (キーワードなど)・予約した時刻・家の住所・利用者の名前は送りません。ケーブルの自主放送とスカパー！プレミアムの局は送りません
            </p>
            <p>
              送るのは 6
              時間ごとで、前に送ってから変わった分だけです。観た番組と録画した番組は、番組が終わってから送ります。時刻は家ごとにずらしてあり、毎回少しずつ揺らします。送れなかったときは次の送信にまとめます
            </p>
            <p>
              オフにすると、送ったものを denpa-hub
              で取り消してから、参加に使っていたトークンを消します。denpa-hub
              に届かなかったときも手元は消し、送ったものは放送が終わって 8
              日たつと denpa-hub から消えます
            </p>
            <p>
              denpa-hub
              は家ごとの組み合わせを残さず、番組ごとに家の数を数えるだけです。予約した家と観た家が少ない番組は順位に出しません。放送が終わって
              8 日たつと、番組ごとに録画した家・ライブで観た家・録画で観た家の数
              (5 の倍数に切り下げたもの)
              だけを残し、家を特定できない集計として外部 (放送局など)
              に示すことがあります。残した数は、オフにしても取り消せません。作りは
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
