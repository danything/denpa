import { type Actions, fail } from "@sveltejs/kit";
import { eq } from "drizzle-orm";

import { SERVICE_TYPE_LABEL } from "#lib/format.js";
import { parseId } from "#lib/id.js";
import { config } from "#lib/server/config.js";
import {
  checkContracts as verifyContracts,
  getContractRows,
  testDecode as testDecodeStream,
  testDecodeUnverified,
} from "#lib/server/contracts.js";
import { orm } from "#lib/server/db.js";
import { recordings } from "#lib/server/schema.js";
import {
  cardStatus,
  getActiveCardId,
  putCardReaders,
} from "#lib/server/scramble.js";
import {
  type AgentTuner,
  putTuners,
  recordingOf,
  type TunerConfig,
  tunerList,
} from "#lib/server/tuner.js";
import { unreceivable } from "#lib/tuner-types.js";
import { ALL_CHANNEL_TYPES } from "#lib/types.js";

/** 画面に出す理由 (`Error:` の前置きを付けない) */
const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface TunerUser {
  use: string;
  priority: number;
  /** 画面に出す言葉 */
  label: string;
}

/**
 * 使っている相手を読める言葉に直す。
 *
 * エージェントが持っているのは用途の印だけで、そこには ASCII しか載せられない
 * (以前は HTTP ヘッダに載せていた名残で、いまも短いままにしてある)。
 * 番組名はここで引き直す。
 */
function describe(use: string): string {
  const recording = recordingOf(use);
  if (recording !== null) {
    const row = orm()
      .select({ name: recordings.name })
      .from(recordings)
      .where(eq(recordings.id, recording))
      .get();
    return row === undefined ? "録画" : `録画: ${row.name}`;
  }

  // 復号できるかを試す選局 (`contracts.decodeOnChannel`)。印にチャンネルが入らないので、括弧を添えない
  if (use === "live test-decode") return "復号の確認";
  for (const [pattern, label] of USE_WORDS) {
    const found = use.match(pattern);
    if (found !== null) return `${label} (${found[1]})`;
  }
  return use;
}

/** 録画のほかの用途の印と、画面の言葉。括弧の中に印のチャンネルを添える (`logo`・`live` の印は `種別/チャンネル` なので、チャンネルだけ) */
const USE_WORDS: [RegExp, string][] = [
  [/^logo \S+\/(\S+)$/, "局ロゴ収集"],
  [/^epg (\S+)$/, "番組表"],
  [/^scan (\S+)$/, "チャンネルスキャン"],
  [/^scan quality (\S+)$/, "受信品質の測定"],
  [/^live \S+\/(\S+)$/, "ライブ視聴"],
];

/**
 * チューナーが足りないときに残る順 (`config.priority` の大きい順) を、画面の言葉で。
 *
 * **数字は画面に出さない。** ルールの「優先度」(0〜9。予約どうしを比べる) と並ぶと、
 * ルールの 2 が番組表の 3 に負けるように読めてしまう (別の物差し)。順番だけ言えば足りる。
 * キーを `config.priority` から取るので、用途を足したら言葉も足さないと型で落ちる
 */
const USE_LABEL: Record<keyof typeof config.priority, string> = {
  recording: "録画",
  live: "ライブ視聴",
  epgNow: "番組表の取得 (「番組表をいますぐ集める」を押したとき)",
  scan: "チャンネルスキャン",
  carousel: "衛星の局ロゴの取得 (ロゴを流す中継で待つとき)",
  epg: "番組表の取得 (ふだん)",
  logo: "局ロゴの取得",
};

function yieldOrder(): string[] {
  return (
    Object.entries(config.priority) as [keyof typeof config.priority, number][]
  )
    .sort((a, b) => b[1] - a[1])
    .map(([use]) => USE_LABEL[use]);
}

function withLabels(
  tuners: AgentTuner[],
): (Omit<AgentTuner, "users"> & { users: TunerUser[] })[] {
  return tuners.map((tuner) => ({
    ...tuner,
    users: tuner.users.map((user) => ({ ...user, label: describe(user.use) })),
  }));
}

export async function load() {
  // 一覧と「自動で見つけた状態か」は同じ答えに入っている。1 度だけ聞く
  const answer = tunerList();
  return {
    /*
     * 定義を書いていないので自動で見つけた状態か。
     *
     * 出さないと「画面の内容がどこから来たのか」が分からない。保存すると
     * それが固定されるので、そこは言っておく必要がある
     */
    detected: answer.then((got) => got.detected === true).catch(() => false),
    /*
     * 以下は相手待ちなので promise のまま返して後から流し込む。
     * 待つと画面が出ない
     *
     * 繋がらなかった理由も一緒に返す。空の一覧だけ渡すと「チューナーが
     * 1 台も無い」と区別が付かない (以前はエージェントの生死を別の行に
     * 出していたが、見るところが増えるだけだった)
     */
    tuners: answer
      .then((got) => ({
        list: withLabels(got.tuners),
        error: null as string | null,
      }))
      .catch((error: unknown) => ({ list: [], error: reason(error) })),
    // チューナーを譲り合う順。チューナーの節の「詳しく」に出す
    yieldOrder: yieldOrder(),
    card: cardStatus(),
    contracts: contractRows().catch(() => []),
  };
}

/** いま使っているカードの契約の一覧 (ダイアログ)。カードが無ければ空 */
async function contractRows() {
  const id = getActiveCardId(await cardStatus());
  return id ? getContractRows(id) : [];
}

export const actions = {
  /** 機材の定義を書き換える。渡すのはデバイスと種別だけ (選局はエージェントが組み立てる) */
  tuners: async ({ request }) => {
    const form = await request.formData();

    /*
     * 行ごとに `name.0` `device.0` … と名前を分けてある。
     *
     * 同じ名前を並べて `getAll()` で読む形だと、チェックの外れた行が
     * 送られてこないぶんだけ番号がずれて、別の行の設定が混ざる
     */
    const rows = new Set<number>();
    for (const key of form.keys()) {
      const match = key.match(/^name\.(\d+)$/);
      if (match !== null) rows.add(Number(match[1]));
    }

    /*
     * 消す行は「⋯」の中の「削除」の 2 回目 (`delete` にその行の番号)。
     * **名前を空にしても消さない**。その場で保存するので、欄を空にして離れただけで
     * チューナーが消えていた。空の名前は断り、画面は元の名前に戻す (`autosave`)
     *
     * **足す欄は番号の代わりに `add` を入れた名前 (`name.add` `type.add.GR` …) にし、「追加」のボタン (`add`) で送ったときだけ読む。**
     * 同じフォームなので、ほかの行を変えたときの保存にも一緒に乗ってくる。番号付きの名前にしていた頃は、
     * 名前だけ打った途中でほかの行を切り替えると、その行まで断られて保存されなかった
     */
    const drop =
      form.get("delete") === null ? null : Number(form.get("delete"));
    // 行の欄を読む。`type.GR` なら `type.<番号>.GR`
    const slot = (at: number | "add") => (field: string) => {
      const [head, ...rest] = field.split(".");
      return form.get([head, at, ...rest].join("."));
    };
    const sources = [...rows]
      .sort((a, b) => a - b)
      .filter((index) => index !== drop)
      .map((index) => slot(index));
    if (form.get("add") !== null) sources.push(slot("add"));

    /*
     * 機材が受けられる種別 (デバイスごと。保存する先と同じ並びの先頭のエージェントのもの)。画面は受けられない種別を選ばせないが、ここでも同じものと突き合わせて断る。
     * エージェントに聞けなければ突き合わせない (送るところで同じく繋がらずに断られる)
     */
    const receivable = new Map(
      (
        await tunerList().then(
          (list) => list.tuners,
          (): AgentTuner[] => [],
        )
      ).flatMap((tuner): [string, AgentTuner["receivable"]][] =>
        tuner.device === null ? [] : [[tuner.device, tuner.receivable]],
      ),
    );

    const tuners: TunerConfig[] = [];
    for (const get of sources) {
      const name = String(get("name") ?? "").trim();
      if (name === "") return fail(400, { message: "名前は空にできません" });

      // CATV と SKY の欄は受信の設定に並べたときだけ来る (`extraTypes`)
      const types = ALL_CHANNEL_TYPES.filter(
        (type) => get(`type.${type}`) !== null,
      );
      if (types.length === 0) {
        return fail(400, {
          message: `${name}: 受信できる種別を 1 つ以上選んでください。使わないなら「使う」をオフにしてください`,
        });
      }
      const device = String(get("device") ?? "").trim();
      if (device === "")
        return fail(400, {
          message: `${name}: デバイスのパスを入れてください`,
        });
      // 「使う」をオフにした台は選局に使わないので突き合わせない (受けられない種別が入ったままでもオフにして保存できる)
      const refused =
        get("use") === null ? [] : unreceivable(types, receivable.get(device));
      if (refused.length > 0) {
        return fail(400, {
          message: `${name}: ${refused.map((type) => `「${SERVICE_TYPE_LABEL[type]}」`).join("")}を受信できません`,
        });
      }

      tuners.push({
        name,
        types,
        device,
        lnb: String(get("lnb") ?? "").trim() || null,
        // スイッチは「使う」。外れていれば送られてこない (足す欄は隠し欄でいつも使う)
        disabled: get("use") === null,
      });
    }

    return await save(tuners);
  },

  /** 定義を消して自動検出に戻す。挿さっている機材をエージェントが自分で見つける */
  tunersAuto: () => save([]),

  /**
   * 使わないカードリーダーを入れ替える。行ごとに `reader.<番号>` にリーダーの名前、`reader-use.<番号>` にスイッチ
   * (外れていれば送られてこない)。使う最後の 1 台をオフにする聞き返しは画面でする (`Tuners.svelte`)
   */
  cards: async ({ request }) => {
    const form = await request.formData();
    const disabled: string[] = [];
    for (const [key, value] of form.entries()) {
      const match = key.match(/^reader\.(\d+)$/);
      if (match === null || typeof value !== "string") continue;
      if (form.get(`reader-use.${match[1]}`) === null) disabled.push(value);
    }
    try {
      await putCardReaders(disabled);
    } catch (error) {
      return fail(502, {
        message: `カードリーダーの設定をエージェントへ送れませんでした: ${reason(error)}`,
      });
    }
    return { success: true };
  },

  /** B-CAS カード内の CA 契約情報を確認し、各有料局の契約・有効期限を更新する */
  checkContracts: async () => {
    try {
      const rows = await verifyContracts();
      return { success: true, contracts: rows };
    } catch (error) {
      return fail(500, {
        message: `カードの契約を確かめられませんでした: ${reason(error)}`,
      });
    }
  },

  /** 対象の局のストリームを数秒開いて、復号できるかを試す */
  testDecode: async ({ request }) => {
    const form = await request.formData();
    const serviceId = parseId(form.get("serviceId"));
    if (serviceId === null || serviceId < 1) {
      return fail(400, { message: "serviceId が不正です" });
    }
    try {
      const result = await testDecodeStream(serviceId);
      if (!result.ok) {
        return fail(500, {
          message:
            result.error === undefined
              ? "この局で復号を試せませんでした"
              : `この局で復号を試せませんでした: ${result.error}`,
        });
      }
      return {
        success: true,
        decodeOk: result.decodeOk,
        contracts: await contractRows(),
      };
    } catch (error) {
      return fail(500, {
        message: `この局で復号を試せませんでした: ${reason(error)}`,
      });
    }
  },

  /** 確かめていない有料の局を、物理チャンネルごとに 1 回の選局でまとめて確かめる */
  testDecodeUnverified: async () => {
    try {
      const result = await testDecodeUnverified();
      if (!result.ok) {
        return fail(500, {
          message: `復号を確かめられませんでした: ${result.error}`,
        });
      }
      const all = [...result.results.values()];
      return {
        success: true,
        tested: all.filter((one) => one.ok).length,
        skipped: all.filter((one) => !one.ok).length,
        contracts: await contractRows(),
      };
    } catch (error) {
      return fail(500, {
        message: `復号を確かめられませんでした: ${reason(error)}`,
      });
    }
  },
} satisfies Actions;

/** 定義をエージェントへ送る。画面はその場で保存して、見出しの横に「保存しました」を出す (`autosave`)。通知は出さない */
async function save(tuners: TunerConfig[]) {
  try {
    await putTuners(tuners);
  } catch (error) {
    return fail(502, {
      message: `チューナーの設定をエージェントへ送れませんでした: ${reason(error)}`,
    });
  }
  return { success: true };
}
