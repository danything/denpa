import { fail } from "@sveltejs/kit";
import { and, gt, lte, sql } from "drizzle-orm";

import { channelNotice } from "#lib/channel-notice.js";
import { channelNumber } from "#lib/format.js";
import { LAST_COOKIE, type LiveCodec } from "#lib/live.js";
import { orm } from "#lib/server/db.js";
import {
  airing,
  currentServices,
  SERVICE_ORDER,
  SERVICE_TYPE_ORDER,
  serviceCounts,
} from "#lib/server/epg.js";
import { warm } from "#lib/server/live.js";
import { recordAiring } from "#lib/server/reservations.js";
import { programs, services as stations } from "#lib/server/schema.js";
import { settings } from "#lib/server/settings.js";
import type { Service } from "#lib/types.js";

import type { Actions } from "./$types";

/**
 * ライブ視聴で選べる局と、いま流れている番組。
 *
 * **番組表と同じ並びにする** (`SERVICE_ORDER`)。番組表で見つけた局を、ここでも
 * 同じ位置で探せるようにするため。
 *
 * 取り残しの局は出さない (`currentServices` と `airing`)。出すと、選んでも
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
   * 放送の局の番号 (original_network_id と service_id)。データ放送が「この局へ」と言ってきたとき
   * (epgTune) に、一覧から局を探すのに使う
   */
  networkId: number;
  serviceId: number;
  /**
   * テレビに出ている番号。**探すときの手掛かりはこれ。**
   *
   * 地上波はリモコン番号 (1〜12)。BS と CS は**サービスID がそのまま3桁番号**
   * にあたる (BS朝日1=151、WOWOWプライム=191、時代劇専門ch=292)。
   */
  number: number | null;
  hasLogo: boolean;
  /** いま流れている番組。無いこともある (番組表がまだ薄い局) */
  now: {
    id: number;
    name: string;
    startAt: number;
    endAt: number;
    description: string | null;
  } | null;
}

/**
 * 画面が覚えている前回の局 (`live-player.svelte.ts` の `remember` が置く cookie)。
 *
 * 壊れていても無視するだけでよい — 覚えていないときと同じで、一覧の先頭が出る
 */
function remembered(
  raw: string | undefined,
  channels: LiveChannel[],
): {
  channel: LiveChannel;
  audio?: string;
  codec?: LiveCodec;
  raw?: boolean;
} | null {
  if (raw === undefined) return null;
  try {
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const found = channels.find(
      (channel) =>
        channel.type === saved["channelType"] &&
        channel.channel === saved["channel"],
    );
    if (found === undefined) return null;
    return {
      channel: found,
      ...(typeof saved["audio"] === "string" ? { audio: saved["audio"] } : {}),
      // 覚えていない形式を渡さない。知らない値なら既定 (H.264) に落ちる
      ...(saved["codec"] === "av1" ? { codec: "av1" as const } : {}),
      // 前回は放送のまま見ていた (`TuneCommand.raw`)。画面はそのまま放送のままでリクエストし、サーバは先回りする
      ...(saved["raw"] === true ? { raw: true } : {}),
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
    .where(currentServices())
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
  const byService = new Map(
    now.map((program) => [program.service_id, program]),
  );

  const channels: LiveChannel[] = airing(services, now).map((service) => {
    const program = byService.get(service.id);
    return {
      id: service.id,
      name: service.name,
      type: service.type,
      channel: service.channel,
      networkId: service.network_id,
      serviceId: service.service_id,
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
   * どの局で開くかは、ここ1箇所で決める (画面に同じ判断を持たせると、先にエンコードしたものが使われずに壊れた)。
   * 番組表から名指しで来た局 (`?service=`。無い番号は使わない) → 前回の局 (`LAST_COOKIE`) → 一覧の先頭
   */
  const asked = Number(url.searchParams.get("service"));
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
          // エンコード方式と放送のまま (MPEG-2) かは、局が変わっても引き継ぐ (その端末で出るかの話)
          ...(kept?.codec === undefined ? {} : { codec: kept.codec }),
          ...(kept?.raw === true ? { raw: true } : {}),
        };

  /*
   * 繋いでくる前にエンコードし始める (`live.warm`。WebSocket が繋がるまでの 160ms を ffmpeg の立ち上がりと重ねる)。
   * 前回が放送のままならそのままで温める (外れても来なければ 8秒で畳む)
   */
  if (start !== null)
    warm(
      start.channelType,
      start.channel,
      start.serviceId,
      start.audio,
      start.codec,
      start.raw === true,
    );

  // データ放送に渡す郵便番号と都道府県。家の場所は端末では変わらないので、置き場はサーバ
  const current = settings();
  return {
    channels,
    /** 局が無いときに上に出す案内 (`#lib/channel-notice.ts`。出すのは `+layout.svelte`) */
    channelNotice: channelNotice(serviceCounts()),
    start,
    postalCode: current.postalCode,
    prefecture: current.prefecture,
    bmlNetwork: current.bmlNetwork,
  };
}

export const actions = {
  /**
   * **いま観ている番組を録る** (映像の右上の録画ボタン)。
   *
   * 番組表からいま流れている番組を引いて、手動予約と同じ経路に乗せる (`recordAiring`)。
   * 既に予約済み・録画中なら二重には録らない (予約は番組ごとに1本)
   */
  record: async ({ request }) => {
    const form = await request.formData();
    const serviceId = Number(form.get("service"));
    if (!Number.isInteger(serviceId))
      return fail(400, { message: "局の指定が不正です" });

    // アプリの `POST /api/services/<id>/record` と同じ経路 (`recordAiring`)
    const result = await recordAiring(serviceId);
    if (!result.ok) return fail(result.status, { message: result.message });
    return { recorded: result.name };
  },
} satisfies Actions;
