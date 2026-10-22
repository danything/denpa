<script lang="ts">
  import "@anyblades/blades/layered/components/modal";
  import { untrack } from "svelte";
  import { submitting } from "#lib/actions.js";
  import { dateTime } from "#lib/format.js";
  import { resolve } from "$app/paths";
  import X from "~icons/lucide/x";

  /**
   * **ロゴを大きく見る窓** (設定の「受信できるチャンネル」の表で、局ロゴ・CMロゴを押したとき)。
   *
   * 表の中のロゴは行の高さに合わせて小さく、CMロゴは白い縁だけの画像なので、
   * ロゴの形になっているかは並べたままでは見分けにくい。**整数倍で拡大し、画素をぼかさない**
   * (`image-rendering: pixelated`)。CMロゴは高さ 36px ほどなので 8〜10 倍になる。
   *
   * 窓は `<dialog>` を `showModal` で開く (× ・Esc・幕を押すと閉じる)。見た目は `app.css` の `.modal-box`。
   * **閉じても中身は残す** — 閉じる動き (`app.css` のダイアログ) の間に空にならないように。
   * 見せていたCMロゴが消えたら (「覚え直す」) 閉じる。表の行もその時に消える
   */
  let {
    target,
    onclose,
  }: {
    /** 見せるもの。`null` で閉じる */
    target: {
      id: number;
      name: string;
      kind: "station" | "cm";
      /** CMロゴを覚えた時刻。局ロゴでは使わない */
      learnedAt: number | null;
    } | null;
    onclose: () => void;
  } = $props();

  /** 拡大の上限。CMロゴ (高さ 36px ほど) が窓に収まる大きさ */
  const MAX_SCALE = 10;

  let dialog = $state<HTMLDialogElement | null>(null);
  let box = $state<HTMLElement | null>(null);
  /** 閉じる間も出しておく中身 (最後に開いたもの) */
  let shown = $state.raw<NonNullable<typeof target> | null>(null);
  /** 画像の元の大きさ。読めるまでは 0 (出さない) */
  let natural = $state.raw({ width: 0, height: 0 });
  /** 画像を置ける幅 */
  let room = $state(0);

  /** 見せるものが変わったら開く・閉じる。追うのは `target` と `dialog` だけ (`shown` は書くだけ) */
  $effect(() => {
    const next = target;
    const element = dialog;
    if (element === null) return;
    untrack(() => {
      if (next === null) {
        if (element.open) element.close();
        return;
      }
      const before = shown;
      if (
        before === null ||
        before.id !== next.id ||
        before.kind !== next.kind ||
        before.learnedAt !== next.learnedAt
      ) {
        natural = { width: 0, height: 0 };
      }
      shown = next;
      if (!element.open) {
        element.showModal();
        box?.focus();
      }
    });
  });

  const src = $derived(
    shown === null
      ? ""
      : shown.kind === "cm"
        ? resolve(`api/services/${shown.id}/logo-data?at=${shown.learnedAt}`)
        : resolve(`api/services/${shown.id}/logo`),
  );

  /** 窓の幅と高さ (画面の半分) に収まる、いちばん大きい整数倍 */
  const scale = $derived.by(() => {
    if (natural.width === 0 || room === 0) return 0;
    const height =
      typeof window === "undefined" ? 600 : window.innerHeight * 0.5;
    // 台の内側の余白 (左右 1rem ずつ) を除いた幅
    const fit = Math.min(
      (room - 32) / natural.width,
      height / natural.height,
      MAX_SCALE,
    );
    return Math.max(1, Math.floor(fit));
  });

  function loaded(event: Event): void {
    const image = event.currentTarget as HTMLImageElement;
    natural = { width: image.naturalWidth, height: image.naturalHeight };
  }
</script>

<!-- Esc は dialog がそのまま閉じる。閉じたことは `close` で受け取る -->
<dialog
  bind:this={dialog}
  {onclose}
  aria-labelledby="logo-zoom-title"
  data-testid="logo-zoom"
>
  <!-- 幕を押したら閉じる (番組の詳細と同じく、箱の後ろに全面のボタンを敷く)。Tab では止まらない -->
  <button
    type="button"
    class="backdrop"
    tabindex="-1"
    aria-label="閉じる"
    onclick={() => dialog?.close()}
  ></button>
  <article class="modal-box" bind:this={box} tabindex="-1">
    <button
      type="button"
      class="ghost icon small close"
      onclick={() => dialog?.close()}
      aria-label="閉じる"
      data-testid="logo-zoom-close"
    >
      <X aria-hidden="true" />
    </button>
    {#if shown !== null}
      <h2 id="logo-zoom-title" class="broadcast">{shown.name}</h2>
      <p class="small muted kind">
        {#if shown.kind === "cm"}
          CMロゴ (CM検出のために録画から覚えたもの)
        {:else}
          局ロゴ (放送波から取得したもの)
        {/if}
      </p>
      <div
        class="frame"
        class:dark={shown.kind === "cm"}
        bind:clientWidth={room}
      >
        <img
          {src}
          alt={shown.kind === "cm"
            ? `${shown.name} のCM検出のロゴ`
            : `${shown.name} の局ロゴ`}
          onload={loaded}
          class:ready={scale > 0}
          style:width={scale > 0 ? `${natural.width * scale}px` : undefined}
          style:height={scale > 0 ? `${natural.height * scale}px` : undefined}
          data-testid="logo-zoom-image"
        />
      </div>
      {#if shown.kind === "cm" && shown.learnedAt !== null}
        <footer class="modal-actions">
          <span class="small muted learned" data-testid="logo-zoom-learned">
            {dateTime(shown.learnedAt)} に覚えました
            {#if scale > 0}<span class="num">・ {scale} 倍</span>{/if}
          </span>
          <!-- 「覚え直す」はこの窓の中だけ (表の行を低く保つ)。消えたら窓も閉じる -->
          <form method="POST" action="?/logoForget" use:submitting>
            <input type="hidden" name="serviceId" value={shown.id} />
            <button
              type="submit"
              class="secondary"
              aria-label={`${shown.name} のCM検出のロゴを覚え直す`}
              data-testid="logo-zoom-forget"
            >
              覚え直す
            </button>
          </form>
        </footer>
      {/if}
    {/if}
  </article>
</dialog>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: none;
    box-shadow: none;
    cursor: default;
  }
  .close {
    position: absolute;
    top: var(--dp-space-3);
    right: var(--dp-space-3);
    z-index: 1;
    color: var(--dp-muted);
  }
  .close:hover {
    color: inherit;
  }
  .close :global(svg) {
    width: 1.125rem;
    height: 1.125rem;
  }
  h2 {
    margin: 0 2.5rem 0 0;
    font-size: var(--dp-text-lg);
  }
  .kind {
    margin: var(--dp-space-1) 0 var(--dp-space-4);
  }
  /* 画像を真ん中に置く台。CMロゴは白い縁だけの画像なので、暗い地に置く */
  .frame {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 8rem;
    padding: var(--dp-space-4);
    border-radius: var(--dp-radius);
    background: var(--dp-subtle);
    overflow: hidden;
  }
  .frame.dark {
    background: #000;
  }
  .frame img {
    max-width: none;
    image-rendering: pixelated;
    visibility: hidden;
  }
  .frame img.ready {
    visibility: visible;
  }
  .learned {
    margin-right: auto;
  }
  .modal-actions form {
    margin: 0;
  }
</style>
