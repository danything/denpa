<script lang="ts">
    import { onMount } from 'svelte';
    import { BRIGHT, OVERLAY, OVERLAY_BTN, OVERLAY_ON } from './icons';
    import Icon from './Icon.svelte';

    /**
     * 明るく出す。**ライブと観る画面で同じもの。**
     *
     * ## 端末の輝度は変えられない
     *
     * **ブラウザから画面の輝度を触る道はありません。** W3C に Screen Brightness
     * API の提案はありましたが、どのブラウザにも実装されていない (ネイティブの
     * 殻をかぶせたときだけ触れる領域)。できるのは2つだけで、両方やっています:
     *
     * - **絵そのものを持ち上げる** (CSS の `filter`)。送られてくる絵には
     *   触らないので、焼き直しも要らないし切り抜き (`watch` の `snapshot`) は
     *   素のまま残る
     * - **画面を暗くさせない** (`awake.svelte.ts` の Wake Lock)。出先で
     *   読めなくなる原因の半分は、端末が勝手に落とす明るさのほう
     *
     * ## 目盛りではなく二択
     *
     * 摘みで 50〜200% を選べるようにしていたが、**選ぶ場面が「明るいところで
     * 見えない」しか無い**。中間の値を選ぶ理由が誰にも無く、押すたびに
     * 引き出しを開けて摘みを掴むぶんだけ手間だった。
     *
     * **覚えるのは端末ごと** (`localStorage`)。同じ人でも、居間のテレビと
     * 出先のタブレットで要るものが違う。**画面をまたいで1つ** (鍵が同じ) —
     * ライブで上げたのに録画で戻っている、というのが無いように
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
     * 明るくしたときの倍率。
     *
     * **上げすぎると白く潰れる。** 1.4 は、暗い場面の輪郭が出るところと、
     * 明るい場面が飛ばないところの間で採った値
     */
    const BOOST = 1.4;

    onMount(() => {
        if (localStorage.getItem(KEY) === 'on') value = BOOST;
    });

    function toggle(): void {
        const on = value === 1;
        value = on ? BOOST : 1;
        try {
            localStorage.setItem(KEY, on ? 'on' : 'off');
        } catch {
            // 覚えられなくても観るのに支障は無い (プライベート窓など)
        }
    }
</script>

<button
    type="button"
    class="{OVERLAY_BTN} btn-circle {value === 1 ? OVERLAY : OVERLAY_ON}"
    onclick={toggle}
    aria-label={value === 1 ? '明るくする' : '明るさを元に戻す'}
    aria-pressed={value !== 1}
    data-testid={testid}
    data-brightness={value}
>
    <Icon path={BRIGHT} />
</button>
