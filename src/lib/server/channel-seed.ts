/**
 * **BS と CS は、スキャンしなくても最初から局が並ぶようにする。**
 *
 * 地上波は地域で顔ぶれが変わるので総当たりで探すしかないが、BS と CS は
 * 全国どこでも同じ。総当たりすると BS だけで 92 か所を選局し、局の居るところでは
 * NIT が来るまで待つので数分かかる。決まった表を持っていれば、その待ちが要らない。
 *
 * **入れるのは、局が1つも無いときだけ** (初めて起こしたとき)。一度でもスキャン
 * したら触らない — 利用者が BS を消した (アンテナが無いなど) のに戻ってくるのは困る。
 * 入れるのは、受けられるチューナーがある種別だけ。局の入れ替え (BS の再編など) で
 * 表が古くなったら、画面のスキャンで上書きできる。
 *
 * エージェントに繋がったときと、チューナーが増減したときに見る (runtime.ts)。
 * 表は Khronos31/hassio-addons の denpa アドオンが初回起動で入れていたもの (MIT)
 */
import type { ChannelType } from '../types';
import SEED from './channel-seed.json';
import { refresh as scanState } from './scan';
import { type AgentChannel, getChannels, getTuners, putChannels } from './tuner';

const TYPES: ChannelType[] = ['BS', 'CS'];

/**
 * 入れるべきなら入れる。入れた種別を返す (無ければ空)。
 *
 * 局を入れたらエージェントが `channels` を知らせてくるので、取り込み直しと
 * 番組表の集め直しはその知らせで走る (runtime.ts)。ここでは預けるだけ
 */
export async function seedChannels(): Promise<ChannelType[]> {
    /*
     * **スキャンの最中は入れない。** スキャンは結果を最後にまとめて預けるので、その間は
     * 局が空のまま。そこへチューナーの知らせ (選局のたびに来る) で割り込むと、
     * スキャンの途中で標準の表に切り替わり、番組表集めがそちらへ走る (レビュー指摘)
     */
    if (scanState().state === 'running') return [];
    const [tuners, channels] = await Promise.all([getTuners(), getChannels()]);
    if (channels.length > 0) return [];
    const receivable = new Set(tuners.filter((t) => !t.disabled).flatMap((t) => t.types));
    const types = TYPES.filter((type) => receivable.has(type));
    if (types.length === 0) return [];

    const seed = (SEED as AgentChannel[]).filter((c) => types.includes(c.type));
    await putChannels(seed, types);
    console.log(`[channels] ${types.join(' / ')} の局を標準の表から入れました (${seed.length} TS)`);
    return types;
}
