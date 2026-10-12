/**
 * **チューナーの選び方の場面。エージェントと denpa の両方のテストが同じものを読む。**
 *
 * どの本を使うかはエージェントが決め、denpa はその決まりを前提に予約を割り振る
 * (`src/lib/server/conflict.ts`)。決まりの中身はエージェントだけが持ち、両者の間にあるのは
 * 約束 (docs/agent.md「選ぶ順の約束」) だけ。片方だけ変わって食い違ったら、どちらかが落ちる:
 *
 * - `agent/conformance.test.ts` は本物のエージェントに開かせて、入った本の `rank` を見る
 * - `src/lib/server/conflict.test.ts` は denpa のなぞり方 (`placements`) で同じ答えになるかを見る
 *
 * 偽の放送に居るのは地上波 T16・T21、衛星 BS11_0・BS03_0 だけ (`tests/fake/services.ts`)。
 */

export interface SceneTuner {
    name: string;
    types: string[];
    /** エージェントが返すはずの順位 (`GET /denpa/tuners` の `rank`) */
    rank: number;
}

export type SceneStep =
    /** 開く。`rank` は入るはずの本の順位、null なら断られる (409) */
    | { open: string; type: string; channel: string; priority: number; rank: number | null }
    /** 読むのをやめる */
    | { close: string };

export interface Scene {
    name: string;
    tuners: SceneTuner[];
    steps: SceneStep[];
}

/** 録画の強さ (`config.priority.recording`)。denpa が割り振るのはこれだけ */
export const RECORDING = 10;

export const scenes: Scene[] = [
    {
        /*
         * Issue #668 のケース1。順どおりに選ぶので、先の予定は見ない。
         * T16 を兼用、T21 を専用に入れていれば録れたが、エージェントはそうしない
         * (denpa は、そうしないことを前提に予約を割り振る)
         */
        name: '空いていて受けられる本のうち、順位のいちばん前を使う。先の予定は見ない',
        tuners: [
            { name: 'mlt9', types: ['GR', 'BS', 'CS'], rank: 1 },
            { name: 'gr9', types: ['GR'], rank: 0 },
        ],
        steps: [
            { open: 'a', type: 'GR', channel: 'T16', priority: RECORDING, rank: 0 },
            { open: 'b', type: 'GR', channel: 'T21', priority: RECORDING, rank: 1 },
            // gr9 が空いても、T21 は mlt9 から移らない (1回の選局の途中で本を替えない)
            { close: 'a' },
            { open: 'c', type: 'BS', channel: 'BS11_0', priority: RECORDING, rank: null },
        ],
    },
    {
        name: '受けられる種別が同じ本は同じ順位。その順位が埋まってから次へ行く',
        tuners: [
            { name: 'bs8', types: ['BS', 'CS'], rank: 1 },
            { name: 'mlt8', types: ['GR', 'BS', 'CS'], rank: 2 },
            { name: 'gr8', types: ['GR'], rank: 0 },
            { name: 'gr7', types: ['GR'], rank: 0 },
        ],
        steps: [
            { open: 'a', type: 'GR', channel: 'T16', priority: RECORDING, rank: 0 },
            { open: 'b', type: 'BS', channel: 'BS11_0', priority: RECORDING, rank: 1 },
            { open: 'c', type: 'BS', channel: 'BS03_0', priority: RECORDING, rank: 2 },
            { open: 'd', type: 'GR', channel: 'T21', priority: RECORDING, rank: 0 },
        ],
    },
    {
        /*
         * 番組表集めが前の本を使っていても、録画は空いている兼用の本へ逃げずに蹴って入る。
         * 逃げると、あとの衛星の録画が兼用の本を取れない (denpa は予約しか見ていない)
         */
        name: '弱い相手しかいない本も空いているとみなす',
        tuners: [
            { name: 'mlt9', types: ['GR', 'BS', 'CS'], rank: 1 },
            { name: 'gr9', types: ['GR'], rank: 0 },
        ],
        steps: [
            { open: 'epg', type: 'GR', channel: 'T16', priority: 3, rank: 0 },
            { open: 'a', type: 'GR', channel: 'T21', priority: RECORDING, rank: 0 },
            { open: 'b', type: 'BS', channel: 'BS11_0', priority: RECORDING, rank: 1 },
        ],
    },
    {
        /*
         * 読み手がいなくなって余韻 (5秒) で残っているだけの本は空いている。兼用の本が
         * 余韻で残っていても、地上波は前の本を使う
         */
        name: '余韻で残っているだけの本は空いている。それでも順位のいちばん前を使う',
        tuners: [
            { name: 'mlt9', types: ['GR', 'BS', 'CS'], rank: 1 },
            { name: 'gr9', types: ['GR'], rank: 0 },
        ],
        steps: [
            { open: 'a', type: 'BS', channel: 'BS11_0', priority: RECORDING, rank: 1 },
            { close: 'a' },
            { open: 'b', type: 'GR', channel: 'T16', priority: RECORDING, rank: 0 },
            { open: 'c', type: 'BS', channel: 'BS03_0', priority: RECORDING, rank: 1 },
        ],
    },
    {
        name: '同じチャンネルを読んでいる選局があれば、どの本でもそこに乗る',
        tuners: [
            { name: 'mlt9', types: ['GR', 'BS', 'CS'], rank: 1 },
            { name: 'gr9', types: ['GR'], rank: 0 },
        ],
        steps: [
            { open: 'a', type: 'GR', channel: 'T16', priority: RECORDING, rank: 0 },
            { open: 'b', type: 'GR', channel: 'T21', priority: RECORDING, rank: 1 },
            { close: 'a' },
            // gr9 が空いていても、T21 を読んでいる mlt9 に乗る
            { open: 'c', type: 'GR', channel: 'T21', priority: RECORDING, rank: 1 },
        ],
    },
];
