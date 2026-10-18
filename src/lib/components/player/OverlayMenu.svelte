<script lang="ts" generics="T extends string | number">
    import type { Snippet } from 'svelte';
    import Menu, { type MenuTrigger } from '../Menu.svelte';
    import { stageMenu } from './controls.svelte';

    /**
     * 映像の上に出すドロップダウン (速さ。`SpeedMenu`)。**メニュー(選択肢の並び)だけ**を持つ。
     * 項目を `{#each}` で敷き、押したら選んで閉じる、選択中は `aria-current`。
     * 音声・字幕・コーデックは再生の設定 (⚙ `SettingsMenu`) の選択肢の並びにある。
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
        testid?: string | undefined;
        /** メニューをボタンのどちら端に揃えるか。右端に置くボタン (速さ) は `end` */
        align?: 'start' | 'end';
        /** 選択肢の文字の大きさ。速さは数字を大きく真ん中に (`large`) */
        size?: 'normal' | 'large';
        /** 付けるなら `data-{attrName}={key}` を各選択肢に足す */
        attrName?: string;
    } = $props();

    let open = $state(false);
    /** 開いている間は操作列を残し、メニューは舞台の枠の中に収める (`stageMenu`) */
    const stage = stageMenu(() => open);
</script>

<Menu bind:open side="top" {align} boundary={stage} {trigger} class="overlay-menu {size}" testid={testid && `${testid}-menu`}>
    {#each items as item (item.key)}
        {@const extra = attrName === undefined ? {} : { [`data-${attrName}`]: item.key }}
        <button
            type="button"
            role="menuitem"
            class="menu-item option"
            onclick={() => onselect(item.key)}
            data-testid={testid && `${testid}-option`}
            data-active={item.active ? '' : undefined}
            aria-current={item.active ? 'true' : undefined}
            {...extra}
        >
            {item.label}
        </button>
    {/each}
</Menu>

<style>
    /* 箱と選択肢の地は `SettingsMenu` と同じなので app.css (`.overlay-menu`) に置く。ここは速さの並べ方だけ */
    :global(.overlay-menu.large) {
        gap: 0.25rem;
        font-size: var(--dp-text-lg);
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
     * grid にするのは開いているときだけ (`:popover-open`)。閉じているときの `display: none` を消さない。
     * 列の数は閉じる動きの間も持たせる (外すと、閉じる間だけ縦 1 列に戻って見える)
     */
    :global(.stage[data-compact] .overlay-menu.large) {
        grid-template-columns: repeat(4, auto);
    }
    :global(.stage[data-compact] .overlay-menu.large:popover-open) {
        display: grid;
    }
</style>
