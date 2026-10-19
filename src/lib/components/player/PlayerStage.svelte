<script lang="ts">
    import { type Snippet, setContext } from 'svelte';
    import AmbientGlow from './AmbientGlow.svelte';
    import type { Ambient } from './ambient.svelte.js';
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
     * - 枠の大きさから、操作列の詰め方を決める (`compact`。下の説明)
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
        /** 狭い枠か (スマホの縦)。押すものを 40px に縮める */
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
     * **枠の大きさで操作列の詰め方を変える。**
     *
     * 操作列は 48px の丸を横に9個、右端の縦の列に3個並べる作り (`ControlBar`) で、
     * 映像が 476px 幅・340px 高あることを前提にしている。スマホの縦 (390px 幅) で
     * 全画面をやめると枠は 358x224 しか無く、**下の操作バーが二段に折れて映像を覆い、
     * 右の縦列 (当時は閉じる・切り抜き・削除) が操作バーのシークバーや再生ボタンに重なって**
     * いた (実機の報告「全画面じゃないと操作ボタンがおかしくなる」)。
     *
     * - `compact` (幅 448px 未満か、16:9 より低く抑えられて高さ 300px 未満か、横にしたスマホ) … 押すものを 40px に縮め、毎回は使わないもの
     *   (音・字幕・音声・エンコード方式・速さなど) を再生の設定 (⚙) に畳む。読みもの (時刻) は
     *   押すものの間に残して短くし、押すものの行は一段のまま (`InfoBlock`)。スマホの縦は枠が画面の幅そのまま (端まで
     *   広げる。下の `@media`) で、いちばん広いもので 430px。
     *   縦の iPad (映像が 476px) はここに入れない — あちらは 48px の9個が一段に
     *   収まるように幅を決めてある。
     *   **高さでも畳む** — 幅が足りていても、300px に満たない枠に 48px の操作バーと右上の
     *   一行を載せると映像がほとんど隠れる (二段組の低い窓など)。**横にしたスマホも畳む**
     *   (枠は画面の高さいっぱいの 693x390 ほど。全部並べると読みものが数文字しか残らない)
     * - `narrow` だけのとき (幅で `compact`。全画面は除く。スマホの縦) … 読みものの上の段 (番組名・局・時間帯) を省く
     *   (`InfoBlock`。`data-narrow`)。**操作バーは映像の上に重ね、触らなければ引っ込める** (ほかの枠と同じ)。
     *   以前は映像の下 (枠の外) に段を足して出しっぱなしにしていた — 390x219 の映像に重ねると半分を覆い、
     *   字幕に時刻が重なったため。ただ、枠が映像より高くなり、映像の下に操作バーの段がいつも残って見えた。
     *   いまは引っ込むので覆うのは触った直後だけで、字幕は出ている間だけ操作バーの上へ持ち上げる (下の `lift`)

     *
     * 全画面にすると枠が画面いっぱいになるので、横持ちの全画面はどちらにも
     * 当たらない (今までどおり)。**決めるのは媒体の幅ではなく枠の大きさ** —
     * 同じ画面幅でも、二段組かどうかで映像の幅がまるで違う
     */
    let narrow = $state(false);
    let short = $state(false);
    const compact = $derived(narrow || short);
    /** スマホの縦 (幅で狭く、全画面でない)。読みものの上の段を省く (`InfoBlock`) */
    const slim = $derived(narrow && !fullscreen.active);
    $effect(() => {
        const target = element;
        if (target === null) return;
        /*
         * **横にしたスマホも畳む** (`PlayerLayout` の `PHONE_LANDSCAPE`)。枠は 693x390 ほどで、
         * 48px を全部並べると読みもの (時刻・局・番組名) が数文字しか残らず、ライブでは
         * 「20:3…」まで潰れていた。毎回使うものだけ残して ⚙ に畳み、読みものは一行を取る
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
     * **映像の縦横比** (`"1920 / 1080"` の形)。二段組では枠をこの形にする (下の style の `--dp-aspect`)。
     *
     * 枠を列の幅いっぱいの 16:9 にしていた頃は、横に長い低い窓で高さの上限に当たると、映像の左右に
     * 黒い帯が出ていた。枠を映像の形にして、幅は列の幅と「高さ × 縦横比」の小さいほうにする
     * (余った横は地かアンビエントモードの色)。
     *
     * 読むのは、エンジンが描く canvas (`raw/engine.ts`。MPEG-2 と互換モード。worker に渡してあるので
     * 大きさは `data-aspect` で受け取る) があればそちら、無ければ `<video>` の絵の大きさ。
     * **まだ分からない間は前の形のまま** — 局を変えるたびに 16:9 へ戻ってから跳ねないように
     */
    let aspect = $state('16 / 9');
    $effect(() => {
        const target = element;
        if (target === null) return;
        const read = () => {
            const raw = target.querySelector<HTMLCanvasElement>('canvas[data-input]');
            if (raw !== null) {
                const told = raw.dataset['aspect'];
                if (told !== undefined) aspect = told;
                return;
            }
            const video = target.querySelector('video');
            if (video !== null && video.videoWidth > 0 && video.videoHeight > 0)
                aspect = `${video.videoWidth} / ${video.videoHeight}`;
        };
        read();
        // `<video>` の絵の大きさが変わった (`resize` は泡立たないので、捕まえる側で受ける)
        target.addEventListener('resize', read, true);
        target.addEventListener('loadedmetadata', read, true);
        // エンジンの canvas が出入りした・形を書き換えた
        const changes = new MutationObserver(read);
        changes.observe(target, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-aspect'] });
        return () => {
            target.removeEventListener('resize', read, true);
            target.removeEventListener('loadedmetadata', read, true);
            changes.disconnect();
        };
    });

    /**
     * **広い枠でも、押すものが一段に収まらなければ畳む** (`crowded`)。
     *
     * 押すものの行 (`ControlRow`) は折り返さない。狭い枠 (`compact`) はいつも畳むが、
     * それより広くても一段に入るとは限らない — 並ぶものは番組しだい (字幕・
     * チャプター・Hybridcast) で、縦の iPad の二段組 (映像 476px) に全部載ると 48px が
     * 11個で 570px を超える。幅の線では決められないので、**畳まずに並べたらはみ出すか**を測る。
     *
     * 測るときだけ印 (`data-measuring`) を立てて畳んだものを並べ、いちばん右 (全画面) が
     * 行の右端を越えるかを読んで、すぐ外す。同じ処理の中で読むだけなので、画面には出ない。
     * 測るときは畳んだものを全部並べるので、畳んでいてもいなくても同じ答えになる (幅の境目で行ったり来たりしない)
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
            target.setAttribute('data-measuring', '');
            const last = row.lastElementChild;
            const over =
                last !== null && last.getBoundingClientRect().right > row.getBoundingClientRect().right + 0.5;
            target.removeAttribute('data-measuring');
            crowded = over;
        };
        const sizes = new ResizeObserver(measure);
        sizes.observe(target);
        /*
         * 押すものが出入りしたら (字幕・音声のボタンなど) 測り直す。**文字だけの入れ替えは見ない** —
         * 時計は毎秒書き換わるので、そのたびに測ることになる
         */
        const inner = new MutationObserver((records) => {
            const isElement = (node: Node) => node.nodeType === Node.ELEMENT_NODE;
            if (records.some((r) => [...r.addedNodes].some(isElement) || [...r.removedNodes].some(isElement))) measure();
        });
        const attach = () => {
            const next = target.querySelector<HTMLElement>(':scope > [data-stage-bar] [data-stage-row]');
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
     * **操作列を出している間は、字幕を操作列の上まで持ち上げる。**
     *
     * 操作バーは映像に重ねるので、下の方に出る字幕 (たいていの字幕) がシークバーと時刻の下に
     * 潜っていた (横にしたスマホでは2行目が丸ごと隠れた)。字を描く係 (`CaptionPainter`) が
     * 字の載っている縦の範囲を `data-ink` に書くので、操作バーの上端と比べて重なるぶんだけ
     * canvas を上へずらす (`translate`)。字を縮めたりはしない — 放送の升目どおりのまま動かす。
     *
     * - 持ち上げるのは重なるときだけ。上の方の字幕は動かない
     * - 枠の上端より上へは出さない (操作バーと字幕がどちらも長いときは、上を優先して見せる)
     * - 操作バーを引っ込めている間は戻す
     * - データ放送の小窓に映像ごと寄せている間も戻す (下の `offsetIn`)
     * - 小窓・切り抜きは canvas の中身を使うので、ずらしても影響しない
     */
    $effect(() => {
        const stage = element;
        if (stage === null) return;
        const lifting = controls.shown;
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
</script>

{#if ambient}
    <!-- 光は枠より前 (兄弟) に置く。位置を持つ枠のほうが後ろなので、光の上に描かれる -->
    <AmbientGlow {ambient} stage={element} fullscreen={fullscreen.active} testid="{testid}-ambient" />
{/if}
<!--
    枠の置き場。二段組では、枠が使える広さ (列の幅と高さ) をここで測る (下の style の `container-type`)
-->
<div class="room">
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!--
    **映像の周りは黒** (letterbox の帯にテーマ色を出さない)。縦横比は 16:9 (二段組では映像の形。下の style) で、高さは
    画面に収まるまで。**低くしすぎない** (224px) — 上下と右に操作バーを重ねるので、
    それより低いと操作バーどうしが重なって押せなくなる
-->
<div
    bind:this={element}
    class="stage"
    style:--dp-aspect={aspect}
    class:quiet={!controls.shown}
    data-compact={compact ? '' : undefined}
    data-fold={fold ? '' : undefined}
    data-narrow={slim ? '' : undefined}
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
        background: #000;
        aspect-ratio: 16 / 9;
        max-height: 100%;
        min-height: 14rem;
    }
    /* 置き場は箱を持たない (狭い画面・横にしたスマホ・広げた全画面。下で二段組だけ箱にする) */
    .room {
        display: contents;
    }
    /*
     * **二段組では、枠を映像の形にして、使える広さに収まる大きさにする** (上の `aspect`)。
     *
     * 幅は列の幅 (`100cqw`) と「高さ × 縦横比」(`100cqh`) の小さいほう。横に長い低い窓でも映像の左右に
     * 黒い帯が出ず、余った横は地 (アンビエントモードでは映像の色) になる。**上に寄せて、横は真ん中** —
     * 映像の左と右の列の中身までの間が同じになる (E2E の `expectSideFrame`)。
     * 高さの下限 (14rem) は今までどおり。それより低い窓では、枠は 14rem の高さで切れる。
     *
     * 測る箱 (`container-type: size`) は `.room` で、`<main>` の列そのものにはしない — 測る箱は
     * 中の `position: absolute` の基準になり、列に付けるとアンビエントモードの色 (`AmbientGlow`) の位置がずれる
     */
    @media (min-width: 768px) {
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
     * **スマホの縦では映像を画面の端から端まで。** 余白 (`--dp-gutter`、
     * `+layout.svelte`) のぶんだけ左右へはみ出させる。見出し・一覧・番組の中身は
     * 今までどおり余白の内側に残す。
     *
     * 余白の内側に置いていた頃は 390px の画面で枠が 358px しか無く、映像は
     * 358x201 (枠の高さの下限 224px との差が上下の黒帯) — **小さいうえに
     * 周りが黒く縁取られて**見えた。端まで出すと 390x219。
     * **高さの下限 (14rem) も外し、枠をちょうど映像の形 (16:9) にする** — 下限が残ると、
     * 映像より数 px 高い枠の上下に黒帯が出る。操作バーは引っ込むので、低い枠でも重なりは触った直後だけ
     *
     * 線は `sm` (640px) — ナビを畳むのと同じ幅。携帯の縦はみなこれより狭く、
     * 縦の iPad mini (744px) や横にした携帯は入らない (縦横比は今までどおり)。
     * 全画面にしたときは UA が `margin: 0 !important` を当てるので影響しない
     */
    @media (max-width: 639px) and (orientation: portrait) {
        .stage {
            margin-inline: calc(-1 * var(--dp-gutter, 1rem));
            min-height: 0;
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
        /* 二段組の置き場 (上) は使わない。枠は `PlayerLayout` の `.main` (画面の高さ) に直に置く */
        .room {
            display: contents;
        }
        .stage:not([data-pseudo]) {
            align-self: center;
            aspect-ratio: 16 / 9;
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
