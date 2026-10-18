import { rmSync, writeFileSync } from 'node:fs';
import { expect, recordOne, setRecording, test } from './helpers';

/**
 * **録画をその場で流す API** (`GET /api/recordings/<id>/playback`・`/stream`。`server/playback.ts`)。
 *
 * エンコードしない設定で録った録画 (元の TS だけ) を使う。偽 ffmpeg は映像を作らず、頭の塊の時刻 (tfdt)
 * だけ本物と同じ決め方で出す (`tests/fake/fmp4-out.ts`)。確かめるのは、サーバが TS の中で飛び先を
 * 引いて、物差し (TS の頭を 0) の時刻で流しはじめていること
 */

/** fMP4 の頭の moof の tfdt (90kHz の秒)。無ければ null */
function firstTfdt(bytes: Uint8Array): number | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = (at: number) => new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    const walk = (from: number, to: number, path: string[]): number | null => {
        for (let at = from; at + 8 <= to; ) {
            const size = view.getUint32(at);
            if (size < 8) return null;
            const name = type(at);
            if (name === path[0]) {
                if (path.length === 1) {
                    const version = bytes[at + 8];
                    const value =
                        version === 1 ? Number(view.getBigUint64(at + 12)) : view.getUint32(at + 12);
                    return value / 90_000;
                }
                return walk(at + 8, at + size, path.slice(1));
            }
            at += size;
        }
        return null;
    };
    return walk(0, bytes.length, ['moof', 'traf', 'tfdt']);
}

test.describe('録画をその場で流す', () => {
    test.afterAll(async ({ request, stack }) => {
        rmSync(stack.slowFile, { force: true });
        await setRecording(request, { transcodeLimit: '' });
    });

    test('元の TS だけの録画: 何で観られるかを返し、飛び先から物差しの時刻で流す', async ({
        page,
        request,
        stack,
        baseURL,
    }) => {
        test.setTimeout(180_000);
        await setRecording(request, { codecs: [] });
        const { id } = await recordOne(page, request);

        const info = (await (await request.get(`/api/recordings/${id}/playback`)).json()) as {
            duration: number;
            axis: string;
            offers: { codec: string; way: string }[];
        };
        expect(info.axis).toBe('ts');
        expect(info.duration).toBeGreaterThan(3);
        expect(info.offers).toContainEqual(expect.objectContaining({ codec: 'h264', way: 'stream' }));
        expect(info.offers).toContainEqual(expect.objectContaining({ codec: 'av1', way: 'stream' }));
        expect(info.offers).toContainEqual({ codec: 'mpeg2', way: 'raw' });
        // エンコード済みが無いのでファイルそのままは出さない
        expect(info.offers.some((offer) => offer.way === 'file')).toBe(false);

        /*
         * 頭の塊は、リクエストした位置の 1 秒手前 (キーフレームを含めるため) の映像から。偽の放送の映像は
         * 毎コマがキーフレーム (I フレームだけ) なので、そこから 1 コマ以内
         */
        for (const from of [0, 3]) {
            const res = await request.get(`/api/recordings/${id}/stream?codec=h264&from=${from}`);
            expect(res.status()).toBe(200);
            expect(res.headers()['content-type']).toBe('video/mp4');
            const tfdt = firstTfdt(new Uint8Array(await res.body()));
            expect(tfdt).not.toBeNull();
            expect(tfdt!).toBeGreaterThanOrEqual(Math.max(0, from - 1) - 0.05);
            expect(tfdt!).toBeLessThanOrEqual(Math.max(0, from - 1) + 0.6);
        }

        // MPEG-2 は元の TS を飛び先から。物差しの 0 の PTS を添える
        const controller = new AbortController();
        const raw = await fetch(`${baseURL}/api/recordings/${id}/stream?codec=mpeg2&from=2`, {
            signal: controller.signal,
        });
        expect(raw.status).toBe(200);
        expect(raw.headers.get('content-type')).toBe('video/mp2t');
        expect(Number(raw.headers.get('x-denpa-origin'))).toBeGreaterThanOrEqual(0);
        const first = await raw.body!.getReader().read();
        expect(first.value?.[0]).toBe(0x47);
        controller.abort();

        /*
         * **枠が埋まっていれば断る。** 上限を 1 本にして、流しっぱなしの 1 本 (偽 ffmpeg を長引かせる) を
         * 開いたまま、もう 1 本リクエストする。閉じれば枠が返る
         */
        await setRecording(request, { codecs: [], transcodeLimit: '1' });
        writeFileSync(stack.slowFile, '1');
        const holding = new AbortController();
        const held = await fetch(`${baseURL}/api/recordings/${id}/stream?codec=av1`, {
            signal: holding.signal,
        });
        expect(held.status).toBe(200);
        const busy = await request.get(`/api/recordings/${id}/stream?codec=h264`);
        expect(busy.status()).toBe(503);
        expect((await busy.json()).message).toBe('サーバが混んでいます');
        // 詰め替え・MPEG-2 は数えない
        const rawWhileBusy = await fetch(`${baseURL}/api/recordings/${id}/stream?codec=mpeg2`);
        expect(rawWhileBusy.status).toBe(200);
        await rawWhileBusy.body?.cancel();

        holding.abort();
        rmSync(stack.slowFile, { force: true });
        await expect(async () => {
            const res = await request.get(`/api/recordings/${id}/stream?codec=h264`);
            expect(res.status()).toBe(200);
        }).toPass({ timeout: 10_000, intervals: [200] });
    });
});
