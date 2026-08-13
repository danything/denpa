<script lang="ts" generics="T extends string | number">
    import type { Snippet } from 'svelte';

    /**
     * 絵の上に出すドロップダウンの共通部分。**メニュー(選択肢の並び)だけ**を持つ。
     *
     * 3画面には、音声・字幕・焼き方・速さと、同じ形のドロップダウンが
     * いくつも並ぶ。`<ul class="dropdown-content menu …">` から `{#each}` で
     * `<li><button>` を敷き、押したら選んで閉じる (`blur`)、選択中は `menu-active` と
     * `aria-current`、までが全部同じだった。ここに1つにまとめる。
     *
     * **トリガー(押すボタン)は呼び出し側が snippet で渡す。** アイコンの有無・
     * ラベルの出し方・`data-testid` が箇所ごとに違ううえ、テストはその testid を
     * 名指しで掴むので、そこは各画面の持ち物のまま触らない。
     *
     * 選択肢の `data-testid` は `{testid}-option`、器は `{testid}-menu`。
     * `attrName` を渡すと各選択肢に `data-{attrName}={key}` を付ける (テストが
     * 特定の選択肢を掴むのに使う。例: `data-speed="1.5"`)
     */
    interface Item {
        /** 選択肢の値。`{#each}` の key、選んだときに `onselect` へ渡す値、`data-{attrName}` を兼ねる */
        key: T;
        label: string;
        /** いま選ばれているか (`menu-active` と `aria-current`) */
        active: boolean;
    }

    let {
        trigger,
        items,
        onselect,
        testid,
        position = 'dropdown-top',
        menuClass = 'w-52',
        optionClass = '',
        attrName,
    }: {
        /** 押すボタン。`.dropdown` の直下に置くので、そのまま `<button>` を書く */
        trigger: Snippet;
        items: Item[];
        onselect: (key: T) => void;
        /** 器と選択肢の testid の頭 (`{testid}-menu` / `{testid}-option`) */
        testid: string;
        /** daisyUI の開く向き (`dropdown-top` / `dropdown-top dropdown-end` など) */
        position?: string;
        /** 器の幅ほか、箇所ごとに違うクラス (`w-52` / `w-36 text-base` / `w-24 gap-1 text-lg`) */
        menuClass?: string;
        /** 各選択肢のボタンに足すクラス (速さの `tabular-nums justify-center py-2` など) */
        optionClass?: string;
        /** 付けるなら `data-{attrName}={key}` を各選択肢に足す */
        attrName?: string;
    } = $props();
</script>

<div class="dropdown {position}">
    {@render trigger()}
    <ul
        class="dropdown-content menu bg-base-100 text-base-content rounded-box z-10 mb-1 p-2 shadow-lg {menuClass}"
        data-testid="{testid}-menu"
    >
        {#each items as item (item.key)}
            {@const extra = attrName === undefined ? {} : { [`data-${attrName}`]: item.key }}
            <li>
                <button
                    type="button"
                    class="{optionClass} {item.active ? 'menu-active' : ''}"
                    onclick={(event) => {
                        onselect(item.key);
                        // 選んだら閉じる。開きっぱなしだと絵を覆う
                        event.currentTarget.blur();
                    }}
                    data-testid="{testid}-option"
                    aria-current={item.active ? 'true' : undefined}
                    {...extra}
                >
                    {item.label}
                </button>
            </li>
        {/each}
    </ul>
</div>
