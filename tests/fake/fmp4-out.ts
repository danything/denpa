/**
 * **偽 ffmpeg の fMP4 の出口** (`ffmpeg.sh` から呼ぶ)。録画をその場で流す口 (`/api/recordings/<id>/stream`。
 * `server/playback.ts`) の時刻の運び方を、本物の ffmpeg 無しで試すためのもの。
 *
 * 中身の映像は作らない。出すのは init (ftyp + moov の殻) と、**頭の塊の時刻 (tfdt) だけ正しい** moof + mdat。
 * tfdt は本物と同じ決め方で出す:
 *
 * - 入口が標準入力 (TS) なら、最初の映像の PES の PTS を `-copyts` のまま運ぶ。一周の手前 60 秒に
 *   入っていれば負にする (libavformat の `update_wrap_reference`)。そこへ `-output_ts_offset` を足す
 * - 入口がファイルなら `-ss` の位置 (`-copyts` で入口の時刻のまま)
 *
 * 時刻の刻みは 90kHz (映像)
 */
import { pesMarks } from '../../src/lib/ts/seek';

const args = process.argv.slice(2);
const after = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at < 0 ? undefined : args[at + 1];
};

const CLOCK = 90_000;
const WRAP = 2 ** 33;

async function firstVideoPts(): Promise<number | null> {
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of Bun.stdin.stream()) {
        parts.push(chunk);
        size += chunk.length;
        const joined = new Uint8Array(size);
        let at = 0;
        for (const part of parts) {
            joined.set(part, at);
            at += part.length;
        }
        for (const mark of pesMarks(joined)) if (mark.id >= 0xe0 && mark.id <= 0xef) return mark.pts;
        if (size > 16 * 1024 * 1024) return null;
    }
    return null;
}

let seconds: number;
if (after('-i') === 'pipe:0') {
    const pts = await firstVideoPts();
    if (pts === null) {
        console.error('偽 ffmpeg: 映像の PES が見つかりません');
        process.exit(1);
    }
    seconds = (pts >= WRAP - 60 * CLOCK ? pts - WRAP : pts) / CLOCK + Number(after('-output_ts_offset') ?? 0);
} else {
    seconds = Number(after('-ss') ?? 0);
}

function box(type: string, ...body: Uint8Array[]): Uint8Array {
    const size = 8 + body.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    out.set(new TextEncoder().encode(type), 4);
    let at = 8;
    for (const part of body) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

const tfdt = new Uint8Array(12);
const view = new DataView(tfdt.buffer);
// version 1 (64 ビットの時刻)
view.setUint32(0, 0x01000000);
view.setBigUint64(4, BigInt(Math.max(0, Math.round(seconds * CLOCK))));
const tfhd = new Uint8Array(8);
new DataView(tfhd.buffer).setUint32(4, 1);
const mfhd = new Uint8Array(8);
new DataView(mfhd.buffer).setUint32(4, 1);

const out = [
    box('ftyp', new TextEncoder().encode('isom\0\0\0\0isomiso6')),
    box('moov'),
    box('moof', box('mfhd', mfhd), box('traf', box('tfhd', tfhd), box('tfdt', tfdt))),
    box('mdat'),
];
for (const part of out) process.stdout.write(part);

/*
 * **長引かせる目印** (`FAKE_FFMPEG_SLOW_FILE`)。変換の枠が埋まるところを試すのに、流しっぱなしの 1 本が要る。
 * 本物は相手が閉じるまで出し続ける。止められる (SIGTERM) まで居座る
 */
const slow = process.env['FAKE_FFMPEG_SLOW_FILE'];
if (slow !== undefined && (await Bun.file(slow).exists())) await Bun.sleep(120_000);
