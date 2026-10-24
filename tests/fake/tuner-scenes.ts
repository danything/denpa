/**
 * **チューナーの選び方の場面。エージェントと denpa の両方のテストが同じものを読む。**
 *
 * どのチューナーを使うかはエージェントが決め、denpa はその決まりを前提に予約を割り振る
 * (`src/lib/server/conflict.ts`)。決まりの中身はエージェントだけが持ち、両者の間にあるのは
 * 約束 (docs/agent.md「選ぶ順の約束」) だけ。片方だけ変わって食い違ったら、どちらかが落ちる:
 *
 * - `agent/conformance.test.ts` は本物のエージェントに開かせて、入ったチューナーの `rank` を見る
 * - `src/lib/server/conflict.test.ts` は denpa のなぞり方 (`placements`) で同じ答えになるかを見る
 *
 * 偽の放送にいるのは地上波 T16・T21、衛星 BS11_0・BS03_0 だけ (`tests/fake/services.ts`)。
 */

export interface SceneTuner {
  name: string;
  types: string[];
  /** エージェントが返すはずの順位 (`GET /denpa/tuners` の `rank`) */
  rank: number;
}

export type SceneStep =
  /**
   * 開く。`rank` は入るはずのチューナーの順位、null なら断られる (409)。
   * `after` は引き継ぐ利用者 (もう離れたものとして選ぶ)。`ended` は、この選局で正常に
   * 終わらされるはずの利用者 (引き継いだ相手)。denpa から見ると `after` の利用者はこの時点で離れている
   */
  | {
      open: string;
      type: string;
      channel: string;
      priority: number;
      rank: number | null;
      after?: string[];
      ended?: string[];
      /** `after` に挙げたが、選ばれなかったチューナーにいるので読み続けているはずの利用者 */
      kept?: string[];
    }
  /** 読むのをやめる */
  | { close: string };

export interface Scene {
  name: string;
  tuners: SceneTuner[];
  steps: SceneStep[];
}

/** 録画の優先度 (`config.priority.recording`)。denpa が割り振るのはこれだけ */
export const RECORDING = 10;

/** 録画として開く */
const rec = (
  open: string,
  type: string,
  channel: string,
  rank: number | null,
  more: { after?: string[]; ended?: string[]; kept?: string[] } = {},
): SceneStep => ({ open, type, channel, priority: RECORDING, rank, ...more });

/** いちばんよく使う組。兼用 (順位 1) と地上波専用 (順位 0) */
const MLT9_GR9: SceneTuner[] = [
  { name: "mlt9", types: ["GR", "BS", "CS"], rank: 1 },
  { name: "gr9", types: ["GR"], rank: 0 },
];

export const scenes: Scene[] = [
  {
    /*
     * Issue #668 のケース1。順どおりに選ぶので、先の予定は見ない。
     * T16 を兼用、T21 を専用に入れていれば録れたが、エージェントはそうしない
     * (denpa は、そうしないことを前提に予約を割り振る)
     */
    name: "空いていて受けられるチューナーのうち、順位のいちばん前を使う。先の予定は見ない",
    tuners: MLT9_GR9,
    steps: [
      rec("a", "GR", "T16", 0),
      rec("b", "GR", "T21", 1),
      // gr9 が空いても、T21 は mlt9 から移らない (1回の選局の途中でチューナーを替えない)
      { close: "a" },
      rec("c", "BS", "BS11_0", null),
    ],
  },
  {
    name: "受けられる種別が同じチューナーは同じ順位。その順位が埋まってから次へ行く",
    tuners: [
      { name: "bs8", types: ["BS", "CS"], rank: 1 },
      { name: "mlt8", types: ["GR", "BS", "CS"], rank: 2 },
      { name: "gr8", types: ["GR"], rank: 0 },
      { name: "gr7", types: ["GR"], rank: 0 },
    ],
    steps: [
      rec("a", "GR", "T16", 0),
      rec("b", "BS", "BS11_0", 1),
      rec("c", "BS", "BS03_0", 2),
      rec("d", "GR", "T21", 0),
    ],
  },
  {
    /*
     * 番組表集めが前のチューナーを使っていても、録画は空いている兼用のチューナーへ逃げずに取り上げて入る。
     * 逃げると、あとの衛星の録画が兼用のチューナーを取れない (denpa は予約しか見ていない)
     */
    name: "優先度の低い相手しかいないチューナーも空いているとみなす",
    tuners: MLT9_GR9,
    steps: [
      { open: "epg", type: "GR", channel: "T16", priority: 3, rank: 0 },
      rec("a", "GR", "T21", 0),
      rec("b", "BS", "BS11_0", 1),
    ],
  },
  {
    /*
     * 利用者がいなくなって余韻 (5秒) で残っているだけのチューナーは空いている。兼用のチューナーが
     * 余韻で残っていても、地上波は前のチューナーを使う
     */
    name: "余韻で残っているだけのチューナーは空いている。それでも順位のいちばん前を使う",
    tuners: MLT9_GR9,
    steps: [
      rec("a", "BS", "BS11_0", 1),
      { close: "a" },
      rec("b", "GR", "T16", 0),
      rec("c", "BS", "BS03_0", 1),
    ],
  },
  {
    name: "同じチャンネルを読んでいる選局があれば、どのチューナーでもそれを共有する",
    tuners: MLT9_GR9,
    steps: [
      rec("a", "GR", "T16", 0),
      rec("b", "GR", "T21", 1),
      { close: "a" },
      // gr9 が空いていても、T21 を読んでいる mlt9 を共有する
      rec("c", "GR", "T21", 1),
    ],
  },
  {
    /*
     * 録画が別のチャンネルへ続くとき。前の録画を止めたことがエージェントに届く前に次が来ても、
     * `after` で渡せば前のチューナーがまだ塞がって見えない。選局を共有していた番組表集めはチューナーを取り上げられる
     */
    name: "引き継ぐ利用者はもう離れたものとして選び、そのチューナーを選んだら終わらせて選局し直す",
    tuners: MLT9_GR9,
    steps: [
      rec("a", "GR", "T16", 0),
      rec("b", "GR", "T21", 1),
      { open: "epg", type: "GR", channel: "T21", priority: 3, rank: 1 },
      rec("c", "BS", "BS11_0", 1, { after: ["b"], ended: ["b"] }),
      { close: "b" },
    ],
  },
  {
    name: "引き継ぐときも、順位のより前のチューナーが空いていればそちらを使い、前の利用者には触らない",
    tuners: MLT9_GR9,
    steps: [
      rec("a", "GR", "T16", 0),
      rec("b", "GR", "T21", 1),
      { close: "a" },
      rec("c", "GR", "T16", 0, { after: ["b"], kept: ["b"] }),
      { close: "b" },
    ],
  },
  {
    name: "引き継ぐ相手のチューナーが受けられない種別なら、ふつうに選ぶ",
    tuners: [
      { name: "gr9", types: ["GR"], rank: 0 },
      { name: "bs9", types: ["BS", "CS"], rank: 1 },
    ],
    steps: [
      rec("a", "BS", "BS11_0", 1),
      rec("b", "GR", "T16", 0, { after: ["a", "nobody"] }),
      { close: "a" },
    ],
  },
  {
    /*
     * 録画が同じチャンネルで続くとき。後ろは前の選局を共有するだけで、引き継ぐことも選局し直す
     * ことも無い。前が離れても後ろはそのチューナーにい続ける
     */
    name: "同じチャンネルで続くなら共有するだけ。前が離れても後ろは同じチューナーに残る",
    tuners: MLT9_GR9,
    steps: [
      rec("a", "GR", "T16", 0),
      rec("b", "GR", "T21", 1),
      // b がまだ読んでいるうちに来るので、b の選局を共有する (マージンで前後が重なる)
      rec("c", "GR", "T21", 1),
      { close: "b" },
      { close: "a" },
      // gr9 が空いても c は mlt9 にいるので、衛星は入れない
      rec("d", "BS", "BS11_0", null),
    ],
  },
  {
    /*
     * 優先度の低い利用者 (番組表集め) が広いチューナーで同じチャンネルを読んでいても、録画はそれを共有せずに
     * 順位のいちばん前のチューナーへ入る。共有すると、録画の入るチューナーが録画以外に左右される
     */
    name: "優先度の低い利用者しかいない同じチャンネルは、そのチューナーが順位で先頭の組のときだけ共有する",
    tuners: MLT9_GR9,
    steps: [
      rec("a", "GR", "T21", 0),
      { open: "epg", type: "GR", channel: "T16", priority: 3, rank: 1 },
      { close: "a" },
      rec("b", "GR", "T16", 0),
      rec("c", "BS", "BS11_0", 1),
    ],
  },
];
