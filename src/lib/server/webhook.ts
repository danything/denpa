import { eq } from 'drizzle-orm';
import type { WebhookEvent } from '../webhook-events';
import { now, orm } from './db';
import { webhooks } from './schema';

/**
 * 録画の節目を外部に知らせる。
 *
 * 録画は失敗しても画面を開くまで気づけないので、外に飛ばせるようにしておく。
 * 送信は投げっぱなしにする。通知が届かないことより、通知の相手が遅いせいで
 * 録画やエンコードが止まるほうが困るため。
 */

export type Webhook = typeof webhooks.$inferSelect;

export interface Payload {
    event: WebhookEvent;
    /** 人が読む1行。Discord や Slack にそのまま出せる形にしておく */
    text: string;
    recording?: {
        id: number;
        name: string;
        service: string;
        startAt: number;
        endAt: number;
    };
    error?: string;
}

function subscribed(webhook: Webhook, event: WebhookEvent): boolean {
    try {
        const events = JSON.parse(webhook.events) as string[];
        // 空なら全部受け取る
        return events.length === 0 || events.includes(event);
    } catch {
        return false;
    }
}

async function post(webhook: Webhook, payload: Payload): Promise<void> {
    const at = now();
    let status = 'ok';
    try {
        const res = await fetch(webhook.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // 相手が遅くても録画側を待たせない
            signal: AbortSignal.timeout(10_000),
            body: JSON.stringify({ ...payload, sentAt: at }),
        });
        if (!res.ok) status = `${res.status} ${(await res.text()).slice(0, 200)}`;
    } catch (error) {
        status = String(error instanceof Error ? error.message : error);
    }

    orm()
        .update(webhooks)
        .set({ last_status: status, last_sent_at: at })
        .where(eq(webhooks.id, webhook.id))
        .run();
    if (status !== 'ok') console.error(`[webhook] ${webhook.url} への送信に失敗: ${status}`);
}

/** 投げっぱなしにする。呼び出し側は待たない */
export function notify(payload: Payload): void {
    const enabled = orm().select().from(webhooks).where(eq(webhooks.enabled, 1)).all();
    for (const webhook of enabled) {
        if (!subscribed(webhook, payload.event)) continue;
        void post(webhook, payload);
    }
}

/** 設定画面の「テスト送信」。こちらは結果を見たいので待つ */
export async function send(webhook: Webhook, payload: Payload): Promise<string> {
    await post(webhook, payload);
    return (
        orm()
            .select({ last_status: webhooks.last_status })
            .from(webhooks)
            .where(eq(webhooks.id, webhook.id))
            .get()?.last_status ?? 'unknown'
    );
}
