import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findDevices, type HwDevice, hwArgs, hwChain, liveHw, liveHwArgs } from './hwenc';

const A: HwDevice = {
    path: '/dev/dri/renderD128',
    label: 'A',
    qsv: ['h264', 'av1'],
    vaapi: ['h264', 'av1'],
    cqp: [],
    full: [],
};
const B: HwDevice = {
    path: '/dev/dri/renderD129',
    label: 'B',
    qsv: ['h264'],
    vaapi: ['h264'],
    cqp: [],
    full: [],
};

describe('GPU の道の選び方', () => {
    test('載っていない口は全部よい。同じ口の中では QSV → VA-API', () => {
        expect(hwChain('av1', {}, 0, [A, B])).toEqual([
            { device: A.path, kind: 'qsv' },
            { device: A.path, kind: 'vaapi' },
        ]);
    });

    test('口はジョブごとに回す。両方焼ける H.264 は先頭が入れ替わる', () => {
        const first = hwChain('h264', {}, 0, [A, B]).map((w) => w.device);
        const second = hwChain('h264', {}, 1, [A, B]).map((w) => w.device);
        expect(first).toEqual([A.path, A.path, B.path, B.path]);
        expect(second).toEqual([B.path, B.path, A.path, A.path]);
    });

    test('口ごとに外せる。A は AV1 だけ、B は H.264 だけ、のような割り振り', () => {
        const allow = {
            [A.path]: { qsv: ['av1' as const], vaapi: [] },
            [B.path]: { qsv: ['h264' as const], vaapi: ['h264' as const] },
        };
        expect(hwChain('h264', allow, 0, [A, B])).toEqual([
            { device: B.path, kind: 'qsv' },
            { device: B.path, kind: 'vaapi' },
        ]);
        expect(hwChain('av1', allow, 0, [A, B])).toEqual([{ device: A.path, kind: 'qsv' }]);
        // 使えないものは許しても出ない (B は AV1 を焼けない)
        expect(hwChain('av1', { [B.path]: { qsv: ['av1'], vaapi: ['av1'] } }, 0, [B])).toEqual([]);
    });

    test('口は最後の段の * で拾い、名前順', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dri-'));
        for (const name of ['renderD129', 'renderD128', 'card0']) writeFileSync(join(dir, name), '');
        expect(findDevices(`${dir}/renderD*`)).toEqual([`${dir}/renderD128`, `${dir}/renderD129`]);
        expect(findDevices('/nonexistent/renderD*')).toEqual([]);
    });
});

describe('ICQ を持たないドライバ (i965)', () => {
    const C: HwDevice = { ...B, path: '/dev/dri/renderD130', qsv: [], cqp: ['h264'] };

    test('CQP でだけ焼けた VA-API には印を付けて渡す', () => {
        expect(hwChain('h264', {}, 0, [C])).toEqual([{ device: C.path, kind: 'vaapi', cqp: true }]);
        // QSV には付けない (CQP に落とすのは VA-API の試しだけ)
        expect(hwChain('h264', {}, 0, [{ ...A, cqp: ['h264'] }])[0]).toEqual({ device: A.path, kind: 'qsv' });
    });

    test('CQP なら -qp で頼む。値は ICQ と同じ軸', () => {
        const icq = hwArgs({ device: C.path, kind: 'vaapi' }, 'h264').encoder;
        expect(icq).toEqual(['h264_vaapi', '-rc_mode', 'ICQ', '-global_quality', '24']);
        const cqp = hwArgs({ device: C.path, kind: 'vaapi', cqp: true }, 'h264').encoder;
        expect(cqp).toEqual(['h264_vaapi', '-rc_mode', 'CQP', '-qp', '24']);
        // AV1 の qp は 0〜255
        expect(hwArgs({ device: C.path, kind: 'vaapi', cqp: true }, 'av1').encoder).toContain('120');
    });
});

describe('ライブを GPU で焼く道', () => {
    const FULL: HwDevice = { ...A, full: ['h264'] };

    test('印が無ければ (使えなければ) ソフトウェア', () => {
        expect(liveHw('h264', {}, 0, [])).toBeNull();
        expect(liveHw('h264', { [A.path]: { qsv: [], vaapi: [] } }, 0, [A])).toBeNull();
    });

    test('復号から GPU で通せる VA-API を、同じ口の QSV より先に採る', () => {
        expect(liveHw('h264', {}, 0, [FULL])).toEqual({ way: { device: A.path, kind: 'vaapi' }, full: true });
        // 通せないコーデックは録画と同じ順 (QSV が先) で、焼くところだけ
        expect(liveHw('av1', {}, 0, [FULL])).toEqual({ way: { device: A.path, kind: 'qsv' }, full: false });
    });

    test('VA-API の印を外せば、復号から GPU も使わない', () => {
        const allow = { [A.path]: { qsv: ['h264' as const], vaapi: [] } };
        expect(liveHw('h264', allow, 0, [FULL])).toEqual({
            way: { device: A.path, kind: 'qsv' },
            full: false,
        });
    });

    test('遅れを作らない引数を足す (B フレームなし・先積みなし)', () => {
        const vaapi = liveHwArgs({ way: { device: A.path, kind: 'vaapi' }, full: false }, 'h264');
        expect(vaapi.input).toEqual(['-init_hw_device', `vaapi=va:${A.path}`, '-filter_hw_device', 'va']);
        expect(vaapi.filter).toEqual(['format=nv12', 'hwupload']);
        expect(vaapi.encoder.join(' ')).toBe(
            'h264_vaapi -rc_mode ICQ -global_quality 24 -bf 0 -async_depth 1',
        );

        const qsv = liveHwArgs({ way: { device: A.path, kind: 'qsv' }, full: false }, 'av1');
        expect(qsv.filter).toEqual(['format=nv12']);
        expect(qsv.encoder.join(' ')).toBe(
            'av1_qsv -preset veryfast -global_quality 24 -bf 0 -async_depth 1',
        );
    });

    test('復号から GPU なら、絵を GPU に置いたままインタレ解除して焼く', () => {
        const full = liveHwArgs({ way: { device: A.path, kind: 'vaapi', cqp: true }, full: true }, 'h264');
        expect(full.input.join(' ')).toBe(
            `-init_hw_device vaapi=va:${A.path} -hwaccel vaapi -hwaccel_output_format vaapi -hwaccel_device va`,
        );
        // CPU のフィルタ (format / hwupload) は挟まない
        expect(full.filter).toEqual(['deinterlace_vaapi=rate=field']);
        expect(full.encoder.join(' ')).toBe('h264_vaapi -rc_mode CQP -qp 24 -bf 0 -async_depth 1');
    });
});
