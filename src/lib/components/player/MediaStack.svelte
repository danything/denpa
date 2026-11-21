<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * 映像と重ねものの束 (ライブ・追っかけ)。観る画面は video の配線が
   * まるで違う (src 再生・続き・CM スキップ) ので、こちらは使わない。
   *
   * - `video` … 映像。**備え付けの操作 (`controls`) は出さない**。あれの
   *   再生位置は「持っている範囲」を尺として描くので絶えず動く
   * - `spare` … 段を替えるときに次の段を用意する `<video>` (`twin` のときだけ置く。ライブの `stageStep`)。
   *   透明・消音で、入れ替えたら (`front`) こちらが `video` になる
   * - `still` … 切り替えの間、前の映像を貼っておく canvas (`live-player` の freeze)。
   *   映像より上 (黒を隠す)、字幕より下 (切り替え中も字幕は見えていてほしい)
   * - `under` … 前の映像と字幕の間に重ねるもの (実況のコメント。`JikkyoLayer`)。
   *   実況と字幕は操作バーの影より上に出す (重なりの順は `ControlBar`)
   * - `overlay` … 放送の字幕。放送の位置・背景の箱・外字のまま描くので canvas に重ねる。
   *   `object-fit` は描く処理 (`CaptionPainter`) が `fill` / `contain` に切り替える
   * - 入れ物 (`box`) … データ放送が小窓へ寄せる先 (`DataBroadcast` の `placeVideo`)。
   *   字幕も中にあるので映像と一緒に縮む
   */
  interface Props {
    /** 前の映像を貼っているか (`live-player` の holding)。still の見せ方 */
    holding: boolean;
    /** 字幕を出しているか。canvas の data-on に写す (描くのは `live-player` の `paint`) */
    captionsOn: boolean;
    onclick: (event: MouseEvent) => void;
    /** data-testid の接頭辞。`<prefix>-video` / `-video-spare` / `-still` / `-captions` になる */
    prefix: string;
    /** `<video>` を 2 つ置くか (段を替えるときに裏で用意する。ライブ) */
    twin?: boolean;
    /** 映している `<video>` (0 か 1。`live-player` の `front`)。入れ替えるとこちらが `video` になる */
    front?: number;
    video?: HTMLVideoElement | null;
    spare?: HTMLVideoElement | null;
    still?: HTMLCanvasElement | null;
    overlay?: HTMLCanvasElement | null;
    box?: HTMLElement | null;
    under?: Snippet | undefined;
  }
  let {
    holding,
    captionsOn,
    onclick,
    prefix,
    twin = false,
    front = 0,
    video = $bindable(null),
    spare = $bindable(null),
    still = $bindable(null),
    overlay = $bindable(null),
    box = $bindable(null),
    under,
  }: Props = $props();

  /** 置いた `<video>`。2 つ目は `twin` のときだけ */
  const slots: (HTMLVideoElement | null)[] = [null, null];
  /**
   * 映している側を `video`、もう一方を `spare` に写す。**置いたその場で写す** (`bind:this` の中から)。
   * 写すのを effect に任せると、画面の `onMount` が `video` を読む時点でまだ null で、開いた局・追っかけを始められなかった
   */
  function sync(): void {
    video = slots[front] ?? null;
    spare = twin ? (slots[1 - front] ?? null) : null;
  }
  // 入れ替えたら (`front`) 写し直す
  $effect.pre(() => {
    void front;
    sync();
  });
</script>

<div bind:this={box} class="box">
  {#each twin ? [0, 1] : [0] as slot (slot)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_media_has_caption -->
    <video
      bind:this={
        () => slots[slot] ?? null,
        (el) => {
          slots[slot] = el;
          sync();
        }
      }
      class="video"
      class:back={slot !== front}
      playsinline
      {onclick}
      aria-hidden={slot !== front ? "true" : undefined}
      data-testid={slot === front ? `${prefix}-video` : `${prefix}-video-spare`}
    ></video>
  {/each}
  <canvas
    bind:this={still}
    class="layer still"
    style:opacity={holding ? 1 : 0}
    data-testid="{prefix}-still"
    data-holding={holding}
    aria-hidden="true"
  ></canvas>
  {@render under?.()}
  <canvas
    bind:this={overlay}
    class="layer captions"
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
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    background: var(--dp-video);
  }
  /* 用意している側は見せず、押させない。入れ替えた瞬間に表と裏が替わる */
  .back {
    opacity: 0;
    pointer-events: none;
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
    transition: opacity var(--dp-duration) var(--dp-ease);
  }
  /* 字幕は実況より上、操作バーのボタンより下 (`app.css` の `--dp-z-stage-*`) */
  .captions {
    z-index: var(--dp-z-stage-captions);
  }
</style>
