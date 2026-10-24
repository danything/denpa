import { type Actions, fail } from "@sveltejs/kit";
import { eq } from "drizzle-orm";

import { config } from "#lib/server/config.js";
import { orm } from "#lib/server/db.js";
import { recordings } from "#lib/server/schema.js";
import { cardStatus } from "#lib/server/scramble.js";
import {
  type AgentTuner,
  putTuners,
  type TunerConfig,
  tunerList,
} from "#lib/server/tuner.js";
import { CHANNEL_TYPES } from "#lib/types.js";

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
  const recording = use.match(/^rec (\d+)$/);
  if (recording !== null) {
    const row = orm()
      .select({ name: recordings.name })
      .from(recordings)
      .where(eq(recordings.id, Number(recording[1])))
      .get();
    return row === undefined ? "録画" : `録画: ${row.name}`;
  }

  for (const [pattern, label] of USE_WORDS) {
    const found = use.match(pattern);
    if (found !== null) return `${label} (${found[1]})`;
  }
  return use;
}

/** 録画のほかの用途の印と、画面の言葉。括弧の中に印のチャンネルを添える */
const USE_WORDS: [RegExp, string][] = [
  [/^logo \S+\/(\S+)$/, "局ロゴ収集"],
  [/^epg (\S+)$/, "番組表"],
  [/^scan (\S+)$/, "チャンネルスキャン"],
  [/^live (\S+)$/, "ライブ視聴"],
];

/**
 * チューナーが足りないときに残る順 (`config.priority` の大きい順) を、画面の言葉で。
 *
 * **数字は画面に出さない。** ルールの「優先度」(0〜9。予約どうしを比べる) と並ぶと、
 * ルールの 2 が番組表の 3 に負けるように読めてしまう (別の物差し)。順番だけ言えば足りる。
 * 鍵を `config.priority` から取るので、用途を足したら言葉も足さないと型で落ちる
 */
const USE_LABEL: Record<keyof typeof config.priority, string> = {
  recording: "録画",
  live: "ライブ視聴",
  epgNow: "番組表の取得 (「番組表をいますぐ集める」を押したとき)",
  scan: "チャンネルスキャン",
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
  // 一覧と「自動で見つけた状態か」は同じ答えに入っている。1度だけ聞く
  const answer = tunerList();
  return {
    /*
     * 定義を書いていないので自動で見つけた状態か。
     *
     * 出さないと「画面の内容がどこから来たのか」が分からない — 保存すると
     * それが固定されるので、そこは言っておく必要がある
     */
    detected: answer.then((got) => got.detected === true).catch(() => false),
    /*
     * 以下は相手待ちなので promise のまま返して後から流し込む。
     * 待つと画面が出ない
     *
     * 繋がらなかった理由も一緒に返す。空の一覧だけ渡すと「チューナーが
     * 1台も無い」と区別が付かない (以前はエージェントの生死を別の行に
     * 出していたが、見るところが増えるだけだった)
     */
    tuners: answer
      .then((got) => ({
        list: withLabels(got.tuners),
        error: null as string | null,
      }))
      .catch((error: unknown) => ({ list: [], error: String(error) })),
    // チューナーを譲り合う順。チューナーの節の「詳しく」に出す
    yieldOrder: yieldOrder(),
    card: cardStatus(),
  };
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
     * **名前を空にしても消さない** — その場で保存するので、欄を空にして離れただけで
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

    const tuners: TunerConfig[] = [];
    for (const get of sources) {
      const name = String(get("name") ?? "").trim();
      if (name === "") return fail(400, { message: "名前は空にできません" });

      const types = CHANNEL_TYPES.filter(
        (type) => get(`type.${type}`) !== null,
      );
      if (types.length === 0) {
        return fail(400, {
          message: `${name}: 受信できる種別を1つ以上選んでください`,
        });
      }
      const device = String(get("device") ?? "").trim();
      if (device === "")
        return fail(400, {
          message: `${name}: デバイスのパスを入れてください`,
        });

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

  /** 定義を消して自動検出に戻す。刺さっている機材をエージェントが自分で見つける */
  tunersAuto: () => save([]),
} satisfies Actions;

/** 定義をエージェントへ送る。画面はその場で保存して、見出しの横に「保存しました」を出す (`autosave`)。通知は出さない */
async function save(tuners: TunerConfig[]) {
  try {
    await putTuners(tuners);
  } catch (error) {
    return fail(502, { message: String(error) });
  }
  return { success: true };
}
