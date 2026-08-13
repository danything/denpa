<script lang="ts">
    import Icon from './Icon.svelte';
    import { OVERLAY, OVERLAY_BTN, OVERLAY_DANGER, OVERLAY_ON } from './icons';

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
    class="{OVERLAY_BTN} {children === undefined ? 'btn-circle' : 'gap-1.5'} {on
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
