<script lang="ts">
  import type { SubmitFunction } from "$app/forms";
  import Trash from "~icons/lucide/trash-2";

  import { submitting } from "#lib/actions.js";
  import type { Arming } from "#lib/arming.svelte.js";
  import Icon from "#lib/components/player/Icon.svelte";

  /**
   * 戻せない操作のボタン。**1 回目で聞き返し、2 回目で送る** (`arming`。録画・予約・ルール・通知先の削除、
   * テレビのアプリの取消、ニコニコとの連携の解除、ほかの端末からのログアウトで同じ)。2 回目の文言は「<操作の名前>を確定」(docs/writing.md)。
   *
   * 2 回押しのキー (`armKey`) は同じ `deleting` を分け合う中で被らない値にする
   * (録画の一覧は録画と録り逃しの予約で共用するので、予約は負の値)
   */
  let {
    deleting,
    armKey,
    action = "?/delete",
    fields = {},
    submit,
    class: size = "",
    testid,
    confirmTestid = `${testid}-confirm`,
    icon = false,
    label = "削除",
    confirmLabel = "削除を確定",
  }: {
    deleting: Arming;
    armKey: number;
    action?: string;
    /** 一緒に送る隠し欄 (名前 → 値) */
    fields?: Record<string, string | number>;
    /** 送ったあとの始末 (`submitting` にそのまま渡す) */
    submit?: SubmitFunction;
    /** 大きさ (app.css の `xs` / `small`) */
    class?: string;
    testid: string;
    confirmTestid?: string;
    /** 字の前にごみ箱のアイコンを置く (一覧の行。どちらの段にも置くので幅は変わらない) */
    icon?: boolean;
    /** 1 回目のボタンの名前 */
    label?: string;
    /** 2 回目のボタンの名前。「<操作の名前>を確定」の形にする */
    confirmLabel?: string;
  } = $props();

  /** 送り終えたら 2 回押しを戻す。断られて行が残ったとき、「削除を確定」を出したままにしない */
  const sent: SubmitFunction = (input) => {
    const after = submit?.(input);
    return async (options) => {
      if (typeof after === "function") await after(options);
      else await options.update();
      deleting.fire();
    };
  };
</script>

<form method="POST" {action} use:submitting={sent}>
  {#each Object.entries(fields) as [name, value] (name)}
    <input type="hidden" {name} {value} />
  {/each}
  {#if deleting.armed === armKey}
    <button type="submit" class="{size} danger" data-testid={confirmTestid}>
      {#if icon}<Icon icon={Trash} size="size-4" />{/if}<span class="btn-label"
        >{confirmLabel}</span
      >
    </button>
  {:else}
    <button
      type="button"
      class="{size} outline danger"
      onclick={() => deleting.arm(armKey)}
      data-testid={testid}
    >
      {#if icon}<Icon icon={Trash} size="size-4" />{/if}<span class="btn-label"
        >{label}</span
      >
    </button>
  {/if}
</form>
