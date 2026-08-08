/**
 * 届いた字幕を、映像に合わせて出す順に並べる。**DOM を触らない。**
 *
 * 時刻は**受け側の再生位置 (mp4 の秒)** で持つ。サーバが添えてくるものが
 * 既にその物差しになっている — 映像と字幕を**同じ ffmpeg** で焼いていて、
 * 入口で 0 に寄せる幅が両方に同じだけ効くため (`server/captions.ts` に実測)。
 *
 * **ここは長いこと「届いた時点の再生位置」に置いていた。** 焼く手間のぶん
 * 字幕のほうが先に届くので、その量を測って足し引きしようとして3回外した
 * (`docs/stream.md` §5.4)。測れないものを測ろうとしていた — いまは
 * **測らずに、書いてある時刻に置く**。
 */

/** 90kHz。取り決めの時刻はこの刻み (`docs/stream.md` §5.3) */
export const CLOCK = 90_000;

/** 出す時刻と、その絵。`bitmap` が null なら「消す」 */
export interface Cue {
    /** 受け側の再生位置 (秒)。ここを追い越したら出す */
    at: number;
    bitmap: ImageBitmap | null;
}

/**
 * 溜めておく上限。**止めて見ている人のぶん。**
 *
 * 押して止めている間も受け取り続けるので、放っておくと際限なく増える。
 * 遅れて見られる長さ (`live-player` の `KEEP` = 5分) を、字幕の出る間隔
 * (実機で毎分18回) で数えたぶんより多めに採る
 */
export const KEEP_CUES = 200;

/**
 * 再生位置に合うものを選ぶ。**過ぎたものの中でいちばん新しい1つ。**
 *
 * 字幕は次が来るまで出しっぱなしなので、「いま出すもの」は
 * **時刻が再生位置を追い越していない中の、最後の1つ**になる。
 * 跳んだ直後もこれで正しく追いつく (間の枚を1つずつ出す必要が無い)。
 *
 * @returns 出すもの。何も出さないなら null
 */
export function currentCue(cues: Cue[], at: number): Cue | null {
    let found: Cue | null = null;
    for (const cue of cues) {
        if (cue.at > at) break;
        found = cue;
    }
    return found;
}

/**
 * 出し終わったものを捨てる。**いま出している1つは残す。**
 *
 * 残さないと、次が来るまでの間に出すものが無くなる (字幕は出しっぱなし)。
 * 上限を超えたぶんは、古いほうから落とす。
 *
 * @param at いまの再生位置 (秒)
 */
export function trimCues(cues: Cue[], at: number): Cue[] {
    // 過ぎたものの中でいちばん新しい1つより前は、もう使わない
    let keepFrom = 0;
    for (let i = 0; i < cues.length; i++) {
        if (cues[i].at > at) break;
        keepFrom = i;
    }
    const kept = cues.slice(keepFrom);
    return kept.length > KEEP_CUES ? kept.slice(kept.length - KEEP_CUES) : kept;
}

/**
 * 並びを保ったまま入れる。**届く順は前後しうる。**
 *
 * 同じ時刻のものが来たら**後から来たほうを採る** (出し直しなので新しいほうが正しい)。
 */
export function insertCue(cues: Cue[], cue: Cue): Cue[] {
    if (cues.length === 0 || cues[cues.length - 1].at < cue.at) return [...cues, cue];
    const out = cues.filter((held) => held.at !== cue.at);
    const at = out.findIndex((held) => held.at > cue.at);
    if (at < 0) return [...out, cue];
    return [...out.slice(0, at), cue, ...out.slice(at)];
}
