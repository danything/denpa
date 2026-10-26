<script lang="ts">
  import "@anyblades/blades/components/progress";
  import type { Snippet } from "svelte";

  /**
   * 時間の掛かる仕事の進み具合 (チャンネルスキャン・ロゴの取得・引き継ぎ)。
   * **バーと「いくつ中いくつ」をいつも組で出す** — バーだけでは、止まっているのか
   * 遅いだけなのかが読めない。後ろに添えるもの (いま何をしているか) は `children`。
   * 終わっていないあいだはバーの上に光の筋を流す (`app.css` の `progress.running`)
   */
  let {
    done,
    total,
    unit = "",
    testid,
    children,
  }: {
    done: number;
    total: number;
    unit?: string;
    testid?: string;
    children?: Snippet;
  } = $props();
</script>

<progress value={done} max={Math.max(1, total)} class:running={done < total}
></progress>
<div class="tiny muted num" data-testid={testid}>
  <span>{done} / {total}{unit === "" ? "" : ` ${unit}`}</span>
  {#if children}{@render children()}{/if}
</div>
