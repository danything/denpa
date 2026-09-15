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
     * - **幕そのものは押させない** (`pointer-events: none`)。箱いっぱいに広がるので、
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

<div class="veil" class:dim={!holding} data-testid={testid} data-veiled={!holding}>
    {#if error !== ''}
        <div class="error">
            <div class="message">{error}</div>
            {#if actions}<div class="actions">{@render actions()}</div>{/if}
        </div>
    {:else if busy}
        <!-- 前の絵を貼っている間は、回っているものだけを小箱に入れる -->
        <span class="busy" class:boxed={holding}>
            <span class="spinner" aria-busy="true"></span>
            {#if note !== ''}<span class="note" data-testid="{testid}-note">{note}</span>{/if}
        </span>
    {:else if idle !== ''}
        <span class="idle">{idle}</span>
    {/if}
</div>

<style>
    .veil {
        pointer-events: none;
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
    }
    .dim {
        background: rgb(0 0 0 / 0.6);
    }
    .error {
        pointer-events: auto;
        padding: 1rem;
        text-align: center;
    }
    .message {
        font-weight: 500;
    }
    .actions {
        margin-top: 0.75rem;
    }
    .busy {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
    }
    .boxed {
        padding: 0.75rem;
        border-radius: 1rem;
        background: rgb(0 0 0 / 0.45);
    }
    /* Pico の aria-busy は文字の前に回るものを出す。大きく、白く */
    .spinner {
        font-size: 2.5rem;
        line-height: 1;
        --pico-color: #fff;
    }
    .note {
        font-size: 0.875rem;
    }
    .idle {
        color: rgb(255 255 255 / 0.6);
    }
</style>
