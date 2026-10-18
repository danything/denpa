<script lang="ts">
    import { untrack } from 'svelte';
    import {
        EVERY,
        ease,
        FADE,
        FADE_STEPS,
        GLANCE,
        type GlowLayout,
        glowLayout,
        glowPixels,
        plan,
        type Rect,
        reach,
        region,
        SMOOTH,
        smoothFrame,
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
     * - **二段組** … 色を枠の後ろに敷き、枠の周りへ 20% だけにじませる。右の列は上のほうだけ面の色を
     *   透かし (72%)、色が下へ向かって面の色に溶ける
     * - 光の輪ではなく地の色に見えるよう、色は**明るさを抑えてから敷く** (`toneFrame`)。暗いテーマは深い色、
     *   明るいテーマは淡い色になり、上に載る字はどちらも 4.5 以上で読める (`WASH_LUMINANCE`)。
     *   明るいテーマでは色の薄い所を透明にし、`mix-blend-mode: multiply` で地に掛ける
     * - 見出しは塗らない (YouTube も塗らない)
     *
     * ## 作り
     *
     * - **写すのは `EVERY` (1秒) ごと。** 縮めるのは写す側 (`<video>` は worker、canvas に
     *   描いているときはその worker) で、画面の側で元の大きさの画素を読むことは無い
     * - 色は、枠の幅を 96 画素とした小さな canvas の中で作り (`ambient.ts` の `glowLayout`・`glowPixels`)、
     *   CSS で引き伸ばして見せる。色はいちばん近い枠の縁の色を強くぼかしたもの、濃さは枠からの距離で決める。
     *   **CSS の `filter: blur` は使わない** — ぼかしが画面の大きさになり、GPU の無い端末では重かった
     * - **色は時間でならす** (`smoothFrame`)。写した1枚は 4 割だけ取り込み、前までの色を 6 割残す。
     *   そのうえで **前の色から次の色へ `FADE` (1.2 秒) かけて 12 段で入れ替える** (`ease`。始めと終わりがゆっくり)。
     *   場面が変わっても跳ばず、2〜3 秒かけて新しい色に寄る。CSS で透明度を動かすと毎フレーム合成し直すので、
     *   段は canvas に描く
     * - **縦に積んで操作バーを映像の下に出しているとき (`data-under`)** は、操作バーの段にも色を敷く。
     *   枠の黒い地は映像の所だけにし、操作バーは薄い暗幕 (`ControlBar`) の上に載る
     * - **色は枠に重ならない4本の帯 (`.band`) にだけ描く** (`strips`)。帯はどれも同じ1枚を切り出す。
     *   枠の後ろに1枚で敷くと、映像が1コマ進むたびに後ろまで合成し直すことになる
     * - 範囲は `<main>` の縦の範囲と窓の横幅で切る (`region`)。ページの巻き取れる長さを増やさない
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

    const now = $derived(plan({ on: ambient.on, room, fullscreen, hidden, reduced, playing: ambient.playing, lit }));
    /** 光を出しているか。置き場はこれが変わったときだけ測り直す (写す・止めるの切り替えでは測らない) */
    const visible = $derived(now !== 'off');

    /** いまの置き場。枠の大きさが変わると変わる */
    let layout: GlowLayout | null = null;
    /** ぼかし終えた前の1枚と次の1枚 (画面に出さない canvas)。入れ替えの間は2枚を重ねて描く */
    let shown: HTMLCanvasElement | null = null;
    let coming: HTMLCanvasElement | null = null;
    /** 時間でならした色 (32x18 の RGBA。`smoothFrame`)。置き場やテーマが変わったら、これから作り直す */
    let smooth: Float32Array | null = null;
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
        toneFrame(frame, dark ? 'dark' : 'light', WASH_LUMINANCE[stacked ? 'stacked' : 'wide']);
        const pixels = glowPixels(frame, GLANCE.width, GLANCE.height, at);
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

    /** 帯の canvas に、前の1枚の上へ次の1枚を `mix` の濃さで重ねて描く */
    function paint(mix: number): void {
        for (const canvas of canvases) {
            const context = canvas?.getContext('2d');
            if (!canvas || !context) continue;
            context.clearRect(0, 0, canvas.width, canvas.height);
            if (shown !== null) {
                context.globalAlpha = 1;
                context.drawImage(shown, 0, 0);
            }
            if (coming !== null && mix > 0) {
                context.globalAlpha = mix;
                context.drawImage(coming, 0, 0);
            }
        }
    }

    /**
     * 写した1枚を取り込み (`smoothFrame`)、ならした色へ `FADE` の長さでゆっくり入れ替える
     * (動かさない設定ではすぐ)。場面が変わっても跳ばない — 取り込むのは 4 割で、入れ替えも長い
     */
    function show(bitmap: ImageBitmap): void {
        const pixels = framePixels(bitmap);
        bitmap.close();
        if (pixels === null) return;
        smooth = smoothFrame(smooth, pixels, SMOOTH);
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
        compose(coming, smooth, layout);
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
        smooth = null;
        shown = null;
        coming = null;
        paint(0);
    });

    /** テーマが変わったら、最後の1枚から塗り直す (色の濃くし方が違う) */
    $effect(() => {
        void dark;
        untrack(() => {
            if (smooth === null || layout === null) return;
            clearInterval(fading);
            coming = null;
            shown = scratch();
            compose(shown, smooth, layout);
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
            // 横は窓の幅いっぱい (二段組では右の列の下にも敷き、列が上のほうで透かす)。縦は `<main>` の中
            const bounds: Rect = { left: 0, top: m.top, right: document.documentElement.clientWidth, bottom: m.bottom };
            const spread = reach(s.width, !stacked);
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
                if (smooth !== null) {
                    shown = scratch();
                    compose(shown, smooth, next);
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
    :global(html:not([data-theme='dark'])) .band {
        mix-blend-mode: multiply;
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
    /* 二段組の右の列は、上のほうだけ面の色を透かして色を通し、下へ向かって面の色に戻す */
    @media (min-width: 768px) {
        :global(html[data-ambient] [data-player-layout] > aside) {
            background: linear-gradient(
                to bottom,
                color-mix(in srgb, var(--dp-surface) 72%, transparent),
                var(--dp-surface) 18rem
            );
        }
    }
</style>
