<script lang="ts">
    import { onMount } from 'svelte';
    import { submitting } from '$lib/actions';
    import ControlBar from '$lib/components/player/ControlBar.svelte';
    import ControlButton from '$lib/components/player/ControlButton.svelte';
    import { playerControls } from '$lib/components/player/controls.svelte';
    import Icon from '$lib/components/player/Icon.svelte';
    import {
        BACK10,
        CAPTION,
        CLOSE,
        EXPAND,
        FORWARD10,
        NEXT,
        OVERLAY,
        PAUSE,
        PLAY,
        PREV,
        SHRINK,
        SOUND_OFF,
        SOUND_ON,
        TRASH,
    } from '$lib/components/player/icons';
    import ProgramFacts from '$lib/components/ProgramFacts.svelte';
    import Toasts, { type Notice } from '$lib/components/Toasts.svelte';
    import { type DetailSeed, programDetail } from '$lib/detail.svelte';
    import { clock, cmNoteWorthShowing, recordedDuration, size } from '$lib/format';
    import {
        type Chapter,
        chapterAt,
        nextChapterAt,
        prevChapterAt,
        resumePoint,
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
    /** 字幕を出しているか。**持っている録画でだけ意味を持つ** (`data.subtitle`) */
    let captions = $state(false);
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

    /**
     * 操作列の出し入れ。**ライブと同じ部品**
     * ([controls.svelte.ts](../../../lib/components/player/controls.svelte.ts))。
     * 動かせば出て、しばらくで消える。止めている間は残る
     */
    const controls = playerControls();
    $effect(() => {
        controls.held = !playing;
    });
    let lastTap: Tap | null = null;

    /** どこまで観たかを書き送る間隔 (ms)。**細かく送るものではない** */
    const REMEMBER = 15_000;
    /** 続きから出したか。出したことを画面にも言う (黙って途中から始まると驚く) */
    let continued = $state(false);

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
        loadDetail();
        if (!ready) return;
        video?.play().catch(() => undefined);
        // 指のときは最初から全画面。テレビと同じで、観るために置いてある画面なので
        if (coarse) enterFull();
        const onFull = () => {
            full = document.fullscreenElement !== null;
        };
        document.addEventListener('fullscreenchange', onFull);
        /*
         * **閉じ際にも書き送る。** 数十秒おきの控えだけだと、最後に観た数十秒が
         * 落ちる。`pagehide` は畳んだ・戻った・落ちた、のどれでも来る (`unload` は
         * スマホで来ないことがある)
         */
        const onLeave = () => remember(true);
        window.addEventListener('pagehide', onLeave);
        const ticker = setInterval(() => {
            if (playing) remember();
        }, REMEMBER);
        return () => {
            document.removeEventListener('fullscreenchange', onFull);
            window.removeEventListener('pagehide', onLeave);
            clearInterval(ticker);
            remember(true);
            if (disarm !== null) clearTimeout(disarm);
        };
    });

    /**
     * **どこまで観たかを覚える。** 覚えるかどうかの判断は `ts/watch.ts` が持つ
     * (サーバも同じものを見る)。
     *
     * 出ていく間際は `sendBeacon` で投げる — 画面を畳んだあとの `fetch` は
     * ブラウザに捨てられることがあり、**最後に観たところがいちばん要る**
     */
    function remember(leaving = false): void {
        if (video === null || !ready) return;
        const body = JSON.stringify({ at: video.currentTime, length: video.duration });
        const url = `/api/recordings/${rec.id}/resume`;
        if (leaving && navigator.sendBeacon !== undefined) {
            navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
            return;
        }
        void fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            keepalive: true,
        }).catch(() => undefined);
    }

    /**
     * **観ていたところから出す。**
     *
     * 尺が分かってから動かす (`loadedmetadata`)。**1回だけ** — 跳んだあとに
     * もう一度来ると、観ている最中に引き戻されることになる
     */
    let resumed = false;
    function resume(): void {
        length = video?.duration ?? 0;
        if (resumed || video === null || rec.resume_ms === null) return;
        resumed = true;
        const at = rec.resume_ms / 1000;
        if (resumePoint(at, video.duration) === null) return;
        video.currentTime = at;
        // **黙って途中から始めない。** 何が起きたか言って、しばらくで引っ込める
        continued = true;
        setTimeout(() => (continued = false), 4000);
    }

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

    /**
     * 字幕の出し入れ。**出すのはブラウザ自身** (`<track>` の `mode`)。
     *
     * 消えているときは `hidden` に置く — `disabled` まで戻すと、次に出すときに
     * 取り直しになる。**最初は消えている**のはテレビと同じ扱いで、
     * 字幕は絵の上に重なるものなので、要る人が出す
     */
    function toggleCaptions(): void {
        const track = video?.textTracks[0];
        if (track === undefined) return;
        captions = !captions;
        track.mode = captions ? 'showing' : 'hidden';
        controls.stir();
    }

    /** 秒で動かす。**端は超えさせない** (超えると勝手に終わる) */
    function seekBy(by: number): void {
        if (video === null) return;
        video.currentTime = Math.min(Math.max(video.currentTime + by, 0), length || video.duration || 0);
        controls.stir();
    }

    function seekTo(seconds: number | null): void {
        if (video === null || seconds === null) return;
        video.currentTime = seconds;
        controls.stir();
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
            if (controls.shown && playing) controls.hide();
            else controls.stir();
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
            c: toggleCaptions,
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

    /**
     * 番組表から引き直す。**押させずに、開いた時点で引く。**
     *
     * 出演者や詳細情報は番組表の側にあり、録画の行は持っていない。
     * 引けなければ行のぶんだけが出たままになる (古い録画は消えている)
     */
    function loadDetail(): void {
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
</script>

<svelte:head><title>{rec.name} - denpa</title></svelte:head>
<svelte:window onclick={stand} onkeydown={keys} />

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
                ない。押す先は中の `<video>` とボタンのほう
            -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions -->
            <section
                bind:this={stage}
                class="relative w-full overflow-hidden rounded-lg bg-black {full
                    ? 'flex h-screen items-center justify-center'
                    : ''}"
                onpointermove={controls.wake}
                onpointerdown={controls.wake}
                onpointerleave={controls.away}
                data-testid="watch-stage"
            >
                <!--
                    **押すのは絵そのもの。** ボタンを避けて敷くのではなく、
                    ボタンを上に重ねる (`z-10`)。`onclick` は `press` が読む
                -->
                <!-- svelte-ignore a11y_media_has_caption -->
                <!--
                    **入れ物の中の字幕は渡せない。** 焼いたものに入っているのは
                    PGS で、文字ではなく**絵** (docs/encode.md)。ブラウザに復号器が
                    無いので、渡すのは**動画の隣に置いた文字のほう**を WebVTT に
                    直したもの (`api/recordings/<id>/subtitle.vtt`)。
                    字幕を持たない録画では `<track>` ごと出さない
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
                        controls.stir();
                    }}
                    onpause={() => {
                        playing = false;
                    }}
                    ontimeupdate={() => (at = video?.currentTime ?? 0)}
                    onloadedmetadata={resume}
                    onvolumechange={() => (muted = video?.muted ?? false)}
                    onerror={() => (broken = true)}
                    data-testid="watch-video"
                >
                    {#if data.subtitle}
                        <track
                            kind="captions"
                            srclang="ja"
                            label="字幕"
                            src="/api/recordings/{rec.id}/subtitle.vtt"
                            data-testid="watch-track"
                        />
                    {/if}
                </video>

                {#if continued}
                    <!--
                        **続きから出したことを言う。** 黙って途中から始まると、
                        壊れているのか飛んだのか分からない
                    -->
                    <div
                        class="pointer-events-none absolute inset-x-0 top-14 z-10 flex justify-center"
                        data-testid="watch-resumed"
                    >
                        <span class="badge badge-neutral badge-sm">続きから再生しています</span>
                    </div>
                {/if}

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
                    class="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 bg-gradient-to-b from-black/60 to-transparent p-2 transition-opacity {controls.shown
                        ? 'opacity-100'
                        : 'opacity-0'}"
                >
                    <a
                        class="btn btn-circle btn-sm pointer-events-auto {OVERLAY}"
                        href="/"
                        aria-label="一覧へ戻る"
                        data-testid="watch-close"
                    >
                        <Icon path={CLOSE} />
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
                            <ControlButton path={TRASH} label="削除" testid="watch-delete" onclick={arm} />
                        {/if}
                    </form>
                </div>

                <!--
                    **真ん中の再生ボタン。** 指のときはこれで再生と停止をする
                    (絵を押すのは操作列の出し入れなので)。マウスでも、止まって
                    いる間は出しておく — 何を押せば始まるかが一目で分かる
                -->
                {#if controls.shown && (coarse || !playing)}
                    <button
                        type="button"
                        class="btn btn-circle btn-lg absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 {OVERLAY}"
                        onclick={togglePlay}
                        aria-label={playing ? '一時停止' : '再生'}
                        data-testid="watch-play"
                    >
                        <Icon path={playing ? PAUSE : PLAY} />
                    </button>
                {/if}

                <!-- 下端。帯と押すもの。**ライブと同じ帯** (`ControlBar`) -->
                <ControlBar shown={controls.shown} testid="watch-controls">
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
                        <ControlButton
                            path={playing ? PAUSE : PLAY}
                            label={playing ? '一時停止' : '再生'}
                            onclick={togglePlay}
                        />
                        <ControlButton
                            path={BACK10}
                            label={`${SKIP}秒戻す`}
                            testid="watch-back"
                            onclick={() => seekBy(-SKIP)}
                        />
                        <ControlButton
                            path={FORWARD10}
                            label={`${SKIP}秒送る`}
                            testid="watch-forward"
                            onclick={() => seekBy(SKIP)}
                        />

                        <!--
                            **チャプター送りは、入っているときだけ出す。**
                            CMを切って焼いたものには入っていないので、出しても
                            押せない操作が並ぶだけになる
                        -->
                        {#if chapters.length > 1}
                            <ControlButton
                                path={PREV}
                                label={'前のチャプター'}
                                testid="watch-prev-chapter"
                                onclick={() => seekTo(prevChapterAt(chapters, at))}
                            />
                            <ControlButton
                                path={NEXT}
                                label={'次のチャプター'}
                                testid="watch-next-chapter"
                                onclick={() => seekTo(nextChapterAt(chapters, at))}
                            />
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

                        <!--
                            **字幕を持っている録画でだけ出す。** 持っていないほうが
                            多い (字幕の無い番組・この仕組みより前に焼いたもの) ので、
                            押しても何も起きない操作を並べない。`/live` と同じ扱い
                        -->
                        {#if data.subtitle}
                            <ControlButton
                                path={CAPTION}
                                label={captions ? '字幕を消す' : '字幕を出す'}
                                on={captions}
                                testid="watch-captions"
                                onclick={toggleCaptions}
                            />
                        {/if}
                        <ControlButton
                            path={muted ? SOUND_OFF : SOUND_ON}
                            label={muted ? '音を出す' : '消音'}
                            onclick={() => {
                                if (video !== null) video.muted = !video.muted;
                            }}
                        />
                        <ControlButton
                            path={full ? SHRINK : EXPAND}
                            label={full ? '全画面をやめる' : '全画面'}
                            testid="watch-full"
                            onclick={toggleFull}
                        />
                    </div>
                </ControlBar>
            </section>
        {/if}
    </section>

    <!--
        **左は番組の中身。全部ここに出す。**

        以前はモーダルで開いていた。**映像の上に被さる**ので、観ながら読めない —
        観る画面で「あらすじを読みながら流す」ができないのは本末転倒だった。
        中身は一覧のモーダルと同じ部品 (`ProgramFacts`) で、枠だけこちらが持つ。

        **中身が長ければ、ここだけが巻き取られる** (`overflow-y-auto`)。
        番組の説明は数百字あるので、ページごと動くと映像が画面から出ていく。
        **押すものは下に貼り付けて、いつでも見えるようにする** (`shrink-0`)
    -->
    <aside class="flex flex-col md:order-1 md:sticky md:top-4 md:h-[calc(100dvh-7rem)]">
        <div class="card bg-base-100 flex min-h-0 flex-1 shadow">
            <div class="card-body min-h-0 flex-1 gap-0 overflow-y-auto p-4" data-testid="watch-facts">
                <!--
                    **引き直せたらそちらを出す。** 録画の行が持っているのは名前と
                    説明までで、出演者などは番組表の側にある。古い録画は番組表から
                    消えているので引けず、そのときは行のぶんだけが出たままになる
                -->
                <ProgramFacts
                    program={detail.current ?? facts}
                    cmNote={cmNoteWorthShowing(rec.cm_note) ? rec.cm_note : null}
                />

                <div class="text-base-content/60 mt-3 text-sm" data-testid="watch-meta">
                    {recordedDuration(rec)} ・ {size(rec.ts_size)}
                </div>
            </div>

            <!-- 押すものは常に見えるところに置く。巻き取られる中身の外 -->
            <div class="border-base-300 flex shrink-0 flex-wrap gap-2 border-t p-4">
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
    </aside>
</div>

<Toasts {notices} source={form} />
