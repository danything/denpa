import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";

import {
  LogoCollector,
  logoTypeOfPng,
  PREFERRED_LOGO_TYPE,
  replacesLogo,
} from "../ts/logo";
import { withPalette } from "../ts/logo-palette";
import type { ChannelType } from "../types";
import { config } from "./config";
import { orm } from "./db";
import { currentServices } from "./epg";
import { emit } from "./events";
import { services } from "./schema";
import { chunks } from "./stream";
import {
  type AgentTuner,
  getTuners,
  openChannelStream,
  type StreamUse,
} from "./tuner";

/**
 * 局ロゴを集める。
 *
 * 放送波の CDT (地上波) とデータカルーセル (衛星) に流れてくるものを取得する。
 * 集め方は Mirakurun と同じで、開いているストリームを共有する。
 *
 * ロゴは滅多に変わらないうえ、放送波に流れてくるのは数十秒〜数分に一度なので、
 * 番組表集めや録画の選局を共有して取得する (`ride`)。自分でチューナーを開くのは
 * 画面から求められたとき (`sweepNow`) だけ。
 */

/**
 * 地上波を1チャンネル開いておく上限。
 *
 * **ロゴは滅多に流れてこない。** 実機で測ると、地上波 (CDT) を100秒読んで
 * 0〜2セクション。3分でも足りなかった。
 */
const SWEEP_TIMEOUT = 6 * 60_000;

/**
 * 衛星を1チャンネル開いておく上限。**地上波よりずっと長い。**
 *
 * 衛星のカルーセルは流しっぱなしではなく、**まとまって来て、あとは無音**。
 * 実機の `BS15_0` を15分読み続けて測ると、13分間はロゴのESに1パケットも
 * 流れず、14分目にまとめて来た (BS 2768・CS 8224 パケット)。
 *
 * 当たりの中継はここまで待つ価値がある — 一度当たれば**BS と CS の全局**が
 * まとめて手に入る。外れの中継は PAT を見た時点 (1秒ほど) で切り上げるので、
 * この長さを待たされるのは当たりの1中継だけ。
 */
const SATELLITE_TIMEOUT = 20 * 60_000;

/**
 * 選局を共有するときの上限。向こうの都合でいつ閉じてもおかしくないので短くする。
 * こちらはチューナーを増やさない (同じチャンネルなら**エージェントが選局を共有させる**)。
 * **実際に集めているのはほぼこちら** (`sweep`)
 */
const RIDE_TIMEOUT = 3 * 60_000;
/**
 * ロゴを取得するときの優先度。**いちばん下** (並びは `config.priority`)。
 * ロゴが出なくても番組表は読めるが、番組情報が来なければ何も予約できない
 */
const SWEEP_PRIORITY = config.priority.logo;
/**
 * 画面から取得するときに同時に開く数。
 *
 * 地上波は中継ごとに入っている局が違うので、1チャンネルずつ数分かけていると
 * 数十チャンネルぶんが何時間もかかる。全部は使わない (録画に残しておく)。
 */
const SWEEP_TUNERS = 2;

/**
 * ロゴのカルーセルが載っていない中継を、次に確かめ直すまでの間隔。
 *
 * **衛星のロゴは中継1つにしか載っていない。** 実機の BS はネットワーク4の
 * 26中継のうち `BS15_0` だけで、そこにエンジニアリングサービス (929) がいる。
 * **CS の12中継には1つもいません** — CS のロゴもこの BS の中継から降ってきます
 * (`CS_LOGO-05`)。つまり CS の物理チャンネルは開くだけ無駄。
 *
 * 覚えておかないと、定期チェックのたびに CS の12中継を開き直すことになる。
 * 放送側の都合はいつか変わるので、間隔を空けて確かめ直す。
 */
const RELAY_RETRY = 7 * 24 * 60 * 60_000;

function logoDir(): string {
  return join(config.dataDir, "logos");
}

/** サービスIDごとのファイル。局の内部IDをそのまま名前にする */
function logoPath(serviceId: number): string {
  return join(logoDir(), `${serviceId}.png`);
}

/**
 * ロゴを流していないと分かった中継の控え。
 *
 * ロゴの置き場に置く。DBに列を足さないのは、ロゴまわりは**ファイルを正**と
 * 決めてあるため (`reconcile`)。置き場ごと消えたら、また調べ直せばいい。
 */
function relayPath(): string {
  return join(logoDir(), "satellite-relays.json");
}

/** 書きかけを読ませない。番組表は同時に見に来るので、別名に書いてから置き換える */
function writeWhole(path: string, data: string | Uint8Array): void {
  const working = `${path}.writing`;
  writeFileSync(working, data);
  renameSync(working, path);
}

interface RelayNotes {
  /** ロゴを積んでいなかった中継と、そう分かった時刻 */
  noCarousel: Record<string, number>;
  /** カルーセルを読み切っても来なかった局 (局ID → そう分かった時刻) */
  absent: Record<string, number>;
  /**
   * 地上波で、開けるだけ開けても**大きいロゴ (64×36) が来なかった**局 (局ID → 時刻)。
   * 控えておかないと、小さいロゴしか流さない局のために定期チェックのたびに6分開き直す
   */
  gaveUp: Record<string, number>;
}

/**
 * 読んだ控えを持っておく。
 *
 * `missing()` は局の数だけ引くので (実機で124局)、そのたびにファイルを
 * 読みに行くと、番組表を1回出すだけで何百回も開くことになる。
 * 書くのはこの1プロセスだけなので、書いたときに入れ替えれば足りる
 */
let relays: RelayNotes | null = null;

function notes(): RelayNotes {
  if (relays !== null) return relays;
  try {
    const parsed = JSON.parse(
      readFileSync(relayPath(), "utf8"),
    ) as Partial<RelayNotes>;
    relays = {
      noCarousel: parsed.noCarousel ?? {},
      absent: parsed.absent ?? {},
      gaveUp: parsed.gaveUp ?? {},
    };
  } catch {
    relays = { noCarousel: {}, absent: {}, gaveUp: {} };
  }
  return relays;
}

function save(next: RelayNotes): void {
  relays = next;
  try {
    mkdirSync(logoDir(), { recursive: true });
    writeWhole(relayPath(), JSON.stringify(next));
  } catch {
    // 控えられなくても集めることはできる。次の機会に
  }
}

/** その中継は今回は飛ばしてよいか。確かめてから RELAY_RETRY の間だけ */
function skipRelay(channel: string): boolean {
  return fresh(notes().noCarousel[channel], RELAY_RETRY);
}

/** 「この中継にロゴは載っていない」/「載っていた」を書き留める */
function markRelay(channel: string, hasLogo: boolean): void {
  const known = notes();
  // 何も変わらないなら書きに行かない
  if (hasLogo === (known.noCarousel[channel] === undefined)) return;
  const noCarousel = { ...known.noCarousel };
  if (hasLogo) delete noCarousel[channel];
  else noCarousel[channel] = Date.now();
  save({ ...known, noCarousel });
}

/**
 * カルーセルを1回ぶん読み切った。**まだ埋まらない局を控える。**
 *
 * カルーセルには BS も CS もまとめて載っているので、読み切ってなお来ない局は
 * そもそも載っていない。中継ごとの当たり外れ (`noCarousel`) とは別の話で、
 * 混ぜると**「CS の中継にロゴが無い」=「CS のロゴは取れない」**という誤りになる
 * (CS のロゴは BS の中継から降ってくる)。
 *
 * **局ごとに控える。** 消えたロゴは「控えに無い = まだ取れるはず」になって自然に取得し直す。
 */
function markAbsent(): void {
  const known = notes();
  const absent = { ...known.absent };
  for (const service of tunableServices()) {
    if (service.type !== "GR" && needsLogo(service))
      absent[service.id] = Date.now();
  }
  save({ ...known, absent });
}

/** その局はカルーセルに載っていないと分かっているか */
function absentFromCarousel(serviceId: number): boolean {
  return fresh(notes().absent[serviceId], LOGO_MAX_AGE);
}

/** 控えた時刻 `at` から `ms` が過ぎていないか (控えが無ければ false) */
function fresh(at: number | undefined, ms: number): boolean {
  return at !== undefined && Date.now() - at < ms;
}

export function readLogo(serviceId: number): Uint8Array | null {
  const path = logoPath(serviceId);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * 取得できたロゴを保存して、番組表に出せるようにする。
 *
 * 放送波の service_id は ARIB のもので、denpa が持っている services.id とは
 * 別物。network_id と合わせて引き直す。
 */
function store(
  networkId: number,
  serviceIds: number[],
  logoType: number,
  data: Uint8Array,
): number {
  mkdirSync(logoDir(), { recursive: true });

  let saved = 0;
  for (const serviceId of serviceIds) {
    const matched = orm()
      .select({ id: services.id })
      .from(services)
      .where(
        and(
          eq(services.network_id, networkId),
          eq(services.service_id, serviceId),
        ),
      )
      .all();
    for (const { id } of matched) {
      // **小さいものへは戻さない。** 局は6種類の大きさを順に流していて、どれが先に来るかは開くたびに違う
      if (!replacesLogo(storedLogoType(id), logoType)) continue;
      writeWhole(logoPath(id), data);
      /*
       * **`updated_at` は触らない。** あれは「最後に取り込んだ時刻」で、番組表は
       * *いちばん新しいものと同じ時刻の局だけ* を出す (`currentServices`)。
       * 進めると、その局だけが「いまの局」になって番組表から他が消える
       */
      orm()
        .update(services)
        .set({ has_logo: true })
        .where(eq(services.id, id))
        .run();
      saved++;
    }
  }
  return saved;
}

/**
 * 流れてくるTSからロゴを取得する。
 *
 * 失敗しても黙って諦める。ロゴが無くても番組表は出るし、録画には何の関係も無い。
 */
function watch(networkId: number): Feed {
  const collector = new LogoCollector(networkId);
  let broken = false;
  /** 同じものを何度も書きに行かない。ロゴは滅多に変わらない */
  const written = new Set<string>();

  const feed = (chunk: Uint8Array) => {
    if (broken) return;
    try {
      collector.feed(chunk);
      const found = collector.collected();
      if (found.length === 0) return;

      // **開いている間は取得し続ける。** 1つのTSにはその物理チャンネルの局が全部流れていて、ロゴは局ごとに別々に来る
      let saved = 0;
      for (const { networkId: network, serviceIds, logo } of found) {
        // 衛星は他ネットワークの局も混ざる。どのネットワークのぶんかは
        // ロゴ自身が知っているので、そちらで引く
        const key = `${network}:${logo.logoId}:${logo.logoType}:${logo.logoVersion}`;
        if (written.has(key)) continue;
        written.add(key);
        saved += store(network, serviceIds, logo.logoType, logo.data);
      }
      if (saved > 0) emit("services");
    } catch (error) {
      console.error(`[logo] 取り込みに失敗しました: ${error}`);
      broken = true;
    }
  };
  /** 外れの中継を早く見切るため・読み切ったかを見るために覗く。地上波では使わない */
  Object.defineProperties(feed, {
    hasSatelliteLogo: { get: () => collector.hasSatelliteLogo },
    carouselRead: { get: () => collector.satelliteCarouselRead },
  });
  return feed as Feed;
}

/** データを渡す入口。ついでに「この中継にロゴがあるか」を覗ける */
interface Feed {
  (chunk: Uint8Array): void;
  readonly hasSatelliteLogo: boolean | null;
  /** 衛星のロゴのカルーセルを1回ぶん読み切ったか */
  readonly carouselRead: boolean;
}

/**
 * `has_logo` を実際のファイルに合わせ直す。
 *
 * この列は「番組表にロゴを出すかどうか」の判断にそのまま使われるので、
 * ファイルが無いのに立っていると番組表に壊れた画像が並ぶ。しかも
 * `missing()` が「もう持っている」とみなして取得しなくなるため、
 * 放っておくと永久に埋まらない。
 *
 * 置き場ごと消えることは実際に起きる (PVCの作り直しなど)。
 * DBとファイルのどちらが正しいかを迷わないよう、**ファイルを正とする**。
 *
 * ついでに、色の表の入っていない古いファイルを直す。放送から取得したままの
 * PNG はパレットが抜けていて、ブラウザは何も描かない (logo-palette.ts)。
 * 取得し直すと局によっては何時間もかかるので、置いてあるものを直す。
 */
export function reconcile(): number {
  const rows = orm()
    .select({ id: services.id, has_logo: services.has_logo })
    .from(services)
    .all();
  let changed = 0;
  orm().transaction((tx) => {
    for (const row of rows) {
      const actual = existsSync(logoPath(row.id));
      if (actual) repaint(row.id);
      if (actual === row.has_logo) continue;
      tx.update(services)
        .set({ has_logo: actual })
        .where(eq(services.id, row.id))
        .run();
      changed++;
    }
  });
  if (changed > 0) emit("services");
  return changed;
}

/** 置いてある PNG に色の表が入っていなければ入れ直す */
function repaint(serviceId: number): void {
  try {
    const path = logoPath(serviceId);
    const stored = readFileSync(path);
    const fixed = withPalette(stored);
    if (fixed.length === stored.length) return;
    writeWhole(path, fixed);
    console.log(`[logo] ${serviceId} の色の表を入れ直しました`);
  } catch {
    // 直せなくても番組表は出る。次の機会に
  }
}

/** ロゴを取得する単位。1つの物理チャンネルと、そこに入っている局 */
interface Target {
  type: string;
  channel: string;
  network_id: number;
}

/**
 * ロゴを取り直すまでの間隔。局のマークは滅多に変わらないが、変わったときに永久に
 * 古いままなのは困る。取り直しは只ではない (1チャンネルに数分開く) ので長めにしておく。
 *
 * **消してから取得するのではない。** 来たものを上書きするだけなので、
 * 取れなければ今のものがそのまま残る。番組表からロゴが消えることはない。
 */
const LOGO_MAX_AGE = 7 * 24 * 60 * 60_000;

/** 置いてあるロゴの logo_type。無い・読めない・規格に無い寸法なら null */
function storedLogoType(serviceId: number): number | null {
  const stored = readLogo(serviceId);
  return stored === null ? null : logoTypeOfPng(stored);
}

/**
 * その局のロゴを取得する必要があるか。無い、古い、**または小さい。**
 *
 * 最初に来た種類 (48×24 など) で閉じると局ごとに大きさが揃わないので、64×36 が来るまでは
 * 足りていないとみなす。
 *
 * 開けるだけ開けて来なかった局 (`gaveUp`) は、次の取り直しの時期まで今のもので足りる。
 *
 * **大きさを見るのは地上波だけ。** 衛星のカルーセル (`LOGO-05`) には 0x05 しか載って
 * いないので小さいものは入りようがなく、来なかったときに控える仕組み (`gaveUp`) も
 * 地上波にしか無い — 衛星まで見ると、万一のときに毎回20分待つことになる
 */
function needsLogo(service: { id: number; type: string }): boolean {
  const serviceId = service.id;
  const written = writtenAt(serviceId);
  if (written === 0) return true;
  if (fresh(notes().gaveUp[serviceId], LOGO_MAX_AGE)) return false;
  if (Date.now() - written > LOGO_MAX_AGE) return true;
  return (
    service.type === "GR" && storedLogoType(serviceId) !== PREFERRED_LOGO_TYPE
  );
}

/**
 * 地上波を上限いっぱいまで開けて、なお足りない局を控える。
 * **ロゴを1つも持っていない局は控えない** — そちらは今までどおり毎回取得する
 */
function markGaveUp(channel: string): void {
  const known = notes();
  const gaveUp = { ...known.gaveUp };
  let changed = false;
  for (const service of tunableServices()) {
    if (
      service.channel !== channel ||
      !existsSync(logoPath(service.id)) ||
      !needsLogo(service)
    )
      continue;
    gaveUp[service.id] = Date.now();
    changed = true;
  }
  if (changed) save({ ...known, gaveUp });
}

/** いま選局できる局。取り残しは見に行かない */
function tunableServices(): {
  id: number;
  type: string;
  channel: string;
  network_id: number;
}[] {
  return orm()
    .select({
      id: services.id,
      type: services.type,
      channel: services.channel,
      network_id: services.network_id,
    })
    .from(services)
    .where(currentServices())
    .orderBy(services.type, services.channel)
    .all();
}

/**
 * ロゴを取得する物理チャンネル。
 *
 * いま選局できる局だけを対象にする。取り残しの局まで見に行くと、
 * もう選局できないチャンネルを1局ずつ開いては諦めることになり、
 * 本当に要る局まで順番が回ってこない。
 */
function missing(): Target[] {
  const services = tunableServices();
  const targets = new Map<string, Target>();
  const add = (service: {
    type: string;
    channel: string;
    network_id: number;
  }) => {
    const key = `${service.type}:${service.channel}`;
    if (targets.has(key)) return;
    targets.set(key, {
      type: service.type,
      channel: service.channel,
      network_id: service.network_id,
    });
  };

  // 地上波は中継ごとに入っている局が違う。その中継の局が足りないときだけ開く
  for (const service of services) {
    if (service.type === "GR" && needsLogo(service)) add(service);
  }

  /*
   * **衛星は「その中継の局が足りているか」では選べない。**
   *
   * ロゴを積んだ中継1つに BS も CS も全部載っているので、中継ごとに見ると
   * BS が揃った時点でその中継が候補から外れ、**そこにしか無い CS が永久に
   * 埋まらない**。
   *
   * 衛星の局が1つでも足りなければ、**まだ外れと分かっていない中継**を当たる。
   * どれが当たりかは開いてみないと分からないが (実機の BS はネットワーク4の
   * 26中継のうち `BS15_0` だけ)、外れは PAT を見た時点で1秒ほどで切り上げ、
   * 書き留めて二度目からは飛ばす (`collect` / `markRelay`)。
   *
   * ただし**カルーセルに載っていないと分かっている局は数に入れない**。
   * 読み切ってなお来なかった局は行っても来ないので、そこだけを理由に
   * 中継を開き直すと同じことの繰り返しになる
   */
  if (missingSatellites() > 0) {
    for (const service of services) {
      if (service.type !== "GR" && !skipRelay(service.channel)) add(service);
    }
  }
  return [...targets.values()];
}

/** その物理チャンネルに入っている局のうち、ロゴを取り直したい数 */
function missingOn(channel: string): number {
  return tunableServices().filter((s) => s.channel === channel && needsLogo(s))
    .length;
}

/**
 * 衛星でまだ取れていない局の数。
 *
 * **衛星のカルーセルは開いた中継の局だけを運ぶのではない。** `BS15_0` の
 * エンジニアリングサービスには `LOGO-05` と `CS_LOGO-05` が並んで流れていて、
 * **BS と CS の全局ぶん**が入っている。開いた中継の局だけで数えると、先に来る BS で閉じて CS を取りこぼす。
 */
function missingSatellites(): number {
  return tunableServices().filter(
    (s) => s.type !== "GR" && needsLogo(s) && !absentFromCarousel(s.id),
  ).length;
}

/**
 * いま開いて読んでいる物理チャンネル。
 *
 * **共有 (`ride`) が自分の開けたものを使わないように持つ。** こちらが開くと
 * エージェントが `tuners` を飛ばし、それを合図に共有が走って同じものを二重に読んでしまう。
 */
const collecting = new Set<string>();

/**
 * 1つの物理チャンネルを開いて、そこに入っている局のロゴを取得する。
 *
 * **物理チャンネルを丸ごと開く。** 局を選り分けてしまうと、ロゴを載せている
 * CDT (PID 0x0029) はどの局のPMTにも載っていない都合でまるごと落ちる。
 * 実機で確かめると、局単位で3分・427MB 読んでも CDT は1つも来なかった。
 *
 * **1局取れた時点でも閉じない。** 1つのTSにはその物理チャンネルの局が全部
 * 流れていて、ロゴは局ごとに別々のタイミングで来る。せっかく開いたのだから、
 * 揃うか時間切れになるまで読む。
 */
async function collect(
  target: Target,
  timeout: number,
  signal?: AbortSignal,
  after: readonly StreamUse[] = [],
): Promise<number> {
  const satellite = target.type !== "GR";
  // 衛星は「開いた中継の局」では見ない。開いた中継以外の局も一緒に取得できる (`missingSatellites`)
  const remaining = () =>
    satellite ? missingSatellites() : missingOn(target.channel);
  const before = remaining();
  /** 当たり外れを書き留めたか。毎回書きに行かないための印 */
  let marked = false;
  const controller = new AbortController();
  /** 上限まで開けきったか。横から止められた・取り上げられたのとは区別する */
  let ranOut = false;
  const stop = setTimeout(() => {
    ranOut = true;
    controller.abort();
  }, timeout);
  collecting.add(target.channel);
  // 外から止められるようにする。衛星に20分かけている最中でも譲れるように
  const give = () => controller.abort();
  signal?.addEventListener("abort", give, { once: true });
  try {
    const stream = await openChannelStream(
      target.type,
      target.channel,
      controller.signal,
      // 何を使っているのかが設定の「チューナー」に出る
      logoUse(target),
      SWEEP_PRIORITY,
      after,
    );
    const feed = watch(target.network_id);
    for await (const chunk of chunks(stream)) {
      feed(chunk);
      const now = remaining();
      // 全部揃ったら、これ以上開けておく理由がない
      if (now === 0) break;
      /*
       * 衛星は揃いきらないことがある (カルーセルに載っていない局がある)。
       * **DII が知らせたロゴのモジュールが全部揃ったら、カルーセルは1回ぶん読み切った**
       * (`carouselRead`)。残っている局は載っていない局なので、そう書き留めて次からは行かない。
       * これが無いと、載っていない局が1つでもあるだけで毎回20分丸ごと待つことになる
       */
      if (satellite && feed.carouselRead) {
        markAbsent();
        break;
      }
      /*
       * **衛星のロゴは1つの中継にしかない** (`RELAY_RETRY`)。外れの中継は PAT を
       * 見た時点で分かるので、待たずに次へ行く。当たり外れは書き留めておく —
       * そうしないと、二度と来ないものを定期チェックのたびに開き直すことになる
       */
      if (satellite && !marked && feed.hasSatelliteLogo !== null) {
        marked = true;
        markRelay(target.channel, feed.hasSatelliteLogo);
        if (!feed.hasSatelliteLogo) break;
      }
    }
  } catch {
    // 取れなければ次の機会に。チューナーが空いていないだけのことも多い
  } finally {
    clearTimeout(stop);
    collecting.delete(target.channel);
    signal?.removeEventListener("abort", give);
    controller.abort();
  }
  // 共有 (RIDE_TIMEOUT) は短いので、来なかったことの証拠にしない
  if (!satellite && ranOut && timeout >= SWEEP_TIMEOUT)
    markGaveUp(target.channel);
  return before - remaining();
}

/** 設定の「チューナー」に出る名乗り。引き継ぎ (`after`) でも同じものを渡す */
function logoUse(target: Target): StreamUse {
  return `logo ${target.type}/${target.channel}`;
}

/**
 * **その種別を受けられる**空きチューナーの数 (衛星用の空きは地上波の役に立たない)。
 *
 * `leaving` は**こちらが閉じたばかりの選局**。閉じたことがエージェントに届くのは
 * 非同期なので、閉じた直後に訊くとまだ使用中に見える。それを数え損ねると、衛星の
 * 外れの中継 (1秒ほどで閉じる) の次に「CS の空きチューナーが無くなった」と諦めて
 * いた — もう1台は当たりの中継を読んでいる最中なので、空きが0に見える。
 * そこにしかいないなら空きとして数え、開くときに `after` で引き継ぐ
 */
export function countFree(
  tuners: readonly Pick<
    AgentTuner,
    "disabled" | "types" | "channel" | "users"
  >[],
  type: string,
  leaving: readonly string[] = [],
): number {
  return tuners.filter(
    (tuner) =>
      !tuner.disabled &&
      tuner.types.includes(type as ChannelType) &&
      (tuner.channel === null ||
        (tuner.users.length > 0 &&
          tuner.users.every((user) => leaving.includes(user.use)))),
  ).length;
}

/**
 * 空きチューナーの数 (`countFree`)。無ければ自分では開かない。
 * ロゴの優先度はいちばん下なので、番組表集めに譲る特別扱いは要らない (エージェントが断る・取り上げる)。
 */
async function freeTuners(
  type: string,
  leaving: readonly string[] = [],
): Promise<number> {
  try {
    return countFree(await getTuners(), type, leaving);
  } catch {
    // エージェントに聞けないなら開きに行かない
    return 0;
  }
}

/** いまエージェントが開けている物理チャンネル */
function openChannels(tuners: AgentTuner[]): Set<string> {
  const open = new Set<string>();
  for (const tuner of tuners) {
    if (tuner.channel !== null) open.add(tuner.channel.channel);
  }
  return open;
}

/** 同時に2つ走らせない。共有の合図 (エージェントの `tuners`) は連続して飛んでくる */
let riding = false;

/**
 * 取得している最中の様子。画面はこれを見る (1チャンネルに数分かける仕事なので、進み具合を出す)。
 */
interface SweepState {
  running: boolean;
  /** いま開いている物理チャンネル。地上波は2つ並ぶ */
  channels: string[];
  /** 見終えた物理チャンネル数と、その総数 */
  done: number;
  total: number;
  /** この取得を始めてからロゴが書き込まれた局の数 (`writtenSince`) */
  found: number;
  /** いまの様子、または終わった理由。そのまま画面に出す */
  message: string;
  startedAt: number | null;
  finishedAt: number | null;
}

const IDLE: SweepState = {
  running: false,
  channels: [],
  done: 0,
  total: 0,
  found: 0,
  message: "",
  startedAt: null,
  finishedAt: null,
};

/**
 * 走っているのは高々1つ。定期実行と画面からの「ロゴをいますぐ集める」が重なると
 * チューナーを食い合う。共有 (ride) だけは只なので別勘定にしてある
 */
let state: SweepState = IDLE;

export function sweepState(): SweepState {
  return state;
}

function update(patch: Partial<SweepState>): void {
  state = { ...state, ...patch };
  emit("logos");
}

/**
 * 順番に開いて取得する。**同時に2つまで。**
 *
 * 地上波は中継ごとに入っている局が違うので、1つずつ回っていると数が捌けない。
 * 衛星は当たりの中継1つで全局ぶんが揃う代わりに1回が長い。
 *
 * 1つ取りかかるたびに空きを見る。録画が始まったのに開きに行くと、使えないまま
 * 待つことを人数ぶん繰り返すことになる。
 */
async function drain(
  queue: Target[],
  parallel: number,
  signal: AbortSignal,
  stamps: Map<number, number>,
): Promise<void> {
  /** 空きが無くなった種別。**その種別だけ**諦める (衛星の満杯で地上波を止めない) */
  const full = new Set<string>();
  const worker = async () => {
    /** この手で閉じたばかりの選局。次を開くときに引き継ぐ (`freeTuners`) */
    let left: StreamUse[] = [];
    for (;;) {
      const target = queue.shift();
      if (target === undefined || signal.aborted) return;
      // 諦めたぶんも見終えたものとして数える。進み具合が総数に届かなくなる
      if (full.has(target.type)) {
        update({ done: state.done + 1 });
        continue;
      }
      if ((await freeTuners(target.type, left)) === 0) {
        full.add(target.type);
        update({
          done: state.done + 1,
          message: `${target.type} の空きチューナーが無くなったため、残りは取りやめました`,
        });
        continue;
      }
      update({ channels: [...state.channels, target.channel] });
      // 衛星のカルーセルは十数分に一度しか来ない。当たりの中継はそれまで待つ
      const limit = target.type === "GR" ? SWEEP_TIMEOUT : SATELLITE_TIMEOUT;
      await collect(target, limit, signal, left);
      left = [logoUse(target)];
      update({
        channels: state.channels.filter(
          (channel) => channel !== target.channel,
        ),
        done: state.done + 1,
        found: writtenSince(stamps),
      });
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
}

/**
 * **いま開いている選局を共有して**ロゴを取得する。
 *
 * 番組表集めも録画も、物理チャンネルを丸ごと開く。そこへ同じチャンネルを要求すると
 * **エージェントは新しいチューナーを使わずに選局を共有させる**ので、こちらは只で電波を
 * 読める。空いた時間に自分で開き直すより早く埋まり、チューナーの取り合いも起きない。
 *
 * 合図はエージェントの `tuners`。開いた瞬間に飛んでくるので、閉じるまでの間に読み切る。
 */
export async function ride(): Promise<number> {
  if (riding) return 0;
  riding = true;
  try {
    // 立っているだけでファイルが無い局を先に取得し直す。そうしないと
    // 「もう持っている」とみなして永久に取得しない
    reconcile();
    const need = missing();
    if (need.length === 0) return 0;

    const open = openChannels(await getTuners());
    if (open.size === 0) return 0;

    let found = 0;
    for (const target of need) {
      if (!open.has(target.channel)) continue;
      // 自分で開けたものは共有しない。同じチャンネルを二重に読むことになる
      if (collecting.has(target.channel)) continue;
      found += await collect(target, RIDE_TIMEOUT);
    }
    return found;
  } catch {
    // エージェントに聞けなければ何もしない。次の通知でまた来る
    return 0;
  } finally {
    riding = false;
  }
}

/**
 * 定期チェック。**ほかの選局を共有するだけで、自分ではチューナーを開かない。**
 *
 * 番組表集めは全チャンネルを定期的に開くので、その選局へ混ぜてもらえば只で読める
 * (実機では BS の38局ぶんが局調べの選局を一度共有しただけで揃った)。録画とチューナーを取り合う理由がない。
 * すぐ欲しいときは画面の「ロゴをいますぐ集める」(`sweepNow`) がある。
 */
export async function sweep(): Promise<number> {
  return ride();
}

/**
 * 画面の「ロゴをいますぐ集める」。残っているぶんを、チューナー2台で一気に取得する。
 *
 * **衛星も混ぜる。** ロゴを運ぶ中継は1つだけで、当たれば BS と CS の全局ぶんが
 * まとめて揃い、外れは PAT を見た時点 (1秒ほど) で次へ行く。当たり外れを
 * 書き留めておくので、二度目からは当たりの中継しか開かない。
 */
export async function sweepNow(): Promise<{
  started: boolean;
  message: string;
}> {
  /*
   * 前の取得が回っていても譲ってもらう。1チャンネルに数分〜20分開くので、
   * 待たせると押した人の用が済まない。只で読める共有 (ride) は
   * 別勘定なので、ここでは触らない
   */
  if (state.running) {
    inflight?.abort();
    if (!(await settled()))
      return { started: false, message: "まだ前の取得が終わっていません" };
  }
  reconcile();
  /*
   * **押されたら「カルーセルに載っていない」の控えを捨てて当たり直す。** 控えが間違っていると
   * (読み切る前に見切った、など)、押しても「すべて取得済み」と言われ、取り直せなかった
   */
  const known = notes();
  if (Object.keys(known.absent).length > 0) save({ ...known, absent: {} });
  const targets = missing();
  if (targets.length === 0) {
    return { started: false, message: "ロゴはすべて取得済みです" };
  }
  // 空きは**種別ごとに数える** (`freeTuners`)
  const free = new Map<string, number>();
  for (const type of new Set(targets.map((target) => target.type))) {
    free.set(type, await freeTuners(type));
  }
  if ([...free.values()].every((count) => count === 0)) {
    return { started: false, message: "空いているチューナーがありません" };
  }
  // 地上波を先に回す。中継ごとに違う局が入っているので、数が捌けるのはこちら
  const ordered = [...targets].sort(
    (a, b) => Number(b.type === "GR") - Number(a.type === "GR"),
  );
  const parallel = Math.min(SWEEP_TUNERS, Math.max(...free.values()));
  // 終わるのは数分後。押した人を待たせず、進み具合は画面へ流す
  void run(ordered, parallel);
  return {
    started: true,
    message:
      `${targets.length} チャンネルをチューナー ${parallel} 台で取得します。` +
      "ロゴが流れてくるまで数分かかります",
  };
}

/** 走っている取得を外から止めるための手段。譲ってもらうときに使う */
let inflight: AbortController | null = null;

/** 止まるのを待つ。開いているストリームを畳むだけなのですぐ終わる */
async function settled(): Promise<boolean> {
  for (let i = 0; i < 50 && state.running; i++) await Bun.sleep(100);
  return !state.running;
}

/**
 * 各局のロゴの書き込み時刻 (無ければ 0)。取得を始める前に控えておく。
 *
 * **取得できた数は「開いた中継で減った数」では数えない。** 1つのTSに他の中継の局の
 * ロゴが入ってくることがあり (衛星は1つの中継に全局ぶん。偽の放送 (`tests/fake`) は
 * 地上波も各中継に全局ぶん流す)、開いた中継の局だけを数えていた頃は、画面の「14 / 14 局」の下に
 * 「12 局のロゴを取得しました」と出ていた。共有 (`ride`) が同じ間に取得したものも
 * 入らなかった。**この取得の間にロゴが書き込まれた局**を数えれば、どこから来ても数が合う
 */
export function logoStamps(
  ids: Iterable<number> = tunableServices().map((s) => s.id),
): Map<number, number> {
  const stamps = new Map<number, number>();
  for (const id of ids) stamps.set(id, writtenAt(id));
  return stamps;
}

/** その局のロゴを書き込んだ時刻。まだ持っていなければ 0 */
function writtenAt(serviceId: number): number {
  try {
    return statSync(logoPath(serviceId)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 控えた時刻 (`logoStamps`) よりあとにロゴが書き込まれた局の数。
 *
 * 数えるのは**いまの局**。取得の途中で局の取り込みが走ると、控えたときには無かった
 * 局が増える — そういう局は「控えた時刻 0」(何も持っていなかった) とみなす。
 * 控えにだけあって今は無い局 (消えた局) は数えない
 */
export function writtenSince(
  stamps: Map<number, number>,
  ids: Iterable<number> = tunableServices().map((s) => s.id),
): number {
  let count = 0;
  for (const id of ids) {
    const now = writtenAt(id);
    if (now > 0 && now > (stamps.get(id) ?? 0)) count++;
  }
  return count;
}

/** 実際に回すところ。走っている印を立て、終わったら結果を残す */
async function run(targets: Target[], parallel: number): Promise<void> {
  const controller = new AbortController();
  inflight = controller;
  const stamps = logoStamps();
  state = {
    ...IDLE,
    running: true,
    total: targets.length,
    startedAt: Date.now(),
  };
  emit("logos");
  try {
    await drain([...targets], parallel, controller.signal, stamps);
  } finally {
    inflight = null;
    const found = writtenSince(stamps);
    /*
     * 残りも**局で**数える (画面の「14 / 14 局」と同じ物差し)。取得するチャンネルの
     * 数 (`missing`) で「未取得のチャンネルは残り N」と出していた頃は、局の数と並べて
     * 何の数なのか読めなかった。放送に載っていない局は残りに入れない
     */
    const { have, total, unavailable } = stats();
    const left = total - have - unavailable;
    update({
      running: false,
      channels: [],
      finishedAt: Date.now(),
      found,
      message:
        state.message !== ""
          ? state.message
          : `${found} 局のロゴを取得しました${left > 0 ? ` (まだの局は残り ${left})` : ""}`,
    });
    if (state.found > 0) console.log(`[logo] ${state.message}`);
    emit("services");
  }
}

/**
 * 何局ぶん持っているか。「本当に取れているのか」を画面で確かめられるように。
 *
 * `pending` はこれから取得する物理チャンネルの数。0 ならボタンを出さない。
 *
 * `unavailable` は**カルーセルに載っていないので取れない**衛星の局の数。
 * 数えておかないと「N局ぶん足りない」という表示が永久に残り、こちらの不具合と
 * 見分けが付かない。
 *
 * **中継にロゴが無いこと (`skipRelay`) では数えない。** CS の12中継にはロゴの
 * カルーセルが無いが、CS のロゴは BS の中継から降ってくるので、中継で数えると
 * 取れる局まで「取れません」と出てしまう。
 * カルーセルを読み切った後になお足りない局だけが、本当に取れない局。
 */
export function stats(): {
  have: number;
  total: number;
  pending: number;
  unavailable: number;
} {
  const states = tunableServices().map((service) => logoState(service.id));
  return {
    have: states.filter((state) => state === "have").length,
    total: states.length,
    pending: missing().length,
    unavailable: states.filter((state) => state === "absent").length,
  };
}

/**
 * 局1つぶんのロゴの具合。設定の「受信できるチャンネル」の表で局ごとに出す。
 *
 * - `have` … 持っている
 * - `absent` … カルーセルに載っていないと分かった局 (取れない。`stats` の `unavailable`)
 * - `missing` … まだ取れていない
 */
export function logoState(serviceId: number): "have" | "absent" | "missing" {
  if (existsSync(logoPath(serviceId))) return "have";
  return absentFromCarousel(serviceId) ? "absent" : "missing";
}
