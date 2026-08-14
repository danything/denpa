<script lang="ts">
    import { onMount } from 'svelte';
    import { submitting } from '$lib/actions';
    import { arming } from '$lib/arming.svelte';
    import ProgramFacts from '$lib/components/ProgramFacts.svelte';
    import AudioMenu from '$lib/components/player/AudioMenu.svelte';
    import { screenAwake } from '$lib/components/player/awake.svelte';
    import ControlBar from '$lib/components/player/ControlBar.svelte';
    import ControlButton from '$lib/components/player/ControlButton.svelte';
    import { playerControls } from '$lib/components/player/controls.svelte';
    import DataBroadcast from '$lib/components/player/DataBroadcast.svelte';
    import FactsAside from '$lib/components/player/FactsAside.svelte';
    import Icon from '$lib/components/player/Icon.svelte';
    import InfoBlock from '$lib/components/player/InfoBlock.svelte';
    import {
        CAMERA,
        CAPTION,
        CHECK,
        CLOSE,
        CUT,
        DATA,
        EXPAND,
        NEXT,
        OVERLAY,
        OVERLAY_BTN,
        PAUSE,
        PLAY,
        PREV,
        SHRINK,
        SOUND_OFF,
        SOUND_ON,
        TRASH,
    } from '$lib/components/player/icons';
    import PlayerStage from '$lib/components/player/PlayerStage.svelte';
    import { clearOverlay, drawOverlay, fitRect } from '$lib/components/player/paint';
    import Remote from '$lib/components/player/Remote.svelte';
    import SpeedMenu from '$lib/components/player/SpeedMenu.svelte';
    import StageNote from '$lib/components/player/StageNote.svelte';
    import { snapshotter } from '$lib/components/player/shot.svelte';
    import Toasts, { errorNotice, type Notice } from '$lib/components/Toasts.svelte';
    import { type DetailSeed, programDetail } from '$lib/detail.svelte';
    import { clock, cmNoteWorthShowing, recordedDuration, size } from '$lib/format';
    import { write as remind, read as stored } from '$lib/keep';
    import { loadOffline } from '$lib/offline.svelte';
    import type { OfflineVideo } from '$lib/offline-db';
    import { captionAt, type Drawn, pixels, readSup } from '$lib/pgs';
    import { keepResume } from '$lib/resume';
    import { feedFor, type PlacedMessage, replayAt } from '$lib/ts/data-timeline';
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
    import type { ResponseMessage } from '$lib/vendor/web-bml/server/ws_api';

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
    onMount(() => {
        void (async () => {
            localCopy = await loadOffline(rec.id);
            if (localCopy?.video !== undefined) localSrc = URL.createObjectURL(localCopy.video);
            localChecked = true;
        })();
        return () => {
            if (localSrc !== null) URL.revokeObjectURL(localSrc);
        };
    });
    const src = $derived(
        localChecked ? (localSrc ?? `/api/recordings/${rec.id}/file?source=encoded`) : undefined,
    );

    let video = $state<HTMLVideoElement | null>(null);
    /** 映像とその上の操作をまとめた箱。全画面にするのはこちら */
    let stage = $state<HTMLElement | null>(null);

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
    /** 指のリモコンの押す口。器ができてから預かる (`Remote`) */
    let dataPress = $state<((code: number) => void) | null>(null);
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

    async function toggleData(): Promise<void> {
        showData = !showData;
        if (!showData) {
            dataChannel = null;
            return;
        }
        if (dataTimeline.length === 0) {
            if (Array.isArray(localCopy?.databroadcast)) {
                // 端末に保存したものから。オフラインでも d が効く
                dataTimeline = localCopy.databroadcast as PlacedMessage[];
            } else {
                const response = await fetch(`/api/recordings/${rec.id}/databroadcast`).catch(() => null);
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
    let full = $state(false);
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

    /**
     * 指で触っているか。**全画面にするかと、押したときの読み方が変わる。**
     *
     * 画面の幅では決めない — 狭い窓で開いた PC まで全画面になる。
     * `(pointer: coarse)` は「いま使っている指し手が粗いか」なので、
     * タッチのノートPCでも当たる
     */
    let coarse = $state(false);

    /** 操作列の出し入れ ([controls.svelte.ts](../../../lib/components/player/controls.svelte.ts))。ライブと同じ */
    const controls = playerControls();
    $effect(() => {
        controls.held = !playing;
    });

    /**
     * 観ている間は画面を落とさせない ([awake.svelte.ts](../../../lib/components/player/awake.svelte.ts))。
     * 動画は触らずに見るものなので、**再生中こそいちばん落とされる**
     */
    const awake = screenAwake();
    $effect(() => {
        awake.on = playing;
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
            document.removeEventListener('fullscreenchange', onFull);
            window.removeEventListener('resize', onResize);
            window.removeEventListener('pagehide', onLeave);
            clearInterval(ticker);
            remember(true);
            deleting.fire();
            if (skipNotice !== null) clearTimeout(skipNotice);
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
     * (サーバも同じものを見る)。送り方は追っかけと共通 (`$lib/resume.ts`)
     */
    function remember(leaving = false): void {
        if (video === null || !ready) return;
        keepResume(rec.id, video.currentTime, video.duration, leaving);
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
        const tracks = audioTrackList();
        if (tracks === null) {
            audios = [];
            return;
        }
        const list: { label: string }[] = [];
        let enabled = 0;
        for (let i = 0; i < tracks.length; i++) {
            list.push({ label: audioLabel(tracks[i], i) });
            if (tracks[i].enabled) enabled = i;
        }
        audios = list;
        audioIndex = enabled;
    }

    /** 音声を選ぶ。**選んだものだけ有効にする** (ブラウザはそれで切り替える) */
    function selectAudio(index: number): void {
        const tracks = audioTrackList();
        if (tracks === null) return;
        for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === index;
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
            const res = await fetch(`/api/recordings/${rec.id}/chapters`);
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
        if (code !== MediaError.MEDIA_ERR_NETWORK || retries >= RETRIES) {
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
            // 端末に保存したものがあればそちら (オフラインでも字幕が出る)
            if (localCopy?.captions !== undefined) {
                drawn = readSup(new Uint8Array(await localCopy.captions.arrayBuffer()));
                paint();
                return;
            }
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
        // 出し入れの判断は `controls` が持つ (押す前に出ていたかで決める)
        else if (action.kind === 'controls') controls.toggle();
        else {
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
    const shooter = snapshotter(controls);

    /** 断られたときだけ知らせる。消せたときは一覧へ戻るので出す先が無い */
    const notices = $derived<Notice[]>([
        ...errorNotice(form, 'watch-delete'),
        ...shooter.notices,
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
    function snapshot(): void {
        // 字幕を出しているときだけ重ねる
        void shooter.take(video, captions && showing !== null ? overlay : null, () => `${rec.name} - ${clock(at)}`);
    }
</script>

<svelte:head><title>{rec.name} - denpa</title></svelte:head>
<svelte:window onclick={deleting.stand} onkeydown={keys} />

<!--
    **ライブ (`/live`) と同じ形。** 映像が左、読むものが右。**中の作りまで同じ**
    にしてある — 絵は `aspect-video max-h-full` の枠に入れ、右の列は固定幅で
    残りの高さをぜんぶ使う。

    **右を映像の高さに合わせない。** 揃えていた頃は、詳細を `absolute` で浮かせて
    grid の行の高さを映像だけで決めさせていた。**揃いはするが、それだけのために
    ライブと違う作りを1つ抱える**ことになるうえ、縦長の画面では絵が低くなるので、
    下に画面半分が空いているのに説明だけ狭い窓から覗くことになっていた
    (下限 `min-h-[24rem]` はその継ぎ当て)。**画面の残りをぜんぶ使う**ほうが、
    読むものとしては素直。

    **タブレットからは2段組** (`md` = 768px)。縦のiPadでちょうど入る幅で、
    そこを境にすると「持ち替えたら形が変わる」ことがない。狭い画面では
    **映像が上、詳細が下**。指で開いたときはそもそも全画面に入っているので、
    ここが見えるのは全画面を抜けたあと。

    **周りの余白は足さない。** 外の `<main>` が既に `p-4 md:p-6` を持っている
    ([+layout.svelte](../../+layout.svelte))。ここでも足していた頃は、他の画面より
    一回り内側から始まっていたうえ、**その足したぶんだけ縦がはみ出して**
    ページごとスクロールバーが出ていた。

    **横幅の頭打ちも置かない。** `max-w-[1800px]` で中央に寄せていた頃は、
    それより広い画面で**左右だけ余白が増えて**いた (実測 1880px でライブ 24px に
    対して 40px)
-->
<div class="flex flex-col gap-4 md:h-full md:min-h-0 md:flex-row" data-testid="watch">
    <!-- **映像を先に書く。** 縦積みになったときに上へ来るのはこちら -->
    <section class="flex min-w-0 flex-1 flex-col md:min-h-0">
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
            <!--
                **枠の形はライブと同じ** (`aspect-video max-h-full`)。画面の高さから
                引き算した決め打ち (`100dvh-9rem`) を持たせていた頃は、その値が
                ヘッダーや帯の厚みと合っているかを目で確かめるしかなかった。
                絵が 16:9 でないときは中で letterbox されるだけ (`<video>` は
                既定で `object-fit: contain`)。

                **低くしすぎない** (`min-h-56` = 224px)。上下と右に帯を重ねている
                ので、絵がそれより低いと**帯どうしが重なって**押せなくなる
            -->
            <!-- 舞台の配線は3画面で共通 (PlayerStage)。全画面はこちら側の癖 (開いた時点で入る) が要るので自前のまま -->
            <PlayerStage {controls} testid="watch-stage" bind:element={stage}>
                {#snippet children(_stage)}
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
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
                <!-- **映像の箱。BML はこれを動かす** (`DataBroadcast` の place)。ライブと同じ -->
                <div bind:this={mediaBox} class="absolute inset-0">
                <video
                    bind:this={video}
                    {src}
                    class="h-full w-full bg-black"
                    playsinline
                    onclick={press}
                    onplay={() => {
                        playing = true;
                        // 出たので、拾い直しは済み。次に切れたらまた1秒から待つ
                        retries = 0;
                        resuming = false;
                        controls.stir();
                    }}
                    onpause={() => {
                        playing = false;
                    }}
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
                    remote={(press) => (dataPress = press)}
                    postal={data.broadcast.postalCode}
                    network={false}
                />

                <!--
                    **放送の字幕。** 映像と同じ枠に、映像の画素そのままの大きさで
                    敷いて、CSS で伸ばす (`object-contain`)。**押す邪魔をしない**
                    (`pointer-events-none`) — 下の絵を押して止められなくなる
                -->
                <canvas
                    bind:this={overlay}
                    class="pointer-events-none absolute"
                    data-testid="watch-captions-canvas"
                    data-on={captions && hasCaptions}
                    aria-hidden="true"
                ></canvas>

                {#if continued}
                    <!--
                        **続きから出したことを言う。** 黙って途中から始まると、
                        壊れているのか飛んだのか分からない。top-14 は操作列よけ
                    -->
                    <StageNote testid="watch-resumed" wrap="inset-x-0 top-14 justify-center">
                        続きから再生しています
                    </StageNote>
                {/if}

                {#if resuming}
                    <!--
                        **繋ぎ直しの最中は、そう言う。** サーバの入れ替えで
                        切れると数十秒帰ってこないので、黙って止まっていると
                        壊れたように見える
                    -->
                    <div
                        class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
                        data-testid="watch-resuming"
                    >
                        <span class="rounded-box flex items-center gap-2 bg-black/60 px-3 py-2 text-white">
                            <span class="loading loading-spinner loading-sm"></span>
                            繋ぎ直しています
                        </span>
                    </div>
                {/if}

                {#if skipped}
                    <!-- **黙って跳ばない。** 何が起きたか言わないと壊れて見える -->
                    <StageNote testid="watch-skipped" wrap="inset-x-0 top-14 justify-center">
                        CMを飛ばしました
                    </StageNote>
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
                        <!-- src は端末のコピー (blob:) のことがあるので、落とす口は API を名指す -->
                        <a
                            class="btn btn-sm"
                            href="/api/recordings/{rec.id}/file?source=encoded&download=1"
                            download>ダウンロード</a
                        >
                    </div>
                {/if}

                <!--
                    **右端は「観るのをやめる」ための列。**

                    閉じる・切り抜く・消すは、観ながら使う操作 (音・字幕・送り) とは
                    押す頻度も並べる理由も違う。1本の帯に混ぜていた頃は押すものが
                    12個並び、**番組の名前が入る幅が残らなかった** (実機のタブレットで
                    名前が折り返し、帯が二段になっていた)。

                    **削除をいちばん下に置く。** 隣を押すつもりで当たっても、
                    聞き返しがあるので消えはしない
                -->
                <ControlBar side shown={controls.shown} testid="watch-side">
                    <a
                        class="{OVERLAY_BTN} btn-circle {OVERLAY}"
                        href="/"
                        aria-label="一覧へ戻る"
                        data-testid="watch-close"
                    >
                        <Icon path={CLOSE} />
                    </a>
                    <!--
                        **データ放送 (d) は右上に置く。** 焼いてある録画でだけ出す
                        (`data.hasData`)。データ操作 (リモコン) を右カラムに出すので、
                        入口の d も右にまとめた。押すと右カラムに `Remote` が出る。
                        ライブと違い、取りに行くのはサーバではなく焼いた変化ログ
                    -->
                    {#if data.hasData}
                        <ControlButton
                            path={DATA}
                            label={showData ? 'データ放送を消す' : 'データ放送を出す'}
                            on={showData}
                            testid="watch-data-button"
                            onclick={toggleData}
                        />
                    {/if}
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
                                path={CHECK}
                                label="削除する"
                                danger
                                submit
                                testid="watch-delete-confirm"
                            />
                        {:else}
                            <ControlButton
                                path={TRASH}
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

                    <div
                        class="mt-1 flex flex-wrap items-center gap-1 text-white"
                        data-testid="watch-buttons"
                    >
                        <!--
                            **並びはライブと同じ。** 再生・音・字幕が左から順で、
                            全画面がいちばん右。画面を移っても同じ場所にあると、
                            見ないでも押せる。

                            **10秒送り・戻しは置いていない。** PCは矢印キー、
                            指は左右の端を素早く2回 (`ts/watch.ts` の `tap`) で
                            できる — 絵の上に常に2つ置いておくほどの用ではない。
                            **閉じる・切り抜き・削除は右の列** (上の `watch-side`)
                        -->
                        <ControlButton
                            path={playing ? PAUSE : PLAY}
                            label={playing ? '一時停止' : '再生'}
                            testid="watch-play"
                            onclick={togglePlay}
                        />
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
                                    <span
                                        class="badge badge-success badge-xs shrink-0 self-center"
                                        data-testid="watch-local"
                                    >
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
                                    ・ <span data-testid="watch-chapter">{current.title}</span>
                                {/if}
                            {/snippet}
                        </InfoBlock>

                        <!-- 早送り。**ライブの追っかけと同じ並び・同じ見た目** -->
                        <SpeedMenu
                            testid="watch-speed"
                            label="再生の速さ"
                            {speed}
                            onselect={(value) => setSpeed(value)}
                        />

                        <ControlButton
                            path={full ? SHRINK : EXPAND}
                            label={full ? '全画面をやめる' : '全画面'}
                            testid="watch-full"
                            onclick={toggleFull}
                        />
                    </div>
                </ControlBar>
                {/snippet}
            </PlayerStage>
        {/if}
    </section>

    <!--
        **右は番組の中身。全部ここに出す。**

        以前はモーダルで開いていた。**映像の上に被さる**ので、観ながら読めない —
        観る画面で「あらすじを読みながら流す」ができないのは本末転倒だった。
        中身は一覧のモーダルと同じ部品 (`ProgramFacts`) で、枠だけこちらが持つ。

        **中身が長ければ、ここだけが巻き取られる** (`overflow-y-auto`)。
        番組の説明は数百字あるので、ページごと動くと映像が画面から出ていく。
        **押すものは下に貼り付けて、いつでも見えるようにする** (`shrink-0`)。

        **高さは画面の残りぜんぶ。幅も枠の作りもライブの右の列と同じ**
        ([live/+page.svelte](../../live/+page.svelte))。映像の高さに揃えていた頃は、
        そのためだけに `absolute` で浮かせる作りをここだけ抱えていた (上の説明)
    -->
    <!-- 枠は追っかけと同じ部品 (FactsAside)。幅・巻き取り・貼り付けの決めごとはそちら -->
    <FactsAside testid="watch-facts">
        {#snippet top()}
            <!--
                **データ放送のリモコンは、映像の上ではなく右の列に出す** — ライブと同じ
                (live/+page.svelte)。以前は映像に重ねていたので、上下の帯や字幕とぶつかっていた。
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

        <div class="text-base-content/60 mt-3 text-sm" data-testid="watch-meta">
            {recordedDuration(rec)} ・ {size(rec.ts_size)}
        </div>

        {#snippet footer()}
            <!--
                **「一覧へ」は置かない。** 絵の右上の「×」が同じ行き先で、
                2つ並べる意味が無かった
            -->
            <a
                class="btn btn-sm btn-outline"
                href="/api/recordings/{rec.id}/file?download=1&source=encoded"
                download
                data-testid="watch-download"
            >
                ダウンロード
            </a>
        {/snippet}
    </FactsAside>
</div>

<Toasts {notices} source={form} />
