/**
 * **放送の時計 (PCR) を、受け取った時刻と映像の物差しに結びつける。**
 *
 * ライブで出している「遅延」は、これまで**手元の貯まりの差**
 * (`buffered.end - currentTime`) でした。あれは「あと何秒ぶん持っているか」で
 * あって、放送との差ではありません — チューナーの選局から ffmpeg の焼き上がり、
 * 回線まで、**上流でかかった時間はどれも入っていない**。
 *
 * 放送は PCR という時計を運んでいて、映像の PTS も同じ時計で打たれています。
 * PCR を「サーバが受け取った時刻」と組にしておけば、「いま映しているコマは、
 * 隣に置いたテレビなら何時何分に映るものか」が言えます。
 *
 *     受け取った時刻(unixMs, サーバの時計) ─── そのとき着いた PCR (90kHz)
 *
 * ffmpeg は入口の時刻を 0 に寄せて出すので (`-copyts` を付けていない。理由は
 * `server/live.ts`)、焼いたものの物差しに直すには**寄せたぶんを引く**だけです。
 * 引く量は ffmpeg 自身が入口で言ってくる (`Input #0 ... start: 72575.147089`)。
 * 出口でも同じだけしか寄っていないことは実測で確かめてある (docs/stream.md)。
 *
 * **PCR は 26.5 時間で一周します** (33ビット)。またいだら結びつけ直すだけに
 * してあります — 巻き戻ったように見えたぶんを足し込む作りにすると、
 * 選局直後の飛びまで拾って**時刻が何時間もずれる**ほうが怖い。
 *
 * ## 放送の時刻 (TDT/TOT) は使わない
 *
 * 以前は TDT と組にしていましたが、**TDT は局ごとに固定でずれています**。
 * 受け取った時刻 (NTP で合わせたサーバの時計) と突き合わせると、地上波9局で
 * -0.72〜+0.90秒 (テレ東 -0.41、tvk +0.90、フジ -0.72)。秒未満の端数も局ごとに
 * 同じところで入ってくるので、何本待っても寄りません。その差がそのまま
 * 「放送から」に出て、Eテレでは手元の貯まりより小さい値になっていました。
 *
 * 比べる相手 (`now`) もサーバの時計なので、**時計の絶対値はどこにも要りません**。
 *
 * ## いちばん早く着いた組を採る
 *
 * 受け取るのは塊ごとで、ffmpeg が詰まれば読むのも遅れます。遅れた組を採ると
 * そのぶん「放送から」が小さく出るので、**`受け取った時刻 − PCR` がいちばん
 * 小さい組**を採ります。ただし PCR とサーバの時計は別の水晶なので少しずつずれる —
 * 永久には持たず、**30秒ごとに選び直します** (直前の区切りのぶんも残して比べる)
 */

import { PacketStream, PID_PAT, parsePat, SectionAssembler, TABLE_PMT } from './psi';

/** PCR の刻み。映像の PTS と同じ */
const CLOCK = 90_000;
/** 33ビットで一周する長さ (秒)。26.5 時間ほど */
const WRAP = 2 ** 33 / CLOCK;
/** 組を選び直す区切り (ms)。水晶どうしのずれは 30秒で 1ms にも届かない */
const WINDOW = 30_000;

/** 受け取った時刻と、そのとき着いた PCR */
export interface Anchor {
    /** そのとき着いた PCR (秒) */
    pcr: number;
    /** サーバが受け取った時刻 (unix ms) */
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
    const control = (packet[3]! >> 4) & 0x03;
    if (control !== 2 && control !== 3) return Number.NaN;
    const length = packet[4]!;
    if (length < 7) return Number.NaN;
    // PCR_flag
    if ((packet[5]! & 0x10) === 0) return Number.NaN;
    const base =
        packet[6]! * 2 ** 25 +
        packet[7]! * 2 ** 17 +
        packet[8]! * 2 ** 9 +
        packet[9]! * 2 +
        (packet[10]! >> 7);
    return base / CLOCK;
}

/** `受け取った時刻 − PCR` (秒)。**小さいほど遅れずに着いた組** */
function lag(anchor: Anchor): number {
    return anchor.unixMs / 1000 - anchor.pcr;
}

/**
 * 1局に絞った TS から、PCR と受け取った時刻の組を拾い続ける。
 *
 * **絞ったあとを食わせる** (`ServiceFilter` の出口)。あちらは PAT・PMT と
 * その局の ES を残すので、PCR を運ぶ ES も通っている
 */
export class BroadcastClock {
    private readonly packets = new PacketStream();
    private readonly pat = new SectionAssembler(PID_PAT);
    private pmt: SectionAssembler | null = null;
    private pmtPid: number | null = null;
    private pcrPid: number | null = null;
    private pcr = Number.NaN;
    /** いまの区切りで採っている組 */
    private current: Anchor | null = null;
    /** 1つ前の区切りで採った組。**区切りの直後に遅れた組しか無くても困らないように** */
    private previous: Anchor | null = null;
    private windowFrom = Number.NaN;

    /** いちばん遅れずに着いた組。まだ PCR を読めていなければ null */
    get anchor(): Anchor | null {
        const current = this.current;
        const previous = this.previous;
        if (current === null || previous === null) return current ?? previous;
        return lag(previous) < lag(current) ? previous : current;
    }

    /** 直近の PCR (秒)。まだ読めていなければ NaN */
    get now(): number {
        return this.pcr;
    }

    /**
     * @param receivedAt その塊を受け取った時刻 (unix ms, サーバの時計)。
     *   塊の中の PCR はどれもこの時刻で組にする — 早く着いた PCR ほど遅れて
     *   見えるだけで、塊の最後の PCR がいちばん小さく出て選ばれる
     */
    feed(chunk: Uint8Array, receivedAt = Date.now()): void {
        for (const packet of this.packets.feed(chunk)) {
            const pid = ((packet[1]! & 0x1f) << 8) | packet[2]!;
            if (this.pcrPid === null || pid === this.pcrPid) {
                const at = readPcr(packet);
                if (Number.isFinite(at)) this.onPcr(at, receivedAt);
            }
            for (const section of this.pat.feed(packet)) this.onPat(section);
            for (const section of this.pmt?.feed(packet) ?? []) this.onPmt(section);
        }
    }

    private onPcr(at: number, receivedAt: number): void {
        // 一周した (または選局で飛んだ)。結びつけ直す
        if (Number.isFinite(this.pcr) && (at < this.pcr - 1 || at > this.pcr + WRAP / 2)) {
            this.current = null;
            this.previous = null;
            this.windowFrom = Number.NaN;
        }
        this.pcr = at;
        if (!(receivedAt - this.windowFrom < WINDOW)) {
            this.previous = this.current;
            this.current = null;
            this.windowFrom = receivedAt;
        }
        const anchor = { pcr: at, unixMs: receivedAt };
        if (this.current === null || lag(anchor) < lag(this.current)) this.current = anchor;
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
        const pid = ((section[8]! & 0x1f) << 8) | section[9]!;
        // 0x1fff は「PCR を運ぶ ES は無い」の意味
        this.pcrPid = pid === 0x1fff ? null : pid;
    }
}

/**
 * ffmpeg が入口で言ってくる `start:` を読む。
 *
 *     Duration: N/A, start: 72575.147089, bitrate: N/A
 *
 * **これが 0 に寄せたぶん**。`-copyts` を付けていないので、出てくる時刻は
 * 入口の時刻からこれを引いたものになる。映像が音声より遅れて始まっても
 * 映像だけ 0 に詰められることはない (頭は同じ絵で埋まる。docs/stream.md)
 */
export function parseStart(line: string): number {
    const match = /\bstart:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (match === null) return Number.NaN;
    const at = Number(match[1]);
    return Number.isFinite(at) ? at : Number.NaN;
}
