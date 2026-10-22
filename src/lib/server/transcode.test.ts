import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * **その場で変換する本数の枠** (`transcode.ts`)。DB は一時ファイルへ。
 * GPU の見立て (`hwenc`) はほかの試験が同じプロセスで差し替えていることがあるので、既定の本数は
 * `transcodeAuto` の答えで比べる
 */
const dir = mkdtempSync(join(tmpdir(), 'denpa-transcode-'));
const { config } = await import('./config');
const before = config.dbPath;
config.dbPath = join(dir, 'denpa.db');
afterAll(() => {
    config.dbPath = before;
    rmSync(dir, { recursive: true, force: true });
});

const { parseTranscodeLimit, saveSettings, settings } = await import('./settings');
const { holdTranscode, TRANSCODE_DEFAULT, transcodeAuto, transcodeLimit, transcodesInUse } =
    await import('./transcode');

test('既定は GPU の有無で 2 本か 4 本', () => {
    const defaults: number[] = [TRANSCODE_DEFAULT.cpu, TRANSCODE_DEFAULT.gpu];
    expect(defaults).toContain(transcodeAuto());
    expect(transcodeLimit()).toBe(transcodeAuto());
});

test('上限まで取ったら断り、返せばまた取れる。2 回返しても 1 本ぶん', () => {
    saveSettings({ transcodeLimit: 2 });
    const a = holdTranscode();
    const b = holdTranscode();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(holdTranscode()).toBeNull();
    a?.();
    a?.();
    expect(transcodesInUse()).toBe(1);
    const c = holdTranscode();
    expect(c).not.toBeNull();
    b?.();
    c?.();
    expect(transcodesInUse()).toBe(0);
});

test('設定で変えられる。空に戻せば自動', () => {
    saveSettings({ transcodeLimit: 3 });
    expect(settings().transcodeLimit).toBe(3);
    expect(transcodeLimit()).toBe(3);
    saveSettings({ transcodeLimit: null });
    expect(settings().transcodeLimit).toBeNull();
    expect(transcodeLimit()).toBe(transcodeAuto());
});

test('本数の読み方: 1〜16 の整数だけ。ほかは自動', () => {
    expect(parseTranscodeLimit('4')).toBe(4);
    expect(parseTranscodeLimit('')).toBeNull();
    expect(parseTranscodeLimit('0')).toBeNull();
    expect(parseTranscodeLimit('17')).toBeNull();
    expect(parseTranscodeLimit('2.5')).toBeNull();
    expect(parseTranscodeLimit(undefined)).toBeNull();
});
