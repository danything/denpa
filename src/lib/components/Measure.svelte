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
    /** 土台に実際に付いている class。**当たっているかどうかを、結果と別に見る** */
    let rootClass = $state('');
    /** 決まりが載っている CSS に本当にあるか。**class が付いていることとは別** */
    let rules = $state('');
    /** 土台と同じ置かれ方で `100dvh` を測ったらいくつか。**浮かせた札との差を見る** */
    let plain = $state(0);
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
     * **その決まりが本当に届いているか。**
     *
     * 同じ `@media` の中の3つのうち2つだけ効く、ということは起こらない。
     * 起きているように見えるなら、**片方の決まりがそこに無い** (配られた
     * CSS が古い) を疑う。当てずっぽうで直す前に、載っている CSS を数える
     */
    function ruleState(): string {
        const sheets = Array.from(document.styleSheets);
        let seen = 0;
        let found = false;
        for (const sheet of sheets) {
            let top: CSSRule[];
            try {
                top = Array.from(sheet.cssRules);
            } catch {
                // 別の出どころの CSS は中身を読めない。数えるだけ
                continue;
            }
            const stack = [...top];
            while (stack.length > 0) {
                const rule = stack.pop();
                if (rule === undefined) break;
                /*
                 * **数えるほうが先。** `CSSStyleRule` にも `cssRules` がある
                 * (入れ子が書けるようになったため、たいてい空)。潜るほうを
                 * 先に見ると**規則が全部そちらへ流れて 0件になる** (実際なった)
                 */
                if (rule instanceof CSSStyleRule) {
                    seen++;
                    if (rule.selectorText.includes('h-\\[100dvh\\]')) found = true;
                }
                /*
                 * **入れ子はぜんぶ潜る。** `@media` だけ見ていても届かない —
                 * Tailwind は中身を `@layer` に入れるので、そこで止まる
                 */
                const inner = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules;
                if (inner !== undefined) stack.push(...Array.from(inner));
            }
        }
        const href = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]'))
            .map((link) => link.href.split('/').pop())
            .join(' ');
        return `決まり ${found ? '有' : '無'} / ${seen}件 / ${href}`;
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

        /*
         * **浮かせずにも測る。** 上のものは `position: absolute` で浮いている。
         * 土台は流れの中に居るので、置かれ方で答えが変わるならそこが効いている
         */
        const flat = document.createElement('div');
        flat.style.cssText = 'height:100dvh; visibility:hidden; pointer-events:none;';
        document.body.appendChild(flat);
        plain = Math.round(flat.getBoundingClientRect().height);
        flat.remove();

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

        /*
         * **土台は class で探す。** `body > div > div` で採っていたが、
         * それが本当に土台かどうかは形しだいで、外すと**別のものの数を
         * 土台として報せる**。実機で「`overflow:hidden` は効いているのに
         * `height:100dvh` が効いていない」という辻褄の合わない値が出た
         */
        const root = document.querySelector('[data-root]');
        if (root === null) {
            base = '土台が見つからない';
        } else {
            const style = getComputedStyle(root);
            base = `土台 ${Math.round(root.getBoundingClientRect().height)} (h:${style.height} min:${style.minHeight} over:${style.overflowY})`;
            // **決まりが当たっているかと、当たった結果は別。** class ごと出す
            rootClass = root.className;
        }

        rules = ruleState();
        culprits = findCulprits(client);
    }

    onMount(() => {
        take();

        /*
         * **測り続ける。**
         *
         * 1回だけ撮っていたが、**それでは組み上がる前の姿を報せうる** —
         * 字が届く前、一覧が伸びる前、知らせで中身が入れ替わる前。実機から
         * 「土台の高さが 763.765px」という、決まりとも中身とも合わない値が
         * 返ってきた。読むための道具が嘘をつくと、そこから先が全部無駄になる。
         *
         * 形が変わったら測り直す (`ResizeObserver`) のに加えて、**中身が
         * 入れ替わっても**測り直す (`MutationObserver`)。どちらもコマに
         * 束ねてから測る — 測ること自体で組み直しを呼ぶので、そのまま
         * 走らせると止まらなくなる
         */
        const again = () => take();
        let waiting = 0;
        const later = () => {
            if (waiting !== 0) return;
            waiting = requestAnimationFrame(() => {
                waiting = 0;
                take();
            });
        };

        window.addEventListener('resize', again);
        window.addEventListener('scroll', again, { passive: true });
        window.visualViewport?.addEventListener('resize', again);

        /*
         * **見張るのは土台の中だけ。** この札も body の中に居るので、body ごと
         * 見張ると**自分が書き換わったことで測り直しに来る**。コマに束ねても
         * 毎コマ回り続けることになる
         */
        const root = document.querySelector('[data-root]');
        const sizes = new ResizeObserver(later);
        sizes.observe(document.documentElement);
        if (root !== null) sizes.observe(root);

        const changes = new MutationObserver(later);
        if (root !== null) {
            changes.observe(root, { childList: true, subtree: true, attributes: true });
        }

        return () => {
            if (waiting !== 0) cancelAnimationFrame(waiting);
            window.removeEventListener('resize', again);
            window.removeEventListener('scroll', again);
            window.visualViewport?.removeEventListener('resize', again);
            sizes.disconnect();
            changes.disconnect();
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
    <div class="max-w-[70ch] break-all">class: {rootClass}</div>
    {#if units !== null}
        <div>
            dvh {units.dvh} / svh {units.svh} / lvh {units.lvh} / vh {units.vh} / 流れの中 {plain} — {mode}
        </div>
    {/if}
    <div class="max-w-[70ch] break-all">{rules}</div>
    {#each culprits as culprit (culprit.what + culprit.bottom)}
        <div>↳ {culprit.what} → {culprit.bottom}</div>
    {/each}
</div>
