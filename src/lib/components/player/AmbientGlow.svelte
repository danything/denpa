<script lang="ts">
    import {
        blurPixels,
        EVERY,
        GLANCE,
        type GlowLayout,
        glowLayout,
        plan,
        type Rect,
        region,
        strips,
    } from './ambient';
    import type { Ambient } from './ambient.svelte.js';
    import { PHONE_LANDSCAPE } from './PlayerLayout.svelte';

    /**
     * アンビエントモードの光。**いまのコマの色をぼかして、映像の枠の周りへ広げる。**
     * 舞台 (`PlayerStage`) が枠のすぐ前 (兄弟) に置く。オン/オフと写し方は `ambient.svelte.ts`。
     *
     * ## 作り
     *
     * - 写すのは `EVERY` (200ms) ごと、1秒に5回まで。**縮めるのは写す側** (`<video>` は worker、canvas に
     *   描いているときはその worker) で、画面の側で元の大きさの画素を読むことは無い
     * - 写した 32x18 を、枠の幅を 64 画素とした小さな canvas に置いてぼかし (`ambient.ts` の `glowLayout`・
     *   `blurPixels`。1回 80x50 画素ほど)、CSS で引き伸ばして見せる。**CSS の `filter: blur` は使わない** —
     *   ぼかしが画面の大きさになり、GPU の無い端末では入れ替えのたびに重かった
     * - **前の1枚から次の1枚へ、`EVERY` の長さで 4 段に分けて入れ替える** (`FADE_STEP` ごと)。
     *   CSS で透明度を動かすと、その間は毎フレーム光を合成し直すことになる
     * - **光は枠の周りの4本の帯 (`.band`) にだけ描く** (`strips`)。帯はどれも同じ光を持ち、自分の所だけを
     *   切り出して見せる。枠の後ろに1枚で敷くと、映像が1コマ進むたびに後ろの光まで合成し直すことになる
     * - 光の届く範囲は `<main>` の内側と右の列の左端で切る (`region`)。列の上に光を出さない・ページの
     *   巻き取れる長さを増やさない。切った端でも急に途切れないよう、範囲の縁で薄くする (`mask-image`)
     *
     * ## 写さないとき (`ambient.ts` の `plan`)
     *
     * 止めている間・裏に回った間・全画面の間は写さない (光は最後の1枚のまま)。**動かさない設定の端末では
     * 1枚だけ写して止める** (入れ替えの段も付けない)。**明るいテーマでは出さない** (`plan` の `dark`)。
     * 狭い画面・横にしたスマホでは映像の周りに地が残らないので出さない。
     *
     * **映像の上には何も重ねない** — 光は枠の外だけで、字幕・データ放送・操作バー・CM 飛ばしの通知は
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

    /** 入れ替えの1段の長さ (ms)。`EVERY` を4段に分ける */
    const FADE_STEP = EVERY / 4;

    const BANDS = [0, 1, 2, 3];
    let box = $state<HTMLDivElement | null>(null);
    const bands = $state<(HTMLDivElement | null)[]>([null, null, null, null]);
    const canvases = $state<(HTMLCanvasElement | null)[]>([null, null, null, null]);

    let hidden = $state(false);
    let reduced = $state(false);
    let wide = $state(false);
    let dark = $state(false);
    /** もう1枚写して光を出しているか */
    let lit = $state(false);
    /** 写した回数。E2E が「動いている・止まっている」を見る */
    let updates = $state(0);

    const now = $derived(plan({ on: ambient.on, wide, dark, fullscreen, hidden, reduced, playing: ambient.playing, lit }));
    /** 光を出しているか。置き場はこれが変わったときだけ測り直す (写す・止めるの切り替えでは測らない) */
    const visible = $derived(now !== 'off');

    /** いまの置き場。枠の大きさが変わると変わる */
    let layout: GlowLayout | null = null;
    /** ぼかし終えた前の1枚と次の1枚 (画面に出さない canvas)。入れ替えの間は2枚を重ねて描く */
    let shown: HTMLCanvasElement | null = null;
    let coming: HTMLCanvasElement | null = null;
    /** 最後に写した1枚。置き場が変わったら、これからぼかし直す */
    let last: ImageBitmap | null = null;
    let fading: ReturnType<typeof setInterval> | undefined;

    function scratch(): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = layout?.width ?? 1;
        canvas.height = layout?.height ?? 1;
        return canvas;
    }

    /** 写した1枚を置き場に描いてぼかす */
    function compose(target: HTMLCanvasElement, bitmap: ImageBitmap, at: GlowLayout): void {
        const context = target.getContext('2d', { willReadFrequently: true });
        if (context === null) return;
        context.clearRect(0, 0, at.width, at.height);
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, at.x, at.y, at.w, at.h);
        const image = context.getImageData(0, 0, at.width, at.height);
        blurPixels(image.data, at.width, at.height, at.radius);
        context.putImageData(image, 0, 0);
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

    /** 次の1枚を出す。`EVERY` の長さで前の1枚から入れ替える (動かさない設定ではすぐ) */
    function show(bitmap: ImageBitmap): void {
        last?.close();
        last = bitmap;
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
        compose(coming, bitmap, layout);
        const swap = () => {
            [shown, coming] = [coming, shown];
            paint(0);
        };
        if (reduced) {
            swap();
            return;
        }
        let step = 1;
        paint(step / 4);
        fading = setInterval(() => {
            step++;
            if (step >= 4) {
                clearInterval(fading);
                swap();
            } else paint(step / 4);
        }, FADE_STEP);
    }

    $effect(() => {
        const motion = matchMedia('(prefers-reduced-motion: reduce)');
        const twoColumns = matchMedia('(min-width: 768px)');
        const phone = matchMedia(PHONE_LANDSCAPE);
        const check = () => {
            hidden = document.visibilityState === 'hidden';
            reduced = motion.matches;
            wide = twoColumns.matches && !phone.matches;
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

    /** 消したら光も捨てる。次にオンにしたときに古い色が出ないように */
    $effect(() => {
        if (now !== 'off') return;
        lit = false;
        clearInterval(fading);
        last?.close();
        last = null;
        shown = null;
        coming = null;
        paint(0);
    });

    $effect(() => () => {
        clearInterval(fading);
        last?.close();
        last = null;
    });

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
            const s = target.getBoundingClientRect();
            const m = main.getBoundingClientRect();
            const bounds: Rect = { left: m.left, top: m.top, right: m.right, bottom: m.bottom };
            const aside = frame?.querySelector<HTMLElement>(':scope > aside');
            if (aside) {
                const a = aside.getBoundingClientRect();
                if (a.left >= s.right - 1) bounds.right = Math.min(bounds.right, a.left);
            }
            const area = region(s, bounds);
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

            const next = glowLayout(area, s);
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
                // 縁を薄くする覆いは範囲全体の大きさで敷き、帯の位置ぶんずらす (帯どうしで繋がって見える)
                band.style.maskSize = `${areaWidth}px ${areaHeight}px`;
                band.style.maskPosition = `${area.left - part.left}px ${area.top - part.top}px`;
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
                if (last !== null) {
                    shown = scratch();
                    compose(shown, last, next);
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
     * 光の届く範囲。位置と大きさは上の `measure` が書く。**自分では何も描かない** (帯が描く)。
     * 文書の順で枠より前にあるので、重なっても枠の下になる
     */
    .ambient {
        --ambient-fade: 2.5rem;
        position: absolute;
        pointer-events: none;
    }
    .ambient[data-off] {
        display: none;
    }
    .band {
        position: absolute;
        overflow: hidden;
        opacity: 0.55;
        /* 範囲の縁で薄くする。範囲全体の大きさで敷き、帯の位置ぶんずらす (`measure` の `maskSize`・`maskPosition`) */
        mask-image:
            linear-gradient(
                to right,
                transparent,
                #000 var(--ambient-fade),
                #000 calc(100% - var(--ambient-fade)),
                transparent
            ),
            linear-gradient(
                to bottom,
                transparent,
                #000 var(--ambient-fade),
                #000 calc(100% - var(--ambient-fade)),
                transparent
            );
        mask-repeat: no-repeat;
        mask-composite: intersect;
    }
    canvas {
        position: absolute;
    }
</style>
