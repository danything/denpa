/**
 * 音。**内蔵音は WebAudio で合成し、出所の分からない音のファイルは持たない。**
 *
 * - 内蔵音 (`browser.playRomSound("romsound://N")`、TR-B14 第二分冊 第三編 第2部 3.3.5):
 *   0〜4 速報チャイム・5〜12 ボタン操作音・13 アラート音。規格は音色を決めていないので、
 *   役目が分かる短い音にする (ボタンは短く高い 1 音、チャイムは下がる 2〜4 音、アラートは 2 音の繰り返し)
 * - 文書の音 (`object type="audio/X-arib-aiff"`): AIFF-C の非圧縮 PCM (12 kHz・1 ch・16 ビット) を読む
 */

/** [周波数 Hz, 長さ 秒] の並び */
type Tune = [number, number][];

const TUNES: Record<number, Tune> = {
    0: [
        [1318, 0.35],
        [1046, 0.5],
    ],
    1: [
        [1568, 0.25],
        [1318, 0.25],
        [1046, 0.5],
    ],
    2: [
        [1046, 0.25],
        [1318, 0.25],
        [1568, 0.5],
    ],
    3: [
        [1568, 0.2],
        [1318, 0.2],
        [1568, 0.2],
        [1318, 0.4],
    ],
    4: [
        [880, 0.3],
        [698, 0.3],
        [880, 0.3],
        [698, 0.5],
    ],
    5: [[2093, 0.08]],
    6: [
        [2093, 0.06],
        [2093, 0.06],
        [2093, 0.06],
    ],
    7: [
        [1568, 0.05],
        [2349, 0.12],
    ],
    8: [
        [2349, 0.05],
        [1568, 0.12],
    ],
    9: [[2637, 0.06]],
    10: [
        [2637, 0.05],
        [2637, 0.05],
        [2637, 0.05],
    ],
    11: [[1760, 0.1]],
    12: [
        [1175, 0.06],
        [1760, 0.1],
    ],
    13: [
        [1000, 0.25],
        [750, 0.25],
        [1000, 0.25],
        [750, 0.25],
    ],
};

export class Sound {
    private context: AudioContext | null = null;
    private readonly playing = new Set<AudioScheduledSourceNode>();

    private audio(): AudioContext | null {
        if (this.context !== null) return this.context;
        if (typeof AudioContext === 'undefined') return null;
        this.context = new AudioContext();
        return this.context;
    }

    /** 内蔵音を鳴らす。知らない番号なら false */
    rom(id: number): boolean {
        const tune = TUNES[id];
        const context = tune === undefined ? null : this.audio();
        if (tune === undefined || context === null) return false;
        let at = context.currentTime + 0.01;
        for (const [frequency, length] of tune) {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.type = 'sine';
            oscillator.frequency.value = frequency;
            gain.gain.setValueAtTime(0.15, at);
            gain.gain.exponentialRampToValueAtTime(0.001, at + length);
            oscillator.connect(gain).connect(context.destination);
            oscillator.start(at);
            oscillator.stop(at + length);
            this.track(oscillator);
            at += length;
        }
        return true;
    }

    /** AIFF を鳴らす。読めなければ null。止める関数と、鳴り終わりの通知を返す */
    aiff(data: Uint8Array, ended: () => void): (() => void) | null {
        const pcm = decodeAiff(data);
        const context = pcm === null ? null : this.audio();
        if (pcm === null || context === null) return null;
        let buffer: AudioBuffer;
        try {
            buffer = context.createBuffer(1, pcm.samples.length, pcm.rate);
        } catch {
            return null;
        }
        buffer.copyToChannel(pcm.samples, 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.addEventListener('ended', ended);
        source.start();
        this.track(source);
        return () => {
            source.removeEventListener('ended', ended);
            source.stop();
        };
    }

    private track(node: AudioScheduledSourceNode): void {
        this.playing.add(node);
        node.addEventListener('ended', () => this.playing.delete(node));
    }

    destroy(): void {
        for (const node of this.playing) {
            try {
                node.stop();
            } catch {}
        }
        this.playing.clear();
        void this.context?.close();
        this.context = null;
    }
}

/** 80 ビットの浮動小数 (AIFF の標本化周波数) */
function extended(data: Uint8Array, at: number): number {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const exponent = (view.getUint16(at) & 0x7fff) - 16383;
    const high = view.getUint32(at + 2);
    const low = view.getUint32(at + 6);
    return (high * 2 ** 32 + low) * 2 ** (exponent - 63);
}

/** AIFF-C の非圧縮 PCM を読む (1 ch・16 ビットだけ) */
export function decodeAiff(data: Uint8Array): { rate: number; samples: Float32Array<ArrayBuffer> } | null {
    const tag = (at: number): string => String.fromCharCode(...data.subarray(at, at + 4));
    if (data.length < 12 || tag(0) !== 'FORM' || (tag(8) !== 'AIFC' && tag(8) !== 'AIFF')) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let rate = 0;
    let frames = 0;
    let channels = 0;
    let bits = 0;
    let sound: Uint8Array | null = null;
    let at = 12;
    while (at + 8 <= data.length) {
        const id = tag(at);
        const size = view.getUint32(at + 4);
        const body = at + 8;
        if (id === 'COMM' && body + 18 <= data.length) {
            channels = view.getUint16(body);
            frames = view.getUint32(body + 2);
            bits = view.getUint16(body + 6);
            rate = extended(data, body + 8);
            if (tag(8) === 'AIFC' && body + 22 <= data.length && tag(body + 18) !== 'NONE') return null;
        } else if (id === 'SSND' && body + 8 <= data.length) {
            const offset = view.getUint32(body);
            sound = data.subarray(body + 8 + offset, Math.min(body + size, data.length));
        }
        at = body + size + (size & 1);
    }
    if (
        sound === null ||
        channels !== 1 ||
        bits !== 16 ||
        !(rate > 0) ||
        frames === 0 ||
        rate < 3000 ||
        rate > 768000
    )
        return null;
    const count = Math.min(frames, sound.length >> 1);
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++)
        samples[i] = ((((sound[i * 2]! << 8) | sound[i * 2 + 1]!) << 16) >> 16) / 32768;
    return { rate, samples };
}
