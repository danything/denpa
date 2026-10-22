<script lang="ts">
    import { tick } from 'svelte';
    import Menu from '../Menu.svelte';
    import ControlButton from './ControlButton.svelte';
    import { stageMenu } from './controls.svelte';
    import Icon from './Icon.svelte';
    import { BACK, CHECK, FORWARD, SETTINGS } from './icons';
    import type { SettingAction, SettingChoice, SettingRow, SettingToggle } from './settings';

    /**
     * 再生の設定 (⚙)。**3画面 (ライブ・追っかけ・観る画面) で同じもの。**
     *
     * 端末ごとに決めて、たいていは決めたまま観るもの (CMスキップ・アンビエントモード・バックグラウンド再生・
     * 互換モード・字幕の言語・音声・コーデック) を1つにまとめる (並べるものは `StageTail` が決める)。
     * 1つずつボタンにしていた頃は操作バーに押すものが並びすぎ、
     * 毎回使うもの (再生・シーク・音・速さ) が埋もれていた。
     *
     * **速さと字幕の出し入れは操作バーにも置く。** 速さは観ながら何度も変え、変えている間は数字がボタンに出る
     * (`SpeedMenu`)。字幕は番組ごとに出し入れし、`c` キーとも対になっている。⚙ の「字幕」の行は言語まで選べる
     * (オフ・字幕のストリーム・言語。`settings.ts` の `subtitles`)
     *
     * - 上の並び: 切り替えが先、選ぶものが後 (YouTube と同じ)。切り替えは押すとその場で変わり、閉じない
     *   (`menuitemcheckbox` + `aria-checked`)。選ぶものは行にいまの値を出し、押すと選択肢の並びに入る
     * - 選択肢の並び: 先頭が「戻る」行。選ぶと閉じる (`menuitemradio` + `aria-checked`)。
     *   Esc か ← で上の並びへ戻る (上の並びの Esc は閉じる。`Menu`)
     *
     * **狭い枠では、操作バーから畳んだもの (`head`) を上の並びの頭に置く** — 音・速さ・小窓など。「ほか」(⋯) のボタンを
     * 別に置いていた頃は、狭い操作バーに ⋯ と ⚙ が並んでいた。押すものは押したら閉じ、切り替えはその場で変わる。
     * いつもの行との間は線で分ける
     *
     * testid: ボタンは `{prefix}-settings`、枠は `{prefix}-settings-menu`、行は `{prefix}-{id}`、
     * 選択肢は `{prefix}-{id}-option` に `data-{id}={key}` (例: `data-codec="av1"`)
     */
    let {
        prefix,
        head = [],
        toggles,
        choices,
    }: {
        /** testid の頭 (`watch` / `chase` / `live`) */
        prefix: string;
        /** 狭い枠で操作バーから畳んだもの。上の並びの頭に置く */
        head?: SettingRow[];
        toggles: SettingToggle[];
        choices: SettingChoice[];
    } = $props();

    let open = $state(false);
    /** 開いている選択肢の並び (`SettingChoice` の `id`)。上の並びなら null */
    let view = $state<string | null>(null);
    const opened = $derived(
        [...head.filter((row) => row.kind === 'choice'), ...choices].find((c) => c.id === view),
    );
    let pane = $state<HTMLElement | null>(null);

    // 閉じたら上の並びに戻しておく。次に開いたとき途中から始まらないように
    $effect(() => {
        if (!open) view = null;
    });
    /**
     * **開いている選択肢の並びが無くなったら、上の並びへ戻る** (音声が2本から1本に減ったときなど)。
     * 消えた項目にいたフォーカスは上の並びの先頭へ移す (そのままだと行き場を失って、↑↓が効かなくなる)
     */
    $effect(() => {
        if (view === null || opened !== undefined) return;
        view = null;
        void tick().then(() => {
            // 消えた項目にいたときだけ (フォーカスは body に落ちている)。ほかを触っているなら奪わない
            if (document.activeElement !== null && document.activeElement !== document.body) return;
            pane?.querySelector<HTMLElement>('.menu-item')?.focus({ preventScroll: true });
        });
    });

    /** 開いている間は操作列を残し、メニューは舞台の枠の中に収める (`stageMenu`) */
    const stage = stageMenu(() => open);

    /** 並びを替え、フォーカスを移す (入ったら選ばれているもの、戻ったら入った行) */
    async function go(next: string | null): Promise<void> {
        const from = view;
        view = next;
        await tick();
        const target =
            next === null
                ? pane?.querySelector<HTMLElement>(`[data-setting="${from}"]`)
                : (pane?.querySelector<HTMLElement>('.option[data-active]:not([data-disabled])') ??
                  pane?.querySelector<HTMLElement>('.option:not([data-disabled])'));
        target?.focus({ preventScroll: true });
    }

    function onkeydown(event: KeyboardEvent): void {
        if (view !== null && (event.key === 'Escape' || event.key === 'ArrowLeft')) {
            event.preventDefault();
            void go(null);
        } else if (view === null && event.key === 'ArrowRight') {
            const id = (event.target as HTMLElement).closest<HTMLElement>('[data-choice]')?.dataset[
                'setting'
            ];
            if (id === undefined) return;
            event.preventDefault();
            void go(id);
        }
    }
</script>

{#snippet action(item: SettingAction)}
    <button
        type="button"
        role="menuitem"
        class="menu-item setting"
        data-setting={item.id}
        data-testid="{prefix}-{item.id}"
        onclick={() => item.run()}
    >
        <Icon icon={item.icon} />
        <span class="label">{item.label}</span>
    </button>
{/snippet}

{#snippet toggle(item: SettingToggle)}
    <button
        type="button"
        role="menuitemcheckbox"
        class="menu-item setting"
        aria-checked={item.on}
        data-keep-open={item.closes === true ? undefined : ''}
        data-setting={item.id}
        data-testid="{prefix}-{item.id}"
        onclick={() => item.toggle()}
    >
        <Icon icon={item.icon} />
        <span class="label">{item.label}</span>
        <span class="switch" data-on={item.on ? '' : undefined} aria-hidden="true"></span>
    </button>
{/snippet}

{#snippet choice(item: SettingChoice)}
    <button
        type="button"
        role="menuitem"
        class="menu-item setting"
        aria-haspopup="menu"
        data-keep-open
        data-choice
        data-setting={item.id}
        data-testid="{prefix}-{item.id}"
        onclick={() => go(item.id)}
    >
        <Icon icon={item.icon} />
        <span class="label">{item.label}</span>
        <span class="value">{item.value}</span>
        <Icon icon={FORWARD} />
    </button>
{/snippet}

<Menu
    bind:open
    side="top"
    align="end"
    boundary={stage}
    class="overlay-menu settings-menu"
    testid="{prefix}-settings-menu"
>
    {#snippet trigger(menu)}
        <ControlButton {menu} icon={SETTINGS} label="再生の設定" testid="{prefix}-settings" />
    {/snippet}
    <!-- svelte-ignore a11y_no_static_element_interactions -- キーは中の項目から上がってくるものを受けるだけ -->
    <div class="pane" bind:this={pane} {onkeydown}>
        {#if opened === undefined}
            {#each head as row (row.id)}
                {#if row.kind === 'action'}
                    {@render action(row)}
                {:else if row.kind === 'toggle'}
                    {@render toggle(row)}
                {:else}
                    {@render choice(row)}
                {/if}
            {/each}
            {#if head.length > 0}<hr class="split" />{/if}
            {#each toggles as item (item.id)}
                {@render toggle(item)}
            {/each}
            {#each choices as item (item.id)}
                {@render choice(item)}
            {/each}
        {:else}
            <button
                type="button"
                role="menuitem"
                class="menu-item setting back"
                data-keep-open
                data-testid="{prefix}-settings-back"
                onclick={() => go(null)}
            >
                <Icon icon={BACK} />
                <span class="label">{opened.label}</span>
            </button>
            {#each opened.options as option (option.key)}
                <button
                    type="button"
                    role="menuitemradio"
                    class="menu-item option"
                    aria-checked={option.active}
                    aria-disabled={option.disabled === true ? 'true' : undefined}
                    data-disabled={option.disabled === true ? '' : undefined}
                    data-active={option.active ? '' : undefined}
                    data-testid="{prefix}-{opened.id}-option"
                    {...{ [`data-${opened.id}`]: option.key }}
                    onclick={() => {
                        if (option.disabled !== true) opened.pick(option.key);
                    }}
                >
                    <span class="mark">
                        {#if option.active}<Icon icon={CHECK} />{/if}
                    </span>
                    {option.label}
                </button>
            {/each}
        {/if}
    </div>
</Menu>

<style>
    /*
     * **幅は上の並びと選択肢の並びで変えない。** 入るたびに枠の幅が変わると、押した位置から行が逃げる。
     * 名前と値が1行に収まる幅から。**値は省かずに出したい** (音声の「主音声ステレオ (日本語)」など) ので、
     * 映像の上のほかのメニュー (20rem まで) より広く取り、それでも入らなければ値だけ2行に折る
     */
    :global(.overlay-menu.settings-menu) {
        min-width: 17rem;
        max-width: min(24rem, 90vw);
    }
    .pane {
        display: contents;
    }
    /* 畳んだものといつもの行の境目。線は面の線の色で、上下を少し空ける */
    .split {
        margin: 0.25rem 0;
        border: 0;
        border-top: 1px solid var(--dp-line);
    }
    .setting {
        padding: 0.5rem 0.75rem;
    }
    .setting :global(svg) {
        flex-shrink: 0;
        width: 1.25rem;
        height: 1.25rem;
    }
    .label {
        flex: 1 1 auto;
        white-space: nowrap;
        padding-inline-end: 0.75rem;
    }
    /*
     * 値は名前と同じ大きさの字で、色だけ控える。長い値は2行まで右にそろえて折り、
     * それでも入らないぶんだけ「…」で止める
     */
    .value {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        min-width: 0;
        max-width: 13rem;
        overflow: hidden;
        font-size: inherit;
        line-height: 1.3;
        text-align: right;
        color: var(--dp-muted);
    }
    .back {
        border-bottom: 1px solid var(--dp-line);
        border-radius: 0;
        margin-bottom: 0.125rem;
    }
    /* 選択肢の左に、選んでいる印の幅を取っておく (選んだものだけずれないように) */
    .mark {
        display: inline-flex;
        width: 1.25rem;
        flex-shrink: 0;
    }
    .mark :global(svg) {
        width: 1rem;
        height: 1rem;
    }
    /* オン/オフのスイッチ。状態は行の `aria-checked` で読ませ、これは見た目だけ */
    .switch {
        position: relative;
        flex-shrink: 0;
        width: 2.25rem;
        height: 1.25rem;
        border-radius: var(--dp-radius-full);
        /* 切っているときの地は文字色を薄めたもの。線の色 (`--dp-line`) では暗いほうで面に沈む */
        background: color-mix(in srgb, currentColor 28%, transparent);
        transition: background-color var(--dp-duration) var(--dp-ease);
    }
    .switch::after {
        content: '';
        position: absolute;
        top: 0.125rem;
        left: 0.125rem;
        width: 1rem;
        height: 1rem;
        border-radius: var(--dp-radius-full);
        background: #fff;
        box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);
        transition: transform var(--dp-duration) var(--dp-ease);
    }
    /*
     * 入っているときも主の色 (青) は使わない (青はリンクとフォーカスだけ)。白を濃く敷いた溝にし、
     * 入り切りは丸の位置でも分かる。メニューの面はいつも暗い磨りガラス (app.css の `.overlay-menu`)
     */
    .switch[data-on] {
        background: rgb(255 255 255 / 0.6);
    }
    .switch[data-on]::after {
        transform: translateX(1rem);
    }
</style>
