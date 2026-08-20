<script lang="ts">
    /**
     * 指で押すリモコン。**データ放送を出している間だけ、右の列に出す。**
     *
     * データ放送は十字と決定と色ボタンで操作するもので、キーボードのある
     * 端末では既に渡している (`DataBroadcast.svelte` の `key`)。**指で見る
     * 端末には押す場所が無い**ので、ここで用意する。
     *
     * 絵の上に重ねない — 番組の中身と同じで、**観ながら押すものは右の列**に
     * 置く (`live/+page.svelte`)。放送の作った画面は枠を下まで塗り潰すので、
     * 上に重ねると押すものが放送の絵に埋もれる。
     *
     * **「消す」は置きません。** 文書が d を掴んでいる間は d では消せないから、と
     * 逃げ道を1つ置いていたが、**消す口は既に右の縦列にある** (d のボタン。押せば
     * その場で畳む)。同じことをする口を2つ置かない
     */

    interface Props {
        /** 押されたキーを BML へ渡す。`AribKeyCode` の番号 */
        press: (code: number) => void;
    }

    const { press }: Props = $props();

    /**
     * `AribKeyCode` (借りものの `content.ts`) と同じ値。
     *
     * **番号で書くのは、`content.ts` を読み込まずに済ませるため** — 値として
     * import すると、このリモコンが載っているだけで借りもの全体 (700KB) が
     * 落ちてくる。データ放送を出す前から出ている画面なので、それは困る
     */
    /** d (DataButton)。放送の文書に「d が押された」と伝える (`DataBroadcast` の DATA_BUTTON と同じ) */
    const DATA = 20;
    const UP = 1;
    const DOWN = 2;
    const LEFT = 3;
    const RIGHT = 4;
    const ENTER = 18;
    const BACK = 19;
    const BLUE = 21;
    const RED = 22;
    const GREEN = 23;
    const YELLOW = 24;

    /**
     * 色ボタン。**並びは実機のリモコンと同じ 青・赤・緑・黄。**
     *
     * 色は放送が名指しするもので、番組が「青を押して」と言うときの青。
     * `btn-info` のような主題の色に寄せると、**放送の言う色と画面の色が
     * 食い違う**ので、じかに塗る
     */
    const COLORS = [
        { code: BLUE, name: '青', paint: 'bg-blue-600 text-white' },
        { code: RED, name: '赤', paint: 'bg-red-600 text-white' },
        { code: GREEN, name: '緑', paint: 'bg-green-600 text-white' },
        { code: YELLOW, name: '黄', paint: 'bg-yellow-400 text-black' },
    ];

    /**
     * 数字。**並びは実機のリモコンと同じ** (1〜9・0・10・11)。
     * `AribKeyCode` は `Digit0` が 5 で、そこから数の順に並んでいる。
     *
     * **畳んである** — 使う放送のほうが少ない (投票や郵便番号の入力)
     */
    const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '10', '11'];
    const digit = (name: string): number => 5 + Number(name);
</script>

<!--
    **指で押せる大きさにする。** daisyUI の `btn-sm` は指には小さいので、
    十字と決定は正方形で大きめに取る
-->
<div class="card bg-base-100 mb-2 shrink-0 shadow" data-testid="live-remote">
    <div class="card-body gap-3 p-3">
        <div class="flex gap-1">
            {#each COLORS as color (color.code)}
                <button
                    type="button"
                    class="btn h-8 min-h-0 flex-1 border-0 text-sm {color.paint}"
                    onclick={() => press(color.code)}
                    data-testid="live-remote-{color.code}"
                >
                    {color.name}
                </button>
            {/each}
        </div>

        <!-- 十字と決定。**真ん中が決定**で、実機と同じ形 -->
        <div class="mx-auto grid grid-cols-3 gap-1">
            <div></div>
            <button type="button" class="btn size-12 p-0 text-lg" onclick={() => press(UP)}
                aria-label="上" data-testid="live-remote-up">↑</button>
            <div></div>
            <button type="button" class="btn size-12 p-0 text-lg" onclick={() => press(LEFT)}
                aria-label="左" data-testid="live-remote-left">←</button>
            <button type="button" class="btn btn-primary size-12 p-0 text-xs" onclick={() => press(ENTER)}
                data-testid="live-remote-enter">決定</button>
            <button type="button" class="btn size-12 p-0 text-lg" onclick={() => press(RIGHT)}
                aria-label="右" data-testid="live-remote-right">→</button>
            <div></div>
            <button type="button" class="btn size-12 p-0 text-lg" onclick={() => press(DOWN)}
                aria-label="下" data-testid="live-remote-down">↓</button>
            <div></div>
        </div>

        <div class="flex gap-2">
            <button type="button" class="btn btn-sm flex-1" onclick={() => press(BACK)} data-testid="live-remote-back">
                戻る
            </button>
            <!-- d は放送に渡す (DataButtonPressed)。待機ページからメニューを開くのはこれ -->
            <button type="button" class="btn btn-sm" onclick={() => press(DATA)} data-testid="live-remote-data">
                d
            </button>
        </div>

        <!-- **畳んでおく。** 使う放送のほうが少ないので、いつも場所を取らせない -->
        <details class="text-sm">
            <summary class="cursor-pointer select-none" data-testid="live-remote-digits">数字</summary>
            <div class="mt-2 grid grid-cols-3 gap-1">
                {#each DIGITS as name (name)}
                    <button
                        type="button"
                        class="btn btn-sm"
                        onclick={() => press(digit(name))}
                        data-testid="live-remote-digit-{name}"
                    >
                        {name}
                    </button>
                {/each}
            </div>
        </details>

        <p class="text-base-content/60 text-xs">
            キーボードでも押せます — 矢印キー・Enter・Backspace と、色は B / R / G / Y
        </p>
    </div>
</div>
