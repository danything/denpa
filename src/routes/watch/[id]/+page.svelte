<script lang="ts">
    import { onMount, untrack } from 'svelte';
    import { submitting } from '#lib/actions.js';
    import { arming } from '#lib/arming.svelte.js';
    import { type CanvasPlayer, canvasPlayer } from '#lib/canvas-player.js';
    import { canvasVideo, driveNoticeSeen } from '#lib/canvas-video.js';
    import {
        CAPTION_TEXT_VERSION,
        type CaptionLanguage,
        type CaptionPage,
        type CaptionPages,
        captionLanguage as languageOf,
    } from '#lib/caption-text.js';
    import DriveNotice from '#lib/components/DriveNotice.svelte';
    import ProgramFacts from '#lib/components/ProgramFacts.svelte';
    import { ambientMode } from '#lib/components/player/ambient.svelte.js';
    import { screenAwake } from '#lib/components/player/awake.svelte.js';
    import { backgroundPlayback } from '#lib/components/player/background.svelte.js';
    import CloseLink from '#lib/components/player/CloseLink.svelte';
    import ControlBar from '#lib/components/player/ControlBar.svelte';
    import ControlButton from '#lib/components/player/ControlButton.svelte';
    import ControlRow from '#lib/components/player/ControlRow.svelte';
    import { CaptionPainter } from '#lib/components/player/caption-draw.js';
    import {
        CAPTION_LANGUAGE_KEY,
        CAPTION_ON_KEY,
        pickLanguage,
        storedCaptionsOn,
    } from '#lib/components/player/caption-pref.js';
    import { playerControls } from '#lib/components/player/controls.svelte.js';
    import DataBroadcast, { pressD } from '#lib/components/player/DataBroadcast.svelte';
    import Extras from '#lib/components/player/Extras.svelte';
    import FactsAside from '#lib/components/player/FactsAside.svelte';
    import { eachFrame } from '#lib/components/player/frames.js';
    import { stageFullscreen } from '#lib/components/player/fullscreen.svelte.js';
    import InfoBlock from '#lib/components/player/InfoBlock.svelte';
    import {
        AUDIO,
        CAMERA,
        CAPTION,
        CHECK,
        CODEC,
        DATA,
        NEXT,
        PAUSE,
        PLAY,
        PREV,
        SOUND_OFF,
        SOUND_ON,
        TRASH,
    } from '#lib/components/player/icons.js';
    import { playerKeys } from '#lib/components/player/keys.js';
    import PlayerLayout from '#lib/components/player/PlayerLayout.svelte';
    import PlayerStage from '#lib/components/player/PlayerStage.svelte';
    import { fitRect } from '#lib/components/player/paint.js';
    import { pictureInPicture } from '#lib/components/player/pip.svelte.js';
    import Remote from '#lib/components/player/Remote.svelte';
    import SeekBar from '#lib/components/player/SeekBar.svelte';
    import SpeedMenu, { SPEED_KEY, storedSpeed } from '#lib/components/player/SpeedMenu.svelte';
    import StageNote from '#lib/components/player/StageNote.svelte';
    import StageTail from '#lib/components/player/StageTail.svelte';
    import { audioTracks, recordingCodecs, subtitles } from '#lib/components/player/settings.js';
    import { snapshotter } from '#lib/components/player/shot.svelte.js';
    import { grabbedFrame, videoFrame } from '#lib/components/player/snapshot.js';
    import { stageTap } from '#lib/components/player/stage-tap.js';
    import Toasts, { errorNotice, type Notice } from '#lib/components/Toasts.svelte';
    import { programDetail, recordingFacts } from '#lib/detail.svelte.js';
    import { driveGate } from '#lib/drive-gate.svelte.js';
    import { denpaFontUrl } from '#lib/font.js';
    import { clock, cmNoteWorthShowing, recordedDuration, size } from '#lib/format.js';
    import { CODEC_LABEL } from '#lib/hw.js';
    import { write as remind, read as stored } from '#lib/keep.js';
    import { type MkvSource, openMkv } from '#lib/mkv-source.js';
    import { loadOffline } from '#lib/offline.svelte.js';
    import type { OfflineVideo } from '#lib/offline-db.js';
    import { canvasSupport, rawUnsupported } from '#lib/raw/support.js';
    import { type RemuxPlayer, remuxPlayer } from '#lib/remux-player.js';
    import { keepResume } from '#lib/resume.js';
    import type { ResponseMessage } from '#lib/ts/bml-protocol.js';
    import { type Cue, showing as captionShowing, currentCue } from '#lib/ts/captions.js';
    import { feedFor, type PlacedMessage, replayAt } from '#lib/ts/data-timeline.js';
    import { pickMediaSource } from '#lib/ts/media-source.js';
    import { stepSpeed } from '#lib/ts/pacing.js';
    import {
        type CanvasAbility,
        type CanvasCodec,
        type CodecChoice,
        canvasChoices,
        canvasTranscodes,
        codecChoices,
        type MediaAbility,
        type Picked,
        type PlaybackInfo,
        pickCanvas,
        pickOffer,
        retryWait,
        STREAM_RETRIES,
        streamForAudio,
        transcodes,
    } from '#lib/ts/playback.js';
    import {
        type Chapter,
        chapterAt,
        cmSpans,
        isCm,
        nextChapterAt,
        plainMarks,
        prevChapterAt,
        resumePoint,
        skipCmAtStart,
        skipTarget,
    } from '#lib/ts/watch.js';
    import { resolve } from '$app/paths';

    let { data, form } = $props();
    const rec = $derived(data.recording);

    /** 観るものがあるか。エンコード済みか、録り終えた元の TS (`+page.server.ts`) */
    const ready = $derived(data.playable);
    /*
     * 端末に保存してあれば**オンラインでもそちらを観る** (docs/offline.md)。
     * サーバから読み直さないので、帯域を使わず、電波が細いところでも途切れない。
     * 字幕・チャプター・データ放送も一緒に落としてあるものを使う
     * (各 load が localCopy を先に見る)。
     *
     * **確かめ終わるまで src を渡さない。** 渡してしまうと `<video>` が先に
     * サーバから読み始め、あとから blob に差し替わって読み直しになる —
     * 端末にあるのにサーバから取得したように見えるのもまぎらわしい
     */
    let localSrc = $state<string | null>(null);
    let localChecked = $state(false);
    let localCopy: OfflineVideo | null = null;
    /**
     * 端末に保存したものを探している最中の約束。**字幕・チャプターも、探し終えてから読む** — 先に読みに行くと
     * 端末のものを見ずにサーバから取得していた (オフラインでは CM 飛ばしも字幕も効かなかった)
     */
    let localLookup: Promise<OfflineVideo | null> = Promise.resolve(null);
    /**
     * 何で観られるか (`api/recordings/<id>/playback`)。聞けなかった (オフライン) ときは null。
     * **どれを使うかはこの画面が決める** (`ts/playback.ts` の `pickOffer`): そのまま読めるファイル、
     * 読めなければサーバが詰め替えて流すもの、まだエンコードしていない録画はサーバがその場で変換して流すもの
     */
    let info = $state.raw<PlaybackInfo | null>(null);
    /** いま観ているもの。観られるものが無ければ null */
    let picked = $state.raw<Picked | null>(null);
    /**
     * 人が選んだコーデック (`auto` は端末に合わせる)。**端末ごとに覚える** — 同じ人でも
     * 手元の端末と居間のテレビでデコードできるものが違う (速さ・CM 飛ばしと同じ `localStorage`)
     */
    let choice = $state<CodecChoice | 'mpeg2'>('auto');
    const CODEC_KEY = 'watch-codec';
    /** サーバが混んでいて、その場の変換を断られた (`remux-player.ts` の `busy`) */
    let busy = $state(false);
    /** その場で流しているときのプレイヤー (`remux-player.ts`) */
    let remux: RemuxPlayer | null = null;
    /** 選び直したときに続ける位置 (秒)。その場で流すプレイヤーの開始位置に使う */
    let switchAt: number | null = null;

    /*
     * ---- 互換モード (`canvas-video.ts`) ----
     *
     * **`<video>` を使わず canvas に描く** (`canvas-player.ts`)。`<video>` の再生が止まる端末 (テスラの
     * 車載ブラウザ) のため。リクエスト先は `<video>` でその場で流すときと同じ `/stream` で、H.264 / AV1 の
     * fMP4 か元の TS (MPEG-2) を、ライブ・追っかけと同じエンジン (`raw/engine.ts`) で描く。
     * **ここでは `<video>` に戻らない** — 描けなくなったら MPEG-2 へ、それも無理なら理由を出して止まる
     * (ライブと同じ)。**端末に保存したものは、その Matroska を読んで描く** (`mkv-source.ts`。オフラインでも)
     */
    /** 互換モードか。**開いたときに決める** (設定画面でオン/オフする) */
    let compat = $state(false);
    /** この端末で描ける形式 (`raw/support.ts`)。調べるまで null */
    let canvasAbility = $state.raw<CanvasAbility | null>(null);
    /** いま canvas に描いている形式。描いていなければ null (`<video>` で観ている・まだ始めていない) */
    let canvasCodec = $state<CanvasCodec | null>(null);
    /** canvas に描くプレイヤー。`canvasCodec` が決まって、映像の箱ができたら作る */
    let canvas: CanvasPlayer | null = null;
    /** canvas のプレイヤーがあるか (`canvas` は畳み直しの都度替わるので、画面の出し分けはこちらで見る) */
    let drawing = $state(false);
    /** 端末に保存した録画を描くときの読み込み元 (`mkv-source.ts`)。サーバから流しているなら null */
    let localMkv: MkvSource | null = null;
    /** 端末に保存した録画を canvas に描いているか (操作バーの「端末」の印・メニューの出し分け) */
    let drawingLocal = $state(false);
    /** 描いている途中で諦めた形式。**選び直すまでリクエストし直さない** (戻しては諦めるを繰り返さない) */
    let canvasGaveUp: CanvasCodec[] = [];
    /** 互換モードで観られない理由。出したら `<video>` には戻らずに止まる */
    let canvasProblem = $state<string | null>(null);
    /** 映像の上に出しておく断り書き (MPEG-2 に切り替えた、など) */
    let warning = $state<string | null>(null);
    /** 運転中の注意 (互換モード。`drive-gate.svelte.ts`)。押すまで再生を始めない */
    const drive = driveGate();

    /** 形式の名前 (メニュー・混んでいるときの勧め) */
    function codecLabel(codec: CanvasCodec): string {
        return codec === 'mpeg2' ? 'MPEG-2' : CODEC_LABEL[codec];
    }

    /**
     * 互換モードの支度。運転中の注意をまだ見せていなければ見せて待ち、描ける形式を調べて、どれで観るかを決める
     * (`ts/playback.ts` の `pickCanvas`)。端末に保存したものがあれば、まずそれを描く (下)
     */
    async function prepareCompat(got: PlaybackInfo | null): Promise<void> {
        if (got === null && localCopy?.video === undefined) {
            canvasProblem = 'サーバに繋がらないため再生できません';
            return;
        }
        if (!driveNoticeSeen()) await drive.confirm();
        const [support, problem] = await Promise.all([canvasSupport(), rawUnsupported()]);
        canvasAbility = { ...support, mpeg2: problem === null };
        /*
         * **端末に保存したものがあれば、それを canvas に描く** (オンラインでも。`<video>` と同じ考え)。
         * 描けない形式 (この端末の VideoDecoder がデコードできない) か読めなければ、サーバから流すものへ
         */
        if (localCopy?.video !== undefined) {
            const source = await openMkv(localCopy.video).catch(() => null);
            if (source?.codec != null && canvasAbility[source.codec]) {
                localMkv = source;
                canvasCodec = source.codec;
                return;
            }
        }
        if (got === null) {
            canvasProblem = '再生できる形式がありません';
            return;
        }
        const codec = pickCanvas(got, canvasAbility, choice);
        if (codec === null) canvasProblem = '再生できる形式がありません';
        else canvasCodec = codec;
    }

    /** canvas に描くプレイヤーを作って流しはじめる。**続きの位置からリクエストする** (選び直し・切り替えならその位置) */
    $effect(() => {
        const codec = canvasCodec;
        // 端末に保存したものはオフラインでも描く (`playback` が聞けなくてよい)
        if (codec === null || (info === null && localMkv === null) || mediaBox === null || canvas !== null) return;
        untrack(() => startCanvas(codec));
    });

    /**
     * 尺 (秒)。**端末に保存したものを描いているなら、そのファイルに書いてある長さ** (描いているのはそのファイル。
     * 尻の手前へ飛ぶと終わりにするので、違う長さを使うと途中で終わる)。それ以外は `playback`
     */
    function canvasLength(): number {
        if (localMkv !== null) return localMkv.duration ?? (localCopy?.durationMs ?? 0) / 1000;
        return info?.duration ?? 0;
    }

    function startCanvas(codec: CanvasCodec): void {
        const local = localMkv;
        const duration = canvasLength();
        const fresh = switchAt === null;
        const from = startFrom(duration);
        let made: CanvasPlayer;
        try {
            made = canvasPlayer({
                host: mediaBox as HTMLElement,
                before: overlay,
                input: local !== null ? 'mkv' : codec === 'mpeg2' ? 'ts-mpeg2' : 'fmp4',
                request: (at, audio, signal) =>
                    local !== null
                        ? Promise.resolve(local.request(at))
                        : fetch(streamUrl(codec, at, audio), { signal }),
                duration,
                start: from ?? 0,
                audio: streamAudio(audioIndex),
                background: background.on || pip.active,
                paused: false,
                state: (state) => {
                    resuming = state === 'retrying';
                    busy = state === 'busy';
                    if (state !== 'failed') return;
                    // 読めない中身・繋ぎ直しを使い切った。理由を出して止まる (`<video>` には戻らない)
                    stopCanvas();
                    canvasProblem = '録画を読み込めませんでした';
                },
                gaveUp: (reason) => canvasFallBack(reason),
                remote: (stop) => (stop ? pauseMedia() : playMedia()),
                waiting: (on) => (on ? stall() : flowing()),
                ended: () => {
                    playing = false;
                    finished();
                },
                tick: canvasTick,
            });
        } catch (error) {
            canvasFallBack(`再生を始められませんでした (${error instanceof Error ? error.message : String(error)})`);
            return;
        }
        canvas = made;
        drawing = true;
        if (muted) made.mute(true);
        drawingLocal = local !== null;
        length = duration;
        at = from ?? 0;
        playing = !made.paused;
        syncAudio();
        place();
        controls.stir();
        if (!fresh || resumed) return;
        resumed = true;
        if (from !== null) showContinued();
        settle();
    }

    /** canvas のプレイヤーを畳む (切り替える・諦める) */
    function stopCanvas(): void {
        canvas?.destroy();
        canvas = null;
        drawing = false;
        drawingLocal = false;
        canvasCodec = null;
        playing = false;
        flowing();
    }

    /**
     * 描くのを諦めた。**理由は断り書きに残す。** ライブと同じ順 (`live-player.svelte.ts` の `fallBack`):
     * H.264 / AV1 を諦めたら MPEG-2 へ、MPEG-2 を諦めたら描ける H.264 / AV1 へ。どれも無理なら理由を出して止まる
     * (`<video>` には戻らない)
     */
    function canvasFallBack(reason: string): void {
        const failed = canvasCodec;
        const position = mediaTime();
        const wasLocal = localMkv !== null;
        stopCanvas();
        /*
         * 端末に保存した録画を描けなくなった。サーバから流せるならそちらへ (描ける形式で)。無理なら理由を出して止まる
         */
        if (wasLocal) {
            localMkv = null;
            const next = info !== null && canvasAbility !== null ? pickCanvas(info, canvasAbility, choice, canvasGaveUp) : null;
            if (next === null) {
                canvasProblem = reason;
                return;
            }
            warning = reason;
            switchAt = position;
            canvasCodec = next;
            return;
        }
        if (failed !== null) canvasGaveUp = [...canvasGaveUp, failed];
        const usable =
            info === null || canvasAbility === null
                ? []
                : canvasChoices(info, canvasAbility).filter(
                      (item) => item.drawable && !canvasGaveUp.includes(item.codec),
                  );
        const next =
            failed === 'mpeg2'
                ? (usable.find((item) => item.codec !== 'mpeg2')?.codec ?? null)
                : usable.some((item) => item.codec === 'mpeg2')
                  ? 'mpeg2'
                  : null;
        if (next === null) {
            canvasProblem = reason;
            return;
        }
        warning = `${reason}。${codecLabel(next)} に切り替えました`;
        switchAt = position;
        canvasCodec = next;
    }

    /** canvas のプレイヤーの刻み。`<video>` の `timeupdate` と映した1枚ごとの追いかけ (`follow`) の代わり */
    function canvasTick(): void {
        if (canvas === null) return;
        const now = canvas.currentTime;
        if (Math.abs(now - at) >= 0.05) at = now;
        // 自動再生で断られて音を出せていない。消音にしておき、押して出してもらう (ライブと同じ)
        if (!muted && canvas.blocked && !canvas.paused) muted = true;
        // 飛んだ先に着いた (流れ出した)。CM の跨ぎを待つのをやめる
        if (waiting && canvas.flowing && now >= hopTo) {
            if (++settled >= SETTLED) open();
        }
        paint();
        hopCm();
        feedData();
    }

    /*
     * ---- 再生の操作 ----
     *
     * `<video>` と canvas のプレイヤーのどちらで観ていても、位置・飛ぶ・止める・再開はここを通す
     */
    /** いまの位置 (秒。物差しの上) */
    function mediaTime(): number {
        return canvas?.currentTime ?? video?.currentTime ?? 0;
    }

    /** 飛ぶ。canvas は持っているものを捨ててリクエストし直す */
    function seekMedia(to: number): void {
        if (canvas !== null) {
            canvas.seek(to);
            at = to;
            paint();
            feedData();
            return;
        }
        if (video !== null) video.currentTime = to;
    }

    function mediaPaused(): boolean {
        return canvas !== null ? canvas.paused : (video?.paused ?? true);
    }

    function playMedia(): void {
        if (canvas !== null) {
            canvas.play();
            playing = true;
            controls.stir();
            return;
        }
        void video?.play().catch(() => undefined);
    }

    function pauseMedia(): void {
        if (canvas !== null) {
            canvas.pause();
            /*
             * **止めた位置を時計にすぐ出す。** 刻み (`canvasTick`) を待つと、押した直後は1つ前の刻みの位置が
             * 出ていて、次の刻みで1秒進んだように見えた。0.05 秒より小さな差は刻みでは直さないので、
             * 止めている間ずっとずれたままのこともあった (`<video>` は止めたときに `timeupdate` が来る)
             */
            at = canvas.currentTime;
            playing = false;
            flowing();
            return;
        }
        video?.pause();
    }

    /** 音を消す・出す。canvas はプレイヤーの音 (自動再生で断られていても、押されたここなら鳴らせる) */
    function toggleMute(): void {
        if (canvas !== null) {
            muted = !muted;
            canvas.mute(muted);
            return;
        }
        if (video !== null) video.muted = !video.muted;
    }

    /** ブラウザへの問い合わせ (`ts/playback.ts`)。DOM が要るので開いてから */
    function ability(): MediaAbility {
        return {
            play: (type) => document.createElement('video').canPlayType(type) !== '',
            mse: (type) => pickMediaSource()?.Source.isTypeSupported(type) ?? false,
        };
    }

    onMount(() => {
        localLookup = loadOffline(rec.id).catch(() => null);
        const asked = stored(CODEC_KEY);
        choice = asked === 'h264' || asked === 'av1' || asked === 'mpeg2' ? asked : 'auto';
        void (async () => {
            const [held, got] = await Promise.all([localLookup, ready ? loadPlayback() : null]);
            localCopy = held;
            info = got;
            // 互換モードは canvas に描く (`prepareCompat`)。端末に保存したものも canvas に描く
            compat = ready && canvasVideo();
            if (compat) {
                await prepareCompat(got);
                localChecked = true;
                return;
            }
            /*
             * 聞けなかった (オフライン) ときは、今までどおりエンコード済みをそのまま渡す。
             * 端末に保存したものがあればそちら (下)
             */
            // MPEG-2 は互換モードでだけ選べる。互換モードでなければ自動と同じ
            const wanted = choice === 'mpeg2' ? 'auto' : choice;
            picked =
                got !== null
                    ? pickOffer(got, ability(), wanted)
                    : rec.library_path?.endsWith('.mkv') === true || localCopy?.video !== undefined
                      ? { way: 'file', codec: 'av1', source: 'encoded' }
                      : null;
            // 端末のコピーはエンコード済みの主。そのまま読むときだけ使う (選んだコーデックがあれば選んだほう)
            if (localCopy?.video !== undefined && picked?.way === 'file' && wanted === 'auto') {
                localSrc = URL.createObjectURL(localCopy.video);
            }
            if (ready && picked === null) broken = true;
            localChecked = true;
        })();
        return () => {
            if (localSrc !== null) URL.revokeObjectURL(localSrc);
            remux?.destroy();
            canvas?.destroy();
            canvas = null;
        };
    });

    /** 何で観られるか (`api/recordings/<id>/playback`)。聞けなければ null */
    async function loadPlayback(): Promise<PlaybackInfo | null> {
        try {
            const res = await fetch(resolve(`api/recordings/${rec.id}/playback`));
            return res.ok ? ((await res.json()) as PlaybackInfo) : null;
        } catch {
            return null;
        }
    }

    const src = $derived(
        localChecked && picked?.way === 'file'
            ? (localSrc ?? resolve(`api/recordings/${rec.id}/file?source=${picked.source}`))
            : undefined,
    );

    /** その場で流すもの (`/stream`) のリクエスト先。`at` 秒から、`audio` (`streamAudio`) の音声で */
    function streamUrl(codec: CanvasCodec, at: number, audio: string): string {
        return resolve(
            `api/recordings/${rec.id}/stream?codec=${codec}&from=${at.toFixed(3)}&audio=${encodeURIComponent(audio)}`,
        );
    }

    /**
     * プレイヤーを作るときに始める位置 (秒)。コーデックを切り替えた所か、続きの位置。頭からなら null。
     * **切り替えた所は1度読んだら忘れる**
     */
    function startFrom(duration: number): number | null {
        const from =
            switchAt ?? (rec.resume_ms === null ? null : resumePoint(rec.resume_ms / 1000, duration));
        switchAt = null;
        return from;
    }

    /** **黙って途中から始めない。** 続きから始めたと言って、しばらくで引っ込める */
    function showContinued(): void {
        continued = true;
        setTimeout(() => (continued = false), 4000);
    }

    /** その場で流すときにリクエストする音声 (`playback` の `audios` の `id`) */
    function streamAudio(index: number): string {
        // 端末に保存した録画はトラックの何本目か (`mkv-source.ts`)
        if (localMkv !== null) return String(index);
        return info?.audios[index]?.id ?? info?.audios[0]?.id ?? '0';
    }

    /** その場で流すなら、プレイヤーを作って流しはじめる。**続きの位置からリクエストする** (頭から読んで捨てない) */
    $effect(() => {
        const plan = picked;
        if (!localChecked || plan?.way !== 'stream' || info === null || video === null || remux !== null) return;
        const source = pickMediaSource();
        if (source === null) return;
        const total = info.duration;
        const from = startFrom(total);
        remux = remuxPlayer(video, source, {
            url: (at, audio) => streamUrl(plan.codec, at, audio),
            codecs: plan.type,
            duration: total,
            start: from ?? 0,
            audio: streamAudio(audioIndex),
            state: (state) => {
                resuming = state === 'retrying';
                busy = state === 'busy';
                if (state === 'failed') broken = true;
            },
        });
    });

    /**
     * **コーデックを選び直す** (コーデックのメニュー)。選んだものは端末ごとに覚える。
     * 観られる方式が変わるなら、いまの位置から観直す (プレイヤーを作り直す)
     */
    function chooseCodec(next: CodecChoice | 'mpeg2'): void {
        choice = next;
        remind(CODEC_KEY, next);
        controls.stir();
        if (info === null) return;
        if (compat) {
            chooseCanvas(next);
            return;
        }
        const fresh = pickOffer(info, ability(), next === 'mpeg2' ? 'auto' : next);
        if (JSON.stringify(fresh) === JSON.stringify(picked) && !busy) return;
        const position = video?.currentTime ?? 0;
        remux?.destroy();
        remux = null;
        // 端末のコピーは自動のときだけ (主のエンコード済み)
        if (localSrc !== null) {
            URL.revokeObjectURL(localSrc);
            localSrc = null;
        }
        busy = false;
        broken = false;
        // ファイルなら尺が分かったところで戻す (`resume`)。その場で流すならプレイヤーの開始位置
        retryAt = position;
        switchAt = position;
        picked = fresh;
    }

    /**
     * 互換モードで選び直す。**選んだものは諦めていても試す** (選び直すまでリクエストし直さない、の「選び直し」)。
     * 描く形式が変わるなら、いまの位置からプレイヤーを作り直す
     */
    function chooseCanvas(next: CodecChoice | 'mpeg2'): void {
        if (info === null || canvasAbility === null) return;
        const fresh = pickCanvas(info, canvasAbility, next, next === 'auto' ? canvasGaveUp : []);
        if (fresh === canvasCodec && !busy && canvasProblem === null) return;
        const position = mediaTime();
        stopCanvas();
        busy = false;
        canvasProblem = null;
        warning = null;
        if (fresh === null) {
            canvasProblem = '再生できる形式がありません';
            return;
        }
        canvasGaveUp = canvasGaveUp.filter((codec) => codec !== fresh);
        switchAt = position;
        canvasCodec = fresh;
    }

    /** メニューに並べるもの。この端末で観られる方式があるコーデックが 2 つ以上あるときだけ出す */
    const codecMenu = $derived.by((): { key: string; label: string; disabled?: boolean }[] => {
        if (info === null || !localChecked) return [];
        /*
         * 互換モードは流せるもの (H.264・AV1・MPEG-2) を並べ、**描けない形式は押せなくする** (ライブと同じ)。
         * 端末に保存したものを描いている間は出さない
         */
        if (compat) {
            if (canvasAbility === null || drawingLocal) return [];
            const items = canvasChoices(info, canvasAbility);
            if (items.length < 2) return [];
            return [
                { key: 'auto', label: '自動' },
                ...items.map((item) => ({
                    key: item.codec,
                    label: codecLabel(item.codec),
                    disabled: !item.drawable,
                })),
            ];
        }
        const choices = codecChoices(info, ability());
        if (choices.length < 2) return [];
        return [
            { key: 'auto', label: '自動' },
            ...choices.map((codec) => ({ key: codec, label: CODEC_LABEL[codec] })),
        ];
    });

    /** 混んでいて断られたとき、サーバに変換させずに観られるもの (エンコード済み・詰め替え) */
    const lighter = $derived.by((): CanvasCodec[] => {
        if (info === null || !busy) return [];
        // 互換モードは描ける形式のうち、変換させないもの (詰め替え・元の TS)
        if (compat) {
            if (canvasAbility === null) return [];
            const plan = info;
            return canvasChoices(plan, canvasAbility)
                .filter((item) => item.drawable && !canvasTranscodes(plan, item.codec))
                .map((item) => item.codec);
        }
        const can = ability();
        return codecChoices(info, can).filter((codec) => {
            const way = pickOffer(info as PlaybackInfo, can, codec);
            return way !== null && way.codec === codec && !transcodes(info as PlaybackInfo, way);
        });
    });

    let video = $state<HTMLVideoElement | null>(null);
    /** 映像とその上の操作をまとめた箱。全画面にするのはこちら */
    let stage = $state<HTMLElement | null>(null);
    /** 全画面の出入り (3画面共通。[fullscreen.svelte.ts](../../../lib/components/player/fullscreen.svelte.ts)) */
    const fullscreen = stageFullscreen(() => stage);

    /*
     * --- 録画のデータ放送 ---
     *
     * ライブは今のカルーセルをそのまま流すが、録画は**エンコードするときに取り出しておいた
     * 変化ログ**を、再生位置に合わせて流し直す (`ts/data-timeline`,
     * `server/recorded-bml.ts`)。描くのはライブと同じ `DataBroadcast`。
     */
    /** d ボタンで出しているか */
    let showData = $state(false);
    /** 映像を入れる箱。**BML はこれを動かす** (`DataBroadcast` の place) */
    let mediaBox = $state<HTMLElement | null>(null);
    /** リモコンのキーを渡す関数と、d を文書へ渡す関数 (ライブと同じ。`DataBroadcast` の press / pressD) */
    let dataPress = $state<((code: number) => void) | null>(null);
    let dataButton = $state<(() => boolean) | null>(null);
    /**
     * データ放送を作り直す合図 (`DataBroadcast` の channel)。**戻ったら変える** —
     * エンジンを作り直して、その時点まで積み直す
     */
    let dataChannel = $state<string | null>(null);
    /** 録画のときに取り出しておいた変化ログ。**押されてから取得する** (字幕と同じ「求められてから」) */
    let dataTimeline: PlacedMessage[] = [];
    /** エンジンへ流す関数。`DataBroadcast` が open のたびに預けてくる */
    let dataEmit: ((message: ResponseMessage) => void) | null = null;
    /** どこまで流したか (再生位置 ms)。まだなら -1 */
    let dataFed = -1;

    function nowMs(): number {
        return Math.round(mediaTime() * 1000);
    }

    /** データ放送を出す/消す。d ボタンの振る舞いは `pressD` (DataBroadcast) */
    async function setData(on: boolean): Promise<void> {
        showData = on;
        if (!showData) {
            dataChannel = null;
            return;
        }
        if (dataTimeline.length === 0) {
            if (Array.isArray(localCopy?.databroadcast)) {
                // 端末に保存したものから。オフラインでも d が効く
                dataTimeline = localCopy.databroadcast as PlacedMessage[];
            } else {
                const response = await fetch(resolve(`api/recordings/${rec.id}/databroadcast`)).catch(() => null);
                dataTimeline = response?.ok ? await response.json() : [];
            }
        }
        dataFed = -1;
        // エンジンを作らせる。open のあと listenData が呼ばれて、いまの位置まで積み直す
        dataChannel = `${rec.id}`;
    }

    /**
     * `DataBroadcast` がエンジンへの入口を預けてくる (作り直すたびに新しいものを)。
     * **預かった直後に、いまの再生位置まで積んで追いつく** (`replayAt`)
     */
    function listenData(emit: ((message: ResponseMessage) => void) | null): void {
        dataEmit = emit;
        if (emit === null) return;
        const to = nowMs();
        for (const message of replayAt(dataTimeline, to)) emit(message);
        dataFed = to;
    }

    /** 再生が進んだぶんのデータ放送を流す。**戻っていたらエンジンを作り直す** */
    function feedData(): void {
        if (!showData || dataEmit === null) return;
        const to = nowMs();
        const feed = feedFor(dataTimeline, dataFed, to);
        if (feed.reset) {
            // channel を変えると close→open して listenData が積み直す
            dataChannel = `${rec.id}:${to}`;
            return;
        }
        for (const message of feed.messages) dataEmit(message);
        dataFed = to;
    }

    let playing = $state(false);
    let at = $state(0);
    let length = $state(0);
    let muted = $state(false);
    /**
     * 選べる音声トラック。**ブラウザがコンテナから出せたときだけ。**
     *
     * エンコードしたものには主音声・副音声が両方入っている (二カ国語の映画・二重音声の
     * アニメなど)。ブラウザが Matroska の音声を `video.audioTracks` に出せれば、
     * ここで選んだものだけを有効にして切り替える。ライブと違い**サーバはエンコード
     * 直さない** — コンテナの中に入っているものを選ぶだけ。
     *
     * **出せない端末 (Chrome・Firefox の既定) では `playback` の名前で並べ、選んだらその場で流すほうへ
     * 移る** (`moveForAudio`。サーバが選んだ1本を流す)。移れる先も無ければ空のまま = 切り替えは出さない。
     * 押しても効かない操作を並べないため、2本以上あるときだけ出す (`hasCaptions` と同じ考え)
     */
    let audios = $state<{ label: string }[]>([]);
    let audioIndex = $state(0);
    /**
     * 字幕を出しているか。**持っている録画でだけ意味を持つ** (`data.subtitle`)。
     * **既定は出す** — ライブと同じ (`live-player` の `captions`)。端末ごとに覚える (`caption-pref.ts`)
     */
    let captions = $state(true);
    /**
     * 字幕。**開いた時点で取得する** (既定で出すので)。エンコードした録画に入っている放送の字幕を
     * 文字の配置で受け取る (`captions.json`。ライブと同じ描き方)。ずっと前にエンコードした録画の画像の字幕 (PGS) は読まない。
     *
     * 持っている番組かどうかは**取ってみるまで分からない** — 入れ物から抜くので、
     * 無ければ 404 が返る。ライブと同じで、持っているときだけボタンを出す
     * (`live-player` の `hasCaptions`)
     */
    /** 受け取った字幕 (全部の言語)。持っていなければ null */
    let captionText = $state.raw<CaptionPages | null>(null);
    /**
     * 載っている言語。第1言語は `pages`、第2言語から後ろは `others` (`captions.json`)。
     * 名前が分からない第1言語 (古いサーバ・端末に保存した古いコピー) は「字幕1」
     */
    const captionLanguages = $derived<CaptionLanguage[]>(
        captionText === null
            ? []
            : [
                  captionText.language ?? languageOf(1, ''),
                  ...(captionText.others ?? []).filter((o) => o.pages.length > 0),
              ],
    );
    /** 出している言語 (`CaptionLanguage.index`) */
    let captionLanguage = $state(1);
    /** 文字の配置。時刻の順 */
    const cues = $derived<Cue[]>(
        captionText === null
            ? []
            : captionLanguage === 1
              ? captionText.pages
              : (captionText.others?.find((o) => o.index === captionLanguage)?.pages ?? captionText.pages),
    );
    const hasCaptions = $derived(
        captionText !== null &&
            (captionText.pages.length > 0 || (captionText.others ?? []).some((o) => o.pages.length > 0)),
    );
    /** 文字の配置を描く係 (`overlay` ができたら作る) */
    let painter: CaptionPainter | null = null;
    /** いま描いている文字の配置。同じものを描き直さない */
    let shownPage: CaptionPage | null = null;
    $effect(() => {
        if (overlay === null) return;
        const made = new CaptionPainter(overlay, denpaFontUrl());
        painter = made;
        return () => {
            made.close();
            if (painter === made) painter = null;
        };
    });
    /** 重ねる先 (`/live` と同じやり方。`server/captions.ts`) */
    let overlay = $state<HTMLCanvasElement | null>(null);
    /** 貼り直しを追わせている映像。二重に回さないための目印 (`follow`) */
    let following: HTMLVideoElement | null = null;
    /** 読めなかったとき。**黙って黒いままにしない** */
    let broken = $state(false);
    /**
     * 読み込み待ちで止まっているか。**輪を出す。**
     *
     * 出さないと、映像が止まったのが**詰まりなのか壊れたのか分かりません**。
     * 飛んだ直後や回線が細いときは数秒待つことがある
     */
    let buffering = $state(false);
    let bufferTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * 輪を出すまでの間 (ms)。**短い詰まりでは出さない。**
     *
     * コマ落ち程度の詰まりは毎回起きるので、その都度出すと**輪が点滅する**
     * だけになる。待たされていると人が思いはじめるあたりに置く
     */
    const BUFFER_NOTICE = 400;
    /**
     * 繋ぎが切れて繋ぎ直している最中か。**サーバの入れ替え (デプロイ) 用。**
     *
     * コンテナごと作り直すので、観ている最中に配信が切れる。何もしないと**そこで
     * 止まったまま**で、自分で開き直して位置を探し直すことになっていた
     */
    let resuming = $state(false);
    /** 続けて何回繋ぎ直したか。**諦める分かれ目** */
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    /** 繋ぎ直したあとに戻る位置 (秒)。0 は「戻る先は無い」 */
    let retryAt = 0;
    let chapters = $state<Chapter[]>([]);

    /** 操作列の出し入れ ([controls.svelte.ts](../../../lib/components/player/controls.svelte.ts))。ライブと同じ */
    const controls = playerControls();

    /**
     * 画面を落とさせない ([awake.svelte.ts](../../../lib/components/player/awake.svelte.ts))。
     * **開いている間はずっと** — 観るためだけに開く画面なので、止めて読んでいる間も
     */
    const awake = screenAwake();
    $effect(() => {
        awake.on = true;
    });

    /**
     * 小窓 (PiP。[pip.svelte.ts](../../../lib/components/player/pip.svelte.ts))。
     *
     * **互換モードの映像は canvas のプレイヤーからストリームを取って出す** (ライブ・追っかけと同じ方法。`raw`/`capture`)。
     * 小窓で押された止める・再開は `paused`/`toggle` で合わせる — `<video>` で観ているときもこの経路で
     * 同じに効く (`paused` は位置を持っている側に聞く。`playing` を読むのは、操作バーで止めた・再開したときに
     * 小窓の側も合わせ直させるため)
     */
    const pip = pictureInPicture({
        video: () => video,
        raw: () => drawing,
        capture: () => canvas?.pipStream() ?? null,
        flow: (on) => canvas?.pipFlow(on),
        paused: () => {
            void playing;
            return mediaPaused();
        },
        toggle: togglePlay,
        auto: () => background.on,
        overlay: () => overlay,
        captions: () => captions && hasCaptions,
    });

    // canvas の音を「再生する音」と言うのは、バックグラウンド再生を入れているときと小窓を開いている間だけ (`raw/engine.ts`)
    $effect(() => {
        const on = background.on || pip.active;
        if (drawing) canvas?.background(on);
    });

    /** バックグラウンド再生 ([background.svelte.ts](../../../lib/components/player/background.svelte.ts))。既定は切で、裏に回ったら止め、戻ったら止めた所から */
    const background = backgroundPlayback({
        pip: () => pip.active,
        paused: mediaPaused,
        pause: pauseMedia,
        resume: playMedia,
    });

    /** アンビエントモード ([ambient.svelte.ts](../../../lib/components/player/ambient.svelte.ts))。canvas に描いているときはプレイヤーから縮めた1枚をもらう */
    const ambient = ambientMode({
        playing: () => playing,
        canvas: () => canvas,
        video: () => video,
    });

    /**
     * 早送りの速さ。**ライブの追っかけと同じ並び** (`ts/pacing` の `SPEEDS`)。
     * 録画は放送より先が無いという縛りが無いので、いつでも選べる。
     *
     * **選んだ値は覚える。** 倍速で観る人はたいてい次も倍速で、開くたびに
     * 選び直すことになる。覚えるのは端末ごと (`localStorage`) — 同じ人でも
     * 手元の端末と居間のテレビで好みが違う。続きの位置 (`resume_ms`) を
     * サーバに置いているのとは逆の理由
     */
    let speed = $state(1);

    /**
     * CM を自動で飛ばすか。**切っていない録画のためのもの。**
     *
     * エンコードするときに CM を落とす設定にしていれば要らないが、判定を当てにせず
     * 残してエンコードしている場合 (既定はチャプターを入れるだけ) は、観るたびに
     * 送りのボタンを押すことになる。
     *
     * **端末ごとに覚える** (速さと同じ理由。`speed` の項)。
     * **観はじめに入れるかどうかは `skipCmAtStart`** — 既定は入で、ロゴでの
     * 判定に失敗した1本だけは覚えていても切って始める (理由と試験はあちら)
     */
    const SKIP_CM_KEY = 'watch-skip-cm';
    let skipCm = $state(false);
    /** CM を飛ばしたことを短く言う。黙って飛ぶと壊れたように見える */
    let skipped = $state(false);
    let skipNotice: ReturnType<typeof setTimeout> | null = null;
    /**
     * **跨いでいる間、最後の本編のコマで蓋をする面。**
     *
     * 先読み (`CM_LEAD`) だけでは 0コマにできません。`requestVideoFrameCallback`
     * は**映したあと**に来るうえ、ブラウザは先のコマを何枚かコンポジタへ渡し終えて
     * いるので、そこで位置を変えても**渡し済みのぶんは出てしまいます**。
     * 実機で見えていた「一瞬の CM」はこれです。
     *
     * 予測で消せない以上、**隠します。** 飛ぶ直前のコマを写して被せ、飛んだ先が
     * 映ってから外す。黒で塗らないのは、**止まったコマのほうが飛んだように見える**ため
     * (黒を挟むと切れたように見える)
     */
    let cover = $state<HTMLCanvasElement | null>(null);
    /** 蓋をしているか */
    let hopping = $state(false);
    /**
     * 飛んだ先が映るのを待っているか。**`hopping` とは別**。
     *
     * 開いた直後は「飛ぶかどうかまだ分からない」ので、蓋だけ先に出して
     * (`hopping`) チャプターを待ちます。そのとき飛ぶ判断は**まだしていない**ので、
     * 蓋があることを理由に `hopCm` を止めてはいけない
     */
    let waiting = false;
    /**
     * 蓋が黒塗りか (写したコマではないか)。
     *
     * **写すのは本編のコマだけ。** CM の中で蓋をすると、写したものがそのまま
     * CM の1コマになる — 開いた直後 (本編前の CM) がまさにそれで、
     * 蓋をしているのに CM が見えていた
     */
    let blanked = false;
    /** 飛んだ先 (秒)。ここまで来たら蓋を外す */
    let hopTo = 0;
    /** 飛んだ先に着いたと数えたコマ数。`SETTLED` まで数えてから蓋を外す */
    let settled = 0;
    /**
     * 蓋を外すまでに待つコマ数。
     *
     * **1コマでは早すぎます。** `requestVideoFrameCallback` は「コンポジタへ渡した」
     * ところで呼ばれるもので、渡したコマが画面に出るのはその先です
     * (`expectedDisplayTime` が未来を指しているのはそのため)。さらに Windows の
     * Chrome / Edge は**映像を DOM とは別の面 (DirectComposition の overlay) に
     * 出す**ので、蓋を外す DOM の更新のほうが**映像の面より先に画面へ出ます**。
     *
     * 実機 (Windows Chrome・1.25倍) では、位置も章も本編に入っているのに
     * **画面だけ CM のまま**という画面が撮れていました。数コマ余分に待てば消えます。
     * そのぶん本編の頭が静止画になりますが、4コマ (30コマ/秒で 0.13秒) なので
     * 飛んだ間合いに紛れます。
     *
     * `mediaTime` を持たないブラウザ (古い Firefox) では `currentTime` で数えます。
     * あちらは位置を代入した時点で飛んだ先を返すので、なおさら1コマでは足りない
     */
    const SETTLED = 4;
    /** 蓋の外し忘れ止め。飛んだ先が来ないまま止まっても、いつかは外す */
    let hopGiveUp: ReturnType<typeof setTimeout> | null = null;
    /** 蓋をしておく上限 (ms)。読み込みが詰まっても止まったコマのまま居座らせない */
    const HOP_GIVE_UP = 2_000;

    /** どこまで観たかを書き送る間隔 (ms)。**細かく送るものではない** */
    const REMEMBER = 15_000;
    /** 続きから出したか。出したことを画面にも言う (黙って途中から始まると驚く) */
    let continued = $state(false);

    /** 押し間違い防止に2回押させる。挙動は3画面共通 ([arming.svelte.ts](../../../lib/arming.svelte.ts)) */
    const deleting = arming('[data-testid^="watch-delete"]');

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
        // 前に選んだ速さで始める。覚えるのは端末ごと
        setSpeed(storedSpeed(), false);
        skipCm = skipCmAtStart(rec.cm_note, stored(SKIP_CM_KEY));
        // **チャプターが来るまで蓋をしておく。** 頭が CM のことが多く、
        // 取得している間そのまま流れていた (`settle`)
        if (skipCm) shut();
        void loadChapters().then(() => {
            chaptersReady = true;
            settle();
        });
        void detail.open(rec.program_id, facts);
        // 字幕は消していても取ってくる (持っているかどうかで ⚙ の字幕の行と字幕ボタンを出す)。持っていない録画では何も起きない
        captions = storedCaptionsOn(stored(CAPTION_ON_KEY));
        void loadCaptions();
        if (video !== null) follow(video);
        if (!ready) return;
        video?.play().catch(() => undefined);
        // 指のときは最初から全画面。テレビと同じで、観るために置いてある画面なので
        // iPhone では枠を広げる (`fullscreen.svelte.ts`) — 押した勢いが要らないので読み込み直しても入る。
        // 画面の幅では決めない — 狭い窓で開いた PC まで全画面になる
        if (window.matchMedia('(pointer: coarse)').matches) fullscreen.enter();
        // 枠が変われば重ねる場所も変わる (全画面・持ち替え・窓の伸び縮み)
        const onResize = () => place();
        window.addEventListener('resize', onResize);
        /*
         * **閉じ際にも書き送る。** 15秒おきの控えだけだと、最後に観た十数秒が
         * 落ちる。`pagehide` は畳んだ・戻った・落ちた、のどれでも来る (`unload` は
         * スマホで来ないことがある)
         */
        const onLeave = () => remember(true);
        window.addEventListener('pagehide', onLeave);
        const ticker = setInterval(() => {
            if (playing) remember();
        }, REMEMBER);
        return () => {
            window.removeEventListener('resize', onResize);
            window.removeEventListener('pagehide', onLeave);
            // 貼り直しの追いかけを畳む。外さないと画面を離れたあとも回り続ける
            following = null;
            clearInterval(ticker);
            remember(true);
            deleting.fire();
            if (skipNotice !== null) clearTimeout(skipNotice);
            if (hopGiveUp !== null) clearTimeout(hopGiveUp);
            if (bufferTimer !== null) clearTimeout(bufferTimer);
            if (retryTimer !== null) clearTimeout(retryTimer);
        };
    });

    /*
     * **音声トラックは後から増えることがある。** ブラウザによっては
     * `loadedmetadata` の時点ではまだ出そろっておらず、最初のフレームを
     * デコードしたあとで `addtrack` してくる。並びが変わったら読み直す
     */
    $effect(() => {
        const tracks = audioTrackList();
        if (tracks === null) return;
        const update = (): void => syncAudio();
        tracks.addEventListener('addtrack', update);
        tracks.addEventListener('removetrack', update);
        tracks.addEventListener('change', update);
        return () => {
            tracks.removeEventListener('addtrack', update);
            tracks.removeEventListener('removetrack', update);
            tracks.removeEventListener('change', update);
        };
    });

    /**
     * **どこまで観たかを覚える。** 覚えるかどうかの判断は `ts/watch.ts` が持つ
     * (サーバも同じものを見る)。送り方は追っかけと共通 (`#lib/resume.ts`)
     */
    function remember(leaving = false): void {
        if (!ready) return;
        if (canvas !== null) {
            keepResume(rec.id, canvas.currentTime, length, info?.axis, leaving);
            return;
        }
        if (video === null) return;
        keepResume(rec.id, video.currentTime, video.duration, info?.axis, leaving);
    }

    /**
     * **末尾まで来たことを、その場で覚える** (`onended`)。
     *
     * 位置の控えは 15秒 おきで、しかも**流れている間だけ**書きます。ふつうに
     * 末尾まで観たときは終わり際の控えが末尾の近くになるので、サーバが
     * 「観終えた」と読んで目印を消します (`ts/watch.ts` の `resumePoint`)。
     *
     * **末尾が CM だと、そこへ届きません。** 自動で飛ばすと、最後の控え
     * (CM に入る手前) から一足飛びに終端へ行き、着いた時点で流れていないので
     * 次の控えが書かれない。一覧では**観かけのまま**残っていました (実機。
     * 最後の CM が 3分40秒 の録画で「残り4分」のまま)。
     *
     * `onended` は引数を持つ (`Event`) ので、`remember` を直に渡すと
     * **`leaving` にイベントが入って真になります**。包んで渡す
     */
    function finished(): void {
        remember();
    }

    /**
     * **観ていたところから出す。**
     *
     * 尺が分かってから動かす (`loadedmetadata`)。**1回だけ** — 飛んだあとに
     * もう一度来ると、観ている最中に引き戻されることになる
     */
    let resumed = false;
    function resume(): void {
        length = video?.duration ?? 0;
        place();
        // **速さを掛け直す。** 読み込むもの (src) が変わるとブラウザは 1 に戻す —
        // 端末のコピーへ差し替えたときに、選んであった速さが黙って外れていた
        if (video !== null && speed !== 1) video.playbackRate = speed;
        // 繋ぎが切れて読み直したところ。**観ていた位置へ戻して続ける** (`recover`)
        if (retryAt > 0 && video !== null) {
            video.currentTime = retryAt;
            retryAt = 0;
            void video.play().catch(() => undefined);
            return;
        }
        if (resumed || video === null) return;
        resumed = true;
        const at = rec.resume_ms === null ? null : rec.resume_ms / 1000;
        if (at !== null && resumePoint(at, video.duration) !== null) {
            video.currentTime = at;
            showContinued();
        }
        settle();
    }

    /**
     * `video.audioTracks` を読める形にする。**標準の DOM 型に無いので自前で受ける** —
     * `HTMLMediaElement.audioTracks` は仕様にはあるがブラウザ実装が揃っておらず、
     * TypeScript の既定の型にも入っていない。無ければ `null`
     */
    interface AudioTrackLike {
        label: string;
        language: string;
        enabled: boolean;
    }
    interface AudioTrackListLike {
        readonly length: number;
        [index: number]: AudioTrackLike;
        addEventListener(type: string, listener: () => void): void;
        removeEventListener(type: string, listener: () => void): void;
    }
    function audioTrackList(): AudioTrackListLike | null {
        return (video as unknown as { audioTracks?: AudioTrackListLike } | null)?.audioTracks ?? null;
    }

    /** トラックの見出し。コンテナに入っている名前 (主音声/副音声) → 言語 → 連番の順で選ぶ */
    function audioLabel(track: AudioTrackLike, i: number): string {
        const name = track.label.trim();
        if (name !== '') return name;
        const lang = track.language.trim();
        if (lang !== '') return lang;
        return `音声 ${i + 1}`;
    }

    /** いま `<video>` が持っている音声トラックを読み直す (`loadedmetadata` と `addtrack` から) */
    function syncAudio(): void {
        /*
         * **その場で流しているときは、`playback` の音声の名前から並べる。** 流しているのは
         * 選んだ1本だけなので、`audioTracks` には1本しか出ない (`remux-player.ts`)
         */
        // 端末に保存した録画を canvas に描いているなら、そのトラックの名前 (名前 → 言語 → 連番。`<video>` から読むときと同じ)
        if (localMkv !== null) {
            audios = localMkv.audios.map((track, i) => ({
                label: audioLabel({ label: track.name, language: track.language, enabled: false }, i),
            }));
            return;
        }
        if (picked?.way === 'stream' || canvas !== null) {
            audios = (info?.audios ?? []).map((audio, i) => ({ label: audio.label.trim() || `音声 ${i + 1}` }));
            return;
        }
        const tracks = audioTrackList();
        if (tracks === null) {
            /*
             * **ブラウザが入れ物の音声を出さない** (Chrome・Firefox の既定)。流すほうへ移れるなら
             * `playback` の名前で並べ、選んだら移る (`selectAudio`)。移れなければ出さない
             */
            audios =
                audioFallback() === null
                    ? []
                    : (info?.audios ?? []).map((audio, i) => ({ label: audio.label.trim() || `音声 ${i + 1}` }));
            return;
        }
        const list: { label: string }[] = [];
        let enabled = 0;
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            if (track === undefined) continue;
            list.push({ label: audioLabel(track, i) });
            if (track.enabled) enabled = i;
        }
        audios = list;
        audioIndex = enabled;
    }

    /** 音声を選ぶ。**選んだものだけ有効にする** (ブラウザはそれで切り替える)。その場で流しているならリクエストし直す */
    function selectAudio(index: number): void {
        const player = remux ?? canvas;
        if (player !== null) {
            player.setAudio(streamAudio(index));
            audioIndex = index;
            return;
        }
        const tracks = audioTrackList();
        if (tracks === null) {
            moveForAudio(index);
            return;
        }
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            if (track !== undefined) track.enabled = i === index;
        }
        audioIndex = index;
    }

    /** 音声を選ぶために移る先 (`streamForAudio`)。ファイルをそのまま読んでいないなら null */
    function audioFallback(): Picked | null {
        if (info === null || picked?.way !== 'file') return null;
        return streamForAudio(info, ability(), picked.codec);
    }

    /**
     * **ファイルのままでは選べない音声を、その場で流すほうへ移って選ぶ。** いまの位置から観直す
     * (`chooseCodec` と同じ作り直し)。いまの音声 (ファイルでは1本目) を選んだだけなら何もしない
     */
    function moveForAudio(index: number): void {
        if (index === audioIndex) return;
        const fresh = audioFallback();
        if (fresh === null) return;
        const position = video?.currentTime ?? 0;
        // 端末のコピーはそのまま読むときだけ (`chooseCodec` と同じ)
        if (localSrc !== null) {
            URL.revokeObjectURL(localSrc);
            localSrc = null;
        }
        busy = false;
        broken = false;
        audioIndex = index;
        retryAt = position;
        switchAt = position;
        picked = fresh;
    }

    /**
     * チャプターの位置。**エンコードしたものから読む** (`api/recordings/<id>/chapters`)。
     *
     * CM はチャプターとして入っているので、そのまま**CM飛ばし**になる。
     * 無い録画もある (CMを切ってエンコードしたもの・検出が当たらなかったもの) ので、
     * 取れなければ送りのボタンを出さないだけ
     */
    async function loadChapters(): Promise<void> {
        try {
            // 端末に保存したものがあればそちら (オフラインでもCM飛ばしが効く)。探し終えるのを待ってから
            const copy = await localLookup;
            const held = copy?.chapters as { chapters?: typeof chapters } | undefined;
            if (held?.chapters !== undefined) {
                chapters = held.chapters;
                return;
            }
            const res = await fetch(resolve(`api/recordings/${rec.id}/chapters`));
            if (!res.ok) return;
            chapters = (await res.json()).chapters ?? [];
        } catch {
            // 出せないだけ。観るのに支障は無い
        }
    }

    /**
     * 配信が切れたら繋ぎ直す。**サーバの入れ替え (デプロイ) で切れるため。**
     *
     * `<video>` はファイルを少しずつ取りに来ているので、途中で接続先が消えると
     * そこで止まる。**同じ所から読み直して、観ていた位置へ戻す** — 開き直しでは
     * ないので、覚えている続きの位置 (15秒おき) ではなく、切れた瞬間の位置。
     *
     * **理由を見て決める。** 読めない形式・壊れたファイルは何度やっても同じで、
     * そちらは今までどおり観られる先の案内を出す (`broken`)。繋ぎ直すのは繋ぎが切れた
     * ときだけ
     */
    function recover(): void {
        if (video === null) return;
        const code = video.error?.code ?? 0;
        // その場で流しているときの切れ目は `remux-player.ts` が繋ぎ直す。ここに来るのは読めない中身
        if (remux !== null || code !== MediaError.MEDIA_ERR_NETWORK || retries >= STREAM_RETRIES) {
            broken = true;
            resuming = false;
            return;
        }
        retryAt = video.currentTime;
        const wait = retryWait(retries);
        retries++;
        resuming = true;
        if (retryTimer !== null) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
            retryTimer = null;
            // 同じ src を読み直す。位置を戻すのは尺が分かってから (`resume`)
            video?.load();
        }, wait);
    }

    /**
     * 早送りの速さを変える。**音は残す** — ブラウザは倍速でも音程を保つので、
     * 消してしまうと早く観たいだけの人が黙って観ることになる
     */
    function setSpeed(value: number, remember = true): void {
        // canvas に描いているときは等速だけ (音を自前で鳴らしている。メニューも出さない)
        if (drawing) return;
        speed = value;
        if (video !== null) video.playbackRate = value;
        if (remember) remind(SPEED_KEY, String(value));
        controls.stir();
    }

    /**
     * CM飛ばしのオン/オフ。切り替えた時点で、いま CM の中にいれば飛ぶ —
     * 「CMが始まったから押した」がいちばん多い押し方なので
     */
    function toggleSkipCm(): void {
        skipCm = !skipCm;
        remind(SKIP_CM_KEY, skipCm ? '1' : '0');
        if (skipCm) hopCm();
        controls.stir();
    }

    /**
     * CM を跨ぐ**手前**で飛ぶための先読み (秒)。
     *
     * 30コマ/秒で3コマぶん。**入ってから飛ぶと必ず CM のコマが見えます** —
     * 画面は飛ぶまで今のコマを出し続けるので、気付くのが1コマ遅れれば1コマ映る。
     *
     * **コンポジタに渡し済みのコマぶんを見込んで取る。** ブラウザは先のコマを
     * 何枚か渡し終えているので、蓋 (`cover`) を出しても効くのは次の合成から。
     * 1コマぶんの先読みでは間に合わない。本編の末尾 0.1 秒が静止画になるが、
     * 境目は場面の切れ目なので分からない
     */
    const CM_LEAD = 0.1;

    /**
     * CM の中にいたら、その終わりまで飛ぶ。**判断は `ts/watch.ts` が持つ。**
     *
     * 続いている CM はまとめて跨ぐので、15秒ごとに何度も飛ぶことはない
     */
    function hopCm(): void {
        // 飛んだ先を待っている最中。着くまでは何もしない
        if (waiting || !skipCm || (video === null && canvas === null)) return;
        const to = skipTarget(chapters, mediaTime(), CM_LEAD);
        if (to === null) return;
        /*
         * **canvas は蓋をしない。** プレイヤーは飛び先より前のフレームを描かずに捨て、描けるまで前のフレーム (本編の
         * 最後のコマ) を出したままにする (`raw/worker.ts` の `floor`)。字幕だけ消しておく
         */
        if (canvas === null) shut();
        else clearCaptions();
        hopTo = to;
        waiting = true;
        seekMedia(to);
        // **続きから始めたばかりなら、そちらだけ言う。** 通知は列に積むので重なりはしないが、
        // 観る人にとって起きたのは「続きから始まった」こと (CM を跨いだのは中の都合)
        if (continued) return;
        skipped = true;
        if (skipNotice !== null) clearTimeout(skipNotice);
        skipNotice = setTimeout(() => (skipped = false), 2500);
    }

    /**
     * いま映っているコマを写して蓋をする。**飛ぶ前に呼ぶ。**
     *
     * **本編にいるときだけ写します。** CM の中で写すと、蓋そのものが CM の
     * 1コマになる。チャプターがまだ来ていないときも同じ扱い (中身が分からない)。
     * 写せないときは黒で塗って、映像の枠ごと覆う。
     *
     * 字幕も一緒に消す。CM の字幕が蓋の外に出ては意味がない
     */
    function shut(): void {
        const here = video === null ? null : chapterAt(chapters, video.currentTime);
        const shot = video !== null && here !== null && !isCm(here.title) && video.videoWidth > 0;
        const ctx = cover?.getContext('2d') ?? null;
        if (cover !== null && ctx !== null) {
            cover.width = shot ? (video as HTMLVideoElement).videoWidth : 16;
            cover.height = shot ? (video as HTMLVideoElement).videoHeight : 9;
            if (shot) {
                try {
                    ctx.drawImage(video as HTMLVideoElement, 0, 0, cover.width, cover.height);
                } catch {
                    // 写せなかった。黒いままなので、下は見えない
                }
            } else {
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, cover.width, cover.height);
            }
        }
        blanked = !shot;
        hopping = true;
        clearCaptions();
        place();
        if (hopGiveUp !== null) clearTimeout(hopGiveUp);
        hopGiveUp = setTimeout(open, HOP_GIVE_UP);
    }

    /** 蓋を外す。飛んだ先が映ったとき (`follow`) と、待ちくたびれたとき */
    function open(): void {
        hopping = false;
        waiting = false;
        settled = 0;
        if (hopGiveUp !== null) {
            clearTimeout(hopGiveUp);
            hopGiveUp = null;
        }
    }

    /**
     * **観はじめの1回。** チャプターが揃ってから、始まりが CM なら飛ぶ。
     *
     * 開いた時点では**チャプターをまだ取れていません** (別に取得するため)。
     * 何もしないと、取れるまでの間だけ**本編前の CM がそのまま流れます** —
     * 実機で見えていた「一瞬の CM」はこれでした。取得している間は
     * 黒い蓋をしておいて、揃ってから飛ぶ・飛ばないを決める
     *
     * **始める位置 (続きか頭か) が決まるのも待ちます** (`resume`)。チャプターが先に
     * 揃うと頭 (0秒) で見てしまい、録画の頭の CM を飛んでから続きへ移っていた —
     * リロードのたびに「CMを飛ばしました」が出ていたのはこれ。両方から呼び、遅いほうで決める
     */
    let chaptersReady = false;
    function settle(): void {
        if (!chaptersReady || !resumed) return;
        hopCm();
        // 飛ばなかった (CM ではなかった・切ってある)。蓋は要らない
        if (!waiting) open();
    }

    function togglePlay(): void {
        if (mediaPaused()) playMedia();
        else pauseMedia();
    }

    /**
     * 字幕の出し入れ。**canvas に描いて重ねる** — ライブ (`/live`) と同じやり方 (`caption-draw.ts`)。
     *
     * 文字を `<track>` に渡す方法は**放送どおりには出ない** — 左右の位置も、背景の箱も、
     * 外字も落ちる。放送が言う置き場所のまま描く
     */
    function toggleCaptions(): void {
        setCaptions(!captions);
        controls.stir();
    }

    /** 字幕を出す・消す。端末ごとに覚える (`caption-pref.ts`) */
    function setCaptions(on: boolean): void {
        captions = on;
        remind(CAPTION_ON_KEY, on ? '1' : '0');
        if (on) {
            void loadCaptions();
            paint();
        } else {
            clearCaptions();
        }
    }

    /** 字幕の言語を選ぶ。言語の名前 (ISO 639) で端末に覚える (`caption-pref.ts`) */
    function setCaptionLanguage(index: number): void {
        const code = captionLanguages.find((l) => l.index === index)?.code ?? '';
        if (code !== '') remind(CAPTION_LANGUAGE_KEY, code);
        captionLanguage = index;
        clearCaptions();
        paint();
    }

    /**
     * 字幕を取ってくる。**既定で出すので、開いた時点で取得する**
     * (`onMount`)。一度読めていれば読み直さない。
     *
     * 端末に保存したものがあればそちらから読む (オフラインでも字幕が出る)
     */
    async function loadCaptions(): Promise<void> {
        if (captionText !== null) return;
        try {
            // 端末に保存したものがあればそちら。**字幕を持たない番組は 404** (ボタンを出さないだけで、異常ではない)
            const copy = await localLookup;
            const text =
                copy !== null
                    ? (copy.captionText as CaptionPages | undefined)
                    : await fetch(resolve(`api/recordings/${rec.id}/captions.json`)).then((res) =>
                          res.ok ? (res.json() as Promise<CaptionPages>) : undefined,
                      );
            if (text?.v === CAPTION_TEXT_VERSION) {
                captionText = text;
                // 覚えている言語が載っていればそれ、無ければ第1言語
                captionLanguage = pickLanguage(captionLanguages, stored(CAPTION_LANGUAGE_KEY));
                paint();
            }
        } catch (error) {
            // 出せないだけ。観るのに支障は無い
            console.warn('[captions] 取れませんでした', error);
        }
    }

    /** 詰まった。**少し待ってから**輪を出す */
    function stall(): void {
        // CM を跨いでいる間は蓋がある。そちらに任せる
        if (hopping || bufferTimer !== null || buffering) return;
        bufferTimer = setTimeout(() => {
            bufferTimer = null;
            buffering = true;
        }, BUFFER_NOTICE);
    }

    /** 動き出した。輪を引っ込める */
    function flowing(): void {
        if (bufferTimer !== null) {
            clearTimeout(bufferTimer);
            bufferTimer = null;
        }
        if (buffering) buffering = false;
    }

    function clearCaptions(): void {
        shownPage = null;
        painter?.show(null);
    }

    /**
     * **字幕の貼り直しと CM の跨ぎを、映した1枚ごとに追わせる**
     * ([frames.ts](../../../lib/components/player/frames.ts))。ライブと同じ作り
     * (`live-player` の `follow`)。
     *
     * `timeupdate` だけで貼り直していた頃は、**字幕が 0.1 秒ほど遅れて見えて**
     * いました (あちらは 250ms ごとにしか来ない)。
     *
     * `paint` は出すものが変わっていなければその場で戻るので、空回りは安い
     */
    function follow(target: HTMLVideoElement): void {
        if (following === target) return;
        following = target;
        eachFrame(target, (meta) => {
            // 別の映像に移った (画面を閉じた) ら、こちらは畳む
            if (following !== target) return false;
            /*
             * **映したコマの時刻で外す。** `currentTime` では早すぎます —
             * 位置を代入した時点で `currentTime` は**飛んだ先を返す**のに
             * (仕様どおり)、画面にはまだ手前のコマが出ています。それで外して
             * いたので、蓋を出しても CM の尻が1コマ見えていた。
             * `requestVideoFrameCallback` の `mediaTime` は**いま映した**コマの
             * 時刻なので、これが飛んだ先を越えるまで待つ
             */
            if (waiting) {
                const there = !target.seeking && (meta?.mediaTime ?? target.currentTime) >= hopTo;
                if (!there) settled = 0;
                else if (++settled >= SETTLED) open();
            }
            paint();
            // **CM の跨ぎもここで見ます。** `timeupdate` (250ms) 任せだった頃は、
            // 気付くまでの 7コマぶん (30コマ/秒) CM が見えていた
            hopCm();
            return true;
        });
    }

    /**
     * 字幕と CM の蓋を**映像が出ているところ**にぴったり重ねる (`fitRect`)
     */
    function place(): void {
        if (video === null) return;
        // canvas に描いているときは `<video>` は空なので、放送の 16:9 とみなす (プレイヤーは映像の縦横比のまま描く)
        const [width, height] = drawing ? [16, 9] : [video.videoWidth, video.videoHeight];
        const rect = fitRect(video.clientWidth, video.clientHeight, width, height);
        /*
         * 字幕も CM の蓋も、映像と同じ場所・同じ大きさに置く。**画面の画素の境目に揃える** —
         * 端数の位置に置くと、字幕の canvas が半画素ずれて描かれ、字の縁が滲む。
         * 端は外へ丸める (CM の蓋が映像の縁を1画素も残さず覆うように)
         */
        const dpr = window.devicePixelRatio || 1;
        const left = Math.floor((video.offsetLeft + rect.left) * dpr) / dpr;
        const top = Math.floor((video.offsetTop + rect.top) * dpr) / dpr;
        const right = Math.ceil((video.offsetLeft + rect.left + rect.width) * dpr) / dpr;
        const bottom = Math.ceil((video.offsetTop + rect.top + rect.height) * dpr) / dpr;
        for (const layer of [overlay, cover]) {
            if (layer === null) continue;
            layer.style.left = `${left}px`;
            layer.style.top = `${top}px`;
            layer.style.width = `${right - left}px`;
            layer.style.height = `${bottom - top}px`;
        }
        // 黒塗りの蓋は枠ごと覆う。**まだ映像の大きさが分からない**ことがあるため
        // (開いた直後。`fitRect` は 0 を渡されると当てにならない)
        if (blanked && cover !== null) {
            cover.style.left = '0';
            cover.style.top = '0';
            cover.style.width = '100%';
            cover.style.height = '100%';
        }
    }

    /*
     * **全画面の出入りで測り直す** (本物でも広げたのでも)。枠が変わるので、描き
     * 終わってから。iPhone で広げたときは窓の `resize` が来ないので、ここで受け取る
     */
    $effect(() => {
        void fullscreen.active;
        const frame = requestAnimationFrame(place);
        return () => cancelAnimationFrame(frame);
    });
    /*
     * **映像の箱が変わったら測り直す。** 窓の `resize` も全画面の出入りも無しに変わる
     * ことがある — スマホの縦は操作バーを映像の下に出す (`PlayerStage` の `under`) ので、
     * 枠の形が開いた直後に一度変わる
     */
    $effect(() => {
        const target = video;
        if (target === null) return;
        const watcher = new ResizeObserver(() => place());
        watcher.observe(target);
        return () => watcher.disconnect();
    });

    /**
     * いまの位置に合う1枚を重ねる。**変わったときだけ描く。**
     * canvas の箱は `place` が映像に合わせ、中の座標は `CaptionPainter` が放送の面から写す
     */
    function paint(): void {
        // 蓋の下。いま描くと CM の字幕を仕込むことになる
        if (hopping) return;
        if (!captions || overlay === null) return;
        // 描き方はライブと同じ (`caption-draw.ts`)
        const at = mediaTime();
        const page = captionShowing(currentCue(cues, at), at);
        if (page === shownPage) return;
        shownPage = page;
        place();
        painter?.show(page);
    }

    /** 秒で動かす。**端は超えさせない** (超えると勝手に終わる) */
    function seekBy(by: number): void {
        if (video === null && canvas === null) return;
        seekMedia(Math.min(Math.max(mediaTime() + by, 0), length || video?.duration || 0));
        controls.stir();
    }

    function seekTo(seconds: number | null): void {
        if ((video === null && canvas === null) || seconds === null) return;
        seekMedia(seconds);
        controls.stir();
    }

    /** 映像を押されたときの読み方は追っかけと同じ (`stage-tap.ts`) */
    const press = stageTap({ toggle: togglePlay, controls: () => controls.toggle(), seekBy });

    /**
     * キーでも動かせるようにする。全画面のときはこれがいちばん早い。
     * **割り当ては追っかけと共通** (`player/keys.ts`。修飾キーの扱いもあちら)。
     * データ放送を出している間の十字キーはあちらのカーソル (`DataBroadcast`) なので、送りには使わない
     */
    const playerKey = playerKeys({
        togglePlay,
        seekBy,
        toggleCaptions,
        snapshot: () => void snapshot(),
        toggleFull: fullscreen.toggle,
        stepSpeed: (by) => setSpeed(stepSpeed(speed, by)),
        toggleMute,
    });
    function keys(event: KeyboardEvent): void {
        if (showData && event.key.startsWith('Arrow')) return;
        playerKey(event);
    }

    const current = $derived(chapterAt(chapters, at));
    /** CM の入っている録画でだけ、飛ばすボタンを出す (押しても何も起きない操作を並べない) */
    const hasCm = $derived(chapters.some((chapter) => isCm(chapter.title)));
    /** シークバーで琥珀に塗る CM の区間と、それ以外の切れ目 */
    const cmOnBar = $derived(cmSpans(chapters));
    const marksOnBar = $derived(plainMarks(chapters));

    /**
     * あと何分で終わるか。**倍速のぶんは割る** — 2倍で観ているときに
     * 「残り30分」と出ても、掛かるのは15分なので当てにならない
     */
    const remaining = $derived(Math.max(0, (length - at) / (drawing ? 1 : speed || 1)));

    /**
     * 右に出す中身。**録画の行が持っているぶんだけ**で組み立てる (追っかけと同じ `recordingFacts`)。
     *
     * 出演者などは番組表の側にあり、24時間で消える。引けるうちは開いた時点で
     * 引き直す (`onMount`)。引けなければ行のぶんだけが出たままになる
     */
    const facts = $derived(recordingFacts(rec));

    /** 切り抜きの結果。**貼れたかどうかは言う** (黙って何も起きないと分からない) */
    const shooter = snapshotter(controls);

    /**
     * **録画の再生中は選局できない。** データ放送が「この局へ」と言ってきたら (epgTune)、文書には失敗を
     * 返し (`DataBroadcast` の tune)、観ている人にはそう知らせる
     */
    let tuneRefused = $state<Notice | null>(null);
    function refuseTune(): boolean {
        tuneRefused = { key: `tune-${Date.now()}`, kind: 'info', text: '録画の再生中は選局できません' };
        return false;
    }

    /** 断られたときだけ知らせる。消せたときは一覧へ戻るので出す先が無い */
    const notices = $derived<Notice[]>([
        ...errorNotice(form, 'watch-delete'),
        ...shooter.notices,
        ...pip.notices,
        ...(tuneRefused === null ? [] : [tuneRefused]),
    ]);

    /**
     * いまの1コマを**字幕ごと**切り抜いて PNG に (`番組名_YYYYMMDD-HHMMSS.png`)。
     * 指の端末では共有シート、PC では落としてクリップボードにも置く。
     * 重ね方・渡し方は3画面共通 ([snapshot.ts](../../../lib/components/player/snapshot.ts))
     */
    function snapshot(): void {
        // 字幕を出しているときだけ重ねる
        const drawn = captions && shownPage !== null;
        // canvas に描いているときはプレイヤーから1枚もらう (`<video>` は空。ライブ・追っかけと同じ)
        void shooter.take(
            () => (canvas !== null ? grabbedFrame(canvas.grab()) : videoFrame(video)),
            drawn ? overlay : null,
            rec.name,
        );
    }
</script>

<svelte:head><title>{rec.name} - denpa</title></svelte:head>
<svelte:window onclick={deleting.stand} onkeydown={keys} />

<!-- **ライブ (`/live`) と同じレイアウト・同じ作り** (PlayerLayout)。映像が左、読むものが右 -->
<PlayerLayout testid="watch">
        {#if !ready}
            <!-- 録っている最中は load が追っかけへ送るので、ここに来るのはエンコード済みも元の TS も無い録画 -->
            <div class="panel stack not-ready">
                <h2>まだ観られません</h2>
                <p class="small muted">観られるファイルがありません。</p>
                {#if rec.encode_error}
                    <p class="small muted">{rec.encode_error}</p>
                {/if}
            </div>
        {:else}
            <!--
                舞台 (映像と操作をまとめた箱。全画面にするのはここ) は3画面で共通 (PlayerStage)。
                全画面はこちら側の癖 (開いた時点で入る) が要るので自前のまま
            -->
            <PlayerStage {controls} {fullscreen} {ambient} testid="watch-stage" bind:element={stage}>
                {#snippet children(layout)}
                <!--
                    **押すのは映像そのもの。** ボタンを避けて敷くのではなく、
                    ボタンを上に重ねる (z-index 10)。押したときの処理は自分で繋ぐ (`press` の effect)
                -->
                <!-- svelte-ignore a11y_media_has_caption -->
                <!--
                    **字幕は `<track>` ではない。** 文字を渡す方法は放送どおりには出ない
                    (左右の位置・背景の箱・外字が落ちる)。放送の置き場所のまま canvas に描いて
                    重ねる — ライブと同じやり方 (下の canvas)
                -->
                <!--
                    **映像の箱。データ放送はこれを小窓へ寄せる** (`DataBroadcast` の `placeVideo`)。ライブと同じ
                -->
                <div
                    bind:this={mediaBox}
                    style="position:absolute; inset:0; width:100%; height:100%;"
                >
                <video
                    bind:this={video}
                    {src}
                    style="width:100%; height:100%; background:#000;"
                    playsinline
                    onclick={press}
                    onplay={() => {
                        playing = true;
                        if (video !== null) follow(video);
                        // 出たので、繋ぎ直しは済み。次に切れたらまた1秒から待つ
                        retries = 0;
                        resuming = false;
                        controls.stir();
                    }}
                    onpause={() => {
                        playing = false;
                        // 止めたのは詰まりではない。輪は引っ込める
                        flowing();
                    }}
                    onended={finished}
                    onwaiting={stall}
                    onstalled={stall}
                    onseeking={stall}
                    onplaying={flowing}
                    oncanplay={flowing}
                    ontimeupdate={() => {
                        at = video?.currentTime ?? 0;
                        hopCm();
                        paint();
                        feedData();
                    }}
                    onseeked={feedData}
                    onloadstart={() => {
                        // **読み込みが始まった瞬間に速さを掛け直す。** src を入れ替えると
                        // (端末のコピーへの差し替え) ブラウザは playbackRate を 1 に戻す。
                        // metadata を待ってからでは、その間だけ選んだ速さが外れて見える
                        if (video !== null && speed !== 1) video.playbackRate = speed;
                    }}
                    onloadedmetadata={() => {
                        resume();
                        syncAudio();
                    }}
                    onvolumechange={() => (muted = video?.muted ?? false)}
                    onerror={recover}
                    data-testid="watch-video"
                >
                </video>
                <!--
                    **放送の字幕は映像と同じ箱の中に置く** (ライブの `MediaStack` と同じ)。
                    データ放送を出すと、この箱ごと BML の小窓へ寄せる。外に置いて
                    いた頃は**映像だけが小窓へ行き、字幕は枠いっぱいのまま**データ放送の面
                    (`z-index: 5`) の下に隠れていた。中にあれば、テレビと同じで映像と一緒に縮む。
                    位置と大きさは `place` が映像に合わせて style で書く。
                    **押す邪魔をしない** (`pointer-events: none`) — 下の映像を押して止められなくなる
                -->
                <canvas
                    bind:this={overlay}
                    style="position:absolute; pointer-events:none;"
                    data-testid="watch-captions-canvas"
                    data-on={captions && hasCaptions}
                    aria-hidden="true"
                ></canvas>
                <!--
                    **CM を跨ぐ間の蓋。** 字幕より後ろに置く = 字幕の上に載る
                    (CM の字幕まで隠すため)。操作バーや通知 (z-index 10) の下には残す。
                    字幕と同じ理由で箱の中に置く (小窓の中でも CM を隠す)。
                    出し入れは `hidden` のまま — style に式を書くと `hopping` が変わるたびに
                    属性ごと書き直され、`place` が JS で書いた位置と大きさが消える
                -->
                <canvas
                    bind:this={cover}
                    style="position:absolute; pointer-events:none;"
                    hidden={!hopping}
                    aria-hidden="true"
                ></canvas>
                </div>
                <!--
                    **録画のデータ放送。** エンコードするときに取り出した変化ログ (`data.hasData`) を、
                    再生位置に合わせて流す (`feedData`/`listenData`)。描くのはライブと同じエンジン。
                    双方向は録画では使わない (`network={false}`) — 送り先が生きていない
                -->
                <DataBroadcast
                    on={showData}
                    channel={dataChannel}
                    media={mediaBox}
                    listen={listenData}
                    bind:press={dataPress}
                    bind:pressD={dataButton}
                    postal={data.broadcast.postalCode}
                    prefecture={data.broadcast.prefecture}
                    network={false}
                    clock={() => rec.start_at + nowMs()}
                    tune={refuseTune}
                />

                {#if buffering && !resuming}
                    <!--
                        **読み込み待ち。** 映像が止まったのが詰まりなのか壊れたのか
                        分からないと、待てばいいのかどうかが決められない。
                        繋ぎ直しの最中はあちらが出るので、重ねない
                    -->
                    <div class="wait">
                        <span class="wait-box" aria-busy="true">読み込み中</span>
                    </div>
                {/if}

                {#if resuming}
                    <!--
                        **繋ぎ直しの最中は、そう言う。** サーバの入れ替えで
                        切れると数十秒帰ってこないので、黙って止まっていると
                        壊れたように見える
                    -->
                    <div class="wait">
                        <span class="wait-box" aria-busy="true">繋ぎ直しています</span>
                    </div>
                {/if}

                {#if busy}
                    <!--
                        **サーバが混んでいて、その場の変換を断られた** (同時に変換する本数の上限。設定の GPU)。
                        待っても空くとは限らないので、サーバに変換させずに観られるものを勧める
                    -->
                    <div class="broken" data-testid="watch-busy">
                        <p class="small">サーバが混んでいます</p>
                        {#if lighter.length > 0}
                            <div class="cluster">
                                {#each lighter as codec (codec)}
                                    <button
                                        type="button"
                                        class="small"
                                        data-testid="watch-busy-switch"
                                        onclick={() => chooseCodec(codec)}
                                    >
                                        {codecLabel(codec)} で観る
                                    </button>
                                {/each}
                            </div>
                        {:else}
                            <p class="small">しばらくしてから開き直してください</p>
                        {/if}
                    </div>
                {:else if canvasProblem !== null}
                    <!--
                        **互換モードで観られない。理由を出して止まる** (`<video>` には戻らない。ライブと同じ)。
                        ほかのブラウザを勧めない — 互換モードは `<video>` が止まる端末のためのもの
                    -->
                    <div class="broken" data-testid="watch-broken">
                        <p class="small">{canvasProblem}</p>
                    </div>
                {:else if broken}
                    <!-- **黙って黒いままにしない。** 観られる先を案内する (外のプレイヤーは相手にしない) -->
                    <div class="broken" data-testid="watch-broken">
                        <p class="small">
                            このブラウザでは再生できませんでした。<br
                            />Chrome・Edge か、テレビのアプリ (denpa-tv) で観てください。
                        </p>
                    </div>
                {/if}

                <!--
                    **右端は「観るのをやめる」ための列。**

                    閉じる・切り抜く・消すは、観ながら使う操作 (音・字幕・送り) とは
                    押す頻度も並べる理由も違う。下の操作バーに混ぜると番組の名前が入る幅が残らない。

                    **削除をいちばん下に置く。** 隣を押すつもりで当たっても、
                    聞き返しがあるので消えはしない
                -->
                <ControlBar side shown={controls.shown} testid="watch-side">
                    <CloseLink testid="watch-close" />
                    <!--
                        **データ放送 (d) は右上に置く。** 取り出してある録画でだけ出す
                        (`data.hasData`)。データ操作 (リモコン) を右カラムに出すので、
                        入口の d も右にまとめた。押すと右カラムに `Remote` が出る。
                        ライブと違い、取得するのはサーバではなく取り出しておいた変化ログ
                    -->
                    {#if data.hasData}
                        <ControlButton
                            icon={DATA}
                            label={showData ? 'データ放送を消す' : 'データ放送を出す'}
                            on={showData}
                            testid="watch-data-button"
                            onclick={() => pressD(showData, dataButton, (on) => void setData(on))}
                        />
                    {/if}
                    <!--
                        **切り抜き。** 字幕ごと写して、そのまま貼れるようにする。
                        観ている場面を人に見せるのに、いちいち撮り直さずに済む
                    -->
                    <ControlButton
                        icon={CAMERA}
                        label="この場面を切り抜く"
                        testid="watch-shot"
                        onclick={() => void snapshot()}
                    />
                    <!--
                        **観終わったその場で消せるようにする。** 末尾はたいてい
                        CM なので、流したまま消せる。押し間違い防止に2回押させる
                        のは一覧と同じ。

                        **2回目も同じ大きさの丸** (`danger`)。見た目とその理由は
                        [icons.ts](../../../lib/components/player/icons.ts) の
                        `OVERLAY_DANGER`
                    -->
                    <form method="POST" action="?/delete" use:submitting>
                        <input type="hidden" name="id" value={rec.id} />
                        {#if deleting.armed !== null}
                            <ControlButton
                                icon={CHECK}
                                label="削除を確定"
                                danger
                                submit
                                testid="watch-delete-confirm"
                            />
                        {:else}
                            <ControlButton
                                icon={TRASH}
                                label="削除"
                                testid="watch-delete"
                                onclick={() => deleting.arm(rec.id)}
                            />
                        {/if}
                    </form>
                </ControlBar>

                <!-- 下端。操作バーと押すもの。**ライブと同じ操作バー** (`ControlBar`) -->
                <ControlBar shown={controls.shown} testid="watch-controls">
                    <!--
                        **シークバーの CM は琥珀で塗る** (denpa-tv と同じ)。どこで CM が挟まって
                        いるかが見えると、送りのボタンを何回押すかが分かる。色だけに頼らず、
                        読み上げでは位置にいまのチャプターの名前を添える (下の時刻の横にも出ている)
                    -->
                    <SeekBar
                        value={at}
                        max={length || 0}
                        step={0.1}
                        onseek={seekTo}
                        cm={cmOnBar}
                        marks={marksOnBar}
                        valuetext={current === null ? undefined : `${clock(at)}、${current.title}`}
                        paused={!playing}
                        testid="watch-seek"
                    />

                    <ControlRow testid="watch-buttons">
                        <!--
                            **並びはライブと同じ。** 再生・音・字幕が左から順で、
                            全画面がいちばん右。画面を移っても同じ場所にあると、
                            見ないでも押せる。

                            **10秒送り・戻しは置いていない。** PCは矢印キー、
                            指は左右の端を素早く2回 (`ts/watch.ts` の `tap`) で
                            できる — 映像の上に常に2つ置いておくほどの用ではない。
                            **閉じる・d・切り抜き・削除は右の列** (上の `watch-side`)
                        -->
                        <ControlButton
                            icon={playing ? PAUSE : PLAY}
                            label={playing ? '一時停止' : '再生'}
                            testid="watch-play"
                            onclick={togglePlay}
                        />
                        <!--
                            **畳むとき (狭い枠・一段に入らないとき) に残すのは、再生・チャプター送り・
                            時刻・再生の設定 (⚙)・全画面だけ。** 音・字幕・速さ・小窓は「ほか」(⋯) に入れる (`Extras`)。
                            広い枠では包みは何もしないので、並びは今までどおり
                        -->
                        <Extras>
                            <ControlButton
                                icon={muted ? SOUND_OFF : SOUND_ON}
                                label={muted ? '音を出す' : '音を消す'}
                                testid="watch-sound"
                                onclick={toggleMute}
                            />

                            <!--
                                **字幕を持っている録画でだけ出す。** 持っていないほうが
                                多い (字幕の無い番組・この仕組みより前にエンコードしたもの) ので、
                                押しても何も起きない操作を並べない。`/live` と同じ扱い
                            -->
                            {#if hasCaptions}
                                <ControlButton
                                    icon={CAPTION}
                                    label={captions ? '字幕を消す' : '字幕を出す'}
                                    on={captions}
                                    testid="watch-captions"
                                    onclick={toggleCaptions}
                                />
                            {/if}
                        </Extras>

                        <!--
                            **チャプター送りは、入っているときだけ出す。**
                            CMを切ってエンコードしたものには入っていないので、出しても
                            押せない操作が並ぶだけになる。**畳むときも残す** — 録画の中を
                            前後に飛ぶ唯一のボタンで、CM や本編の頭へ毎回のように使う
                        -->
                        {#if chapters.length > 1}
                            <ControlButton
                                icon={PREV}
                                label="前のチャプター"
                                onclick={() => seekTo(prevChapterAt(chapters, at))}
                            />
                            <ControlButton
                                icon={NEXT}
                                label="次のチャプター"
                                testid="watch-next-chapter"
                                onclick={() => seekTo(nextChapterAt(chapters, at))}
                            />
                        {/if}

                        <!-- **読みものは3画面共通の二段** (InfoBlock)。決まりは [ControlBar.svelte](../../../lib/components/player/ControlBar.svelte) -->
                        <InfoBlock
                            range={{ start: rec.start_at, end: rec.end_at }}
                            service={rec.service_name}
                            title={rec.name}
                            titleTestid="watch-name"
                        >
                            {#snippet badge()}
                                {#if localSrc !== null || drawingLocal}
                                    <!-- サーバではなく端末のコピーで観ている印。操作バーのタイトルの並びに出す -->
                                    <span class="tag success local">
                                        端末
                                    </span>
                                {/if}
                            {/snippet}
                            {#snippet status()}
                                <!--
                                    **残りも出す。** 「あと何分で終わるか」は、途中で
                                    観るのをやめるかどうかを決めるのに要る。倍速のときは
                                    **実際に掛かる時間**にする (1.5倍なら残りも1.5で割る)。
                                    狭い枠では位置と長さだけにする (`.long` を省く。`InfoBlock`)
                                -->
                                <span class="clock" data-testid="watch-clock">
                                    {clock(at)} / {clock(length)}<span class="long"> 残り {clock(remaining)}</span>
                                </span>
                                {#if current !== null}
                                    <span class="long">・ <span>{current.title}</span></span>
                                {/if}
                            {/snippet}
                        </InfoBlock>

                        <!--
                            早送り。**ライブの追っかけと同じ並び・同じ見た目。**
                            互換モードで canvas に描いているときは出さない (等速だけ。追っかけと同じ)
                        -->
                        {#if !compat}
                            <Extras>
                                <SpeedMenu
                                    testid="watch-speed"
                                    label="再生の速さ"
                                    {speed}
                                    onselect={(value) => setSpeed(value)}
                                />
                            </Extras>
                        {/if}

                        <!--
                            **再生の設定 (⚙) に入れるもの。** CMスキップはチャプターに CM が入っている録画でだけ
                            (押した時点で CM の中にいれば、そこで飛ぶ)。コーデックはこの端末で観られる方式が
                            2つ以上あるときだけ (「自動」は端末に合わせる。`ts/playback.ts` の `pickOffer`。
                            エンコード済みと違うものを選ぶと、サーバがその場で変換して流す)。音声は2本以上あって
                            選べるときだけ (ブラウザが出せなければ流すほうへ移って選ぶ。`syncAudio`)
                        -->
                        <StageTail
                            prefix="watch"
                            {background}
                            {ambient}
                            {pip}
                            {fullscreen}
                            stage={layout}
                            cm={hasCm ? { on: skipCm, toggle: toggleSkipCm } : undefined}
                            subtitle={hasCaptions
                                ? subtitles({
                                      icon: CAPTION,
                                      on: captions,
                                      languages: captionLanguages,
                                      language: captionLanguage,
                                      onoff: (on) => setCaptions(on),
                                      onlanguage: (index) => setCaptionLanguage(index),
                                  })
                                : undefined}
                            codec={codecMenu.length > 0
                                ? recordingCodecs({
                                      icon: CODEC,
                                      choices: codecMenu,
                                      selected: codecMenu.some((item) => item.key === choice) ? choice : 'auto',
                                      onpick: (key) => chooseCodec(key as CodecChoice | 'mpeg2'),
                                  })
                                : undefined}
                            audio={audios.length > 1
                                ? audioTracks({
                                      icon: AUDIO,
                                      items: audios.map((track, i) => ({
                                          key: i,
                                          label: track.label,
                                          active: i === audioIndex,
                                      })),
                                      onselect: (key) => selectAudio(key),
                                  })
                                : undefined}
                        />
                    </ControlRow>
                </ControlBar>
                {/snippet}

                <!-- 映像の上の通知は舞台の列に積む (`PlayerStage` の `notes`)。いくつ出ても重ならない -->
                {#snippet notes()}
                    {#if continued}
                        <!--
                            **続きから出したことを言う。** 黙って途中から始まると、
                            壊れているのか飛んだのか分からない
                        -->
                        <StageNote testid="watch-resumed">続きから再生しています</StageNote>
                    {/if}
                    {#if skipped}
                        <!-- **黙って飛ばない。** 何が起きたか言わないと壊れて見える -->
                        <StageNote testid="watch-skipped">CMを飛ばしました</StageNote>
                    {/if}
                    {#if warning !== null}
                        <!-- 互換モードの断り書き (切り替えた理由)。ライブと同じ出し方 -->
                        <StageNote testid="watch-warning">{warning}</StageNote>
                    {/if}
                {/snippet}
            </PlayerStage>
        {/if}

    <!--
        **右は番組の中身。観ながら読めるよう、映像に被せず全部ここに出す。**
        中身は一覧のモーダルと同じ部品 (`ProgramFacts`)。枠は追っかけと同じ部品 (FactsAside)
    -->
    {#snippet aside()}
    <FactsAside testid="watch-facts">
        {#snippet top()}
            <!--
                **データ放送のリモコンは、映像の上ではなく右の列に出す** (ライブと同じ)。
                データ放送を出している間だけ、番組の中身の上に出す
            -->
            {#if dataPress !== null}
                <Remote press={dataPress} />
            {/if}
        {/snippet}

        <!--
            **引き直せたらそちらを出す。** 録画の行が持っているのは名前と
            説明までで、出演者などは番組表の側にある。古い録画は番組表から
            消えているので引けず、そのときは行のぶんだけが出たままになる
        -->
        <ProgramFacts
            program={detail.current ?? facts}
            cmNote={cmNoteWorthShowing(rec.cm_note) ? rec.cm_note : null}
            fps={rec.fps}
        />

        <div class="small muted meta num" data-testid="watch-meta">
            {recordedDuration(rec)} ・ {size(rec.ts_size)}
        </div>
        <!--
            **押すものは置かない。** 「一覧へ」は映像の右上の「×」と同じ行き先なので、
            観ている横に要らない
        -->
    </FactsAside>
    {/snippet}
</PlayerLayout>

<Toasts
    {notices}
    source={form}
    ondismiss={(key) => {
        shooter.dismiss(key);
        pip.dismiss(key);
        if (tuneRefused?.key === key) tuneRefused = null;
    }}
/>

<!-- 運転中の注意 (互換モードで初めて再生する前に1回。ライブ・追っかけと同じ)。押すまで再生を始めない -->
<DriveNotice open={drive.open} onaccept={drive.accept} />

<style>
    .not-ready h2 {
        font-size: var(--dp-text-base);
    }
    .wait {
        pointer-events: none;
        position: absolute;
        inset: 0;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .wait-box {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem;
        border-radius: 1rem;
        background: rgb(0 0 0 / 0.6);
        color: #fff;
        --pico-color: #fff;
    }
    .broken {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        padding: 1rem;
        background: rgb(0 0 0 / 0.8);
        text-align: center;
        color: #fff;
    }
    .local {
        flex-shrink: 0;
        align-self: center;
        font-size: 0.625rem;
        padding: 0 0.35rem;
    }
    .meta {
        margin-top: 0.75rem;
    }
</style>
