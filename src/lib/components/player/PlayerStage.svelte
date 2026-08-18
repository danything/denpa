<script lang="ts">
    import type { Snippet } from 'svelte';
    import type { PlayerControls } from './controls.svelte';

    /**
     * 絵の舞台。**3つの視聴画面 (ライブ・追っかけ・録画) で同じ配線を1本に。**
     *
     * 持つのは枠と、どの画面でも同じだった配線だけ:
     * - ポインタで操作列を出す/隠す・触らないとカーソルも消す (`controls`)
     * - キーボードで触っている間は操作列を残す (focusin/focusout)
     * - 全画面 — **枠ごと**入れる (映像だけでなく操作列も一緒に大きくする)
     *
     * 中身 (video・重ねる canvas・操作列) は画面ごとに違うので snippet で受ける。
     * 全画面の口は snippet の引数で渡す — ボタンは各画面の操作列にあるため。
     */
    interface Props {
        controls: PlayerControls;
        testid: string;
        /**
         * 画面ごとの背景・高さの決まり。共通の枠 (relative/overflow) はこちらが持つ。
         * 既定は**映像の周りは黒** (letterbox の帯にテーマ色を出さない) と、
         * 帯どうしが重ならない下限の高さ (`min-h-56`)
         */
        stageClass?: string;
        /** 枠そのもの。画面側で要るとき (録画視聴の開いた時点の全画面) に bind する */
        element?: HTMLElement | null;
        children: Snippet<[{ full: () => void; fullscreened: boolean }]>;
    }
    let {
        controls,
        testid,
        stageClass = 'bg-black aspect-video max-h-full min-h-56',
        element = $bindable(null),
        children,
    }: Props = $props();

    let fullscreened = $state(false);
    function full(): void {
        if (element === null) return;
        if (document.fullscreenElement === null) void element.requestFullscreen().catch(() => {});
        else void document.exitFullscreen().catch(() => {});
    }
    $effect(() => {
        const update = () => (fullscreened = document.fullscreenElement !== null);
        document.addEventListener('fullscreenchange', update);
        return () => document.removeEventListener('fullscreenchange', update);
    });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    bind:this={element}
    class="relative overflow-hidden {stageClass} {controls.shown ? '' : 'cursor-none'}"
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
    {@render children({ full, fullscreened })}
</div>
