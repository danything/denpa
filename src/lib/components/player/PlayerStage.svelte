<script lang="ts">
  import { setContext, type Snippet } from "svelte";

  import type { Ambient } from "./ambient.svelte.js";
  import AmbientGlow from "./AmbientGlow.svelte";
  import {
    PLAYER_CONTROLS,
    PLAYER_STAGE,
    type PlayerControls,
  } from "./controls.svelte";
  import type { StageFullscreen } from "./fullscreen.svelte.js";
  import { PHONE_LANDSCAPE } from "./PlayerLayout.svelte";

  /**
   * 映像を出す領域。3つの視聴画面で同じ配線を1本に: 操作列の出し入れとカーソル (`controls`)・キーボードで触っている
   * 間は残す・全画面は枠ごと (iPhone は広げる。`data-pseudo`)・枠の大きさから操作列の詰め方を決める (`compact`)。
   * 中身は画面ごとに違うので snippet で受ける
   */
  interface Props {
    controls: PlayerControls;
    testid: string;
    /** 枠そのもの。画面側で要るとき (録画視聴の開いた時点の全画面) に bind する */
    element?: HTMLElement | null;
    /** 全画面の出入り (`stageFullscreen(() => element)`) */
    fullscreen: StageFullscreen;
    children: Snippet<[StageApi]>;
    /**
     * 映像の上の通知 (`StageNote`) を積む列。**通知はみなここへ** — 通知ごとに
     * 絶対配置していた頃は、置き場ごとに上からの距離を書いていて、同時に出ると重なった。
     * 上端の真ん中から下へ積む。右端の縦の列 (`ControlBar`) には掛けない
     */
    notes?: Snippet;
    /**
     * アンビエントモード (`ambient.svelte.ts`)。渡すと、映像の周りの地に映像の色を敷く (`AmbientGlow`)。
     * 色は枠の外に出るだけで、枠の中 (映像・字幕・データ放送・操作列・通知) には重ならない
     */
    ambient?: Ambient;
  }
  interface StageApi {
    /** 狭い枠か (スマホの縦・低い枠・横にしたスマホ)。押すものを 40px に縮める */
    compact: boolean;
    /** 毎回は使わないものを再生の設定 (⚙) に畳むか。狭い枠か、押すものが一段に収まらないとき */
    fold: boolean;
  }
  let {
    controls,
    testid,
    element = $bindable(null),
    fullscreen,
    children,
    notes,
    ambient,
  }: Props = $props();

  // 中のメニュー (`OverlayMenu`・`SettingsMenu`) が「開いている間は操作列を残せ」と言う先。取り手で渡す (props は差し替わりうる)
  setContext(PLAYER_CONTROLS, () => controls);
  // メニューを枠の中に収める先 (`OverlayMenu`・`SettingsMenu`)。bind で入るので取り手で渡す
  setContext(PLAYER_STAGE, () => element);

  /**
   * 枠の大きさで操作列の詰め方を変える (操作列は 48px の丸を横に9個並べる作りで、狭い枠では折れて映像を覆った)。
   * 決めるのは媒体の幅ではなく枠の大きさ (二段組かどうかで映像の幅がまるで違う)。
   *
   * - `compact` (幅 448px 未満・16:9 より低く抑えられて高さ 300px 未満・横にしたスマホ) … 押すものを 40px に縮め、
   *   毎回は使わないものを ⚙ に畳む。縦の iPad (476px) は入れない
   * - `narrow` だけ (スマホの縦。全画面は除く) … 読みものの上の段を省く (`InfoBlock` の `data-narrow`)
   */
  let narrow = $state(false);
  let short = $state(false);
  const compact = $derived(narrow || short);
  /** スマホの縦 (幅で狭く、全画面でない)。読みものの上の段を省く (`InfoBlock`) */
  const slim = $derived(narrow && !fullscreen.active);
  $effect(() => {
    const target = element;
    if (target === null) return;
    // 横にしたスマホも畳む (全部並べると読みものが数文字しか残らない)
    const phone = window.matchMedia(PHONE_LANDSCAPE);
    const measure = () => {
      narrow = target.clientWidth < 448;
      /*
       * 高さで畳むのは、枠が 16:9 より低く抑えられているときだけ (`max-height` で切られた低い窓)。
       * 16:9 のままなら幅の線で足りる (縦の iPad の二段組まで畳まない)
       */
      const height = target.clientHeight;
      short =
        !narrow &&
        ((height < 300 && height < (target.clientWidth * 9) / 16 - 1) ||
          phone.matches);
    };
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(target);
    phone.addEventListener("change", measure);
    return () => {
      watcher.disconnect();
      phone.removeEventListener("change", measure);
    };
  });

  /**
   * 映像の縦横比 (`"1920 / 1080"`)。二段組では枠をこの形にする (`--dp-aspect`)。エンジンの canvas があれば
   * その `data-aspect`、無ければ `<video>`。分からない間は前の形のまま (局を変えるたびに跳ねない)
   */
  let aspect = $state("16 / 9");
  $effect(() => {
    const target = element;
    if (target === null) return;
    const read = () => {
      const raw = target.querySelector<HTMLCanvasElement>("canvas[data-input]");
      if (raw !== null) {
        const told = raw.dataset["aspect"];
        if (told !== undefined) aspect = told;
        return;
      }
      const video = target.querySelector("video");
      if (video !== null && video.videoWidth > 0 && video.videoHeight > 0)
        aspect = `${video.videoWidth} / ${video.videoHeight}`;
    };
    read();
    // `<video>` の映像の大きさが変わった (`resize` は泡立たないので、捕まえる側で受ける)
    target.addEventListener("resize", read, true);
    target.addEventListener("loadedmetadata", read, true);
    // エンジンの canvas が出入りした・形を書き換えた
    const changes = new MutationObserver(read);
    changes.observe(target, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-aspect"],
    });
    return () => {
      target.removeEventListener("resize", read, true);
      target.removeEventListener("loadedmetadata", read, true);
      changes.disconnect();
    };
  });

  /**
   * 広い枠でも、押すものが一段に収まらなければ畳む (`crowded`)。並ぶものは番組しだいで幅の線では決められないので、
   * 測るときだけ畳んだものを並べ (`data-measuring`)、いちばん右が行の右端を越えるかを読む (同じ処理の中なので画面には出ない)
   */
  let crowded = $state(false);
  const fold = $derived(compact || crowded);
  $effect(() => {
    const target = element;
    if (target === null) return;
    // 狭い枠ではいつも畳む。測るのは 48px で並べているときだけ (40px で測ると少なく見積もる)
    if (compact) {
      crowded = false;
      return;
    }
    let row: HTMLElement | null = null;
    const measure = () => {
      if (row === null) {
        crowded = false;
        return;
      }
      target.setAttribute("data-measuring", "");
      const last = row.lastElementChild;
      const over =
        last !== null &&
        last.getBoundingClientRect().right >
          row.getBoundingClientRect().right + 0.5;
      target.removeAttribute("data-measuring");
      crowded = over;
    };
    const sizes = new ResizeObserver(measure);
    sizes.observe(target);
    // 押すものが出入りしたら測り直す。文字だけの入れ替え (毎秒の時計) は見ない
    const inner = new MutationObserver((records) => {
      const isElement = (node: Node) => node.nodeType === Node.ELEMENT_NODE;
      if (
        records.some(
          (r) =>
            [...r.addedNodes].some(isElement) ||
            [...r.removedNodes].some(isElement),
        )
      )
        measure();
    });
    const attach = () => {
      const next = target.querySelector<HTMLElement>(
        ":scope > [data-stage-bar] [data-stage-row]",
      );
      if (next === row) return;
      if (row !== null) sizes.unobserve(row);
      inner.disconnect();
      row = next;
      if (row !== null) {
        sizes.observe(row);
        inner.observe(row, { childList: true, subtree: true });
      }
    };
    // 操作バーそのものが出入りする (ライブは選局するまで出さない)
    const outer = new MutationObserver(() => {
      attach();
      measure();
    });
    outer.observe(target, { childList: true });
    attach();
    measure();
    return () => {
      sizes.disconnect();
      inner.disconnect();
      outer.disconnect();
    };
  });

  /**
   * 操作列を出している間は、字幕を操作列の上まで持ち上げる (操作バーに潜っていた)。字を描く係が字の縦の範囲を
   * `data-ink` に書くので、重なるぶんだけ canvas を `translate` でずらす (字は縮めない)。枠の上端より上へは
   * 出さず、操作バーを引っ込めている間は戻す
   */
  $effect(() => {
    const stage = element;
    if (stage === null) return;
    const lifting = controls.shown;
    /*
     * 位置は `offsetTop` で測る (ずらす前の位置)。データ放送の小窓の中 (`data-bml-window`) では動かさない —
     * 操作バーと重ならず、ずらすと小窓の端で切れる
     */
    const offsetIn = (el: HTMLElement): number | null => {
      if (el.closest("[data-bml-window]") !== null) return null;
      let y = 0;
      let at: Element | null = el;
      while (at instanceof HTMLElement && at !== stage) {
        y += at.offsetTop;
        at = at.offsetParent;
      }
      return at === stage ? y : null;
    };
    const lift = () => {
      const bar = stage.querySelector<HTMLElement>(":scope > [data-stage-bar]");
      const barTop =
        lifting && bar !== null ? bar.offsetTop : Number.POSITIVE_INFINITY;
      const canvases = stage.querySelectorAll<HTMLElement>("canvas[data-ink]");
      for (const canvas of canvases) {
        const [inkTop = 0, inkBottom = 0] = (canvas.dataset["ink"] ?? "")
          .split(",")
          .map(Number);
        const y = offsetIn(canvas);
        let by = 0;
        if (y !== null) {
          const overlap = y + inkBottom * canvas.offsetHeight - barTop + 4;
          const room = Math.max(0, y + inkTop * canvas.offsetHeight);
          by = Math.round(Math.min(Math.max(0, overlap), room));
        }
        canvas.style.translate = by > 0 ? `0 ${-by}px` : "";
      }
    };
    lift();
    // 字幕が替わった・大きさが変わった・小窓へ出入りした・canvas が足されたときに測り直す
    const inks = new MutationObserver(lift);
    inks.observe(stage, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-ink", "data-bml-window"],
    });
    const sizes = new ResizeObserver(lift);
    sizes.observe(stage);
    const bar = stage.querySelector(":scope > [data-stage-bar]");
    if (bar !== null) sizes.observe(bar);
    for (const canvas of stage.querySelectorAll("canvas"))
      sizes.observe(canvas);
    return () => {
      inks.disconnect();
      sizes.disconnect();
      for (const canvas of stage.querySelectorAll<HTMLElement>(
        "canvas[data-ink]",
      ))
        canvas.style.translate = "";
    };
  });
</script>

{#if ambient}
  <!-- 光は枠より前 (兄弟) に置く。位置を持つ枠のほうが後ろなので、光の上に描かれる -->
  <AmbientGlow
    {ambient}
    stage={element}
    fullscreen={fullscreen.active}
    testid="{testid}-ambient"
  />
{/if}
<!-- 枠の置き場。二段組では、枠が使える広さをここで測る (下の style の `container-type`) -->
<div class="room">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!--
    映像の周りは黒 (letterbox の帯にテーマ色を出さない)。低くしすぎない (224px) — 上下と右に重ねる操作バーどうしが重なる
-->
  <div
    bind:this={element}
    class="stage"
    style:--dp-aspect={aspect}
    class:quiet={!controls.shown}
    data-compact={compact ? "" : undefined}
    data-fold={fold ? "" : undefined}
    data-narrow={slim ? "" : undefined}
    data-pseudo={fullscreen.pseudo ? "" : undefined}
    onpointermove={controls.wake}
    onpointerdown={controls.wake}
    onpointerleave={controls.away}
    onfocusin={(event) => {
      // キーボードで来たときだけ残す (`focusin` はマウスで押しても飛ぶので `:focus-visible` で見分ける)
      const target = event.target;
      controls.keyboard =
        target instanceof Element && target.matches(":focus-visible");
    }}
    onfocusout={() => (controls.keyboard = false)}
    data-testid={testid}
  >
    {@render children({
      compact,
      fold,
    })}
    {#if notes}
      <div class="notes" data-testid="{testid}-notes">{@render notes()}</div>
    {/if}
  </div>
</div>

<style>
  .stage {
    position: relative;
    overflow: hidden;
    background: var(--dp-video);
    aspect-ratio: 16 / 9;
    max-height: 100%;
    min-height: 14rem;
  }
  /* 置き場は箱を持たない (狭い画面・横にしたスマホ・広げた全画面。下で二段組だけ箱にする) */
  .room {
    display: contents;
  }
  /*
     * 二段組では、枠を映像の形にして使える広さに収める (上の `aspect`)。幅は列の幅 (`100cqw`) と
     * 「高さ × 縦横比」(`100cqh`) の小さいほう。上に寄せて横は真ん中 (E2E の `expectSideFrame`)。
     * 測る箱は `.room` — `<main>` の列にすると `position: absolute` の基準になり、`AmbientGlow` の位置がずれる
     */
  /* 横にしたスマホ (下) は 768px を超えても二段組にしないので、ここから外す (`PlayerLayout` の `PHONE_LANDSCAPE`) */
  @media (min-width: 768px) and (not ((orientation: landscape) and (max-height: 500px) and (pointer: coarse))) {
    .room {
      display: flex;
      flex: 1 1 0%;
      min-height: 0;
      flex-direction: column;
      align-items: center;
      container-type: size;
    }
    .stage {
      aspect-ratio: var(--dp-aspect, 16 / 9);
      width: min(100cqw, max(100cqh, 14rem) * var(--dp-aspect, 16 / 9));
    }
  }
  .quiet {
    cursor: none;
  }
  /* 字幕の持ち上げ (上の `lift`)。操作バーの出入りと同じ `--dp-duration` で動かす (動かさない設定では一緒に止まる) */
  .stage :global(canvas[data-ink]) {
    transition: translate var(--dp-duration);
  }
  /* 通知の列。押せない (下の映像を押せるように)。押せる通知は自分で戻す */
  .notes {
    pointer-events: none;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    /* 右端の縦の列 (`ControlBar`。48px の丸と右の余白 8px) に掛けない。真ん中に置くので左も同じだけ空ける */
    padding: 0.5rem 4rem;
  }
  .notes:empty {
    display: none;
  }
  /*
     * スマホの縦では映像を画面の端から端まで (余白 `--dp-gutter` のぶんはみ出させる。358px の枠では小さく、
     * 周りが黒く縁取られて見えた)。高さの下限も外して枠をちょうど 16:9 にする。全画面では UA が margin を消す
     */
  @media (max-width: 639px) and (orientation: portrait) {
    .stage {
      margin-inline: calc(-1 * var(--dp-gutter, 1rem));
      min-height: 0;
    }
  }
  /*
     * 横にしたスマホでは、枠を 16:9 にして真ん中に置く (画面の幅いっぱいだと左右の黒帯の上に操作バーの端が出て
     * 潜って見えた)。条件は `PlayerLayout` の `PHONE_LANDSCAPE` と同じ
     */
  @media (orientation: landscape) and (max-height: 500px) and (pointer: coarse) {
    /* 二段組の置き場 (上) は使わない (箱を持たないまま)。枠は `PlayerLayout` の `.main` (画面の高さ) に直に置く */
    .stage:not([data-pseudo]) {
      align-self: center;
      aspect-ratio: 16 / 9;
      width: auto;
      max-width: 100%;
      height: 100%;
    }
  }
  /*
     * 広げた全画面 (iPhone。`fullscreen.svelte.ts`)。画面いっぱいに被せ、縦横比・高さの上下限・余白は外す。
     * 端は安全域の内側で止める (操作列を指の届く所に置く)。外側は `html[data-stage-fullscreen]` の黒 (`app.css`)
     */
  .stage[data-pseudo] {
    position: fixed;
    top: env(safe-area-inset-top, 0px);
    right: env(safe-area-inset-right, 0px);
    bottom: env(safe-area-inset-bottom, 0px);
    left: env(safe-area-inset-left, 0px);
    z-index: 90;
    width: auto;
    margin: 0;
    aspect-ratio: auto;
    max-height: none;
    min-height: 0;
  }
  /* 置き場の箱 (測る箱) は外す。中の `position: fixed` の基準が窓でなくなる */
  .room:has(> [data-pseudo]) {
    display: contents;
  }
</style>
