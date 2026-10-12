/**
 * 偽 ffmpeg のライブの出口 (焼いたもの)。**作り置きの fMP4 を、時刻を進めながら繰り返し流す。**
 *
 * 偽 ffmpeg はふだん入ってきた TS をそのまま流すだけで、画面の MSE は何も映さない (絵が要らない
 * テストばかりなので)。互換モード (canvas に描く道。`src/lib/raw/fmp4.ts`) は**実際に解いて描く
 * ところまで**見たいので、本物の ffmpeg に書かせた fMP4 を流す。組はライブと同じ (H.264 + AAC・AV1 + Opus):
 *
 *     ffmpeg -f lavfi -i testsrc2=size=320x180:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 2 \
 *       -c:v libx264 -preset ultrafast -tune zerolatency -crf 35 -g 30 -pix_fmt yuv420p -c:a aac -b:a 64k -ac 2 \
 *       -f mp4 -movflags +empty_moov+default_base_moof -frag_duration 50000 live-h264.mp4
 *     ffmpeg -f lavfi -i testsrc2=size=320x180:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 2 \
 *       -c:v libsvtav1 -preset 12 -g 30 -pix_fmt yuv420p -c:a libopus -b:a 64k -ac 2 \
 *       -f mp4 -movflags +empty_moov+default_base_moof -frag_duration 50000 live-av1.mp4
 *
 * 形はライブの ffmpeg と同じ (`server/live.ts` の `+empty_moov+default_base_moof`)。2秒ぶんを
 * 頭 (ftyp + moov) を1回だけ出してから、媒体 (moof + mdat) を**時刻 (tfdt) を1周ぶんずつ
 * 足して**繰り返す。速さは実時間 (本物のライブと同じく、先へは溜めない)。
 *
 *     bun tests/fake/fmp4-loop.ts <fMP4>
 *
 * 入口 (TS) は読んで捨てる。読まないとパイプが詰まって、送る側 (`server/live.ts`) が止まる
 */

import { readFileSync } from 'node:fs';

interface Fragment {
    data: Uint8Array;
    /** トラックごとの tfdt の在りか (data の中の位置) と、版 (1 なら 64 ビット) */
    stamps: { track: number; at: number; wide: boolean }[];
    /** 先頭のコマの時刻 (秒)。流す頃合いを決める */
    seconds: number;
}

function boxes(data: Uint8Array, from: number, to: number): { type: string; start: number; end: number }[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out: { type: string; start: number; end: number }[] = [];
    let at = from;
    while (at + 8 <= to) {
        const size = view.getUint32(at);
        if (size < 8 || at + size > to) break;
        out.push({ type: String.fromCharCode(...data.subarray(at + 4, at + 8)), start: at, end: at + size });
        at += size;
    }
    return out;
}

const file = new Uint8Array(readFileSync(process.argv[2] ?? ''));
const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
const top = boxes(file, 0, file.length);

/** トラックごとの時刻の刻み (moov → trak → mdia → mdhd) */
const timescales = new Map<number, number>();
const moov = top.find((b) => b.type === 'moov');
const traks = moov === undefined ? [] : boxes(file, moov.start + 8, moov.end);
for (const trak of traks.filter((b) => b.type === 'trak')) {
    const inner = boxes(file, trak.start + 8, trak.end);
    const tkhd = inner.find((b) => b.type === 'tkhd');
    const mdia = inner.find((b) => b.type === 'mdia');
    const mdhd =
        mdia === undefined ? undefined : boxes(file, mdia.start + 8, mdia.end).find((b) => b.type === 'mdhd');
    if (tkhd === undefined || mdhd === undefined) continue;
    const id = view.getUint32(tkhd.start + 8 + (file[tkhd.start + 8] === 1 ? 20 : 12));
    timescales.set(id, view.getUint32(mdhd.start + 8 + (file[mdhd.start + 8] === 1 ? 20 : 12)));
}

const head = file.subarray(0, top.find((b) => b.type === 'moof')?.start ?? file.length);
const fragments: Fragment[] = [];
/** トラックごとの1周の長さ (そのトラックの刻み)。最後のコマの終わり */
const loop = new Map<number, number>();
for (let i = 0; i < top.length; i++) {
    const moof = top[i]!;
    if (moof.type !== 'moof') continue;
    const mdat = top.slice(i + 1).find((b) => b.type === 'mdat');
    if (mdat === undefined) break;
    const data = file.slice(moof.start, mdat.end);
    const stamps: Fragment['stamps'] = [];
    let seconds = Number.POSITIVE_INFINITY;
    for (const traf of boxes(data, 8, moof.end - moof.start).filter((b) => b.type === 'traf')) {
        const inner = boxes(data, traf.start + 8, traf.end);
        const tfhd = inner.find((b) => b.type === 'tfhd');
        const tfdt = inner.find((b) => b.type === 'tfdt');
        const trun = inner.find((b) => b.type === 'trun');
        if (tfhd === undefined || tfdt === undefined) continue;
        const v = new DataView(data.buffer);
        const track = v.getUint32(tfhd.start + 12);
        const wide = data[tfdt.start + 8] === 1;
        const at = tfdt.start + 12;
        const base = wide ? Number(v.getBigUint64(at)) : v.getUint32(at);
        stamps.push({ track, at, wide });
        const scale = timescales.get(track) ?? 90000;
        seconds = Math.min(seconds, base / scale);
        // 1周の長さ: このかたまりのコマの長さを足した終わり (trun に長さが無ければ tfhd の既定)
        if (trun !== undefined) {
            const flags = v.getUint32(trun.start + 8) & 0xffffff;
            const count = v.getUint32(trun.start + 12);
            let p = trun.start + 16 + (flags & 0x01 ? 4 : 0) + (flags & 0x04 ? 4 : 0);
            const each = [0x100, 0x200, 0x400, 0x800].filter((bit) => flags & bit).length * 4;
            const tf = v.getUint32(tfhd.start + 8) & 0xffffff;
            let fallback = 0;
            if (tf & 0x08)
                fallback = v.getUint32(tfhd.start + 16 + (tf & 0x01 ? 8 : 0) + (tf & 0x02 ? 4 : 0));
            let total = 0;
            for (let n = 0; n < count; n++, p += each) total += flags & 0x100 ? v.getUint32(p) : fallback;
            loop.set(track, Math.max(loop.get(track) ?? 0, base + total));
        }
    }
    fragments.push({ data, stamps, seconds: Number.isFinite(seconds) ? seconds : 0 });
}

// 入口の TS は読んで捨てる (上の説明)
void (async () => {
    for await (const _ of Bun.stdin.stream()) {
        // 捨てる
    }
})();

const out = Bun.stdout.writer();
out.write(head);
await out.flush();

const period = Math.max(...[...loop].map(([track, end]) => end / (timescales.get(track) ?? 90000)), 0.1);
const started = performance.now();
for (let round = 0; ; round++) {
    for (const fragment of fragments) {
        const data = fragment.data.slice();
        const v = new DataView(data.buffer);
        for (const { track, at, wide } of fragment.stamps) {
            // 1周の長さはトラックで揃える (長いほう)。揃えないと音と絵が1周ごとにずれていく
            const shift = Math.round(period * (timescales.get(track) ?? 90000) * round);
            if (wide) v.setBigUint64(at, v.getBigUint64(at) + BigInt(shift));
            else v.setUint32(at, v.getUint32(at) + shift);
        }
        const due = (round * period + fragment.seconds) * 1000 - (performance.now() - started);
        if (due > 0) await Bun.sleep(due);
        out.write(data);
        await out.flush();
    }
}
