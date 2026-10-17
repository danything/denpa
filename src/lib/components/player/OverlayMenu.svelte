<script lang="ts" generics="T extends string | number">
    import { getContext, type Snippet } from 'svelte';
    import Menu, { type MenuTrigger } from '../Menu.svelte';
    import { PLAYER_CONTROLS, PLAYER_STAGE, type PlayerControls } from './controls.svelte';

    /**
     * 映像の上に出すドロップダウンの共通部分。**メニュー(選択肢の並び)だけ**を持つ。
     *
     * 3画面には、音声・字幕・エンコード方式・速さと、同じ形のドロップダウンが
     * いくつも並ぶ。項目を `{#each}` で敷き、押したら選んで閉じる、選択中は
     * `aria-current`、までが全部同じだった。ここに1つにまとめる。
     *
     * 開け閉めは `Menu` (popover。キーボードで辿れる・外を押すと閉じる)。最前面に出るので、
     * 舞台を全画面にしている間も隠れない。
     *
     * **トリガー(押すボタン)は呼び出し側が snippet で渡す。** アイコンの有無・
     * ラベルの出し方・`data-testid` が箇所ごとに違ううえ、テストはその testid を
     * 名指しで使うので、そこは各画面の持ち物のまま触らない。snippet は `Menu` の
     * 引き金の属性を受け取り、ボタン (`ControlButton`) にそのまま広げる。
     *
     * 選択肢の `data-testid` は `{testid}-option`、枠は `{testid}-menu`。
     * `attrName` を渡すと各選択肢に `data-{attrName}={key}` を付ける (テストが
     * 特定の選択肢を指すのに使う。例: `data-speed="1.5"`)
     */
    interface Item {
        /** 選択肢の値。`{#each}` の key、選んだときに `onselect` へ渡す値、`data-{attrName}` を兼ねる */
        key: T;
        label: string;
        /** いま選ばれているか (`aria-current`) */
        active: boolean;
        /** 並べるが押せない (互換モードでこの端末が描けない形式。`CodecMenu`) */
        disabled?: boolean;
    }

    let {
        trigger,
        items,
        onselect,
        testid,
        align = 'start',
        size = 'normal',
        attrName,
    }: {
        /** 押すボタン。受け取った属性を `<button>` (`ControlButton`) に広げる */
        trigger: Snippet<[MenuTrigger]>;
        items: Item[];
        onselect: (key: T) => void;
        /** 枠と選択肢の testid の頭 (`{testid}-menu` / `{testid}-option`) */
        testid: string;
        /** メニューをボタンのどちら端に揃えるか。右端に置くボタン (速さ) は `end` */
        align?: 'start' | 'end';
        /** 選択肢の文字の大きさ。速さは数字を大きく真ん中に (`large`) */
        size?: 'normal' | 'large';
        /** 付けるなら `data-{attrName}={key}` を各選択肢に足す */
        attrName?: string;
    } = $props();

    let open = $state(false);

    /**
     * **開いている間は操作列を残す。**
     *
     * 操作列は触らなくなって 2.5 秒で引っ込む (`controls.svelte.ts`) が、このメニューは
     * 操作列の中にあるので、選んでいる最中に**メニューごと消えて**いた。舞台
     * (`PlayerStage`) が context に置いた `controls` に伝える。舞台の外では何もしない
     */
    const controls = getContext<(() => PlayerControls) | undefined>(PLAYER_CONTROLS);
    $effect(() => {
        if (controls === undefined) return;
        controls().hold = open;
        return () => {
            controls().hold = false;
        };
    });

    /**
     * **メニューは舞台の枠の中に収める。** 枠の外へ出ると、上はページの見出しにかぶる。
     * スマホの縦で全画面をやめると枠は 224px しか無く、速さ (7つ) のメニューが上へはみ出していた。
     * 枠を当たり判定の境にして、入りきらなければメニューの中を巻き取る (`Menu` の `boundary`)。
     * 舞台の外 (と、枠がまだ無いうち) は画面に収める
     */
    const stage = getContext<(() => HTMLElement | null) | undefined>(PLAYER_STAGE);
</script>

<Menu bind:open side="top" {align} boundary={stage} {trigger} class="overlay-menu {size}" testid="{testid}-menu">
    {#each items as item (item.key)}
        {@const extra = attrName === undefined ? {} : { [`data-${attrName}`]: item.key }}
        <button
            type="button"
            role="menuitem"
            class="menu-item option"
            aria-disabled={item.disabled === true ? 'true' : undefined}
            data-disabled={item.disabled === true ? '' : undefined}
            onclick={() => {
                if (item.disabled !== true) onselect(item.key);
            }}
            data-testid="{testid}-option"
            data-active={item.active ? '' : undefined}
            aria-current={item.active ? 'true' : undefined}
            {...extra}
        >
            {item.label}
        </button>
    {/each}
</Menu>

<style>
    /*
     * **幅は中身で決める。ボタンより狭くはしない** (ボタンの幅は `Menu` が下限に置く)。メニューごとに
     * 決め打ち (音声 13rem・エンコード方式 9rem・速さ 6rem) にしていた頃は、2 択のエンコード方式にも
     * 名前の短い音声にも余白ばかりの箱が出て、タブレットで目立った
     */
    :global(.overlay-menu) {
        gap: 0.125rem;
        width: max-content;
        max-width: min(20rem, 90vw);
        padding: 0.5rem;
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
    /*
     * **狭い枠では速さを4列に並べる。** 縦に7つ積むと 300px あり、スマホの縦で
     * 全画面をやめた枠 (224px) には入らない — 巻き取らせると2つしか見えず、
     * 押したい速さを探してメニューの中を動かすことになる。
     * 開いているときだけ (`:popover-open`)。閉じているときの `display: none` を消さない
     */
    :global(.stage[data-compact] .overlay-menu.large:popover-open) {
        display: grid;
        grid-template-columns: repeat(4, auto);
    }
</style>
