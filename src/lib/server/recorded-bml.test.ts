import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bxmlDescriptor, ddbSection, diiSection, packetize, patSection, programMap } from '$lib/ts/synth';
import { loadRecordedBml, saveRecordedBml } from './recorded-bml';

/*
 * 録画のデータ放送。**TS から取り出してサイドカーに置き、再生時に読み直す。**
 * 解き方は ts/data-timeline.ts が持つので、ここはファイルの出し入れだけを確かめる。
 */

const SERVICE = 1024;
const PMT_PID = 0x1f0;
const VIDEO_PID = 0x0111;
const BML_PID = 0x0800;
const COMPONENT_TAG = 0x40;

function bmlPmt(): Uint8Array {
    return programMap(SERVICE, VIDEO_PID, [
        [0x02, VIDEO_PID, [0x52, 0x01, 0x00]],
        [0x0d, BML_PID, [0x52, 0x01, COMPONENT_TAG, ...bxmlDescriptor()]],
    ]);
}

function multipart(body: string): Uint8Array {
    const out =
        'Content-Type: multipart/mixed; boundary=denpa\r\n\r\n' +
        `--denpa\r\nContent-Type: text/X-arib-bml\r\nContent-Location: /startup.bml\r\n\r\n${body}\r\n` +
        '--denpa--\r\n';
    return new TextEncoder().encode(out);
}

/** 放送の実時刻 (TDT) */
function tdt(unixMs: number): Uint8Array {
    const jst = unixMs + 9 * 3600 * 1000;
    const days = Math.floor(jst / 86400000) + 40587;
    const ofDay = jst % 86400000;
    const bcd = (n: number) => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xff;
    return packetize(
        0x0014,
        Uint8Array.from([
            0x70,
            0x70,
            0x05,
            (days >> 8) & 0xff,
            days & 0xff,
            bcd(Math.floor(ofDay / 3600000)),
            bcd(Math.floor((ofDay % 3600000) / 60000)),
            bcd(Math.floor((ofDay % 60000) / 1000)),
        ]),
    );
}

/** PAT・PMT・TDT・カルーセルを1本の TS バイト列にする */
function tsBytes(unixMs: number, body: string): Uint8Array {
    const module = multipart(body);
    const spec = { moduleId: 1, moduleSize: module.length, moduleVersion: 1, contentType: 'multipart/mixed' };
    const parts = [
        packetize(0x0000, patSection([[SERVICE, PMT_PID]])),
        packetize(PMT_PID, bmlPmt()),
        tdt(unixMs),
        packetize(BML_PID, diiSection(0xf0000001, 4066, spec, 1)),
        packetize(BML_PID, ddbSection(0xf0000001, 1, 1, 0, module)),
    ];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
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
        const parts = [
            packetize(0x0000, patSection([[SERVICE, PMT_PID]])),
            packetize(PMT_PID, programMap(SERVICE, VIDEO_PID, [[0x02, VIDEO_PID, [0x52, 0x01, 0x00]]])),
        ];
        const total = parts.reduce((sum, part) => sum + part.length, 0);
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const part of parts) {
            bytes.set(part, at);
            at += part.length;
        }
        writeFileSync(ts, bytes);

        expect(saveRecordedBml(ts, sidecar, T, null)).toBe(0);
        expect(loadRecordedBml(sidecar)).toEqual([]);
    });
});
