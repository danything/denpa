import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * **試し焼きの落とし方** (`hwenc.probe`)。手元にも CI にも GPU は無いので、ffmpeg を
 * 起こす `run` だけ差し替えて、ドライバの返事を作って見る。
 *
 * 作る返事は issue #417 の機材 (Gemini Lake・i965) に寄せたもの: QSV は初期化できず、
 * VA-API は ICQ を持たず CQP なら焼け、MPEG-2 は GPU で解ける。AV1 は焼けない
 */
const real = await import('./stream');
/*
 * **差し替えはこのファイルの中だけで効かせる。** bun は1つのプロセスで全部のテストを回し、
 * `mock.module` は他のファイルにも残る。終わったら本物の `run` に戻す (下の `afterAll`)
 */
const realRun = real.run;
const calls: string[][] = [];
let answer: ((argv: string[]) => number) | null = null;
mock.module('./stream', () => ({
    ...real,
    run: async (argv: string[], options?: Parameters<typeof realRun>[1]) => {
        if (answer === null) return realRun(argv, options);
        calls.push(argv);
        return { code: answer(argv), stdout: new Uint8Array(), stderr: '' };
    },
}));

const { config } = await import('./config');
const dir = mkdtempSync(join(tmpdir(), 'dri-'));
writeFileSync(join(dir, 'renderD128'), '');
const devicesBefore = config.hwDevices;
config.hwDevices = `${dir}/renderD*`;
afterAll(() => {
    answer = null;
    config.hwDevices = devicesBefore;
});

const { probe, describeDevice, liveHw } = await import('./hwenc');

/** i965 らしい返事 */
function i965(argv: string[]): number {
    const line = argv.join(' ');
    if (line.includes('-f mpegts')) return 0; // 試し素材を作る (CPU)
    if (line.includes('qsv')) return 1;
    if (line.includes('av1_vaapi')) return 1;
    if (line.includes('-rc_mode ICQ')) return 1;
    return 0;
}

test('ICQ が落ちたら CQP で試し、通ったほうを覚える', async () => {
    answer = i965;
    calls.length = 0;
    const { devices } = await probe();
    expect(devices).toHaveLength(1);
    const device = devices[0]!;
    expect(device.qsv).toEqual([]);
    expect(device.vaapi).toEqual(['h264']);
    expect(device.cqp).toEqual(['h264']);
    // 復号から GPU の試しも CQP で頼んでいる (ICQ で頼むと i965 では落ちる)
    const full = calls.find((argv) => argv.includes('-hwaccel'));
    expect(full?.join(' ')).toContain('-rc_mode CQP -qp 24');
    expect(full?.join(' ')).toContain('deinterlace_vaapi=rate=field');
    expect(device.full).toEqual(['h264']);
    expect(describeDevice(device)).toBe('VA-API: H.264 (CQP)、ライブは復号から GPU: H.264');
    // ライブは復号から GPU の道を、CQP のまま採る
    expect(liveHw('h264', {}, 0, devices)).toEqual({
        way: { device: device.path, kind: 'vaapi', cqp: true },
        full: true,
    });
});

test('ICQ が通れば CQP は試さない', async () => {
    answer = (argv) => (argv.join(' ').includes('qsv') ? 1 : 0);
    calls.length = 0;
    const { devices } = await probe();
    expect(devices[0]!.vaapi).toEqual(['av1', 'h264']);
    expect(devices[0]!.cqp).toEqual([]);
    expect(calls.some((argv) => argv.includes('CQP'))).toBe(false);
});

test('MPEG-2 を GPU で解けなければ、焼くところだけ GPU', async () => {
    answer = (argv) => {
        const line = argv.join(' ');
        if (line.includes('qsv') || line.includes('-hwaccel')) return 1;
        return 0;
    };
    const { devices } = await probe();
    expect(devices[0]!.vaapi).toEqual(['av1', 'h264']);
    expect(devices[0]!.full).toEqual([]);
    expect(liveHw('h264', {}, 0, devices)).toEqual({
        way: { device: devices[0]!.path, kind: 'vaapi' },
        full: false,
    });
});

test('試し素材を作れなければ、復号から GPU は試さない', async () => {
    answer = (argv) => (argv.join(' ').includes('-f mpegts') || argv.join(' ').includes('qsv') ? 1 : 0);
    calls.length = 0;
    const { devices } = await probe();
    expect(devices[0]!.full).toEqual([]);
    expect(calls.some((argv) => argv.includes('-hwaccel'))).toBe(false);
});
