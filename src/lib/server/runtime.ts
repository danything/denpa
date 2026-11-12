import { mkdirSync } from "node:fs";

import { SOCKET_PATH } from "#lib/live.js";

import { listen } from "./agent-events";
import {
  type Agent,
  listAgents,
  syncEnvAgentsOnBoot,
  tuningAgents,
} from "./agents";
import { warnIfClosed, warnIfProxyHidden } from "./auth";
import { config } from "./config";
import { pruneCodes } from "./device-auth";
import { checkDisk } from "./disk";
import { pump, requeueOrphanedJobs } from "./encoder";
import { readChannels, sync, syncServicesOnly } from "./epg";
import { collectOnce } from "./epg-collect";
import { emit } from "./events";
import { pruneHistory, reconcile } from "./files";
import { probe } from "./hwenc";
import { attend } from "./live";
import { reconcile as logoReconcile, ride, sweep } from "./logo";
import { checkPower, forgetWake } from "./power";
import { activeRecordingIds, recoverOrphanedRecordings } from "./recorder";
import { restoreWidths } from "./restore-width";
import { fillSatellites } from "./satellite-lineup";
import { recheckContracts, tick } from "./scheduler";
import { prune as pruneSessions } from "./session";
import { beginDraining } from "./shutdown";
import { redeem } from "./tickets";
import { pruneTransfer, swapAtBoot } from "./transfer";
import { checkForUpdate } from "./update";
import { notify } from "./webhook";
import { serve } from "./ws";

let started = false;
/** スリープの様子を見る間隔 (ms。power.ts)。起こしてから録画を始めるまで (`WAKE_LEAD`。3 分) より十分短くする */
const POWER_CHECK = 30_000;
const timers: ReturnType<typeof setInterval>[] = [];
/** エージェントごとの通知の購読を止めるもの */
let unlisten: (() => void)[] = [];

async function guard(
  name: string,
  fn: () => Promise<unknown> | unknown,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    // ループを止めないことが最優先。次の周回で自然に復帰する
    console.error(`[${name}] ${error}`);
  }
}

function every(
  ms: number,
  name: string,
  fn: () => Promise<unknown> | unknown,
): void {
  const timer = setInterval(() => void guard(name, fn), ms);
  // このタイマーのためにイベントループを生かしておく必要はない
  timer.unref?.();
  timers.push(timer);
}

/** いま 1 回走らせて、あとは `every` と同じ */
function nowAndEvery(
  ms: number,
  name: string,
  fn: () => Promise<unknown> | unknown,
): void {
  void guard(name, fn);
  every(ms, name, fn);
}

export function start(): void {
  if (started) return;
  started = true;

  /*
   * **取り込んだ DB に入れ替える** (設定の「連携」の「denpa を別の機械へ移す」。transfer.ts)。
   * DB とロゴに触る前にやる。取り込みはプロセスを終えて、ここで入れ替わる。
   * **入れ替えられなければ起動を止める。** 入れ替えかけのまま動くより、起き直してやり直すほうがよい
   * (何度やっても同じ結果になる作り)
   */
  try {
    swapAtBoot();
  } catch (error) {
    console.error(
      `[transfer] 取り込んだ DB に入れ替えられませんでした: ${error}`,
    );
    throw error;
  }

  /*
   * 前のバージョンの置き場の変数は読まない (docs/config.md「置き場を変えた」)。黙って既定に変わると
   * 空の置き場を見て「録画が全部消えた」ように見えるので、残っていたら言う
   */
  for (const old of ["RECORDED_DIR", "LIBRARY_DIR"]) {
    if (process.env[old]) {
      console.warn(
        `[boot] ${old} はもう読みません。RAW_DIR / ENCODED_DIR か MEDIA_DIR に書き直してください`,
      );
    }
  }
  mkdirSync(config.rawDir, { recursive: true });
  mkdirSync(config.encodedDir, { recursive: true });

  /*
   * **`TUNER_AGENT_URL` と DB の `agents` を突き合わせる** (agents.ts)。環境変数から消したエージェントの行はここで消える。
   * 読めない書き方なら起動は止めず、エージェントを呼ぶたびに同じ誤りを返す
   */
  syncEnvAgentsOnBoot();

  /*
   * **ログインする方法が無ければ、無いことを起動ログに出す。** 何も設定していなければ
   * 全アクセスを断る作り (auth.configured) なので、閉まっていること自体は安全だが、
   * 気付けないと「なぜか入れない」にしか見えない。
   *
   * `DENPA_AUTOSTART=0` でも出すように、バックグラウンド処理より先に呼ぶ
   */
  warnIfClosed();
  // 前段と同じネットワークを信頼していそうなら知らせる (auth.sharedNetworks)
  warnIfProxyHidden();

  /*
   * **GPU でエンコードできるか、ffmpeg に確かめさせておく** (hwenc.ts)。数秒かかるので
   * 待たずに進む。設定画面は終わるまで「確認中」を出し、エンコードするときは
   * そのとき分かっている範囲で決める。触るのは ffmpeg だけでチューナーには行かないので、
   * `DENPA_AUTOSTART=0` でも回す
   */
  void probe();

  /*
   * **ライブ視聴のエンドポイントを開ける。** ここは `DENPA_AUTOSTART=0` でも開ける。
   * 押されたときだけ動くもので、勝手にチューナーを使いはしない。
   *
   * 認証は使い捨てのチケットで見る。ブラウザは WebSocket のハンドシェイクに `Authorization` を
   * 付けてくれないので、画面が先に `/api/live/ticket` から取ってくる (`tickets.ts`)
   */
  serve(SOCKET_PATH, {
    // **ハンドシェイクより前に見る。** ここで断れば普通の HTTP で理由を返せる
    accept: (url) => redeem(url.searchParams.get("ticket")),
    open: (connection) => attend(connection),
  });

  const recovered = recoverOrphanedRecordings();
  const orphanedJobs = requeueOrphanedJobs();
  if (recovered.resumed > 0 || recovered.failed > 0 || orphanedJobs > 0) {
    console.log(
      `[boot] 前回の異常終了を回収: 録画 ${recovered.resumed} 件を再開 / ` +
        `${recovered.failed} 件を失敗扱い / エンコード ${orphanedJobs} 件を再投入`,
    );
  }
  installShutdownHooks();

  /*
   * **新しいバージョンが出ていないか、GitHub を見に行く** (update.ts)。起動時に 1 回と
   * `UPDATE_CHECK_INTERVAL` (既定 1 時間) おき。チューナーには行かないので `DENPA_AUTOSTART=0` でも回す
   */
  nowAndEvery(config.updateCheckInterval, "update", checkForUpdate);

  if (!config.autostart) {
    console.log(
      "[boot] DENPA_AUTOSTART=0 のためバックグラウンド処理は起動しません",
    );
    return;
  }

  /*
   * 局を取り込んで、溜まっている番組表で予約を組み直す。
   * 局の一覧はエージェントが持っている (スキャンの結果) ので、そこから取る
   */
  void guard("epg", sync);
  nowAndEvery(config.channelSyncInterval, "services", syncChannels);

  /*
   * **番組表を自分で集める。**
   * チューナーが空いているだけ並列に回し、薄い局から先に行く (epg-collect.ts)。
   * 起動直後に 1 回走らせるので、初回は数分で番組表が出る
   */
  nowAndEvery(config.epgCollectInterval, "epg-collect", collectOnce);

  listenToAgents();

  every(config.schedulerTick, "scheduler", async () => {
    await tick();
    pump();
  });

  /*
   * **Windows と Mac では、録画・視聴・エンコードの間スリープさせず、次の録画の前にスリープから起こす** (power.ts)。
   * ほかの OS では何もしない
   */
  nowAndEvery(POWER_CHECK, "power", checkPower);

  /*
   * 実体と DB を突き合わせ、外から消されたものを一覧から落とす。
   *
   * inotify (fs.watch) で消した瞬間に気づけないか試したが、この構成では
   * 最初の 1 件しかイベントが来ず当てにできなかったので定期実行にしてある。
   * すぐ反映したいときは画面の「ファイルと照合」を押す。
   */
  nowAndEvery(config.reconcileInterval, "reconcile", reconcile);

  /*
   * ディスク残量を定期的に確かめる。埋まると始まる録画が片っ端から失敗するので、
   * 下回ったところで知らせる (disk.ts)。照合と同じ周期でよい
   */
  nowAndEvery(config.reconcileInterval, "disk", checkDisk);

  /*
   * 古い履歴を畳む。終わった予約と、消した録画の行が対象。
   * 実体はもう無いので、消えて困るものはない。照合と同じ周期でよい
   */
  nowAndEvery(config.reconcileInterval, "prune", pruneHistory);
  // 送りかけのまま放っておかれた取り込みも、同じ周期で片付ける (transfer.ts)
  nowAndEvery(config.reconcileInterval, "transfer", pruneTransfer);

  /*
   * 番組名を半角に寄せて取り込んでいた頃の録画を、元の TS の EIT から放送のとおりの幅に戻す
   * (restore-width.ts)。見た録画は覚えるので、2 回目からは録り終えた新しいぶんだけ見る
   */
  nowAndEvery(config.reconcileInterval, "restore-width", async () => {
    const result = await restoreWidths();
    if (result.restored > 0 || result.missed > 0) {
      console.log(
        `[restore-width] 録画 ${result.seen} 件を見ました: 元の TS から戻した ${result.restored} 件 / ` +
          `もとから放送のとおり ${result.already} 件 / 戻せなかった ${result.missed} 件`,
      );
    }
  });

  /*
   * 切れたログインの控えを片付ける。**入れなくなる人はいない。** 切れたものは
   * 読む側 (`session.find`) が既に無視しているので、消しているのは行だけ
   */
  nowAndEvery(config.reconcileInterval, "sessions", pruneSessions);
  // 切れたペアリングコードも同じく (device-auth.ts)
  nowAndEvery(config.reconcileInterval, "device-codes", pruneCodes);

  /*
   * 局ロゴ。放送波から取得するしかないので、持っていない局のぶんを少しずつ取得する。
   * ふだんは開いている選局を共有するので、チューナーは増えない (衛星のロゴが足りない間だけ、空いている
   * チューナーで当たりの中継を開いて待つ。`logo.awaitCarousel`)
   *
   * 起動のたびに、印 (`has_logo`) とファイルを突き合わせ直す。置き場ごと
   * 消えることは実際にあり、印だけ残っていると番組表に壊れた画像が並ぶ
   */
  void guard("logo", () => logoReconcile(true));
  every(config.logoSweepInterval, "logo", sweep);
}

/**
 * 局の一覧をエージェントから取り込む。**BS / CS が無ければ、そのついでに放送の一覧から入れる**
 * (satellite-lineup.ts)。一覧は 1 回だけ読んで両方に使う。エージェントが後から起きても、
 * 次の周期 (`CHANNEL_SYNC_INTERVAL`、既定 1 分) で入る。放送の一覧を読むのは数十秒かかるので待たない
 */
async function syncChannels(): Promise<void> {
  const read = await readChannels();
  syncServicesOnly(read);
  // 放送の一覧から入れるかは、選局に使うエージェント (`tuningAgents` の先頭) の控えで決める。読めなかった回は見送る
  const tuning = tuningAgents()[0]!.id;
  const channels = read.find((r) => r.agent === tuning)?.channels;
  if (channels === undefined) return;
  void fillSatellites(channels).catch((error: unknown) => {
    console.warn(`[channels] 衛星の局を入れられませんでした: ${error}`);
  });
}

/** 呼ばれてから `ms` 置いて `run` を 1 回呼ぶ。待っている間に呼ばれた分はまとめる */
export function settleThen(ms: number, run: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      run();
    }, ms);
    timer.unref?.();
  };
}

/**
 * カードが契約の更新 (EMM) を受け入れたという通知 (`card`) から、契約を確かめ直すまでの間 (ms)。
 * 1 回の受信で個別とグループの EMM を続けて受け入れることがあり (エージェントは 1 秒に 1 件ずつ渡す)、それを 1 回にまとめる
 */
const CARD_SETTLE_MS = 10_000;
const recheckAfterCard = settleThen(
  CARD_SETTLE_MS,
  () => void recheckContracts(),
);

/**
 * 全部のエージェントからの通知を受け取る (agent-events.ts。1 台に 1 つずつ繋ぐ)。上の定期実行は、通知が途切れたときの保険として残す。
 * 読めない `TUNER_AGENT_URL` のときは繋がない (起動は止めない。`start` の突き合わせと同じ)
 */
function listenToAgents(): void {
  let all: Agent[];
  try {
    all = listAgents();
  } catch (error) {
    console.error(
      `[agent] 通知を購読できません: ${error instanceof Error ? error.message : error}`,
    );
    return;
  }
  unlisten = all.map((agent) => listenToAgent(agent));
}

function listenToAgent(agent: Agent): () => void {
  return listen(
    agent,
    (event) => {
      switch (event.name) {
        case "tuners":
          emit("tuners");
          /*
           * 誰かがチューナーを開いた、かもしれない。そこへ同じチャンネルを
           * 要求するとエージェントが選局を共有させるので、チューナーを増やさずにロゴを読める。
           * 開いた瞬間に来る通知なので、ここで共有する
           */
          void guard("logo", ride);
          break;
        case "channels":
          /*
           * スキャンで局が入れ替わった。このエージェントの控えだけ取り込み直して (ほかのエージェントは前の写しのまま)、番組表も取得し直す。
           * 局の取り込み (`sync`) が先。取得は全チャンネルで数分かかるので、局の一覧と予約はそれを待たずに変える
           * (取得も始めに局を取り込むので、`POST /api/sync` は逆の順で同じ結果になる)
           */
          void guard("epg", async () => {
            await sync(agent);
            await collectOnce();
          });
          break;
        case "card":
          /*
           * カードが契約の更新を受け入れた。番組表に契約の情報がある局は、カードに聞き直すと
           * 更新後の状態と期限が入る (12 時間ごとの確かめ直しを待たない)
           */
          console.log(
            "[contracts] カードが契約の更新を受け入れました。10 秒後に契約を確かめ直します",
          );
          recheckAfterCard();
          break;
        default:
          break;
      }
    },
    // エージェントに繋がらない状態が続いたら知らせる。黙って落ちても、
    // 次の録画が失敗するまで気付けなかったのを埋める (agent-events.ts が切り替えを判定)
    (up) => {
      if (up) {
        console.log(`[agent] ${agent.name} に繋がりました`);
        notify({
          event: "agent.up",
          text: `エージェント「${agent.name}」に繋がりました`,
        });
      } else {
        console.error(`[agent] ${agent.name} に繋がりません`);
        notify({
          event: "agent.down",
          text: `エージェント「${agent.name}」に繋がりません。このエージェントのチューナーでは録画できません`,
        });
      }
    },
  );
}

function stop(): void {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
  for (const off of unlisten) off();
  unlisten = [];
  // Mac: 録画の前に起こす予約を取り消す (止まった本体のために起こさない。power.ts)
  forgetWake();
  started = false;
}

/** 入口 (`server.js`) が見る名前。あちらと揃えること */
const TAKE_OVER = "__denpaTakeOverSignals";
/** 入口が読む `hold-signals.ts` が、起動の途中に来た合図を置く名前。あちらと揃えること */
const HELD = "__denpaHeldSignal";

/**
 * Pod の入れ替えなどで止められたときの後始末。
 *
 * **録画中は、終わるまで待ってから止まる。** 追記で開いているので落ちても
 * 次の起動で続きから録れるが、入れ替わるまでの十数秒はどうやっても落ちる。
 * ArgoCD の同期は待てるが、放送は待ってくれない。
 *
 * **待っている間も、始まる録画は始める** (`scheduler.ts`)。始めないでいた頃は、
 * 待っている間に始まる番組の先頭が丸ごと落ちていた。そのぶん待つ時間は伸びるが、
 * Pod はどのみち残っているので、新しく待たせるものは無い。
 * エンコードは待たない (再起動でやり直せる)。
 *
 * 待つのをやめる上限が `SHUTDOWN_WAIT`。0 にすると待たずに止まる。
 * **Kubernetes 側の `terminationGracePeriodSeconds` と docker compose の
 * `stop_grace_period` を、これ以上に伸ばしておくこと。** 伸ばさないと、
 * 待っている途中で SIGKILL され、待った意味が無くなる。
 */
function installShutdownHooks(): void {
  /*
   * **畳むのは 1 度だけ。** 引き取りは 2 度ある (下) ので、`takeOverSignals` の中の印だけでは
   * 1 度目の引き取りのあとに受けた合図と、2 度目のあとに受けた合図で 2 度畳みかねない
   */
  let draining = false;
  /*
   * **落ちても降りる。** `drain` の中で投げると、`void` で捨てているぶん
   * 誰も受け止めず、**プロセスが生きたまま残る** = 入れ替えが止まる。
   * 受け止めて、使っているものだけ放して降りる
   */
  const onSignal = (signal: NodeJS.Signals) => {
    if (draining) return;
    draining = true;
    drain(signal).catch((error) => {
      console.warn(`[boot] 停止の途中で失敗しました: ${error}`);
      process.exit(0);
    });
  };
  const take = () => takeOverSignals(onSignal);
  take();
  /*
   * **もう一度、あとから引き取り直す。** adapter-bun が後始末を登録するのは
   * `build/index.js` の**いちばん最後**で、こちら (`hooks.server.ts`) はその手前なので、
   * 最初の引き取りでは外す相手がまだいない (外す理由は `takeOverSignals`)。
   * 入口の `server.js` が `build/index.js` を読み終えたところで呼ぶ。
   * `setImmediate` では足りない。adapter はアプリの初期化を `await` してから登録するので、
   * 先に走ることがありうる。
   */
  (globalThis as Record<string, unknown>)[TAKE_OVER] = (): number => {
    const taken = take();
    if (taken > 0)
      console.log(`[boot] 停止のシグナルを引き取りました (${taken} 件)`);
    return taken;
  };
}

/**
 * 停止のシグナルを**こちらで受け取る**。先に入っていた後始末は外す。
 *
 * 外す相手は adapter (adapter-bun。前は adapter-node) で、SIGTERM を受けた**その場で listen を閉じる**。
 * 両方残すと、録画が終わるのを待っている間、プロセスは生きているのにポートだけ
 * 閉じて画面がどこからも開けなかった (実機で 34 分。`/proc/net/tcp` に listen が
 * 1 つも無く、当時の前段 (Traefik) は「no available server」)。
 *
 * 落とすのはこちらの `drain` の最後で `process.exit` するときだけにする。
 * 開いている応答は切れるが、これは今までと同じ (以前も待たずに exit していた)。
 *
 * **外れたかどうかは数で分かる。** 0 なら相手がまだ登録していないので、
 * 呼ぶ側があとでもう一度引き取る (`installShutdownHooks`)。
 *
 * **2 度目の合図でも落ちないようにする。** `once` にしていた頃は、1 度目で
 * 自分の後始末が外れ、2 度目は**誰も聞いていない**状態になっていた。そこへ
 * デプロイがもう一度走ると、録画の途中でも既定どおりその場で終わる。
 *
 * **自分を先に入れてから、ほかを外す。** 外してから入れると、そのすき間は誰も聞いていない。
 * PID 1 (コンテナ) では、そこへ来た合図は捨てられる (`hold-signals.ts`)。
 *
 * **起動の途中に来た合図を受け直す。** 入口の `hold-signals.ts` が取っておいたものがあれば、
 * 引き取ったところで受けたことにする。録画があれば待ち、無ければすぐ止まる (いつもと同じ)
 */
export function takeOverSignals(
  onSignal: (signal: NodeJS.Signals) => void,
): number {
  let taken = 0;
  let draining = false;
  const receive = (signal: NodeJS.Signals) => {
    // もう畳んでいる最中。2 度目からは受け取るだけで何もしない
    if (draining) return;
    draining = true;
    onSignal(signal);
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const others = process.listeners(signal);
    process.on(signal, () => receive(signal));
    for (const other of others) process.removeListener(signal, other);
    taken += others.length;
  }
  const global = globalThis as Record<string, unknown>;
  const held = global[HELD];
  if (held === "SIGTERM" || held === "SIGINT") {
    delete global[HELD];
    receive(held);
  }
  return taken;
}

/** 5 秒ごとに様子を見る。録画は分単位なので、これ以上細かく見ても意味が無い */
const DRAIN_CHECK = 5000;
/** 待っている間、これだけおきに「まだ待っている」と残す (ms) */
const DRAIN_REPORT = 60_000;

/**
 * 何があっても降りる。**降り損ねを「ぶら下がったまま」にしない。**
 *
 * 実機で、消しはじめられた Pod が **40 分たっても降りてこない**ことがあった
 * (録画はとうに終わり、`activeRecordingIds()` も 0、SIGTERM は捕まえていて
 * `/proc/1/status` の `SigCgt` に 15 が立っている。それでも生きている)。
 * こうなると `terminationGracePeriodSeconds` (6 時間) を使い切るまで
 * **新しい Pod が上がらない**。Recreate なので、その間ずっと古いまま。
 *
 * 待つループを回す前に**先に目覚ましを掛ける**。ループの中で何が起きても、
 * `SHUTDOWN_WAIT` を過ぎたら降りる。原因が分からなくても、
 * 「入れ替えが 6 時間止まる」だけは起こさない
 */
function forceExitAfter(ms: number, why: string): void {
  const timer = setTimeout(() => {
    console.warn(`[boot] ${why}。これ以上待たずに停止します`);
    try {
      stop();
    } catch (error) {
      console.warn(`[boot] 後始末に失敗しました: ${error}`);
    }
    process.exit(0);
  }, ms);
  // 目覚ましそのものがプロセスを生かし続けないように
  timer.unref?.();
}

async function drain(signal: string): Promise<void> {
  /*
   * **まず残す。** 何をしているかを先に書いておかないと、この先で躓いたときに
   * 「合図を受け取ったのかどうか」すら分からない。実際、降りてこない Pod を
   * 調べたときに、記録から読み取れることが何も無かった
   */
  const recordings = activeRecordingIds().length;
  console.log(`[boot] ${signal} を受けました (録画 ${recordings} 件)`);

  if (config.shutdownWait <= 0 || recordings === 0) {
    stop();
    process.exit(0);
  }

  // ループを回す前に掛ける。**この先で何が起きても降りる**
  forceExitAfter(config.shutdownWait, "待ち時間を使い切りました");

  beginDraining();
  console.log(`[boot] 録画が終わるまで待ちます (この間も画面は開けます)`);

  const until = Date.now() + config.shutdownWait;
  let reported = Date.now();
  while (activeRecordingIds().length > 0 && Date.now() < until) {
    await Bun.sleep(DRAIN_CHECK);
    // **黙って待たない。** 何を待っているのかが分からないと、外からは固まって見える
    if (Date.now() - reported >= DRAIN_REPORT) {
      reported = Date.now();
      console.log(
        `[boot] まだ待っています (録画 ${activeRecordingIds().length} 件)`,
      );
    }
  }

  const left = activeRecordingIds().length;
  if (left > 0) {
    console.warn(
      `[boot] 待ち時間を使い切りました。録画 ${left} 件を残して停止します`,
    );
  } else {
    console.log("[boot] 録画が終わったので停止します");
  }
  stop();
  process.exit(0);
}
