<script lang="ts">
    import { type Snippet, setContext } from 'svelte';
    import { PLAYER_CONTROLS, PLAYER_STAGE, type PlayerControls } from './controls.svelte';
    import type { StageFullscreen } from './fullscreen.svelte.js';
    import { PHONE_LANDSCAPE } from './PlayerLayout.svelte';

    /**
     * 映像を出す領域。**3つの視聴画面 (ライブ・追っかけ・録画) で同じ配線を1本に。**
     *
     * 持つのは枠と、どの画面でも同じだった配線だけ:
     * - ポインタで操作列を出す/隠す・触らないとカーソルも消す (`controls`)
     * - キーボードで触っている間は操作列を残す (focusin/focusout)
     * - 全画面 — **枠ごと**入れる (映像だけでなく操作列も一緒に大きくする)。
     *   出入りは画面側が持つ `fullscreen` (`fullscreen.svelte.ts`。`f` キーからも使うため)。
     *   iPhone では枠を画面いっぱいに広げて代わりにする (`data-pseudo`。下の style)
     * - 枠の大きさから、操作列の詰め方を決める (`compact` / `low`。下の説明)
     *
     * 中身 (video・重ねる canvas・操作列) は画面ごとに違うので snippet で受ける。
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
         * 映像の上の知らせ (`StageNote`) を積む列。**知らせはみなここへ** — 知らせごとに
         * 絶対配置していた頃は、置き場ごとに上からの距離を書いていて、同時に出ると重なった。
         * 上端の真ん中から下へ積む。低い枠では右上の一行 (`ControlBar`) の下から
         */
        notes?: Snippet;
    }
    interface StageApi {
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
        fullscreen,
        children,
        notes,
    }: Props = $props();

    // 中のメニュー (`OverlayMenu`) が「開いている間は操作列を残せ」と言う先。取り手で渡す (props は差し替わりうる)
    setContext(PLAYER_CONTROLS, () => controls);
    // メニューを枠の中に収める先 (`OverlayMenu`)。bind で入るので取り手で渡す
    setContext(PLAYER_STAGE, () => element);

    /**
     * **枠の大きさで操作列の詰め方を変える。**
     *
     * 操作列は 48px の丸を横に9個、右の縦列に4個並べる作り (`ControlBar`) で、
     * 映像が 476px 幅・340px 高あることを前提にしている。スマホの縦 (390px 幅) で
     * 全画面をやめると枠は 358x224 しか無く、**下の操作バーが二段に折れて映像を覆い、
     * 右の縦列 (閉じる・切り抜き・削除) が操作バーのシークバーや再生ボタンに重なって**
     * いた (実機の報告「全画面じゃないと操作ボタンがおかしくなる」)。
     *
     * - `compact` (幅 448px 未満か、16:9 より低く抑えられて高さ 300px 未満か、横にしたスマホ) … 押すものを 40px に縮め、毎回は使わないもの
     *   (音声・送り・エンコード方式・速さなど) を「ほか」(⋯) に畳む。読みものは
     *   一行にして押すものの上へ。スマホの縦は枠が画面の幅そのまま (端まで
     *   広げる。下の `@media`) で、いちばん広いもので 430px。
     *   縦の iPad (映像が 476px) はここに入れない — あちらは 48px の9個が一段に
     *   収まるように幅を決めてある。
     *   **高さでも畳む** — 幅が足りていても、300px に満たない枠に 48px の操作バーと右上の
     *   一行を載せると映像がほとんど隠れる (二段組の低い窓など)。**横にしたスマホも畳む**
     *   (枠は画面の高さいっぱいの 693x390 ほど。全部並べると読みものが数文字しか残らない)
     * - `under` (幅で `compact` のとき。全画面は除く) … **下の操作バーを映像の下 (枠の外) に出す。**
     *   スマホの縦の枠は 390x219 しか無く、操作バー (シークバー・読みもの・押すもの) を
     *   重ねると映像の半分を覆い、字幕に時刻が重なっていた。「ほか」を開くとさらに隠れる。
     *   映像の下は余っているので、操作バーはそこに置いて**いつも出しておく** (映像を覆わないので
     *   引っ込める理由が無い)。右上の一行 (閉じる・切り抜きなど) は今までどおり映像の上。
     *   全画面では映像の周りに黒帯があるので、今までどおり重ねる
     * - `low` (高さ 360px 未満) … 右の縦列を横に寝かせて右上の一行にする。縦に
     *   4個積むと 228px、下の操作バーが 112px で、それより低い枠では重なる (スマホの横や
     *   縦の iPad の二段組)。**大きさは変えない**。狭い枠も低い (224px) ので、
     *   `compact` のときは必ずこちらも立てる
     *
     * 全画面にすると枠が画面いっぱいになるので、横持ちの全画面はどちらにも
     * 当たらない (今までどおり)。**決めるのは媒体の幅ではなく枠の大きさ** —
     * 同じ画面幅でも、二段組かどうかで映像の幅がまるで違う
     */
    let narrow = $state(false);
    let short = $state(false);
    let low = $state(false);
    const compact = $derived(narrow || short);
    /*
     * **操作バーを下に出すのは幅で決めたときだけ。** 高さで決めると、操作バーを出したぶん枠が
     * 高くなって外れ、外れると低くなってまた入る (行ったり来たりする)。幅は操作バーを
     * 出しても変わらない
     */
    const under = $derived(narrow && !fullscreen.active);
    $effect(() => {
        const target = element;
        if (target === null) return;
        /*
         * **横にしたスマホも畳む** (`PlayerLayout` の `PHONE_LANDSCAPE`)。枠は 693x390 ほどで、
         * 48px を全部並べると読みもの (時刻・局・番組名) が数文字しか残らず、ライブでは
         * 「20:3…」まで潰れていた。毎回使うものだけ残して ⋯ に畳み、読みものは一行を取る
         */
        const phone = window.matchMedia(PHONE_LANDSCAPE);
        const measure = () => {
            narrow = target.clientWidth < 448;
            /*
             * 高さで畳むのは、**枠が 16:9 より低く抑えられているときだけ** (高さの上限 `max-height`
             * で切られた、低い窓)。16:9 のままなら低さは幅で決まっていて、幅の線で足りる —
             * 縦の iPad の二段組 (500x281) まで畳むと、48px の9個が一段に入る幅を捨てることになる。
             * 幅で畳んでいるときは見ない (操作バーを下に出すと、枠の高さに操作バーが入る)
             */
            const height = target.clientHeight;
            short = !narrow && ((height < 300 && height < (target.clientWidth * 9) / 16 - 1) || phone.matches);
            low = target.clientHeight < 360;
        };
        measure();
        const watcher = new ResizeObserver(measure);
        watcher.observe(target);
        phone.addEventListener('change', measure);
        return () => {
            watcher.disconnect();
            phone.removeEventListener('change', measure);
        };
    });

    /**
     * **操作列を出している間は、字幕を操作列の上まで持ち上げる。**
     *
     * 操作バーは映像に重ねるので、下の方に出る字幕 (たいていの字幕) がシークバーと時刻の下に
     * 潜っていた (横にしたスマホでは2行目が丸ごと隠れた)。字を描く係 (`CaptionPainter`) が
     * 字の載っている縦の範囲を `data-ink` に書くので、操作バーの上端と比べて重なるぶんだけ
     * canvas を上へずらす (`translate`)。字を縮めたりはしない — 放送の升目どおりのまま動かす。
     *
     * - 持ち上げるのは重なるときだけ。上の方の字幕は動かない
     * - 枠の上端より上へは出さない (操作バーと字幕がどちらも長いときは、上を優先して見せる)
     * - 操作バーを映像の下に出している間 (`under`) と操作バーを引っ込めている間は戻す
     * - データ放送の小窓に映像ごと寄せている間も戻す (下の `offsetIn`)
     * - 小窓・切り抜きは canvas の中身を使うので、ずらしても影響しない
     */
    $effect(() => {
        const stage = element;
        if (stage === null) return;
        const lifting = controls.shown && !under;
        /*
         * 位置は `offsetTop` で測る (枠の中の、ずらす前の位置。`translate` が効かない)。
         *
         * **データ放送の小窓の中では動かさない。** 映像の箱が小窓へ寄せられている間
         * (`DataBroadcast` が `data-bml-window` を立てる)、字幕は映像と一緒に小窓の中にあって、操作バーとは
         * 重ならない。ずらすと小窓の端で切れる
         */
        const offsetIn = (el: HTMLElement): number | null => {
            if (el.closest('[data-bml-window]') !== null) return null;
            let y = 0;
            let at: Element | null = el;
            while (at instanceof HTMLElement && at !== stage) {
                y += at.offsetTop;
                at = at.offsetParent;
            }
            return at === stage ? y : null;
        };
        const lift = () => {
            const bar = stage.querySelector<HTMLElement>(':scope > [data-stage-bar]');
            const barTop = lifting && bar !== null ? bar.offsetTop : Number.POSITIVE_INFINITY;
            const canvases = stage.querySelectorAll<HTMLElement>('canvas[data-ink]');
            for (const canvas of canvases) {
                const [inkTop = 0, inkBottom = 0] = (canvas.dataset['ink'] ?? '').split(',').map(Number);
                const y = offsetIn(canvas);
                let by = 0;
                if (y !== null) {
                    const overlap = y + inkBottom * canvas.offsetHeight - barTop + 4;
                    const room = Math.max(0, y + inkTop * canvas.offsetHeight);
                    by = Math.round(Math.min(Math.max(0, overlap), room));
                }
                canvas.style.translate = by > 0 ? `0 ${-by}px` : '';
            }
        };
        lift();
        /*
         * 字幕が替わったとき (`data-ink`)・操作バーや枠の大きさが変わったとき・映像の箱が
         * データ放送の小窓へ出入りしたとき (`data-bml-window`)・canvas が足されたとき (`childList`) に測り直す
         */
        const inks = new MutationObserver(lift);
        inks.observe(stage, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-ink', 'data-bml-window'] });
        const sizes = new ResizeObserver(lift);
        sizes.observe(stage);
        const bar = stage.querySelector(':scope > [data-stage-bar]');
        if (bar !== null) sizes.observe(bar);
        for (const canvas of stage.querySelectorAll('canvas')) sizes.observe(canvas);
        return () => {
            inks.disconnect();
            sizes.disconnect();
            for (const canvas of stage.querySelectorAll<HTMLElement>('canvas[data-ink]')) canvas.style.translate = '';
        };
    });

    /**
     * 「ほか」(⋯) を開いているか。**操作列が引っ込んだら閉じる** — 開いたまま
     * 残すと、次に出したときに映像の半分を覆った状態から始まる。操作バーを映像の下に
     * 出している間 (`under`) は操作バーが引っ込まないので、閉じるまで開いたまま
     */
    let more = $state(false);
    $effect(() => {
        if ((!controls.shown && !under) || !compact) more = false;
    });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!--
    **映像の周りは黒** (letterbox の帯にテーマ色を出さない)。縦横比は 16:9 で、高さは
    画面に収まるまで。**低くしすぎない** (224px) — 上下と右に操作バーを重ねるので、
    それより低いと操作バーどうしが重なって押せなくなる
-->
<div
    bind:this={element}
    class="stage"
    class:quiet={!controls.shown}
    data-compact={compact ? '' : undefined}
    data-low={low || compact ? '' : undefined}
    data-more={more ? '' : undefined}
    data-under={under ? '' : undefined}
    data-pseudo={fullscreen.pseudo ? '' : undefined}
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
    {@render children({
        compact,
        more,
        toggleMore: () => (more = !more),
    })}
    {#if notes}
        <div class="notes" data-testid="{testid}-notes">{@render notes()}</div>
    {/if}
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
    /*
     * **操作バーを映像の下に出す (`under`)。** 枠を2段の格子にし、上の段を 16:9 (`::before` が
     * 縦横比を持つ)、下の段を操作バー (`ControlBar` の `.bottom`) にする。中身 (video・字幕・
     * データ放送・幕・知らせ) は絶対配置のまま上の段に置く — 格子の子の絶対配置は、
     * その段を入れ物にして `inset: 0` で収まる。中身の書き方は画面ごとに変えずに済む
     */
    .stage[data-under] {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: auto auto;
        aspect-ratio: auto;
        max-height: none;
        min-height: 0;
    }
    .stage[data-under]::before {
        content: '';
        grid-area: 1 / 1;
        aspect-ratio: 16 / 9;
    }
    /*
     * **終わりの線まで書く。** 絶対配置の子は、終わりを `auto` にすると格子の端
     * (枠の内側いっぱい) まで伸びる — `1 / 1` だけでは操作バーの段まで覆ってしまう
     */
    .stage[data-under] > :global(*) {
        grid-area: 1 / 1 / 2 / 2;
    }
    /* 字幕の持ち上げ (上の `lift`)。操作バーの出入り (200ms) と同じ速さで動かす */
    .stage :global(canvas[data-ink]) {
        transition: translate 200ms;
    }
    /* 知らせの列。押せない (下の映像を押せるように)。押せる知らせは自分で戻す */
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
        padding: 0.5rem;
    }
    .notes:empty {
        display: none;
    }
    /* 低い枠では右の列が右上の一行に寝る (`ControlBar`)。その下から出す */
    .stage[data-low] .notes {
        padding-top: 3.25rem;
    }
    /*
     * **スマホの縦では映像を画面の端から端まで。** 余白 (`--dp-gutter`、
     * `+layout.svelte`) のぶんだけ左右へはみ出させる。見出し・一覧・番組の中身は
     * 今までどおり余白の内側に残す。
     *
     * 余白の内側に置いていた頃は 390px の画面で枠が 358px しか無く、映像は
     * 358x201 (枠の高さの下限 224px との差が上下の黒帯) — **小さいうえに
     * 周りが黒く縁取られて**見えた。端まで出すと 390x219 で、下限との差は 2px ほど。
     *
     * 線は `sm` (640px) — ナビを畳むのと同じ幅。携帯の縦はみなこれより狭く、
     * 縦の iPad mini (744px) や横にした携帯は入らない (縦横比は今までどおり)。
     * 全画面にしたときは UA が `margin: 0 !important` を当てるので影響しない
     */
    @media (max-width: 639px) and (orientation: portrait) {
        .stage {
            margin-inline: calc(-1 * var(--dp-gutter, 1rem));
        }
    }
    /*
     * **横にしたスマホでは、枠を映像の縦横比 (16:9) に合わせて真ん中に置く。** 高さは画面
     * いっぱい (`PlayerLayout` が `.main` を画面の高さにする)、幅はそこから決める。
     * 枠を画面の幅いっぱいにしていた頃は、映像の左右が黒帯になり、操作バーの端のボタンや右上の
     * 3つが黒帯の上に出て、地 (黒い丸) が見えず半分潜ったように見えた。
     * 条件は `PlayerLayout` の `PHONE_LANDSCAPE` と同じ
     */
    @media (orientation: landscape) and (max-height: 500px) and (pointer: coarse) {
        .stage:not([data-pseudo]) {
            align-self: center;
            width: auto;
            max-width: 100%;
            height: 100%;
        }
    }
    /*
     * **広げた全画面 (iPhone。`fullscreen.svelte.ts`)。** 画面いっぱいに被せ、
     * 縦横比 (16:9)・高さの上下限・端まで出す余白はみな外す。映像は video の
     * `object-fit` (既定の contain) で収まり、上下か左右が黒帯になる。
     *
     * 端は安全域 (切り欠き・ホームバー) の内側で止める — 操作列を指の届く所に
     * 置くため。外側の黒帯は `html[data-stage-fullscreen]` の黒が見える (`app.css`)。
     * いまの viewport は `viewport-fit=cover` ではないので env() は 0 で、横持ちの
     * 切り欠きは Safari がページの外として避けてくれる。cover にしたときもこのまま効く
     */
    .stage[data-pseudo] {
        position: fixed;
        top: env(safe-area-inset-top, 0px);
        right: env(safe-area-inset-right, 0px);
        bottom: env(safe-area-inset-bottom, 0px);
        left: env(safe-area-inset-left, 0px);
        z-index: 90;
        margin: 0;
        aspect-ratio: auto;
        max-height: none;
        min-height: 0;
    }
</style>
