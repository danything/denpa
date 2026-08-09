<script lang="ts">
    import { onMount } from 'svelte';
    import { submitting } from '$lib/actions';
    import Brightness from '$lib/components/player/Brightness.svelte';
    import ControlBar from '$lib/components/player/ControlBar.svelte';
    import ControlButton from '$lib/components/player/ControlButton.svelte';
    import { playerControls } from '$lib/components/player/controls.svelte';
    import Icon from '$lib/components/player/Icon.svelte';
    import { clearOverlay, drawOverlay, fitRect } from '$lib/components/player/paint';
    import {
        BACK10,
        CAMERA,
        CAPTION,
        CENTER_BTN,
        CLOSE,
        CUT,
        EXPAND,
        FORWARD10,
        NEXT,
        OVERLAY,
        OVERLAY_BTN,
        PAUSE,
        PLAY,
        OVERLAY_ON,
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
    import { captionAt, type Drawn, pixels, readSup } from '$lib/pgs';
    import { SPEEDS } from '$lib/ts/pacing';
    import {
        type Chapter,
        chapterAt,
        isCm,
        nextChapterAt,
        prevChapterAt,
        resumePoint,
        SKIP,
        skipTarget,
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
    /**
     * 字幕を出しているか。**持っている録画でだけ意味を持つ** (`data.subtitle`)。
     * **既定は出す** — ライブと同じ (`live-player` の `captions`)
     */
    let captions = $state(true);
    /**
     * 字幕の絵。**開いた時点で取りに行く** (既定で出すので)。
     *
     * 持っている番組かどうかは**取ってみるまで分からない** — 入れ物から抜くので、
     * 無ければ 404 が返る。ライブと同じで、持っているときだけボタンを出す
     * (`live-player` の `hasCaptions`)
     */
    let drawn = $state<Drawn[]>([]);
    const hasCaptions = $derived(drawn.length > 0);
    /** 重ねる先 (`/live` と同じやり方。`server/captions.ts`) */
    let overlay = $state<HTMLCanvasElement | null>(null);
    /** いま出している1枚。同じものを描き直さないため */
    let showing: Drawn | null = null;
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

    /**
     * 早送りの速さ。**ライブの追っかけと同じ並び** (`ts/pacing` の `SPEEDS`)。
     * 録画は放送より先が無いという縛りが無いので、いつでも選べる。
     *
     * **選んだ値は覚える。** 倍速で観る人はたいてい次も倍速で、開くたびに
     * 選び直すことになる。覚えるのは端末ごと (`localStorage`) — 同じ人でも
     * 手元の端末と居間のテレビで好みが違う。続きの位置 (`resume_ms`) を
     * サーバに置いているのとは逆の理由
     */
    const SPEED_KEY = 'watch-speed';
    let speed = $state(1);

    /**
     * CM を自動で飛ばすか。**切っていない録画のためのもの。**
     *
     * 焼くときに CM を落とす設定にしていれば要らないが、判定を当てにせず
     * 残して焼いている場合 (既定はチャプターを入れるだけ) は、観るたびに
     * 送りのボタンを押すことになる。
     *
     * **端末ごとに覚える** (速さと同じ理由。`SPEED_KEY` の項)。
     * **既定は切っておく** — 判定が外れたときに本編を飛ばすので、
     * 黙って始めるものではない
     */
    const SKIP_CM_KEY = 'watch-skip-cm';
    let skipCm = $state(false);
    /** CM を飛ばしたことを短く言う。黙って跳ぶと壊れたように見える */
    let skipped = $state(false);
    let skipNotice: ReturnType<typeof setTimeout> | null = null;

    /** どこまで観たかを書き送る間隔 (ms)。**細かく送るものではない** */
    const REMEMBER = 15_000;
    /** 続きから出したか。出したことを画面にも言う (黙って途中から始まると驚く) */
    let continued = $state(false);

    /**
     * 画面の明るさ (`Brightness`)。**出先の明るいところで暗い場面を読むため。**
     * 覚えるのは端末ごとで、ライブと同じ値を使う
     */
    let brightness = $state(1);

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
        // 前に選んだ速さで始める。覚えるのは端末ごと
        setSpeed(storedSpeed(), false);
        skipCm = stored(SKIP_CM_KEY) === '1';
        void loadChapters();
        loadDetail();
        // 字幕は既定で出す (ライブと同じ)。持っていない録画では何も起きない
        if (captions) void loadCaptions();
        if (!ready) return;
        video?.play().catch(() => undefined);
        // 指のときは最初から全画面。テレビと同じで、観るために置いてある画面なので
        if (coarse) enterFull();
        const onFull = () => {
            full = document.fullscreenElement !== null;
            // 全画面は枠が変わるので、描き終わってから測り直す
            requestAnimationFrame(place);
        };
        document.addEventListener('fullscreenchange', onFull);
        // 枠が変われば重ねる場所も変わる (全画面・持ち替え・窓の伸び縮み)
        const onResize = () => place();
        window.addEventListener('resize', onResize);
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
            window.removeEventListener('resize', onResize);
            window.removeEventListener('pagehide', onLeave);
            clearInterval(ticker);
            remember(true);
            if (disarm !== null) clearTimeout(disarm);
            if (skipNotice !== null) clearTimeout(skipNotice);
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
        place();
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

    /**
     * 早送りの速さを変える。**音は残す** — ブラウザは倍速でも音程を保つので、
     * 消してしまうと早く観たいだけの人が黙って観ることになる
     */
    function setSpeed(value: number, remember = true): void {
        speed = value;
        if (video !== null) video.playbackRate = value;
        if (remember) remind(SPEED_KEY, String(value));
        controls.stir();
    }

    /** 覚えているもの。読めない繋ぎ (プライベート窓) では黙って null */
    function stored(key: string): string | null {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function remind(key: string, value: string): void {
        try {
            localStorage.setItem(key, value);
        } catch {
            // 覚えられなくても観るのに支障は無い (プライベート窓など)
        }
    }

    /** 前に選んだ速さを引き出す。読めない・知らない値なら等速 */
    function storedSpeed(): number {
        const saved = Number(stored(SPEED_KEY));
        return SPEEDS.includes(saved as (typeof SPEEDS)[number]) ? saved : 1;
    }

    /**
     * CM飛ばしの入り切り。切り替えた時点で、いま CM の中に居れば跳ぶ —
     * 「CMが始まったから押した」がいちばん多い押し方なので
     */
    function toggleSkipCm(): void {
        skipCm = !skipCm;
        remind(SKIP_CM_KEY, skipCm ? '1' : '0');
        if (skipCm) hopCm();
        controls.stir();
    }

    /**
     * CM の中に居たら、その終わりまで跳ぶ。**判断は `ts/watch.ts` が持つ。**
     *
     * 続いている CM はまとめて跨ぐので、15秒ごとに何度も跳ぶことはない
     */
    function hopCm(): void {
        if (!skipCm || video === null) return;
        const to = skipTarget(chapters, video.currentTime);
        if (to === null) return;
        video.currentTime = to;
        skipped = true;
        if (skipNotice !== null) clearTimeout(skipNotice);
        skipNotice = setTimeout(() => (skipped = false), 2500);
    }

    /** 速さを1段ずつ動かす。端では止まる */
    function stepSpeed(by: number): void {
        const at = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
        const next = SPEEDS[Math.min(Math.max(at + by, 0), SPEEDS.length - 1)];
        if (next !== undefined) setSpeed(next);
    }

    function togglePlay(): void {
        if (video === null) return;
        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
    }

    /**
     * 字幕の出し入れ。**絵を canvas に重ねる** — ライブ (`/live`) と同じやり方。
     *
     * 文字に直して `<track>` に渡す道も通したが、**放送どおりには出ない** —
     * 左右の位置も、背景の箱も、外字も落ちる。焼くときに作った絵 (PGS) が
     * 動画の隣に置いてあるので、それを denpa 自身が解いて重ねる
     * ([pgs.ts](../../../lib/pgs.ts) の `readSup`)
     */
    function toggleCaptions(): void {
        captions = !captions;
        if (captions) void loadCaptions();
        else clearCaptions();
        controls.stir();
    }

    /**
     * 字幕の絵を取ってくる。**押されるまで取りに行かない。**
     *
     * 実機の30分もので 6.0MB (697枚)。動画そのものが 300MB なので誤差だが、
     * 出さないと決めている人にまで運ばせる理由は無い
     */
    async function loadCaptions(): Promise<void> {
        if (drawn.length > 0) return;
        try {
            const res = await fetch(`/api/recordings/${rec.id}/captions.sup`);
            if (!res.ok) return;
            drawn = readSup(new Uint8Array(await res.arrayBuffer()));
            paint();
        } catch {
            // 出せないだけ。観るのに支障は無い
        }
    }

    function clearCaptions(): void {
        showing = null;
        clearOverlay(overlay);
    }

    /**
     * 字幕を**映像の絵が出ているところ**にぴったり重ねる。
     *
     * **字幕の面と映像は縦横比が違う。** 地上波は 1440x1080 の横長画素で、
     * 焼くときに正方形 (1920x1080) へ直しているのに、字幕の面は放送のまま。
     * `object-contain` で敷いていた頃は字幕だけ4:3に letterbox されて
     * **横に縮み、位置もずれて**いた。プレイヤーと同じく、映像の枠いっぱいに
     * 引き伸ばす (`fitRect`)
     */
    function place(): void {
        if (video === null || overlay === null) return;
        const rect = fitRect(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight);
        overlay.style.left = `${video.offsetLeft + rect.left}px`;
        overlay.style.top = `${video.offsetTop + rect.top}px`;
        overlay.style.width = `${rect.width}px`;
        overlay.style.height = `${rect.height}px`;
    }

    /**
     * いまの位置に合う1枚を重ねる。**変わったときだけ描く。**
     *
     * canvas は**映像の画素そのままの大きさ**にして、CSS で伸ばす
     * (`object-contain`)。位置合わせはブラウザ任せで、こちらは放送が言う座標に
     * そのまま置けばよい — **左右の位置がそのまま出る**のはこのため
     */
    function paint(): void {
        if (!captions || overlay === null) return;
        const next = captionAt(drawn, video?.currentTime ?? 0);
        if (next === showing) return;
        showing = next;
        if (next === null) {
            clearOverlay(overlay);
            return;
        }
        place();
        drawOverlay(overlay, {
            x: next.x,
            y: next.y,
            videoWidth: next.videoWidth,
            videoHeight: next.videoHeight,
            // 広げるのはここだけ。持っているのは畳んだ形 (`pgs.ts` の `Drawn`)
            source: new ImageData(new Uint8ClampedArray(pixels(next)), next.width, next.height),
        });
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
            s: () => void snapshot(),
            f: toggleFull,
            // 早送りは順送り。**戻る側も付ける** (行き過ぎたら戻れないと不便)
            '>': () => stepSpeed(1),
            '<': () => stepSpeed(-1),
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
    /** CM の入っている録画でだけ、飛ばす口を出す (押しても何も起きない操作を並べない) */
    const hasCm = $derived(chapters.some((chapter) => isCm(chapter.title)));

    /**
     * あと何分で終わるか。**倍速のぶんは割る** — 2倍で観ているときに
     * 「残り30分」と出ても、掛かるのは15分なので当てにならない
     */
    const remaining = $derived(Math.max(0, (length - at) / (speed || 1)));

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

    /** 切り抜きの結果。**貼れたかどうかは言う** (黙って何も起きないと分からない) */
    let shot = $state<Notice | null>(null);

    /** 断られたときだけ知らせる。消せたときは一覧へ戻るので出す先が無い */
    const notices = $derived<Notice[]>([
        ...(form !== null && form !== undefined && 'message' in form && typeof form.message === 'string'
            ? [{ key: 'watch-delete', kind: 'error' as const, text: form.message }]
            : []),
        ...(shot === null ? [] : [shot]),
    ]);

    /**
     * いまの1コマを**字幕ごと**切り抜いて、クリップボードへ。
     *
     * 字幕は別の canvas に重ねてあるので、映像の上にそれを重ねて焼き直すだけ。
     * **面の大きさが違う** (字幕 1440x1080 / 映像 1920x1080) ので、画面で
     * やっているのと同じように引き伸ばす。
     *
     * **貼れないことがある。** クリップボードに絵を置けるのは安全な繋ぎ
     * (https か localhost) だけで、押した勢い (user activation) も要る。
     * 断られたら**落とすほうに倒す** — 撮ったものを取り落とさない
     */
    async function snapshot(): Promise<void> {
        if (video === null || video.videoWidth === 0) return;
        controls.stir();
        const shotCanvas = document.createElement('canvas');
        shotCanvas.width = video.videoWidth;
        shotCanvas.height = video.videoHeight;
        const ctx = shotCanvas.getContext('2d');
        if (ctx === null) return;
        ctx.drawImage(video, 0, 0, shotCanvas.width, shotCanvas.height);
        // 出している字幕をそのまま重ねる (消しているときは重ねない)
        if (captions && overlay !== null && overlay.width > 1 && showing !== null) {
            ctx.drawImage(overlay, 0, 0, shotCanvas.width, shotCanvas.height);
        }

        const blob = await new Promise<Blob | null>((resolve) => shotCanvas.toBlob(resolve, 'image/png'));
        if (blob === null) return;

        try {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            shot = { key: `shot-${Date.now()}`, kind: 'success', text: '切り抜きをコピーしました' };
        } catch {
            // 置けない繋ぎ (http) や断られたとき。落として渡す
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${rec.name} - ${clock(at)}.png`;
            link.click();
            URL.revokeObjectURL(url);
            shot = { key: `shot-${Date.now()}`, kind: 'success', text: '切り抜きを保存しました' };
        }
    }
</script>

<svelte:head><title>{rec.name} - denpa</title></svelte:head>
<svelte:window onclick={stand} onkeydown={keys} />

<!--
    **タブレットからは2段組**にする (`md` = 768px)。縦のiPadでちょうど入る幅で、
    そこを境にすると「持ち替えたら形が変わる」ことがない。詳細は左に固定幅で
    置き、余ったぶんを全部映像にやる — 映像は横に広いほど見やすい。

    狭い画面では**映像が上、詳細が下**。指で開いたときはそもそも全画面に
    入っているので、ここが見えるのは全画面を抜けたあと。

    **詳細は右。** ライブ (`/live`) も右に局の一覧を置いているので、画面を
    移っても「絵は左、読むものは右」で揃う。

    **周りの余白は足さない。** 外の `<main>` が既に `p-4 md:p-6` を持っている
    ([+layout.svelte](../../+layout.svelte))。ここでも足していた頃は、他の画面より
    一回り内側から始まっていたうえ、**その足したぶんだけ縦がはみ出して**
    ページごとスクロールバーが出ていた。

    **横幅の頭打ちも置かない。** `max-w-[1800px]` で中央に寄せていた頃は、
    それより広い画面で**左右だけ余白が増えて**いた (実測 1880px でライブ 24px に
    対して 40px)。広すぎて映像が縦に伸びきる心配は要らない — 高さのほうを
    抑えてあるので、そこから先は黒い帯になるだけで、ライブ (`aspect-video
    max-h-full`) と同じ振る舞いになる
-->
<div class="grid gap-4 md:grid-cols-[1fr_minmax(15rem,20rem)]">
    <!-- **映像を先に書く。** 縦積みになったときに上へ来るのはこちら -->
    <!--
        **映像は自分の背丈のまま置く** (`self-start`)。縦長の画面では左のほうが
        背が高くなる (下の `min-h`) ので、伸ばされるままにすると映像の下に
        黒い帯が付く
    -->
    <section class="md:self-start">
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
                class="relative w-full overflow-hidden bg-black {full
                    ? 'flex h-screen items-center justify-center'
                    : ''} {controls.shown ? '' : 'cursor-none'}"
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
                    **字幕は `<track>` ではない。** 焼いたものに入っているのは PGS で、
                    文字ではなく**絵** (docs/encode.md)。文字に直して渡す道も通したが、
                    放送どおりには出ない (左右の位置・背景の箱・外字が落ちる)。
                    絵のまま重ねる — ライブと同じやり方 (下の canvas)
                -->
                <!--
                    **低くしすぎない** (`min-h-56` = 224px)。上下の帯を重ねて
                    いるので、絵がそれより低いと**帯どうしが重なって**削除も
                    再生も押せなくなる。16:9 なら 390px の端末で 219px なので、
                    ここが効くのは縦の狭い窓と、絵の大きさが分からないとき
                -->
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
                <video
                    bind:this={video}
                    {src}
                    class="w-full bg-black {full
                        ? 'h-full max-h-none'
                        : 'max-h-[calc(100dvh-9rem)] min-h-56 md:max-h-[calc(100dvh-7rem)]'}"
                    style="filter: brightness({brightness})"
                    playsinline
                    onclick={press}
                    onplay={() => {
                        playing = true;
                        controls.stir();
                    }}
                    onpause={() => {
                        playing = false;
                    }}
                    ontimeupdate={() => {
                        at = video?.currentTime ?? 0;
                        hopCm();
                        paint();
                    }}
                    onloadedmetadata={resume}
                    onvolumechange={() => (muted = video?.muted ?? false)}
                    onerror={() => (broken = true)}
                    data-testid="watch-video"
                >
                </video>

                <!--
                    **放送の字幕。** 映像と同じ枠に、映像の画素そのままの大きさで
                    敷いて、CSS で伸ばす (`object-contain`)。**押す邪魔をしない**
                    (`pointer-events-none`) — 下の絵を押して止められなくなる
                -->
                <canvas
                    bind:this={overlay}
                    class="pointer-events-none absolute"
                    style="filter: brightness({brightness})"
                    data-testid="watch-captions-canvas"
                    data-on={captions && hasCaptions}
                    aria-hidden="true"
                ></canvas>

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

                {#if skipped}
                    <!-- **黙って跳ばない。** 何が起きたか言わないと壊れて見える -->
                    <div
                        class="pointer-events-none absolute inset-x-0 top-14 z-10 flex justify-center"
                        data-testid="watch-skipped"
                    >
                        <span class="badge badge-neutral badge-sm">CMを飛ばしました</span>
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
                    **いちばん多く押すものは真ん中に、大きく。**

                    送る・止める・戻すを下の帯に他と同じ顔で並べていた頃は、
                    10個ほどの丸から狙って探すことになっていた。絵の真ん中なら
                    どこを見ていても目の隅に入るし、**指でも狙いやすい**
                    (絵を押すのは操作列の出し入れなので、指はここを押す)。

                    帯からは消してある。同じことをする口を2つ置くと、押した
                    ほうによって癖が違うのではないかと疑わせる
                -->
                <!--
                    **帯より上に置く** (`z-20`)。低い窓では真ん中と下の帯が
                    重なるので、下にすると帯のほうが押されてしまう
                -->
                {#if controls.shown}
                    <div
                        class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-4"
                    >
                        <button
                            type="button"
                            class="pointer-events-auto {CENTER_BTN} {OVERLAY}"
                            onclick={() => seekBy(-SKIP)}
                            aria-label="{SKIP}秒戻す"
                            data-testid="watch-back"
                        >
                            <Icon path={BACK10} size="size-8" />
                        </button>
                        <button
                            type="button"
                            class="pointer-events-auto {CENTER_BTN} {OVERLAY}"
                            onclick={togglePlay}
                            aria-label={playing ? '一時停止' : '再生'}
                            data-testid="watch-play"
                        >
                            <Icon path={playing ? PAUSE : PLAY} size="size-8" />
                        </button>
                        <button
                            type="button"
                            class="pointer-events-auto {CENTER_BTN} {OVERLAY}"
                            onclick={() => seekBy(SKIP)}
                            aria-label="{SKIP}秒送る"
                            data-testid="watch-forward"
                        >
                            <Icon path={FORWARD10} size="size-8" />
                        </button>
                    </div>
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
                        <!--
                            **並びはライブと同じ。** 音・字幕が左から順で、
                            全画面がいちばん右。画面を移っても同じ場所にあると、
                            見ないでも押せる。

                            **送る・止める・戻すはここに無い** — 絵の真ん中に
                            大きく置いてある (上の説明)。**出口と削除はここ** —
                            上にも帯を出すと絵の上下が両方黒く塗られる
                        -->
                        <a
                            class="{OVERLAY_BTN} btn-circle {OVERLAY}"
                            href="/"
                            aria-label="一覧へ戻る"
                            data-testid="watch-close"
                        >
                            <Icon path={CLOSE} />
                        </a>
                        <ControlButton
                            path={muted ? SOUND_OFF : SOUND_ON}
                            label={muted ? '音を出す' : '消音'}
                            onclick={() => {
                                if (video !== null) video.muted = !video.muted;
                            }}
                        />

                        <!--
                            **字幕を持っている録画でだけ出す。** 持っていないほうが
                            多い (字幕の無い番組・この仕組みより前に焼いたもの) ので、
                            押しても何も起きない操作を並べない。`/live` と同じ扱い
                        -->
                        {#if hasCaptions}
                            <ControlButton
                                path={CAPTION}
                                label={captions ? '字幕を消す' : '字幕を出す'}
                                on={captions}
                                testid="watch-captions"
                                onclick={toggleCaptions}
                            />
                        {/if}

                        <!--
                            **チャプター送りは、入っているときだけ出す。**
                            CMを切って焼いたものには入っていないので、出しても
                            押せない操作が並ぶだけになる
                        -->
                        {#if chapters.length > 1}
                            <ControlButton
                                path={PREV}
                                label="前のチャプター"
                                testid="watch-prev-chapter"
                                onclick={() => seekTo(prevChapterAt(chapters, at))}
                            />
                            <ControlButton
                                path={NEXT}
                                label="次のチャプター"
                                testid="watch-next-chapter"
                                onclick={() => seekTo(nextChapterAt(chapters, at))}
                            />
                        {/if}

                        <!--
                            **CM を自動で飛ばす。** チャプターに CM が入っている
                            録画でだけ出す。押した時点で CM の中に居れば、そこで跳ぶ
                        -->
                        {#if hasCm}
                            <ControlButton
                                path={CUT}
                                label={skipCm ? 'CM飛ばしをやめる' : 'CMを自動で飛ばす'}
                                on={skipCm}
                                testid="watch-skip-cm"
                                onclick={toggleSkipCm}
                            />
                        {/if}

                        <!--
                            **残りも出す。** 「あと何分で終わるか」は、途中で
                            観るのをやめるかどうかを決めるのに要る。倍速のときは
                            **実際に掛かる時間**にする (1.5倍なら残りも1.5で割る)
                        -->
                        <span class="px-1 text-xs tabular-nums" data-testid="watch-clock">
                            {clock(at)} / {clock(length)}
                            <span class="text-white/70">残り {clock(remaining)}</span>
                        </span>
                        {#if current !== null}
                            <span class="badge badge-sm badge-ghost" data-testid="watch-chapter">
                                {current.title}
                            </span>
                        {/if}

                        <!--
                            **番組の名前はここ。** 独立した行にしていた頃は、その
                            ぶん帯が高くなって絵に掛かっていた。押すものの間は
                            どのみち空いているので、そこに入れて縮む側にする
                        -->
                        <span
                            class="min-w-0 grow truncate px-2 text-xs text-white/80"
                            data-testid="watch-name"
                        >
                            {rec.name}
                        </span>

                        <!-- 早送り。**ライブの追っかけと同じ並び・同じ見た目** -->
                        <div class="dropdown dropdown-top dropdown-end">
                            <button
                                class="btn btn-sm tabular-nums {speed === 1 ? OVERLAY : OVERLAY_ON}"
                                aria-label="再生の速さ"
                                data-testid="watch-speed"
                            >
                                {speed}×
                            </button>
                            <ul
                                class="dropdown-content menu bg-base-100 text-base-content rounded-box z-10 mb-1 w-28 p-2 shadow-lg"
                                data-testid="watch-speed-menu"
                            >
                                {#each SPEEDS as value (value)}
                                    <li>
                                        <button
                                            class="tabular-nums {value === speed ? 'menu-active' : ''}"
                                            onclick={(event) => {
                                                setSpeed(value);
                                                event.currentTarget.blur();
                                            }}
                                            data-testid="watch-speed-option"
                                            data-speed={value}
                                            aria-current={value === speed ? 'true' : undefined}
                                        >
                                            {value}×
                                        </button>
                                    </li>
                                {/each}
                            </ul>
                        </div>

                        <!-- 画面の明るさ。ライブと同じ部品・同じ値 -->
                        <Brightness bind:value={brightness} testid="watch-brightness" />

                        <!--
                            **切り抜き。** 字幕ごと写して、そのまま貼れるようにする。
                            観ている場面を人に見せるのに、いちいち撮り直さずに済む
                        -->
                        <ControlButton
                            path={CAMERA}
                            label="この場面を切り抜く"
                            testid="watch-shot"
                            onclick={() => void snapshot()}
                        />
                        <ControlButton
                            path={full ? SHRINK : EXPAND}
                            label={full ? '全画面をやめる' : '全画面'}
                            testid="watch-full"
                            onclick={toggleFull}
                        />

                        <!--
                            **観終わったその場で消せるようにする。** 末尾はたいてい
                            CM なので、流したまま消せる。押し間違い防止に2回押させる
                            のは一覧と同じ。**いちばん端に置く** — 隣を押すつもりで
                            当たっても、聞き返しがあるので消えはしない
                        -->
                        <form method="POST" action="?/delete" use:submitting>
                            <input type="hidden" name="id" value={rec.id} />
                            {#if armed}
                                <button class="btn btn-error btn-lg" data-testid="watch-delete-confirm">
                                    確定
                                </button>
                            {:else}
                                <ControlButton
                                    path={TRASH}
                                    label="削除"
                                    testid="watch-delete"
                                    onclick={arm}
                                />
                            {/if}
                        </form>
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

        **高さは映像に合わせる。** 画面の高さから引き算した値 (`100dvh-7rem`) を
        持たせていた頃は、**映像の下端と揃わなかった** — 映像の高さは列の幅と
        16:9で決まるので、画面の高さとは関係がない。

        中身を `absolute` で浮かせて、この枠そのものは**高さを持たない**ように
        する。すると grid の行の高さは映像だけで決まり、伸ばされた枠が
        ちょうど映像と同じ高さになる。**高さが決まって初めて中が巻き取られる**
        ので、浮かせるのは巻き取りのためでもある (中身の背丈のままだと
        `overflow-y-auto` は効かない)。

        **下限も要る。** 縦長の画面 (縦のiPad) では列が細く、映像もそのぶん
        低くなる — 高さを映像に合わせるだけだと、下に画面半分の余りが
        できているのに説明だけ 260px の窓から覗くことになる。焼けていない
        録画は映像の代わりに短い札が出るだけなので、そちらにも効く
    -->
    <aside class="flex flex-col md:relative md:min-h-[24rem]">
        <div class="card bg-base-100 flex min-h-0 flex-1 shadow md:absolute md:inset-0">
            <!--
                **`card-body` は使わない。** daisyUI はあれの中の `<p>` に
                `flex-grow: 1` を当てるので、**中身が枠より短いと段落が余白を
                全部吸って**、局名と説明の下だけが不自然に空いていた
                (実機の26分もの。局名の下に 60px、説明の下に 90px)。
                ここは縦に積むだけの箱でよく、余白は自前で持つ
            -->
            <div class="min-h-0 flex-1 overflow-y-auto p-4" data-testid="watch-facts">
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

            <!--
                押すものは常に見えるところに置く。巻き取られる中身の外。

                **「一覧へ」は置かない。** 絵の左上の「×」が同じ行き先で、
                2つ並べる意味が無かった
            -->
            <div class="border-base-300 flex shrink-0 flex-wrap gap-2 border-t p-4">
                <a
                    class="btn btn-sm btn-outline"
                    href="/api/recordings/{rec.id}/file?download=1&source=encoded"
                    download
                    data-testid="watch-download"
                >
                    ダウンロード
                </a>
            </div>
        </div>
    </aside>
</div>

<Toasts {notices} source={form} />
