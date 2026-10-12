/**
 * チューナーの割り当てと競合判定。DBにもエージェントにも触らない純粋な計算にしてあるので、
 * 「2本のチューナーで3局を同時に録ろうとした」ような状況を単体テストで固定できる。
 *
 * ## エージェントとの約束の上で数える
 *
 * **どの本を使うかを決めるのはエージェント**で、denpa は名指ししない (ライブや番組表集めも
 * 同じ本を使うので、denpa が「この本で」と決めると食い違う)。代わりにエージェントは
 * **選ぶ順** (`GET /denpa/tuners` の `rank`) を公開し、次の約束を守る
 * ([agent.md](../../../docs/agent.md#選ぶ順の約束)。`agent/conformance.test.ts` が押さえている)。
 *
 * 1. 同じか強い読み手が同じ物理チャンネルを読んでいなければ、**空いている本のうち、受けられて
 *    `rank` がいちばん小さい本**を使う。録画から見て弱い相手 (ライブ・番組表集めなど) しか
 *    いない本も空いているとみなす。同じ `rank` の本は受けられる種別が同じで、どれを使ってもよい
 * 2. 1回の選局の読み手は、**終わるまで同じ本にいる**。同じか強い読み手が同じチャンネルを
 *    読んでいれば、どの本でもそこに乗る
 * 3. 引き継ぐ読み手 (`after`。スケジューラが同じ見回りで止めた録画) は、もう離れたものとして選ぶ。
 *    なのでここでは、離すのと掴むのが同じ時刻なら離すほうを先に数える
 *
 * ここではその約束どおりに**開始順になぞって**、どの予約も最後まで本を掴めるかを見る。
 * 瞬間ごとの本数だけを数えていた頃は、どの瞬間も足りているのに、地上波が兼用の本
 * (PX-MLT など) に先に入ったせいで後の衛星が掴めない組を通していた (#668)。
 *
 * **「種別の少ない本から」という決まりはここには書かない。** 順を決めるのはエージェントで、
 * こちらは `rank` を読むだけ。決まりを両方に持つと、片方だけ直したときに黙ってずれる。
 * 同じ場面を両方のテストに通して、ずれたら落ちるようにしてある (`tests/fake/tuner-scenes.ts`)。
 *
 * **予約しか見ない。** ライブや番組表集めの予定は読めないが、約束1で録画には必ず譲るので、
 * 予約どうしの割り振りはそれらに左右されない。
 */

export interface Assignable {
    id: number;
    start_at: number;
    end_at: number;
    priority: number;
    /** チャンネル種別 (GR/BS/CS)。受けられるかはチューナーごとに決まる (`Capacity`) */
    type: string;
    /** 物理チャンネル。同じチャンネルなら1本のチューナーを共有できる */
    channel: string;
}

/**
 * 採用したもの。**掴んでよい区間つき** (前後マージン込み)。
 *
 * 丸ごと入らないときは**入るところまで**にする (`assign` の「入るところまで録る」)。
 * `from`/`to` が番組の時刻を食っていれば、その録画は頭か尻が欠ける
 */
export interface Accepted<T extends Assignable> {
    reservation: T;
    /** チューナーを掴んでよい始まり (マージン込み) */
    from: number;
    /** 掴んでよい終わり (マージン込み) */
    to: number;
}

export interface AssignResult<T extends Assignable> {
    accepted: Accepted<T>[];
    rejected: { reservation: T; reason: string }[];
}

/**
 * 番組そのものが丸ごと入っているか。**マージンが削られただけなら「丸ごと」。**
 *
 * 隣り合う番組はマージンぶんだけ必ず重なるので、そこを削っただけで
 * 「途中から」と言い出すと、**ほとんどの録画に札が付いて意味を失う**
 */
export function whole<T extends Assignable>(a: Accepted<T>): boolean {
    return a.from <= a.reservation.start_at && a.to >= a.reservation.end_at;
}

/**
 * 実際にチューナーを掴んでいる区間。
 *
 * 番組の時刻そのままで数えると、22:00 終了と 22:00 開始の予約が「重ならない」ことに
 * なってしまう。実際には前の録画は終了マージンぶん伸び、次の録画は開始マージンぶん
 * 早く始まるので、その間チューナーは2本要る。ここを見落とすと予約表では通っているのに
 * 実行時に「チューナーが空かない」で録り逃す。
 */
function window(a: { start_at: number; end_at: number }, margins: Margins) {
    return { from: a.start_at - margins.start, to: a.end_at + margins.end };
}

export interface Margins {
    /** 開始何ms前から録り始めるか */
    start: number;
    /** 終了何ms後まで録り続けるか */
    end: number;
}

/**
 * **チューナー不足の文言で使う単位。** BS と CS は同じ衛星チューナーで受けるので1つに言う
 */
function poolOf(type: string): string {
    return type === 'BS' || type === 'CS' ? 'BS/CS' : type;
}

/** 同じ `rank` のチューナーの組。受けられる種別は同じ (エージェントとの約束) */
export interface TunerGroup {
    rank: number;
    types: ReadonlySet<string>;
    count: number;
}

/**
 * 動いているチューナーを、**エージェントが選ぶ順** (`rank`) に組にして並べたもの。**空なら本数不明。**
 *
 * 単位ごとの本数で持たないのは、PX-MLT のように**地上波も衛星も受ける1本**があるから。
 * 本数で持つと、その1本を地上波でも衛星でも1本ずつ数えてしまう
 */
export type Capacity = readonly TunerGroup[];

/**
 * エージェントの一覧から作る。**`rank` の無い本が1つでもあれば本数不明** (空) にする —
 * 選ぶ順の分からないエージェント (古い版) を相手に、外れるかもしれない割り振りで
 * 予約を競合にしない。エージェントに繋がらないときと同じ扱い
 */
export function capacityOf(
    tuners: readonly { types: readonly string[]; disabled?: boolean; rank?: number | null }[],
): Capacity {
    const enabled = tuners.filter((t) => !t.disabled);
    const groups = new Map<number, TunerGroup>();
    for (const tuner of enabled) {
        if (typeof tuner.rank !== 'number') return [];
        const group = groups.get(tuner.rank);
        if (group === undefined)
            groups.set(tuner.rank, { rank: tuner.rank, types: new Set(tuner.types), count: 1 });
        else group.count++;
    }
    return [...groups.values()].sort((a, b) => a.rank - b.rank);
}

/**
 * **録画中で、もうどれかの本に入っているもの。** なぞり始めの状態になる。
 *
 * 録り始めた予約は割り振り直さないが、終わるまで本を塞ぐ。どの本にいるかは
 * エージェントが知っている (`GET /denpa/tuners` の `users`。scheduler.ts の `recordingHolds`)
 */
export interface Busy {
    type: string;
    channel: string;
    /** 入っている本の `rank` */
    rank: number;
    /** 離す時刻 */
    until: number;
}

/** その種別を受けられるチューナーが1本も無ければ、本数不明として数えない */
function known(capacity: Capacity, type: string): boolean {
    return capacity.some((group) => group.types.has(type));
}

/** 1本のチューナーで足りる単位。エージェントは種別とチャンネルが同じなら相乗りさせる */
function keyOf(type: string, channel: string): string {
    return `${type}:${channel}`;
}

interface Hold {
    type: string;
    channel: string;
    from: number;
    to: number;
}

/**
 * 掴んでいる本の様子。**約束どおりに1本ずつ取って、離す。**
 *
 * 「なぞる」の中身は予約 (`assign`) と下見 (`contentions`) で同じものを使う
 */
class Tuners {
    private readonly free: number[];
    /** `keyOf` → 入っている組と、乗っている数 */
    private readonly held = new Map<string, { group: number; refs: number }>();

    constructor(private readonly capacity: Capacity) {
        this.free = capacity.map((group) => group.count);
    }

    /** 録画中のものを入れる。`rank` の知らない本 (無効にした本など) は数えない */
    place(busy: Busy): string | null {
        const group = this.capacity.findIndex((g) => g.rank === busy.rank);
        if (group < 0) return null;
        const key = keyOf(busy.type, busy.channel);
        const held = this.held.get(key);
        if (held !== undefined) {
            held.refs++;
            return key;
        }
        this.free[group]!--;
        this.held.set(key, { group, refs: 1 });
        return key;
    }

    /**
     * 掴む。同じチャンネルが入っていればそこに乗り、無ければ**空いていて受けられる組の
     * うち `rank` のいちばん小さい組**から1本取る (約束1)。取れた組の番号 (取れなければ -1)
     */
    take(type: string, channel: string): number {
        const key = keyOf(type, channel);
        const held = this.held.get(key);
        if (held !== undefined) {
            held.refs++;
            return held.group;
        }
        const group = this.capacity.findIndex((g, i) => this.free[i]! > 0 && g.types.has(type));
        if (group < 0) return -1;
        this.free[group]!--;
        this.held.set(key, { group, refs: 1 });
        return group;
    }

    /** 離す。最後の1人が離れたら本が空く (空いたら true) */
    drop(key: string): boolean {
        const held = this.held.get(key);
        if (held === undefined) return false;
        if (--held.refs > 0) return false;
        this.held.delete(key);
        this.free[held.group]!++;
        return true;
    }

    /** いまの様子の写し。中身は本の数ぶんしか無い */
    clone(): Tuners {
        const copy = new Tuners(this.capacity);
        copy.free.splice(0, copy.free.length, ...this.free);
        for (const [key, { group, refs }] of this.held) copy.held.set(key, { group, refs });
        return copy;
    }

    /** 同じ様子か。同じなら、この先は同じように進む */
    same(other: Tuners): boolean {
        if (this.held.size !== other.held.size) return false;
        for (const [key, { group, refs }] of this.held) {
            const theirs = other.held.get(key);
            if (theirs === undefined || theirs.group !== group || theirs.refs !== refs) return false;
        }
        return true;
    }
}

/**
 * 約束どおりに開始順になぞると、それぞれがどの `rank` の本に入るか (入れなければ null)。
 * 同じ時刻は**離すほうが先** (区間は半開。スケジューラも止めるほうを先にやる)。
 * 同じ時刻に掴むものどうしは渡した順。
 *
 * **エージェントの適合テストと同じ場面を通すための口** (`tests/fake/tuner-scenes.ts`)。
 * 片方だけ直してずれたら、どちらかのテストが落ちる
 */
export function placements(
    holds: readonly Hold[],
    capacity: Capacity,
    busy: readonly Busy[] = [],
): (number | null)[] {
    const tuners = new Tuners(capacity);
    const events: { at: number; delta: 1 | -1; i: number; key: string | null }[] = [];
    for (const b of busy) {
        const key = tuners.place(b);
        if (key !== null) events.push({ at: b.until, delta: -1, i: -1, key });
    }
    holds.forEach((hold, i) => {
        // 長さの無いものはチューナーを掴まない
        if (hold.to <= hold.from) return;
        events.push({ at: hold.from, delta: 1, i, key: null }, { at: hold.to, delta: -1, i, key: null });
    });
    events.sort((a, b) => a.at - b.at || a.delta - b.delta || a.i - b.i);

    const placed: (number | null)[] = holds.map(() => null);
    const keys: (string | null)[] = holds.map(() => null);
    for (const event of events) {
        if (event.i < 0) {
            tuners.drop(event.key!);
            continue;
        }
        const hold = holds[event.i]!;
        if (event.delta < 0) {
            const key = keys[event.i];
            if (key !== null && key !== undefined) tuners.drop(key);
            continue;
        }
        const group = tuners.take(hold.type, hold.channel);
        if (group < 0) continue;
        placed[event.i] = capacity[group]!.rank;
        keys[event.i] = keyOf(hold.type, hold.channel);
    }
    return placed;
}

/**
 * 優先度が高い順・開始が早い順に採用していき、入らなかったものを競合として返す。
 *
 * 採用するたびに、**それまでに採ったものと合わせて開始順になぞり直し**、全員が最後まで
 * 本を掴めるかを見る (`Timeline`)。後から足したものの選局で先に採ったものの入る本が変わる
 * ことがあるので、足すたびに確かめる。なので**後から低い優先度を足したせいで、
 * 高いほうが録れなくなることは無い**。
 *
 * 同じ物理チャンネルの同時録画はエージェントが1本のチューナーで捌く。
 * 受けられるチューナーが分からない種別 (`known`) は無制限に扱う。
 *
 * ## 入るところまで録る
 *
 * **丸ごと入らないからといって、丸ごと捨てない。** 1本の本に最後まで収まる
 * 一番長い区間を見つけて、そこだけ掴みます。
 *
 * 取り合いは**番組まるごと**で起きるとは限りません。実機で出たのはこの形:
 *
 *     23:45 ────片田舎(テレ朝)──── 00:15
 *     00:00 ────落第賢者(MX)────────────── 00:30
 *     00:00 ────LV999(テレ東)───────────── 00:30
 *
 * 3チャンネル要るのは **00:00〜00:15 の15分だけ**で、そこを越えれば
 * 2本で足ります。丸ごとで判断していた頃は LV999 が**まるまる録れません**でした。
 *
 * **切られるのは優先度の低いほうです。** 採るのが優先度の高い順なので、
 * 席が埋まったところへ来るのは必ず低いほう — 上の例では落第賢者 (優先度1) が
 * 00:15 から始まり、LV999 (優先度2) は丸ごと録れます。優先度が同じなら
 * 開始が早いほう・古いほうが丸ごと残ります。
 *
 * **短くても録ります。** 5分でも残っていれば、何も無いよりまし
 * (「録る価値のある長さ」を決めようとしましたが、番組しだいで意味が変わるので
 * 置いていません)。
 *
 * ## 番組はマージンに勝つ
 *
 * マージンは「番組が延びたときのための保険」なので、他所の**番組**とぶつかったら
 * 相手が優先度の高い予約でもマージンのほうを削る (削っただけなら `whole`)。
 * 削るのは要るぶんだけ — 削らずに入るならそのまま、削れば長く入るなら削る
 */
export function assign<T extends Assignable>(
    candidates: T[],
    capacity: Capacity,
    margins: Margins = { start: 0, end: 0 },
    busy: readonly Busy[] = [],
): AssignResult<T> {
    const ordered = [...candidates].sort(
        (a, b) => b.priority - a.priority || a.start_at - b.start_at || a.id - b.id,
    );

    const accepted: Accepted<T>[] = [];
    const rejected: { reservation: T; reason: string }[] = [];

    const timeline = new Timeline(capacity, busy);
    /** 採用したもの → `timeline` の中の番号 (本数の分からない種別は入れない) */
    const number = new Map<Accepted<T>, number>();

    for (const candidate of ordered) {
        const mine = window(candidate, margins);
        if (!known(capacity, candidate.type)) {
            accepted.push({ reservation: candidate, from: mine.from, to: mine.to });
            continue;
        }
        // 掴みはじめの順。要らない削りを戻す順 (`room`) もこれで決まる
        const rivals = accepted
            .filter((a) => number.has(a) && a.from < mine.to && mine.from < a.to)
            .sort((a, b) => a.from - b.from);
        const hold = (from: number, to: number): Hold => ({
            type: candidate.type,
            channel: candidate.channel,
            from,
            to,
        });
        const changes = (trims: readonly Trim<T>[]) =>
            new Map(trims.map((t) => [number.get(t.rival)!, { from: t.from, to: t.to }]));
        const found = room(candidate, mine, rivals, busy, (from, to, trims) =>
            timeline.check(hold(from, to), changes(trims)),
        );
        if (found === null) {
            rejected.push({
                reservation: candidate,
                reason: `${poolOf(candidate.type)} を受けられるチューナーが足りません (同時に ${worst(candidate, mine, rivals, busy)} チャンネル必要です)`,
            });
            continue;
        }
        timeline.commit(hold(found.from, found.to), changes(found.trims));
        for (const trim of found.trims) {
            trim.rival.from = trim.from;
            trim.rival.to = trim.to;
        }
        const taken = { reservation: candidate, from: found.from, to: found.to };
        accepted.push(taken);
        number.set(taken, timeline.size - 1);
    }

    return { accepted, rejected };
}

/** 出入りの印。`i` は掴むものの番号 (録画中のものは -1) */
interface Mark {
    at: number;
    delta: 1 | -1;
    i: number;
    key: string;
}

/** 時刻順。同じ時刻は離すほうが先、その中は番号順 (`placements` と同じ) */
const byTime = (a: Mark, b: Mark) => a.at - b.at || a.delta - b.delta || a.i - b.i;

/** 並んだ印のうち、`at` 以降の最初の位置 */
function firstAt(marks: readonly Mark[], at: number): number {
    let lo = 0;
    let hi = marks.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (marks[mid]!.at < at) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/**
 * **採用済みを開始順になぞった様子を、時刻ごとに覚えておいたもの。** 候補を足したら
 * どうなるかを、変わるところだけなぞり直して確かめる (`check`)。足したら覚え直す (`commit`)。
 *
 * 候補ごと・区間の候補ごとに頭から全部なぞっていた頃は、重なり続ける予約が千件あると
 * 割り振りだけで秒に届いた。足したもの・削ったものより前は何も変わらないので、その時刻の
 * 様子から始める。後ろは、様子が足す前と同じに戻った時点で、その先も同じに進むので打ち切る
 */
class Timeline {
    private readonly holds: Hold[] = [];
    private marks: Mark[] = [];
    /** 出入りのある時刻 (昇順) */
    private times: number[] = [];
    /** `times[k]` の出入りを反映する前の様子。最後の1つは、全部反映した後の様子 */
    private before: Tuners[];

    constructor(capacity: Capacity, busy: readonly Busy[]) {
        const tuners = new Tuners(capacity);
        for (const b of busy) {
            const key = tuners.place(b);
            if (key !== null) this.marks.push({ at: b.until, delta: -1, i: -1, key });
        }
        this.marks.sort(byTime);
        this.before = [tuners.clone()];
        for (const mark of this.marks) {
            if (this.times.at(-1) !== mark.at) this.times.push(mark.at);
            tuners.drop(mark.key);
            this.before[this.times.length] = tuners.clone();
        }
    }

    get size(): number {
        return this.holds.length;
    }

    /** `at` 以上の最初の時刻の番号 */
    private index(at: number): number {
        let lo = 0;
        let hi = this.times.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.times[mid]! < at) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /** 足す前と違ってくる範囲 (始まりと、そこまで見れば足りる終わり) */
    private span(extra: Hold, changed: ReadonlyMap<number, { from: number; to: number }>) {
        let start = extra.to > extra.from ? extra.from : Infinity;
        let end = extra.to > extra.from ? extra.to : -Infinity;
        for (const [i, w] of changed) {
            const was = this.holds[i]!;
            if (w.from !== was.from) start = Math.min(start, was.from);
            if (w.to !== was.to) start = Math.min(start, w.to);
            end = Math.max(end, w.from, was.to);
        }
        return { start, end };
    }

    /** 掴む・離すを1つ反映する。掴めなければ false */
    private apply(tuners: Tuners, mark: Mark, extra?: Hold): boolean {
        if (mark.delta < 0) {
            tuners.drop(mark.key);
            return true;
        }
        const hold = mark.i === this.holds.length && extra !== undefined ? extra : this.holds[mark.i]!;
        return tuners.take(hold.type, hold.channel) >= 0;
    }

    /**
     * `extra` を足し、`changed` (番号 → 縮めた区間) を縮めたら、誰かが掴めなくなるか。
     * 掴めなくなる最初の時刻を返す (全員掴めるなら null)
     */
    check(extra: Hold, changed: ReadonlyMap<number, { from: number; to: number }>): number | null {
        const { start, end } = this.span(extra, changed);
        if (start === Infinity) return null;
        const self = this.holds.length;
        const added: Mark[] = [];
        if (extra.to > extra.from) {
            const key = keyOf(extra.type, extra.channel);
            added.push({ at: extra.from, delta: 1, i: self, key }, { at: extra.to, delta: -1, i: self, key });
        }
        for (const [i, w] of changed) {
            const hold = this.holds[i]!;
            const key = keyOf(hold.type, hold.channel);
            if (w.to <= w.from) continue;
            // 掴みはじめが変わらず、変わる前から掴んでいるなら、その様子から始まる
            if (w.from >= start) added.push({ at: w.from, delta: 1, i, key });
            added.push({ at: w.to, delta: -1, i, key });
        }
        added.sort(byTime);

        const tuners = this.before[this.index(start)]!.clone();
        let n = firstAt(this.marks, start);
        let x = 0;
        const next = (): Mark | undefined => {
            while (n < this.marks.length && changed.has(this.marks[n]!.i)) n++;
            const base = this.marks[n];
            const mine = added[x];
            if (base === undefined) return mine;
            if (mine === undefined) return base;
            return byTime(base, mine) <= 0 ? base : mine;
        };
        for (let mark = next(); mark !== undefined; ) {
            const at = mark.at;
            for (; mark !== undefined && mark.at === at; mark = next()) {
                if (mark === this.marks[n]) n++;
                else x++;
                if (!this.apply(tuners, mark, extra)) return at;
            }
            // 足す前の、この時刻を過ぎた後の様子と同じなら、この先も同じに進む (足す前は全員掴めている)
            if (at >= end && tuners.same(this.before[this.index(at + 1)]!)) return null;
        }
        return null;
    }

    /** 足して、覚え直す。`check` で全員掴めると分かっているものだけ渡すこと */
    commit(extra: Hold, changed: ReadonlyMap<number, { from: number; to: number }>): void {
        const { start, end } = this.span(extra, changed);
        const insert = (mark: Mark) => {
            let lo = 0;
            let hi = this.marks.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (byTime(this.marks[mid]!, mark) <= 0) lo = mid + 1;
                else hi = mid;
            }
            this.marks.splice(lo, 0, mark);
        };
        if (changed.size > 0) this.marks = this.marks.filter((mark) => !changed.has(mark.i));
        for (const [i, w] of changed) {
            const hold = { ...this.holds[i]!, from: w.from, to: w.to };
            this.holds[i] = hold;
            const key = keyOf(hold.type, hold.channel);
            if (w.to <= w.from) continue;
            insert({ at: w.from, delta: 1, i, key });
            insert({ at: w.to, delta: -1, i, key });
        }
        const self = this.holds.length;
        this.holds.push(extra);
        if (extra.to > extra.from) {
            const key = keyOf(extra.type, extra.channel);
            insert({ at: extra.from, delta: 1, i: self, key });
            insert({ at: extra.to, delta: -1, i: self, key });
        }
        if (start === Infinity) return;

        // 変わった時刻から、足す前の様子に戻るまでだけ覚え直す
        const k0 = this.index(start);
        const tuners = this.before[k0]!.clone();
        const times: number[] = [];
        const before: Tuners[] = [];
        let resume: number | null = null;
        for (let n = firstAt(this.marks, start); n < this.marks.length; ) {
            const at = this.marks[n]!.at;
            times.push(at);
            before.push(tuners.clone());
            for (; n < this.marks.length && this.marks[n]!.at === at; n++) this.apply(tuners, this.marks[n]!);
            const k = this.index(at + 1);
            if (at >= end && tuners.same(this.before[k]!)) {
                resume = k;
                break;
            }
        }
        this.times = [
            ...this.times.slice(0, k0),
            ...times,
            ...(resume === null ? [] : this.times.slice(resume)),
        ];
        this.before = [
            ...this.before.slice(0, k0),
            ...before,
            ...(resume === null ? [tuners.clone()] : this.before.slice(resume)),
        ];
    }
}

interface Trim<T extends Assignable> {
    rival: Accepted<T>;
    from: number;
    to: number;
}

/**
 * 1本の本に最後まで収まる、いちばん長い区間 (無ければ null)。`fails` は、候補をその区間で足し、
 * 相手をそう削ったら掴めなくなる最初の時刻 (全員掴めるなら null)。
 *
 * 区切りの候補は、相手が掴みはじめる・離す・番組の頭と尻の時刻だけ (その間では
 * 誰の出入りも無いので、入れるかどうかも変わらない)。
 * 相手のマージンを削らない場合と削る場合を両方試し、長いほうを採る (同じなら削らないほう)。
 *
 * **頭を決めたら、尻は掴めなくなる時刻より前に限る。** 候補が `t` まで掴み続けるなら、
 * そこまでのなぞり方は尻をもっと先にしたときと同じなので、そこで掴めなくなった誰かは
 * やはり掴めない。なので尻を1つずつ縮めて試さず、掴めなくなった時刻まで一気に縮める
 */
function room<T extends Assignable>(
    candidate: T,
    mine: { from: number; to: number },
    rivals: Accepted<T>[],
    busy: readonly Busy[],
    fails: (from: number, to: number, trims: readonly Trim<T>[]) => number | null,
): { from: number; to: number; trims: Trim<T>[] } | null {
    const edges = new Set<number>([mine.from, mine.to, candidate.start_at, candidate.end_at]);
    for (const a of rivals) {
        edges.add(a.from).add(a.to).add(a.reservation.start_at).add(a.reservation.end_at);
    }
    for (const b of busy) edges.add(b.until);
    const points = [...edges].filter((p) => p >= mine.from && p <= mine.to).sort((a, b) => a - b);
    const key = keyOf(candidate.type, candidate.channel);

    /** 候補の番組本体と重なる相手のマージンを、相手の番組の端まで縮める。番組本体は削らない */
    const trimsFor = (from: number, to: number): Trim<T>[] => {
        const bodyFrom = Math.max(from, candidate.start_at);
        const bodyTo = Math.min(to, candidate.end_at);
        if (bodyTo <= bodyFrom) return [];
        const trims: Trim<T>[] = [];
        for (const rival of rivals) {
            // 同じチャンネルは相乗りなので、どいてもらっても何も空かない
            if (keyOf(rival.reservation.type, rival.reservation.channel) === key) continue;
            let { from: rFrom, to: rTo } = rival;
            const { start_at, end_at } = rival.reservation;
            if (end_at < bodyTo && rTo > bodyFrom && rTo > end_at)
                rTo = Math.min(rTo, Math.max(end_at, bodyFrom));
            if (start_at > bodyFrom && rFrom < bodyTo && rFrom < start_at) {
                rFrom = Math.max(rFrom, Math.min(start_at, bodyTo));
            }
            if (rFrom !== rival.from || rTo !== rival.to) trims.push({ rival, from: rFrom, to: rTo });
        }
        return trims;
    };

    const search = (push: boolean) => {
        let best: { from: number; to: number; trims: Trim<T>[] } | null = null;
        const last = points.length - 1;
        for (let i = 0; i < last; i++) {
            const from = points[i]!;
            if (best !== null && points[last]! - from <= best.to - best.from) break;
            let j = last;
            while (j > i) {
                const to = points[j]!;
                if (best !== null && to - from <= best.to - best.from) break;
                const trims = push ? trimsFor(from, to) : [];
                // 削るものが無ければ、削らない場合と同じ
                if (push && trims.length === 0) {
                    j--;
                    continue;
                }
                const failed = fails(from, to, trims);
                if (failed === null) {
                    best = { from, to, trims };
                    break;
                }
                /*
                 * 掴めなくなった時刻までしか掴めない (その時刻ちょうどなら、離すほうが先なので入る)。
                 * 尻を縮めると削り方も変わるが、変わるのは縮めた尻より後の出入りだけなので、
                 * それより前に掴めなくなったものはやはり掴めない
                 */
                while (j > i && points[j]! > failed) j--;
                if (points[j] === to) j--;
            }
        }
        if (best === null || !push) return best;
        // 要らない削りは戻す。保険のマージンは、削らずに済むなら残す
        const needed = [...best.trims];
        for (const trim of best.trims) {
            const without = needed.filter((t) => t !== trim);
            if (fails(best.from, best.to, without) === null) needed.splice(needed.indexOf(trim), 1);
        }
        return { ...best, trims: needed };
    };

    const plain = search(false);
    if (plain !== null && plain.from === mine.from && plain.to === mine.to) return plain;
    const pushed = search(true);
    if (pushed !== null && (plain === null || pushed.to - pushed.from > plain.to - plain.from)) return pushed;
    return plain;
}

/** 断るときに添える数。候補の区間のうち、同時に要るチャンネルがいちばん多い瞬間の数 */
function worst<T extends Assignable>(
    candidate: T,
    mine: { from: number; to: number },
    rivals: Accepted<T>[],
    busy: readonly Busy[],
): number {
    const points = [mine.from, ...rivals.map((a) => a.from)].filter((p) => p >= mine.from && p < mine.to);
    let most = 0;
    for (const at of points) {
        const keys = new Set([keyOf(candidate.type, candidate.channel)]);
        for (const a of rivals) {
            if (a.from <= at && at < a.to) keys.add(keyOf(a.reservation.type, a.reservation.channel));
        }
        for (const b of busy) if (at < b.until) keys.add(keyOf(b.type, b.channel));
        most = Math.max(most, keys.size);
    }
    return most;
}

/**
 * 同じ時間帯にチューナーを掴むもの。ルール画面のプレビュー用。
 *
 * **予約とプレビューを1つに混ぜて数える** — まだ保存していないルールにも、
 * ルール自身が同時に録ろうとするぶんの重なりを出すため。
 */
export interface Occupant {
    programId: number;
    name: string;
    serviceName: string;
    /** チャンネル種別。取り合うかどうかはチューナーしだい (`Capacity`) */
    type: string;
    channel: string;
    start_at: number;
    end_at: number;
}

/**
 * **誰も掴んでいない瞬間まで、`at` からさかのぼった時刻。** 下見はここからなぞる。
 *
 * どの本に入るかは、その前に誰がどの本に入ったかで変わる (#668 の形 — 先に終わった
 * 地上波のせいで、後の衛星が兼用の本を取れない)。なので知りたい時間帯の相手だけ
 * 渡すと答えが変わる。誰も掴んでいない瞬間を挟めば振り出しに戻るので、そこから先を渡す
 */
export function settled(occupants: Iterable<Occupant>, margins: Margins, at: number): number {
    const spans = [...occupants]
        .map((o) => window(o, margins))
        .filter((w) => w.to > w.from && w.from <= at)
        .sort((a, b) => a.from - b.from);
    let start = at;
    let end = -Infinity;
    for (const span of spans) {
        if (span.from >= end) start = span.from;
        end = Math.max(end, span.to);
    }
    return end > at ? start : at;
}

/**
 * **チューナーが足りなくなる相手だけ**を返す (番組ID → 相手)。ただ時間が重なっているだけでは出さない。
 *
 * 数え方は上の `assign` と同じ約束の上でなぞる (同じファイルに置いてあるのもそのため)。
 * ここだけ違う物差しで数えると、画面が「重なっています」と言っているのに
 * スケジューラは通す、という食い違いが出る。
 *
 * - **優先度は見ない。** 皆同じ強さとして開始順になぞり、入れなかったものは空くのを待つ
 *   (空いたら開始順に入る。後から来たほうが「入るところまで録る」のに当たる)
 * - **同じ物理チャンネルは1本で足りる。** テレ東1と2のような相乗りは何本並んでも1本。
 * - **入れずに待つものがいるときだけ競合。** 地上波チューナーが2本あるなら、別チャンネルの
 *   2番組が重なっていても録れる。
 * - **本数が分からないときは何も言わない** (エージェントが落ちているとき)。
 *   `assign` も同じ扱いで、勝手に競合扱いにはしない。
 *
 * 名指しするのは、待っているものが受けられる本を**掴んでいる相手と、同じ本を待っている相手**。
 * 同じチャンネルの相手がいるものは言わない (その1本に相乗りするので、自分だけ諦めても何も空かない)。
 * 番組ID は重ならないこと (呼ぶ側で番組IDごとに1つにまとめてある)。
 *
 * **渡すのは、誰も掴んでいない瞬間から先** (`settled`)。途中から渡すと、その前に誰が
 * どの本に入ったかが抜けて答えが変わる。
 *
 * ## 時刻順に1回なぞって数える
 *
 * - **数えるのは、誰かが掴みはじめた瞬間に待っているものがいるときだけ。** 離すだけでは取り合いは
 *   増えない。待つものがいなければ誰も困っていない
 * - **名指しするのは、その瞬間のうち相手がいちばん多いもの** (同数なら早いほう)
 * - **名前は最後に1回だけ集める。** いちばん多い瞬間が更新されるたびに集めていた頃は、
 *   同時に掴む数を K として全体が K の3乗で伸びた。瞬間だけ覚えておき、もう1度なぞって拾う
 */
export function contentions(
    occupants: Iterable<Occupant>,
    capacity: Capacity,
    margins: Margins,
    busy: readonly Busy[] = [],
): Map<number, string[]> {
    // 時刻順に並べる。安定ソートなので同時刻は渡された順のまま。掴みはじめの早い順が、名指しの並びになる
    const edges = [...occupants]
        .flatMap((o): Edge[] => {
            if (!known(capacity, o.type)) return [];
            const { from, to } = window(o, margins);
            // 長さの無いものはチューナーを掴まない
            if (to <= from) return [];
            return [
                { at: from, o, delta: 1 },
                { at: to, o, delta: -1 },
            ];
        })
        .sort((a, b) => a.at - b.at);

    // 番組ごとに、名指しする相手がいちばん多い瞬間 (同数なら早いほう)
    const best = new Map<number, Worst>();
    for (const moment of sweep(edges, capacity, busy)) {
        for (const w of judge(moment, capacity)) {
            if (w.size > (best.get(w.o.programId)?.size ?? 0)) best.set(w.o.programId, w);
        }
    }

    const due = Map.groupBy(best.values(), (w) => w.at);
    const named = new Map<number, string[]>();
    for (const moment of sweep(edges, capacity, busy)) {
        for (const { o, types, mask } of due.get(moment.at) ?? []) {
            const member = membership(moment, capacity, types);
            const rivals = [...moment.active].filter(
                (x) => (member(x) & mask) !== 0 && x.channel !== o.channel,
            );
            named.set(
                o.programId,
                rivals.map((x) => `${x.name} (${x.serviceName})`),
            );
        }
    }
    return named;
}

/** 掴みはじめ (+1) と離す (-1) の印 */
interface Edge {
    at: number;
    o: Occupant;
    delta: 1 | -1;
}

/** 誰かが掴みはじめ、待っているものがいる瞬間の様子 (`sweep`) */
interface Moment {
    at: number;
    /** 待っているものの種別 */
    waiting: readonly string[];
    /** いま掴んでいるか待っている番組 (掴みはじめの早い順) */
    active: ReadonlySet<Occupant>;
    /** 番組 → 入っている組の番号。待っているなら -1 */
    where: ReadonlyMap<Occupant, number>;
}

const WAITING = -1;

/**
 * 時刻順になぞり、**誰かが掴みはじめた瞬間に、入れずに待つものがいれば**止まる。同時刻は離すほうを先に反映する (区間は半開)。
 *
 * 入れなかった番組は待たせ、どこかが空くたびに開始順に入れ直す。
 * **中身は使い回している。** 次へ進むと書き換わるので、止まったその場で読むこと
 */
function* sweep(edges: readonly Edge[], capacity: Capacity, busy: readonly Busy[]): Generator<Moment> {
    const tuners = new Tuners(capacity);
    const releases = busy
        .flatMap((b) => {
            const key = tuners.place(b);
            return key === null ? [] : [{ at: b.until, key }];
        })
        .sort((a, b) => a.at - b.at);
    let next = 0;
    const active = new Set<Occupant>();
    const where = new Map<Occupant, number>();
    const waiting = new Set<Occupant>();
    const enter = (o: Occupant) => {
        const group = tuners.take(o.type, o.channel);
        where.set(o, group < 0 ? WAITING : group);
        return group >= 0;
    };

    for (const [at, batch] of Map.groupBy(edges, (edge) => edge.at)) {
        let freed = false;
        for (; next < releases.length && releases[next]!.at <= at; next++) {
            freed = tuners.drop(releases[next]!.key) || freed;
        }
        for (const { o, delta } of batch) {
            if (delta > 0) continue;
            if (where.get(o) === WAITING) waiting.delete(o);
            else freed = tuners.drop(keyOf(o.type, o.channel)) || freed;
            active.delete(o);
            where.delete(o);
        }
        if (freed) {
            for (const o of waiting) if (enter(o)) waiting.delete(o);
        }
        let starts = false;
        for (const { o, delta } of batch) {
            if (delta < 0) continue;
            starts = true;
            active.add(o);
            if (!enter(o)) waiting.add(o);
        }
        if (starts && waiting.size > 0) {
            yield { at, waiting: [...new Set([...waiting].map((o) => o.type))], active, where };
        }
    }
}

/** 名指しする相手がいちばん多い瞬間と、そのとき待っていたものの種別 */
interface Worst {
    o: Occupant;
    /** 名指しする相手の数 */
    size: number;
    at: number;
    types: readonly string[];
    /** `types` のうち、自分が巻き込まれているもの (ビット) */
    mask: number;
}

/**
 * 番組が、待っている種別のどれの取り合いに入っているか (`types` の順のビット)。
 *
 * 入っているのは、**その種別を受けられる本を掴んでいる番組と、受けられる本が重なる
 * 待ちの番組**。それ以外を諦めても、待っているものは入れない
 */
function membership(moment: Moment, capacity: Capacity, types: readonly string[]): (x: Occupant) => number {
    const receivers = (type: string) => new Set(capacity.flatMap((g, i) => (g.types.has(type) ? [i] : [])));
    const wanted = types.map(receivers);
    const overlap = new Map<string, number>();
    return (x) => {
        const group = moment.where.get(x) ?? WAITING;
        if (group !== WAITING) {
            return wanted.reduce((mask, set, i) => (set.has(group) ? mask | (1 << i) : mask), 0);
        }
        let mask = overlap.get(x.type);
        if (mask === undefined) {
            const mine = receivers(x.type);
            mask = wanted.reduce((m, set, i) => ([...set].some((g) => mine.has(g)) ? m | (1 << i) : m), 0);
            overlap.set(x.type, mask);
        }
        return mask;
    };
}

/** その瞬間に取り合いに入っている番組と、名指しする相手の数 */
function judge(moment: Moment, capacity: Capacity): Worst[] {
    const types = moment.waiting;
    const member = membership(moment, capacity, types);
    const masks = new Map<Occupant, number>();
    for (const x of moment.active) {
        const mask = member(x);
        if (mask !== 0) masks.set(x, mask);
    }
    /*
     * 自分の入っている取り合いの相手の数 (同じチャンネルは除く。1本で足りるので、
     * 諦めても何も空かない)。種別は高々数個なので、組み合わせごとに数えておく
     */
    const combos = 1 << types.length;
    const size = new Array<number>(combos).fill(0);
    const sameChannel = Array.from({ length: combos }, () => new Map<string, number>());
    for (const [x, mask] of masks) {
        for (let c = 1; c < combos; c++) {
            if ((c & mask) === 0) continue;
            size[c]!++;
            sameChannel[c]!.set(x.channel, (sameChannel[c]!.get(x.channel) ?? 0) + 1);
        }
    }
    /*
     * 同じチャンネルの相手が居るものは言わない。その1本に相乗りするので、
     * 自分だけ諦めても何も空かない (名指しの相手には入る)
     */
    const riders = new Map<string, number>();
    for (const x of moment.active) {
        const key = keyOf(x.type, x.channel);
        riders.set(key, (riders.get(key) ?? 0) + 1);
    }
    return [...masks].flatMap(([o, mask]) => {
        if (riders.get(keyOf(o.type, o.channel))! > 1) return [];
        const n = size[mask]! - (sameChannel[mask]!.get(o.channel) ?? 0);
        return n > 0 ? [{ o, size: n, at: moment.at, types, mask }] : [];
    });
}
