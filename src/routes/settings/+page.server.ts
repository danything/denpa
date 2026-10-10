import { basename } from 'node:path';
import { fail } from '@sveltejs/kit';
import { eq, not } from 'drizzle-orm';
import { HW_CODECS, HW_KINDS, type HwAllow, hwAllowed } from '#lib/hw.js';
import { isCmMode } from '#lib/server/cm.js';
import { now, orm } from '#lib/server/db.js';
import { liveTokens, revokeToken } from '#lib/server/device-auth.js';
import { describeDevice, type HwEncode, hwEncode, probe } from '#lib/server/hwenc.js';
import { available as migrateAvailable, source, start, status } from '#lib/server/migrate.js';
import { webhooks } from '#lib/server/schema.js';
import { normalizePostalCode, saveSettings, settings } from '#lib/server/settings.js';
import { send } from '#lib/server/webhook.js';
import type { VideoCodec } from '#lib/types.js';
import { EVENTS } from '#lib/webhook-events.js';

/** 画面に渡す形。口ごとの一言 (`summary`) と、testid に使う口の名前 (`port`) を添える */
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
         * GPU で焼けるか (server/hwenc.ts)。起動直後の確かめが終わっていなければ
         * promise のまま渡す — 画面は「確認中」を出して待つ
         */
        hw: hw.probed ? forScreen(hw) : probe().then(forScreen),
        /** データ放送に渡すもの。郵便番号と、双方向の中継を許すか */
        broadcast: { postalCode: current.postalCode, bmlNetwork: current.bmlNetwork },
        webhooks: orm().select().from(webhooks).orderBy(webhooks.id).all(),
        /** ペアリングしたテレビ (アプリの鍵。device-auth.ts) */
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
    /** 録画のしかた。番組ごとに変えたくなることが実際にはほとんど無いので全体で1つ */
    saveRecording: async ({ request }) => {
        const form = await request.formData();
        /*
         * **コーデックは複数選べる** (`av1` / `h264` を両方)。1つも選ばなければ
         * 「エンコードしない」。カンマ区切りで持ち、`encode` も一緒に合わせて
         * 書く — 古いDBに残っている `encode=false` を確実に上書きするため
         */
        const codecs = form
            .getAll('codecs')
            .map(String)
            .filter((c): c is 'av1' | 'h264' => c === 'av1' || c === 'h264');
        const cmCut = String(form.get('cmCut') ?? '');
        if (!isCmMode(cmCut)) {
            return fail(400, { message: 'CMの指定が不正です' });
        }
        saveSettings({
            // 順序は読むとき (parseCodecs) に AV1 を先頭へ寄せる。ここは来たまま
            codec: (codecs.length > 0 ? codecs.join(',') : 'none') as VideoCodec,
            encode: codecs.length > 0,
            cmCut,
            cmDetector: form.get('cmDetector') === 'silence' ? 'silence' : 'logo',
            keepOriginal: form.get('keepOriginal') === 'on',
            freeOnly: form.get('freeOnly') === 'on',
            fpsDetect: form.get('fpsDetect') === 'on',
        });
        return { success: true, saved: true };
    },

    /**
     * **GPU の口ごとの割り振り。** 画面で触れるのは使えるものの印だけなので、
     * 使えないもの・いま見えていない口は前の値をそのまま持ち越す (GPU を挿し替えた
     * ときにそのまま効く)。使えるものは印のとおりに
     */
    saveHw: async ({ request }) => {
        const form = await request.formData();
        const previous = settings().hwAllow;
        const next: HwAllow = { ...previous };
        for (const device of hwEncode().devices) {
            next[device.path] = Object.fromEntries(
                HW_KINDS.map((kind) => [
                    kind,
                    HW_CODECS.filter((codec) =>
                        device[kind].includes(codec)
                            ? form.get(`hw.${device.path}.${kind}.${codec}`) === 'on'
                            : hwAllowed(previous, device.path, kind, codec),
                    ),
                ]),
            ) as HwAllow[string];
        }
        saveSettings({ hwAllow: next });
        return { success: true, saved: true };
    },

    /** GPU を挿し直した・権限を直したあとに、再起動せずに確かめ直す */
    probeHw: async () => {
        await probe();
        return { success: true, probed: true };
    },

    /**
     * データ放送に渡す郵便番号。
     *
     * **空にできる** (「渡さない」という選択)。空にしても危なくない —
     * 放送のアプリが地域を決められなくなるだけ
     */
    saveBroadcast: async ({ request }) => {
        const form = await request.formData();
        const raw = String(form.get('postalCode') ?? '').trim();
        const postalCode = normalizePostalCode(raw);
        if (raw !== '' && postalCode === '') {
            return fail(400, { message: '郵便番号は数字7桁で入れてください (例 1000001)' });
        }
        saveSettings({ postalCode, bmlNetwork: form.get('bmlNetwork') === 'on' });
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

        // name は廃止したが、列は残してある (既定 '' なので入れなくてよい)
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

    /** テレビの鍵を止める。テレビは次に API を叩いたときに 401 を受けて、ペアリングし直しになる */
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
