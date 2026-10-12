/**
 * **互換モード** — 動画を `<video>` でなく canvas に描くか (端末ごと)。
 *
 * テスラの車載ブラウザは停車中でも `<video>` の再生を止める。canvas に描くものは止めない
 * ので、ライブ・追っかけの H.264 / AV1 も、放送のままの MPEG-2 (`raw/`) と同じく worker でデコードして
 * canvas に描く (`raw/fmp4.ts`)。
 *
 * - 置き場は localStorage の鍵1つ (`keep.ts`)。**入れた・切ったと明示した値が勝つ**
 * - 明示が無ければ、UA にテスラの印 (`Tesla/<数字>`) がある端末は入、それ以外は切。
 *   **判定は画面だけ** — サーバは UA を見ない (送るものは同じ fMP4)
 * - 運転中の注意 (`DRIVE_NOTICE`) を一度見せたかも同じく端末に覚える。設定で入れたとき
 *   (確かめる窓) と、UA の既定で入っている端末で初めて canvas で再生する前に出す
 */

import { read, write } from '#lib/keep.js';

/** 入れたか切ったか (`on` / `off`)。無ければ UA で決める */
const CANVAS_VIDEO = 'canvas-video';
/** 運転中の注意を見せたか (`1`) */
const DRIVE_NOTICE = 'canvas-drive-notice';

export type CanvasChoice = 'on' | 'off' | null;

/** テスラの車載ブラウザの UA か (`Tesla/2026.32.1` のような印) */
export function isTesla(ua: string): boolean {
    return /\bTesla\/\d/.test(ua);
}

/** 明示した値と UA から、入れるかを決める。**明示した値が勝つ** */
export function decide(choice: CanvasChoice, ua: string): boolean {
    return choice === null ? isTesla(ua) : choice === 'on';
}

/** 明示した値。触っていなければ null */
function canvasChoice(): CanvasChoice {
    const value = read(CANVAS_VIDEO);
    return value === 'on' || value === 'off' ? value : null;
}

function userAgent(): string {
    return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

/** この端末で互換モードを使うか */
export function canvasVideo(): boolean {
    return decide(canvasChoice(), userAgent());
}

/** この端末がテスラの車載ブラウザか (設定画面の「この端末で使えるもの」に出す) */
export function teslaBrowser(): boolean {
    return isTesla(userAgent());
}

/** 入れる・切る。**明示した値として覚える** (UA の既定より勝つ) */
export function chooseCanvas(on: boolean): void {
    write(CANVAS_VIDEO, on ? 'on' : 'off');
}

/** 運転中の注意をもう見せたか */
export function driveNoticeSeen(): boolean {
    return read(DRIVE_NOTICE) === '1';
}

/** 運転中の注意を見せた (「わかりました」を押した) */
export function seeDriveNotice(): void {
    write(DRIVE_NOTICE, '1');
}
