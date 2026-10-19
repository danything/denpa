<script lang="ts">
    import { untrack } from 'svelte';
    import {
        changed,
        coarse,
        EVERY,
        ease,
        FADE,
        FADE_STEPS,
        farthest,
        follow,
        frameDelta,
        GLANCE,
        type GlowLayout,
        GRID,
        glowLayout,
        glowPixels,
        plan,
        type Rect,
        reach,
        region,
        strips,
        toneFrame,
        WASH_LUMINANCE,
    } from './ambient';
    import type { Ambient } from './ambient.svelte.js';
    import { PHONE_LANDSCAPE } from './PlayerLayout.svelte';

    /**
     * アンビエントモード。**いまのコマの色を、映像の周りの地に薄く敷く** (YouTube と同じ見え方)。
     * 舞台 (`PlayerStage`) が枠のすぐ前 (兄弟) に置く。オン/オフと写し方は `ambient.svelte.ts`。
     *
     * ## 見え方
     *
     * - **縦に積むとき (768px より狭い)** … 映像の下の番組の中身に色を敷く。映像のすぐ下がいちばん濃く、
     *   下へ向かって地に溶ける (`reach` の 90%)。中身の字は色の上に直に載る
     * - **二段組** … 色を窓全体に敷く。映像の周りがいちばん濃く、窓の端へ向かって薄くなる (届く幅は枠から
     *   いちばん遠い窓の端まで。`farthest`)。見出しと右の列は地の色と区切りの線を外し、同じ色の上に載る
     * - 光の輪ではなく地の色に見えるよう、色は**明るさを抑えてから敷く** (`toneFrame`)。暗いテーマは深い色、
     *   明るいテーマは淡い色になり、上に載る字はどちらも 4.5 以上で読める (`WASH_LUMINANCE`)。
     *   明るいテーマでは色の薄い所を透明にし、`mix-blend-mode: multiply` で地に掛ける
     * - 見出しだけを別の色で塗ることはしない。二段組で見出しが色づくのは、窓全体に敷いた色の上に透けて載るから
     *
     * ## 作り
     *
     * - **写すのは `EVERY` (200ms) ごと、1秒に5回。** 縮めるのは写す側 (`<video>` は worker、canvas に
     *   描いているときはその worker) で、画面の側で元の大きさの画素を読むことは無い
     * - 色は、枠の幅を 96 画素とした小さな canvas の中で作り (`ambient.ts` の `glowLayout`・`glowPixels`)、
     *   CSS で引き伸ばして見せる。色は**写した1枚を横 4 x 縦 3 の格子に面積で平均したもの** (`coarse`) の、いちばん近い縁の所の色。濃さは枠からの距離で決める。
     *   **CSS の `filter: blur` は使わない** — ぼかしが画面の大きさになり、GPU の無い端末では重かった
     * - **前の色から次の色へ `FADE` (200ms) かけて 4 段で入れ替える** (`ease`)。色は時定数 250ms でならし (`follow`)、場面が変わったときだけすぐ切り替える。
     *   CSS で透明度を動かすと毎フレーム合成し直すので、段は canvas に描く
     * - **縦に積んで操作バーを映像の下に出しているとき (`data-under`)** は、操作バーの段にも色を敷く。
     *   枠の黒い地は映像の所だけにし、操作バーは薄い暗幕 (`ControlBar`) の上に載る
     * - **色は枠に重ならない4本の帯 (`.band`) にだけ描く** (`strips`)。帯はどれも同じ1枚を切り出す。
     *   枠の後ろに1枚で敷くと、映像が1コマ進むたびに後ろまで合成し直すことになる
     * - 範囲は、二段組では窓全体、縦に積むときは `<main>` の縦の範囲と窓の横幅で切る (`region`)。
     *   ページの巻き取れる長さを増やさない
     *
     * ## 写さないとき (`ambient.ts` の `plan`)
     *
     * 止めている間・裏に回った間・全画面の間は写さない (色は最後の1枚のまま)。**動かさない設定の端末では
     * 1枚だけ写して止める** (入れ替えの段も付けない)。横にしたスマホでは映像の周りに地が残らないので出さない。
     *
     * **映像の上には何も重ねない** — 色は枠の外だけで、字幕・データ放送・操作バー・CM 飛ばしの通知は
     * 枠の中にある
     */
    let {
        ambient,
        stage,
        fullscreen,
        testid,
    }: {
        ambient: Ambient;
        /** 映像の枠 (`PlayerStage` の `.stage`) */
        stage: HTMLElement | null;
        /** 全画面か (`StageFullscreen.active`) */
        fullscreen: boolean;
        testid: string;
    } = $props();

    /** 入れ替えの1段の長さ (ms) */
    const FADE_STEP = FADE / FADE_STEPS;

    const BANDS = [0, 1, 2, 3];
    let box = $state<HTMLDivElement | null>(null);
    const bands = $state<(HTMLDivElement | null)[]>([null, null, null, null]);
    const canvases = $state<(HTMLCanvasElement | null)[]>([null, null, null, null]);

    let hidden = $state(false);
    let reduced = $state(false);
    let room = $state(false);
    /** 縦に積んでいるか (768px より狭い)。色は映像の下へだけ敷く */
    let stacked = $state(false);
    let dark = $state(false);
    /** もう1枚写して光を出しているか */
    let lit = $state(false);
    /** 写した回数。E2E が「動いている・止まっている」を見る */
    let updates = $state(0);
    /** 最後に写した1枚と、最後に入れ替えた1枚の違い (`frameDelta`)。E2E が「止まった映像では 0 に近い」を見る */
    let delta = $state<number | null>(null);

    const now = $derived(plan({ on: ambient.on, room, fullscreen, hidden, reduced, playing: ambient.playing, lit }));
    /** 光を出しているか。置き場はこれが変わったときだけ測り直す (写す・止めるの切り替えでは測らない) */
    const visible = $derived(now !== 'off');

    /** いまの置き場。枠の大きさが変わると変わる */
    let layout: GlowLayout | null = null;
    /** ぼかし終えた前の1枚と次の1枚 (画面に出さない canvas)。入れ替えの間は2枚を重ねて描く */
    let shown: HTMLCanvasElement | null = null;
    let coming: HTMLCanvasElement | null = null;
    /** いまの色 (格子 `GRID` の RGBA。時間でならしたもの)。置き場やテーマが変わったら、これから作り直す */
    let colors: Float32Array | null = null;
    /** 時間でならした色 (`follow`)。写すたびに進め、違いが大きくなったら `colors` に移す */
    let smoothed: Float32Array | null = null;
    /** 最後に写した時刻 (`performance.now`)。ならす重みを、経った時間で決める */
    let lastAt: number | null = null;
    let fading: ReturnType<typeof setInterval> | undefined;

    function scratch(): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = layout?.width ?? 1;
        canvas.height = layout?.height ?? 1;
        return canvas;
    }

    /** ならした色から、敷く色を作って描く (`toneFrame`・`glowPixels`) */
    function compose(target: HTMLCanvasElement, colors: Float32Array, at: GlowLayout): void {
        const context = target.getContext('2d');
        if (context === null) return;
        const frame = Uint8ClampedArray.from(colors);
        toneFrame(frame, dark ? 'dark' : 'light', WASH_LUMINANCE);
        const pixels = glowPixels(frame, GRID.width, GRID.height, at);
        context.putImageData(new ImageData(pixels, at.width, at.height), 0, 0);
    }

    let edge: HTMLCanvasElement | null = null;

    /** 写した1枚の画素 (32x18 の RGBA) */
    function framePixels(bitmap: ImageBitmap): Uint8ClampedArray | null {
        if (edge === null) {
            edge = document.createElement('canvas');
            edge.width = GLANCE.width;
            edge.height = GLANCE.height;
        }
        const context = edge.getContext('2d', { willReadFrequently: true });
        if (context === null) return null;
        context.clearRect(0, 0, GLANCE.width, GLANCE.height);
        context.drawImage(bitmap, 0, 0, GLANCE.width, GLANCE.height);
        return context.getImageData(0, 0, GLANCE.width, GLANCE.height).data;
    }

    /**
     * 帯の canvas に、前の1枚から次の1枚へ `mix` だけ進んだ色を描く。**2枚を足し合わせて混ぜる** —
     * 前の1枚を `1 - mix`、次の1枚を `mix` の濃さで描き、2枚目は重ねずに足す (`lighter`)。canvas は透明度を
     * 掛けた色で持つので、足すとちょうど 2 枚の間の色になる。
     *
     * 前の1枚を濃さ 1 のまま描き、その上に次の1枚を重ねていた頃は、光の薄い所 (縁へ向かって透ける所) で
     * 2 枚の透明度が重なって入れ替えの間だけ濃くなり、入れ替え終わると元の薄さへ落ちていた。1 秒に 5 回
     * 入れ替えるので、光が 5 回明滅して見えた (画面に出たコマで、明るさが 31.6 → 37.3 と上がっては落ちていた)
     */
    function paint(mix: number): void {
        for (const canvas of canvases) {
            const context = canvas?.getContext('2d');
            if (!canvas || !context) continue;
            context.clearRect(0, 0, canvas.width, canvas.height);
            const blending = coming !== null && mix > 0;
            context.globalCompositeOperation = 'source-over';
            if (shown !== null) {
                context.globalAlpha = blending ? 1 - mix : 1;
                context.drawImage(shown, 0, 0);
            }
            if (blending && coming !== null) {
                context.globalCompositeOperation = 'lighter';
                context.globalAlpha = mix;
                context.drawImage(coming, 0, 0);
            }
            context.globalCompositeOperation = 'source-over';
            context.globalAlpha = 1;
        }
    }

    /**
     * 写した1枚を次の色にして、`FADE` の長さで前の色から入れ替える (動かさない設定ではすぐ)
     */
    function show(bitmap: ImageBitmap): void {
        const pixels = framePixels(bitmap);
        bitmap.close();
        if (pixels === null) return;
        // 粗い格子に平均し (`coarse`)、時間でならす (`follow`。場面が変わったらすぐ)
        const now = performance.now();
        // ならした色は、入れ替えるかどうかに関わらず毎回進める (入れ替えを見送っても、ゆっくりした変化を捨てない)
        smoothed = follow(smoothed, coarse(pixels), lastAt === null ? EVERY : now - lastAt);
        lastAt = now;
        // 最後に入れ替えた色との違い。小さければ入れ替えない (`ambient.ts` の `changed`)
        delta = colors === null ? null : frameDelta(colors, smoothed);
        if (colors !== null && !changed(colors, smoothed)) return;
        colors = Float32Array.from(smoothed);
        if (layout === null) return;
        clearInterval(fading);
        coming ??= scratch();
        shown ??= scratch();
        // 入れ替えの途中で次が来たら、途中まで出ていたものを前の1枚にする (色が跳ねない)
        const painted = canvases.find((c) => c !== null);
        if (painted) {
            const context = shown.getContext('2d');
            context?.clearRect(0, 0, layout.width, layout.height);
            context?.drawImage(painted, 0, 0);
        }
        compose(coming, colors, layout);
        const swap = () => {
            [shown, coming] = [coming, shown];
            paint(0);
        };
        if (reduced) {
            swap();
            return;
        }
        let step = 1;
        paint(ease(step / FADE_STEPS));
        fading = setInterval(() => {
            step++;
            if (step >= FADE_STEPS) {
                clearInterval(fading);
                swap();
            } else paint(ease(step / FADE_STEPS));
        }, FADE_STEP);
    }

    $effect(() => {
        const motion = matchMedia('(prefers-reduced-motion: reduce)');
        const twoColumns = matchMedia('(min-width: 768px)');
        const phone = matchMedia(PHONE_LANDSCAPE);
        const check = () => {
            hidden = document.visibilityState === 'hidden';
            reduced = motion.matches;
            room = !phone.matches;
            stacked = !twoColumns.matches;
            dark = document.documentElement.dataset['theme'] === 'dark';
        };
        check();
        document.addEventListener('visibilitychange', check);
        // テーマは設定と端末の設定で変わる (`+layout.svelte` が `<html data-theme>` を書き換える)
        const theme = new MutationObserver(check);
        theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        for (const media of [motion, twoColumns, phone]) media.addEventListener('change', check);
        return () => {
            document.removeEventListener('visibilitychange', check);
            theme.disconnect();
            for (const media of [motion, twoColumns, phone]) media.removeEventListener('change', check);
        };
    });

    /** 色を敷いている間、右の列を色の上に描かせる (`<html data-ambient>`。下の style) */
    $effect(() => {
        if (now === 'off' || !lit) return;
        const root = document.documentElement;
        root.dataset['ambient'] = '';
        return () => {
            delete root.dataset['ambient'];
        };
    });

    /** 消したら光も捨てる。次にオンにしたときに古い色が出ないように */
    $effect(() => {
        if (now !== 'off') return;
        lit = false;
        clearInterval(fading);
        colors = null;
        smoothed = null;
        lastAt = null;
        shown = null;
        coming = null;
        paint(0);
    });

    /** テーマが変わったら、最後の1枚から塗り直す (色の濃くし方が違う) */
    $effect(() => {
        void dark;
        untrack(() => {
            if (colors === null || layout === null) return;
            clearInterval(fading);
            coming = null;
            shown = scratch();
            compose(shown, colors, layout);
            paint(0);
        });
    });

    $effect(() => () => clearInterval(fading));

    /**
     * **範囲と帯の置き場を、枠に合わせて決める。** 枠・`<main>`・右の列の大きさが変わったとき、
     * 右の列が入れ替わったとき (ライブの局の一覧 ⇔ 番組の中身) に測り直す
     */
    $effect(() => {
        const target = stage;
        const outer = box;
        if (target === null || outer === null || !visible) return;
        const main = target.closest('main') ?? document.documentElement;
        const frame = target.closest<HTMLElement>('[data-player-layout]');
        const measure = () => {
            const rect = target.getBoundingClientRect();
            /*
             * **操作バーを映像の下に出している間 (`data-under`) は、映像の所だけを枠とみなす。** 色は映像の
             * 下の端から敷き、操作バーの下にも流す (操作バーは色の上に透けて載る。下の style)
             */
            const s = target.hasAttribute('data-under')
                ? new DOMRect(rect.left, rect.top, rect.width, (rect.width * 9) / 16)
                : rect;
            const m = main.getBoundingClientRect();
            /*
             * 二段組は**窓全体** (見出しと右の列の下にも敷き、窓の端へ向かって薄くする)。
             * 縦に積むときは、横は窓の幅、縦は `<main>` の中
             */
            const width = document.documentElement.clientWidth;
            const bounds: Rect = stacked
                ? { left: 0, top: m.top, right: width, bottom: m.bottom }
                : { left: 0, top: 0, right: width, bottom: window.innerHeight };
            const spread = stacked ? reach(s.width, false) : Math.max(reach(s.width, true), farthest(s, bounds));
            const area = region(s, bounds, spread);
            /*
             * 範囲の座標は入れ物 (いちばん近い位置を持つ祖先。無ければ文書) の内側から。
             * 文書のときは巻き取ったぶんを足す
             */
            const parent = outer.offsetParent;
            let baseLeft = -window.scrollX;
            let baseTop = -window.scrollY;
            if (parent instanceof HTMLElement && getComputedStyle(parent).position !== 'static') {
                const p = parent.getBoundingClientRect();
                baseLeft = p.left + parent.clientLeft - parent.scrollLeft;
                baseTop = p.top + parent.clientTop - parent.scrollTop;
            }
            const areaWidth = area.right - area.left;
            const areaHeight = area.bottom - area.top;
            outer.style.left = `${area.left - baseLeft}px`;
            outer.style.top = `${area.top - baseTop}px`;
            outer.style.width = `${areaWidth}px`;
            outer.style.height = `${areaHeight}px`;

            const next = glowLayout(area, s, spread);
            const resized = layout === null || next.width !== layout.width || next.height !== layout.height;
            const moved =
                resized || next.x !== layout?.x || next.y !== layout?.y || next.radius !== layout?.radius;
            layout = next;

            const parts = strips(area, s);
            BANDS.forEach((i) => {
                const band = bands[i];
                const canvas = canvases[i];
                if (!band || !canvas) return;
                const part = parts[i];
                band.hidden = part === undefined;
                if (part === undefined) return;
                band.style.left = `${part.left - area.left}px`;
                band.style.top = `${part.top - area.top}px`;
                band.style.width = `${part.right - part.left}px`;
                band.style.height = `${part.bottom - part.top}px`;
                // canvas は範囲全体を覆い、帯はその一部を切り出す
                canvas.style.left = `${area.left - part.left}px`;
                canvas.style.top = `${area.top - part.top}px`;
                canvas.style.width = `${areaWidth}px`;
                canvas.style.height = `${areaHeight}px`;
                if (resized) {
                    canvas.width = next.width;
                    canvas.height = next.height;
                }
            });
            // 置き場が変わったら、最後の1枚からぼかし直す (入れ替えの途中なら、そこで済ませる)
            if (moved) {
                clearInterval(fading);
                coming = null;
                shown = null;
                if (colors !== null) {
                    shown = scratch();
                    compose(shown, colors, next);
                }
                paint(0);
            }
        };
        measure();
        const sizes = new ResizeObserver(measure);
        const watchAside = () => {
            sizes.disconnect();
            sizes.observe(target);
            sizes.observe(main);
            const aside = frame?.querySelector(':scope > aside');
            if (aside) sizes.observe(aside);
            measure();
        };
        watchAside();
        const children = new MutationObserver(watchAside);
        if (frame) children.observe(frame, { childList: true });
        window.addEventListener('resize', measure);
        return () => {
            sizes.disconnect();
            children.disconnect();
            window.removeEventListener('resize', measure);
        };
    });

    /** 写す。`watch` の間だけ、`EVERY` ごとに */
    $effect(() => {
        if (now !== 'watch') return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const run = async () => {
            let bitmap: ImageBitmap | null = null;
            try {
                bitmap = (await ambient.glance(GLANCE)) ?? null;
            } catch {
                // 写せなかった (切り替えの途中など)。次の回にまた写す
            }
            if (stopped) {
                bitmap?.close();
                return;
            }
            if (bitmap !== null) {
                show(bitmap);
                updates++;
                lit = true;
            }
            timer = setTimeout(run, EVERY);
        };
        void run();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    });
</script>

<div
    bind:this={box}
    class="ambient"
    data-off={now === 'off' ? '' : undefined}
    data-plan={now}
    data-updates={updates}
    data-delta={delta === null ? undefined : delta.toFixed(2)}
    data-testid={testid}
    aria-hidden="true"
>
    {#each BANDS as i (i)}
        <div bind:this={bands[i]} class="band">
            <canvas bind:this={canvases[i]}></canvas>
        </div>
    {/each}
</div>

<style>
    /*
     * 色を敷く範囲。位置と大きさは上の `measure` が書く。**自分では何も描かない** (帯が描く)。
     * 文書の順で枠より前にあるので、重なっても枠の下になる
     */
    .ambient {
        position: absolute;
        pointer-events: none;
    }
    .ambient[data-off] {
        display: none;
    }
    .band {
        position: absolute;
        overflow: hidden;
    }
    /* 明るいテーマでは地に掛ける (色の付いた所だけが乗る。`toneFrame` が色の薄い所を透明にしてある) */
    /* 窓全体に敷くので、明るいテーマは控えめに (白へ寄るだけなので、字の読みやすさは変わらない) */
    :global(html:not([data-theme='dark'])) .band {
        mix-blend-mode: multiply;
        opacity: 0.6;
    }
    canvas {
        position: absolute;
    }
    /*
     * **右の列 (と、縦に積んだときの番組の中身) は色の上に描く。** 位置を持たせて、文書の順で色より後ろに
     * 描かせる (位置を持たない箱は、位置を持つ色より先に描かれて隠れる)
     */
    :global(html[data-ambient] [data-player-layout] > aside) {
        position: relative;
    }
    /*
     * **二段組では、見出しも同じ色の上に載せる** (YouTube と同じ)。見出しの地とぼかしを外す。右の列と見出しの
     * 区切りの線は、色の有る無しに関わらず付けない (`PlayerLayout`)。字はどれも色の上に直に載るが、色の明るさを
     * 抑えてあるので 4.5 以上で読める (`WASH_LUMINANCE`)
     */
    @media (min-width: 768px) {
        :global(html[data-ambient] .navbar) {
            background: transparent;
            -webkit-backdrop-filter: none;
            backdrop-filter: none;
        }
    }
</style>
