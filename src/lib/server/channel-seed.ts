/**
 * **BS と CS は、スキャンしなくても最初から局が並ぶようにする。**
 *
 * 地上波は地域で顔ぶれが変わるので総当たりで探すしかないが、BS と CS は
 * 全国どこでも同じ。総当たりすると BS だけで 92 か所を選局し、局の居るところでは
 * NIT が来るまで待つので数分かかる。決まった表を持っていれば、その待ちが要らない。
 *
 * **入れるのは、その種別の局が1つも無いとき** (BS と CS それぞれ)。地上波だけ
 * スキャンしてある環境にも入る — 「局が1つも無いときだけ」にしていた頃は、前から
 * 地上波を入れていた環境 (Home Assistant のアドオンの更新など) に BS/CS が永久に
 * 入らず、アドオンが自前で追記していた。1局でもあれば触らない (スキャンした結果を
 * 上書きしない)。入れるのは、受けられるチューナーがある種別だけ。局の入れ替え
 * (BS の再編など) で表が古くなったら、画面のスキャンで上書きできる。
 *
 * エージェントに繋がったときと、チューナーの知らせ (選局のたびに来る) で見る (runtime.ts)。
 * 表は Khronos31/hassio-addons の denpa アドオンが初回起動で入れていたもの (MIT)
 */
import type { ChannelType } from '../types';
import SEED from './channel-seed.json';
import { refresh as scanState } from './scan';
import { type AgentChannel, getTuners, putChannels } from './tuner';

const TYPES: ChannelType[] = ['BS', 'CS'];

/**
 * 入れるべきなら入れる。入れた種別を返す (無ければ空)。
 *
 * **見るのは局の一覧を取り込むとき** (runtime.ts の `syncChannels`。起動時と
 * `CHANNEL_SYNC_INTERVAL` ごと)。条件は「一覧に BS/CS が無い」なので、一覧を読んだ
 * その場で見るのが素直。繋がった・選局されたといった出来事に合わせていた頃は、
 * 起動直後にすんなり繋がると誰も呼ばず、いつまでも入らなかった (#376)。
 * 局の一覧は呼ぶ側が読んだものを受け取り、チューナーは入れる候補があるときだけ聞く。
 *
 * 局を入れたらエージェントが `channels` を知らせてくるので、取り込み直しと
 * 番組表の集め直しはその知らせで走る (runtime.ts)。ここでは預けるだけ
 */
export async function seedChannels(channels: AgentChannel[]): Promise<ChannelType[]> {
    /*
     * **スキャンの最中は入れない。** スキャンは結果を最後にまとめて預けるので、その間は
     * 局が空のまま。そこへ割り込むと、スキャンの途中で標準の表に切り替わり、
     * 番組表集めがそちらへ走る (レビュー指摘)
     */
    if (scanState().state === 'running') return [];
    const present = new Set(channels.map((c) => c.type));
    const missing = TYPES.filter((type) => !present.has(type));
    if (missing.length === 0) return [];
    const receivable = new Set((await getTuners()).filter((t) => !t.disabled).flatMap((t) => t.types));
    const types = missing.filter((type) => receivable.has(type));
    if (types.length === 0) return [];

    const seed = (SEED as AgentChannel[]).filter((c) => types.includes(c.type));
    await putChannels(seed, types);
    console.log(`[channels] ${types.join(' / ')} の局を標準の表から入れました (${seed.length} TS)`);
    return types;
}
