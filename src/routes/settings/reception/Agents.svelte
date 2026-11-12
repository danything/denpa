<script lang="ts">
  import Ellipsis from "~icons/lucide/ellipsis";
  import Link from "~icons/lucide/link";
  import Pencil from "~icons/lucide/pencil";
  import Plus from "~icons/lucide/plus";
  import Trash from "~icons/lucide/trash-2";

  import { submitting } from "#lib/actions.js";
  import { arming } from "#lib/arming.svelte.js";
  import Lead from "#lib/components/Lead.svelte";
  import Menu from "#lib/components/Menu.svelte";
  import Icon from "#lib/components/player/Icon.svelte";
  import { time } from "#lib/format.js";
  import { held } from "#lib/live-updates.svelte.js";
  import type { AgentState } from "#lib/server/agent-admin.js";

  import type { PageData } from "./$types";
  import AgentDialog from "./AgentDialog.svelte";

  let { data }: { data: PageData } = $props();

  /** 削除は 2 回押し (ほかの一覧と同じ。`arming`) */
  const deleting = arming('[data-testid^="agent-delete"]');
  /** 開いている窓 (登録・URL を変える) */
  let dialog = $state<
    { kind: "add" } | { kind: "move"; id: number; name: string } | null
  >(null);
  /** 名前を変えている行 */
  let renaming = $state<number | null>(null);

  /** エージェントに訊く様子。読み直しの間も前の中身を出したままにする (`held`) */
  const states = held(() => data.agentStates);
  const stateOf = (id: number): AgentState | undefined =>
    states.value?.find((state) => state.id === id);
  /** LAN で見つかった、まだ登録していないエージェント (「エージェントを追加」の候補) */
  const found = held(() => data.foundAgents);

  /**
   * 2 段目に「・」でつなぐもの。ホスト・チューナーの台数・バージョン・環境変数で決めたもの・繋がらない時刻。
   * 台数とバージョンは届くまで出さない
   */
  function facts(
    agent: PageData["agents"][number],
    state: AgentState | undefined,
  ): string[] {
    const out = [agent.host];
    if (state?.tuners != null) out.push(`チューナー ${state.tuners} 台`);
    if (state?.version != null) out.push(state.version);
    if (agent.fromEnv) out.push("環境変数");
    if (state?.downSince != null)
      out.push(`繋がりません (${time(state.downSince)} から)`);
    return out;
  }
</script>

<svelte:window onclick={deleting.stand} />

<!--
  **エージェントは 1 台 1 件の一覧** (docs/design.md の「何行かある一覧」)。1 段目は名前、2 段目はホスト・台数・バージョン・状態。
  名前を変える・URL を変える・削除は右端の「⋯」。環境変数 (TUNER_AGENT_URL) で決めたものは、URL と削除を環境変数が持つ
-->
<div class="sections readable">
  <section class="section" data-testid="agent-section">
    <div class="section-head">
      <h2>エージェント</h2>
    </div>
    <Lead>
      チューナーとカードリーダーを動かすエージェントです
      {#snippet more()}
        <p>
          エージェントは何台でも登録できます。どのエージェントのチューナーを使うかは
          denpa
          が決め、録画とライブはその局を受信できるエージェントに振り分けます。
        </p>
        <p>
          登録用の URL は、エージェントのログか <span class="mono"
            >denpa-agent --pair</span
          > に出ます。登録できるのは同じ世帯の機器だけです。
        </p>
      {/snippet}
    </Lead>

    {#if data.agents.length === 0}
      <p class="small muted" data-testid="agent-empty">
        エージェントがありません
      </p>
    {:else}
      <div class="item-list" data-testid="agent-list">
        {#each data.agents as agent (agent.id)}
          {@const state = stateOf(agent.id)}
          <div class="agent item" data-testid="agent-row">
            <div class="grow">
              {#if renaming === agent.id}
                <form
                  method="POST"
                  action="?/renameAgent"
                  class="rename"
                  use:submitting={() =>
                    async ({ update }) => {
                      await update();
                      renaming = null;
                    }}
                >
                  <input type="hidden" name="id" value={agent.id} />
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    name="name"
                    value={agent.name}
                    maxlength="40"
                    aria-label="名前"
                    autofocus
                    data-testid="agent-name-input"
                  />
                  <button
                    type="submit"
                    class="small"
                    data-testid="agent-name-save">保存</button
                  >
                  <button
                    type="button"
                    class="small ghost"
                    onclick={() => (renaming = null)}>閉じる</button
                  >
                </form>
              {:else}
                <div class="name" data-testid="agent-name">{agent.name}</div>
              {/if}
              <div class="small muted" data-testid="agent-facts">
                {facts(agent, state).join("・")}
              </div>
              {#if state?.trouble != null}
                <div class="small text-error" data-testid="agent-trouble">
                  {state.trouble === "changed"
                    ? "証明書が変わりました。登録用の URL を貼り直してください"
                    : "エージェントにこの denpa の登録がありません。登録用の URL を貼り直してください"}
                </div>
              {/if}
              {#if state?.versionDiffers}
                <div class="small text-warn" data-testid="agent-version">
                  ⚠ denpa とバージョンが違います ({state.version})。同じバージョンに揃えてください
                </div>
              {/if}
              {#if state?.rawVisible === false}
                <div class="small text-warn" data-testid="agent-raw">
                  ⚠ 元の TS の置き場が見えません (録画のあとで復号できません)
                </div>
              {/if}
              {#if deleting.armed === agent.id && (state?.recordings.length ?? 0) > 0}
                <div class="small" role="alert">
                  このエージェントで録画中の番組があります ({state?.recordings.join(
                    "、",
                  )})。削除したあとに録画が途切れると、このエージェントでは取り直しません
                </div>
              {/if}
            </div>
            <div class="row-actions">
              {#if state?.trouble != null && !agent.fromEnv}
                <button
                  type="button"
                  class="small secondary outline"
                  onclick={() =>
                    (dialog = { kind: "move", id: agent.id, name: agent.name })}
                  >URL を変える</button
                >
              {/if}
              <Menu side="bottom" align="end" lazy testid="agent-menu">
                {#snippet trigger(props)}
                  <button
                    {...props}
                    type="button"
                    class="ghost icon"
                    title="操作"
                    data-testid="agent-more"
                  >
                    <Icon icon={Ellipsis} size="size-4" /><span
                      class="visually-hidden">{agent.name} の操作</span
                    >
                  </button>
                {/snippet}
                <button
                  type="button"
                  role="menuitem"
                  class="menu-item"
                  onclick={() => (renaming = agent.id)}
                  data-testid="agent-rename"
                >
                  <Icon icon={Pencil} size="size-4" />名前を変える
                </button>
                {#if agent.fromEnv}
                  <!-- 宛先と削除は環境変数が持ち主 -->
                  <p class="menu-note small muted" data-testid="agent-env-note">
                    TUNER_AGENT_URL から消すと外れます
                  </p>
                {:else}
                  <button
                    type="button"
                    role="menuitem"
                    class="menu-item"
                    onclick={() =>
                      (dialog = {
                        kind: "move",
                        id: agent.id,
                        name: agent.name,
                      })}
                    data-testid="agent-move"
                  >
                    <Icon icon={Link} size="size-4" />URL を変える
                  </button>
                  <form
                    method="POST"
                    action="?/removeAgent"
                    class="menu-form"
                    use:submitting={() =>
                      async ({ update }) => {
                        await update();
                        deleting.fire();
                      }}
                  >
                    <input type="hidden" name="id" value={agent.id} />
                    {#if deleting.armed === agent.id}
                      <button
                        type="submit"
                        role="menuitem"
                        class="menu-item menu-danger"
                        data-testid="agent-delete-confirm"
                      >
                        <Icon icon={Trash} size="size-4" />削除を確定
                      </button>
                    {:else}
                      <button
                        type="button"
                        role="menuitem"
                        class="menu-item"
                        data-keep-open
                        onclick={() => deleting.arm(agent.id)}
                        data-testid="agent-delete"
                      >
                        <Icon icon={Trash} size="size-4" />削除
                      </button>
                    {/if}
                  </form>
                {/if}
              </Menu>
            </div>
          </div>
        {/each}
      </div>
    {/if}
    <div class="cluster actions">
      <button
        type="button"
        class="small secondary outline"
        onclick={() => (dialog = { kind: "add" })}
        data-testid="agent-add"
      >
        <Icon icon={Plus} size="size-4" />エージェントを追加
      </button>
    </div>
  </section>
</div>

<AgentDialog
  target={dialog}
  found={found.value ?? []}
  onclose={() => (dialog = null)}
/>

<style>
  /* 1 件が 2 行あるので件の面 (`app.css` の `.item`) に乗せる (テレビのアプリの一覧と同じ) */
  .agent {
    display: flex;
    align-items: center;
    gap: var(--dp-space-3);
    min-height: var(--dp-item-h);
    padding: var(--dp-space-2) var(--dp-space-3);
  }
  .name {
    overflow-wrap: anywhere;
  }
  .row-actions {
    display: flex;
    align-items: center;
    gap: var(--dp-space-2);
  }
  .row-actions button {
    margin: 0;
  }
  .rename {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--dp-space-2);
    margin-bottom: var(--dp-space-1);
  }
  .rename input {
    flex: 1 1 10rem;
    margin: 0;
  }
  .rename button {
    margin: 0;
  }
  .actions {
    margin-top: var(--dp-space-3);
  }
  .actions button {
    margin: 0;
  }
</style>
