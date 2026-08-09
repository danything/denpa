<script lang="ts">
    import { onMount } from 'svelte';
    import { BRIGHT, OVERLAY, OVERLAY_BTN, OVERLAY_ON } from './icons';
    import Icon from './Icon.svelte';

    /**
     * 画面の明るさ。**ライブと観る画面で同じもの。**
     *
     * 端末そのものの明るさは上げきっていても、**出先の明るいところでは
     * 暗い場面が読めない**。そこを持ち上げるための飾り (CSS の `filter`) で、
     * 送られてくる絵そのものには触らない — 焼き直しも要らないし、
     * 切り抜き (`watch` の `snapshot`) は素のまま残る。
     *
     * **覚えるのは端末ごと** (`localStorage`)。同じ人でも、居間のテレビと
     * 出先のタブレットで要る明るさが違う。速さ (`watch-speed`) と同じ理由で、
     * 続きの位置のようにサーバへは置かない。
     *
     * **画面をまたいで1つ**にしてある (鍵が同じ) — ライブで上げたのに録画で
     * 戻っている、というのが無いように
     */
    let {
        value = $bindable(1),
        testid,
    }: {
        /** 掛ける倍率。1 が素のまま */
        value?: number;
        testid?: string;
    } = $props();

    const KEY = 'player-brightness';
    /**
     * 動かせる幅。**暗くするほうも要る** — 寝る前に暗い部屋で観るときは
     * 逆に眩しい。上は 2倍まで (それ以上は白飛びして、かえって読めない)
     */
    const MIN = 0.5;
    const MAX = 2;
    const STEP = 0.05;

    onMount(() => {
        const saved = Number(localStorage.getItem(KEY));
        if (Number.isFinite(saved) && saved >= MIN && saved <= MAX) value = saved;
    });

    function set(next: number): void {
        value = Math.min(Math.max(next, MIN), MAX);
        try {
            localStorage.setItem(KEY, String(value));
        } catch {
            // 覚えられなくても観るのに支障は無い (プライベート窓など)
        }
    }

    /** 素のままかどうか。変えている間だけボタンを塗る */
    const touched = $derived(Math.abs(value - 1) > 0.001);
</script>

<div class="dropdown dropdown-top dropdown-end">
    <button
        class="{OVERLAY_BTN} btn-circle {touched ? OVERLAY_ON : OVERLAY}"
        aria-label="画面の明るさ"
        data-testid={testid}
        data-brightness={value}
    >
        <Icon path={BRIGHT} />
    </button>
    <div
        class="dropdown-content bg-base-100 text-base-content rounded-box z-10 mb-1 w-56 p-3 shadow-lg"
        data-testid="{testid}-menu"
    >
        <div class="mb-2 flex items-center justify-between text-sm">
            <span>明るさ</span>
            <span class="tabular-nums">{Math.round(value * 100)}%</span>
        </div>
        <!--
            **押した勢いを切らない。** `oninput` で効かせるので、摘みを
            動かしている間そのまま絵が変わる
        -->
        <input
            type="range"
            class="range range-sm range-primary w-full"
            min={MIN}
            max={MAX}
            step={STEP}
            {value}
            oninput={(event) => set(Number(event.currentTarget.value))}
            aria-label="画面の明るさ"
            data-testid="{testid}-range"
        />
        <button class="btn btn-sm btn-block mt-2" onclick={() => set(1)} data-testid="{testid}-reset">
            素のまま
        </button>
    </div>
</div>
