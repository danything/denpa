<script lang="ts">
    import { onMount } from 'svelte';
    import { submitting } from '$lib/actions';
    import ProgramDetail from '$lib/components/ProgramDetail.svelte';
    import ProgramFacts from '$lib/components/ProgramFacts.svelte';
    import Toasts, { type Notice } from '$lib/components/Toasts.svelte';
    import { type DetailSeed, programDetail } from '$lib/detail.svelte';
    import { clock, cmNoteWorthShowing, recordedDuration, size } from '$lib/format';
    import {
        type Chapter,
        chapterAt,
        nextChapterAt,
        prevChapterAt,
        SKIP,
        type Tap,
        tap,
        zoneOf,
    } from '$lib/ts/watch';

    let { data, form } = $props();
    const rec = $derived(data.recording);

    /** 焼けているか。**観るのは焼いたものだけ** (`+page.server.ts`) */
    const ready = $derived(rec.library_path !== null);
    const src = $derived(`/api/recordings/${rec.id}/file?source=encoded`);

    let video = $state<HTMLVideoElement | null>(null);
    /** 映像とその上の操作をまとめた箱。全画面にするのはこちら */
    let stage = $state<HTMLElement | null>(null);

    let playing = $state(false);
    let at = $state(0);
    let length = $state(0);
    let muted = $state(false);
    let full = $state(false);
    /** 読めなかったとき。**黙って黒いままにしない** */
    let broken = $state(false);
    let chapters = $state<Chapter[]>([]);

    /**
     * 指で触っているか。**全画面にするかと、押したときの読み方が変わる。**
     *
     * 画面の幅では決めない — 狭い窓で開いた PC まで全画面になる。
     * `(pointer: coarse)` は「いま使っている指し手が粗いか」なので、
     * タッチのノートPCでも当たる
     */
    let coarse = $state(false);

    /** 操作列を出しているか。**指のときは自分で出し入れする** (`tap`) */
    let showing = $state(true);
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    let lastTap: Tap | null = null;

    /** 押し間違い防止に2回押させる。一覧と同じ (`routes/+page.svelte` の `arm`) */
    let armed = $state(false);
    let disarm: ReturnType<typeof setTimeout> | null = null;

    const detail = programDetail();

    /**
     * **開いたら、そのまま観はじめる。**
     *
     * 一覧の行を押してここへ来ているので、**その押した勢い (user activation) が
     * まだ効いている** — SvelteKit の画面遷移は同じ文書の中なので、`play()` も
     * `requestFullscreen()` もそのまま通る。読み込み直したときだけ通らないので、
     * どちらも転んでも無視する (押せば始まる)
     */
    onMount(() => {
        coarse = window.matchMedia('(pointer: coarse)').matches;
        void loadChapters();
        if (!ready) return;
        video?.play().catch(() => undefined);
        // 指のときは最初から全画面。テレビと同じで、観るために置いてある画面なので
        if (coarse) enterFull();
        const onFull = () => {
            full = document.fullscreenElement !== null;
        };
        document.addEventListener('fullscreenchange', onFull);
        return () => {
            document.removeEventListener('fullscreenchange', onFull);
            if (hideTimer !== null) clearTimeout(hideTimer);
            if (disarm !== null) clearTimeout(disarm);
        };
    });

    /**
     * チャプターの位置。**焼いたものから読む** (`api/recordings/<id>/chapters`)。
     *
     * CM はチャプターとして入っているので、そのまま**CM飛ばし**になる。
     * 無い録画もある (CMを切って焼いたもの・検出が当たらなかったもの) ので、
     * 取れなければ送りのボタンを出さないだけ
     */
    async function loadChapters(): Promise<void> {
        try {
            const res = await fetch(`/api/recordings/${rec.id}/chapters`);
            if (!res.ok) return;
            chapters = (await res.json()).chapters ?? [];
        } catch {
            // 出せないだけ。観るのに支障は無い
        }
    }

    function enterFull(): void {
        stage?.requestFullscreen?.().catch(() => undefined);
    }

    function toggleFull(): void {
        if (document.fullscreenElement !== null) void document.exitFullscreen().catch(() => undefined);
        else enterFull();
    }

    function togglePlay(): void {
        if (video === null) return;
        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
    }

    /** 秒で動かす。**端は超えさせない** (超えると勝手に終わる) */
    function seekBy(by: number): void {
        if (video === null) return;
        video.currentTime = Math.min(Math.max(video.currentTime + by, 0), length || video.duration || 0);
        flash();
    }

    function seekTo(seconds: number | null): void {
        if (video === null || seconds === null) return;
        video.currentTime = seconds;
        flash();
    }

    /**
     * 操作列をしばらく出す。**動かしたら見えるように。**
     *
     * 出しっぱなしにすると絵の下端が隠れ続ける。止めている間は消さない —
     * 止めて眺めているときに操作が消えると、出すためだけにもう一度押すことになる
     */
    function flash(): void {
        showing = true;
        if (hideTimer !== null) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            if (playing) showing = false;
        }, 2600);
    }

    /**
     * **マウスを動かしたら操作列を出す。**
     *
     * 出す手段が「押す」しか無かった頃は、10秒送りを押したいだけなのに
     * **一度止めてから押す**ことになっていた (実機で見つけた。隠れた帯の上を
     * 押すと、下の絵が受け取って再生が止まる)。動かしたら出るのは動画アプリの通例。
     *
     * **指のときは何もしない。** あちらは触った時点で `press` が読む —
     * 指を置いただけで出すと、絵を見ている間ずっと出たままになる
     */
    function stir(): void {
        if (coarse) return;
        flash();
    }

    /**
     * 絵を押されたときの読み方は `ts/watch.ts` が決める。**ここは効かせるだけ。**
     *
     * - マウス … 1回で再生/一時停止、左右の端を素早く2回で 10秒
     * - 指 … 1回で操作列の出し入れ、左右の端を素早く2回で 10秒
     */
    function press(event: MouseEvent): void {
        if (video === null) return;
        const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
        const { action, next } = tap(
            lastTap,
            event.timeStamp,
            zoneOf(event.clientX - box.left, box.width),
            coarse,
        );
        lastTap = next;
        if (action.kind === 'play') togglePlay();
        else if (action.kind === 'controls') {
            if (showing && playing) showing = false;
            else flash();
        } else {
            // 2回目。マウスは1回目で再生を切り替えているので、それも戻す
            if (action.undo) togglePlay();
            seekBy(action.by);
        }
    }

    /** キーでも動かせるようにする。全画面のときはこれがいちばん早い */
    function keys(event: KeyboardEvent): void {
        if ((event.target as HTMLElement).closest('input, button, a')) return;
        const map: Record<string, () => void> = {
            ' ': togglePlay,
            k: togglePlay,
            ArrowLeft: () => seekBy(-SKIP),
            ArrowRight: () => seekBy(SKIP),
            f: toggleFull,
            m: () => {
                if (video !== null) video.muted = !video.muted;
            },
        };
        const run = map[event.key];
        if (run === undefined) return;
        event.preventDefault();
        run();
    }

    function arm(): void {
        armed = true;
        if (disarm !== null) clearTimeout(disarm);
        disarm = setTimeout(() => (armed = false), 5000);
    }

    /** 削除の聞き返しは、他所を触ったら取り下げる (一覧と同じ) */
    function stand(event: MouseEvent): void {
        if (!armed) return;
        if ((event.target as HTMLElement | null)?.closest('[data-testid^="watch-delete"]')) return;
        armed = false;
    }

    const current = $derived(chapterAt(chapters, at));

    /**
     * 左に出す中身。**録画の行が持っているぶんだけ**で組み立てる。
     *
     * 出演者などは番組表の側にあり、24時間で消える。引けるうちは「詳細」から
     * 引き直す (`programDetail`)
     */
    const facts = $derived({
        name: rec.name,
        service_name: rec.service_name,
        start_at: rec.start_at,
        end_at: rec.end_at,
        description: rec.description,
        extended: null,
        genre_detail: rec.genre_detail,
        audios: rec.audios,
        video_type: null,
        video_resolution: null,
        is_free: 1,
    });

    function openDetail(): void {
        const seed: DetailSeed = {
            name: rec.name,
            service_name: rec.service_name,
            start_at: rec.start_at,
            end_at: rec.end_at,
            description: rec.description,
        };
        void detail.open(rec.program_id, seed);
    }

    /** 断られたときだけ知らせる。消せたときは一覧へ戻るので出す先が無い */
    const notices = $derived<Notice[]>(
        form !== null && form !== undefined && 'message' in form && typeof form.message === 'string'
            ? [{ key: 'watch-delete', kind: 'error', text: form.message }]
            : [],
    );

    /** アイコンは他の画面と同じ書き方 (インラインの SVG) */
    const PLAY = 'M8 5v14l11-7z';
    const PAUSE = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';
    const BACK10 =
        'M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z';
    const FORWARD10 =
        'M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.06-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z';
    const PREV = 'M6 6h2v12H6zm3.5 6l8.5 6V6z';
    const NEXT = 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z';
    const SOUND_ON =
        'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z';
    const SOUND_OFF =
        'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z';
    const EXPAND = 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z';
    const SHRINK = 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z';
    const TRASH = 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z';
    const CLOSE =
        'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';

    /** 絵の上に置くボタン。読めるように黒く敷く (ライブの画面と同じ) */
    const OVERLAY = 'border-0 bg-black/45 text-white shadow-none hover:bg-black/70';
</script>

<svelte:head><title>{rec.name} - denpa</title></svelte:head>
<svelte:window onclick={stand} onkeydown={keys} />

{#snippet icon(path: string)}
    <svg viewBox="0 0 24 24" class="size-5" fill="currentColor" aria-hidden="true">
        <path d={path} />
    </svg>
{/snippet}

<!--
    **タブレットからは2段組**にする (`md` = 768px)。縦のiPadでちょうど入る幅で、
    そこを境にすると「持ち替えたら形が変わる」ことがない。詳細は左に固定幅で
    置き、余ったぶんを全部映像にやる — 映像は横に広いほど見やすい。

    狭い画面では**映像が上、詳細が下**。指で開いたときはそもそも全画面に
    入っているので、ここが見えるのは全画面を抜けたあと
-->
<div class="mx-auto grid max-w-[1800px] gap-4 p-3 md:grid-cols-[minmax(15rem,20rem)_1fr] lg:p-4">
    <!--
        **映像を先に書く。** 縦積みになったときに上へ来るのはこちら。
        2段組では `md:order-2` で右へ回す
    -->
    <section class="md:order-2">
        {#if !ready}
            <!--
                **焼けていないものは観られない。** 生TSは MPEG-2 で、ブラウザに
                復号器が無い (docs/stream.md §5.5)。黙って黒い枠を出すより、
                そう言って落とす口を出すほうがいい
            -->
            <div class="card bg-base-100 shadow" data-testid="watch-not-ready">
                <div class="card-body">
                    <h2 class="card-title text-base">まだ観られません</h2>
                    <p class="text-base-content/70 text-sm">
                        {#if rec.job_id !== null}
                            いまエンコードしています。焼き上がるとここで観られます。
                        {:else if rec.encode_error}
                            エンコードに失敗しています。生TSは残っているので、落として観られます。
                        {:else}
                            エンコードがまだです。焼き上がるとここで観られます。
                        {/if}
                    </p>
                </div>
            </div>
        {:else}
            <!--
                映像とその上の操作をまとめた箱。**全画面にするのはここ** —
                `<video>` だけを全画面にすると、上に重ねた操作が付いてこない
                (iOS の `webkitEnterFullscreen` は端末の操作列になる)
            -->
            <!--
                動かしたら操作列を出すためだけの `pointermove` なので、押すものでは
                ない (`stir`)。押す先は中の `<video>` とボタンのほう
            -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions -->
            <section
                bind:this={stage}
                class="relative w-full overflow-hidden rounded-lg bg-black {full
                    ? 'flex h-screen items-center justify-center'
                    : ''}"
                onpointermove={stir}
                data-testid="watch-stage"
            >
                <!--
                    **押すのは絵そのもの。** ボタンを避けて敷くのではなく、
                    ボタンを上に重ねる (`z-10`)。`onclick` は `press` が読む
                -->
                <!-- svelte-ignore a11y_media_has_caption -->
                <!--
                    **`<track>` は付けられない。** 焼いたものに入っている字幕は
                    PGS で、文字ではなく**絵**として持っている (docs/encode.md)。
                    WebVTT に直すには絵を読む必要があり、ブラウザには PGS の
                    復号器が無い。**ブラウザで観るときは字幕が出ない**
                    (落としてお手元のプレイヤーで観れば出る)
                -->
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
                <video
                    bind:this={video}
                    {src}
                    class="max-h-[calc(100dvh-9rem)] w-full bg-black {full ? 'h-full' : ''}"
                    playsinline
                    onclick={press}
                    onplay={() => {
                        playing = true;
                        flash();
                    }}
                    onpause={() => {
                        playing = false;
                        showing = true;
                    }}
                    ontimeupdate={() => (at = video?.currentTime ?? 0)}
                    onloadedmetadata={() => (length = video?.duration ?? 0)}
                    onvolumechange={() => (muted = video?.muted ?? false)}
                    onerror={() => (broken = true)}
                    data-testid="watch-video"
                ></video>

                {#if broken}
                    <!--
                        **黙って黒いままにしない。** ブラウザによっては Matroska も
                        AV1 も読めない (Safari)。そのときは落として観てもらう
                    -->
                    <div
                        class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 text-center text-white"
                        data-testid="watch-error"
                    >
                        <p class="text-sm">
                            このブラウザでは再生できませんでした。<br
                            />落としてお手元のプレイヤーで観てください。
                        </p>
                        <a class="btn btn-sm" href="{src}&download=1" download>ダウンロード</a>
                    </div>
                {/if}

                <!--
                    **上端。** 戻ると削除。全画面のときはここしか出口が無いので、
                    操作列を隠していても戻るだけは出しておく
                -->
                <div
                    class="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 bg-gradient-to-b from-black/60 to-transparent p-2 transition-opacity {showing
                        ? 'opacity-100'
                        : 'opacity-0'}"
                >
                    <a
                        class="btn btn-circle btn-sm pointer-events-auto {OVERLAY}"
                        href="/"
                        aria-label="一覧へ戻る"
                        data-testid="watch-close"
                    >
                        {@render icon(CLOSE)}
                    </a>
                    <span class="truncate pt-1 text-sm text-white/90 drop-shadow">{rec.name}</span>
                    <!--
                        **観終わったその場で消せるようにする。** 末尾はたいてい CM なので、
                        流したまま消せる。押し間違い防止に2回押させるのは一覧と同じ
                    -->
                    <form method="POST" action="?/delete" use:submitting class="pointer-events-auto">
                        <input type="hidden" name="id" value={rec.id} />
                        {#if armed}
                            <button class="btn btn-error btn-sm" data-testid="watch-delete-confirm">
                                確定
                            </button>
                        {:else}
                            <button
                                type="button"
                                class="btn btn-circle btn-sm {OVERLAY}"
                                onclick={arm}
                                aria-label="削除"
                                data-testid="watch-delete"
                            >
                                {@render icon(TRASH)}
                            </button>
                        {/if}
                    </form>
                </div>

                <!--
                    **真ん中の再生ボタン。** 指のときはこれで再生と停止をする
                    (絵を押すのは操作列の出し入れなので)。マウスでも、止まって
                    いる間は出しておく — 何を押せば始まるかが一目で分かる
                -->
                {#if showing && (coarse || !playing)}
                    <button
                        type="button"
                        class="btn btn-circle btn-lg absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 {OVERLAY}"
                        onclick={togglePlay}
                        aria-label={playing ? '一時停止' : '再生'}
                        data-testid="watch-play"
                    >
                        {@render icon(playing ? PAUSE : PLAY)}
                    </button>
                {/if}

                <!-- 下端。帯と押すもの -->
                <div
                    class="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/70 to-transparent px-2 pt-6 pb-2 transition-opacity {showing
                        ? 'opacity-100'
                        : 'pointer-events-none opacity-0'}"
                >
                    <!--
                        **帯にはチャプターの切れ目を出す。** どこで CM が挟まって
                        いるかが見えると、送りのボタンを何回押すかが分かる
                    -->
                    <div class="relative">
                        <input
                            type="range"
                            class="range range-xs range-primary w-full"
                            min="0"
                            max={length || 0}
                            step="0.1"
                            value={at}
                            oninput={(e) => seekTo(Number(e.currentTarget.value))}
                            aria-label="再生位置"
                            data-testid="watch-seek"
                        />
                        {#if chapters.length > 1 && length > 0}
                            <div class="pointer-events-none absolute inset-x-0 top-0 h-1">
                                {#each chapters.slice(1) as chapter (chapter.start)}
                                    <span
                                        class="absolute top-0 h-1 w-px bg-white/70"
                                        style="left: {(chapter.start / length) * 100}%"
                                    ></span>
                                {/each}
                            </div>
                        {/if}
                    </div>

                    <div class="mt-1 flex flex-wrap items-center gap-1 text-white">
                        <button
                            type="button"
                            class="btn btn-circle btn-sm {OVERLAY}"
                            onclick={togglePlay}
                            aria-label={playing ? '一時停止' : '再生'}
                        >
                            {@render icon(playing ? PAUSE : PLAY)}
                        </button>
                        <button
                            type="button"
                            class="btn btn-circle btn-sm {OVERLAY}"
                            onclick={() => seekBy(-SKIP)}
                            aria-label="{SKIP}秒戻す"
                            data-testid="watch-back"
                        >
                            {@render icon(BACK10)}
                        </button>
                        <button
                            type="button"
                            class="btn btn-circle btn-sm {OVERLAY}"
                            onclick={() => seekBy(SKIP)}
                            aria-label="{SKIP}秒送る"
                            data-testid="watch-forward"
                        >
                            {@render icon(FORWARD10)}
                        </button>

                        <!--
                            **チャプター送りは、入っているときだけ出す。**
                            CMを切って焼いたものには入っていないので、出しても
                            押せない操作が並ぶだけになる
                        -->
                        {#if chapters.length > 1}
                            <button
                                type="button"
                                class="btn btn-circle btn-sm {OVERLAY}"
                                onclick={() => seekTo(prevChapterAt(chapters, at))}
                                aria-label="前のチャプター"
                                data-testid="watch-prev-chapter"
                            >
                                {@render icon(PREV)}
                            </button>
                            <button
                                type="button"
                                class="btn btn-circle btn-sm {OVERLAY}"
                                onclick={() => seekTo(nextChapterAt(chapters, at))}
                                aria-label="次のチャプター"
                                data-testid="watch-next-chapter"
                            >
                                {@render icon(NEXT)}
                            </button>
                        {/if}

                        <span class="px-1 text-xs tabular-nums" data-testid="watch-clock">
                            {clock(at)} / {clock(length)}
                        </span>
                        {#if current !== null}
                            <span class="badge badge-sm badge-ghost" data-testid="watch-chapter">
                                {current.title}
                            </span>
                        {/if}

                        <span class="grow"></span>

                        <button
                            type="button"
                            class="btn btn-circle btn-sm {OVERLAY}"
                            onclick={() => {
                                if (video !== null) video.muted = !video.muted;
                            }}
                            aria-label={muted ? '音を出す' : '消音'}
                        >
                            {@render icon(muted ? SOUND_OFF : SOUND_ON)}
                        </button>
                        <button
                            type="button"
                            class="btn btn-circle btn-sm {OVERLAY}"
                            onclick={toggleFull}
                            aria-label={full ? '全画面をやめる' : '全画面'}
                            data-testid="watch-full"
                        >
                            {@render icon(full ? SHRINK : EXPAND)}
                        </button>
                    </div>
                </div>
            </section>
        {/if}
    </section>

    <!--
        **左は番組の中身。** 一覧のモーダルと同じものを枠なしで置く
        (`ProgramFacts`)。同じものを2つ書くと、片方だけ直したときにずれる
    -->
    <aside class="md:order-1">
        <div class="card bg-base-100 shadow">
            <div class="card-body p-4">
                <ProgramFacts program={facts} cmNote={cmNoteWorthShowing(rec.cm_note) ? rec.cm_note : null} />

                <div class="text-base-content/60 mt-3 text-sm" data-testid="watch-meta">
                    {recordedDuration(rec)} ・ {size(rec.ts_size)}
                </div>

                <div class="mt-3 flex flex-wrap gap-2">
                    <!--
                        **詳細は EPG から引き直す。** 録画の行が持っているのは
                        名前と説明までで、出演者などは番組表の側にある
                        (古い録画は消えているので引けない)
                    -->
                    <button
                        type="button"
                        class="btn btn-sm btn-outline"
                        onclick={openDetail}
                        data-testid="watch-detail"
                    >
                        詳細
                    </button>
                    <a
                        class="btn btn-sm btn-outline"
                        href="/api/recordings/{rec.id}/file?download=1&source=encoded"
                        download
                        data-testid="watch-download"
                    >
                        ダウンロード
                    </a>
                    <a class="btn btn-sm" href="/" data-testid="watch-back-list">一覧へ</a>
                </div>
            </div>
        </div>
    </aside>
</div>

{#if detail.current}
    <!-- 引き直した詳細。押すものは「閉じる」だけ (足すかどうかを決める画面ではない) -->
    <ProgramDetail program={detail.current} onclose={() => detail.close()} />
{/if}

<Toasts {notices} source={form} />
