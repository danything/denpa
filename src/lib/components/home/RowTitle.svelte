<script lang="ts">
    /**
     * 行の1段目: 時刻・番組名 (行の入口)・状態のバッジ。予約・録画・録り逃しで同じ形。
     *
     * `fresh` はまだ観ていない録画 (`unwatched`)。番組名の頭に小さな点を置く。
     * バッジ (「NEW」など) にしないのは、番組名に入っている [新] と紛れるのと、
     * 状態のバッジと2つ並ぶと番組名が押し出されるため。
     *
     * **行のどこを押しても、その行でいちばんやりたいことをする。** 入口は番組名で、押せる範囲を
     * `::after` で行いっぱいに広げる (`.row-open`)。
     *
     * 録画なら**観る画面へ** (`/watch/<id>`) のリンク (`<a>`)。一覧を開くのは観るためなので、
     * そこを1回で通す。中身を読みたいときは行の中の「詳細」から。予約・録り逃し・観られない録画は
     * 詳細を開くボタン。リンクは SvelteKit が文書を読み込み直さずに遷移するので、
     * **押した勢い (user activation) が切れない** — 観る画面は開いた時点で再生と全画面を
     * 始めるので (`watch/[id]`)、`location.href` で飛ぶと「押したのに何も起きない」になる。
     *
     * 行の `<div>` を丸ごと `role="button"` にしていた頃は、押せるものの中に「詳細」「削除」の
     * ボタンが入れ子になっていて (読み上げでは中身が平たく1つのボタンに潰れる)、
     * リンクでもないので中クリックで別のタブにも開けなかった。行の中のボタンとルール名の
     * リンクは広げた範囲より上に置く (`.row-actions` など)
     */
    import { time } from '#lib/format.js';

    let {
        start,
        end,
        state,
        stateShort,
        badge,
        name,
        testid,
        open,
        fresh = false,
        quiet = false,
    }: {
        /** 頭に置く放送の時刻 (`21:30–22:00`。狭い画面は始まりだけ) */
        start: number;
        end: number;
        state: string;
        /** 狭い幅で代わりに出す状態の字 (録画中の「あと21分」)。読み上げはいつも `state` */
        stateShort?: string | undefined;
        badge: string;
        name: string;
        testid: string;
        open: string | (() => void);
        fresh?: boolean;
        quiet?: boolean;
    } = $props();
</script>

<!--
    **1段目は 時刻 · 番組名 · 状態のバッジ。** 番組名が長ければ番組名だけを「…」で切り、時刻とバッジは残す。
    ふつうの状態 (`quietState`) はラベルを出さず、読み上げにだけ渡す。
    塗ったバッジ (録画中など、いま動いているもの) には、ゆっくり脈打つ点を添える (`app.css` の `.rec-dot`)
-->
<div class="title-line">
    <span class="t-time num">{time(start)}<span class="t-end">–{time(end)}</span></span>
    {#if typeof open === 'string'}
        <!-- 行いっぱいが的なので、先読みは押したときだけ (一覧を撫でるだけで何本も読みに行かない) -->
        <a class="row-name row-open broadcast" href={open} data-sveltekit-preload-data="tap" data-testid="row-open">
            {#if fresh}
                <span class="unwatched-dot" role="img" aria-label="未視聴" data-testid="recording-unwatched"></span>
            {/if}
            {name}
        </a>
    {:else}
        <button type="button" class="row-name row-open broadcast" onclick={open} data-testid="row-open">
            {name}
        </button>
    {/if}
    <span class={quiet ? 'visually-hidden' : `tag ${badge}`} data-testid={testid}
        >{#if !quiet && badge.includes('solid')}<span class="rec-dot" aria-hidden="true"></span>{/if}{#if stateShort === undefined}{state}{:else}<span class="t-state-full">{state}</span><span class="t-state-short" aria-hidden="true">{stateShort}</span>{/if}</span
    >
</div>
