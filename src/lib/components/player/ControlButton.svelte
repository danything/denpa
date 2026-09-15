<script lang="ts">
    import Icon from './Icon.svelte';
    import { OVERLAY, OVERLAY_BTN, OVERLAY_DANGER, OVERLAY_ON, OVERLAY_ROUND } from './icons';

    /**
     * 映像の上に置くボタン。**3画面 (ライブ・追っかけ・観る画面) で同じもの。**
     *
     * 黒く敷くのも、押されている間だけ色を変えるのも、`aria-pressed` を
     * 立てるのもここ1箇所。別々に書いていた頃は、画面ごとに敷き方も
     * 押されている表現も違っていた。
     *
     * 文字を添えるときは中身 (`children`) を渡す。**丸くなくなる** —
     * 「音声」「H.264」のように名前が要るものはライブ側にいくつかある
     */
    let {
        path,
        label,
        on = false,
        danger = false,
        submit = false,
        testid,
        onclick,
        children,
    }: {
        /** アイコンの `d` (`icons.ts`)。文字だけのボタンでは省く */
        path?: string;
        /** 読み上げに出す名前。押すと役目が変わるものは、いまの役目を書く */
        label: string;
        /** 押されている間か。字幕を出しているとき・ライブに居るときなど */
        on?: boolean;
        /** 押すと戻せないもの。**聞き返しの2回目**に立てる (`icons.ts` の `OVERLAY_DANGER`) */
        danger?: boolean;
        /** 中の `<form>` を送るボタンにする (削除など) */
        submit?: boolean;
        testid?: string;
        onclick?: () => void;
        children?: import('svelte').Snippet;
    } = $props();
</script>

<button
    type={submit ? 'submit' : 'button'}
    class="{OVERLAY_BTN} {children === undefined ? OVERLAY_ROUND : ''} {on
        ? OVERLAY_ON
        : danger
          ? OVERLAY_DANGER
          : OVERLAY}"
    {onclick}
    aria-label={label}
    aria-pressed={on}
    data-testid={testid}
>
    {#if path !== undefined}
        <Icon {path} />
    {/if}
    {@render children?.()}
</button>

<style>
    /*
     * **絵の上に置くボタンの見た目は、ここ1箇所** (`icons.ts` の OVERLAY*)。
     * 3画面とも ControlButton を読み込むので、`:global` にしておけば
     * `<a>` (閉じる) や EdgeButton にも届く。
     *
     * Pico はボタンの色を変数 (`--pico-background-color` など) で持つので、
     * 変数を差し替える。`:hover` などで Pico が主題の色に戻さないよう、同じ強さ以上で書く
     */
    :global(.ov-btn) {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.375rem;
        height: 3rem;
        min-height: 3rem;
        margin: 0;
        padding: 0 1.25rem;
        border: 0;
        border-radius: var(--pico-border-radius);
        box-shadow: none;
        font-size: 1.125rem;
        line-height: 1;
        text-decoration: none;
        white-space: nowrap;
        flex-shrink: 0;
        background-color: var(--pico-background-color);
        color: var(--pico-color);
    }
    :global(.ov-btn.ov-round) {
        width: 3rem;
        padding: 0;
        border-radius: 999px;
    }
    :global(.ov-btn.ov),
    :global(.ov) {
        --pico-background-color: rgb(0 0 0 / 0.45);
        --pico-border-color: transparent;
        --pico-color: #fff;
        --pico-box-shadow: none;
    }
    :global(.ov-btn.ov:is(:hover, :focus-visible)),
    :global(.ov:is(:hover, :focus-visible)) {
        --pico-background-color: rgb(0 0 0 / 0.7);
        --pico-color: #fff;
    }
    :global(.ov-btn.ov-on),
    :global(.ov-btn.ov-on:is(:hover, :focus-visible)) {
        --pico-background-color: var(--pico-primary-background);
        --pico-border-color: transparent;
        --pico-color: #fff;
        --pico-box-shadow: none;
    }
    :global(.ov-btn.ov-danger),
    :global(.ov-btn.ov-danger:is(:hover, :focus-visible)) {
        --pico-background-color: var(--dp-error);
        --pico-border-color: transparent;
        --pico-color: #fff;
        --pico-box-shadow: none;
    }
</style>
