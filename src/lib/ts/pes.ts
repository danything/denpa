/**
 * **1局に絞った TS から、映像と音声の PES を取り出す** (ライブを生で送る道。docs/stream.md §5.5)。
 *
 * 焼く道ではここを ffmpeg がやっていた。生で送ると TS がそのままブラウザへ来るので、
 * 絵は WASM の復号器 (`wasm/mpeg2`)、音はブラウザの AudioDecoder に渡す前に、
 * こちらで PES に戻す。サーバが1局に絞ってある (`ServiceFilter`) ので、PAT に
 * 載っている局は1つだけ — その PMT を読んで、映像1本と音声 (並んだ順) を拾う。
 *
 * DOM も WASM も触らないので、ここだけ単体で確かめられる (`pes.test.ts`)。
 */

import { PACKET, PacketStream, PID_PAT, parsePat, pmtStreams, SectionAssembler } from './psi';

/** PTS の一周 (33ビット)。26.5 時間 */
export const WRAP = 2 ** 33;

/** PMT の stream_type。**放送の映像は MPEG-2、音声は ADTS の AAC** (ARIB STD-B32) */
const STREAM_MPEG2 = 0x02;
const STREAM_AAC = 0x0f;

export interface Pes {
    pid: number;
    kind: 'video' | 'audio';
    /** 90kHz。無ければ null */
    pts: number | null;
    /** 90kHz。PTS と同じなら書かれないので、そのときは PTS を入れる */
    dts: number | null;
    /** PES の中身 (ES) */
    data: Uint8Array;
}

/** PMT から分かったこと。**音声は並んだ順** — 画面の「何本目の音声」(`AudioTrack.stream`) と揃う */
export interface Streams {
    video: number | null;
    audio: number[];
}

/** 5バイトの PTS / DTS を読む (ISO/IEC 13818-1 2.4.3.7) */
function readStamp(data: Uint8Array, at: number): number {
    return (
        ((data[at]! >> 1) & 0x07) * 2 ** 30 +
        (data[at + 1]! << 22) +
        ((data[at + 2]! >> 1) << 15) +
        (data[at + 3]! << 7) +
        (data[at + 4]! >> 1)
    );
}

/** PES の頭を読んで中身を切り出す。**壊れていれば null** (頭の 00 00 01 が無いなど) */
export function parsePes(
    data: Uint8Array,
): { pts: number | null; dts: number | null; data: Uint8Array } | null {
    if (data.length < 9 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return null;
    const flags = data[7]! >> 6;
    const headerLength = data[8]!;
    const start = 9 + headerLength;
    if (start > data.length) return null;
    const length = (data[4]! << 8) | data[5]!;
    // 長さが書いてあればそこまで (後ろに詰め物が付くことがある)。0 は「次の頭まで」
    const end = length === 0 ? data.length : Math.min(data.length, 6 + length);
    const pts = flags & 0x02 && data.length >= 14 ? readStamp(data, 9) : null;
    const dts = flags === 0x03 && data.length >= 19 ? readStamp(data, 14) : pts;
    return { pts, dts, data: data.subarray(start, end) };
}

interface Partial {
    parts: Uint8Array[];
    size: number;
    /** 書いてある長さ (頭の6バイトを含む)。0 なら次の頭まで */
    expected: number;
}

/**
 * TS を食わせて PES を吐く。**選局し直したら作り直す** (前の局の切れ端を持ち越さない)。
 *
 * 映像は長さ 0 (次の頭で終わりが分かる) なので1枚ぶん遅れて出るが、貯めの中に収まる。
 * 音声は長さが書いてあるので揃った時点で出す
 */
export class PesDemuxer {
    private readonly packets = new PacketStream();
    private readonly pat = new SectionAssembler(PID_PAT);
    private pmt: SectionAssembler | null = null;
    private pmtPid: number | null = null;
    private readonly partial = new Map<number, Partial>();
    /** いま分かっている ES。**変わったら `feed` の返りで知らせる** */
    streams: Streams = { video: null, audio: [] };
    /** 解く音声の PID。**選ばれた1本だけ**組み立てる (他は捨てる) */
    audioPid: number | null = null;
    /** 何本目の音声を拾うか (`AudioTrack.stream`)。無ければ先頭に落とす */
    audioIndex = 0;

    feed(chunk: Uint8Array): { pes: Pes[]; changed: boolean } {
        const out: Pes[] = [];
        let changed = false;
        for (const packet of this.packets.feed(chunk)) {
            // 誤りの印が立っているもの・スクランブルが残っているものは読まない
            if (packet[1]! & 0x80 || packet[3]! & 0xc0) continue;
            const pid = ((packet[1]! & 0x1f) << 8) | packet[2]!;
            if (pid === PID_PAT) {
                for (const section of this.pat.feed(packet)) this.readPat(section);
                continue;
            }
            if (pid === this.pmtPid && this.pmt !== null) {
                for (const section of this.pmt.feed(packet)) changed = this.readPmt(section) || changed;
                continue;
            }
            if (pid === this.streams.video) this.collect(packet, pid, 'video', out);
            else if (pid === this.audioPid) this.collect(packet, pid, 'audio', out);
        }
        return { pes: out, changed };
    }

    /** 音声を選び直す。**組み立てかけのものは捨てる** (前の音声の続きになる) */
    selectAudio(index: number): void {
        this.audioIndex = index;
        const next = this.streams.audio[index] ?? this.streams.audio[0] ?? null;
        if (next !== this.audioPid && this.audioPid !== null) this.partial.delete(this.audioPid);
        this.audioPid = next;
    }

    private readPat(section: Uint8Array): void {
        // 絞ってあるので1つだけのはず。万一複数あっても先頭を採る
        const first = [...parsePat(section).values()][0];
        if (first === undefined || first === this.pmtPid) return;
        this.pmtPid = first;
        this.pmt = new SectionAssembler(first);
    }

    private readPmt(section: Uint8Array): boolean {
        let video: number | null = null;
        const audio: number[] = [];
        for (const [type, pid] of pmtStreams(section)) {
            if (type === STREAM_MPEG2 && video === null) video = pid;
            else if (type === STREAM_AAC) audio.push(pid);
        }
        const same =
            video === this.streams.video &&
            audio.length === this.streams.audio.length &&
            audio.every((pid, i) => pid === this.streams.audio[i]);
        if (same) return false;
        this.streams = { video, audio };
        this.partial.clear();
        this.selectAudio(this.audioIndex);
        return true;
    }

    private collect(packet: Uint8Array, pid: number, kind: Pes['kind'], out: Pes[]): void {
        const control = (packet[3]! >> 4) & 0x03;
        if (control === 0 || control === 2) return;
        let offset = 4;
        if (control === 3) offset += 1 + packet[4]!;
        if (offset >= PACKET) return;
        const payload = packet.subarray(offset);

        if (packet[1]! & 0x40) {
            // 次の頭が来た。**長さ 0 の PES (映像) はここで終わりが分かる**
            this.finish(pid, kind, out);
            const expected = payload.length >= 6 ? 6 + ((payload[4]! << 8) | payload[5]!) : 0;
            this.partial.set(pid, {
                parts: [payload.slice()],
                size: payload.length,
                expected: expected === 6 ? 0 : expected,
            });
        } else {
            const partial = this.partial.get(pid);
            // 頭を見ていない続きは捨てる (途中から受け取った)
            if (partial === undefined) return;
            partial.parts.push(payload.slice());
            partial.size += payload.length;
        }
        const partial = this.partial.get(pid);
        if (partial !== undefined && partial.expected > 0 && partial.size >= partial.expected) {
            this.finish(pid, kind, out);
        }
    }

    private finish(pid: number, kind: Pes['kind'], out: Pes[]): void {
        const partial = this.partial.get(pid);
        if (partial === undefined) return;
        this.partial.delete(pid);
        const joined = new Uint8Array(partial.size);
        let at = 0;
        for (const part of partial.parts) {
            joined.set(part, at);
            at += part.length;
        }
        const parsed = parsePes(joined);
        if (parsed === null || parsed.data.length === 0) return;
        out.push({ pid, kind, ...parsed });
    }
}

/** ADTS の標本化周波数の表 (ISO/IEC 14496-3 表 1.18) */
const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export interface AdtsFrame {
    /** 頭 (7 か 9 バイト) ごと。AudioDecoder は ADTS のまま受け取る */
    data: Uint8Array;
    /** 90kHz */
    pts: number;
    sampleRate: number;
    channels: number;
    /** このコマの長さ (90kHz)。AAC は1コマ 1024 標本 */
    duration: number;
}

/**
 * PES の中身を ADTS のコマに割る。**コマは PES をまたぐことがある**ので、余りは持ち越す。
 *
 * 時刻は PES の PTS を頭のコマに付け、続くコマには1コマぶんずつ足す。持ち越した
 * 余りから始まるコマは、前の続きの時刻になる
 */
export class AdtsSplitter {
    private rest = new Uint8Array(0);
    private next: number | null = null;

    feed(data: Uint8Array, pts: number | null): AdtsFrame[] {
        // 余りが無いときだけ PES の時刻に合わせ直す (余りがあれば頭のコマはその続き)
        if (pts !== null && this.rest.length === 0) this.next = pts;
        const buffer = this.rest.length === 0 ? data : joinTwo(this.rest, data);
        const out: AdtsFrame[] = [];
        let at = 0;
        while (at + 7 <= buffer.length) {
            if (buffer[at] !== 0xff || (buffer[at + 1]! & 0xf6) !== 0xf0) {
                at++;
                continue;
            }
            const length = ((buffer[at + 3]! & 0x03) << 11) | (buffer[at + 4]! << 3) | (buffer[at + 5]! >> 5);
            if (length < 7) {
                at++;
                continue;
            }
            if (at + length > buffer.length) break;
            const rate = RATES[(buffer[at + 2]! >> 2) & 0x0f] ?? 48000;
            const channels = ((buffer[at + 2]! & 0x01) << 2) | (buffer[at + 3]! >> 6);
            const duration = Math.round((1024 * 90_000) / rate);
            if (this.next !== null) {
                out.push({
                    data: buffer.slice(at, at + length),
                    pts: this.next,
                    sampleRate: rate,
                    // 0 は「中身に書いてある」(PCE)。放送のデュアルモノはここに来るので、2本とみなす
                    channels: channels === 0 ? 2 : channels,
                    duration,
                });
                this.next += duration;
            }
            at += length;
        }
        this.rest = buffer.slice(at);
        // 同期が取れないまま溜め込まない
        if (this.rest.length > 8192) this.rest = new Uint8Array(0);
        if (pts !== null && this.rest.length === 0 && out.length === 0) this.next = pts;
        return out;
    }

    reset(): void {
        this.rest = new Uint8Array(0);
        this.next = null;
    }
}

function joinTwo(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

/**
 * **33ビットで一周する時刻を、手元の物差しの近くへ伸ばす。**
 *
 * PTS は 26.5 時間で 0 に戻る。受け側は「いま鳴らしている時刻」を一周をまたいでも
 * 増え続ける数で持つので、届いた時刻は**それにいちばん近い周**に置き直して比べる
 * (字幕・時計の知らせ・次の PES)
 *
 * @param pts 届いた時刻 (90kHz。一周の中)
 * @param near 手元の物差し (90kHz。伸ばしたもの)
 */
export function unwrap(pts: number, near: number): number {
    return pts + Math.round((near - pts) / WRAP) * WRAP;
}
