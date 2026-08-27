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
    const all = new Set<string>();
    const body = new Set<string>();
    for (const rival of rivals) {
        if (rival.from > at || at >= rival.to) continue;
        all.add(rival.reservation.channel);
        if (rival.reservation.start_at <= at && at < rival.reservation.end_at) {
            body.add(rival.reservation.channel);
        }
    }
    return { all, body };
}

/**
 * 優先度が高い順・開始が早い順に採用していき、入らなかったものを競合として返す。
 *
 * 同じ物理チャンネルの同時録画はエージェントが1本のチューナーで捌けるので、
 * 数えるのは「同時刻に開いている“異なるチャンネル”の数」。
 * capacity にその種別が無い場合は本数不明として無制限に扱う。
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
    capacity: Map<string, number>,
    margins: Margins = { start: 0, end: 0 },
): AssignResult<T> {
    const ordered = [...candidates].sort(
        (a, b) => b.priority - a.priority || a.start_at - b.start_at || a.id - b.id,
    );

    const accepted: Accepted<T>[] = [];
    const rejected: { reservation: T; reason: string }[] = [];

    for (const candidate of ordered) {
        const mine = window(candidate, margins);
        const limit = capacity.get(candidate.type);
        if (limit === undefined) {
            accepted.push({ reservation: candidate, from: mine.from, to: mine.to });
            continue;
        }

        const rivals = accepted.filter(
            (a) => a.reservation.type === candidate.type && a.from < mine.to && mine.from < a.to,
        );
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
            const from = points[i];
            const to = points[i + 1];
            const here = holding(rivals, from);
            const all = new Set([candidate.channel, ...here.all]);
            const body = new Set([candidate.channel, ...here.body]);
            worst = Math.max(worst, all.size);
            /*
             * **番組はマージンに勝つ。** この区間が候補の番組にかかっているなら、
             * マージンだけで居座っている相手にはどいてもらう — あちらのマージンは
             * 「延びたときのための保険」で、こちらは番組そのものだから。
             * 候補のマージンぶんの区間では、相手のマージンを追い出さない
             */
            const inBody = from < candidate.end_at && candidate.start_at < to;
            const fits = (inBody ? body : all).size <= limit;
            if (fits) {
                if (inBody && all.size > limit) pushed.push(from);
                run = run === null ? { from, to } : { from: run.from, to };
                if (best === null || run.to - run.from > best.to - best.from) best = { ...run };
            } else {
                run = null;
            }
        }

        if (best === null) {
            rejected.push({
                reservation: candidate,
                reason: `${candidate.type} のチューナー ${limit} 本に対し同時 ${worst} チャンネル必要`,
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
 * **予約とプレビューを1つに混ぜて数える。** 立っている予約としか突き合わせて
 * いなかった頃は、**まだ保存していないルールでは重なりが1件も出なかった**
 * (予約がまだ無いので比べる相手が居ない)。ルールが同時に3本録ろうとしていても
 * 画面は静かなままで、保存して初めて競合が出ていた。
 */
export interface Occupant {
    programId: number;
    name: string;
    serviceName: string;
    /** チャンネル種別。地上波と衛星は別のチューナーなので、取り合わない */
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
                if (list[mid].start_at < at - slack) low = mid + 1;
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
 * - **種別ごとに数える。** チューナーは GR / BS・CS で別々に刺さっている。
 *   全部まとめて数えていた頃は、**衛星の番組に地上波の番組が競合として出ていた**。
 * - **同じ物理チャンネルは1本で足りる。** エージェントが1本のチューナーを配るので、
 *   テレ東1と2のような相乗りは何本並んでも1本。
 * - **本数を超えて初めて競合。** 地上波チューナーが2本あるなら、別チャンネルの
 *   2番組が重なっていても録れる。重なりをそのまま出していた頃は、録れるものまで
 *   「重なっています」と出ていた。
 * - **本数が分からないときは何も言わない** (エージェントが落ちているとき)。
 *   `assign` も同じ扱いで、勝手に競合扱いにはしない。
 *
 * 最初の1件しか返していなかった頃は、3本ぶつかっていても画面には1本ぶんしか
 * 出ず、どれを諦めればいいのかが読めなかった。
 */
export function contending(
    row: { programId: number; type: string; channel: string; start_at: number; end_at: number },
    rivals: Rivals,
    capacity: Map<string, number>,
    margins: Margins,
): string[] {
    const limit = capacity.get(row.type);
    if (limit === undefined) return [];
    const mine = window(row, margins);

    /** 同じ種別で時間が重なっているもの。同じチャンネルのものも入れる (本数は1本で済む) */
    const overlapping: Occupant[] = [];
    // 総当たりにしない。ゆるい条件のルールは数千件に当たるので、
    // 1件ずつ全件と突き合わせると番組表の二乗ぶん回ることになる
    for (let at = rivals.from(mine.from); at < rivals.list.length; at++) {
        const other = rivals.list[at];
        const theirs = window(other, margins);
        // 並びは開始順。これより後ろは全部この番組より後に始まる
        if (theirs.from >= mine.to) break;
        if (other.programId === row.programId || other.type !== row.type) continue;
        if (theirs.to <= mine.from) continue;
        overlapping.push(other);
    }

    /*
     * 同時に何チャンネル要るか。**いちばん要る瞬間は必ずどれかの区間の開始時点に
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
        const channels = new Set([row.channel, ...together.map((o) => o.channel)]);
        if (channels.size > worst) {
            worst = channels.size;
            culprits = together;
        }
    }

    if (worst <= limit) return [];
    // 同じチャンネルの相手は名前を出さない。1本で足りるので、諦めても何も空かない
    return culprits.filter((o) => o.channel !== row.channel).map((o) => `${o.name} (${o.serviceName})`);
}
