/// <reference lib="webworker" />
/**
 * **端末に保存した録画 (Matroska) を canvas に描く**、worker の中の半分 (`messages.ts` の `mkv`)。
 *
 * 保存してあるのはエンコード済みの mkv (H.264 + AAC か AV1 + Opus。字幕の軌道も入っている)。
 * **fMP4 に組み直さず、読んだコマをそのまま fMP4 の道 (`fmp4.ts` の `Fmp4Video`) へ渡す** — 解く・描く・
 * 音・時計・飛び先より前を描かない (`floor`) はそちらのまま。ここが受け持つのは:
 *
 * - 軌道の形 (`ts/mkv-media.ts` の `asFmp4Track`) を渡す。音は選んだ1本だけ (`audio`。何本目か)
 * - **解く順の時刻 (dts) を起こす。** Matroska のコマが持つのは見せる時刻だけで、H.264 の B フレームは
 *   順が入れ替わる。解く順に並んだコマの先 `REORDER` 枚の見せる時刻のうち、いちばん早いものを
 *   そのコマの dts にする (見せる時刻を並べ直したものに近くなる)。そのぶん渡すのが数コマ遅れる
 */

import type { Fmp4Sample } from '#lib/ts/fmp4.js';
import { asFmp4Track, type MkvBlock, MkvDemuxer } from '#lib/ts/mkv-media.js';
import type { Fmp4Video } from './fmp4';

/** dts を起こすのに見る先のコマの数。B フレームの並べ替えの深さより多めに */
const REORDER = 4;
/** 1コマの長さが書いていないときの目安 (ナノ秒)。29.97 コマ */
const FRAME_NS = 33_366_667;

export class MkvInput {
    private demuxer = new MkvDemuxer();
    private video: number | null = null;
    private audio: number | null = null;
    /** 1コマの長さ (TimestampScale の刻み) */
    private frame = 1;
    /** dts を決めかねて待たせている映像のコマ (解く順) */
    private held: MkvBlock[] = [];

    /**
     * @param target 渡す先 (fMP4 の道)
     * @param audioIndex 何本目の音声を鳴らすか (0 から。音の軌道の並び順)
     */
    constructor(
        private readonly target: Fmp4Video,
        private audioIndex = 0,
    ) {}

    /** 音声を選び直す。**次の頭 (頼み直し) から効く** */
    selectAudio(index: number): void {
        this.audioIndex = index;
    }

    /** 飛んだ。頭から読み直す (画面が頭と飛び先の Cluster を繋いで流してくる) */
    reset(): void {
        this.demuxer = new MkvDemuxer();
        this.video = null;
        this.audio = null;
        this.held = [];
    }

    feed(bytes: Uint8Array): void {
        const { tracks, blocks } = this.demuxer.feed(bytes);
        if (tracks !== null) {
            const scale = this.demuxer.scale;
            const video = tracks.find((t) => t.kind === 'video' && t.codec !== null) ?? null;
            const audios = tracks.filter((t) => t.kind === 'audio');
            const audio = audios[this.audioIndex] ?? audios[0] ?? null;
            this.video = video?.number ?? null;
            this.audio = audio?.number ?? null;
            this.frame = Math.max(1, Math.round((video?.defaultDuration ?? FRAME_NS) / scale));
            this.target.configure(
                [video, audio].flatMap((t) => {
                    const made = t === null ? null : asFmp4Track(t, scale);
                    return made === null ? [] : [made];
                }),
            );
        }
        const samples: Fmp4Sample[] = [];
        for (const block of blocks) {
            if (block.track === this.audio) {
                samples.push({
                    track: block.track,
                    dts: block.at,
                    pts: block.at,
                    duration: 0,
                    key: true,
                    data: block.data,
                });
            } else if (block.track === this.video) {
                this.held.push(block);
                if (this.held.length > REORDER) samples.push(this.release());
            }
        }
        if (samples.length > 0) this.target.push(samples);
    }

    /** 待たせている頭の1枚を、dts を付けて出す */
    private release(): Fmp4Sample {
        const block = this.held.shift() as MkvBlock;
        const dts = Math.min(block.at, ...this.held.map((b) => b.at));
        return {
            track: block.track,
            dts,
            pts: block.at,
            duration: this.frame,
            key: block.key,
            data: block.data,
        };
    }
}
