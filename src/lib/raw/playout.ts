/**
 * **生で送る道の時計と貯め方** (docs/stream.md §5.5)。
 *
 * 焼く道では MSE が時計を持っていて (`video.currentTime`)、貯めているぶんも
 * `buffered` で見えた。生の道は自前で鳴らすので、どちらも自分で持つ。
 *
 * ## 時計は音
 *
 * **鳴っている音を時計にする。** 音は途切れると誰でも気づくが、絵は1コマ遅れても
 * 気づかれにくい。だから音は届いた順に隙間なく並べ (Web Audio の時間の上に予約する)、
 * 絵は「いま鳴っている音の PTS」を追いかけて、番が来たコマを出す (worker 側)。
 * 放送の PTS は音と絵で同じ時計 (PCR) に乗っているので、それで口が合う。
 *
 * 音を鳴らせないとき (自動再生を断られた) は、壁時計を時計にする (`now` を渡す側が選ぶ)。
 *
 * ## 貯め方は焼く道と同じ考え
 *
 * 貯まった音の尺が `target` に届いてから鳴らし始め、**使い切ったら止まって貯め直す**。
 * 止まったことは呼ぶ側に返す — 貯める量を伸ばすかどうか (`pacing.nextTarget`) は
 * 焼く道と同じものを使う。溜まりすぎたら (手元の時計と放送の時計のずれ、裏に回った
 * タブが戻ったとき) 放送の今へ跳ぶ。焼く道のように 1.05倍で詰めることはしない —
 * 音を速めると音程が変わる (MSE は保ったまま速めてくれていた)。
 *
 * DOM も Web Audio も触らないので、ここだけ単体で確かめられる (`playout.test.ts`)。
 */

/** 90kHz */
const CLOCK = 90_000;
/** 鳴らし始めを予約するときの先回り (秒)。今すぐにすると頭が欠ける */
export const LEAD = 0.05;
/** 残りがこれを切ったら「使い切った」(秒) */
export const DRY = 0.03;
/** 溜まりがこれだけ `target` を超えたら跳ぶ (秒) */
export const SLACK = 1;
/** 跳ぶまでに溜まりすぎが続く時間 (秒)。**一瞬の塊では跳ばない** */
export const SLACK_FOR = 3;

/** 音の1コマ。時刻は 90kHz (一周をまたいでも増え続けるもの) */
export interface Chunk {
    pts: number;
    duration: number;
}

export interface Scheduled<T extends Chunk> {
    chunk: T;
    /** 鳴らし始める時刻 (時計の秒) */
    when: number;
    /** コマの頭をどれだけ飛ばすか (秒)。鳴らし始めの位置がコマの途中のとき */
    offset: number;
}

export type Tick<T extends Chunk> =
    | { kind: 'none' }
    /** 鳴らし始めた。**予約し直す** */
    | { kind: 'start'; schedule: Scheduled<T>[] }
    /** 使い切って止まった。予約しているものは全部止める */
    | { kind: 'stall' }
    /** 溜まりすぎたので放送の今へ跳んだ。予約しているものを止めて、予約し直す */
    | { kind: 'jump'; schedule: Scheduled<T>[] };

const end = (chunk: Chunk) => chunk.pts + chunk.duration;

export class Playout<T extends Chunk> {
    /** 鳴らしているか。止まっている間は貯める */
    private running = false;
    /** 止めているか (押して)。**止めている間は鳴らし始めない** */
    private held = false;
    /** まだ鳴り終わっていないコマ。貯めている間も、鳴らしている間も */
    private chunks: T[] = [];
    /** 鳴らしている間の対応: 時計の `base` 秒に PTS `origin` が鳴る */
    private base = 0;
    private origin = 0;
    /** 溜まりすぎが始まった時刻 (時計の秒)。溜まりすぎでなければ NaN */
    private overSince = Number.NaN;

    /** どれだけ貯めるか (秒)。呼ぶ側が決める (`pacing.nextTarget`) */
    target: number;

    constructor(target: number) {
        this.target = target;
    }

    get playing(): boolean {
        return this.running;
    }

    /** いま鳴っている PTS。**鳴らしていなければ null** (絵もそこで止まる) */
    position(now: number): number | null {
        if (!this.running) return null;
        return this.origin + (now - this.base) * CLOCK;
    }

    /** 届いたいちばん新しい音の終わり。貯まっている量を見るのに使う */
    get newest(): number | null {
        const last = this.chunks.at(-1);
        return last === undefined ? null : end(last);
    }

    /** 手元にあと何秒ぶん持っているか。**鳴らしていなければ貯まっている尺** */
    lead(now: number): number {
        const newest = this.newest;
        if (newest === null) return 0;
        const from = this.position(now) ?? this.chunks[0]!.pts;
        return Math.max(0, (newest - from) / CLOCK);
    }

    /**
     * 1コマ届いた。**鳴らしている最中なら、鳴らす時刻を返す**
     *
     * 前のコマと離れていたら (音が一瞬途切れた・時刻が飛んだ) そのまま時刻どおりに置く。
     * 番を過ぎたものは捨てる — 遅れて鳴らすと、そこから先が全部ずれる
     */
    push(chunk: T, now: number): Scheduled<T> | null {
        // 前より古い時刻 (選局し直しの取り残し) は捨てる
        const last = this.chunks.at(-1);
        if (last !== undefined && chunk.pts < last.pts) return null;
        this.chunks.push(chunk);
        if (!this.running) {
            // 止めている間は溜め込まない。鳴らし直すときは放送の今から
            if (this.held) this.keepLast(this.target + SLACK);
            return null;
        }
        const when = this.base + (chunk.pts - this.origin) / CLOCK;
        if (when + chunk.duration / CLOCK <= now) {
            this.chunks.pop();
            return null;
        }
        return { chunk, when: Math.max(when, now), offset: Math.max(0, now - when) };
    }

    /** 刻むたびに呼ぶ。**鳴らし始め・止まり・跳びはここで決まる** */
    tick(now: number): Tick<T> {
        if (!this.running) {
            if (this.held || this.lead(now) < this.target) return { kind: 'none' };
            return { kind: 'start', schedule: this.startAt(now) };
        }
        // 鳴り終わったものを落とす
        const at = this.position(now) as number;
        while (this.chunks.length > 0 && end(this.chunks[0]!) <= at) this.chunks.shift();

        const lead = this.lead(now);
        if (lead < DRY) {
            this.running = false;
            this.chunks = [];
            this.overSince = Number.NaN;
            return { kind: 'stall' };
        }
        if (lead > this.target + SLACK) {
            if (Number.isNaN(this.overSince)) this.overSince = now;
            if (now - this.overSince >= SLACK_FOR) {
                this.overSince = Number.NaN;
                return { kind: 'jump', schedule: this.startAt(now) };
            }
        } else {
            this.overSince = Number.NaN;
        }
        return { kind: 'none' };
    }

    /**
     * 時計を替える (壁時計 ⇔ 音)。**いま鳴っている位置を新しい時計の上へ移す。**
     * 予約し直すものを返す
     */
    rebase(position: number, now: number): Scheduled<T>[] {
        if (!this.running) return [];
        this.origin = position;
        this.base = now + LEAD;
        return this.plan();
    }

    /** 止める。**再開は放送の今から** (貯め直してから) */
    hold(): void {
        this.held = true;
        this.running = false;
        this.overSince = Number.NaN;
        this.keepLast(this.target + SLACK);
    }

    resume(): void {
        this.held = false;
    }

    /** 選局し直したとき。**前の局の音は1つも残さない** */
    reset(): void {
        this.running = false;
        this.chunks = [];
        this.overSince = Number.NaN;
    }

    /** 放送の今から `target` 手前で鳴らし始める */
    private startAt(now: number): Scheduled<T>[] {
        const newest = this.newest as number;
        this.origin = Math.max(this.chunks[0]!.pts, newest - this.target * CLOCK);
        this.base = now + LEAD;
        this.running = true;
        this.chunks = this.chunks.filter((chunk) => end(chunk) > this.origin);
        return this.plan();
    }

    private plan(): Scheduled<T>[] {
        return this.chunks.map((chunk) => {
            const when = this.base + (chunk.pts - this.origin) / CLOCK;
            return { chunk, when: Math.max(when, this.base), offset: Math.max(0, this.base - when) };
        });
    }

    /** 新しいほうから `seconds` ぶんだけ残す */
    private keepLast(seconds: number): void {
        const newest = this.newest;
        if (newest === null) return;
        this.chunks = this.chunks.filter((chunk) => end(chunk) > newest - seconds * CLOCK);
    }
}
