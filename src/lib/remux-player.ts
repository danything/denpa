/**
 * **サーバがその場で流す fMP4 を `<video>` に流す** (`/api/recordings/<id>/stream`。決め方は `ts/playback.ts`、
 * 作り方は `server/playback.ts`)。詰め替え (映像は写すだけ) も、その場の変換も同じ受け方。
 *
 * 観る画面はそれまでどおり `<video>` の `currentTime`・`duration`・`playbackRate` を触るだけで
 * 済むようにする。ここが受け持つのは、飛んだ先が溜まっていなければ**そこからリクエストし直す**ことと、
 * 先へ溜めすぎないことだけ。
 *
 * - **尺は先に言う** (`duration`)。バーは最初から全長で出て、続きの位置へも飛べる
 * - **ストリームの時刻はページの物差しのまま** (`PlayAxis`)。字幕・チャプター・データ放送は
 *   `currentTime` で引いているので、そのまま合う
 * - 溜めるのは先 `AHEAD` 秒まで、後ろは `BEHIND` 秒まで。iPhone は溜められる量が小さい
 * - `ManagedMediaSource` (iPhone) は**送り込む頃合いをブラウザが言う**。言われていない間は読まない
 * - 切れたら観ていた位置からリクエストし直す (1秒→2秒→…10秒で頭打ち、続けて8回で諦める)。
 *   観る画面の繋ぎ直し (`recover`) と同じ数
 * - **サーバが混んでいて断られたら (503) リクエストし直さない** (`busy`)。その場の変換の枠が埋まっている
 *   (`server/transcode.ts`)。待っても空くとは限らないので、画面がほかの形式を勧める
 */

import type { PickedMediaSource } from '#lib/ts/media-source.js';
import {
    aheadOf,
    busyAnswer,
    covers,
    type Ranges,
    retryable,
    retryWait,
    STREAM_RETRIES,
    type StreamState,
} from '#lib/ts/playback.js';

/** 先へ溜める上限 (秒) */
const AHEAD = 60;
/** 後ろに残す長さ (秒)。これより前は捨てる */
const BEHIND = 30;
/** 読んでいるストリームの尻からこれだけ先までは、リクエストし直さずに届くのを待つ (秒。`covers`) */
const SLACK = 15;
interface RemuxOptions {
    /** リクエストする先。`from` 秒から、`audio` (`playback` の `audios` の `id`) の音声で */
    url(from: number, audio: string): string;
    /** MSE に渡す型 (`ts/playback.ts` の `streamType`) */
    codecs: string;
    /** 尺 (秒) */
    duration: number;
    /** 観はじめる位置 (秒。続きから) */
    start: number;
    /** どの音声で始めるか */
    audio: string;
    /** 繋ぎ直している・諦めた・戻った・混んでいて断られた */
    state(state: StreamState): void;
}

export interface RemuxPlayer {
    /** 音声を選び直す。**いまの位置からリクエストし直す** (選んだ1本だけを流しているため) */
    setAudio(id: string): void;
    /** 畳む。読んでいるストリームを切る (サーバの ffmpeg も止まる) */
    destroy(): void;
}

function ranges(buffered: TimeRanges): Ranges {
    const out: [number, number][] = [];
    for (let i = 0; i < buffered.length; i++) out.push([buffered.start(i), buffered.end(i)]);
    return out;
}

export function remuxPlayer(
    video: HTMLVideoElement,
    picked: PickedMediaSource,
    options: RemuxOptions,
): RemuxPlayer {
    const media = new picked.Source();
    let buffer: SourceBuffer | null = null;
    /** リクエストし直すたびに増やす。古いストリームの続きを捨てる目印 */
    let run = 0;
    let controller: AbortController | null = null;
    /** 読んでいるストリームのリクエストした位置。読んでいなければ null */
    let loadingFrom: number | null = null;
    let audio = options.audio;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    /** 溜めすぎて待っている読み込みを起こす */
    let wake: (() => void) | null = null;

    const nudge = (): void => {
        const resolve = wake;
        wake = null;
        resolve?.();
    };
    const buffered = (): Ranges => (buffer === null ? [] : ranges(buffer.buffered));

    /** SourceBuffer の手が空くまで待つ */
    function idle(): Promise<void> {
        const target = buffer;
        if (target === null || !target.updating) return Promise.resolve();
        return new Promise((resolve) =>
            target.addEventListener('updateend', () => resolve(), { once: true }),
        );
    }

    /**
     * 1つリクエストして、終わるまで待つ。読めない中身なら投げる。
     *
     * `mine` を渡したら、手が空くのを待つ間にリクエストし直されていれば (`load`) 何もしない。
     * 古いストリームの残りを、新しいストリームの捨てた後へ足さないため
     */
    async function update(job: (target: SourceBuffer) => void, mine?: number): Promise<void> {
        const target = buffer;
        if (target === null) return;
        await idle();
        if (mine !== undefined && mine !== run) return;
        await new Promise<void>((resolve, reject) => {
            const done = (): void => {
                target.removeEventListener('error', fail);
                resolve();
            };
            const fail = (): void => {
                target.removeEventListener('updateend', done);
                reject(new Error('SourceBuffer error'));
            };
            target.addEventListener('updateend', done, { once: true });
            target.addEventListener('error', fail, { once: true });
            try {
                job(target);
            } catch (error) {
                target.removeEventListener('updateend', done);
                target.removeEventListener('error', fail);
                reject(error);
            }
        });
    }

    /** 後ろの捨ててよいぶんを捨てる。捨てたら true */
    async function trim(mine: number): Promise<boolean> {
        const cut = video.currentTime - BEHIND;
        const first = buffered()[0];
        if (first === undefined || first[0] >= cut) return false;
        await update((target) => target.remove(0, cut), mine);
        return true;
    }

    /** 先へ溜めすぎていない・ブラウザが送り込んでよいと言っている、まで待つ */
    async function room(mine: number): Promise<void> {
        for (;;) {
            if (mine !== run) return;
            const streaming =
                !picked.managed || (media as MediaSource & { streaming?: boolean }).streaming !== false;
            if (streaming && aheadOf(buffered(), video.currentTime) < AHEAD) return;
            await new Promise<void>((resolve) => {
                wake = resolve;
            });
        }
    }

    async function append(data: Uint8Array, mine: number): Promise<void> {
        for (;;) {
            if (mine !== run) return;
            try {
                await update((target) => target.appendBuffer(data as BufferSource), mine);
                return;
            } catch (error) {
                // 溜めきれない。後ろを捨てて入れ直す。捨てるものが無ければ観て減るのを待つ
                if (!(error instanceof DOMException && error.name === 'QuotaExceededError')) throw error;
                if (!(await trim(mine))) {
                    await new Promise<void>((resolve) => {
                        wake = resolve;
                    });
                }
            }
        }
    }

    /** `from` 秒からリクエストし直す。溜まっていたものは捨てる */
    async function load(from: number): Promise<void> {
        const mine = ++run;
        controller?.abort();
        nudge();
        if (retryTimer !== null) clearTimeout(retryTimer);
        retryTimer = null;
        const abort = new AbortController();
        controller = abort;
        loadingFrom = from;
        try {
            await idle();
            if (mine !== run || buffer === null) return;
            // 前のストリームの読みかけを落とす。尻まで読み終えて閉じていれば、足せば開き直る
            if (media.readyState === 'open') buffer.abort();
            if (buffered().length > 0)
                await update((target) => target.remove(0, Number.POSITIVE_INFINITY), mine);
            if (mine !== run) return;
            const response = await fetch(options.url(from, audio), { signal: abort.signal });
            /*
             * **混んでいて断られたらリクエストし直さない** (その場の変換の枠が埋まっている)。デプロイの最中の 503
             * (前段が返すもの) とは言い分で見分ける
             */
            if (response.status === 503 && (await busyAnswer(response))) {
                if (mine !== run) return;
                loadingFrom = null;
                options.state('busy');
                return;
            }
            if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`);
            const reader = response.body.getReader();
            for (;;) {
                await room(mine);
                if (mine !== run) {
                    void reader.cancel().catch(() => undefined);
                    return;
                }
                const { done, value } = await reader.read();
                if (mine !== run) return;
                if (done) break;
                await append(value, mine);
                if (retries > 0) {
                    retries = 0;
                    options.state('flowing');
                }
                // 後ろを捨てるのは足したついでに。捨てる長さが溜まってから (毎回は削らない)
                if (video.currentTime - (buffered()[0]?.[0] ?? video.currentTime) > BEHIND * 2)
                    await trim(mine);
            }
            if (mine !== run) return;
            loadingFrom = null;
            // 尻まで届いた。終わりを言わないと、最後で止まったまま `ended` が来ない
            await idle();
            if (mine === run && media.readyState === 'open') media.endOfStream();
        } catch (error) {
            if (mine !== run || closed) return;
            loadingFrom = null;
            // 切れた (繋がらない・途中で落ちた・サーバの 5xx) ならリクエストし直す。読めない中身
            // (SourceBuffer が断った) と 4xx は何度やっても同じ。画面が観られる先の案内を出す
            if (video.error !== null || !retryable(error)) {
                console.warn('[remux] 流せませんでした', error);
                options.state('failed');
                return;
            }
            retry();
        }
    }

    /** 切れた。倍々に待って、観ていた位置からリクエストし直す */
    function retry(): void {
        if (retries >= STREAM_RETRIES) {
            options.state('failed');
            return;
        }
        const wait = retryWait(retries);
        retries++;
        options.state('retrying');
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void load(video.currentTime);
        }, wait);
    }

    /** 飛んだ先が溜まっておらず、待っても届かないなら、そこからリクエストし直す */
    const onSeeking = (): void => {
        nudge();
        if (buffer === null || retryTimer !== null) return;
        if (!covers(buffered(), video.currentTime, loadingFrom, SLACK)) void load(video.currentTime);
    };
    /**
     * 詰まった。読み終えたあとに戻った・ブラウザが捨てた (`ManagedMediaSource`) で
     * いまの位置が無ければ、リクエストし直す
     */
    const onWaiting = (): void => {
        nudge();
        if (buffer === null || retryTimer !== null || loadingFrom !== null) return;
        if (aheadOf(buffered(), video.currentTime) === 0) void load(video.currentTime);
    };

    video.addEventListener('seeking', onSeeking);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('timeupdate', nudge);
    media.addEventListener('startstreaming', nudge);

    /*
     * **ManagedMediaSource は AirPlay を断らないと開かない** (`ts/media-source.ts`)。
     * 付ける前に立てておく
     */
    if (picked.managed) video.disableRemotePlayback = true;
    const objectUrl = URL.createObjectURL(media);
    video.src = objectUrl;
    media.addEventListener(
        'sourceopen',
        () => {
            URL.revokeObjectURL(objectUrl);
            if (closed) return;
            media.duration = options.duration;
            buffer = media.addSourceBuffer(options.codecs);
            // ストリームの時刻をそのまま使う (ページの物差し。`server/playback.ts`)
            buffer.mode = 'segments';
            /*
             * **始める位置を先に言っておく。** まだ何も無いうちに代入した位置は、尺が分かった
             * ところで効く。言わないと 0 にいると見なされ、詰まり (`waiting`) で頭からリクエストし直す
             */
            const start = Math.min(Math.max(0, options.start), Math.max(0, options.duration - 1));
            if (start > 0) video.currentTime = start;
            void load(start);
        },
        { once: true },
    );

    return {
        setAudio(id: string): void {
            if (id === audio) return;
            audio = id;
            void load(video.currentTime);
        },
        destroy(): void {
            closed = true;
            run++;
            controller?.abort();
            nudge();
            if (retryTimer !== null) clearTimeout(retryTimer);
            video.removeEventListener('seeking', onSeeking);
            video.removeEventListener('waiting', onWaiting);
            video.removeEventListener('timeupdate', nudge);
            media.removeEventListener('startstreaming', nudge);
        },
    };
}
