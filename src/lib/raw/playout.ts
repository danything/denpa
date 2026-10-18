/**
 * **変換せずに送る経路の時計と貯め方** (docs/stream.md#放送そのままmpeg-2を送る)。
 *
 * エンコードする経路では MSE が時計を持っていて (`video.currentTime`)、貯めているぶんも
 * `buffered` で見えた。変換しない経路は自前で鳴らすので、どちらも自分で持つ。
 *
 * ## 時計は音
 *
 * **鳴っている音を時計にする。** 音は途切れると誰でも気づくが、映像は1コマ遅れても
 * 気づかれにくい。だから音は届いた順に隙間なく並べ (Web Audio の時間の上に予約する)、
 * 映像は「いま鳴っている音の PTS」を追いかけて、番が来たコマを出す (worker 側)。
 * 放送の PTS は音と映像で同じ時計 (PCR) に乗っているので、それでリップシンクが合う。
 *
 * 音を鳴らせないとき (自動再生を断られた) は、壁時計を時計にする (`now` を渡す側が選ぶ)。
 *
 * ## 貯め方はエンコードする経路と同じ考え
 *
 * 貯まった音の尺が `target` に届いてから鳴らし始め、**使い切ったら止まって貯め直す**。
 * 止まったことは呼ぶ側に返す — 貯める量を伸ばすかどうか (`pacing.nextTarget`) は
 * エンコードする経路と同じものを使う。溜まりすぎたら (手元の時計と放送の時計のずれ、裏に回った
 * タブが戻ったとき) 放送の今へ飛ぶ。エンコードする経路のように 1.05倍で詰めることはしない —
 * 音を速めると音程が変わる (MSE は保ったまま速めてくれていた)。
 *
 * ## 追っかけは放送の今を追わない (`follow`)
 *
 * 互換モードの追っかけ (`RawEngine` の `follow`) は録画を観ているので、**溜まっても飛ばない** —
 * サーバは倍速で送り込んでくる (`server/chase.ts`) ので、溜まりは伸び続けるのが普通。
 * **止めて再開は止めた所から** (止めている間も届いたぶんは捨てない。溢れないようにするのは worker の側)。
 *
 * ## 録画も同じ決め方に、飛ぶ先と終わりを足す
 *
 * 互換モードの観る画面 (`canvas-player.ts`) も `follow` で鳴らす — 止めたら位置を保ち、そこから再開し、
 * 今へは飛ばない。足すのは2つ:
 *
 * - **飛ぶ先** (`reset` の `from`)。サーバは飛び先の少し手前 (キーフレーム・1 秒前) から流してくるので、
 *   手前のぶんは鳴らさず、ここから鳴らし始める
 * - **終わり** (`finish`)。もう届かないと言われたら、貯めが `target` に届かなくても残りを鳴らし、
 *   使い切ったら貯め直さずに `end` を返す
 *
 * DOM も Web Audio も触らないので、ここだけ単体で確かめられる (`playout.test.ts`)。
 */

import { CLOCK } from '#lib/ts/pes.js';

/** 鳴らし始めを予約するときの先回り (秒)。今すぐにすると頭が欠ける */
export const LEAD = 0.05;
/** 残りがこれを切ったら「使い切った」(秒) */
export const DRY = 0.03;
/** 溜まりがこれだけ `target` を超えたら飛ぶ (秒) */
export const SLACK = 1;
/** 飛ぶまでに溜まりすぎが続く時間 (秒)。**一瞬の塊では飛ばない** */
export const SLACK_FOR = 3;
/** 終わりと言われてから、鳴らすものが1つも来ないまま終わりにするまで (秒。`finish`) */
export const LAST_WAIT = 2;

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
    /** 溜まりすぎたので放送の今へ飛んだ。予約しているものを止めて、予約し直す */
    | { kind: 'jump'; schedule: Scheduled<T>[] }
    /** 終わりまで鳴らした (`finish` のあと)。貯め直さない */
    | { kind: 'end' };

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
    /** 放送の今を追わないか (追っかけ。上の説明) */
    follow = false;
    /** 止めた位置・飛ぶ先 (`follow` のとき)。鳴らし始めはここから */
    private resumeAt: number | null = null;
    /** もう届かないか (`finish`)。録画の尻まで読んだ */
    private finished = false;
    /** 終わりと言われてから鳴らすものが無いのに気づいた時刻 (時計の秒)。まだなら NaN */
    private finishedAt = Number.NaN;

    constructor(target: number) {
        this.target = target;
    }

    get playing(): boolean {
        return this.running;
    }

    /** いま鳴っている PTS。**鳴らしていなければ null** (映像もそこで止まる) */
    position(now: number): number | null {
        if (!this.running) return null;
        return this.origin + (now - this.base) * CLOCK;
    }

    /** 届いたいちばん新しい音の終わり。貯まっている量を見るのに使う */
    get newest(): number | null {
        const last = this.chunks.at(-1);
        return last === undefined ? null : end(last);
    }

    /**
     * 手元にあと何秒ぶん持っているか。**鳴らしていなければ貯まっている尺** (追っかけは鳴らし始める所から
     * 数える。飛び先より手前のぶんは鳴らさないので入れない)
     */
    lead(now: number): number {
        const newest = this.newest;
        if (newest === null) return 0;
        const from = this.position(now) ?? this.startFrom();
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
            // 止めている間は溜め込まない。鳴らし直すときは放送の今から (追っかけは止めた所からなので捨てない)
            if (this.held && !this.follow) this.keepLast(this.target + SLACK);
            return null;
        }
        const when = this.base + (chunk.pts - this.origin) / CLOCK;
        if (when + chunk.duration / CLOCK <= now) {
            this.chunks.pop();
            return null;
        }
        return { chunk, when: Math.max(when, now), offset: Math.max(0, now - when) };
    }

    /** 刻むたびに呼ぶ。**鳴らし始め・止まり・飛びはここで決まる** */
    tick(now: number): Tick<T> {
        if (!this.running) {
            const lead = this.lead(now);
            /*
             * もう届かないのに鳴らすものが無い (飛んだ先が尻の先だった)。**少し待ってから** 終わりにする —
             * 尻まで読んだと言われた時点では、渡したぶんの音がまだデコードできて戻ってきていないことがある
             */
            if (this.finished && !this.held && lead < DRY) {
                if (Number.isNaN(this.finishedAt)) this.finishedAt = now;
                if (now - this.finishedAt < LAST_WAIT) return { kind: 'none' };
                this.finished = false;
                return { kind: 'end' };
            }
            // 終わりまで届いていれば、貯めが足りなくても残りを鳴らす
            if (this.held || lead < DRY || (lead < this.target && !this.finished)) return { kind: 'none' };
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
            if (!this.finished) return { kind: 'stall' };
            this.finished = false;
            return { kind: 'end' };
        }
        if (!this.follow && lead > this.target + SLACK) {
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

    /**
     * 止める。**再開は放送の今から** (貯め直してから)。追っかけ (`follow`) は**止めた所から** —
     * 鳴り終わったぶんだけ捨てて、止めた位置を覚える (`now` が要る)
     */
    hold(now?: number): void {
        const at = now === undefined ? null : this.position(now);
        this.held = true;
        this.running = false;
        this.overSince = Number.NaN;
        if (!this.follow) {
            this.keepLast(this.target + SLACK);
            return;
        }
        if (at === null) return;
        this.resumeAt = at;
        this.chunks = this.chunks.filter((chunk) => end(chunk) > at);
    }

    resume(): void {
        this.held = false;
    }

    /**
     * 選局し直したとき・録画で飛んだとき。**前の音は1つも残さない。**
     * `from` (90kHz。届く音と同じ物差し) を渡すと、追っかけ (`follow`) はそこから鳴らし始める
     */
    reset(from: number | null = null): void {
        this.running = false;
        this.chunks = [];
        this.overSince = Number.NaN;
        this.resumeAt = from;
        this.finished = false;
        this.finishedAt = Number.NaN;
    }

    /**
     * 鳴らし始める所を決め直す (`reset` の `from` と同じ)。**物差しを届いた音に合わせてから渡すとき** —
     * 放送の PTS は一周するので、届いた最初のコマの近くに伸ばしてから決める (`engine.ts`)
     */
    aim(from: number): void {
        this.resumeAt = from;
    }

    /** もう届かない (録画の尻まで読んだ)。残りを鳴らしきったら `end` を返す */
    finish(): void {
        this.finished = true;
        this.finishedAt = Number.NaN;
    }

    /** 追っかけで鳴らし始める所。止めた所・飛ぶ先 (無ければいちばん古いもの) */
    private startFrom(): number {
        const oldest = this.chunks[0]!.pts;
        return this.follow && this.resumeAt !== null ? Math.max(oldest, this.resumeAt) : oldest;
    }

    /** 放送の今から `target` 手前で鳴らし始める。追っかけは止めた所・飛ぶ先 (無ければいちばん古いもの) から */
    private startAt(now: number): Scheduled<T>[] {
        const newest = this.newest as number;
        const oldest = this.chunks[0]!.pts;
        this.origin = this.follow ? this.startFrom() : Math.max(oldest, newest - this.target * CLOCK);
        this.resumeAt = null;
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
