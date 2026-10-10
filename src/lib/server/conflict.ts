/**
 * チューナーの割り当てと競合判定。DBにもエージェントにも触らない純粋な計算にしてあるので、
 * 「2本のチューナーで3局を同時に録ろうとした」ような状況を単体テストで固定できる。
 */

export interface Assignable {
    id: number;
    start_at: number;
    end_at: number;
    priority: number;
    /** チャンネル種別 (GR/BS/CS)。チューナーはこの単位で本数が決まる */
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
 * その瞬間に掴んでいるチャンネル。**番組そのものと、マージンだけのぶんを分ける。**
 *
 * マージンは「番組が延びたときのための保険」なので、他所の**番組**とぶつかったら
 * そちらを通す (`assign` の「番組はマージンに勝つ」)
 */
function holding<T extends Assignable>(rivals: Accepted<T>[], at: number) {
    /** `tunerKey` → 単位 (`poolOf`) */
    const all = new Map<string, string>();
    const body = new Map<string, string>();
    for (const rival of rivals) {
        if (rival.from > at || at >= rival.to) continue;
        const pool = poolOf(rival.reservation.type);
        all.set(tunerKey(pool, rival.reservation.channel), pool);
        if (rival.reservation.start_at <= at && at < rival.reservation.end_at) {
            body.set(tunerKey(pool, rival.reservation.channel), pool);
        }
    }
    return { all, body };
}

/**
 * **チューナーを取り合う単位。** BS と CS は同じ衛星チューナーで受けるので1つに束ねる
 * (分けると衛星チューナー1本を倍に数える)
 */
function poolOf(type: string): string {
    return type === 'BS' || type === 'CS' ? 'BS/CS' : type;
}

/**
 * 動いているチューナーそれぞれが受けられる単位 (`poolOf`)。**空なら本数不明。**
 *
 * 単位ごとの本数で持たないのは、PX-MLT のように**地上波も衛星も受ける1本**があるから。
 * 本数で持つと、その1本を地上波でも衛星でも1本ずつ数えてしまう
 */
export type Capacity = readonly ReadonlySet<string>[];

export function capacityOf(tuners: readonly { types: readonly string[]; disabled?: boolean }[]): Capacity {
    return tuners.filter((t) => !t.disabled).map((t) => new Set(t.types.map(poolOf)));
}

/**
 * 1本のチューナーで足りる単位。チャンネル名は地上波と衛星で重ならない作りだが、
 * 単位を跨いで数えるようになったので、念のため単位も付けて取り違えないようにする
 */
function tunerKey(pool: string, channel: string): string {
    return `${pool}:${channel}`;
}

/** その単位を受けられるチューナーが1本も無ければ、本数不明として数えない */
function known(capacity: Capacity, pool: string): boolean {
    return capacity.some((tuner) => tuner.has(pool));
}

/**
 * 単位の組ごとの「溢れる数」(その組のチャンネル数 − その組のどれかを受けられる本数)。
 * 小さい組から順に返す。単位は高々数個なので組を総当たりしてよい
 */
function* overflows(capacity: Capacity, channels: ReadonlyMap<string, string>) {
    const demand = new Map<string, number>();
    for (const pool of channels.values()) {
        if (known(capacity, pool)) demand.set(pool, (demand.get(pool) ?? 0) + 1);
    }
    const pools = [...demand.keys()];
    const subsets = Array.from({ length: (1 << pools.length) - 1 }, (_, i) => i + 1).sort(
        (a, b) => bits(a) - bits(b),
    );
    for (const mask of subsets) {
        const group = new Set(pools.filter((_, i) => mask & (1 << i)));
        let need = 0;
        for (const pool of group) need += demand.get(pool)!;
        const have = capacity.filter((tuner) => [...group].some((pool) => tuner.has(pool))).length;
        yield { group, over: need - have };
    }
}

/**
 * 同時に要るチャンネル (`tunerKey` → 単位) を、チューナーに1本ずつ割り振れるか。
 * 割り振れなければ、**足りない単位の組**を返す (割り振れるなら null)。
 *
 * どの単位の組を取っても溢れなければ割り振れる (ホールの結婚定理)。
 * 小さい組から調べるので、返る組は「どれを諦めれば空くか」に近いものになる
 * (衛星が溢れているのに地上波の番組まで名指ししない)
 */
function shortage(
    capacity: Capacity,
    channels: ReadonlyMap<string, string>,
    /** 指したときは、この単位を含む組だけを見る (名指しする相手を選ぶため) */
    involving?: string,
): Set<string> | null {
    for (const { group, over } of overflows(capacity, channels)) {
        if (involving !== undefined && !group.has(involving)) continue;
        if (over > 0) return group;
    }
    return null;
}

/**
 * 録れずに残るチャンネルの数 (いちばん溢れる組の溢れる数)。
 * 割り振れる最大の本数は「チャンネル数 − これ」になる (ホールの定理の欠損版)
 */
function deficit(capacity: Capacity, channels: ReadonlyMap<string, string>): number {
    let worst = 0;
    for (const { over } of overflows(capacity, channels)) worst = Math.max(worst, over);
    return worst;
}

function bits(n: number): number {
    let count = 0;
    for (; n > 0; n >>= 1) count += n & 1;
    return count;
}

/**
 * 優先度が高い順・開始が早い順に採用していき、入らなかったものを競合として返す。
 *
 * 同じ物理チャンネルの同時録画はエージェントが1本のチューナーで捌けるので、
 * 数えるのは「同時刻に開いている“異なるチャンネル”の数」。
 * 受けられるチューナーが分からない単位 (`known`) は無制限に扱う。
 *
 * ## 入るところまで録る
 *
 * **丸ごと入らないからといって、丸ごと捨てない。** 空いている一番長い区間を
 * 見つけて、そこだけ掴みます。
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
 */
export function assign<T extends Assignable>(
    candidates: T[],
    capacity: Capacity,
    margins: Margins = { start: 0, end: 0 },
): AssignResult<T> {
    const ordered = [...candidates].sort(
        (a, b) => b.priority - a.priority || a.start_at - b.start_at || a.id - b.id,
    );

    const accepted: Accepted<T>[] = [];
    const rejected: { reservation: T; reason: string }[] = [];

    for (const candidate of ordered) {
        const mine = window(candidate, margins);
        const pool = poolOf(candidate.type);
        if (!known(capacity, pool)) {
            accepted.push({ reservation: candidate, from: mine.from, to: mine.to });
            continue;
        }

        // 単位が違っても相手にする。兼用のチューナーを地上波と衛星で取り合うことがある
        const rivals = accepted.filter((a) => a.from < mine.to && mine.from < a.to);
        /*
         * **変わり目でだけ数える。** 同時本数が変わるのは、誰かが掴みはじめるか
         * 離すかした瞬間だけ。その間は数が動かないので、区切りの間を1つの塊として
         * 見れば足りる
         */
        const edges = new Set<number>([mine.from, mine.to]);
        for (const rival of rivals) {
            for (const edge of [rival.from, rival.to, rival.reservation.start_at, rival.reservation.end_at]) {
                if (edge > mine.from && edge < mine.to) edges.add(edge);
            }
        }
        for (const edge of [candidate.start_at, candidate.end_at]) {
            if (edge > mine.from && edge < mine.to) edges.add(edge);
        }
        const points = [...edges].sort((a, b) => a - b);

        // 入れる塊を繋いでいって、いちばん長いものを採る
        let best: { from: number; to: number } | null = null;
        let run: { from: number; to: number } | null = null;
        let worst = 0;
        /** マージンをどかしてもらった区間。あとで相手を縮める */
        const pushed: number[] = [];
        for (let i = 0; i + 1 < points.length; i++) {
            const from = points[i]!;
            const to = points[i + 1]!;
            const here = holding(rivals, from);
            const all = new Map([...here.all, [tunerKey(pool, candidate.channel), pool]]);
            const body = new Map([...here.body, [tunerKey(pool, candidate.channel), pool]]);
            worst = Math.max(worst, all.size);
            /*
             * **番組はマージンに勝つ。** この区間が候補の番組にかかっているなら、
             * マージンだけで居座っている相手にはどいてもらう — あちらのマージンは
             * 「延びたときのための保険」で、こちらは番組そのものだから。
             * 候補のマージンぶんの区間では、相手のマージンを追い出さない
             */
            const inBody = from < candidate.end_at && candidate.start_at < to;
            const fits = shortage(capacity, inBody ? body : all) === null;
            if (fits) {
                if (inBody && shortage(capacity, all) !== null) pushed.push(from);
                run = run === null ? { from, to } : { from: run.from, to };
                if (best === null || run.to - run.from > best.to - best.from) best = { ...run };
            } else {
                run = null;
            }
        }

        if (best === null) {
            rejected.push({
                reservation: candidate,
                reason: `${pool} を受けられるチューナーが足りません (同時に ${worst} チャンネル必要です)`,
            });
            continue;
        }
        const room = best;
        for (const at of pushed) {
            if (at < room.from || at >= room.to) continue;
            for (const rival of rivals) {
                if (rival.from > at || at >= rival.to) continue;
                // 番組そのものが居るなら、どかせない (向こうのほうが優先度が高い)
                if (rival.reservation.start_at <= at && at < rival.reservation.end_at) continue;
                if (rival.reservation.end_at <= at) rival.to = Math.min(rival.to, at);
                else rival.from = Math.max(rival.from, room.to);
            }
        }
        accepted.push({ reservation: candidate, from: room.from, to: room.to });
    }

    return { accepted, rejected };
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
 * 重なりを探す相手。**開始順に並べて、探し始める位置を引けるようにしておく。**
 *
 * 番組は開始順に並べられるが、終了順ではない。ある時刻に掛かっているものを
 * 探すには「いちばん長い番組のぶんだけ手前」から見れば取りこぼさない。
 */
export interface Rivals {
    list: Occupant[];
    /** その時刻に掛かっている可能性のある、いちばん手前の位置 */
    from(at: number): number;
}

export function rivalsOf(occupants: Iterable<Occupant>, margins: Margins): Rivals {
    const list = [...occupants].sort((a, b) => a.start_at - b.start_at);
    const longest = list.reduce((max, o) => Math.max(max, o.end_at - o.start_at), 0);
    const slack = longest + margins.start + margins.end;
    return {
        list,
        from(at: number): number {
            // 開始が (at - いちばん長い番組) より前のものは、もう終わっている
            let low = 0;
            let high = list.length;
            while (low < high) {
                const mid = (low + high) >> 1;
                if (list[mid]!.start_at < at - slack) low = mid + 1;
                else high = mid;
            }
            return low;
        },
    };
}

/**
 * **チューナーが足りなくなる相手だけ**を返す。ただ時間が重なっているだけでは出さない。
 *
 * 数え方は上の `assign` と同じにしてある (同じファイルに置いてあるのもそのため)。
 * ここだけ違う物差しで数えると、画面が「重なっています」と言っているのに
 * スケジューラは通す、という食い違いが出る。
 *
 * - **チューナーごとに受けられる単位で数える** (`Capacity`)。兼用のチューナーがあるときだけ、
 *   地上波と衛星でも取り合う。
 * - **同じ物理チャンネルは1本で足りる。** エージェントが1本のチューナーを配るので、
 *   テレ東1と2のような相乗りは何本並んでも1本。
 * - **割り振れなくなって初めて競合。** 地上波チューナーが2本あるなら、別チャンネルの
 *   2番組が重なっていても録れる。
 * - **本数が分からないときは何も言わない** (エージェントが落ちているとき)。
 *   `assign` も同じ扱いで、勝手に競合扱いにはしない。
 *
 * ぶつかる相手は全部返す (どれを諦めればいいのかが読めるように)。
 */
export function contending(
    row: { programId: number; type: string; channel: string; start_at: number; end_at: number },
    rivals: Rivals,
    capacity: Capacity,
    margins: Margins,
): string[] {
    const pool = poolOf(row.type);
    if (!known(capacity, pool)) return [];
    const mine = window(row, margins);

    /** 時間が重なっているもの。同じチャンネルのものも入れる (本数は1本で済む) */
    const overlapping: Occupant[] = [];
    // 総当たりにしない。ゆるい条件のルールは数千件に当たるので、
    // 1件ずつ全件と突き合わせると番組表の二乗ぶん回ることになる
    for (let at = rivals.from(mine.from); at < rivals.list.length; at++) {
        const other = rivals.list[at]!;
        const theirs = window(other, margins);
        // 並びは開始順。これより後ろは全部この番組より後に始まる
        if (theirs.from >= mine.to) break;
        if (other.programId === row.programId) continue;
        if (theirs.to <= mine.from) continue;
        overlapping.push(other);
    }

    /*
     * 割り振れなくなるか。**いちばん苦しい瞬間は必ずどれかの区間の開始時点に
     * 現れる**ので、そこだけ調べれば足りる (assign と同じ)。重なっている相手を
     * ただ全部足すと、互いには重なっていないもの同士まで一緒に数えてしまう
     */
    let worst = 0;
    let culprits: Occupant[] = [];
    for (const at of [mine.from, ...overlapping.map((o) => window(o, margins).from)]) {
        if (at < mine.from || at >= mine.to) continue;
        const together = overlapping.filter((o) => {
            const theirs = window(o, margins);
            return theirs.from <= at && at < theirs.to;
        });
        const channels = new Map([
            ...together.map((o) => [tunerKey(poolOf(o.type), o.channel), poolOf(o.type)] as const),
            [tunerKey(pool, row.channel), pool],
        ]);
        /*
         * **自分を足すと録れない数が増えるときだけ競合。** 地上波だけが溢れている
         * 区間で、ちょうど空いている衛星の番組まで競合と言わない (`assign` もそちらを落とさない)
         */
        const without = new Map(channels);
        without.delete(tunerKey(pool, row.channel));
        // 同じチャンネルの相手が居れば、その1本に相乗りする (消すと数え違える)
        if (together.some((o) => o.channel === row.channel && poolOf(o.type) === pool)) continue;
        if (deficit(capacity, channels) <= deficit(capacity, without)) continue;
        const short = shortage(capacity, channels, pool);
        if (short === null) continue;
        /*
         * 足りない単位の相手だけを名指しする。それ以外を諦めても空かない。
         * 同じチャンネルの相手も出さない。1本で足りるので、諦めても何も空かない
         */
        const named = together.filter((o) => short.has(poolOf(o.type)) && o.channel !== row.channel);
        if (named.length > worst) {
            worst = named.length;
            culprits = named;
        }
    }

    return culprits.map((o) => `${o.name} (${o.serviceName})`);
}
