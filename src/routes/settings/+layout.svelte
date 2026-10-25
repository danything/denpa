<script lang="ts">
  import { afterNavigate, replaceState } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { onDestroy } from "svelte";
  import ArrowLeft from "~icons/lucide/arrow-left";

  import { SECTION_ALIASES, SETTINGS_GROUPS } from "#lib/settings-sections.js";

  let { children } = $props();

  /** いま開いているグループ (`/settings/reception` なら `reception`)。`/settings` そのものなら null */
  const current = $derived(page.route.id?.split("/")[2] ?? null);
  const group = $derived(
    SETTINGS_GROUPS.find((g) => g.slug === current) ?? null,
  );

  /** 見えている節 (左の一覧と、狭い画面の上の行で印を付ける) */
  let active = $state<string | null>(null);

  let main = $state<HTMLElement>();
  let jumpRow = $state<HTMLElement>();

  /**
   * **グループを移ったら頭に戻す。** 巻き取るのはどの幅でも window (`+layout.svelte` の `FILLED` に入れない)。
   * 頭へは SvelteKit も戻すが、節へ滑らかに巻く設定 (下の `scroll-behavior`) のせいで、前のグループの下から頭まで巻く途中が見える。
   * 戻る・進むはブラウザが前の位置へ帰すので触らない。`#<節>` 付きで来たらその節へ (飛ぶ途中を見せても意味が無いので、ここも滑らかにしない)
   */
  afterNavigate(({ from, to, type }) => {
    if (main === undefined) return;
    let hash = decodeURIComponent(to?.url.hash.slice(1) ?? "");
    // なくなった節 (`#logos`) で来たら、入った先の節へ。URL も書き換えて、そのまま共有されても迷わせない
    const alias = Object.hasOwn(SECTION_ALIASES, hash)
      ? SECTION_ALIASES[hash]
      : undefined;
    if (alias !== undefined) {
      hash = alias;
      replaceState(`#${alias}`, page.state);
    } else if (from?.url.pathname === to?.url.pathname || type === "popstate") {
      return;
    }
    const target = hash === "" ? null : document.getElementById(hash);
    if (target === null) {
      window.scrollTo({ top: 0, behavior: "instant" });
      active = group?.sections[0]?.slug ?? null;
    } else {
      pin(target);
    }
  });

  /**
   * **飛んだ先に、上の節が育つ間は付いていく。** 相手待ちの節 (チューナー) は骨組みのあとで本物が流れてきて
   * 背が変わるので、開いた瞬間に合わせただけでは、流れ終わったころには前の節を見ている。
   * 自分で巻こうとしたら (ホイール・指・キー・クリック)、そこで手を離す
   */
  let unpin = () => {};
  const LET_GO = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
  function pin(target: HTMLElement): void {
    unpin();
    const align = () => {
      target.scrollIntoView({ block: "start", behavior: "instant" });
      active = target.id;
    };
    align();
    const resize = new ResizeObserver(align);
    resize.observe(main?.firstElementChild ?? target);
    const timer = setTimeout(() => unpin(), 4000);
    const letGo = () => unpin();
    for (const type of LET_GO)
      window.addEventListener(type, letGo, { passive: true });
    unpin = () => {
      resize.disconnect();
      clearTimeout(timer);
      for (const type of LET_GO) window.removeEventListener(type, letGo);
      unpin = () => {};
    };
  }
  onDestroy(() => unpin());

  /** 押した節へ飛んでいる間は、見えている節を数え直さない (途中の節に次々と印が付く) */
  let jumping: ReturnType<typeof setTimeout> | undefined;
  function jump(slug: string): void {
    active = slug;
    clearTimeout(jumping);
    jumping = setTimeout(() => (jumping = undefined), 800);
  }

  /**
   * **見えている節を追う** (Vercel のドキュメントの目次と同じ)。上の範囲 (ヘッダーの下から画面の 45%) に
   * かかっている節のうち、いちばん上のもの。長い節 (チューナー) がその範囲にかかっている間は次の節に移らない。
   * 下まで巻いたら最後の節 (短い節はその範囲まで上がってこない)
   */
  $effect(() => {
    void page.url.pathname;
    if (main === undefined) return;
    const parts = [...main.querySelectorAll<HTMLElement>("[data-part]")];
    if (parts.length === 0) return;
    const seen = new Set<string>();

    const pick = () => {
      if (jumping !== undefined) return;
      const box = document.documentElement;
      const bottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
      if (bottom && box.scrollTop > 0) {
        active = parts.at(-1)!.id;
        return;
      }
      const first = parts.find((part) => seen.has(part.id));
      if (first !== undefined) active = first.id;
    };

    /*
     * 上に重なるものの下から数える。浮いたヘッダー (`html` の `scroll-padding-top` が px で持つ。スマホは 0) と、
     * 640〜767px はヘッダーの下に貼り付く節の行 (スマホの節の行は下にある)。rootMargin は px か % だけ (rem は投げる)
     */
    const header =
      Number.parseFloat(
        getComputedStyle(document.documentElement).scrollPaddingTop,
      ) || 0;
    const cover =
      (matchMedia("(min-width: 640px) and (max-width: 767px)").matches
        ? (jumpRow?.getBoundingClientRect().bottom ?? header)
        : header) + 16;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) seen.add(entry.target.id);
          else seen.delete(entry.target.id);
        }
        pick();
      },
      { rootMargin: `-${Math.round(cover)}px 0px -55% 0px` },
    );
    for (const part of parts) observer.observe(part);
    window.addEventListener("scroll", pick, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", pick);
    };
  });
</script>

<!--
    **一覧と詳細の形**。左にグループとその節の一覧、右にグループの画面。
    **グループごとに1つの画面** (`/settings/<グループ>`) で、節は上から積む。節を押すとそこへ滑らかに巻き、
    巻いていくと左の一覧で見えている節に印が付く。並びは `#lib/settings-sections.ts`。

    **横に並べはじめる幅は全画面で 768px** ([+layout.svelte](../+layout.svelte) の `FILLED` の上の説明)。
    並べたときの形は下の style。左の列と右とは線で分けない (地は同じで、右の列を真ん中に寄せた余白で分かれる)。

    **狭い画面では一覧と中身を切り替える。** `/settings` はグループの一覧だけ、押すとその画面と「← 設定」、
    節へ飛ぶ行 (巻いても残る。スマホは下のタブの上、640〜767px はヘッダーの下)
-->
<div class="page settings-page" class:list-view={current === null}>
  <!--
        **行は線で区切らない** (録画の画面のサイドバーと同じ部品)。グループは太字の見出し、
        節はそれより一段深い行。見えている節は左の縦線と主の色の太字
    -->
  <nav
    class="side side-panel"
    aria-label="設定の項目"
    data-testid="settings-nav"
  >
    <ul class="groups">
      {#each SETTINGS_GROUPS as g (g.slug)}
        {@const here = current === g.slug}
        {@const href = resolve(`settings/${g.slug}`)}
        <li>
          <a
            {href}
            class="group-link side-label"
            aria-current={here ? "page" : undefined}
            data-testid="settings-nav-{g.slug}"
          >
            {g.label}
            <!-- 狭い画面の一覧だけ。中に何があるかを1行で (節の一覧は出さないので) -->
            <span class="group-hint"
              >{g.sections.map((s) => s.label).join("・")}</span
            >
          </a>
          <ul class="sections-nav side-list">
            {#each g.sections as section (section.slug)}
              {@const selected = here && active === section.slug}
              <li>
                <a
                  href="{href}#{section.slug}"
                  class="side-item"
                  aria-current={selected ? "location" : undefined}
                  onclick={() => jump(section.slug)}
                  data-testid="settings-nav-{section.slug}"
                >
                  {section.label}
                </a>
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  </nav>

  <div class="main" bind:this={main}>
    <div class="main-inner">
      {#if group !== null}
        <!-- 狭い画面だけ。一覧へ戻る (ブラウザの戻ると同じ行き先) と、節へ飛ぶ行 -->
        <div class="jump small" bind:this={jumpRow} data-testid="settings-jump">
          <a
            class="back"
            href={resolve("settings")}
            title="設定へ戻る"
            data-testid="settings-back"
            ><ArrowLeft aria-hidden="true" /><span class="visually-hidden"
              >設定へ戻る</span
            ></a
          >
          {#each group.sections as section (section.slug)}
            <a
              href="{resolve(`settings/${group.slug}`)}#{section.slug}"
              class:selected={active === section.slug}
              onclick={() => jump(section.slug)}
              data-testid="settings-jump-{section.slug}"
            >
              {section.label}
            </a>
          {/each}
        </div>
      {/if}
      {@render children()}
    </div>
  </div>
</div>

<style>
  /*
     * **広い画面では左右と下を main の余白の外まで広げる。** 左の列は画面の左端に付けてヘッダーの下に貼り付け、
     * 高さは窓の残りまで (あふれたら一覧の中で巻き取る。`app.css` の `.side-panel`)。右の中身は窓ごと巻き、浮いたヘッダーの裏を流れる
     */
  @media (min-width: 768px) {
    .page {
      display: grid;
      grid-template-columns: 14rem minmax(0, 1fr);
      margin: 0 calc(-1 * var(--dp-gutter)) calc(-1 * var(--dp-gutter));
    }
  }
  @media (min-width: 1280px) {
    .page {
      grid-template-columns: 16rem minmax(0, 1fr);
    }
  }

  /*
     * ---- 左の一覧 ----
     * **録画の画面のサイドバーと同じ部品** (`app.css` の `.side-panel`・`.side-label`・`.side-list`・`.side-item`)。
     * グループの見出しはその画面へのリンク。ここは幅と、狭い画面の形だけ
     */
  .groups {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .groups > li {
    margin: 0;
    list-style: none;
  }
  .side a {
    text-decoration: none;
  }
  .group-link {
    border-radius: var(--dp-radius);
    transition:
      background-color var(--dp-duration),
      color var(--dp-duration);
  }
  .group-link:hover {
    color: inherit;
  }
  .group-hint {
    display: none;
  }
  /*
     * 狭い画面の一覧はグループだけ (押すとその画面。節へは節の行で飛ぶ)。
     * 指で押すので行を高くする (40px 以上)。字は本文の大きさ、塗りだけ余白の外へ少し出す
     */
  @media (max-width: 767px) {
    .side {
      padding: 0;
      overflow: visible;
    }
    .side .sections-nav {
      display: none;
    }
    .groups {
      margin-inline: -0.75rem;
    }
    /* 行どうしは線で区切らない。見出しの太字も外し、ふつうの行にする (下に中身の1行) */
    .group-link {
      display: block;
      margin: 0;
      padding-block: 0.625rem;
      color: inherit;
      font-size: var(--dp-text-base);
      font-weight: var(--dp-weight);
    }
    .group-link:hover {
      background: var(--dp-hover-soft);
    }
    .group-hint {
      display: block;
      color: var(--dp-muted);
      font-size: var(--dp-text-xs);
    }
  }

  /* ---- 右の中身 ---- */
  .main {
    min-width: 0;
  }
  /* 節を押したら滑らかに巻く。動かさない設定の端末ではそのまま飛ぶ */
  @media (prefers-reduced-motion: no-preference) {
    :global(html:has(.settings-page)) {
      scroll-behavior: smooth;
    }
  }
  /*
     * 中の 2 段組 (`app.css` の `.setting-rows`) は、この列の幅で切り替える。
     * 広い画面では列を真ん中に寄せる (左に寄せたままだと右が大きく空いて見えた)
     */
  .main-inner {
    display: flex;
    width: 100%;
    max-width: 60rem;
    margin-inline: auto;
    box-sizing: border-box;
    flex-direction: column;
    gap: var(--dp-space-3);
    container-type: inline-size;
  }
  /*
     * **節どうしは線を引かず、上下にたっぷりの余白で区切る** (左の一覧のグループの境目と同じ考え。カードにはしない)。
     * 節の中の行の間より目に見えて空ける。飛んだ先が見出しの上にぴったり付くよう、
     * 巻き取りの余白を取る (広い画面は浮いたヘッダーの下。ヘッダーのぶんは `html` の `scroll-padding-top` が持つので、ここは間の余白だけ。
     * 640〜767px はヘッダーと節の行の下、スマホは上の安全域の下)
     */
  .main-inner :global([data-part] + [data-part]) {
    margin-top: var(--dp-space-4);
    padding-top: var(--dp-space-6);
  }
  .main-inner :global([data-part]) {
    scroll-margin-top: var(--dp-gutter);
  }
  @media (max-width: 767px) {
    /*
     * 640〜767px は節の行 (下の `.jump`) がヘッダーの下に貼り付く。ヘッダーのぶん (`scroll-padding-top`) より下へ
     * はみ出す高さ (ヘッダーとの隙間と節の行の高さから、ヘッダーの下の空き 0.5rem を引いた分) を足す。スマホは下で決め直す
     */
    .main-inner :global([data-part]) {
      scroll-margin-top: calc(
        var(--dp-bar-gap) + var(--dp-bar-pad) * 2 + var(--dp-btn-h-sm) -
          (var(--dp-header-space) - var(--dp-header-bottom)) + var(--dp-gutter)
      );
    }
    /* 狭い画面は一覧か中身のどちらか。どちらを出すかは URL */
    .page.list-view .main,
    .page:not(.list-view) .side {
      display: none;
    }
  }

  /*
     * **狭い画面の節の行。** 「← 設定」と節の名前を横に並べ、巻いても残す (スマホは下、640〜767px はヘッダーの下)。
     * はみ出す分は横に巻く (行を折り返すと高さが変わり、飛んだ先の余白が合わなくなる)
     */
  .jump {
    position: sticky;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: var(--dp-space-1);
    overflow-x: auto;
    scrollbar-width: none;
    white-space: nowrap;
  }
  .jump a {
    flex-shrink: 0;
    padding: 0.3rem 0.65rem;
    border-radius: var(--dp-radius-full);
    color: inherit;
    text-decoration: none;
  }
  /* いまの節は、ほかの選んでいるものと同じく塗らずに主の色の太字と、字の幅いっぱいの下線 (幅は左右の余白 0.65rem×2 を引いた字の幅。余白を変えたらここも) */
  .jump a.selected {
    background: linear-gradient(var(--pico-primary), var(--pico-primary))
      no-repeat center bottom 0.1rem / calc(100% - 1.3rem) 2px;
    color: var(--dp-primary-text);
    font-weight: var(--dp-weight-bold);
  }
  /* 戻るは字だけのアイコンのボタン */
  .jump .back {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: var(--dp-btn-h-sm);
    height: var(--dp-btn-h-sm);
    padding: 0;
    color: inherit;
  }
  .jump .back:hover {
    background: var(--dp-btn-tonal-hover);
  }
  .jump .back :global(svg) {
    width: 1.125rem;
    height: 1.125rem;
  }
  /*
     * 640〜767px はヘッダーが浮いている。**節の行はヘッダーと同じ角丸の面に乗せ、その下に貼り付ける** (ホームの頭の1行・
     * 番組表の操作の1行と同じ。docs/design.md の「浮かせ方」。`app.css` の `--dp-bar-*`)。置かれた位置から隙間 (`--dp-bar-gap`)
     * のぶん上へ出し、巻き始めても動かない。上端では平らで、巻いて中身が裏に入ると面と近い影が出る (窓の巻いた量で。`dp-bar-float`)。
     * 面は節の行そのものの地なので、横に巻いても動かない
     */
  @media (min-width: 640px) {
    .jump {
      top: calc(var(--dp-header-bottom) + var(--dp-bar-gap));
      margin: calc(
          var(--dp-header-bottom) + var(--dp-bar-gap) - var(--dp-header-space)
        )
        calc(var(--dp-bar-inset) - var(--dp-gutter)) 0;
      padding: var(--dp-bar-pad);
      border-radius: var(--dp-bar-radius);
      background: var(--dp-float);
      box-shadow: var(--dp-shadow-tight);
    }
    @supports (animation-timeline: scroll()) {
      .jump {
        background: transparent;
        box-shadow: none;
        animation: dp-bar-float linear both;
        animation-timeline: scroll(root block);
        animation-range: 0 1.5rem;
      }
    }
  }
  /* 節の行がある間 (767px まで) はヘッダーも近い影にそろえる (番組表と同じ。遠い影が下の1行に掛かって段々に見えないように) */
  @media (min-width: 640px) and (max-width: 767.98px) {
    :global(html:has(.settings-page .jump)) {
      --navbar-shadow: var(--dp-shadow-tight);
    }
  }
  /*
     * **スマホ (下のタブがある幅) では下のタブのすぐ上に浮かべる** (押すものは下に。ホームの頭の1行と同じ半透明のカプセル)。
     * 読んでいる間は下のタブと一緒に引っ込む (`+layout.svelte` の `data-retract`)。中身の最後が隠れないよう、そのぶん下を空ける
     */
  @media (max-width: 639.98px) {
    .jump {
      position: fixed;
      inset: auto 0.75rem calc(var(--dp-tabbar, 0px) + 0.375rem);
      margin: 0;
      padding: 0.25rem 0.5rem;
      border-radius: 1.375rem;
      background: var(--dp-float);
      box-shadow: var(--dp-shadow-pop);
      transition: transform var(--dp-duration-move) var(--dp-ease-spring);
    }
    :global([data-retract]) .jump:not(:has(:focus-visible)) {
      transform: translateY(calc(var(--dp-tabbar, 0px) + 0.375rem + 100%));
    }
    .main-inner {
      padding-bottom: 3.5rem;
    }
    .main-inner :global([data-part]) {
      scroll-margin-top: calc(3.5rem + env(safe-area-inset-top));
    }
  }
  @media (min-width: 768px) {
    .jump {
      display: none;
    }
    .main-inner {
      padding: 0 var(--dp-gutter) var(--dp-gutter);
    }
  }
</style>
