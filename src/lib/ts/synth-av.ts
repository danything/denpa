/**
 * **本物の MPEG-2 映像と AAC 音声を、ffmpeg 無しで組み立てる** (試験用)。
 *
 * ライブを生で送る道 (docs/stream.md §5.5) は、ブラウザが MPEG-2 を解いて絵を出す
 * ところまでが仕事で、そこを試すには**本当に解ける放送**が要る。偽エージェントの
 * 放送は中身を 0xFF で埋めていて、解くものが無い。E2E のイメージには本物の ffmpeg も
 * 入っていない (数十分かかる組み立てを避けている) ので、ここで小さく作る。
 *
 * - 映像 … 256x144 の**I フレームだけ**。マクロブロックごとに色 (DC) だけを置き、
 *   AC は持たない (EOB だけ)。コマごとに縞が流れるので、**絵が進んでいるか**を
 *   画素で見分けられる。インタレの印も立てる (受け側の field 分けの道を通すため)
 * - 音声 … 48kHz ステレオの AAC-LC の**無音**を ADTS で。1コマ 7 バイト
 *
 * 規格は ISO/IEC 13818-2 (映像) と 13818-7 / 14496-3 (AAC)。表の出どころは
 * 各関数の頭に書いてある。
 */

import { PACKET, SYNC } from './psi';

/** 90kHz。PES の PTS の刻み */
export const CLOCK = 90_000;
/** 29.97 コマ/秒の1コマ (90kHz)。放送と同じ */
export const FRAME_TICKS = 3003;
/** AAC の1コマ (1024 標本 @48kHz を 90kHz で) */
export const AUDIO_TICKS = 1920;

/** 絵の大きさ。**16 の倍数** (マクロブロックで割り切る) */
export const WIDTH = 256;
export const HEIGHT = 144;

class Bits {
    private readonly out: number[] = [];
    private acc = 0;
    private used = 0;

    put(value: number, width: number): void {
        for (let i = width - 1; i >= 0; i--) {
            this.acc = (this.acc << 1) | ((value >>> i) & 1);
            if (++this.used === 8) {
                this.out.push(this.acc);
                this.acc = 0;
                this.used = 0;
            }
        }
    }

    /** 0 で詰めてバイトの切れ目に揃える (next_start_code / byte_alignment) */
    align(): void {
        if (this.used > 0) this.put(0, 8 - this.used);
    }

    startCode(code: number): void {
        this.align();
        this.out.push(0x00, 0x00, 0x01, code);
    }

    bytes(): Uint8Array {
        this.align();
        return Uint8Array.from(this.out);
    }
}

/** dct_dc_size の符号 (表 B-12 輝度 / B-13 色差)。`[符号, 長さ]` */
const DC_LUMA: [number, number][] = [
    [0b100, 3],
    [0b00, 2],
    [0b01, 2],
    [0b101, 3],
    [0b110, 3],
    [0b1110, 4],
    [0b11110, 5],
    [0b111110, 6],
    [0b1111110, 7],
];
const DC_CHROMA: [number, number][] = [
    [0b00, 2],
    [0b01, 2],
    [0b10, 2],
    [0b110, 3],
    [0b1110, 4],
    [0b11110, 5],
    [0b111110, 6],
    [0b1111110, 7],
    [0b11111110, 8],
];

/** 1ブロック。**DC の差分だけ書いて、すぐ EOB** (表 B-14 の '10') */
function block(bits: Bits, diff: number, table: [number, number][]): void {
    const size = diff === 0 ? 0 : Math.floor(Math.log2(Math.abs(diff))) + 1;
    const [code, length] = table[size]!;
    bits.put(code, length);
    // 負の差分は「足して (2^size − 1)」を書く (7.2.1)
    if (size > 0) bits.put(diff > 0 ? diff : diff + (1 << size) - 1, size);
    bits.put(0b10, 2);
}

/** n コマ目の色 (Y, Cb, Cr)。**列と時刻で縞を流す** — 進んでいれば画素が変わる */
function colorAt(col: number, row: number, n: number): [number, number, number] {
    const y = 32 + ((col * 12 + n * 8) % 192);
    return [y, 96 + ((row * 16) % 64), 160 - ((col * 4) % 64)];
}

/**
 * I フレームを1枚。**毎枚、系列ヘッダから書く** — どこから受け取っても頭から解ける
 * (放送は GOP ごとに書く。試験ではその手間を省く)。
 *
 * @param n 何枚目か。色と time_code に使う
 */
export function mpeg2Frame(n: number): Uint8Array {
    const bits = new Bits();
    const mbWidth = WIDTH / 16;
    const mbHeight = HEIGHT / 16;

    // sequence_header (6.2.2.1)。16:9、29.97、intra/non-intra の量子化表は既定
    bits.startCode(0xb3);
    bits.put(WIDTH, 12);
    bits.put(HEIGHT, 12);
    bits.put(3, 4); // aspect_ratio_information = 16:9
    bits.put(4, 4); // frame_rate_code = 30000/1001
    bits.put(0x3ffff, 18); // bit_rate_value
    bits.put(1, 1); // marker
    bits.put(112, 10); // vbv_buffer_size_value
    bits.put(0, 3); // constrained / load_intra / load_non_intra

    // sequence_extension (6.2.2.3)。Main@Main、4:2:0、インタレ系列、B 無し
    bits.startCode(0xb5);
    bits.put(1, 4);
    bits.put(0x48, 8);
    bits.put(0, 1); // progressive_sequence = 0 (インタレ)
    bits.put(1, 2); // chroma_format = 4:2:0
    bits.put(0, 4); // horizontal / vertical_size_extension
    bits.put(0, 12); // bit_rate_extension
    bits.put(1, 1); // marker
    bits.put(0, 8); // vbv_buffer_size_extension
    bits.put(1, 1); // low_delay
    bits.put(0, 7); // frame_rate_extension_n / _d

    // group_of_pictures_header (6.2.2.6)。閉じた GOP
    bits.startCode(0xb8);
    const seconds = Math.floor(n / 30);
    bits.put(0, 1); // drop_frame_flag
    bits.put(Math.floor(seconds / 3600) % 24, 5);
    bits.put(Math.floor(seconds / 60) % 60, 6);
    bits.put(1, 1); // marker
    bits.put(seconds % 60, 6);
    bits.put(n % 30, 6);
    bits.put(1, 1); // closed_gop
    bits.put(0, 1); // broken_link

    // picture_header (6.2.3)
    bits.startCode(0x00);
    bits.put(0, 10); // temporal_reference (GOP ごとに1枚なので 0)
    bits.put(1, 3); // picture_coding_type = I
    bits.put(0xffff, 16); // vbv_delay
    bits.put(0, 1); // extra_bit_picture

    // picture_coding_extension (6.2.3.1)。フレーム構造・上が先・インタレのコマ
    bits.startCode(0xb5);
    bits.put(8, 4);
    bits.put(0xffff, 16); // f_code (I では使わない = 15)
    bits.put(0, 2); // intra_dc_precision = 8bit
    bits.put(3, 2); // picture_structure = frame
    bits.put(1, 1); // top_field_first
    bits.put(1, 1); // frame_pred_frame_dct (dct_type を書かずに済む)
    bits.put(0, 1); // concealment_motion_vectors
    bits.put(0, 1); // q_scale_type
    bits.put(0, 1); // intra_vlc_format
    bits.put(0, 1); // alternate_scan
    bits.put(0, 1); // repeat_first_field
    bits.put(0, 1); // chroma_420_type
    bits.put(0, 1); // progressive_frame = 0
    bits.put(0, 1); // composite_display_flag

    for (let row = 0; row < mbHeight; row++) {
        // 1行を1スライスに。予測は行の頭で 128 に戻る (7.2.1)
        bits.startCode(row + 1);
        bits.put(8, 5); // quantiser_scale_code (DC だけなので効かない)
        bits.put(0, 1); // extra_bit_slice
        const predictor = [128, 128, 128];
        for (let col = 0; col < mbWidth; col++) {
            bits.put(1, 1); // macroblock_address_increment = 1
            bits.put(1, 1); // macroblock_type = intra
            const [y, cb, cr] = colorAt(col, row, n);
            for (let i = 0; i < 4; i++) {
                block(bits, y - predictor[0]!, DC_LUMA);
                predictor[0] = y;
            }
            block(bits, cb - predictor[1]!, DC_CHROMA);
            predictor[1] = cb;
            block(bits, cr - predictor[2]!, DC_CHROMA);
            predictor[2] = cr;
        }
    }
    return bits.bytes();
}

/**
 * AAC-LC の無音を1コマ、ADTS の頭付きで。48kHz・ステレオ (channel_configuration 2)。
 *
 * 中身は CPE が1つ: 両耳とも `max_sfb = 0` (係数を1つも持たない) で、あとは END。
 * 55 ビットなので7バイトに収まる (14496-3 の raw_data_block)
 */
export function silentAac(): Uint8Array {
    const body = new Bits();
    body.put(1, 3); // id_syn_ele = CPE
    body.put(0, 4); // element_instance_tag
    body.put(0, 1); // common_window
    for (let ch = 0; ch < 2; ch++) {
        body.put(100, 8); // global_gain
        body.put(0, 1); // ics_reserved_bit
        body.put(0, 2); // window_sequence = ONLY_LONG
        body.put(0, 1); // window_shape
        body.put(0, 6); // max_sfb = 0
        body.put(0, 1); // predictor_data_present
        body.put(0, 3); // pulse / tns / gain_control
    }
    body.put(7, 3); // END
    const payload = body.bytes();

    const head = new Bits();
    const length = 7 + payload.length;
    head.put(0xfff, 12);
    head.put(0, 1); // ID = MPEG-4
    head.put(0, 2); // layer
    head.put(1, 1); // protection_absent
    head.put(1, 2); // profile = LC
    head.put(3, 4); // sampling_frequency_index = 48kHz
    head.put(0, 1);
    head.put(2, 3); // channel_configuration
    head.put(0, 4);
    head.put(length, 13);
    head.put(0x7ff, 11); // buffer fullness = VBR
    head.put(0, 2); // number_of_raw_data_blocks - 1
    return Uint8Array.from([...head.bytes(), ...payload]);
}

/** PTS/DTS の5バイト (2.4.3.7)。頭の4ビットは '0010' (PTS だけ) */
function stamp(pts: number): number[] {
    const value = pts % 2 ** 33;
    const high = Math.floor(value / 2 ** 30) & 0x07;
    const mid = Math.floor(value / 2 ** 15) & 0x7fff;
    const low = value & 0x7fff;
    return [0x21 | (high << 1), mid >> 7, ((mid & 0x7f) << 1) | 1, low >> 7, ((low & 0x7f) << 1) | 1];
}

/**
 * PES にする。映像は長さ 0 (「次の頭まで」。放送もそう書く)、音声は長さを書く
 *
 * @param streamId 0xE0 (映像) / 0xC0 (音声)
 */
export function pes(streamId: number, pts: number, data: Uint8Array): Uint8Array {
    const header = [0x80, 0x80, 5, ...stamp(pts)];
    const length = streamId >= 0xe0 ? 0 : header.length + data.length;
    return Uint8Array.from([0x00, 0x00, 0x01, streamId, length >> 8, length & 0xff, ...header, ...data]);
}

/**
 * PES を TS パケットに割る。**最後のパケットは適応フィールドで詰める** (中身を 0xFF で
 * 埋めると PES の続きに見える)。頭のパケットに PCR を載せることもできる
 *
 * @param counter 連続性カウンタの続き。返り値の `counter` を次に渡す
 */
export function packetizePes(
    pid: number,
    data: Uint8Array,
    counter: number,
    pcr: number | null = null,
): { packets: Uint8Array; counter: number } {
    const out: Uint8Array[] = [];
    let at = 0;
    while (at < data.length) {
        const packet = new Uint8Array(PACKET).fill(0xff);
        const withPcr = at === 0 && pcr !== null;
        const rest = data.length - at;
        /*
         * 適応フィールドの長さ。PCR を載せるなら旗1バイト + 6バイト。**中身が
         * 足りないときもここを伸ばして詰める** (中身を 0xFF で埋めると PES の続きに見える)
         */
        const least = withPcr ? 7 : 0;
        const adapted = withPcr || rest < PACKET - 4;
        const take = adapted ? Math.min(rest, PACKET - 5 - least) : PACKET - 4;
        packet[0] = SYNC;
        packet[1] = (at === 0 ? 0x40 : 0) | ((pid >> 8) & 0x1f);
        packet[2] = pid & 0xff;
        packet[3] = (adapted ? 0x30 : 0x10) | (counter & 0x0f);
        if (adapted) {
            const length = PACKET - 5 - take;
            packet[4] = length;
            if (length > 0) packet[5] = withPcr ? 0x10 : 0x00;
            if (withPcr) {
                const base = Math.round(pcr as number) % 2 ** 33;
                packet[6] = Math.floor(base / 2 ** 25) & 0xff;
                packet[7] = Math.floor(base / 2 ** 17) & 0xff;
                packet[8] = Math.floor(base / 2 ** 9) & 0xff;
                packet[9] = Math.floor(base / 2) & 0xff;
                packet[10] = ((base & 1) << 7) | 0x7e;
                packet[11] = 0;
            }
        }
        packet.set(data.subarray(at, at + take), PACKET - take);
        at += take;
        counter = (counter + 1) & 0x0f;
        out.push(packet);
    }
    const packets = new Uint8Array(out.length * PACKET);
    out.forEach((packet, i) => {
        packets.set(packet, i * PACKET);
    });
    return { packets, counter };
}
