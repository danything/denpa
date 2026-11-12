/**
 * **全部のエージェントのチューナーを、1 つの選ぶ順に並べる** (docs/agent.md「選ぶ順の約束」・docs/architecture.md)。
 *
 * どのエージェントに送るかは denpa が決め、エージェントの中のどのチューナーかはエージェントが `rank` の順で決める。
 * 選局の振り分け (`tuner.openChannel`) と予約の割り振り (`conflict.ts`) は、この 1 つの関数で並べた順を使う。
 * 2 か所で並べると、振り分けた先と割り振りが食い違う。
 *
 * 1. 同じエージェントの中は `rank` の順のまま
 * 2. ほかのエージェントの組とは受けられる種別で比べ、片方の種別がもう片方にすっかり含まれるなら、含まれるほう (狭いほう) を前にする
 * 3. 1・2 で決まらなければ、エージェントの並び (`agents.position`) の順
 *
 * 1 と 2 が食い違う (あるエージェントが広いほうを前にしている) ときは 1 を勝たせる。各エージェントの先頭の組だけを比べて、
 * ほかのどの先頭より広くないものを、並びの前のエージェントから取る。
 *
 * **denpa が持つ順の決まりは 2 の「狭いほうが前」だけ。** これが無いと、地上波も衛星も受けるチューナーのあるエージェントが並びの前のとき、
 * 地上波の録画がそちらに入り、ほかのエージェントの地上波専用が空いていても後の衛星の録画が録れない (#668 と同じこと)。
 * エージェントの決め方 (受けられる種別の数が少ないほど前) とは食い違わない。含まれるほうは種別の数も少ないため。
 * エージェントが 1 台なら、1 の順そのもの
 */

/** 同じエージェントの、同じ `rank` のチューナーの組。受けられる種別は同じ (エージェントとの約束) */
export interface TunerGroup {
  /** `agents.id` */
  agent: number;
  rank: number;
  types: ReadonlySet<string>;
  /** 組の中のチューナーの数 */
  count: number;
}

/** 並べるのに要るチューナーの中身。`agent` が無いものは 1 台のエージェントのものとして扱う (単体テスト) */
export interface RankedTuner {
  agent?: number;
  types: readonly string[];
  rank: number | null;
}

/** `small` が `large` にすっかり含まれ、同じではないか */
function narrower(
  small: ReadonlySet<string>,
  large: ReadonlySet<string>,
): boolean {
  if (small.size >= large.size) return false;
  for (const type of small) if (!large.has(type)) return false;
  return true;
}

/**
 * チューナーを組にして、選ぶ順に並べる。**`rank` の無いチューナー (無効にしたもの) は入れない。**
 * エージェントの並びは、`tuners` に初めて出てくる順 (`tuner.getTuners` はエージェントの並びの順につなげて返す)
 */
export function orderGroups(tuners: readonly RankedTuner[]): TunerGroup[] {
  const chains = new Map<number, Map<number, TunerGroup>>();
  for (const tuner of tuners) {
    const agent = tuner.agent ?? 0;
    let chain = chains.get(agent);
    if (chain === undefined) {
      chain = new Map();
      chains.set(agent, chain);
    }
    if (tuner.rank === null) continue;
    const group = chain.get(tuner.rank);
    if (group === undefined)
      chain.set(tuner.rank, {
        agent,
        rank: tuner.rank,
        types: new Set(tuner.types),
        count: 1,
      });
    else group.count++;
  }
  const queues = [...chains.values()].map((chain) =>
    [...chain.values()].sort((a, b) => a.rank - b.rank),
  );
  const out: TunerGroup[] = [];
  for (;;) {
    const heads = queues.filter((queue) => queue.length > 0);
    if (heads.length === 0) return out;
    // ほかのどの先頭よりも広くない先頭のうち、並びの前のもの。狭いほうが前という関係は循環しないので必ずある
    const next = heads.find(
      (queue) =>
        !heads.some(
          (other) =>
            other !== queue && narrower(other[0]!.types, queue[0]!.types),
        ),
    )!;
    out.push(next.shift()!);
  }
}

/** 選局する所。エージェント (`agents.id`) と、そのエージェントの控えでのチャンネルの名前 */
export interface Place {
  agent: number;
  channel: string;
}

/**
 * 局を受けられる所を 1 つの文字列にしたもの (`agent-channels.shareKey`)。`<エージェント>\t<チャンネル>` を改行でつなぐ。
 * 同じ TS の局は同じ文字列になるので、同じ放送か (`rules.oneBroadcast`) はこの文字列を比べれば分かる
 */
export function placesKey(places: readonly Place[]): string {
  return places.map((place) => `${place.agent}\t${place.channel}`).join("\n");
}

/** 受けられる所の 1 つ。`agent` が null なら、どのエージェントの組にも入る (エージェントを書かない単体テストと、チャンネルの分からない局) */
export interface LoosePlace {
  agent: number | null;
  channel: string;
}

/** `placesKey` を読む。タブの無い行は、エージェントを決めていない所 */
export function parsePlaces(key: string): LoosePlace[] {
  return key.split("\n").map((line) => {
    const tab = line.indexOf("\t");
    if (tab < 0) return { agent: null, channel: line };
    return { agent: Number(line.slice(0, tab)), channel: line.slice(tab + 1) };
  });
}
