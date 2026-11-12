<script lang="ts">
  import Lead from "#lib/components/Lead.svelte";

  import type { PageData } from "./$types";
  import AgentTuners from "./AgentTuners.svelte";

  let { data }: { data: PageData } = $props();
</script>

<!--
    **チューナーは 1 つの表。** いまの様子 (空き・使っているもの) と設定 (種別・使うか) を同じ行に並べる。
    名前・デバイス・LNB・削除は入れたときしか触らないので、行の「⋯」の中。
    カードリーダーも同じ機材の話なので、同じ節の下に置く。
    **表はエージェントごとに分け、エージェントの名前を見出しにする** (`AgentTuners.svelte`)。1 台でも見出しを出す
-->
<div class="sections">
  <section class="section" data-testid="tuner-section">
    <div class="section-head">
      <h2>チューナー</h2>
    </div>
    <!-- 譲り合う順は数字ではなく用途の並びで言う (順番は config.priority から) -->
    <Lead>
      足りないときは、決まった用途の順に使います
      {#snippet more()}
        <p>チューナーが足りないときは、上にある用途から先に使います。</p>
        <ol data-testid="tuner-yield-order">
          {#each data.yieldOrder as use (use)}
            <li>{use}</li>
          {/each}
        </ol>
        <p>ルールの「優先度」は予約どうしを比べるもので、この順とは別です。</p>
      {/snippet}
    </Lead>
    {#if data.tunerAgents.length === 0}
      <p class="small muted">
        エージェントがありません。上の「エージェントを追加」から登録してください。
      </p>
    {/if}
    {#each data.tunerAgents as agent (agent.id)}
      <AgentTuners {agent} />
    {/each}
  </section>
</div>
