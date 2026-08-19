/**
 * **放送の実時刻を、映像の物差しに結びつける。**
 *
 * ライブで出している「遅延」は、これまで**手元の貯まりの差**
 * (`buffered.end - currentTime`) でした。あれは「あと何秒ぶん持っているか」で
 * あって、放送との差ではありません — チューナーの選局から ffmpeg の焼き上がり、
 * 回線まで、**上流でかかった時間はどれも入っていない**。
 *
 * 放送そのものは時刻を運んでいます (TDT / TOT)。それを PCR に結びつけておけば、
 * 「いま映しているコマは放送の何時何分のものか」が言えます。
 *
 * ## 結びつけ方
 *
 * TDT は数秒に1回しか来ないので、**来た瞬間の PCR と組にして覚えます**。
 * PCR は 90kHz で連続して流れているので、以降はそこからの差で引けます。
 *
 *     放送の実時刻(unixMs) ─── TDT が来た瞬間 ─── PCR (90kHz)
 *
 * ffmpeg は入口の時刻を 0 に寄せて出すので (`-copyts` を付けていない。理由は
 * `server/live.ts`)、焼いたものの物差しに直すには**寄せたぶんを引く**だけです。
 * 引く量は ffmpeg 自身が入口で言ってくる (`Input #0 ... start: 72575.147089`)。
 *
 * **PCR は 26.5 時間で一周します** (33ビット)。またいだら結びつけ直すだけに
 * してあります — 巻き戻ったように見えたぶんを足し込む作りにすると、
 * 選局直後の飛びまで拾って**時刻が何時間もずれる**ほうが怖い。
 *
 * ## 秒未満は、いちばん大きいものを採る
 *
 * **TDT は秒までしか持っていません** (MJD + BCD)。持っているのは切り捨てた値
 * なので、1つの組から出る時刻は**最大1秒ぶん過去に寄ります** — そのぶん
 * 「放送からの遅れ」は大きく出ます。
 *
 * 秒の変わり目ちょうどに来た TDT だけが正しい値を持つので、
 * **`実時刻 − PCR` がいちばん大きい組を採り続けます**。TDT は数秒に1回来るので、
 * 十数秒で 0.1 秒くらいまで寄ります。1つ目で決め打ちにしていた頃は、局ごとに
 * 1秒ちかく違う数字が出ていました (実測で 0.2秒 と 1.8秒)
 */

import { PID_TIME, parseTimeTable } from './eit';
import { PacketStream, PID_PAT, parsePat, SectionAssembler, TABLE_PMT } from './psi';

/** PCR の刻み。映像の PTS と同じ */
const CLOCK = 90_000;
/** 33ビットで一周する長さ (秒)。26.5 時間ほど */
const WRAP = 2 ** 33 / CLOCK;
/** TDT が持っている刻み (秒)。**これより大きく飛んだら採り直す** */
const SECOND = 1;

/** 放送の実時刻と、そのときの PCR */
export interface Anchor {
    /** そのときの PCR (秒) */
    pcr: number;
    /** 放送の実時刻 (unix ms) */
    unixMs: number;
}

/**
 * 1パケットから PCR を読む。無ければ NaN。
 *
 * PCR は適応フィールドの先頭に入っている。**基準部だけ使う** — 拡張部は
 * 27MHz ぶんの端数で、秒に直すと 1/27,000,000 なので要らない
 */
export function readPcr(packet: Uint8Array): number {
    if (packet.length < 12 || packet[0] !== 0x47) return Number.NaN;
    // 適応フィールドを持つか (2 = 適応のみ, 3 = 適応 + 中身)
    const control = (packet[3] >> 4) & 0x03;
    if (control !== 2 && control !== 3) return Number.NaN;
    const length = packet[4];
    if (length < 7) return Number.NaN;
    // PCR_flag
    if ((packet[5] & 0x10) === 0) return Number.NaN;
    const base =
        packet[6] * 2 ** 25 + packet[7] * 2 ** 17 + packet[8] * 2 ** 9 + packet[9] * 2 + (packet[10] >> 7);
    return base / CLOCK;
}

/**
 * 1局に絞った TS から、放送の実時刻と PCR の組を拾い続ける。
 *
 * **絞ったあとを食わせる** (`ServiceFilter` の出口)。あちらは PAT・PMT・
 * PID 0x14 とその局の ES を残すので、要るものは全部通っている
 */
export class BroadcastClock {
    private readonly packets = new PacketStream();
    private readonly pat = new SectionAssembler(PID_PAT);
    /** TDT は CRC を持たない。`syntax` で受ける (`bml.ts` と同じ理由) */
    private readonly time = new SectionAssembler(PID_TIME, 'syntax');
    private pmt: SectionAssembler | null = null;
    private pmtPid: number | null = null;
    private pcrPid: number | null = null;
    private pcr = Number.NaN;
    private found: Anchor | null = null;
    /** 採っている組の `実時刻 − PCR` (秒)。**大きいほうが真に近い** */
    private best = Number.NEGATIVE_INFINITY;

    /** いちばん新しい、実時刻と PCR の組。まだ揃っていなければ null */
    get anchor(): Anchor | null {
        return this.found;
    }

    /** 直近の PCR (秒)。まだ読めていなければ NaN */
    get now(): number {
        return this.pcr;
    }

    feed(chunk: Uint8Array): void {
        for (const packet of this.packets.feed(chunk)) {
            const pid = ((packet[1] & 0x1f) << 8) | packet[2];
            if (this.pcrPid === null || pid === this.pcrPid) {
                const at = readPcr(packet);
                if (Number.isFinite(at)) {
                    // 一周した (または選局で飛んだ)。結びつけ直す
                    if (Number.isFinite(this.pcr) && (at < this.pcr - 1 || at > this.pcr + WRAP / 2)) {
                        this.found = null;
                        this.best = Number.NEGATIVE_INFINITY;
                    }
                    this.pcr = at;
                }
            }
            for (const section of this.pat.feed(packet)) this.onPat(section);
            for (const section of this.pmt?.feed(packet) ?? []) this.onPmt(section);
            for (const section of this.time.feed(packet)) this.onTime(section);
        }
    }

    private onPat(section: Uint8Array): void {
        // 絞ったあとなので番組は1つだけ。最初のものを見る
        const pid = [...parsePat(section).values()][0];
        if (pid === undefined || this.pmtPid === pid) return;
        this.pmtPid = pid;
        this.pmt = new SectionAssembler(pid);
    }

    private onPmt(section: Uint8Array): void {
        if (section[0] !== TABLE_PMT || section.length < 12) return;
        const pid = ((section[8] & 0x1f) << 8) | section[9];
        // 0x1fff は「PCR を運ぶ ES は無い」の意味
        this.pcrPid = pid === 0x1fff ? null : pid;
    }

    private onTime(section: Uint8Array): void {
        if (!Number.isFinite(this.pcr)) return;
        const unixMs = parseTimeTable(section);
        if (unixMs === null) return;
        const offset = unixMs / 1000 - this.pcr;
        /*
         * **大きいほうを採る** (上の説明)。ただし1秒より大きく**下に**飛んだら
         * 採り直す — 放送が時計を合わせ直したときに、古い値を抱え込まないため
         */
        if (this.found === null || offset > this.best || offset < this.best - SECOND) {
            this.best = offset;
            this.found = { pcr: this.pcr, unixMs };
        }
    }
}

/**
 * 焼いたものの物差し (0 起点) の時刻を、放送の実時刻に直す。
 *
 * @param anchor TDT が来た瞬間の PCR と実時刻
 * @param start ffmpeg が入口で 0 に寄せたぶん (秒)。`Input #0 ... start:` の値
 * @param at 焼いたものの時刻 (秒)
 */
export function broadcastTime(anchor: Anchor, start: number, at: number): number | null {
    if (!Number.isFinite(start) || !Number.isFinite(at)) return null;
    return Math.round(anchor.unixMs + (at + start - anchor.pcr) * 1000);
}

/**
 * ffmpeg が入口で言ってくる `start:` を読む。
 *
 *     Duration: N/A, start: 72575.147089, bitrate: N/A
 *
 * **これが 0 に寄せたぶん**。`-copyts` を付けていないので、出てくる時刻は
 * 入口の時刻からこれを引いたものになる
 */
export function parseStart(line: string): number {
    const match = /\bstart:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (match === null) return Number.NaN;
    const at = Number(match[1]);
    return Number.isFinite(at) ? at : Number.NaN;
}
