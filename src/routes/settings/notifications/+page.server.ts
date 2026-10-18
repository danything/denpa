import { fail } from '@sveltejs/kit';
import { eq, not } from 'drizzle-orm';
import { now, orm } from '#lib/server/db.js';
import { webhooks } from '#lib/server/schema.js';
import { send } from '#lib/server/webhook.js';
import { EVENTS } from '#lib/webhook-events.js';

export function load() {
    return {
        webhooks: orm().select().from(webhooks).orderBy(webhooks.id).all(),
        events: EVENTS,
    };
}

export const actions = {
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
};
