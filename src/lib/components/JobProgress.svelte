<script lang="ts">
  import "@anyblades/blades/components/progress";
  import type { Snippet } from "svelte";

  /**
   * 時間の掛かる仕事の進み具合 (チャンネルスキャン・ロゴの取得・引き継ぎ・別の機械へ移す)。
   * **バーと「いくつ中いくつ」をいつも組で出す**。バーだけでは、止まっているのか
   * 遅いだけなのかが読めない。後ろに添えるもの (いま何をしているか) は `children`。
   * 動いているあいだは伸びたところを明るさで脈打たせる (`app.css` の `progress.running`)。
   * 中断・失敗で止まったものは脈打たせない。使う側が仕事の状態を `running` で渡す (渡さなければ終わっていないあいだ)
   */
  let {
    done,
    total,
    unit = "",
    testid,
    running,
    children,
  }: {
    done: number;
    total: number;
    unit?: string;
    testid?: string;
    running?: boolean;
    children?: Snippet;
  } = $props();
</script>

<progress
  value={done}
  max={Math.max(1, total)}
  class:running={running ?? done < total}
></progress>
<div class="tiny muted num" data-testid={testid}>
  <span>{done} / {total}{unit === "" ? "" : ` ${unit}`}</span
  >{#if children}{@render children()}{/if}
</div>
