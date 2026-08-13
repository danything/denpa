import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    BML_TS,
    bmlHead,
    ddbSection,
    diiSection,
    multipartModule,
    packetize,
    patSection,
    programMap,
    stream,
    tdtPacket as tdt,
} from '$lib/ts/synth';
import { loadRecordedBml, saveRecordedBml } from './recorded-bml';

/*
 * 録画のデータ放送。**TS から取り出してサイドカーに置き、再生時に読み直す。**
 * 解き方は ts/data-timeline.ts が持つので、ここはファイルの出し入れだけを確かめる。
 */

/** モジュール1つぶんの multipart (ファイル1枚の形) */
const multipart = (body: string) => multipartModule([['/startup.bml', 'text/X-arib-bml', body]]);

/** PAT・PMT・TDT・カルーセルを1本の TS バイト列にする */
function tsBytes(unixMs: number, body: string): Uint8Array {
    const module = multipart(body);
    const spec = { moduleId: 1, moduleSize: module.length, moduleVersion: 1, contentType: 'multipart/mixed' };
    return stream(
        ...bmlHead(),
        tdt(unixMs),
        packetize(BML_TS.bmlPid, diiSection(BML_TS.downloadId, 4066, spec, 1)),
        packetize(BML_TS.bmlPid, ddbSection(BML_TS.downloadId, 1, 1, 0, module)),
    );
}

const dir = mkdtempSync(join(tmpdir(), 'denpa-bml-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T = Date.UTC(2026, 7, 12, 0, 0, 30);

describe('saveRecordedBml / loadRecordedBml', () => {
    test('TS から取り出して書き、読み直すと同じ変化が並ぶ', () => {
        const ts = join(dir, 'rec.ts');
        const sidecar = join(dir, 'rec.bml.jsonl');
        writeFileSync(ts, tsBytes(T, '<bml>録画のデータ放送</bml>'));

        // 基準を放送時刻の 10 秒前に置く → モジュールは再生位置 10000ms になる
        const changes = saveRecordedBml(ts, sidecar, T - 10_000, null);
        expect(changes).toBeGreaterThan(0);

        const loaded = loadRecordedBml(sidecar);
        const done = loaded.find((item) => item.message.type === 'moduleDownloaded');
        if (done?.message.type !== 'moduleDownloaded') throw new Error('moduleDownloaded が無い');
        expect(done.at).toBe(10_000);
        expect(Buffer.from(done.message.files[0].dataBase64, 'base64').toString()).toContain(
            '録画のデータ放送',
        );
    });

    test('データ放送を持たない TS では書かない・読めば空', () => {
        const ts = join(dir, 'plain.ts');
        const sidecar = join(dir, 'plain.bml.jsonl');
        // BML の ES が無い PMT (映像だけ)
        const { service, pmtPid, videoPid } = BML_TS;
        writeFileSync(
            ts,
            stream(
                packetize(0x0000, patSection([[service, pmtPid]])),
                packetize(pmtPid, programMap(service, videoPid, [[0x02, videoPid, [0x52, 0x01, 0x00]]])),
            ),
        );

        expect(saveRecordedBml(ts, sidecar, T, null)).toBe(0);
        expect(loadRecordedBml(sidecar)).toEqual([]);
    });
});
