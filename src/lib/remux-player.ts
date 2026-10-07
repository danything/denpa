/**
 * **詰め替えた fMP4 を `<video>` に流す** (#503。決め方は `ts/remux.ts`、作り方は `server/remux.ts`)。
 *
 * 観る画面はそれまでどおり `<video>` の `currentTime`・`duration`・`playbackRate` を触るだけで
 * 済むようにする。ここが受け持つのは、跳んだ先が溜まっていなければ**そこから頼み直す**ことと、
 * 先へ溜めすぎないことだけ。
 *
 * - **尺は先に言う** (`duration`)。バーは最初から全長で出て、続きの位置へも跳べる
 * - **流れの時刻はファイルの時刻のまま** (`server/remux.ts`)。字幕・チャプター・データ放送は
 *   `currentTime` で引いているので、そのまま合う
 * - 溜めるのは先 `AHEAD` 秒まで、後ろは `BEHIND` 秒まで。iPhone は溜められる量が小さい
 * - `ManagedMediaSource` (iPhone) は**送り込む頃合いをブラウザが言う**。言われていない間は読まない
 * - 切れたら観ていた位置から頼み直す (1秒→2秒→…10秒で頭打ち、続けて8回で諦める)。
 *   観る画面の拾い直し (`recover`) と同じ数
 */

import type { PickedMediaSource } from '#lib/ts/media-source.js';
import { aheadOf, covers, type Ranges } from '#lib/ts/remux.js';

/** 先へ溜める上限 (秒) */
const AHEAD = 60;
/** 後ろに残す長さ (秒)。これより前は捨てる */
const BEHIND = 30;
/** 読んでいる流れの尻からこれだけ先までは、頼み直さずに届くのを待つ (秒。`covers`) */
const SLACK = 15;
/** 続けて頼み直す上限 */
const RETRIES = 8;

export type RemuxState = 'flowing' | 'retrying' | 'failed';

export interface RemuxOptions {
    /** 頼む先。`from` 秒から、`audio` 本目の音声で */
    url(from: number, audio: number): string;
    /** `remuxType` */
    codecs: string;
    /** 尺 (秒) */
    duration: number;
    /** 観はじめる位置 (秒。続きから) */
    start: number;
    /** 何本目の音声で始めるか */
    audio: number;
    /** 繋ぎ直している・諦めた・戻った */
    state(state: RemuxState): void;
}

export interface RemuxPlayer {
    /** 音声を選び直す。**いまの位置から頼み直す** (入れ物の中の1本だけを詰めているため) */
    setAudio(index: number): void;
    /** 畳む。読んでいる流れを切る (サーバの ffmpeg も止まる) */
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
    /** 頼み直すたびに増やす。古い流れの続きを捨てる目印 */
    let run = 0;
    let controller: AbortController | null = null;
    /** 読んでいる流れの頼んだ位置。読んでいなければ null */
    let loadingFrom: number | null = null;
    let audio = options.audio;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    /** 溜めすぎて待っている読み手を起こす */
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

    /** 1つ頼んで、終わるまで待つ。読めない中身なら投げる */
    async function update(job: (target: SourceBuffer) => void): Promise<void> {
        const target = buffer;
        if (target === null) return;
        await idle();
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
    async function trim(): Promise<boolean> {
        const cut = video.currentTime - BEHIND;
        const first = buffered()[0];
        if (first === undefined || first[0] >= cut) return false;
        await update((target) => target.remove(0, cut));
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
                await update((target) => target.appendBuffer(data as BufferSource));
                return;
            } catch (error) {
                // 溜めきれない。後ろを捨てて入れ直す。捨てるものが無ければ観て減るのを待つ
                if (!(error instanceof DOMException && error.name === 'QuotaExceededError')) throw error;
                if (!(await trim())) {
                    await new Promise<void>((resolve) => {
                        wake = resolve;
                    });
                }
            }
        }
    }

    /** `from` 秒から頼み直す。溜まっていたものは捨てる */
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
            // 前の流れの読みかけを落とす。尻まで読み終えて閉じていれば、足せば開き直る
            if (media.readyState === 'open') buffer.abort();
            if (buffered().length > 0) await update((target) => target.remove(0, Number.POSITIVE_INFINITY));
            if (mine !== run) return;
            const response = await fetch(options.url(from, audio), { signal: abort.signal });
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
                if (video.currentTime - (buffered()[0]?.[0] ?? video.currentTime) > BEHIND * 2) await trim();
            }
            if (mine !== run) return;
            loadingFrom = null;
            // 尻まで届いた。終わりを言わないと、最後で止まったまま `ended` が来ない
            await idle();
            if (mine === run && media.readyState === 'open') media.endOfStream();
        } catch (error) {
            if (mine !== run || closed) return;
            loadingFrom = null;
            // 切れた (繋がらない・途中で落ちた・サーバの 5xx) なら頼み直す。読めない中身
            // (SourceBuffer が断った) と 4xx は何度やっても同じ。画面が落とす口を出す
            if (
                video.error !== null ||
                !(error instanceof TypeError || /^Error: HTTP 5/.test(String(error)))
            ) {
                console.warn('[remux] 流せませんでした', error);
                options.state('failed');
                return;
            }
            retry();
        }
    }

    /** 切れた。倍々に待って、観ていた位置から頼み直す */
    function retry(): void {
        if (retries >= RETRIES) {
            options.state('failed');
            return;
        }
        const wait = Math.min(10_000, 1000 * 2 ** retries);
        retries++;
        options.state('retrying');
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void load(video.currentTime);
        }, wait);
    }

    /** 跳んだ先が溜まっておらず、待っても届かないなら、そこから頼み直す */
    const onSeeking = (): void => {
        nudge();
        if (buffer === null || retryTimer !== null) return;
        if (!covers(buffered(), video.currentTime, loadingFrom, SLACK)) void load(video.currentTime);
    };
    /**
     * 詰まった。読み終えたあとに戻った・ブラウザが捨てた (`ManagedMediaSource`) で
     * いまの位置が無ければ、頼み直す
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
            // 流れの時刻をそのまま使う (ファイルの時刻。`server/remux.ts`)
            buffer.mode = 'segments';
            /*
             * **始める位置を先に言っておく。** まだ何も無いうちに代入した位置は、尺が分かった
             * ところで効く。言わないと 0 にいると見なされ、詰まり (`waiting`) で頭から頼み直す
             */
            const start = Math.min(Math.max(0, options.start), Math.max(0, options.duration - 1));
            if (start > 0) video.currentTime = start;
            void load(start);
        },
        { once: true },
    );

    return {
        setAudio(index: number): void {
            if (index === audio) return;
            audio = index;
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
