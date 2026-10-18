import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **測るための作り物の映像** (放送は使わない)。ffmpeg の testsrc2 に粒を乗せて、放送や録画と
 * 同じ大きさ・同じ重さにする。1度作ったら置いておく。
 *
 * - `mpeg2.m2ts` … 1440x1080i 29.97 の MPEG-2 (上が先・GOP 15・B 2枚・15Mbps) と AAC。地上波と同じ形
 * - `av1.mp4` / `h264.mp4` … 1920x1080p 59.94 の fMP4 (互換モードの `/stream` と同じ箱の切り方)。
 *   変換の既定 (`bwdif=mode=send_frame`) は 29.97p だが、なめらか (59.94p) のほうが 1 枚の持ち時間が短く厳しい
 */
export const SECONDS = 30;

function ffmpeg(out: string, args: string[]): void {
    if (existsSync(out)) return;
    const work = `${out}.part`;
    const result = spawnSync(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-y', ...args, '-t', String(SECONDS), work],
        { stdio: 'inherit' },
    );
    if (result.status !== 0) throw new Error(`${out} を作れませんでした`);
    renameSync(work, out);
}

const SINE = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];
const FMP4 = [
    '-f',
    'mp4',
    '-movflags',
    '+empty_moov+default_base_moof+frag_keyframe',
    '-frag_duration',
    '500000',
];

export function media(dir: string): { mpeg2: string; av1: string; h264: string } {
    mkdirSync(dir, { recursive: true });
    const mpeg2 = join(dir, 'mpeg2.m2ts');
    const av1 = join(dir, 'av1.mp4');
    const h264 = join(dir, 'h264.mp4');
    ffmpeg(mpeg2, [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1440x1080:rate=30000/1001,noise=alls=12:allf=t,setfield=tff',
        ...SINE,
        ...['-c:v', 'mpeg2video', '-b:v', '15M', '-maxrate', '20M', '-bufsize', '9781248'],
        ...['-g', '15', '-bf', '2', '-flags', '+ilme+ildct', '-top', '1', '-aspect', '16:9'],
        ...['-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-f', 'mpegts'],
    ]);
    const p60 = ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60000/1001,noise=alls=8:allf=t'];
    ffmpeg(av1, [
        ...p60,
        ...SINE,
        ...['-c:v', 'libsvtav1', '-preset', '10', '-crf', '35', '-g', '120', '-pix_fmt', 'yuv420p'],
        ...['-c:a', 'libopus', '-b:a', '128k', '-ac', '2', ...FMP4],
    ]);
    ffmpeg(h264, [
        ...p60,
        ...SINE,
        ...[
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '23',
            '-g',
            '120',
            '-bf',
            '3',
            '-pix_fmt',
            'yuv420p',
        ],
        ...['-c:a', 'aac', '-b:a', '128k', '-ac', '2', ...FMP4],
    ]);
    return { mpeg2, av1, h264 };
}
