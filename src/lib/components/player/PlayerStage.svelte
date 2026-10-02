<script lang="ts">
    import { type Snippet, setContext } from 'svelte';
    import { PLAYER_CONTROLS, PLAYER_STAGE, type PlayerControls } from './controls.svelte';

    /**
     * 絵の舞台。**3つの視聴画面 (ライブ・追っかけ・録画) で同じ配線を1本に。**
     *
     * 持つのは枠と、どの画面でも同じだった配線だけ:
     * - ポインタで操作列を出す/隠す・触らないとカーソルも消す (`controls`)
     * - キーボードで触っている間は操作列を残す (focusin/focusout)
     * - 全画面 — **枠ごと**入れる (映像だけでなく操作列も一緒に大きくする)
     * - 枠の大きさから、操作列の詰め方を決める (`compact` / `low`。下の説明)
     *
     * 中身 (video・重ねる canvas・操作列) は画面ごとに違うので snippet で受ける。
     * 全画面の口は snippet の引数で渡す — ボタンは各画面の操作列にあるため。
     */
    interface Props {
        controls: PlayerControls;
        testid: string;
        /** 枠そのもの。画面側で要るとき (録画視聴の開いた時点の全画面) に bind する */
        element?: HTMLElement | null;
        children: Snippet<[StageApi]>;
    }
    interface StageApi {
        full: () => void;
        fullscreened: boolean;
        /** 狭い枠か (スマホの縦)。**押すものを減らして「ほか」に畳む** */
        compact: boolean;
        /** 「ほか」を開いているか */
        more: boolean;
        toggleMore: () => void;
    }
    let {
        controls,
        testid,
        element = $bindable(null),
        children,
    }: Props = $props();

    // 中のメニュー (`OverlayMenu`) が「開いている間は操作列を残せ」と言う先。取り手で渡す (props は差し替わりうる)
    setContext(PLAYER_CONTROLS, () => controls);
    // メニューを枠の中に収める先 (`OverlayMenu`)。bind で入るので取り手で渡す
    setContext(PLAYER_STAGE, () => element);

    let fullscreened = $state(false);
    function full(): void {
        if (element === null) return;
        if (document.fullscreenElement === null) void element.requestFullscreen().catch(() => {});
        else void document.exitFullscreen().catch(() => {});
    }
    /**
     * **枠の大きさで操作列の詰め方を変える。**
     *
     * 操作列は 48px の丸を横に9個、右の縦列に4個並べる作り (`ControlBar`) で、
     * 絵が 476px 幅・340px 高あることを前提にしている。スマホの縦 (390px 幅) で
     * 全画面をやめると枠は 358x224 しか無く、**下の帯が二段に折れて絵を覆い、
     * 右の縦列 (閉じる・切り抜き・削除) が帯のシークバーや再生ボタンに重なって**
     * いた (実機の報告「全画面じゃないと操作ボタンがおかしくなる」)。
     *
     * - `compact` (幅 448px 未満) … 押すものを 40px に縮め、毎回は使わないもの
     *   (音声・送り・焼き方・速さなど) を「ほか」(⋯) に畳む。読みものは
     *   一行にして押すものの上へ。スマホは縦でいちばん広いもので 398px。
     *   縦の iPad (絵が 476px) はここに入れない — あちらは 48px の9個が一段に
     *   収まるように幅を決めてある
     * - `low` (高さ 360px 未満) … 右の縦列を横に寝かせて右上の一行にする。縦に
     *   4個積むと 228px、下の帯が 112px で、それより低い枠では重なる (スマホの横や
     *   縦の iPad の二段組)。**大きさは変えない**。狭い枠も低い (224px) ので、
     *   `compact` のときは必ずこちらも立てる
     *
     * 全画面にすると枠が画面いっぱいになるので、横持ちの全画面はどちらにも
     * 当たらない (今までどおり)。**決めるのは媒体の幅ではなく枠の大きさ** —
     * 同じ画面幅でも、二段組かどうかで絵の幅がまるで違う
     */
    let compact = $state(false);
    let low = $state(false);
    $effect(() => {
        const target = element;
        if (target === null) return;
        const measure = () => {
            compact = target.clientWidth < 448;
            low = target.clientHeight < 360;
        };
        measure();
        const watcher = new ResizeObserver(measure);
        watcher.observe(target);
        return () => watcher.disconnect();
    });

    /**
     * 「ほか」(⋯) を開いているか。**操作列が引っ込んだら閉じる** — 開いたまま
     * 残すと、次に出したときに絵の半分を覆った状態から始まる
     */
    let more = $state(false);
    $effect(() => {
        if (!controls.shown || !compact) more = false;
    });

    $effect(() => {
        const update = () => (fullscreened = document.fullscreenElement !== null);
        document.addEventListener('fullscreenchange', update);
        return () => document.removeEventListener('fullscreenchange', update);
    });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!--
    **映像の周りは黒** (letterbox の帯にテーマ色を出さない)。形は 16:9 で、高さは
    画面に収まるまで。**低くしすぎない** (224px) — 上下と右に帯を重ねるので、
    それより低いと帯どうしが重なって押せなくなる
-->
<div
    bind:this={element}
    class="stage"
    class:quiet={!controls.shown}
    data-compact={compact ? '' : undefined}
    data-low={low || compact ? '' : undefined}
    data-more={more ? '' : undefined}
    onpointermove={controls.wake}
    onpointerdown={controls.wake}
    onpointerleave={controls.away}
    onfocusin={(event) => {
        /*
         * **キーボードで来たときだけ残す。**
         *
         * `focusin` は**マウスで押したときにも飛ぶ**ので、そのまま真にすると
         * ボタンを1回押しただけで焦点がそこに残り、**操作列が消えなくなる**
         * (焦点が枠の外へ出るまで居座る)。`:focus-visible` はキーボードで
         * 辿ってきたときにだけ立つので、それで見分ける
         */
        const target = event.target;
        controls.keyboard = target instanceof Element && target.matches(':focus-visible');
    }}
    onfocusout={() => (controls.keyboard = false)}
    data-testid={testid}
>
    {@render children({ full, fullscreened, compact, more, toggleMore: () => (more = !more) })}
</div>

<style>
    .stage {
        position: relative;
        overflow: hidden;
        background: #000;
        aspect-ratio: 16 / 9;
        max-height: 100%;
        min-height: 14rem;
    }
    .quiet {
        cursor: none;
    }
</style>
