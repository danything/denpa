<script lang="ts" generics="T extends string | number">
    import { DropdownMenu } from 'bits-ui';
    import type { Snippet } from 'svelte';

    /**
     * 絵の上に出すドロップダウンの共通部分。**メニュー(選択肢の並び)だけ**を持つ。
     *
     * 3画面には、音声・字幕・焼き方・速さと、同じ形のドロップダウンが
     * いくつも並ぶ。項目を `{#each}` で敷き、押したら選んで閉じる、選択中は
     * `aria-current`、までが全部同じだった。ここに1つにまとめる。
     *
     * 開け閉めは Bits UI の DropdownMenu (キーボードで辿れる・外を押すと閉じる)。
     * **器は portal に出さない** — 全画面にしているのは舞台の枠なので、`body` へ
     * 出すと全画面の間は見えなくなる。
     *
     * **トリガー(押すボタン)は呼び出し側が snippet で渡す。** アイコンの有無・
     * ラベルの出し方・`data-testid` が箇所ごとに違ううえ、テストはその testid を
     * 名指しで掴むので、そこは各画面の持ち物のまま触らない。ボタンは包みの `<span>`
     * の中に入り、押したのが包みまで届いて開く。
     *
     * 選択肢の `data-testid` は `{testid}-option`、器は `{testid}-menu`。
     * `attrName` を渡すと各選択肢に `data-{attrName}={key}` を付ける (テストが
     * 特定の選択肢を掴むのに使う。例: `data-speed="1.5"`)
     */
    interface Item {
        /** 選択肢の値。`{#each}` の key、選んだときに `onselect` へ渡す値、`data-{attrName}` を兼ねる */
        key: T;
        label: string;
        /** いま選ばれているか (`aria-current`) */
        active: boolean;
    }

    let {
        trigger,
        items,
        onselect,
        testid,
        align = 'start',
        width = '13rem',
        size = 'normal',
        attrName,
    }: {
        /** 押すボタン。包みの `<span>` の中に置くので、そのまま `<button>` を書く */
        trigger: Snippet;
        items: Item[];
        onselect: (key: T) => void;
        /** 器と選択肢の testid の頭 (`{testid}-menu` / `{testid}-option`) */
        testid: string;
        /** 器を口のどちら端に揃えるか。右端に置く口 (速さ) は `end` */
        align?: 'start' | 'end';
        /** 器の幅 */
        width?: string;
        /** 選択肢の文字の大きさ。速さは数字を大きく真ん中に (`large`) */
        size?: 'normal' | 'large';
        /** 付けるなら `data-{attrName}={key}` を各選択肢に足す */
        attrName?: string;
    } = $props();

    let open = $state(false);

    /** 引き金の props から `type` を抜く(下の包みの span の説明) */
    function withoutType(props: Record<string, unknown>): Record<string, unknown> {
        const { type: _type, ...rest } = props;
        return rest;
    }
</script>

<DropdownMenu.Root bind:open>
    <DropdownMenu.Trigger>
        {#snippet child({ props })}
            <!--
                Bits UI は引き金に `type="button"` を付ける。包みの span に付くと Pico がボタンの余白と枠を当て、
                帯が 1 段ぶん高くなる(実測 45px → 60.5px)。包みには要らないので外す
            -->
            <span {...withoutType(props)} class="trigger">{@render trigger()}</span>
        {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content
        side="top"
        {align}
        sideOffset={4}
        class="overlay-menu {size}"
        style="width: {width}"
        data-testid="{testid}-menu"
    >
        {#each items as item (item.key)}
            {@const extra = attrName === undefined ? {} : { [`data-${attrName}`]: item.key }}
            <DropdownMenu.Item
                class="option"
                textValue={item.label}
                onSelect={() => onselect(item.key)}
                data-testid="{testid}-option"
                data-active={item.active ? '' : undefined}
                aria-current={item.active ? 'true' : undefined}
                {...extra}
            >
                {item.label}
            </DropdownMenu.Item>
        {/each}
    </DropdownMenu.Content>
</DropdownMenu.Root>

<style>
    .trigger {
        display: inline-flex;
    }
    :global(.overlay-menu) {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
        padding: 0.5rem;
        color: var(--pico-color);
    }
    :global(.overlay-menu .option) {
        padding: 0.4rem 0.75rem;
    }
    :global(.overlay-menu .option[data-active]) {
        background: var(--pico-primary-background);
        color: #fff;
    }
    :global(.overlay-menu.large) {
        gap: 0.25rem;
        font-size: 1.125rem;
    }
    :global(.overlay-menu.large .option) {
        justify-content: center;
        padding: 0.5rem;
        font-variant-numeric: tabular-nums;
    }
</style>
