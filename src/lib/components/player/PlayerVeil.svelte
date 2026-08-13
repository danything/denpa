<script lang="ts">
    import type { Snippet } from 'svelte';

    /**
     * 何も映っていない間の幕。**見た目の決まりを画面ごとに書かない** —
     * 敷きの濃さ・スピナーの大きさ・文字色が3画面で3種類に育っていた。
     *
     * - **前の絵を貼っている間 (`holding`) は塗り潰さない。** 覆ってしまうと
     *   貼っている意味が無くなる (実機で撮ると、前の絵が白くかすんだだけの
     *   画面になっていた)。回っているものだけを小箱に入れて、どんな絵の上でも
     *   見えるようにする
     * - **幕そのものは押させない** (`pointer-events-none`)。箱いっぱいに広がるので、
     *   そのままだと下の操作列を覆って押せなくなる。押しもの (`actions`) だけ戻す
     */
    interface Props {
        /** 前の絵を貼っているか (`live-player` の holding) */
        holding: boolean;
        /** 繋いでいる最中か。回っているものを出す */
        busy: boolean;
        /** busy に添える文言 (「繋ぎ直しています」)。空なら出さない */
        note?: string;
        /** 失敗の文言。あれば busy より先にこちらを出す */
        error?: string;
        /** エラーの下の押しもの (「やり直す」)。押せるようにするのは幕の側 */
        actions?: Snippet;
        /** busy でも error でもないときの文言 (「選んでください」)。空なら何も出さない */
        idle?: string;
        testid: string;
    }
    let { holding, busy, note = '', error = '', actions, idle = '', testid }: Props = $props();
</script>

<div
    class="pointer-events-none absolute inset-0 flex items-center justify-center text-white
           {holding ? '' : 'bg-black/60'}"
    data-testid={testid}
    data-veiled={!holding}
>
    {#if error !== ''}
        <div class="pointer-events-auto p-4 text-center">
            <div class="font-medium">{error}</div>
            {#if actions}<div class="mt-3">{@render actions()}</div>{/if}
        </div>
    {:else if busy}
        <!--
            敷くのは外側。daisyUI の `loading` は自分の background-color で
            回る絵を塗っているので、そこへ bg-* を足すと回るものの色を上書きする
        -->
        <span
            class="flex flex-col items-center gap-2 {holding ? 'rounded-box bg-black/45 p-3' : ''}"
        >
            <span class="loading loading-spinner loading-lg"></span>
            {#if note !== ''}<span class="text-sm" data-testid="{testid}-note">{note}</span>{/if}
        </span>
    {:else if idle !== ''}
        <span class="text-white/60">{idle}</span>
    {/if}
</div>
