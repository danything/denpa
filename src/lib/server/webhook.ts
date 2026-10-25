import { eq } from "drizzle-orm";

import type { WebhookEvent } from "../webhook-events";
import { now, orm } from "./db";
import { webhooks } from "./schema";

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
  /** 人が読む1行。Discord や Slack にそのまま出せる形式にしておく */
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

/** 空なら全部受け取る。壊れた行は列の読み取り関数が空にする (`schema.ts`) ので、ここでは構えない */
function subscribed(webhook: Webhook, event: WebhookEvent): boolean {
  return webhook.events.length === 0 || webhook.events.includes(event);
}

/**
 * 送って、結果を行に残す。戻り値も同じ結果 (`ok` か失敗の理由)。
 * 設定画面の「テスト送信」はこれを待つ (結果を見たいので)
 *
 * **宛先のアドレスは縛らない。** 自宅の Home Assistant のような LAN の中の通知先が
 * ふつうにあり、通知先を決めるのは denpa の画面を使える人だけだから。代わりに、
 * 通知先を足がかりに別の所を覗かせない:
 *
 * - **リダイレクトは追わない。** 外の通知先が内側の URL へ飛ばしても、そこへは送らない
 * - **相手の本文は残さない・返さない。** 結果は HTTP のステータスコードだけ (テスト送信で内側の
 *   サービスの中身を読み出す道具にしない)
 * - **ログには URL ではなくホストだけ。** Discord や Slack の URL はパスそのものが鍵
 */
export async function send(
  webhook: Webhook,
  payload: Payload,
): Promise<string> {
  const at = now();
  let status = "ok";
  try {
    const res = await fetch(webhook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "manual",
      // 相手が遅くても録画側を待たせない
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ ...payload, sentAt: at }),
    });
    // 本文は読まずに捨てる (接続を手放すため)
    await res.body?.cancel();
    if (res.status >= 300 && res.status < 400)
      status = `${res.status} (リダイレクトは追いません)`;
    else if (!res.ok) status = String(res.status);
  } catch (error) {
    status = failure(error);
  }

  orm()
    .update(webhooks)
    .set({ last_status: status, last_sent_at: at })
    .where(eq(webhooks.id, webhook.id))
    .run();
  if (status !== "ok")
    console.error(`[webhook] ${hostOf(webhook.url)} への送信に失敗: ${status}`);
  return status;
}

/** 送れなかった理由。例外の文には URL が入りうるので、決まった言葉とエラーコードだけにする */
export function failure(error: unknown): string {
  if (error === null || typeof error !== "object") return "繋がりませんでした";
  // AbortSignal.timeout は DOMException で投げる (Error を継がない実装もある)
  if ("name" in error && error.name === "TimeoutError") return "時間切れです";
  const code = "code" in error ? String(error.code) : "";
  return /^[\w-]{1,40}$/.test(code)
    ? `繋がりませんでした (${code})`
    : "繋がりませんでした";
}

/** 通知先にできる URL か。http か https で、ホストがあるもの */
export function webhookUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname !== ""
    );
  } catch {
    return false;
  }
}

/** ログに出す通知先。ホストだけ (パスとクエリは鍵を含みうる) */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(読めない URL)";
  }
}

/** 投げっぱなしにする。呼び出し側は待たない */
export function notify(payload: Payload): void {
  const enabled = orm()
    .select()
    .from(webhooks)
    .where(eq(webhooks.enabled, true))
    .all();
  for (const webhook of enabled) {
    if (!subscribed(webhook, payload.event)) continue;
    void send(webhook, payload);
  }
}
