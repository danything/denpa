<script lang="ts">
  import Lead from "#lib/components/Lead.svelte";

  import type { PageData } from "./$types";
  import AgentTuners from "./AgentTuners.svelte";

  let { data }: { data: PageData } = $props();
</script>

<!--
    **表はエージェントごとに分け、エージェントの名前を見出しにする** (`AgentTuners.svelte`)。1 台でも見出しを出す。
    表とカードリーダーの作りは `AgentTuners.svelte` の説明
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
    {#if data.tunerRefusal !== null}
      <p class="small muted">{data.tunerRefusal}</p>
    {:else if data.tunerAgents.length === 0}
      <p class="small muted">
        エージェントがありません。上の「エージェントを追加」から登録してください。
      </p>
    {/if}
    {#each data.tunerAgents as agent (agent.id)}
      <AgentTuners {agent} />
    {/each}
  </section>
</div>
