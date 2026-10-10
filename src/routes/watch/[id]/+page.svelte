<script lang="ts">
    import { onMount } from 'svelte';
    import type { ResponseMessage } from 'web-bml/protocol';
    import { submitting } from '#lib/actions.js';
    import { arming } from '#lib/arming.svelte.js';
    import { CAPTION_TEXT_VERSION, type CaptionPage, type CaptionPages } from '#lib/caption-text.js';
    import ProgramFacts from '#lib/components/ProgramFacts.svelte';
    import AudioMenu from '#lib/components/player/AudioMenu.svelte';
    import { screenAwake } from '#lib/components/player/awake.svelte.js';
    import { backgroundPlayback } from '#lib/components/player/background.svelte.js';
    import CloseLink from '#lib/components/player/CloseLink.svelte';
    import ControlBar from '#lib/components/player/ControlBar.svelte';
    import ControlButton from '#lib/components/player/ControlButton.svelte';
    import ControlRow from '#lib/components/player/ControlRow.svelte';
    import { CaptionPainter } from '#lib/components/player/caption-draw.js';
    import { playerControls } from '#lib/components/player/controls.svelte.js';
    import DataBroadcast, { pressD } from '#lib/components/player/DataBroadcast.svelte';
    import Extras from '#lib/components/player/Extras.svelte';
    import FactsAside from '#lib/components/player/FactsAside.svelte';
    import { eachFrame } from '#lib/components/player/frames.js';
    import { stageFullscreen } from '#lib/components/player/fullscreen.svelte.js';
    import InfoBlock from '#lib/components/player/InfoBlock.svelte';
    import {
        CAMERA,
        CAPTION,
        CHECK,
        CUT,
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
    import MoreButton from '#lib/components/player/MoreButton.svelte';
    import PlayerLayout from '#lib/components/player/PlayerLayout.svelte';
    import PlayerStage from '#lib/components/player/PlayerStage.svelte';
    import { fitRect } from '#lib/components/player/paint.js';
    import { pictureInPicture } from '#lib/components/player/pip.svelte.js';
    import Remote from '#lib/components/player/Remote.svelte';
    import SeekBar from '#lib/components/player/SeekBar.svelte';
    import SpeedMenu, { SPEED_KEY, storedSpeed } from '#lib/components/player/SpeedMenu.svelte';
    import StageNote from '#lib/components/player/StageNote.svelte';
    import StageTail from '#lib/components/player/StageTail.svelte';
    import { snapshotter } from '#lib/components/player/shot.svelte.js';
    import { videoFrame } from '#lib/components/player/snapshot.js';
    import { stageTap } from '#lib/components/player/stage-tap.js';
    import Toasts, { errorNotice, type Notice } from '#lib/components/Toasts.svelte';
    import { programDetail, recordingFacts } from '#lib/detail.svelte.js';
    import { denpaFontUrl } from '#lib/font.js';
    import { clock, cmNoteWorthShowing, recordedDuration, size } from '#lib/format.js';
    import { write as remind, read as stored } from '#lib/keep.js';
    import { loadOffline } from '#lib/offline.svelte.js';
    import type { OfflineVideo } from '#lib/offline-db.js';
    import { type RemuxPlayer, remuxPlayer } from '#lib/remux-player.js';
    import { keepResume } from '#lib/resume.js';
    import { type Cue, showing as captionShowing, currentCue } from '#lib/ts/captions.js';
    import { feedFor, type PlacedMessage, replayAt } from '#lib/ts/data-timeline.js';
    import { pickMediaSource } from '#lib/ts/media-source.js';
    import { stepSpeed } from '#lib/ts/pacing.js';
    import { type MediaFile, type Playback, pickPlayback } from '#lib/ts/remux.js';
    import {
        type Chapter,
        chapterAt,
        isCm,
        nextChapterAt,
        prevChapterAt,
        resumePoint,
        skipCmAtStart,
        skipTarget,
    } from '#lib/ts/watch.js';
    import { resolve } from '$app/paths';

    let { data, form } = $props();
    const rec = $derived(data.recording);

    /** 焼けているか。**観るのは焼いたものだけ** (`+page.server.ts`) */
    const ready = $derived(rec.library_path !== null);
    /*
     * 端末に保存してあれば**オンラインでもそちらを観る** (docs/offline.md)。
     * サーバから読み直さないので、帯域を使わず、電波が細いところでも途切れない。
     * 字幕・チャプター・データ放送も一緒に落としてあるものを使う
     * (各 load が localCopy を先に見る)。
     *
     * **確かめ終わるまで src を渡さない。** 渡してしまうと `<video>` が先に
     * サーバから読み始め、あとから blob に差し替わって読み直しになる —
     * 端末にあるのにサーバへ取りに行ったように見えるのもまぎらわしい
     */
    let localSrc = $state<string | null>(null);
    let localChecked = $state(false);
    let localCopy: OfflineVideo | null = null;
    /**
     * どれを、どう観るか (`ts/remux.ts` の `pickPlayback`)。**そのまま読めないブラウザでは、
     * サーバで fMP4 に詰め替えて MSE に流す** (iPhone の Safari で H.264 の録画。#503)。
     * 中身を聞けなかった (オフライン) ときは、今までどおり主をそのまま渡す
     */
    let playback = $state<Playback>({ way: 'direct', source: 'encoded' });
    /** 詰め替えて流しているときの器 (`remux-player.ts`) */
    let remux: RemuxPlayer | null = null;
    onMount(() => {
        void (async () => {
            const [held, files] = await Promise.all([loadOffline(rec.id), ready ? loadMedia() : []]);
            localCopy = held;
            playback = pickPlayback(files, {
                play: (type) => document.createElement('video').canPlayType(type) !== '',
                mse: (type) => pickMediaSource()?.Source.isTypeSupported(type) ?? false,
            });
            // 詰め替えるなら端末のコピーは使えない (そのまま読めないのは同じ)
            if (localCopy?.video !== undefined && playback.way === 'direct') {
                localSrc = URL.createObjectURL(localCopy.video);
            }
            localChecked = true;
        })();
        return () => {
            if (localSrc !== null) URL.revokeObjectURL(localSrc);
            remux?.destroy();
        };
    });

    /** 焼いたファイルの中身 (`api/recordings/<id>/media`)。聞けなければ空 (= そのまま渡す) */
    async function loadMedia(): Promise<MediaFile[]> {
        try {
            const res = await fetch(resolve(`api/recordings/${rec.id}/media`));
            return res.ok ? ((await res.json()).files ?? []) : [];
        } catch {
            return [];
        }
    }

    const src = $derived(
        localChecked && playback.way === 'direct'
            ? (localSrc ?? resolve(`api/recordings/${rec.id}/file?source=${playback.source}`))
            : undefined,
    );

    /** 詰め替えて観るなら、器を作って流しはじめる。**続きの位置から頼む** (頭から読んで捨てない) */
    $effect(() => {
        if (!localChecked || playback.way !== 'remux' || video === null || remux !== null) return;
        const picked = pickMediaSource();
        if (picked === null) return;
        const plan = playback;
        const from = rec.resume_ms === null ? null : resumePoint(rec.resume_ms / 1000, plan.duration);
        remux = remuxPlayer(video, picked, {
            url: (at, audio) =>
                resolve(
                    `api/recordings/${rec.id}/remux?source=${plan.source}&from=${at.toFixed(3)}&audio=${audio}`,
                ),
            codecs: plan.codecs,
            duration: plan.duration,
            start: from ?? 0,
            audio: audioIndex,
            state: (state) => {
                resuming = state === 'retrying';
                if (state === 'failed') broken = true;
            },
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
     * ライブは今のカルーセルをそのまま流すが、録画は**焼くときに取り出しておいた
     * 変化ログ**を、再生位置に合わせて流し直す (`ts/data-timeline`,
     * `server/recorded-bml.ts`)。描くのはライブと同じ `DataBroadcast`。
     */
    /** d ボタンで出しているか */
    let showData = $state(false);
    /** 映像を入れる箱。**BML はこれを動かす** (`DataBroadcast` の place) */
    let mediaBox = $state<HTMLElement | null>(null);
    /** リモコンの押す口と、d を文書へ渡す口 (ライブと同じ。`DataBroadcast` の press / pressD) */
    let dataPress = $state<((code: number) => void) | null>(null);
    let dataButton = $state<(() => boolean) | null>(null);
    /**
     * データ放送を作り直す合図 (`DataBroadcast` の channel)。**戻ったら変える** —
     * 器を作り直して、その時点まで積み直す
     */
    let dataChannel = $state<string | null>(null);
    /** 焼いておいた変化ログ。**押されてから取りに行く** (字幕と同じ「頼まれてから」) */
    let dataTimeline: PlacedMessage[] = [];
    /** 借りものへ流す口。`DataBroadcast` が open のたびに預けてくる */
    let dataEmit: ((message: ResponseMessage) => void) | null = null;
    /** どこまで流したか (再生位置 ms)。まだなら -1 */
    let dataFed = -1;

    function nowMs(): number {
        return Math.round((video?.currentTime ?? 0) * 1000);
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
        // 器を作らせる。open のあと listenData が呼ばれて、いまの位置まで積み直す
        dataChannel = `${rec.id}`;
    }

    /**
     * `DataBroadcast` が器の口を預けてくる (作り直すたびに新しいものを)。
     * **預かった直後に、いまの再生位置まで積んで追いつく** (`replayAt`)
     */
    function listenData(emit: ((message: ResponseMessage) => void) | null): void {
        dataEmit = emit;
        if (emit === null) return;
        const to = nowMs();
        for (const message of replayAt(dataTimeline, to)) emit(message);
        dataFed = to;
    }

    /** 再生が進んだぶんのデータ放送を流す。**戻っていたら器を作り直す** */
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
     * 選べる音声トラック。**ブラウザが器から出せたときだけ。**
     *
     * 焼いたものには主音声・副音声が両方入っている (二カ国語の映画・二重音声の
     * アニメなど)。ブラウザが Matroska の音声を `video.audioTracks` に出せれば、
     * ここで選んだものだけを有効にして切り替える。ライブと違い**サーバは焼き
     * 直さない** — 器の中に入っているものを選ぶだけ。
     *
     * **出せない端末では空のまま = 切り替えは出さない。** `audioTracks` は
     * ブラウザ任せで、Matroska の副音声を出さないものもある。押しても効かない
     * 操作を並べないため、2本以上あるときだけ出す (`hasCaptions` と同じ考え)
     */
    let audios = $state<{ label: string }[]>([]);
    let audioIndex = $state(0);
    /**
     * 字幕を出しているか。**持っている録画でだけ意味を持つ** (`data.subtitle`)。
     * **既定は出す** — ライブと同じ (`live-player` の `captions`)
     */
    let captions = $state(true);
    /**
     * 字幕。**開いた時点で取りに行く** (既定で出すので)。焼いた録画に入っている放送の字幕を
     * 文字の配置で受け取る (`captions.json`。ライブと同じ描き方)。ずっと前に焼いた録画の絵の字幕 (PGS) は読まない。
     *
     * 持っている番組かどうかは**取ってみるまで分からない** — 入れ物から抜くので、
     * 無ければ 404 が返る。ライブと同じで、持っているときだけボタンを出す
     * (`live-player` の `hasCaptions`)
     */
    /** 文字の配置。時刻の順 */
    let cues = $state.raw<Cue[]>([]);
    const hasCaptions = $derived(cues.length > 0);
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
     * 出さないと、絵が止まったのが**詰まりなのか壊れたのか分かりません**。
     * 跳んだ直後や回線が細いときは数秒待つことがある
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
     * 繋ぎが切れて拾い直している最中か。**サーバの入れ替え (デプロイ) 用。**
     *
     * 器ごと作り直すので、観ている最中に配信が切れる。何もしないと**そこで
     * 止まったまま**で、自分で開き直して位置を探し直すことになっていた
     */
    let resuming = $state(false);
    /** 続けて何回拾い直したか。**諦める分かれ目** */
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    /** 拾い直したあとに戻る位置 (秒)。0 は「戻る先は無い」 */
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
     * 小窓 (PiP。[pip.svelte.ts](../../../lib/components/player/pip.svelte.ts))。小窓で押された
     * 止める・再開は `<video>` の `play`/`pause` で拾えているので、合わせる口は要らない
     */
    const pip = pictureInPicture({
        video: () => video,
        auto: () => background.on,
        overlay: () => overlay,
        captions: () => captions && hasCaptions,
    });

    /** バックグラウンド再生 ([background.svelte.ts](../../../lib/components/player/background.svelte.ts))。既定は切で、裏に回ったら止め、戻ったら止めた所から */
    const background = backgroundPlayback({
        pip: () => pip.active,
        paused: () => video?.paused ?? true,
        pause: () => video?.pause(),
        resume: () => void video?.play().catch(() => undefined),
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
     * 焼くときに CM を落とす設定にしていれば要らないが、判定を当てにせず
     * 残して焼いている場合 (既定はチャプターを入れるだけ) は、観るたびに
     * 送りのボタンを押すことになる。
     *
     * **端末ごとに覚える** (速さと同じ理由。`speed` の項)。
     * **観はじめに入れるかどうかは `skipCmAtStart`** — 既定は入で、ロゴでの
     * 判定に失敗した1本だけは覚えていても切って始める (理由と試験はあちら)
     */
    const SKIP_CM_KEY = 'watch-skip-cm';
    let skipCm = $state(false);
    /** CM を飛ばしたことを短く言う。黙って跳ぶと壊れたように見える */
    let skipped = $state(false);
    let skipNotice: ReturnType<typeof setTimeout> | null = null;
    /**
     * **跨いでいる間、最後の本編のコマで蓋をする面。**
     *
     * 先読み (`CM_LEAD`) だけでは 0コマにできません。`requestVideoFrameCallback`
     * は**映したあと**に来るうえ、ブラウザは先のコマを何枚か合成器へ渡し終えて
     * いるので、そこで位置を変えても**渡し済みのぶんは出てしまいます**。
     * 実機で見えていた「一瞬の CM」はこれです。
     *
     * 予測で消せない以上、**隠します。** 跳ぶ直前のコマを写して被せ、跳んだ先が
     * 映ってから外す。黒で塗らないのは、**止め絵のほうが跳んだように見える**ため
     * (黒を挟むと切れたように見える)
     */
    let cover = $state<HTMLCanvasElement | null>(null);
    /** 蓋をしているか */
    let hopping = $state(false);
    /**
     * 跳んだ先が映るのを待っているか。**`hopping` とは別**。
     *
     * 開いた直後は「跳ぶかどうかまだ分からない」ので、蓋だけ先に出して
     * (`hopping`) チャプターを待ちます。そのとき跳ぶ判断は**まだしていない**ので、
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
    /** 跳んだ先 (秒)。ここまで来たら蓋を外す */
    let hopTo = 0;
    /** 跳んだ先に着いたと数えたコマ数。`SETTLED` まで数えてから蓋を外す */
    let settled = 0;
    /**
     * 蓋を外すまでに待つコマ数。
     *
     * **1コマでは早すぎます。** `requestVideoFrameCallback` は「合成器へ渡した」
     * ところで呼ばれるもので、渡したコマが画面に出るのはその先です
     * (`expectedDisplayTime` が未来を指しているのはそのため)。さらに Windows の
     * Chrome / Edge は**映像を DOM とは別の面 (DirectComposition の overlay) に
     * 出す**ので、蓋を外す DOM の更新のほうが**映像の面より先に画面へ出ます**。
     *
     * 実機 (Windows Chrome・1.25倍) では、位置も章も本編に入っているのに
     * **画面だけ CM のまま**という絵が撮れていました。数コマ余分に待てば消えます。
     * そのぶん本編の頭が止め絵になりますが、4コマ (30コマ/秒で 0.13秒) なので
     * 跳んだ間合いに紛れます。
     *
     * `mediaTime` を持たないブラウザ (古い Firefox) では `currentTime` で数えます。
     * あちらは位置を代入した時点で跳んだ先を返すので、なおさら1コマでは足りない
     */
    const SETTLED = 4;
    /** 蓋の外し忘れ止め。跳んだ先が来ないまま止まっても、いつかは外す */
    let hopGiveUp: ReturnType<typeof setTimeout> | null = null;
    /** 蓋をしておく上限 (ms)。読み込みが詰まっても止め絵で居座らせない */
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
        // 取りに行っている間そのまま流れていた (`settle`)
        if (skipCm) shut();
        void loadChapters().then(settle);
        void detail.open(rec.program_id, facts);
        // 字幕は既定で出す (ライブと同じ)。持っていない録画では何も起きない
        if (captions) void loadCaptions();
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
     * 解いたあとで `addtrack` してくる。並びが変わったら読み直す
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
        if (video === null || !ready) return;
        keepResume(rec.id, video.currentTime, video.duration, leaving);
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
     * 尺が分かってから動かす (`loadedmetadata`)。**1回だけ** — 跳んだあとに
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

    /** トラックの見出し。器に入っている名前 (主音声/副音声) → 言語 → 連番の順で拾う */
    function audioLabel(track: AudioTrackLike, i: number): string {
        const name = track.label.trim();
        if (name !== '') return name;
        const lang = track.language.trim();
        if (lang !== '') return lang;
        return `音声 ${i + 1}`;
    }

    /** いま器が持っている音声トラックを読み直す (`loadedmetadata` と `addtrack` から) */
    function syncAudio(): void {
        /*
         * **詰め替えて流しているときは、入れ物の音声の名前から並べる。** 流しているのは
         * 選んだ1本だけなので、器 (`audioTracks`) には1本しか出ない (`remux-player.ts`)
         */
        if (playback.way === 'remux') {
            audios = playback.audios.map((label, i) => ({ label: label.trim() || `音声 ${i + 1}` }));
            return;
        }
        const tracks = audioTrackList();
        if (tracks === null) {
            audios = [];
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

    /** 音声を選ぶ。**選んだものだけ有効にする** (ブラウザはそれで切り替える)。詰め替えなら頼み直す */
    function selectAudio(index: number): void {
        if (remux !== null) {
            remux.setAudio(index);
            audioIndex = index;
            return;
        }
        const tracks = audioTrackList();
        if (tracks === null) return;
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            if (track !== undefined) track.enabled = i === index;
        }
        audioIndex = index;
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
            // 端末に保存したものがあればそちら (オフラインでもCM飛ばしが効く)
            const held = localCopy?.chapters as { chapters?: typeof chapters } | undefined;
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
     * 配信が切れたら拾い直す。**サーバの入れ替え (デプロイ) で切れるため。**
     *
     * `<video>` はファイルを少しずつ取りに来ているので、途中で口が無くなると
     * そこで止まる。**同じ所から読み直して、観ていた位置へ戻す** — 開き直しでは
     * ないので、覚えている続きの位置 (15秒おき) ではなく、切れた瞬間の位置。
     *
     * **理由を見て決める。** 読めない形式・壊れたファイルは何度やっても同じで、
     * そちらは今までどおり落とす口を出す (`broken`)。拾い直すのは繋ぎが切れた
     * ときだけ
     */
    const RETRIES = 8;
    function recover(): void {
        if (video === null) return;
        const code = video.error?.code ?? 0;
        // 詰め替えて流しているときの切れ目は `remux-player.ts` が拾い直す。ここに来るのは読めない中身
        if (remux !== null || code !== MediaError.MEDIA_ERR_NETWORK || retries >= RETRIES) {
            broken = true;
            resuming = false;
            return;
        }
        retryAt = video.currentTime;
        // 倍々に伸ばして 10秒で頭打ち。入れ替えは数十秒かかる
        const wait = Math.min(10_000, 1000 * 2 ** retries);
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
        speed = value;
        if (video !== null) video.playbackRate = value;
        if (remember) remind(SPEED_KEY, String(value));
        controls.stir();
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
     * CM を跨ぐ**手前**で跳ぶための先読み (秒)。
     *
     * 30コマ/秒で3コマぶん。**入ってから跳ぶと必ず CM のコマが見えます** —
     * 画面は跳ぶまで今の絵を出し続けるので、気付くのが1コマ遅れれば1コマ映る。
     *
     * **合成器に渡し済みのコマぶんを見込んで取る。** ブラウザは先のコマを
     * 何枚か渡し終えているので、蓋 (`cover`) を出しても効くのは次の合成から。
     * 1コマぶんの先読みでは間に合わない。本編の末尾 0.1 秒が止め絵になるが、
     * 境目は場面の切れ目なので分からない
     */
    const CM_LEAD = 0.1;

    /**
     * CM の中に居たら、その終わりまで跳ぶ。**判断は `ts/watch.ts` が持つ。**
     *
     * 続いている CM はまとめて跨ぐので、15秒ごとに何度も跳ぶことはない
     */
    function hopCm(): void {
        // 跳んだ先を待っている最中。着くまでは何もしない
        if (waiting || !skipCm || video === null) return;
        const to = skipTarget(chapters, video.currentTime, CM_LEAD);
        if (to === null) return;
        shut();
        video.currentTime = to;
        hopTo = to;
        waiting = true;
        skipped = true;
        if (skipNotice !== null) clearTimeout(skipNotice);
        skipNotice = setTimeout(() => (skipped = false), 2500);
    }

    /**
     * いま映っているコマを写して蓋をする。**跳ぶ前に呼ぶ。**
     *
     * **本編に居るときだけ写します。** CM の中で写すと、蓋そのものが CM の
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

    /** 蓋を外す。跳んだ先が映ったとき (`follow`) と、待ちくたびれたとき */
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
     * **観はじめの1回。** チャプターが揃ってから、始まりが CM なら跳ぶ。
     *
     * 開いた時点では**チャプターをまだ取れていません** (別に取りに行くため)。
     * 何もしないと、取れるまでの間だけ**本編前の CM がそのまま流れます** —
     * 実機で見えていた「一瞬の CM」はこれでした。取りに行っている間は
     * 黒い蓋をしておいて、揃ってから跳ぶ・跳ばないを決める
     */
    function settle(): void {
        hopCm();
        // 跳ばなかった (CM ではなかった・切ってある)。蓋は要らない
        if (!waiting) open();
    }

    function togglePlay(): void {
        if (video === null) return;
        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
    }

    /**
     * 字幕の出し入れ。**canvas に描いて重ねる** — ライブ (`/live`) と同じやり方 (`caption-draw.ts`)。
     *
     * 文字を `<track>` に渡す道は**放送どおりには出ない** — 左右の位置も、背景の箱も、
     * 外字も落ちる。放送が言う置き場所のまま描く
     */
    function toggleCaptions(): void {
        captions = !captions;
        if (captions) void loadCaptions();
        else clearCaptions();
        controls.stir();
    }

    /**
     * 字幕を取ってくる。**既定で出すので、開いた時点で取りに行く**
     * (`onMount`)。一度読めていれば読み直さない。
     *
     * 端末に保存したものがあればそちらから読む (オフラインでも字幕が出る)
     */
    async function loadCaptions(): Promise<void> {
        if (cues.length > 0) return;
        try {
            // 端末に保存したものがあればそちら。**字幕を持たない番組は 404** (ボタンを出さないだけで、異常ではない)
            const text =
                localCopy !== null
                    ? (localCopy.captionText as CaptionPages | undefined)
                    : await fetch(resolve(`api/recordings/${rec.id}/captions.json`)).then((res) =>
                          res.ok ? (res.json() as Promise<CaptionPages>) : undefined,
                      );
            if (text?.v === CAPTION_TEXT_VERSION && text.pages.length > 0) {
                cues = text.pages.map(({ at, page }) => ({ at, page }));
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
             * 位置を代入した時点で `currentTime` は**跳んだ先を返す**のに
             * (仕様どおり)、画面にはまだ手前のコマが出ています。それで外して
             * いたので、蓋を出しても CM の尻が1コマ見えていた。
             * `requestVideoFrameCallback` の `mediaTime` は**いま映した**コマの
             * 時刻なので、これが跳んだ先を越えるまで待つ
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
     * 字幕と CM の蓋を**映像の絵が出ているところ**にぴったり重ねる (`fitRect`)
     */
    function place(): void {
        if (video === null) return;
        const rect = fitRect(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight);
        // 字幕も CM の蓋も、映像の絵と同じ場所・同じ大きさに置く
        for (const layer of [overlay, cover]) {
            if (layer === null) continue;
            layer.style.left = `${video.offsetLeft + rect.left}px`;
            layer.style.top = `${video.offsetTop + rect.top}px`;
            layer.style.width = `${rect.width}px`;
            layer.style.height = `${rect.height}px`;
        }
        // 黒塗りの蓋は枠ごと覆う。**まだ絵の大きさが分からない**ことがあるため
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
     * 終わってから。iPhone で広げたときは窓の `resize` が来ないので、ここで拾う
     */
    $effect(() => {
        void fullscreen.active;
        const frame = requestAnimationFrame(place);
        return () => cancelAnimationFrame(frame);
    });

    /**
     * いまの位置に合う1枚を重ねる。**変わったときだけ描く。**
     * canvas の箱は `place` が映像の絵に合わせ、中の座標は `CaptionPainter` が放送の面から写す
     */
    function paint(): void {
        // 蓋の下。いま描くと CM の字幕を仕込むことになる
        if (hopping) return;
        if (!captions || overlay === null) return;
        // 描き方はライブと同じ (`caption-draw.ts`)
        const at = video?.currentTime ?? 0;
        const page = captionShowing(currentCue(cues, at), at);
        if (page === shownPage) return;
        shownPage = page;
        place();
        painter?.show(page);
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

    /** 絵を押されたときの読み方は追っかけと同じ (`stage-tap.ts`) */
    const press = stageTap({ toggle: togglePlay, controls: () => controls.toggle(), seekBy });

    /**
     * **押す口は自分で繋ぐ** (`onclick={press}` と書かない)。
     *
     * データ放送を出すと、借りものは**映像の箱を閉じた影 (`attachShadow`) の中へ
     * 移します** (`DataBroadcast` の `place`)。Svelte は `onclick` を根に1つだけ
     * 置いて配る作りで、配り先を `composedPath()` の先頭から辿る — **閉じた影の
     * 中は composedPath に出てこない**ので、辿り着くのは影の入れ物までです。
     * 書いたとおりに見えて、**d を出した瞬間だけ絵を押しても止まらなく**なる
     * (実機で踏んだ。押した先を数えると `watch-video` が light DOM から消えている)。
     *
     * 要素に直に付けた口は、要素ごと移されても付いたまま動きます
     */
    $effect(() => {
        const target = video;
        if (target === null) return;
        target.addEventListener('click', press);
        return () => target.removeEventListener('click', press);
    });

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
        toggleMute: () => {
            if (video !== null) video.muted = !video.muted;
        },
    });
    function keys(event: KeyboardEvent): void {
        if (showData && event.key.startsWith('Arrow')) return;
        playerKey(event);
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
     * 右に出す中身。**録画の行が持っているぶんだけ**で組み立てる (追っかけと同じ `recordingFacts`)。
     *
     * 出演者などは番組表の側にあり、24時間で消える。引けるうちは開いた時点で
     * 引き直す (`onMount`)。引けなければ行のぶんだけが出たままになる
     */
    const facts = $derived(recordingFacts(rec));

    /** 切り抜きの結果。**貼れたかどうかは言う** (黙って何も起きないと分からない) */
    const shooter = snapshotter(controls);

    /** 断られたときだけ知らせる。消せたときは一覧へ戻るので出す先が無い */
    const notices = $derived<Notice[]>([
        ...errorNotice(form, 'watch-delete'),
        ...shooter.notices,
        ...pip.notices,
    ]);

    /**
     * いまの1コマを**字幕ごと**切り抜いて PNG に (`番組名_YYYYMMDD-HHMMSS.png`)。
     * 指の端末では共有シート、PC では落としてクリップボードにも置く。
     * 重ね方・渡し方は3画面共通 ([snapshot.ts](../../../lib/components/player/snapshot.ts))
     */
    function snapshot(): void {
        // 字幕を出しているときだけ重ねる
        const drawn = captions && shownPage !== null;
        void shooter.take(() => videoFrame(video), drawn ? overlay : null, rec.name);
    }
</script>

<svelte:head><title>{rec.name} - denpa</title></svelte:head>
<svelte:window onclick={deleting.stand} onkeydown={keys} />

<!-- **ライブ (`/live`) と同じ形・同じ作り** (PlayerLayout)。映像が左、読むものが右 -->
<PlayerLayout testid="watch">
        {#if !ready}
            <!-- 生TSがあれば load が追っかけへ送るので、ここに来るのは焼いたものも生TSも無い録画 -->
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
            <PlayerStage {controls} {fullscreen} testid="watch-stage" bind:element={stage}>
                {#snippet children(layout)}
                <!--
                    **押すのは絵そのもの。** ボタンを避けて敷くのではなく、
                    ボタンを上に重ねる (z-index 10)。押す口は自分で繋ぐ (`press` の effect)
                -->
                <!-- svelte-ignore a11y_media_has_caption -->
                <!--
                    **字幕は `<track>` ではない。** 文字を渡す道は放送どおりには出ない
                    (左右の位置・背景の箱・外字が落ちる)。放送の置き場所のまま canvas に描いて
                    重ねる — ライブと同じやり方 (下の canvas)
                -->
                <!--
                    **映像の箱。BML はこれを動かす** (`DataBroadcast` の place)。ライブと同じ。
                    **class ではなく style で書く** — 影の中へ移されると class が届かず 0 幅になる
                    (`MediaStack.svelte`)。`pointer-events:auto` は、押すのを通す `live-data` の
                    影へ移されても**絵を押して止められる**ように
                -->
                <div
                    bind:this={mediaBox}
                    style="position:absolute; inset:0; width:100%; height:100%; pointer-events:auto;"
                >
                <video
                    bind:this={video}
                    {src}
                    style="width:100%; height:100%; background:#000;"
                    playsinline
                    onplay={() => {
                        playing = true;
                        if (video !== null) follow(video);
                        // 出たので、拾い直しは済み。次に切れたらまた1秒から待つ
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
                </div>
                <!--
                    **録画のデータ放送。** 焼くときに取り出した変化ログ (`data.hasData`) を、
                    再生位置に合わせて流す (`feedData`/`listenData`)。描くのはライブと同じ借りもの。
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
                    network={false}
                />

                <!--
                    **放送の字幕。** 映像の絵に重ねる (`place`)。**押す邪魔をしない**
                    (`pointer-events: none`) — 下の絵を押して止められなくなる
                -->
                <canvas
                    bind:this={overlay}
                    class="layer"
                    data-testid="watch-captions-canvas"
                    data-on={captions && hasCaptions}
                    aria-hidden="true"
                ></canvas>

                <!--
                    **CM を跨ぐ間の蓋。** 字幕より後ろに置く = 字幕の上に載る
                    (CM の字幕まで隠すため)。帯や報せ (z-index 10) の下には残す
                -->
                <canvas
                    bind:this={cover}
                    class="layer"
                    hidden={!hopping}
                    aria-hidden="true"
                ></canvas>

                {#if continued}
                    <!--
                        **続きから出したことを言う。** 黙って途中から始まると、
                        壊れているのか飛んだのか分からない。lower は操作列よけ
                    -->
                    <StageNote testid="watch-resumed" place="lower">
                        続きから再生しています
                    </StageNote>
                {/if}

                {#if buffering && !resuming}
                    <!--
                        **読み込み待ち。** 絵が止まったのが詰まりなのか壊れたのか
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

                {#if skipped}
                    <!-- **黙って跳ばない。** 何が起きたか言わないと壊れて見える -->
                    <StageNote testid="watch-skipped" place="lower">
                        CMを飛ばしました
                    </StageNote>
                {/if}

                {#if broken}
                    <!-- **黙って黒いままにしない。** 観られる先を案内する (外のプレイヤーは相手にしない) -->
                    <div class="broken">
                        <p class="small">
                            このブラウザでは再生できませんでした。<br
                            />Chrome・Edge か、テレビのアプリ (denpa-tv) で観てください。
                        </p>
                    </div>
                {/if}

                <!--
                    **右端は「観るのをやめる」ための列。**

                    閉じる・切り抜く・消すは、観ながら使う操作 (音・字幕・送り) とは
                    押す頻度も並べる理由も違う。下の帯に混ぜると番組の名前が入る幅が残らない。

                    **削除をいちばん下に置く。** 隣を押すつもりで当たっても、
                    聞き返しがあるので消えはしない
                -->
                <ControlBar side shown={controls.shown} testid="watch-side">
                    <CloseLink testid="watch-close" />
                    <!--
                        **データ放送 (d) は右上に置く。** 焼いてある録画でだけ出す
                        (`data.hasData`)。データ操作 (リモコン) を右カラムに出すので、
                        入口の d も右にまとめた。押すと右カラムに `Remote` が出る。
                        ライブと違い、取りに行くのはサーバではなく焼いた変化ログ
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
                                label="削除する"
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

                <!-- 下端。帯と押すもの。**ライブと同じ帯** (`ControlBar`) -->
                <ControlBar shown={controls.shown} testid="watch-controls">
                    <!--
                        **帯にはチャプターの切れ目を出す。** どこで CM が挟まって
                        いるかが見えると、送りのボタンを何回押すかが分かる
                    -->
                    <SeekBar
                        value={at}
                        max={length || 0}
                        step={0.1}
                        onseek={seekTo}
                        marks={chapters.slice(1).map((chapter) => chapter.start)}
                    />

                    <ControlRow testid="watch-buttons">
                        <!--
                            **並びはライブと同じ。** 再生・音・字幕が左から順で、
                            全画面がいちばん右。画面を移っても同じ場所にあると、
                            見ないでも押せる。

                            **10秒送り・戻しは置いていない。** PCは矢印キー、
                            指は左右の端を素早く2回 (`ts/watch.ts` の `tap`) で
                            できる — 絵の上に常に2つ置いておくほどの用ではない。
                            **閉じる・d・切り抜き・削除は右の列** (上の `watch-side`)
                        -->
                        <ControlButton
                            icon={playing ? PAUSE : PLAY}
                            label={playing ? '一時停止' : '再生'}
                            testid="watch-play"
                            onclick={togglePlay}
                        />
                        <ControlButton
                            icon={muted ? SOUND_OFF : SOUND_ON}
                            label={muted ? '音を出す' : '音を消す'}
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
                                icon={CAPTION}
                                label={captions ? '字幕を消す' : '字幕を出す'}
                                on={captions}
                                testid="watch-captions"
                                onclick={toggleCaptions}
                            />
                        {/if}

                        <!--
                            **ここから CM 飛ばしまでと速さは、狭い枠では「ほか」(⋯) に畳む** (`Extras`)。
                            広い枠では包みは何もしないので、並びは今までどおり
                        -->
                        <MoreButton stage={layout} testid="watch-more" />
                        <Extras>
                        <!--
                            **音声トラックの切り替え。** ブラウザが器から2本以上
                            出せたときだけ (二カ国語・二重音声)。`/live` の音声選びと
                            同じ見た目。1本しか無ければ出さない
                        -->
                        {#if audios.length > 1}
                            <AudioMenu
                                testid="watch-audio"
                                items={audios.map((track, i) => ({
                                    key: i,
                                    label: track.label,
                                    active: i === audioIndex,
                                }))}
                                onselect={(key) => selectAudio(key)}
                            />
                        {/if}

                        <!--
                            **チャプター送りは、入っているときだけ出す。**
                            CMを切って焼いたものには入っていないので、出しても
                            押せない操作が並ぶだけになる
                        -->
                        {#if chapters.length > 1}
                            <ControlButton
                                icon={PREV}
                                label="前のチャプター"
                                testid="watch-prev-chapter"
                                onclick={() => seekTo(prevChapterAt(chapters, at))}
                            />
                            <ControlButton
                                icon={NEXT}
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
                                icon={CUT}
                                label={skipCm ? 'CM飛ばしをやめる' : 'CMを自動で飛ばす'}
                                on={skipCm}
                                testid="watch-skip-cm"
                                onclick={toggleSkipCm}
                            />
                        {/if}
                        </Extras>

                        <!-- **読みものは3画面共通の二段** (InfoBlock)。決まりは [ControlBar.svelte](../../../lib/components/player/ControlBar.svelte) -->
                        <InfoBlock
                            range={{ start: rec.start_at, end: rec.end_at }}
                            service={rec.service_name}
                            title={rec.name}
                            titleTestid="watch-name"
                        >
                            {#snippet badge()}
                                {#if localSrc !== null}
                                    <!-- サーバではなく端末のコピーで観ている印。帯の題名の並びに出す -->
                                    <span class="tag success local">
                                        端末
                                    </span>
                                {/if}
                            {/snippet}
                            {#snippet status()}
                                <!--
                                    **残りも出す。** 「あと何分で終わるか」は、途中で
                                    観るのをやめるかどうかを決めるのに要る。倍速のときは
                                    **実際に掛かる時間**にする (1.5倍なら残りも1.5で割る)
                                -->
                                <span data-testid="watch-clock">
                                    {clock(at)} / {clock(length)} 残り {clock(remaining)}
                                </span>
                                {#if current !== null}
                                    ・ <span>{current.title}</span>
                                {/if}
                            {/snippet}
                        </InfoBlock>

                        <!-- 早送り。**ライブの追っかけと同じ並び・同じ見た目** -->
                        <Extras>
                            <SpeedMenu
                                testid="watch-speed"
                                label="再生の速さ"
                                {speed}
                                onselect={(value) => setSpeed(value)}
                            />
                        </Extras>

                        <StageTail prefix="watch" {background} {pip} {fullscreen} />
                    </ControlRow>
                </ControlBar>
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

        <div class="small muted meta" data-testid="watch-meta">
            {recordedDuration(rec)} ・ {size(rec.ts_size)}
        </div>
        <!--
            **押すものは置かない。** 「一覧へ」は絵の右上の「×」と同じ行き先、
            ダウンロードは録画の詳細の「その他…」にある。観ている横に要らない
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
    }}
/>

<style>
    .not-ready h2 {
        font-size: 1rem;
    }
    /* 字幕・CM の蓋。位置と大きさは place が style で決める */
    .layer {
        pointer-events: none;
        position: absolute;
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
