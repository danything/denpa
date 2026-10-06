import { fail } from '@sveltejs/kit';
import { and, gt, lte, sql } from 'drizzle-orm';
import { channelNumber } from '#lib/format.js';
import { LAST_COOKIE, type LiveCodec } from '#lib/live.js';
import { orm } from '#lib/server/db.js';
import { airing, CURRENT_SERVICES, SERVICE_ORDER, SERVICE_TYPE_ORDER } from '#lib/server/epg.js';
import { warm } from '#lib/server/live.js';
import { recordAiring } from '#lib/server/reservations.js';
import { programs, services as stations } from '#lib/server/schema.js';
import { settings } from '#lib/server/settings.js';
import type { Service } from '#lib/types.js';
import type { Actions } from './$types';

/**
 * ライブ視聴で選べる局と、いま流れている番組。
 *
 * **番組表と同じ並びにする** (`SERVICE_ORDER`)。番組表で見つけた局を、ここでも
 * 同じ位置で探せるようにするため。
 *
 * 取り残しの局は出さない (`CURRENT_SERVICES` と `airing`)。出すと、選んでも
 * 映らない行が並ぶ — 終わったチャンネルの枠が SDT に残っていることがある。
 */
export interface LiveChannel {
    /** `service.id`。一覧の目印 */
    id: number;
    name: string;
    type: string;
    /** 物理チャンネル。これで選局する */
    channel: string;
    /**
     * テレビに出ている番号。**探すときの手掛かりはこれ。**
     *
     * 地上波はリモコン番号 (1〜12)。BS と CS は**サービスID がそのまま3桁番号**
     * にあたる (BS朝日1=151、WOWOWプライム=191、時代劇専門ch=292)。
     */
    number: number | null;
    hasLogo: boolean;
    /** いま流れている番組。無いこともある (番組表がまだ薄い局) */
    now: { id: number; name: string; startAt: number; endAt: number; description: string | null } | null;
}

/**
 * 画面が覚えている前回の局 (`live-player.svelte.ts` の `remember` が置く cookie)。
 *
 * 壊れていても無視するだけでよい — 覚えていないときと同じで、一覧の先頭が出る
 */
function remembered(
    raw: string | undefined,
    channels: LiveChannel[],
): { channel: LiveChannel; audio?: string; codec?: LiveCodec; raw?: boolean } | null {
    if (raw === undefined) return null;
    try {
        const saved = JSON.parse(raw) as Record<string, unknown>;
        const found = channels.find(
            (channel) => channel.type === saved['channelType'] && channel.channel === saved['channel'],
        );
        if (found === undefined) return null;
        return {
            channel: found,
            ...(typeof saved['audio'] === 'string' ? { audio: saved['audio'] } : {}),
            // 覚えていない形を渡さない。知らない値なら既定 (H.264) に落ちる
            ...(saved['codec'] === 'av1' ? { codec: 'av1' as const } : {}),
            // 前回は生で見ていた (`TuneCommand.raw`)。画面はそのまま生で頼み、サーバは先回りする
            ...(saved['raw'] === true ? { raw: true } : {}),
        };
    } catch {
        return null;
    }
}

export function load(event) {
    const { url, cookies } = event;
    const at = Date.now();
    // テレビと同じ並び (SERVICE_TYPE_ORDER / SERVICE_ORDER)。番組表とも揃えてある
    const services: Service[] = orm()
        .select()
        .from(stations)
        .where(sql.raw(CURRENT_SERVICES))
        .orderBy(sql.raw(SERVICE_TYPE_ORDER), sql.raw(SERVICE_ORDER))
        .all();

    /*
     * いま流れているものだけ引く。番組表を丸ごと持ってくると、局の数 × 8日ぶんに
     * なって画面が出るまで待たされる (実機で 25,000 件を超える)
     */
    const now = orm()
        .select({
            id: programs.id,
            service_id: programs.service_id,
            name: programs.name,
            start_at: programs.start_at,
            end_at: programs.end_at,
            // 概要も採る。**右で詳細を出すのに要る** (`programDetail`)
            description: programs.description,
        })
        .from(programs)
        .where(and(lte(programs.start_at, at), gt(programs.end_at, at)))
        .all();
    const byService = new Map(now.map((program) => [program.service_id, program]));

    const channels: LiveChannel[] = airing(services, now).map((service) => {
        const program = byService.get(service.id);
        return {
            id: service.id,
            name: service.name,
            type: service.type,
            channel: service.channel,
            number: channelNumber(service),
            hasLogo: service.has_logo,
            now:
                program === undefined
                    ? null
                    : {
                          id: program.id,
                          name: program.name,
                          startAt: program.start_at,
                          endAt: program.end_at,
                          description: program.description,
                      },
        };
    });

    /*
     * **どの局で開くかは、ここで決める。**
     *
     * 1. 番組表の「視聴」から名指しで来た局 (`?service=`)。押した人はそれを
     *    見に来ているので、覚えている前回の局より優先する。**居ない番号は
     *    使わない** — 局が入れ替わったあとの古いリンクを踏んでも、いつもの
     *    前回の局で開く
     * 2. 画面が覚えている前回の局 (`LAST_COOKIE`)
     * 3. 一覧の先頭 = リモコン番号のいちばん若い局
     *
     * **決めるのをここ1箇所にしてある。** 画面にも同じ判断を持たせていた頃は、
     * ずれたときに「先に焼いたものが使われず、画面は別の局を開く」という形で
     * 静かに壊れた。画面は決まったものを開くだけ
     */
    const asked = Number(url.searchParams.get('service'));
    const named = channels.find((channel) => channel.id === asked);
    const kept = remembered(cookies.get(LAST_COOKIE), channels);
    const saved = named === undefined ? kept : null;
    const target = named ?? saved?.channel ?? channels[0];

    const start =
        target === undefined
            ? null
            : {
                  channelType: target.type,
                  channel: target.channel,
                  serviceId: target.id,
                  // 音声の控えは、同じ局に戻ったときだけ活かす
                  ...(saved?.audio === undefined ? {} : { audio: saved.audio }),
                  /*
                   * **焼き方は局が変わっても引き継ぐ。** 音声と違って番組の中身で
                   * 決まるものではなく、その端末で出るかどうかの話なので、
                   * 局を選び直すたびに H.264 へ戻されては困る
                   */
                  ...(kept?.codec === undefined ? {} : { codec: kept.codec }),
                  // 生 (MPEG-2) で見るかも同じく引き継ぐ
                  ...(kept?.raw === true ? { raw: true } : {}),
              };

    /*
     * **繋いでくる前に焼きはじめる** (`live.warm`)。画面が動き出して札を取り、
     * WebSocket が繋がるまでの 160ms を、ffmpeg の立ち上がりと重ねる
     */
    if (start !== null) {
        // **前回が生なら生で温める。** 外れても困らない (来なければ 8秒で畳む)
        const raw = start.raw === true;
        warm(start.channelType, start.channel, start.serviceId, start.audio, start.codec, raw);
    }

    /*
     * **データ放送に渡す郵便番号** (設定画面で入れるもの)。放送のアプリは
     * これで天気や地域のニュースをどこの分にするかを決める。受け取るのは
     * 端末の中 (NVRAM) だが、置き場はサーバにしてある — 家の場所は端末では
     * 変わらないので、端末ごとに訊き直すのは無駄
     */
    const current = settings();
    return { channels, start, postalCode: current.postalCode, bmlNetwork: current.bmlNetwork };
}

export const actions = {
    /**
     * **いま観ている番組を録る** (絵の右上の録画ボタン)。
     *
     * 番組表からいま流れている番組を引いて、手動予約と同じ道に乗せる (`recordAiring`)。
     * 既に予約済み・録画中なら二重には録らない (予約は番組ごとに1本)
     */
    record: async ({ request }) => {
        const form = await request.formData();
        const serviceId = Number(form.get('service'));
        if (!Number.isInteger(serviceId)) return fail(400, { message: 'チャンネルの指定が不正です' });

        // アプリの `POST /api/services/<id>/record` と同じ道 (`recordAiring`)
        const result = await recordAiring(serviceId);
        if (!result.ok) return fail(result.status, { message: result.message });
        return { recorded: result.name };
    },
} satisfies Actions;
