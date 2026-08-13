<script lang="ts">
    /**
     * 映像と重ねものの束 (ライブ・追っかけ)。録画視聴は video の配線が
     * まるで違う (src 再生・続き・CM飛ばし) ので、こちらは使わない。
     *
     * - `video` … 絵。**備え付けの操作 (`controls`) は出さない** — あれの
     *   再生位置は「持っている範囲」を尺として描くので絶えず動く
     * - `still` … 切り替えの間、前の絵を貼っておく canvas (`live-player` の freeze)。
     *   映像より上 (黒を隠す)、字幕より下 (切り替え中も字幕は見えていてほしい)
     * - `overlay` … 放送の字幕。文字ではなく**絵**で届くので canvas に重ねる
     * - 入れ物 (`box`) … データ放送に「映像はここ」と伝える先。**枠そのものを
     *   渡すと親子が循環する** (`DataBroadcast`)
     *
     * **class ではなく style で書く** — データ放送を出している間、この入れ物は
     * BML の閉じた影の中へ移され、表の CSS (Tailwind) が届かない。しかも BML の
     * 既定は div に width:0 を与えるので、class だと映像が消える。
     */
    interface Props {
        /** 前の絵を貼っているか (`live-player` の holding)。still の見せ方 */
        holding: boolean;
        /** 字幕を出しているか。canvas の data-on に写す (見た目はページ側の paint) */
        captionsOn: boolean;
        onclick: (event: MouseEvent) => void;
        /** data-testid の接頭辞。`<prefix>-video` / `-still` / `-captions` になる */
        prefix: string;
        video?: HTMLVideoElement | null;
        still?: HTMLCanvasElement | null;
        overlay?: HTMLCanvasElement | null;
        box?: HTMLElement | null;
    }
    let {
        holding,
        captionsOn,
        onclick,
        prefix,
        video = $bindable(null),
        still = $bindable(null),
        overlay = $bindable(null),
        box = $bindable(null),
    }: Props = $props();
</script>

<div bind:this={box} style="position:absolute; inset:0; width:100%; height:100%;">
    <!-- svelte-ignore a11y_media_has_caption -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <video
        bind:this={video}
        style="width:100%; height:100%; background:#000;"
        playsinline
        {onclick}
        data-testid="{prefix}-video"
    ></video>
    <canvas
        bind:this={still}
        style="position:absolute; inset:0; width:100%; height:100%;
               object-fit:contain; pointer-events:none;
               transition:opacity 150ms; opacity:{holding ? 1 : 0};"
        data-testid="{prefix}-still"
        data-holding={holding}
        aria-hidden="true"
    ></canvas>
    <canvas
        bind:this={overlay}
        style="position:absolute; inset:0; width:100%; height:100%;
               object-fit:contain; pointer-events:none;"
        data-testid="{prefix}-captions"
        data-on={captionsOn}
        aria-hidden="true"
    ></canvas>
</div>
