import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { and, eq, ne } from "drizzle-orm";

import { beforeJapanese, typeNames } from "../format";
import {
  LogoCollector,
  logoTypeOfPng,
  PREFERRED_LOGO_TYPE,
  replacesLogo,
} from "../ts/logo";
import { type CarouselCounts, CarouselProgress } from "../ts/logo-dsmcc";
import { withPalette } from "../ts/logo-palette";
import type { ChannelType } from "../types";
import { config } from "./config";
import { orm } from "./db";
import { currentServices } from "./epg";
import { emit } from "./events";
import {
  type CarouselWatch,
  nextCarouselAttempt,
  OFF_PERIOD_RETRY,
} from "./logo-period";
import { recordLogoAttempt } from "./logo-record";
import { services } from "./schema";
import { chunks } from "./stream";
import {
  type AgentTuner,
  getTuners,
  openChannelStream,
  type StreamUse,
} from "./tuner";

/**
 * 局ロゴを取得する。
 *
 * 放送波の CDT (地上波) とデータカルーセル (衛星) に流れてくるものを取得する。
 * 取得のしかたは Mirakurun と同じで、開いているストリームを共有する。
 *
 * ロゴは滅多に変わらないうえ、放送波に流れてくるのは地上波で数分に一度、衛星はダウンロードの期間中だけ十数分に一度なので、
 * 番組表の取得や録画の選局を共有して取得する (`ride`)。自分でチューナーを開くのは
 * 画面から求められたとき (`sweepNow`) と、衛星のロゴが足りない間にチューナーが空いているとき
 * (`awaitCarousel`。当たりの中継で待ち、分からなければ外れを 1 秒ほどで見切りながら探す) だけ。
 */

/**
 * 地上波を 1 チャンネル開いておく上限。
 *
 * **ロゴは滅多に流れてこない。** 実機で測ると、地上波 (CDT) を 100 秒読んで
 * 0〜2 セクション。3 分でも足りなかった。
 */
const SWEEP_TIMEOUT = 6 * 60_000;

/**
 * 選局を共有するときの上限。向こうの都合でいつ閉じてもおかしくないので短くする
 * (衛星の当たりの中継だけは `config.logoCarouselWait` まで延ばす。`collect`)。
 * こちらはチューナーを増やさない (同じチャンネルなら**エージェントが選局を共有させる**)。
 * **実際に取得しているのはほぼこちら** (`sweep`)
 */
const RIDE_TIMEOUT = 3 * 60_000;
/**
 * ロゴを取得するときの優先度。**いちばん下** (並びは `config.priority`)。
 * ロゴが出なくても番組表は読めるが、番組情報が来なければ何も予約できない。
 * 衛星の当たりの中継を、ダウンロードの期間中に自分で開いて待つときと「いますぐ」だけは `config.priority.carousel` (`carouselPriority`)
 */
const SWEEP_PRIORITY = config.priority.logo;
/**
 * 画面から取得するときに同時に開く数。
 *
 * 地上波は中継ごとに入っている局が違うので、1 チャンネルずつ数分かけていると
 * 数十チャンネルぶんが何時間もかかる。全部は使わない (録画に残しておく)。
 */
const SWEEP_TUNERS = 2;

/**
 * ロゴのカルーセルが載っていない中継を、次に確かめ直すまでの間隔。
 *
 * **衛星のロゴは中継 1 つにしか載っていない。** 実機の BS はネットワーク 4 の
 * 26 中継のうち `BS15:16625` だけで、そこにエンジニアリングサービス (929) がいる。
 * **CS の 12 中継には 1 つもいない。** CS のロゴもこの BS の中継から流れてくる
 * (`CS_LOGO-05`)。CS の物理チャンネルは開いても取得できない。
 *
 * 覚えておかないと、定期チェックのたびに CS の 12 中継を開き直すことになる。
 * 放送側の都合はいつか変わるので、間隔を空けて確かめ直す。
 */
const RELAY_RETRY = 7 * 24 * 60 * 60_000;

function logoDir(): string {
  return join(config.dataDir, "logos");
}

/** サービス ID ごとのファイル。局の内部 ID をそのまま名前にする */
function logoPath(serviceId: number): string {
  return join(logoDir(), `${serviceId}.png`);
}

/**
 * ロゴを流していないと分かった中継の控え。
 *
 * ロゴの置き場に置く。DB に列を足さないのは、ロゴまわりは**ファイルを正**と
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
  /**
   * ロゴのカルーセルを積んでいた中継と、そう分かった時刻。チューナーが空いているときに
   * 自分から開くのはここだけ (`awaitCarousel`)。外れを全部当たり直すことはしない
   */
  carriers: Record<string, number>;
  /** カルーセルを読み切っても来なかった局 (局 ID → そう分かった時刻) */
  absent: Record<string, number>;
  /**
   * 地上波で、開けるだけ開けても**大きいロゴ (64×36) が来なかった**局 (局 ID → 時刻)。
   * 控えておかないと、小さいロゴしか流さない局のために定期チェックのたびに 6 分開き直す
   */
  gaveUp: Record<string, number>;
}

/**
 * 読んだ控えを持っておく。
 *
 * `missing()` は局の数だけ引くので (実機で 124 局)、そのたびにファイルを
 * 読みに行くと、番組表を 1 回出すだけで何百回も開くことになる。
 * 書くのはこの 1 プロセスだけなので、書いたときに入れ替えれば足りる。
 * 置き場が変わったら読み直す (`db.ts` の接続と同じ。テストはファイルごとに置き場を変える)
 */
let relays: RelayNotes | null = null;
let relaysFrom = "";

function notes(): RelayNotes {
  const path = relayPath();
  if (relays !== null && relaysFrom === path) return relays;
  relaysFrom = path;
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<RelayNotes>;
    relays = {
      noCarousel: parsed.noCarousel ?? {},
      carriers: parsed.carriers ?? {},
      absent: parsed.absent ?? {},
      gaveUp: parsed.gaveUp ?? {},
    };
  } catch {
    relays = { noCarousel: {}, carriers: {}, absent: {}, gaveUp: {} };
  }
  return relays;
}

function save(next: RelayNotes): void {
  relays = next;
  relaysFrom = relayPath();
  try {
    mkdirSync(logoDir(), { recursive: true });
    writeWhole(relayPath(), JSON.stringify(next));
  } catch {
    // 控えられなくても取得はできる。次の機会に
  }
}

/** その中継は今回は飛ばしてよいか。確かめてから RELAY_RETRY の間だけ */
function skipRelay(channel: string): boolean {
  return fresh(notes().noCarousel[channel], RELAY_RETRY);
}

/** 「この中継にロゴは載っていない」/「載っていた」を書き留める */
function markRelay(channel: string, hasLogo: boolean): void {
  const known = notes();
  // 何も変わらないなら書きに行かない。外れの控えが古くなっていたら、時刻を書き直す (書き直さないと毎回開き直す)
  if (
    hasLogo === !fresh(known.noCarousel[channel], RELAY_RETRY) &&
    hasLogo === (known.carriers[channel] !== undefined)
  )
    return;
  const noCarousel = { ...known.noCarousel };
  const carriers = { ...known.carriers };
  if (hasLogo) {
    delete noCarousel[channel];
    carriers[channel] = Date.now();
  } else {
    noCarousel[channel] = Date.now();
    delete carriers[channel];
  }
  save({ ...known, noCarousel, carriers });
}

/**
 * カルーセルを 1 回ぶん読み切った。**まだ埋まらない局を控える。**
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
      // **小さいものへは戻さない。** 局は 6 種類の大きさを順に流していて、どれが先に来るかは開くたびに違う
      if (!replacesLogo(storedLogoType(id), logoType)) continue;
      writeWhole(logoPath(id), data);
      /*
       * **`updated_at` は触らない。** あれは「最後に取り込みで見かけた時刻」で、見かけない時間が長い局の
       * 番組表と予約を片付けるのに使う (`epg.forgetMissing`)。進めると、選局できなくなった局が片付かない
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
 * 衛星の中継 1 つぶんの読みかけ。**閉じても捨てない** (`CarouselProgress`)。
 *
 * `written` も一緒に残す。読みかけには揃ったロゴも入っているので、開き直すたびに同じものを
 * 全局ぶん書き直すことになる (書き込み時刻が進むと、「この取得で取れた局」の数も狂う)
 */
interface Carousel {
  progress: CarouselProgress;
  written: Set<string>;
}

/**
 * 中継ごとの読みかけ。**残すのは当たりの中継だけ** (ロゴを積んでいるのはふつう 1 中継なので、溜まっても 1 つ)。
 * 読み切ったら・外れと分かったら捨てる (`collect`)。揃ったまま残すと、1 週間後の取り直しで
 * 古い読みかけから書いたことにして、新しいものを取得しなくなる
 */
const carousels = new Map<string, Carousel>();

/** 前の読みかけ。無ければ新しく (当たりと分かるまでは `carousels` に入れない) */
function carouselOf(channel: string): Carousel {
  return (
    carousels.get(channel) ?? {
      progress: new CarouselProgress(),
      written: new Set(),
    }
  );
}

/**
 * 流れてくる TS からロゴを取得する。
 *
 * 失敗しても黙って諦める。ロゴが無くても番組表は出るし、録画には何の関係も無い。
 *
 * `carousel` を渡すと、衛星のカルーセルを前に開いたときの続きから読む
 */
function watch(networkId: number, carousel?: Carousel): Feed {
  const collector = new LogoCollector(networkId, carousel?.progress);
  let broken = false;
  /** 同じものを何度も書きに行かない。ロゴは滅多に変わらない */
  const written = carousel?.written ?? new Set<string>();

  const feed = (chunk: Uint8Array) => {
    if (broken) return;
    try {
      collector.feed(chunk);
      const found = collector.collected();
      if (found.length === 0) return;

      // **開いている間は取得し続ける。** 1 つの TS にはその物理チャンネルの局が全部流れていて、ロゴは局ごとに別々に来る
      let saved = 0;
      for (const { networkId: network, serviceIds, logo } of found) {
        // 衛星は他ネットワークの局も混ざる。どのネットワークのぶんかは
        // ロゴ自身に入っているので、そちらで引く
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
  /** 外れの中継を早く見切るためと、読み切ったかを確かめるために読む。地上波では使わない */
  Object.defineProperties(feed, {
    hasSatelliteLogo: { get: () => collector.hasSatelliteLogo },
    carouselRead: { get: () => collector.satelliteCarouselRead },
    counts: { get: () => collector.satelliteCounts },
  });
  return feed as Feed;
}

/** データを渡す入口。ついでに「この中継にロゴがあるか」も読める */
interface Feed {
  (chunk: Uint8Array): void;
  readonly hasSatelliteLogo: boolean | null;
  /** 衛星のロゴのカルーセルを 1 回ぶん読み切ったか */
  readonly carouselRead: boolean;
  /** この回に読んだパケットとセクションの数 (記録の 1 行に足す。`waitedMessage`) */
  readonly counts: Readonly<CarouselCounts>;
}

/**
 * `has_logo` を実際のファイルに合わせ直す。
 *
 * この列は「番組表にロゴを出すかどうか」の判断にそのまま使われるので、
 * ファイルが無いのに立っていると番組表に壊れた画像が並ぶ。しかも
 * `missing()` が「もう持っている」とみなして取得しなくなるため、
 * 放っておくと永久に埋まらない。
 *
 * 置き場ごと消えることは実際に起きる (PVC の作り直しなど)。
 * DB とファイルのどちらが正しいかを迷わないよう、**ファイルを正とする**。
 *
 * 起動したときは (`repaintOld`)、色の表の入っていない古いファイルも直す。放送から取得したままの
 * PNG はパレットが抜けていて、ブラウザは何も描かない (logo-palette.ts)。
 * 取得し直すと局によっては何時間もかかるので、置いてあるものを直す。取得のたびには直さない
 * (今のコードが書くものには色の表が入っているので、全局の PNG を読み直すだけになる)
 */
export function reconcile(repaintOld = false): number {
  const rows = orm()
    .select({ id: services.id, has_logo: services.has_logo })
    .from(services)
    .all();
  let changed = 0;
  orm().transaction((tx) => {
    for (const row of rows) {
      const actual = existsSync(logoPath(row.id));
      if (actual && repaintOld) repaint(row.id);
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

/** ロゴを取得する単位。1 つの物理チャンネルと、そこに入っている局 */
interface Target {
  type: string;
  channel: string;
  network_id: number;
}

/** 局の行から、その局が入っている物理チャンネル */
function targetOf(service: Target): Target {
  return {
    type: service.type,
    channel: service.channel,
    network_id: service.network_id,
  };
}

/**
 * ロゴを取り直すまでの間隔。局のマークは滅多に変わらないが、変わったときに永久に
 * 古いままなのは困る。取り直すたびに 1 チャンネルを数分開くので、長めにしておく。
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
 * 地上波にしか無い。衛星まで見ると、万一のときに毎回 20 分待つことになる
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
 * **ロゴを 1 つも持っていない局は控えない。** そちらは今までどおり毎回取得する
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

/**
 * いま選局できる局。取り残しは見に行かない。
 * 復号できない局も見に行かない (`services.decodable`。ライブに出さず、ケーブルとスカパー！プレミアムの局のロゴはまだ集めない)。
 * **CATV の局もまだ見に行かない。** ここから先は地上波でない局を衛星として扱う (カルーセルを当たりの中継で待つ) ので、CATV を入れると衛星に数えてしまう
 */
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
    .where(
      and(
        currentServices(),
        eq(services.decodable, true),
        ne(services.type, "CATV"),
      ),
    )
    .orderBy(services.type, services.channel)
    .all();
}

/**
 * ロゴを取得する物理チャンネル。
 *
 * いま選局できる局だけを対象にする。取り残しの局まで見に行くと、
 * もう選局できないチャンネルを 1 局ずつ開いては諦めることになり、
 * 本当に要る局まで順番が回ってこない。
 */
function missing(): Target[] {
  const services = tunableServices();
  const targets = new Map<string, Target>();
  const add = (service: Target) => {
    const key = `${service.type}:${service.channel}`;
    if (!targets.has(key)) targets.set(key, targetOf(service));
  };

  // 地上波は中継ごとに入っている局が違う。その中継の局が足りないときだけ開く
  for (const service of services) {
    if (service.type === "GR" && needsLogo(service)) add(service);
  }

  /*
   * **衛星は「その中継の局が足りているか」では選べない。**
   *
   * ロゴを積んだ中継 1 つに BS も CS も全部載っているので、中継ごとに見ると
   * BS が揃った時点でその中継が候補から外れ、**そこにしか無い CS が永久に
   * 埋まらない**。
   *
   * 衛星の局が 1 つでも足りなければ、**まだ外れと分かっていない中継**を当たる。
   * どれが当たりかは開いてみないと分からないが (実機の BS はネットワーク 4 の
   * 26 中継のうち `BS15:16625` だけ)、外れは PAT を見た時点で 1 秒ほどで切り上げ、
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
 * **衛星のカルーセルは開いた中継の局だけを運ぶのではない。** `BS15:16625` の
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
 * 1 回開いてどう終わったか。画面に出すメッセージと、次にいつ開くかを決める。
 *
 * - `done` … 揃った、またはカルーセルを 1 回ぶん読み切った
 * - `miss` … ロゴを積んでいない中継だった (衛星)
 * - `ranOut` … 上限まで開けていた
 * - `yielded` … 開けたあとで切れた。優先度の高い要求に譲った (エージェントが取り上げた) のがほとんど
 * - `busy` … 開けなかった。空いているチューナーが無い
 * - `stopped` … こちらから止めた (「いますぐ」の押し直しなど)
 */
type Outcome = "done" | "miss" | "ranOut" | "yielded" | "busy" | "stopped";

/**
 * 衛星のカルーセルをいつ見たか・いつ待って来なかったか (`logo-period.ts` の `CarouselWatch`)。
 * ここから、ダウンロードの期間中か、次にいつ自分で開くかを決める (`awaitCarousel`)。
 *
 * - `seenAt` は読み進んだ回か、共通データの SDTT を見た回。共有でも控える。同じ DII が繰り返し来るだけでは
 *   控えない (無音の間も DII だけ流し続ける中継があると、ずっと期間中に見えてしまう)
 * - `ranOutAt` は上限まで開けて何も来なかった回だけ。譲って切れた回は数えない (読みかけは残っていて、次は続きから読む)。
 *   **途中まで届いた回も数えない。** 前は上限で切れたら一律に 6 時間空けていて、来ているのに読み切れなかった回まで
 *   次の機会を捨てていた (#1939)
 *
 * プロセスの中だけに持つ。起動し直したら期間の外とみなし、いちばん下の優先度で一度開くところから始める
 */
const carouselWatch: CarouselWatch = {};

/**
 * 自分で開いて待ち始めた時刻を控える (`CarouselWatch.triedAt`。定期チェックと「いますぐ」)。
 * 開けた回だけ数える。開けなかった回・外れの中継 (1 秒ほどで閉じて次へ行く) は数えない
 */
function markTried(outcome: Outcome, startedAt: number): void {
  if (outcome !== "busy" && outcome !== "miss")
    carouselWatch.triedAt = startedAt;
}

/**
 * 1 つの物理チャンネルを開いて、そこに入っている局のロゴを取得する。
 *
 * **物理チャンネルを丸ごと開く。** 局を選り分けてしまうと、ロゴを載せている
 * CDT (PID 0x0029) はどの局の PMT にも載っていない都合でまるごと落ちる。
 * 実機で確かめると、局単位で 3 分・427MB 読んでも CDT は 1 つも来なかった。
 *
 * **1 局取れた時点でも閉じない。** 1 つの TS にはその物理チャンネルの局が全部
 * 流れていて、ロゴは局ごとに別々のタイミングで来る。せっかく開いたのだから、
 * 揃うか時間切れになるまで読む。
 *
 * **衛星のカルーセルは読みかけを残す** (`carousels`)。番組表の取得やライブに譲って切れても、
 * 次に開いたときに続きから読む。**当たりの中継と分かったら、共有でも `config.logoCarouselWait` まで開く。**
 * 十数分に一度しか来ないものを 3 分で切り上げていると、来る時刻に開いている見込みが薄い。
 *
 * 返す `received` は、この回にカルーセルから 1 つでも受け取ったか (`CarouselProgress.received`)。
 * `openedMs` は開いていた長さ (開けなかったら 0)。`counts` はこの回に読んだ数 (開けなかったら null)
 */
async function collect(
  target: Target,
  timeout: number,
  signal?: AbortSignal,
  after: readonly StreamUse[] = [],
  priority: number = SWEEP_PRIORITY,
): Promise<{
  found: number;
  outcome: Outcome;
  carrier: boolean;
  received: boolean;
  openedMs: number;
  counts: Readonly<CarouselCounts> | null;
}> {
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
  const startedAt = Date.now();
  const expire = (ms: number) =>
    setTimeout(() => {
      ranOut = true;
      controller.abort();
    }, ms);
  let stop = expire(timeout);
  collecting.add(target.channel);
  // 外から止められるようにする。衛星に 20 分かけている最中でも譲れるように
  const give = () => controller.abort();
  signal?.addEventListener("abort", give, { once: true });
  let opened = false;
  /** こちらで見切って閉じた理由。無ければ向こうの都合で切れた */
  let ended: Outcome | null = null;
  const carousel = satellite ? carouselOf(target.channel) : undefined;
  const receivedBefore = carousel?.progress.received ?? 0;
  /** ロゴを積んだ中継だったか */
  let carrier = false;
  let openedAt: number | null = null;
  let feed: Feed | null = null;
  try {
    const stream = await openChannelStream(
      target.type,
      target.channel,
      controller.signal,
      // 何を使っているのかが設定の「チューナー」に出る
      logoUse(target),
      priority,
      after,
    );
    opened = true;
    openedAt = Date.now();
    feed = watch(target.network_id, carousel);
    for await (const chunk of chunks(stream)) {
      feed(chunk);
      /*
       * **衛星のロゴは 1 つの中継にしかない** (`RELAY_RETRY`)。外れの中継は PAT を
       * 見た時点で分かるので、待たずに次へ行く。当たり外れは書き留めておく。
       * そうしないと、二度と来ないものを定期チェックのたびに開き直すことになる。
       * 揃ったかを見るより先に書き留める (1 回目の読み込みで揃ったときも、当たりの中継として扱う)
       */
      if (satellite && !marked && feed.hasSatelliteLogo !== null) {
        marked = true;
        markRelay(target.channel, feed.hasSatelliteLogo);
        if (!feed.hasSatelliteLogo) {
          ended = "miss";
          break;
        }
        // 当たり。読みかけを残す。共有 (RIDE_TIMEOUT) でも、カルーセルが 1 回りするまで開いておく
        if (carousel !== undefined) carousels.set(target.channel, carousel);
        carrier = true;
        if (timeout < config.logoCarouselWait) {
          clearTimeout(stop);
          stop = expire(config.logoCarouselWait - (Date.now() - startedAt));
        }
      }
      // 全部揃ったら、これ以上開けておく理由がない
      if (remaining() === 0) {
        ended = "done";
        break;
      }
      /*
       * 衛星は揃いきらないことがある (カルーセルに載っていない局がある)。
       * **DII が知らせたロゴのモジュールが全部揃ったら、カルーセルは 1 回ぶん読み切った**
       * (`carouselRead`)。残っている局は載っていない局なので、そう書き留めて次からは行かない。
       * これが無いと、載っていない局が 1 つでもあるだけで毎回 20 分丸ごと待つことになる
       */
      if (satellite && feed.carouselRead) {
        markAbsent();
        ended = "done";
        break;
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
  const outcome: Outcome =
    ended ??
    (ranOut
      ? "ranOut"
      : signal?.aborted === true
        ? "stopped"
        : opened
          ? "yielded"
          : "busy");
  // 読み切った・外れだった読みかけは捨てる。持っていても次に役立たない
  if (outcome === "done" || outcome === "miss")
    carousels.delete(target.channel);
  const received = (carousel?.progress.received ?? 0) > receivedBefore;
  /*
   * 途中まででも届いていれば・共通データの SDTT が来ていれば、カルーセルは流れている (ダウンロードの期間中)。
   * 次に空いたときに続きを読む。共有で見たときも控える (前に「来なかった」と控えていても、こちらが新しくなる)。
   * ただし**上限まで開けて読み進まなかった回は、SDTT が来ていても「来なかった」と控える。** SDTT だけ来てブロックが
   * 増えない中継があると、期間中のまま空くたびに番組表の取得より上の優先度で 20 分ずつ塞ぎ続けてしまう
   */
  const sdtt = (feed?.counts.sdtt ?? 0) > 0;
  if (carrier && outcome === "ranOut" && !received)
    carouselWatch.ranOutAt = Date.now();
  else if (carrier && (received || sdtt)) carouselWatch.seenAt = Date.now();
  // 共有 (RIDE_TIMEOUT) は短いので、来なかったことの証拠にしない
  if (!satellite && ranOut && timeout >= SWEEP_TIMEOUT)
    markGaveUp(target.channel);
  return {
    found: before - remaining(),
    outcome,
    carrier,
    received,
    openedMs: openedAt === null ? 0 : Date.now() - openedAt,
    counts: feed?.counts ?? null,
  };
}

/**
 * その中継を開くときの優先度。**当たりと分かっている衛星の中継で、カルーセルを待つときだけ**番組表の取得より上
 * (`config.priority.carousel`)。外れを探すとき・地上波はいちばん下のまま。
 *
 * 番組表の取得は衛星のチューナー 2 台で次のチャンネルへ移るとき、いちばん優先度の低い選局を取り上げる。
 * いちばん下のままだと、十数分に一度のカルーセルが来る前に取り上げられ続けた (#1939)。
 * 録画・ライブ・スキャン・「番組表をいますぐ集める」には今までどおり譲る。持っているのは読み切るまで、
 * 長くても `config.logoCarouselWait`。
 *
 * 定期チェック (`awaitCarousel`) では、ダウンロードの期間の外ならこれを使わず、いちばん下で開く (`logo-period.ts`)
 */
function carouselPriority(target: Target): number {
  return target.type !== "GR" &&
    notes().carriers[target.channel] !== undefined &&
    !skipRelay(target.channel)
    ? config.priority.carousel
    : SWEEP_PRIORITY;
}

/** 設定の「チューナー」に出る用途の名前。引き継ぎ (`after`) でも同じものを渡す */
function logoUse(target: Target): StreamUse {
  return `logo ${target.type}/${target.channel}`;
}

/**
 * **その種別を受けられる**空きチューナーの数 (衛星用の空きは地上波の役に立たない)。
 *
 * `leaving` は**こちらが閉じたばかりの選局**。閉じたことがエージェントに届くのは
 * 非同期なので、閉じた直後に訊くとまだ使用中に見える。それを数え損ねると、衛星の
 * 外れの中継 (1 秒ほどで閉じる) の次に「CS の空きチューナーが無くなった」と諦めて
 * いた。もう 1 台は当たりの中継を読んでいる最中なので、空きが 0 に見える。
 * そこにしかいないなら空きとして数え、開くときに `after` で引き継ぐ。
 *
 * **利用者のいない選局 (余韻) も空きとして数える。** エージェントは誰も読まなくなった選局を 5 秒畳まずに残し
 * (`TunerPool.Linger`)、その間に来た要求に使い回す。一覧ではチャンネルが付いたまま利用者が空になる。
 * これを使用中と数えていた頃は、外れの中継を閉じた直後や番組表の取得が終わった直後に空きが 0 に見え、
 * BS と CS のチューナーが共通の 2 台の環境で、当たりの中継まで行き着かずに「CS の空きチューナーが無くなったため、
 * 残りは取りやめました」と止まっていた (#1939)
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
      tuner.users.every((user) => leaving.includes(user.use)),
  ).length;
}

/**
 * 空きチューナーの数 (`countFree`)。無ければ自分では開かない。
 * 譲る相手は優先度の数だけで決まるので、番組表の取得に譲る特別扱いは要らない (エージェントが断る・取り上げる)。
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

/**
 * 共有できる物理チャンネル。**ロゴ以外の利用者がいる選局だけ** (`ride`)。
 *
 * ロゴの利用者しかいない選局は自分のもので、読んでいる最中か、閉じたのがエージェントに
 * まだ届いていないだけ。それを共有しに行くと、閉じた後に**自分で開き直して**衛星のチューナーを
 * 1 台塞いでいた。外れと分かったばかりの中継まで開き直し、その間に「いますぐ」が CS の空きを
 * 0 と見て残りを諦めていた (17-logo が CI で時々落ちていた)
 */
export function shareable(
  tuners: readonly Pick<AgentTuner, "channel" | "users">[],
): Set<string> {
  const open = new Set<string>();
  for (const tuner of tuners) {
    if (
      tuner.channel !== null &&
      tuner.users.some((user) => !user.use.startsWith("logo "))
    )
      open.add(tuner.channel.channel);
  }
  return open;
}

/**
 * 共有する選局を選んでいる最中か。合図 (エージェントの `tuners`) は連続して飛んでくるので、
 * 選んでいる間に来たぶんは、選び終えてからもう一度見る (`replan`)。
 * **読むほうは並べる。** 衛星の当たりの中継は 20 分読むので、1 つずつ待っていると、その間に
 * 番組表の取得が開いた地上波を共有し損ねる
 */
let planning = false;
let replan = false;

/**
 * 取得している最中の様子。画面はこれを見る (1 チャンネルに数分かける仕事なので、進み具合を出す)。
 */
interface SweepState {
  running: boolean;
  /** いま開いている物理チャンネル。地上波は 2 つ並ぶ */
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
 * 走っているのは高々 1 つ。定期実行と画面からの「ロゴをいますぐ集める」が重なると
 * チューナーを取り合う。共有 (ride) だけはチューナーを増やさないので別勘定にしてある
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
 * 順番に開いて取得する。**同時に 2 つまで。**
 *
 * 地上波は中継ごとに入っている局が違うので、1 つずつ回っていると数が捌けない。
 * 衛星は当たりの中継 1 つで全局ぶんが揃う代わりに 1 回が長い。
 *
 * 1 つ取りかかるたびに空きを見る。録画が始まったのに開きに行くと、使えないまま
 * 待つことを人数ぶん繰り返すことになる。
 *
 * **空きが無いのが同じ取得のもう一方のワーカーのせいなら、その種別を取りやめない。** その種別の残りはもう一方のワーカーが取り、
 * このワーカーはほかの種別へ進む (無ければ終える)。地上波の空きが 1 台だけの環境で、もう一方が開いている地上波を
 * 「空きが無い」と取り違え、地上波を 1 チャンネルで止めていた
 */
async function drain(
  queue: Target[],
  parallel: number,
  signal: AbortSignal,
  stamps: Map<number, number>,
  leaving: readonly StreamUse[] = [],
): Promise<void> {
  /** 空きが無くなった種別。**その種別だけ**諦める (衛星の満杯で地上波を止めない) */
  const full = new Set<string>();
  /** いま開いている種別ごとの数 (この取得の中だけ) */
  const open = new Map<string, number>();
  const worker = async (index: number) => {
    /** このワーカーが閉じたばかりの選局。次を開くときに引き継ぐ (`freeTuners`) */
    let left: readonly StreamUse[] = index === 0 ? leaving : [];
    /** もう一方のワーカーが取る種別。このワーカーは取らない (もう一方が開いていなければ戻す) */
    const handedOver = new Set<string>();
    for (;;) {
      // もう一方のワーカーが開いていない種別は戻す (先に終えたなら、残りはこのワーカーが取る)
      for (const type of handedOver)
        if ((open.get(type) ?? 0) === 0) handedOver.delete(type);
      const at = queue.findIndex((target) => !handedOver.has(target.type));
      if (at < 0 || signal.aborted) return;
      const target = queue.splice(at, 1)[0]!;
      // 諦めたぶんも見終えたものとして数える。進み具合が総数に届かなくなる
      /*
       * 衛星は当たりの中継 1 つで BS と CS の全局ぶんが揃う。揃ったあと (読み切ったあと) は、残りの中継を開いて
       * 当たり外れを確かめても取得できる局は無い
       */
      if (
        full.has(target.type) ||
        (target.type !== "GR" && missingSatellites() === 0)
      ) {
        update({ done: state.done + 1 });
        continue;
      }
      if ((await freeTuners(target.type, left)) === 0) {
        if ((open.get(target.type) ?? 0) > 0) {
          queue.unshift(target);
          handedOver.add(target.type);
          continue;
        }
        full.add(target.type);
        update({
          done: state.done + 1,
          message: `${beforeJapanese(typeNames([target.type]))}の空きチューナーが無くなったため、残りは取りやめました`,
        });
        continue;
      }
      open.set(target.type, (open.get(target.type) ?? 0) + 1);
      update({ channels: [...state.channels, target.channel] });
      // 衛星のカルーセルは十数分に一度しか来ない。当たりの中継はそれまで待つ
      const limit =
        target.type === "GR" ? SWEEP_TIMEOUT : config.logoCarouselWait;
      const startedAt = Date.now();
      const { found, outcome, carrier, received, openedMs, counts } =
        await collect(target, limit, signal, left, carouselPriority(target));
      open.set(target.type, (open.get(target.type) ?? 1) - 1);
      /*
       * もう一方のワーカーと同じ空きを取り合って開けなかった。その中継は読んでいないので列へ戻し、この種別はもう一方のワーカーが取る
       */
      if (outcome === "busy" && (open.get(target.type) ?? 0) > 0) {
        queue.unshift(target);
        handedOver.add(target.type);
        update({
          channels: state.channels.filter(
            (channel) => channel !== target.channel,
          ),
        });
        continue;
      }
      // 記録の「7 時間あけて開き直します」と合わせる。「いますぐ」で開けた回も、定期チェックの間合いはここから数える
      if (carrier) markTried(outcome, startedAt);
      const note = carrier
        ? carouselMessage(target.channel, outcome, received)
        : "";
      // 当たりの中継は、定期チェックで待ったとき (`awaitCarousel`) と同じ 1 行を記録に残す
      const line = carrier
        ? waitedMessage(target.channel, outcome, received, openedMs, counts)
        : null;
      if (line !== null) console.log(`[logo] ${line}`);
      if (carrier)
        recordLogoAttempt({
          startedAt,
          channel: target.channel,
          origin: "now",
          openedMs,
          outcome,
          received,
          found,
          counts,
        });
      left = [logoUse(target)];
      update({
        channels: state.channels.filter(
          (channel) => channel !== target.channel,
        ),
        done: state.done + 1,
        found: writtenSince(stamps),
        /*
         * 当たりの中継を取り上げられたら、そう言う。黙って次へ進むと、最後に「0 局のロゴを取得しました」
         * とだけ出て、読み切って何も無かったのか途中で切れたのか見分けが付かなかった
         */
        ...(note !== "" ? { message: note } : {}),
      });
    }
  };
  await Promise.all(Array.from({ length: parallel }, (_, i) => worker(i)));
}

/** 当たりの中継が読み切れないまま閉じたときのメッセージ。それ以外は空 (`run` の締めのメッセージを使う) */
function carouselMessage(
  channel: string,
  outcome: Outcome,
  received: boolean,
): string {
  const minutes = config.logoCarouselWait / 60_000;
  switch (outcome) {
    case "yielded":
      return `${channel} はほかの選局にチューナーを譲りました。読んだところまでは覚えているので、次に開いたときに続きから読みます`;
    case "ranOut":
      return received
        ? `${channel} を ${minutes} 分開いて途中まで読みました。次に開いたときに続きから読みます`
        : `${channel} を ${minutes} 分開きましたが、ロゴは流れてきませんでした`;
    default:
      return "";
  }
}

/**
 * 当たりの中継で待ったあと (`awaitCarousel`) の記録の 1 行。どう終わったかを残す。残していなかった頃は、
 * 2 台の環境で一晩揃わなかったときに、取り上げられ続けたのか来なかったのかが記録から分からなかった (#1939)。
 * 外れの中継 (`miss`) と、開けなかった回 (`busy`) は出さない。
 *
 * `counts` を渡すと、この回に読んだ数を後ろに足す (`countsNote`)。20 分開いても何も来なかった報告で、
 * カルーセルが来なかったのか、ロゴの ES を見つけられなかったのか、誤りで壊れたのかを記録から分けられなかった (#1939)
 */
export function waitedMessage(
  channel: string,
  outcome: Outcome,
  received: boolean,
  openedMs: number,
  counts: Readonly<CarouselCounts> | null = null,
): string | null {
  const opened = `${channel} を ${Math.round(openedMs / 60_000)} 分開いて`;
  const line = (() => {
    switch (outcome) {
      case "done":
        return `${opened}、カルーセルを読み切りました`;
      case "yielded":
        return `${opened}、ほかの選局にチューナーを譲りました。読んだところまでは覚えています`;
      case "stopped":
        return `${opened}、「ロゴをいますぐ集める」を先にしました`;
      case "ranOut":
        if (received)
          return `${opened}途中まで読みました。次に空いたときに続きから読みます`;
        // SDTT が来ていればダウンロードは出ている。それでも読み進まなければ同じく間をあける (`collect` の `carouselWatch`)
        if (counts !== null && counts.sdtt > 0)
          return `${opened}、ダウンロードは出ていましたが、ロゴは届きませんでした。${OFF_PERIOD_RETRY / 3_600_000} 時間あけて開き直します`;
        return `${opened}もロゴが流れてこなかったので、ダウンロードの期間の外とみなして ${OFF_PERIOD_RETRY / 3_600_000} 時間あけて開き直します`;
      default:
        return null;
    }
  })();
  return line === null || counts === null
    ? line
    : `${line} (${countsNote(counts)})`;
}

/** 読んだ数の書き出し。数だけで、放送の中身は出さない */
function countsNote(counts: Readonly<CarouselCounts>): string {
  return [
    `TS ${counts.packets} パケット`,
    `誤り ${counts.errors}`,
    `PMT ${counts.pmt ? "あり" : "なし"}`,
    `ロゴの ES ${counts.esPids} 本に ${counts.esPackets} パケット`,
    `DII ${counts.dii}`,
    `DDB ${counts.ddb}`,
    `共通データの SDTT ${counts.sdtt}`,
  ].join("・");
}

/**
 * **いま開いている選局を共有して**ロゴを取得する。
 *
 * 番組表の取得も録画も、物理チャンネルを丸ごと開く。そこへ同じチャンネルを要求すると
 * **エージェントは新しいチューナーを使わずに選局を共有させる**ので、こちらはチューナーを増やさずに電波を
 * 読める。空いた時間に自分で開き直すより早く埋まり、チューナーの取り合いも起きない。
 *
 * 合図はエージェントの `tuners`。開いた瞬間に飛んでくるので、閉じるまでの間に読み切る。
 * 相手が先に閉じれば、こちらはいちばん低い優先度で開いたまま残り、次に要る人が来たら譲る。
 */
export async function ride(): Promise<number> {
  if (planning) {
    replan = true;
    return 0;
  }
  planning = true;
  const rides: Promise<{ found: number }>[] = [];
  try {
    do {
      replan = false;
      // 立っているだけでファイルが無い局を先に取得し直す。そうしないと
      // 「もう持っている」とみなして永久に取得しない
      reconcile();
      const need = missing();
      if (need.length === 0) break;

      const open = shareable(await getTuners());
      for (const target of need) {
        if (!open.has(target.channel)) continue;
        // 自分で開けたものは共有しない。同じチャンネルを二重に読むことになる
        // (`collect` は開きに行く前に `collecting` へ入れるので、選び直しても二重にならない)
        if (collecting.has(target.channel)) continue;
        rides.push(collect(target, RIDE_TIMEOUT));
      }
    } while (replan);
  } catch {
    // エージェントに聞けなければ何もしない。次の通知でまた来る
  } finally {
    planning = false;
  }
  const results = await Promise.all(rides);
  return results.reduce((sum, { found }) => sum + found, 0);
}

/** 自分で開いて待っている当たりの中継。「いますぐ」が押されたら畳んで譲る */
let idle: { use: StreamUse; controller: AbortController } | null = null;

/**
 * **衛星のロゴが足りない間は、空いているチューナーで当たりの中継を開いて待つ。**
 *
 * 共有 (`ride`) だけでは揃わなかった (docs/logo.md「衛星は共有だけでは揃わなかった」)。
 *
 * 待つのは**当たりと分かっている中継だけ** (`carriers`)、**その種別のチューナーが空いているとき**だけ。
 * **ダウンロードの期間中だけ**、優先度は番組表の取得の 1 つ上 (`carouselPriority`) で、空くたびに開く。録画・ライブ・スキャンが来れば取り上げられ、
 * 読みかけは残る (`CarouselProgress`) ので、次に空いたときに続きから読む。どう終わったかは 1 行残す (`waitedMessage`)。
 * **期間の外では**いちばん下の優先度で、`OFF_PERIOD_RETRY` おきにだけ開く (`nextCarouselAttempt`)。ロゴは期間の外には
 * 流れてこないので、番組表の取得を押しのけてまで待たない (docs/logo.md「衛星はダウンロードの期間にだけ流れてくる」)。
 *
 * 当たりがまだ分からなければ、確かめていない衛星の中継を順に開いて探す。外れは PAT を見た時点
 * (1 秒ほど) で閉じ、1 週間は開き直さない (`RELAY_RETRY`)。当たりを控える前のバージョンから
 * 上げたときも、番組表の取得がその中継を開くのを何時間も待たずに済む
 */
async function awaitCarousel(): Promise<number> {
  if (missingSatellites() === 0) return 0;
  const attempt = nextCarouselAttempt(carouselWatch, Date.now());
  if (attempt.at > Date.now()) return 0;
  let found = 0;
  /** この手で閉じたばかりの外れの中継。次を開くときに引き継ぐ (`countFree`) */
  let left: StreamUse[] = [];
  for (;;) {
    const target = carrierTarget() ?? unprobedRelay();
    if (target === null || collecting.has(target.channel)) return found;
    if ((await freeTuners(target.type, left)) === 0) return found;
    // 空きを訊いている間に、共有や「いますぐ」が同じ中継を開いたかもしれない
    if (collecting.has(target.channel) || state.running) return found;
    const controller = new AbortController();
    idle = { use: logoUse(target), controller };
    const startedAt = Date.now();
    try {
      const result = await collect(
        target,
        config.logoCarouselWait,
        controller.signal,
        left,
        attempt.period ? carouselPriority(target) : SWEEP_PRIORITY,
      );
      found += result.found;
      markTried(result.outcome, startedAt);
      const line = result.carrier
        ? waitedMessage(
            target.channel,
            result.outcome,
            result.received,
            result.openedMs,
            result.counts,
          )
        : null;
      if (line !== null) console.log(`[logo] ${line}`);
      if (result.carrier)
        recordLogoAttempt({
          startedAt,
          channel: target.channel,
          origin: "wait",
          openedMs: result.openedMs,
          outcome: result.outcome,
          received: result.received,
          found: result.found,
          counts: result.counts,
        });
      // 外れなら次の中継へ。それ以外 (読み切った・譲った・来なかった) はここまで
      if (result.outcome !== "miss") return found;
    } finally {
      idle = null;
    }
    left = [logoUse(target)];
  }
}

/** まだ当たり外れを確かめていない衛星の中継。BS から (並びは `tunableServices`) */
function unprobedRelay(): Target | null {
  const known = notes();
  const service = tunableServices().find(
    (s) =>
      s.type !== "GR" &&
      known.carriers[s.channel] === undefined &&
      !skipRelay(s.channel),
  );
  return service === undefined ? null : targetOf(service);
}

/** 当たりと分かっている中継のうち、いまも選局できて、いちばん最近当たったもの */
function carrierTarget(): Target | null {
  const tunable = tunableServices();
  const known = Object.entries(notes().carriers).sort(([, a], [, b]) => b - a);
  for (const [channel] of known) {
    const service = tunable.find(
      (s) => s.type !== "GR" && s.channel === channel,
    );
    if (service === undefined || skipRelay(channel)) continue;
    return targetOf(service);
  }
  return null;
}

/**
 * 定期チェック。**ほかの選局を共有する** (`ride`)。
 *
 * 番組表の取得は全チャンネルを定期的に開くので、その選局を共有すればチューナーを増やさずに読める
 * (実機では BS の 38 局ぶんが番組表の取得の選局を一度共有しただけで揃った)。録画とチューナーを取り合う理由がない。
 *
 * **衛星だけは、足りない間は空いているチューナーで当たりの中継を待つ** (`awaitCarousel`)。
 * 地上波は共有を重ねるうちに揃う (1 回の共有は `RIDE_TIMEOUT` までで、当たらないことも多い)。
 * すぐ欲しいときは画面の「ロゴをいますぐ集める」(`sweepNow`) がある。
 */
export async function sweep(): Promise<number> {
  const [shared, waited] = await Promise.all([ride(), awaitCarousel()]);
  return shared + waited;
}

/**
 * 画面の「ロゴをいますぐ集める」。残っているぶんを、チューナー 2 台で一気に取得する。
 *
 * **衛星も混ぜる。** ロゴを運ぶ中継は 1 つだけで、当たれば BS と CS の全局ぶんが
 * まとめて揃い、外れは PAT を見た時点 (1 秒ほど) で次へ行く。当たり外れを
 * 書き留めておくので、二度目からは当たりの中継しか開かない。
 */
export async function sweepNow(): Promise<{
  started: boolean;
  message: string;
}> {
  /*
   * 前の取得が回っていても譲ってもらう。1 チャンネルに数分〜20 分開くので、
   * 待たせると押した人の用が済まない。チューナーを増やさない共有 (ride) は
   * 別勘定なので、ここでは触らない
   */
  if (state.running) {
    inflight?.abort();
    if (!(await settled()))
      return { started: false, message: "まだ前の分を集めています" };
  }
  reconcile();
  /*
   * **押されたら「カルーセルに載っていない」「この中継は外れ」の控えを捨てて当たり直す。** 控えが間違っていると
   * (読み切る前に見切った、前の選局の PAT を見て当たりの中継を外れとした、など)、押しても「すべて取得済み」と
   * 言われ、1 週間 (`RELAY_RETRY`) は取り直せなかった。外れの中継は PAT で 1 秒ほどで見切るので、当たり直しても安い
   */
  const known = notes();
  if (
    Object.keys(known.absent).length > 0 ||
    Object.keys(known.noCarousel).length > 0
  )
    save({ ...known, absent: {}, noCarousel: {} });
  const targets = missing();
  if (targets.length === 0) {
    return { started: false, message: "ロゴはすべて集め終えています" };
  }
  /*
   * 空いているチューナーで待っている当たりの中継 (`awaitCarousel`) は畳んで、ここから開き直す。
   * 読みかけは残るので損はしない。閉じたことがエージェントに届く前に空きを訊くので、引き継ぐ (`countFree`)
   */
  const leaving: StreamUse[] = [];
  if (idle !== null) {
    leaving.push(idle.use);
    idle.controller.abort();
  }
  // 空きは**種別ごとに数える** (`freeTuners`)
  const free = new Map<string, number>();
  for (const type of new Set(targets.map((target) => target.type))) {
    free.set(type, await freeTuners(type, leaving));
  }
  if ([...free.values()].every((count) => count === 0)) {
    return { started: false, message: "空いているチューナーがありません" };
  }
  /*
   * 地上波を先に回す。中継ごとに違う局が入っているので、数が捌けるのはこちら。
   * 衛星は**当たりと分かっている中継を外れ探しより先に**開く。外れの控えは上で捨てたので、並びのままだと
   * `BS01:16400` から順に当たり直し、途中でチューナーが塞がると当たりの中継 (`BS15:16625`) まで行き着かない (#1939)
   */
  const carriers = notes().carriers;
  const order = (target: Target) =>
    target.type === "GR" ? 0 : carriers[target.channel] !== undefined ? 1 : 2;
  const ordered = [...targets].sort((a, b) => order(a) - order(b));
  const parallel = Math.min(SWEEP_TUNERS, Math.max(...free.values()));
  // 終わるのは数分後。押した人を待たせず、進み具合は画面へ流す
  void run(ordered, parallel, leaving);
  return {
    started: true,
    message:
      `${targets.length} チャンネルをチューナー ${parallel} 台で集めます。` +
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
 * **取得できた数は「開いた中継で減った数」では数えない。** 1 つの TS に他の中継の局の
 * ロゴが入ってくることがあり (衛星は 1 つの中継に全局ぶん。偽の放送 (`tests/fake`) は
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
 * 局が増える。そういう局は「控えた時刻 0」(何も持っていなかった) とみなす。
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
async function run(
  targets: Target[],
  parallel: number,
  leaving: readonly StreamUse[] = [],
): Promise<void> {
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
    await drain([...targets], parallel, controller.signal, stamps, leaving);
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
          : `${found} 局のロゴを集めました${left > 0 ? ` (まだの局は残り ${left})` : ""}`,
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
 * 数えておかないと「N 局ぶん足りない」という表示が永久に残り、こちらの不具合と
 * 見分けが付かない。
 *
 * **中継にロゴが無いこと (`skipRelay`) では数えない。** CS の 12 中継にはロゴの
 * カルーセルが無いが、CS のロゴは BS の中継から降ってくるので、中継で数えると
 * 取れる局まで「取れません」と出てしまう。
 * カルーセルを読み切った後になお足りない局だけが、本当に取れない局。
 *
 * `satellite` は**衛星でまだ取れていない局の数と、ロゴを積んだ中継** (分かっていなければ null)。
 * 衛星のロゴはダウンロードの期間にしか流れてこず、揃うまで何回か開き直すことがある。黙っていると
 * 止まっているように見えるので、画面で「いつ続きを読むか」を言う
 */
export function stats(): {
  have: number;
  total: number;
  pending: number;
  unavailable: number;
  satellite: { missing: number; carrier: string | null };
} {
  const rows = tunableServices().map((service) => ({
    satellite: service.type !== "GR",
    state: logoState(service.id),
  }));
  const states = rows.map((row) => row.state);
  // 持っていて取り直しを待っているだけの局は数えない。画面ではもうロゴが出ている
  const satellite = rows.filter(
    (row) => row.satellite && row.state === "missing",
  ).length;
  return {
    have: states.filter((state) => state === "have").length,
    total: states.length,
    pending: missing().length,
    unavailable: states.filter((state) => state === "absent").length,
    satellite: {
      missing: satellite,
      carrier: satellite > 0 ? (carrierTarget()?.channel ?? null) : null,
    },
  };
}

/**
 * 局 1 つぶんのロゴの具合。設定の「受信できるチャンネル」の表で局ごとに出す。
 *
 * - `have` … 持っている
 * - `absent` … カルーセルに載っていないと分かった局 (取れない。`stats` の `unavailable`)
 * - `missing` … まだ取れていない
 */
export function logoState(serviceId: number): "have" | "absent" | "missing" {
  if (existsSync(logoPath(serviceId))) return "have";
  return absentFromCarousel(serviceId) ? "absent" : "missing";
}
