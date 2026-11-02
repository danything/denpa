import { fail } from "@sveltejs/kit";
import { and, gt, lte, sql } from "drizzle-orm";

import { channelNotice } from "#lib/channel-notice.js";
import { channelNumber } from "#lib/format.js";
import { jikkyoChannel } from "#lib/jikkyo/channels.js";
import { LAST_COOKIE } from "#lib/live.js";
import { channelAlert } from "#lib/server/channel-alert.js";
import { orm } from "#lib/server/db.js";
import {
  airing,
  currentServices,
  SERVICE_ORDER,
  SERVICE_TYPE_ORDER,
  serviceCounts,
} from "#lib/server/epg.js";
import { warm } from "#lib/server/live.js";
import { linkState } from "#lib/server/niconico.js";
import { recordAiring } from "#lib/server/reservations.js";
import { programs, services as stations } from "#lib/server/schema.js";
import { settings } from "#lib/server/settings.js";
import { liveStart, readKept, viewingOptions } from "#lib/server/viewing.js";
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
  /** 実況のチャンネル (`jk1` など。`#lib/jikkyo/channels.ts`)。実況の無い局と、世帯の設定 (連携の「実況」) がオフのときは null */
  jikkyo: string | null;
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

export function load(event) {
  const { url, cookies } = event;
  const at = Date.now();
  // テレビと同じ並び (SERVICE_TYPE_ORDER / SERVICE_ORDER)
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

  const current = settings();
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
      jikkyo: current.jikkyo ? jikkyoChannel(service) : null,
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
  const viewing = viewingOptions(url);
  // 選択 (自動・AV1・H.264・MPEG-2) は局が変わっても引き継ぐ (その端末で出るかの話)。H.264 を外す設定なら H.264 は自動
  const kept = readKept(cookies.get(LAST_COOKIE), viewing.hidden.length > 0);
  const start = liveStart(
    channels,
    Number(url.searchParams.get("service")),
    kept,
    viewing.indoor,
  );

  /*
   * 繋いでくる前にエンコードし始める (`live.warm`。WebSocket が繋がるまでの 160ms を ffmpeg の立ち上がりと重ねる)。
   * 形式は選択と開いた名前から決めたもの (自動なら家の中は放送のまま、外は AV1。`viewing.warmFormat`)。
   * 画面が別の形式に決めても、温めたものは誰も来なければ 8秒で畳む
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
  return {
    channels,
    /** 局が無いときに上に出す案内 (`#lib/channel-notice.ts`。出すのは `+layout.svelte`) */
    channelNotice: channelNotice(serviceCounts()),
    channelAlert: channelAlert(),
    start,
    /** コーデックのメニューで選んでいるもの (端末ごと。`LAST_COOKIE`) */
    choice: kept.choice,
    /** 開いた名前が家の中か (`#lib/host.ts` の `indoorHost`)。「自動」の形式を画面が決めるのに使う */
    indoor: viewing.indoor,
    /** コーデックのメニューから外すもの (世帯の設定) */
    hidden: viewing.hidden,
    postalCode: current.postalCode,
    prefecture: current.prefecture,
    bmlNetwork: current.bmlNetwork,
    /** 実況を流せるか (世帯の設定)。オンのときだけ ⚙ に「実況」の行を出す */
    jikkyo: current.jikkyo,
    /** 実況の NG ワード (世帯の設定)。含むコメントは流さない */
    jikkyoNg: current.jikkyoNg,
    /** ニコニコと連携しているか (世帯で 1 つ)。しているときは、書き込みを公式のニコニコ実況へ送る (`server/niconico-live.ts`) */
    niconico: linkState().state === "linked",
  };
}

export const actions = {
  /**
   * **いま観ている番組を録る** (右端の縦の列のいちばん上の録画ボタン)。
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
