import { basename } from 'node:path';
import { fail } from '@sveltejs/kit';
import { chooseHw, HW_CODECS, HW_EVERY, HW_SOFTWARE, hwUsable } from '#lib/hw.js';
import { isCmMode } from '#lib/server/cm.js';
import { describeDevice, type HwEncode, hwEncode, probe } from '#lib/server/hwenc.js';
import { parseTranscodeLimit, saveSettings, settings, TRANSCODE_LIMIT_MAX } from '#lib/server/settings.js';
import { transcodeAuto } from '#lib/server/transcode.js';
import type { VideoCodec } from '#lib/types.js';

/** 画面に渡す形。GPU ごとの一言 (`summary`) と、testid に使う GPU の名前 (`port`) を添える */
function forScreen(hw: HwEncode) {
    return {
        ...hw,
        devices: hw.devices.map((device) => ({
            ...device,
            summary: describeDevice(device),
            port: basename(device.path),
        })),
    };
}

export function load() {
    const hw = hwEncode();
    return {
        recording: settings(),
        /**
         * GPU でエンコードできるか (server/hwenc.ts)。起動直後の確かめが終わっていなければ
         * promise のまま渡す — 画面は「確認中」を出して待つ
         */
        hw: hw.probed ? forScreen(hw) : probe().then(forScreen),
        /** その場で変換する本数 (`server/transcode.ts`)。自動のときの本数と、選べる本数 */
        transcode: {
            auto: transcodeAuto(),
            choices: Array.from({ length: TRANSCODE_LIMIT_MAX }, (_, i) => i + 1),
        },
    };
}

export const actions = {
    /**
     * エンコード。番組ごとに変えたくなることが実際にはほとんど無いので全体で1つ。
     * コーデックごとのエンコーダ (GPU)・その場で変換する本数・元のTS・コマ数も同じ節で受ける。
     * **節ごとにフォームが分かれている** (CM・自動予約は別の action)。ここで受けない値には触らない
     */
    saveEncoding: async ({ request }) => {
        const form = await request.formData();
        // **コーデックは複数選べる** (`av1` / `h264` を両方)。1つも選ばなければ「エンコードしない」。カンマ区切りで持つ
        const codecs = form
            .getAll('codecs')
            .map(String)
            .filter((c): c is 'av1' | 'h264' => c === 'av1' || c === 'h264');
        // その場で変換する本数の上限。空は自動 (GPU の有無で決める)。欄が無ければ前のまま
        const rawLimit = form.get('transcodeLimit');
        const transcodeLimit = rawLimit === null ? undefined : parseTranscodeLimit(String(rawLimit));
        if (rawLimit !== null && String(rawLimit).trim() !== '' && transcodeLimit === null) {
            return fail(400, { message: '本数が不正です' });
        }
        /*
         * **コーデックごとのエンコーダ** (`hw.av1` / `hw.h264`。ソフトウェア・デバイスの path・順番に使う)。
         * 持ち方はデバイス × 方式 × コーデックのまま (`chooseHw`)。欄が無いコーデック (GPU を
         * 確かめ終わる前に保存した・そのコーデックを使えるデバイスが無い) と、いま見えていないデバイスを
         * 選んできたもの (画面を開いたあとに確かめ直して GPU が変わった) は前のまま
         */
        const devices = hwEncode().devices;
        let hwAllow = settings().hwAllow;
        for (const codec of HW_CODECS) {
            const choice = String(form.get(`hw.${codec}`) ?? '');
            const known =
                choice === HW_SOFTWARE ||
                choice === HW_EVERY ||
                hwUsable(devices, codec).some((device) => device.path === choice);
            if (known) hwAllow = chooseHw(hwAllow, devices, codec, choice);
        }
        saveSettings({
            // 順序は読むとき (parseCodecs) に AV1 を先頭へ寄せる。ここは来たまま
            codec: (codecs.length > 0 ? codecs.join(',') : 'none') as VideoCodec,
            keepOriginal: form.get('keepOriginal') === 'on',
            fpsDetect: form.get('fpsDetect') === 'on',
            hwAllow,
            ...(transcodeLimit === undefined ? {} : { transcodeLimit }),
        });
        return { success: true, saved: true };
    },

    /** CMの扱い (チャプターを打つ・切り取る・何もしない) */
    saveCm: async ({ request }) => {
        const cmCut = String((await request.formData()).get('cmCut') ?? '');
        if (!isCmMode(cmCut)) {
            return fail(400, { message: 'CMの指定が不正です' });
        }
        saveSettings({ cmCut });
        return { success: true, saved: true };
    },

    /** 自動予約を無料放送だけにするか */
    saveReserve: async ({ request }) => {
        saveSettings({ freeOnly: (await request.formData()).get('freeOnly') === 'on' });
        return { success: true, saved: true };
    },

    /** GPU を挿し直した・権限を直したあとに、再起動せずに確かめ直す */
    probeHw: async () => {
        await probe();
        return { success: true, probed: true };
    },
};
