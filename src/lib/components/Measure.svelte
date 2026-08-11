<script lang="ts">
    /**
     * **画面の高さを、その端末で読むための札。** URL に `?measure` を付けた
     * ときだけ出る。
     *
     * 縦のはみ出しは**端末でしか起きない**ことがある。ブラウザの自動運転には
     * 引っ込むアドレスバーも、携帯の枠の切り欠きも作れないので、
     * 「手元では出ないが実機では出る」を追う手が無かった
     * (実機の PWA で「リロードすると画面全体がスクロールできる」として出た)。
     *
     * 出すのは**どこがはみ出しているか**まで。数だけ見ても、土台が高いのか
     * 中身が高いのか分からない
     */

    import { onMount } from 'svelte';

    /** 単位ごとの実際の高さ。**同じ数とは限らない**のが要点 */
    interface Units {
        dvh: number;
        svh: number;
        lvh: number;
        vh: number;
    }

    interface Culprit {
        what: string;
        bottom: number;
    }

    let inner = $state(0);
    let width = $state(0);
    let client = $state(0);
    let scroll = $state(0);
    let units = $state<Units | null>(null);
    let mode = $state('');
    let wide = $state(false);
    /**
     * 土台の実際の姿。
     *
     * **塞いであるはずのものが塞がっていないことがある。** 二段組の画面では
     * 土台に `md:h-[100dvh] md:overflow-hidden` が当たっていて、当たっていれば
     * ページごと動きようがない。**はみ出しが出ているのに当たっている**なら、
     * はみ出させているのは土台の外に居るもの (`position: fixed` は塞ぎを
     * すり抜ける)
     */
    let base = $state('');
    let culprits = $state<Culprit[]>([]);

    const over = $derived(scroll - client);

    /**
     * その要素の見分け。**class は先頭だけ** — 全部出すと札が画面を覆う。
     *
     * `id` は属性から採る。`<form>` の `.id` は**中の入力欄**を指すことが
     * あり (名前の付いた部品が同名の属性より前に出る古い決まり)、そのまま
     * 出すと `form#[object HTMLInputElement]` になる
     */
    function name(element: Element): string {
        const tag = element.tagName.toLowerCase();
        const attr = element.getAttribute('id');
        const id = attr === null || attr === '' ? '' : `#${attr}`;
        const testid = element.getAttribute('data-testid');
        if (testid !== null) return `${tag}${id}[${testid}]`;
        const cls = element.className;
        const first = typeof cls === 'string' && cls !== '' ? `.${cls.split(/\s+/)[0]}` : '';
        return `${tag}${id}${first}`;
    }

    /**
     * 単位ごとの高さを実際に測る。
     *
     * `dvh` (いま見えている) と `lvh` (バーが引っ込んだとき) が食い違う端末では、
     * **片方で組んだ土台にもう片方の中身を入れるとはみ出す**。計算では出せない
     * ので、その場に置いて測る
     */
    function measureUnits(): Units {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:absolute; visibility:hidden; pointer-events:none; top:0; left:0;';
        document.body.appendChild(probe);
        const one = (unit: string): number => {
            probe.style.height = `100${unit}`;
            return Math.round(probe.getBoundingClientRect().height);
        };
        const found = { dvh: one('dvh'), svh: one('svh'), lvh: one('lvh'), vh: one('vh') };
        probe.remove();
        return found;
    }

    /**
     * ページごとはみ出している要素。**深いものから3つ** (浅いものは親の巻き添え)。
     *
     * **ページが動かないなら何も出さない。** 中で自分だけスクロールする枠
     * (番組表の表など) の中身は、画面の下より深いところに居るのが正しい。
     * それを並べると、はみ出していない画面にまで犯人が出る
     */
    function findCulprits(limit: number): Culprit[] {
        if (scroll - client <= 1) return [];
        const found: Culprit[] = [];
        for (const element of document.querySelectorAll('body *')) {
            const box = element.getBoundingClientRect();
            if (box.height === 0) continue;
            const bottom = Math.round(box.bottom + window.scrollY);
            if (bottom <= limit + 1) continue;
            found.push({ what: name(element), bottom });
        }
        return found.slice(-3).reverse();
    }

    function take(): void {
        inner = Math.round(window.innerHeight);
        width = Math.round(window.innerWidth);
        client = document.documentElement.clientHeight;
        scroll = document.documentElement.scrollHeight;
        units = measureUnits();
        mode =
            ['standalone', 'fullscreen', 'minimal-ui', 'browser'].find(
                (m) => matchMedia(`(display-mode: ${m})`).matches,
            ) ?? '?';
        // 二段組にする線。ここを越えているかで、土台に当たる決まりが変わる
        wide = matchMedia('(min-width: 768px)').matches;

        const root = document.querySelector('body > div > div');
        if (root === null) {
            base = '土台が見つからない';
        } else {
            const style = getComputedStyle(root);
            base = `土台 ${Math.round(root.getBoundingClientRect().height)} (h:${style.height} over:${style.overflowY})`;
        }

        culprits = findCulprits(client);
    }

    onMount(() => {
        take();
        // 撮り直す口。バーの出入りでも切り替わるので、動くたびに測る
        const again = () => take();
        window.addEventListener('resize', again);
        window.addEventListener('scroll', again, { passive: true });
        window.visualViewport?.addEventListener('resize', again);
        return () => {
            window.removeEventListener('resize', again);
            window.removeEventListener('scroll', again);
            window.visualViewport?.removeEventListener('resize', again);
        };
    });
</script>

<!--
    **押せないようにしておく。** 出しているのは読むための数で、下にあるものを
    触れなくしたら本末転倒
-->
<div
    class="pointer-events-none fixed right-1 bottom-1 z-[100] max-w-[95vw] rounded
           bg-black/85 px-2 py-1 font-mono text-[10px] leading-tight text-white"
    data-testid="measure"
>
    <div>
        窓 {width}x{inner} / 枠 {client} / 中身 {scroll} =
        <b class={over > 1 ? 'text-red-400' : 'text-green-400'}>はみ出し {over}</b>
    </div>
    <div>{base} / {wide ? '二段組 (md)' : '一段 (md 未満)'}</div>
    {#if units !== null}
        <div>dvh {units.dvh} / svh {units.svh} / lvh {units.lvh} / vh {units.vh} — {mode}</div>
    {/if}
    {#each culprits as culprit (culprit.what + culprit.bottom)}
        <div>↳ {culprit.what} → {culprit.bottom}</div>
    {/each}
</div>
