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
import { CarouselProgress } from "../ts/logo-dsmcc";
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
 * 画面から求められたとき (`sweepNow`) と、衛星のロゴが足りない間にチューナーが空いているとき
 * (`awaitCarousel`。当たりの中継で待ち、分からなければ外れを1秒ほどで見切りながら探す) だけ。
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
 * 選局を共有するときの上限。向こうの都合でいつ閉じてもおかしくないので短くする
 * (衛星の当たりの中継だけは `SATELLITE_TIMEOUT` まで延ばす。`collect`)。
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
  /**
   * ロゴのカルーセルを積んでいた中継と、そう分かった時刻。チューナーが空いているときに
   * 自分から開くのはここだけ (`awaitCarousel`)。外れを全部当たり直すことはしない
   */
  carriers: Record<string, number>;
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
  if (
    hasLogo === (known.noCarousel[channel] === undefined) &&
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
 * 衛星の中継1つぶんの読みかけ。**閉じても捨てない** (`CarouselProgress`)。
 *
 * `written` も一緒に残す。読みかけには揃ったロゴも入っているので、開き直すたびに同じものを
 * 全局ぶん書き直すことになる (書き込み時刻が進むと、「この取得で取れた局」の数も狂う)
 */
interface Carousel {
  progress: CarouselProgress;
  written: Set<string>;
}

/**
 * 中継ごとの読みかけ。**残すのは当たりの中継だけ** (ロゴを積んでいるのはふつう1中継なので、溜まっても1つ)。
 * 読み切ったら・外れと分かったら捨てる (`collect`)。揃ったまま残すと、1週間後の取り直しで
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
 * 流れてくるTSからロゴを取得する。
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
 * 1回開いてどう終わったか。画面の言い分と、次にいつ開くかを決める。
 *
 * - `done` … 揃った、またはカルーセルを1回ぶん読み切った
 * - `miss` … ロゴを積んでいない中継だった (衛星)
 * - `ranOut` … 上限まで開けていた
 * - `yielded` … 開けたあとで切れた。優先度の高い要求に譲った (エージェントが取り上げた) のがほとんど
 * - `busy` … 開けなかった。空いているチューナーが無い
 * - `stopped` … こちらから止めた (「いますぐ」の押し直しなど)
 */
type Outcome = "done" | "miss" | "ranOut" | "yielded" | "busy" | "stopped";

/**
 * 当たりの中継を自分で開いて、上限 (`SATELLITE_TIMEOUT`) まで待ってもカルーセルを読み切れなかった時刻。
 * 待っても来ないものを、空くたびに開き直さないための控え (`awaitCarousel`)。
 * 譲って切れた回は数えない (読みかけは残っていて、次は続きから読む)
 */
let carouselRanOutAt: number | undefined;

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
 *
 * **衛星のカルーセルは読みかけを残す** (`carousels`)。番組表集めやライブに譲って切れても、
 * 次に開いたときに続きから読む。**当たりの中継と分かったら、共有でも `SATELLITE_TIMEOUT` まで開く** —
 * 十数分に一度しか来ないものを3分で切り上げていると、来る時刻に居合わせる見込みが薄い
 */
async function collect(
  target: Target,
  timeout: number,
  signal?: AbortSignal,
  after: readonly StreamUse[] = [],
): Promise<{ found: number; outcome: Outcome; carrier: boolean }> {
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
  // 外から止められるようにする。衛星に20分かけている最中でも譲れるように
  const give = () => controller.abort();
  signal?.addEventListener("abort", give, { once: true });
  let opened = false;
  /** こちらで見切って閉じた理由。無ければ向こうの都合で切れた */
  let ended: Outcome | null = null;
  const carousel = satellite ? carouselOf(target.channel) : undefined;
  /** ロゴを積んだ中継だったか */
  let carrier = false;
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
    opened = true;
    const feed = watch(target.network_id, carousel);
    for await (const chunk of chunks(stream)) {
      feed(chunk);
      const now = remaining();
      // 全部揃ったら、これ以上開けておく理由がない
      if (now === 0) {
        ended = "done";
        break;
      }
      /*
       * 衛星は揃いきらないことがある (カルーセルに載っていない局がある)。
       * **DII が知らせたロゴのモジュールが全部揃ったら、カルーセルは1回ぶん読み切った**
       * (`carouselRead`)。残っている局は載っていない局なので、そう書き留めて次からは行かない。
       * これが無いと、載っていない局が1つでもあるだけで毎回20分丸ごと待つことになる
       */
      if (satellite && feed.carouselRead) {
        markAbsent();
        ended = "done";
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
        if (!feed.hasSatelliteLogo) {
          ended = "miss";
          break;
        }
        // 当たり。読みかけを残す。共有 (RIDE_TIMEOUT) でも、カルーセルが1回りするまで居る
        if (carousel !== undefined) carousels.set(target.channel, carousel);
        carrier = true;
        if (timeout < SATELLITE_TIMEOUT) {
          clearTimeout(stop);
          stop = expire(SATELLITE_TIMEOUT - (Date.now() - startedAt));
        }
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
  if (carrier && outcome === "ranOut") carouselRanOutAt = Date.now();
  // 共有 (RIDE_TIMEOUT) は短いので、来なかったことの証拠にしない
  if (!satellite && ranOut && timeout >= SWEEP_TIMEOUT)
    markGaveUp(target.channel);
  return { found: before - remaining(), outcome, carrier };
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

/**
 * 共有する選局を選んでいる最中か。合図 (エージェントの `tuners`) は連続して飛んでくるので、
 * 選んでいる間に来たぶんは、選び終えてからもう一度見る (`replan`)。
 * **読むほうは並べる。** 衛星の当たりの中継は20分読むので、1つずつ待っていると、その間に
 * 番組表集めが開いた地上波を共有し損ねる
 */
let planning = false;
let replan = false;

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
  leaving: readonly StreamUse[] = [],
): Promise<void> {
  /** 空きが無くなった種別。**その種別だけ**諦める (衛星の満杯で地上波を止めない) */
  const full = new Set<string>();
  const worker = async (index: number) => {
    /** この手で閉じたばかりの選局。次を開くときに引き継ぐ (`freeTuners`) */
    let left: readonly StreamUse[] = index === 0 ? leaving : [];
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
      const { outcome, carrier } = await collect(target, limit, signal, left);
      const note = carrier ? carouselMessage(target.channel, outcome) : "";
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

/** 当たりの中継が読み切れないまま閉じたときの言い分。それ以外は空 (`run` の締めの言い分を使う) */
function carouselMessage(channel: string, outcome: Outcome): string {
  switch (outcome) {
    case "yielded":
      return `${channel} は番組表集めやライブにチューナーを譲りました。読んだところまでは覚えているので、次に開いたときに続きから読みます`;
    case "ranOut":
      return `${channel} を ${SATELLITE_TIMEOUT / 60_000} 分開きましたが、ロゴは流れてきませんでした`;
    default:
      return "";
  }
}

/**
 * **いま開いている選局を共有して**ロゴを取得する。
 *
 * 番組表集めも録画も、物理チャンネルを丸ごと開く。そこへ同じチャンネルを要求すると
 * **エージェントは新しいチューナーを使わずに選局を共有させる**ので、こちらは只で電波を
 * 読める。空いた時間に自分で開き直すより早く埋まり、チューナーの取り合いも起きない。
 *
 * 合図はエージェントの `tuners`。開いた瞬間に飛んでくるので、閉じるまでの間に読み切る。
 * 相手が先に閉じれば、こちらはいちばん低い優先度で居残るだけで、次に要る人が来たら譲る。
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

      const open = openChannels(await getTuners());
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

/**
 * 当たりの中継を自分で開き直すまでの間隔。上限 (`SATELLITE_TIMEOUT`) まで開けても
 * 読み切れなかったとき (カルーセルが来なかった) にだけ使う。空くたびに20分開き直すと、
 * 来ないもののためにチューナーを1台塞ぎ続けることになる。番組表集めが同じ中継を開く間隔
 * (`EPG_CHANNEL_INTERVAL` の既定) に揃えてある
 */
const CAROUSEL_RETRY = 6 * 60 * 60_000;

/** 自分で開いて待っている当たりの中継。「いますぐ」が押されたら畳んで譲る */
let idle: { use: StreamUse; controller: AbortController } | null = null;

/**
 * **衛星のロゴが足りない間は、空いているチューナーで当たりの中継を開いて待つ。**
 *
 * 共有 (`ride`) だけでは揃わなかった。カルーセルは十数分に一度しか流れてこないのに、
 * 番組表集めがその中継を開くのは6時間に一度、数分だけ。しかもチューナーが2台の衛星では、
 * 番組表集めが次のチャンネルへ移るときに、居残ったロゴの選局を真っ先に取り上げる。
 * 実機の報告では、地上波は揃ったのに BS/CS は何日経っても進まなかった。
 *
 * 待つのは**当たりと分かっている中継だけ** (`carriers`)、**どのチューナーも使っていないとき**だけ、
 * 優先度はいちばん下のまま。録画・ライブ・番組表集めが来れば取り上げられ、読みかけは残る
 * (`CarouselProgress`) ので、次に空いたときに続きから読む。
 *
 * 当たりがまだ分からなければ、確かめていない衛星の中継を順に開いて探す。外れは PAT を見た時点
 * (1秒ほど) で閉じ、1週間は開き直さない (`RELAY_RETRY`)。当たりを控える前のバージョンから
 * 上げたときも、番組表集めがその中継を開くのを何時間も待たずに済む
 */
async function awaitCarousel(): Promise<number> {
  if (missingSatellites() === 0) return 0;
  if (fresh(carouselRanOutAt, CAROUSEL_RETRY)) return 0;
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
    try {
      const result = await collect(
        target,
        SATELLITE_TIMEOUT,
        controller.signal,
        left,
      );
      found += result.found;
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
  return service === undefined
    ? null
    : {
        type: service.type,
        channel: service.channel,
        network_id: service.network_id,
      };
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
    return {
      type: service.type,
      channel: service.channel,
      network_id: service.network_id,
    };
  }
  return null;
}

/**
 * 定期チェック。**ほかの選局を共有する** (`ride`)。
 *
 * 番組表集めは全チャンネルを定期的に開くので、その選局へ混ぜてもらえば只で読める
 * (実機では BS の38局ぶんが局調べの選局を一度共有しただけで揃った)。録画とチューナーを取り合う理由がない。
 *
 * **衛星だけは、足りない間は空いているチューナーで当たりの中継を待つ** (`awaitCarousel`)。
 * 地上波は共有だけで揃う (CDT は数分おきに流れていて、番組表集めが開いている間に来る)。
 * すぐ欲しいときは画面の「ロゴをいますぐ集める」(`sweepNow`) がある。
 */
export async function sweep(): Promise<number> {
  const [shared, waited] = await Promise.all([ride(), awaitCarousel()]);
  return shared + waited;
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
  // 地上波を先に回す。中継ごとに違う局が入っているので、数が捌けるのはこちら
  const ordered = [...targets].sort(
    (a, b) => Number(b.type === "GR") - Number(a.type === "GR"),
  );
  const parallel = Math.min(SWEEP_TUNERS, Math.max(...free.values()));
  // 終わるのは数分後。押した人を待たせず、進み具合は画面へ流す
  void run(ordered, parallel, leaving);
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
 *
 * `satellite` は**衛星でまだ取れていない局の数と、ロゴを積んだ中継** (分かっていなければ null)。
 * 衛星のロゴは十数分に一度しか流れてこず、揃うまで何回か開き直すことがある。黙っていると
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
