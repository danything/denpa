/**
 * **焼いたものを fMP4 に詰め替えて流す** (#503。決め方は `ts/remux.ts`、受け側は `remux-player.ts`)。
 *
 * 映像は写すだけ (`-c:v copy`)、音声は Opus を AAC に焼き直す。焼き直しは音声だけなので
 * 軽く、ファイルを読む速さで進む。相手が読まなければ ffmpeg の出口が詰まって止まる
 * (`stream.ts` の `ffmpegBody` は読まれたぶんしか取りに行かない)。
 *
 * ## 位置はファイルの時刻のまま出す
 *
 * シークは頼み直す (`?from=<秒>`)。字幕・チャプター・データ放送・続きの位置は
 * どれも**ファイルの時刻**で持っているので、流れの時刻もそれに揃える:
 *
 * - `-ss` を `-i` の前に置く。映像は写すので、`from` の手前の鍵フレームから始まる
 * - `-copyts` で入口の時刻を出口まで運ぶ
 * - mp4 の多重化器は既定で頭を 0 に詰め直す。`frag_discont` で塊の時刻 (tfdt) を
 *   そのまま書かせ、`negative_cts_offsets` で B フレームのぶんを編集リストに逃がさせない
 *   (逃がすと頭がずれる。ブラウザの MSE は編集リストを当てにできない)
 * - 頭 (`from` = 0) だけは AAC の前置きと B フレームのぶん時刻が負になり、そのままでは
 *   tfdt が壊れる (負の数が符号なしで書かれる)。`make_non_negative` で全体を揃って
 *   ずらす。ずれは数十ms (手元の試しで 0.067秒) で、映像と音声の間は崩れない
 *
 * 手元の ffmpeg (9.x の開発版) で試した tfdt (秒、映像・音声の順):
 *
 *     -ss 10   8.342 (鍵フレーム)   9.979 (AAC の前置きぶん手前)
 *     -ss 30  25.025               …
 *     -ss 0    0.067                0.046
 */

import { statSync } from 'node:fs';
import type { EncodedSource, MediaFile } from '#lib/ts/remux.js';
import { config } from './config';
import { ffmpegBody, run } from './stream';

/**
 * ffmpeg の引数。**`audio` は入れ物の中の何本目の音声か** (主・副で分けて焼いてある。`encoder.ts`)。
 * 音声の無い入れ物でも降りないよう `?` を付ける
 */
export function remuxArgs(path: string, from: number, audio: number): string[] {
    return [
        '-hide_banner',
        '-nostats',
        '-loglevel',
        'error',
        ...(from > 0 ? ['-ss', from.toFixed(3)] : []),
        '-copyts',
        '-i',
        path,
        '-map',
        '0:v:0',
        '-map',
        `0:a:${audio}?`,
        '-c:v',
        'copy',
        // 元の放送 (AAC 256kbps) と録画の Opus に揃える。モノラル (デュアルモノを分けたもの) も両耳へ
        '-c:a',
        'aac',
        '-b:a',
        '256k',
        '-ac',
        '2',
        '-avoid_negative_ts',
        'make_non_negative',
        '-f',
        'mp4',
        '-movflags',
        '+empty_moov+default_base_moof+frag_discont+negative_cts_offsets',
        // 1秒ずつ。鍵フレームごと (数秒) だと、頭の絵が出るまでそのぶん待つ
        '-frag_duration',
        '1000000',
        'pipe:1',
    ];
}

/** 詰め替えて流す。閉じられたら ffmpeg も止める (`ffmpegBody`) */
export function remuxStream(path: string, from: number, audio: number): ReadableStream<Uint8Array> {
    return ffmpegBody([config.ffmpeg, ...remuxArgs(path, from, audio)], `[remux] 詰め替え ${path}`);
}

interface ProbedStream {
    codec_type?: string;
    codec_name?: string;
    profile?: string;
    level?: number;
    pix_fmt?: string;
    tags?: { title?: string; TITLE?: string };
}

/** H.264 の profile 名 → codecs の頭 (profile_idc と制約の印) */
const AVC_PROFILES: Record<string, string> = {
    Baseline: '4200',
    'Constrained Baseline': '42e0',
    Main: '4d00',
    Extended: '5800',
    High: '6400',
    'High 10': '6e00',
    'High 4:2:2': '7a00',
    'High 4:4:4 Predictive': 'f400',
};
const AV1_PROFILES: Record<string, number> = { Main: 0, High: 1, Professional: 2 };

/** 映像の codecs 文字列。知らないものは null (判断に使わない) */
function videoCodec(stream: ProbedStream | undefined): string | null {
    if (stream === undefined) return null;
    const level = typeof stream.level === 'number' && stream.level > 0 ? stream.level : null;
    if (stream.codec_name === 'h264') {
        const head = AVC_PROFILES[stream.profile ?? ''] ?? '6400';
        return `avc1.${head}${(level ?? 40).toString(16).padStart(2, '0')}`;
    }
    if (stream.codec_name === 'av1') {
        const profile = AV1_PROFILES[stream.profile ?? ''] ?? 0;
        const depth = /10/.test(stream.pix_fmt ?? '') ? '10' : '08';
        // tier は ffprobe が言わない。放送の焼き直しは Main tier
        return `av01.${profile}.${String(level ?? 8).padStart(2, '0')}M.${depth}`;
    }
    return null;
}

/** 音声の codecs 文字列 */
function audioCodec(stream: ProbedStream | undefined): string | null {
    if (stream?.codec_name === 'opus') return 'opus';
    if (stream?.codec_name === 'aac') return 'mp4a.40.2';
    return null;
}

/** ffprobe (`-show_streams -show_format` の JSON) から中身を起こす。読めなければ全部 null */
export function mediaInfo(source: EncodedSource, json: string): MediaFile {
    let parsed: { streams?: ProbedStream[]; format?: { duration?: string } } = {};
    try {
        parsed = JSON.parse(json);
    } catch {
        // 読めない。判断に使わない形で返す
    }
    const streams = parsed.streams ?? [];
    const audios = streams.filter((stream) => stream.codec_type === 'audio');
    const duration = Number(parsed.format?.duration);
    return {
        source,
        video: videoCodec(streams.find((stream) => stream.codec_type === 'video')),
        audio: audioCodec(audios[0]),
        audios: audios.map((stream) => stream.tags?.title ?? stream.tags?.TITLE ?? ''),
        duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    };
}

/** 待ち時間の上限。壊れたファイルで居座らせない */
const TIMEOUT = 15_000;

/** 読んだ中身の控え。開くたびに聞くので、同じファイル (パスと更新時刻) なら読み直さない */
const probed = new Map<string, { mtime: number; file: MediaFile }>();
/** 控えの上限。古いものから捨てる */
const KEEP = 64;

/** 焼いたファイルの中身を読む (見出しだけ。一瞬で返る) */
export async function probeMedia(source: EncodedSource, path: string): Promise<MediaFile> {
    let mtime = -1;
    try {
        mtime = statSync(path).mtimeMs;
    } catch {
        // 無い。読んでも同じなので null で返る
    }
    const held = probed.get(path);
    if (held !== undefined && held.mtime === mtime) return { ...held.file, source };
    const result = await run(
        [config.ffprobe, '-v', 'error', '-show_streams', '-show_format', '-print_format', 'json', path],
        { timeoutMs: TIMEOUT, stdout: true },
    );
    const file = mediaInfo(source, result.code === 0 ? new TextDecoder().decode(result.stdout) : '');
    if (result.code === 0) {
        probed.delete(path);
        probed.set(path, { mtime, file });
        if (probed.size > KEEP) probed.delete(probed.keys().next().value as string);
    }
    return file;
}
