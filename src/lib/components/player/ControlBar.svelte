<script lang="ts">
  /**
   * 映像に重ねる操作列 (3画面で同じ)。端から濃くなる影の上に置き、しばらく触らなければ消える (`shown`。消えている
   * 間は押せない)。下端 (既定) は観ながら使うもの、右端 (`side`) は観る流れの外のもの (閉じる・録画・切り抜き・削除)。
   *
   * - 右端は縦に積み、丸は 48px のまま — 車のタブレットで映像の右の縁をなぞる指がいちばん届き、全画面から出ずに
   *   押せる (横一行・40px にしたら窮屈で押しにくく、戻した)
   * - 読みもの (時刻・局名・番組名) は押すものの行の空きに二段で入れる (`InfoBlock`)。幅ゼロから伸ばし、縮むのは
   *   番組名だけ (中身の幅で並べると長い名前で操作バーが二段に折れた)
   * - 狭い枠 (`data-compact`。`PlayerStage`) では余白も削る
   */
  let {
    shown = true,
    side = false,
    testid,
    children,
  }: {
    shown?: boolean;
    side?: boolean;
    testid?: string;
    children: import("svelte").Snippet;
  } = $props();

  /*
   * 影は下端と右端の両方に敷く (ボタンは塗らない。docs/design.md)。右は舞台の高さいっぱいに縁から流す —
   * ボタンの所だけに敷くと四角い影が貼り付いて見えた。影の帯は押せず、押せるのは中のボタンだけ
   */
</script>

<div
  class="bar"
  class:side
  class:bottom={!side}
  class:away={!shown}
  data-testid={testid}
  data-shown={shown}
  data-stage-bar={side ? undefined : ""}
>
  {@render children()}
</div>

<style>
  .bar {
    position: absolute;
    z-index: 10;
    color: var(--dp-on-video);
    transition: opacity var(--dp-duration);
  }
  .bar.away {
    pointer-events: none;
    opacity: 0;
  }
  .side {
    top: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    display: flex;
    /* 縦に積む (車のタブレットで指が届く右の縁。上の説明)。横一行に直さない */
    flex-direction: column;
    align-items: center;
    /* 丸どうしは 8px 空ける (指で隣を押さない) */
    gap: 0.5rem;
    /* 角に寄せる (上と右の空きは 8px)。丸が角から離れて浮いて見えないように */
    padding: 0.5rem;
  }
  .side > :global(*) {
    pointer-events: auto;
  }
  .side.away > :global(*) {
    pointer-events: none;
  }
  .side::before {
    content: "";
    position: absolute;
    inset: 0 0 0 auto;
    z-index: -1;
    width: 7.5rem;
    background: linear-gradient(
      to left,
      color-mix(in srgb, var(--dp-video) 62%, transparent),
      transparent
    );
    pointer-events: none;
  }

  .bottom {
    left: 0;
    right: 0;
    bottom: 0;
    padding: 2.5rem 0.75rem 0.75rem;
    background: linear-gradient(
      to top,
      color-mix(in srgb, var(--dp-video) 82%, transparent),
      color-mix(in srgb, var(--dp-video) 55%, transparent) 55%,
      transparent
    );
  }
  /*
   * 透かしを減らす設定では、影を濃くする (中のボタンの所はほとんど透けない)。まったく透かさない帯にすると、
   * 操作バーが出ている間だけ映像の右端と下端が四角く欠けて見えるので、端へ向かって消えていくのは残す
   */
  @media (prefers-reduced-transparency: reduce) {
    .bottom {
      background: linear-gradient(
        to top,
        color-mix(in srgb, var(--dp-video-panel) 95%, transparent),
        color-mix(in srgb, var(--dp-video-panel) 85%, transparent) 60%,
        transparent
      );
    }
    .side::before {
      background: linear-gradient(
        to left,
        color-mix(in srgb, var(--dp-video-panel) 95%, transparent),
        color-mix(in srgb, var(--dp-video-panel) 85%, transparent) 50%,
        transparent
      );
    }
  }
  :global(.stage[data-compact]) .bottom {
    padding: 1rem 0.375rem 0.375rem;
  }
</style>
