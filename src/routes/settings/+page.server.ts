import { basename } from 'node:path';
import { fail } from '@sveltejs/kit';
import { eq, not } from 'drizzle-orm';
import { chooseHw, HW_CODECS, HW_EVERY, HW_SOFTWARE, hwUsable } from '#lib/hw.js';
import { parsePrefectureField } from '#lib/prefecture.js';
import { isCmMode } from '#lib/server/cm.js';
import { now, orm } from '#lib/server/db.js';
import { liveTokens, revokeToken } from '#lib/server/device-auth.js';
import { describeDevice, type HwEncode, hwEncode, probe } from '#lib/server/hwenc.js';
import { available as migrateAvailable, source, start, status } from '#lib/server/migrate.js';
import { webhooks } from '#lib/server/schema.js';
import {
    normalizePostalCode,
    parseTranscodeLimit,
    saveSettings,
    settings,
    TRANSCODE_LIMIT_MAX,
} from '#lib/server/settings.js';
import { transcodeAuto } from '#lib/server/transcode.js';
import { send } from '#lib/server/webhook.js';
import type { VideoCodec } from '#lib/types.js';
import { EVENTS } from '#lib/webhook-events.js';

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
    const current = settings();
    const hw = hwEncode();
    return {
        recording: current,
        /**
         * GPU でエンコードできるか (server/hwenc.ts)。起動直後の確かめが終わっていなければ
         * promise のまま渡す — 画面は「確認中」を出して待つ
         */
        hw: hw.probed ? forScreen(hw) : probe().then(forScreen),
        /** データ放送に渡すもの。郵便番号・都道府県と、双方向の中継を許すか */
        broadcast: {
            postalCode: current.postalCode,
            prefecture: current.prefecture,
            bmlNetwork: current.bmlNetwork,
        },
        /** その場で変換する本数 (`server/transcode.ts`)。自動のときの本数と、選べる本数 */
        transcode: {
            auto: transcodeAuto(),
            choices: Array.from({ length: TRANSCODE_LIMIT_MAX }, (_, i) => i + 1),
        },
        webhooks: orm().select().from(webhooks).orderBy(webhooks.id).all(),
        /** ペアリングしたテレビ (アクセストークン。device-auth.ts) */
        devices: liveTokens(),
        events: EVENTS,
        migrate: {
            available: migrateAvailable(),
            source: source.recordedDir,
            status: status(),
        },
    };
}

export const actions = {
    /**
     * 録画のしかた。番組ごとに変えたくなることが実際にはほとんど無いので全体で1つ。
     * コーデックごとのエンコーダ (GPU) と、その場で変換する本数も同じ節で受ける
     */
    saveRecording: async ({ request }) => {
        const form = await request.formData();
        // **コーデックは複数選べる** (`av1` / `h264` を両方)。1つも選ばなければ「エンコードしない」。カンマ区切りで持つ
        const codecs = form
            .getAll('codecs')
            .map(String)
            .filter((c): c is 'av1' | 'h264' => c === 'av1' || c === 'h264');
        const cmCut = String(form.get('cmCut') ?? '');
        if (!isCmMode(cmCut)) {
            return fail(400, { message: 'CMの指定が不正です' });
        }
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
            cmCut,
            keepOriginal: form.get('keepOriginal') === 'on',
            freeOnly: form.get('freeOnly') === 'on',
            fpsDetect: form.get('fpsDetect') === 'on',
            hwAllow,
            ...(transcodeLimit === undefined ? {} : { transcodeLimit }),
        });
        return { success: true, saved: true };
    },

    /** GPU を挿し直した・権限を直したあとに、再起動せずに確かめ直す */
    probeHw: async () => {
        await probe();
        return { success: true, probed: true };
    },

    /**
     * データ放送に渡す郵便番号と都道府県。
     *
     * **どちらも空にできる** (「渡さない」という選択。都道府県の未設定は 255)。
     * 空にしても危なくない — 放送のアプリが地域を決められなくなるだけ
     */
    saveBroadcast: async ({ request }) => {
        const form = await request.formData();
        const raw = String(form.get('postalCode') ?? '').trim();
        const postalCode = normalizePostalCode(raw);
        if (raw !== '' && postalCode === '') {
            return fail(400, { message: '郵便番号は数字7桁で入れてください (例 1000001)' });
        }
        // 選ぶ欄なので、表に無い番号は画面の外から来たもの。黙って未設定にせず断る
        const field = form.get('prefecture');
        const prefecture = parsePrefectureField(field === null ? null : String(field));
        if (prefecture === null) {
            return fail(400, { message: '都道府県の指定が正しくありません' });
        }
        saveSettings({ postalCode, prefecture, bmlNetwork: form.get('bmlNetwork') === 'on' });
        return { success: true, saved: true };
    },

    addWebhook: async ({ request }) => {
        const form = await request.formData();
        const url = String(form.get('url') ?? '').trim();
        if (!/^https?:\/\//.test(url)) {
            return fail(400, { message: 'http(s) で始まるURLを入れてください' });
        }
        // 何も選ばなければ全部の通知を受け取る
        const events = form.getAll('events').map(String).filter(Boolean);

        orm().insert(webhooks).values({ url, events, enabled: true, created_at: now() }).run();
        return { success: true, webhookAdded: true };
    },

    toggleWebhook: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'IDが不正です' });
        orm()
            .update(webhooks)
            .set({ enabled: not(webhooks.enabled) })
            .where(eq(webhooks.id, id))
            .run();
        return { success: true };
    },

    /** テレビのアクセストークンを無効にする。テレビは次に API を呼んだときに 401 を受けて、ペアリングし直しになる */
    revokeDevice: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isInteger(id)) return fail(400, { message: 'IDが不正です' });
        revokeToken(id);
        return { success: true };
    },

    deleteWebhook: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'IDが不正です' });
        orm().delete(webhooks).where(eq(webhooks.id, id)).run();
        return { success: true };
    },

    testWebhook: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        const webhook = orm().select().from(webhooks).where(eq(webhooks.id, id)).get();
        if (webhook === undefined) return fail(400, { message: '通知先が見つかりません' });

        const status = await send(webhook, {
            event: 'recording.finished',
            text: 'denpa からのテスト送信です',
        });
        return { success: true, tested: status };
    },

    /**
     * EPGStation からの引き継ぎ。数百GBのコピーになるので開始だけ受けて裏で進める。
     * 進捗は SSE で降ってくる。
     */
    migrate: async ({ request }) => {
        const form = await request.formData();
        const options = { apply: form.get('apply') === 'on', move: form.get('move') === 'on' };
        const result = start(options);
        if (!result.started) return fail(409, { message: result.message });
        return { success: true, migrate: result.message };
    },
};
