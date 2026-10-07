/**
 * 番組表のサブチャンネル (issue #509)。**画面に触らない所だけ**を置く (単体テストで見る)。
 *
 * テレビの番組表と同じ形にする:
 *
 * - **既定は本チャンネルだけ。** テレ東2・3 や Eテレ2・3 の列は出さない。
 *   ほとんどの時間は本チャンネルと同じものを流していて、列が増えても横に広がるだけ
 * - **出すときは、同じものを流している間は1つのマスにまとめる。** 本チャンネルの番組を
 *   サブの列まで横に伸ばし、分割放送をしている間だけサブに自分のマスを立てる
 *
 * 録画のルールとライブ画面には関わらない。どちらもサブチャンネルを局として扱い続ける
 * (ライブは相乗り中のサブを `epg.airing` で別に外している)
 */

/** 局の見分けに使う列 (`services` の行) */
export interface Station {
    id: number;
    service_id: number;
    network_id: number;
    type: string;
}

/** 表に置く番組 */
export interface Airing {
    id: number;
    service_id: number;
    start_at: number;
    end_at: number;
    name: string;
}

/**
 * 局ごとの本チャンネル。局の id → 本チャンネルの id (本チャンネルは自分を指す)。
 *
 * **地上波だけ束ねる。** 地上波はネットワークID が放送局ごとに振られていて
 * (テレ東 / テレ東2 / テレ東3 は同じ値)、同じ値なら同じ放送局と言い切れる。
 * 本チャンネルはサービスID のいちばん若いもの (ARIB TR-B14 でサービス番号 0 が先頭。
 * NHK総合1 1024 / 総合2 1025、テレ東 1072 / 1073 / 1074)。
 *
 * BS と CS はネットワークID が全局で同じ (BS は 4) なので、これでは束ねられない。
 * サービスID の並びでも決められない — BS朝日1・2・3 (151〜153) はサブだが、
 * WOWOW のプライム・ライブ・シネマ (191〜193) はそれぞれが本チャンネル。
 * 取り違えると見たい局が消えるので、衛星はこれまでどおり1局1列にしておく
 */
export function mainOf(services: Station[]): Map<number, number> {
    const first = new Map<number, Station>();
    for (const service of services) {
        if (service.type !== 'GR') continue;
        const known = first.get(service.network_id);
        if (known === undefined || service.service_id < known.service_id)
            first.set(service.network_id, service);
    }
    return new Map(
        services.map((service) => [
            service.id,
            service.type === 'GR' ? (first.get(service.network_id)?.id ?? service.id) : service.id,
        ]),
    );
}

/** サブチャンネルを持つ局があるか。無ければ切り替えを出さない */
export function hasSubchannels(main: Map<number, number>): boolean {
    for (const [id, of] of main) if (id !== of) return true;
    return false;
}

/**
 * 表の列。本チャンネルの並びは渡した順 (`SERVICE_ORDER`) のまま、サブはその**すぐ右**。
 *
 * 渡す順でも普通は隣り合う (リモコン番号 → サービスID) が、別の地域の同じ番号の局を
 * 一緒に受けていると間に挟まる。横に伸ばすマスは隣り合っていないと描けないので寄せ直す
 *
 * @param subs サブチャンネルも出すか
 */
export function columnsOf<S extends Station>(services: S[], main: Map<number, number>, subs: boolean): S[] {
    const children = new Map<number, S[]>();
    for (const service of services) {
        const of = main.get(service.id) ?? service.id;
        if (of === service.id) continue;
        const list = children.get(of);
        if (list === undefined) children.set(of, [service]);
        else list.push(service);
    }
    const columns: S[] = [];
    for (const service of services) {
        if ((main.get(service.id) ?? service.id) !== service.id) continue;
        columns.push(service);
        if (subs) columns.push(...(children.get(service.id) ?? []));
    }
    return columns;
}

/** 表の1マス。同じ番組が2つ以上のマスになることがある (分割放送の前後で幅が変わるとき) */
export interface Cell<P extends Airing> {
    /** 描くときの鍵。番組の id だけでは重なる */
    key: string;
    program: P;
    /** 左から何列目か (0 始まり。時刻の列は数えない) */
    column: number;
    /** 何列ぶん横に伸ばすか */
    span: number;
    /** このマスが受け持つ時間。番組の途中で幅が変わると、番組の時間より短くなる */
    start_at: number;
    end_at: number;
}

/**
 * マスを組む。**サブの列は、自分の番組を流している間だけ自分のマスを持つ。**
 * それ以外の時間は本チャンネルのマスが横に伸びてくる。
 *
 * サブの番組が「自分の番組」かどうか:
 *
 * - **名前が無い** → 相乗り。マルチ編成をしていない間の NHK総合2 や Eテレ2・3 は
 *   名前の無い枠が並ぶ
 * - **本チャンネルと名前も時刻も同じ** → 相乗り。サブの EIT に本チャンネルと同じ番組を
 *   載せてくる局もある
 * - **番組が無い** → 相乗り (サブの番組表がまだ集まっていないときも、これで済む)
 * - それ以外 → 分割放送。サブに自分のマスを立てる
 *
 * 分割放送が本チャンネルの番組の途中で始まったり終わったりしたら、その時刻で
 * 本チャンネルのマスを切って、幅を変えたマスを上下に積む (テレビの番組表も同じ形)。
 *
 * 並びは受け持つ時刻の早い順。少しずつ描くとき (`drawGradually`) に朝の側から出る
 */
export function cellsOf<S extends Station, P extends Airing>(
    columns: S[],
    programs: P[],
    main: Map<number, number>,
): Cell<P>[] {
    const index = new Map(columns.map((service, i) => [service.id, i]));
    const byService = new Map<number, P[]>();
    for (const program of programs) {
        if (!index.has(program.service_id)) continue;
        const list = byService.get(program.service_id);
        if (list === undefined) byService.set(program.service_id, [program]);
        else list.push(program);
    }

    const cells: Cell<P>[] = [];
    const add = (program: P, column: number, span: number, start: number, end: number) =>
        cells.push({
            key: `${program.id}:${column}:${start}`,
            program,
            column,
            span,
            start_at: start,
            end_at: end,
        });

    columns.forEach((service, column) => {
        if ((main.get(service.id) ?? service.id) !== service.id) return;
        const own = byService.get(service.id) ?? [];
        // 右に続くサブの列 (`columnsOf` で隣に寄せてある)
        const subs: S[] = [];
        for (let i = column + 1; i < columns.length && main.get(columns[i]!.id) === service.id; i++) {
            subs.push(columns[i]!);
        }
        if (subs.length === 0) {
            for (const program of own) add(program, column, 1, program.start_at, program.end_at);
            return;
        }

        const same = new Set(own.map((p) => `${p.start_at}:${p.end_at}:${p.name}`));
        // サブごとの分割放送
        const split = subs.map((sub) =>
            (byService.get(sub.id) ?? []).filter(
                (p) => p.name !== '' && !same.has(`${p.start_at}:${p.end_at}:${p.name}`),
            ),
        );
        split.forEach((list, i) => {
            for (const program of list) add(program, column + 1 + i, 1, program.start_at, program.end_at);
        });

        for (const program of own) {
            // 長さの無い枠は切りようが無い。これまでどおり本チャンネルの列に1行だけ出す (`place`)
            if (program.end_at <= program.start_at) {
                add(program, column, 1, program.start_at, program.end_at);
                continue;
            }
            // 番組の中で、分割放送が始まる・終わる時刻で切る
            const edges = new Set([program.start_at, program.end_at]);
            for (const list of split) {
                for (const p of list) {
                    if (p.start_at > program.start_at && p.start_at < program.end_at) edges.add(p.start_at);
                    if (p.end_at > program.start_at && p.end_at < program.end_at) edges.add(p.end_at);
                }
            }
            const cuts = [...edges].sort((a, b) => a - b);

            // 区切りごとに、本チャンネルの番組を出す列のかたまり ([左端, 列数])
            let runs: [number, number][] = [];
            let from = cuts[0]!;
            const flush = (to: number) => {
                for (const [left, span] of runs) add(program, left, span, from, to);
            };
            for (let c = 0; c + 1 < cuts.length; c++) {
                const start = cuts[c]!;
                const end = cuts[c + 1]!;
                const next: [number, number][] = [[column, 1]];
                split.forEach((list, i) => {
                    if (list.some((p) => p.start_at < end && p.end_at > start)) return;
                    const last = next[next.length - 1]!;
                    // 1つ左の列も出しているなら、そのマスを伸ばす
                    if (last[0] + last[1] === column + 1 + i) last[1]++;
                    else next.push([column + 1 + i, 1]);
                });
                // 幅が変わらなければ切らない (分割放送が続けて並んでいるだけ)
                if (c > 0 && String(next) !== String(runs)) {
                    flush(start);
                    from = start;
                }
                runs = next;
            }
            flush(cuts[cuts.length - 1]!);
        }
    });

    return cells.sort((a, b) => a.start_at - b.start_at || a.column - b.column);
}

/**
 * 端末ごとに覚える cookie。**読むのはサーバ** (`+page.server.ts`) — 描く前に
 * どちらの形か分かっていれば、覚えを読むまで列が出たり消えたりしない
 */
export const SUBCHANNELS_COOKIE = 'denpa_guide_subchannels';

/** 覚えていた値。**既定は出さない** (テレビの番組表と同じ) */
export function storedSubchannels(saved: string | undefined): boolean {
    return saved === '1';
}
