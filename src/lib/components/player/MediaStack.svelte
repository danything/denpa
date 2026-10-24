<script lang="ts">
  /**
   * 映像と重ねものの束 (ライブ・追っかけ)。録画視聴は video の配線が
   * まるで違う (src 再生・続き・CM飛ばし) ので、こちらは使わない。
   *
   * - `video` … 映像。**備え付けの操作 (`controls`) は出さない** — あれの
   *   再生位置は「持っている範囲」を尺として描くので絶えず動く
   * - `still` … 切り替えの間、前の映像を貼っておく canvas (`live-player` の freeze)。
   *   映像より上 (黒を隠す)、字幕より下 (切り替え中も字幕は見えていてほしい)
   * - `overlay` … 放送の字幕。放送の位置・背景の箱・外字のまま描くので canvas に重ねる。
   *   `object-fit` は描く係 (`CaptionPainter`) が `fill` / `contain` に切り替える
   * - 入れ物 (`box`) … データ放送が小窓へ寄せる先 (`DataBroadcast` の `placeVideo`)。
   *   字幕も中にあるので映像と一緒に縮む
   */
  interface Props {
    /** 前の映像を貼っているか (`live-player` の holding)。still の見せ方 */
    holding: boolean;
    /** 字幕を出しているか。canvas の data-on に写す (描くのは `live-player` の `paint`) */
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

<div bind:this={box} class="box">
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_media_has_caption -->
  <video
    bind:this={video}
    class="video"
    playsinline
    {onclick}
    data-testid="{prefix}-video"
  ></video>
  <canvas
    bind:this={still}
    class="layer still"
    style:opacity={holding ? 1 : 0}
    data-testid="{prefix}-still"
    data-holding={holding}
    aria-hidden="true"
  ></canvas>
  <canvas
    bind:this={overlay}
    class="layer"
    data-testid="{prefix}-captions"
    data-on={captionsOn}
    aria-hidden="true"
  ></canvas>
</div>

<style>
  .box {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .video {
    width: 100%;
    height: 100%;
    background: var(--dp-video);
  }
  .layer {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    pointer-events: none;
  }
  .still {
    transition: opacity var(--dp-duration);
  }
</style>
