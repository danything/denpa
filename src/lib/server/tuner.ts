/**
 * チューナーエージェントを呼ぶところ。
 *
 * **相手が返すのは素のTSだけ**で、局も番組も時刻も、意味を持つものは何も
 * 返ってこない。読むのは denpa の仕事 ([agent.md](../../../docs/agent.md))。
 *
 * **使い方は1つだけ。** 物理チャンネルを丸ごと開く。局を選り分けるのは
 * `ts/service-filter.ts`、番組の切れ目を見るのは `ts/eit.ts`。
 */

import {
    array,
    boolean,
    type Infer,
    literal,
    nullable,
    number,
    object,
    optional,
    type Shape,
    string,
    tolerate,
} from '../shape';
import type { ChannelType } from '../types';
import { config } from './config';
import type { Busy } from './conflict';

/*
 * **エージェントが返すものの形式は、ここで確かめてから型にする** (`shape.ts`)。
 * 相手は別のプロセス (agent/。別のイメージで動くこともある) で、版がずれれば形式もずれる。キャストで型を
 * 付けていた頃は、ずれても「どこかで undefined」としてしか出なかった。
 *
 * **違っていても止めない** (`tolerate`)。版がずれただけで録画が止まるのでは
 * 困るので、警告を出して来たものをそのまま使う。直すのは人
 */
const CHANNEL_TYPE: Shape<ChannelType> = literal('GR', 'BS', 'CS', 'SKY');

/** エージェントが知っているチャンネル。スキャンの結果そのもの */
const AGENT_CHANNEL = object({
    type: CHANNEL_TYPE,
    channel: string,
    networkId: number,
    transportStreamId: number,
    remoteControlKeyId: nullable(number),
    services: array(object({ serviceId: number, serviceType: number, name: string })),
});
export type AgentChannel = Infer<typeof AGENT_CHANNEL>;

const AGENT_TUNER = object({
    index: number,
    name: string,
    types: array(CHANNEL_TYPE),
    disabled: boolean,
    /**
     * エージェントが選ぶ順。小さいほど先に使う。無効なチューナーは null。予約の割り振りはこの順どおりに
     * 使われる前提で数える (`conflict.ts`、docs/agent.md「選ぶ順の約束」)
     */
    rank: nullable(number),
    /** 選局に使うデバイス。エージェントはこれを直に開く */
    device: nullable(string),
    /** 衛星の給電。要る構成だけ */
    lnb: nullable(string),
    /** いま使っているチャンネル。空いていれば null */
    channel: nullable(object({ type: CHANNEL_TYPE, channel: string })),
    users: array(object({ use: string, priority: number })),
    pid: nullable(number),
    error: nullable(string),
});
export type AgentTuner = Infer<typeof AGENT_TUNER>;

const TUNERS = object({ tuners: array(AGENT_TUNER), detected: optional(boolean) });

/** 画面から書き換えられる部分だけ */
export interface TunerConfig {
    name: string;
    types: ChannelType[];
    device: string | null;
    lnb: string | null;
    disabled: boolean;
}

/**
 * 局の内部ID。`networkId * 100000 + serviceId`。
 *
 * 録画も予約も `services.id` を参照しているので、ここを変えると
 * 過去の録画が辿れなくなる (docs/data.md)。
 */
export function serviceKey(networkId: number, serviceId: number): number {
    return networkId * 100000 + serviceId;
}

/** 番組のID。局の内部ID + event_id */
export function programKey(networkId: number, serviceId: number, eventId: number): number {
    return serviceKey(networkId, serviceId) * 100000 + eventId;
}

async function get<T>(path: string, shape: Shape<T>, timeout = 10_000): Promise<T> {
    const res = await fetch(`${config.agentUrl}${path}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
        throw new Error(`エージェント ${path} -> ${res.status} ${await res.text()}`);
    }
    return tolerate(shape, await res.json(), `エージェントの ${path}`);
}

export function getChannels(): Promise<AgentChannel[]> {
    return get('/denpa/channels', array(AGENT_CHANNEL));
}

/**
 * チャンネルスキャンの結果を預ける。
 *
 * **見つけたのは denpa** (総当たりの選局はエージェントに任せるが、NIT と SDT を
 * 読むのはこちら)。それでも控えを持つのはエージェントのほうにする —
 * アンテナに何が映るかは機材ごとの話で、エージェントを増やせば顔ぶれも変わる。
 *
 * `scanned` には**探した種別**を渡す。地上波だけ探したときに全部を置き換えると
 * BS と CS が設定から消える。
 */
export async function putChannels(found: AgentChannel[], scanned: ChannelType[]): Promise<AgentChannel[]> {
    const res = await fetch(`${config.agentUrl}/denpa/channels`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels: found, scanned }),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`チャンネルを保存できません (${res.status}) ${await res.text()}`);
    return tolerate(array(AGENT_CHANNEL), await res.json(), 'エージェントの PUT /denpa/channels');
}

/** 一覧と、定義を書いていないので自分で見つけた状態か (`detected`。設定の「チューナー」に出す) を1度に */
export function tunerList(): Promise<Infer<typeof TUNERS>> {
    return get('/denpa/tuners', TUNERS);
}

export async function getTuners(): Promise<AgentTuner[]> {
    return (await tunerList()).tuners;
}

/**
 * 機材の定義を書き換える。
 *
 * **選局コマンドは無い。** エージェントがデバイスと種別から選局する
 * (渡せると、denpa に入れた人が privileged なチューナー側で好きなコマンドを走らせられる)。
 *
 * **空を渡すと定義そのものが消える** = 自動検出に戻す。
 */
export async function putTuners(tuners: TunerConfig[]): Promise<void> {
    const res = await fetch(`${config.agentUrl}/denpa/tuners`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tuners }),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const error = typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
        throw new Error(typeof error === 'string' ? error : `チューナーを保存できません (${res.status})`);
    }
}

/**
 * 何のために開いたかを伝える印。設定の「チューナー」にそのまま出る。
 *
 * **ASCII だけ**にしてある。番組名は入れず録画IDだけ渡して、読める言葉に直すのは
 * 画面側でやる (routes/settings/reception/tuners.server.ts)。
 */
export type StreamUse =
    | `rec ${number}`
    | `logo ${string}`
    | `epg ${string}`
    | `scan ${string}`
    | `live ${string}`;

/** 録画の利用者の名乗り。読むほう (`recordingOf`) と対にしておく */
export function recordingUse(id: number): StreamUse {
    return `rec ${id}`;
}

/**
 * 録画の利用者 (`recordingUse`) なら、その録画ID。**どの録画がどのチューナーにいるか**を
 * エージェントの一覧から読むのに使う (`recordingHolds`)
 */
export function recordingOf(use: string): number | null {
    const found = /^rec (\d+)$/.exec(use);
    return found === null ? null : Number(found[1]);
}

/**
 * **録画中の予約が、いまどのチューナーにいるか。** 割り振りのなぞり始めの状態になる。
 *
 * 録り始めた予約は割り振り直さない (候補に入れない) が、終わるまでチューナーを塞ぐ。どのチューナーに
 * 入ったかはエージェントが知っているので、一覧の利用者 (`users`) の `rec <録画ID>`
 * (`recordingUse`) から読む。利用者のいるチューナーは今まさに録っているチューナーなので、いる場所を取り違えることは無い。
 * ただし録り始めたのに、まだ使えていない (空き待ちで掛け直している) 録画は数えられない。
 *
 * 録画以外の利用者 (ライブ・番組表集めなど) は入れない。録画には譲る約束なので
 * (docs/agent.md「選ぶ順の約束」)、予約の割り振りには効かない。
 * 終わる時刻の分からない録画 (DB に無い) も入れない
 */
export function recordingHolds(
    tuners: readonly Pick<AgentTuner, 'disabled' | 'rank' | 'channel' | 'users'>[],
    untilOf: (recordingId: number) => number | undefined,
): Busy[] {
    return tuners.flatMap((tuner) => {
        if (tuner.disabled || tuner.rank === null || tuner.channel === null) return [];
        const ends = tuner.users.flatMap((u) => {
            const id = recordingOf(u.use);
            const until = id === null ? undefined : untilOf(id);
            return until === undefined ? [] : [until];
        });
        if (ends.length === 0) return [];
        return [
            {
                type: tuner.channel.type,
                channel: tuner.channel.channel,
                rank: tuner.rank,
                until: Math.max(...ends),
            },
        ];
    });
}

/**
 * チューナーに空きが無い。**待って掛け直せば通る**ので、他の失敗と分ける。
 *
 * 総当たりのスキャンでここを区別できないと、録画中で塞がっていただけの
 * チャンネルを「受信できない」と判断して設定から落としてしまう。
 */
export class TunerBusyError extends Error {}

/**
 * 物理チャンネルを丸ごと開く。**使い方はこれ1つ。**
 *
 * 同じチャンネルを誰かが既に開いていれば、エージェントが選局を共有させる
 * (チューナーは増えない)。空きが無ければ 409 が返るので、呼んだ側は待って掛け直す。
 *
 * `after` の利用者は、もう離れたものとしてエージェントに選ばせる (引き継ぎ。録画を止めて
 * 同じ定期チェックで次を始めるとき。docs/agent.md「選ぶ順の約束」)。知らない古いエージェントは
 * 読み飛ばして、ふつうに選ぶ
 */
export async function openChannelStream(
    type: string,
    channel: string,
    signal: AbortSignal,
    use: StreamUse,
    priority = config.priority.recording,
    after: readonly StreamUse[] = [],
): Promise<ReadableStream<Uint8Array>> {
    const query = new URLSearchParams({ type, channel, priority: String(priority), use });
    for (const leaving of after) query.append('after', leaving);
    const res = await fetch(`${config.agentUrl}/denpa/stream?${query}`, { signal });
    if (!res.ok || res.body === null) {
        const detail = await res.text().catch(() => '');
        if (res.status === 409) throw new TunerBusyError(`チューナーに空きがありません ${detail}`);
        throw new Error(`選局できません (${res.status}) ${detail}`);
    }
    return res.body;
}

/** 空き待ちで掛け直す回数と間隔 (ms)。待つのは前のチャンネルが離れるまで */
const BUSY_TRIES = 3;
const BUSY_WAIT = 700;

/**
 * 開く。**空きが無ければ少し待って掛け直す。**
 *
 * ライブは**チャンネルを変える一瞬だけ、前のチャンネルと合わせて2台要る**。
 * 前のを離してから次を要求しているが、離れたことがエージェントに届くのは非同期なので、
 * 重なる瞬間が残る。地上波は2台しかないため、録画か番組表集めが1台使っていると
 * そこで断られていた (実機で `[live] GR:T15: チューナーに空きがありません`)。
 *
 * **待っているのは前のチャンネルが離れるまで**なので、長くは掛からない。
 * 掛け直すのは空き待ちのときだけ — 選局そのものが駄目なら何度やっても同じ。
 *
 * 録画には使わない。録画は自前で掛け直す (`recorder.openWithRetry`。空き待ちに
 * 限らず、終了時刻まで取り直す)。
 */
export function openWhenFree(
    type: string,
    channel: string,
    signal: AbortSignal,
    use: StreamUse,
    priority: number,
    giveUp: () => boolean,
): Promise<ReadableStream<Uint8Array>> {
    return retryWhileBusy(() => openChannelStream(type, channel, signal, use, priority), giveUp);
}

/**
 * 空き待ちのときだけ掛け直す。**掛け方そのものは渡してもらう。**
 *
 * 分けてあるのは試すため — 本物のエージェントを立てなくても、待ち直しの
 * 判断だけを確かめられる (`tuner.test.ts`)
 */
export async function retryWhileBusy<T>(
    open: () => Promise<T>,
    giveUp: () => boolean = () => false,
    wait: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<T> {
    for (let tries = 0; ; tries++) {
        try {
            return await open();
        } catch (error) {
            if (!(error instanceof TunerBusyError) || tries >= BUSY_TRIES || giveUp()) throw error;
            await wait(BUSY_WAIT);
        }
    }
}

/**
 * **同じ TS を指している枠か。** 指していれば、先に見つけたほうの名前を返す。
 *
 * 衛星は1つの周波数に何本もの TS が入っていて、`BS01_0` のような
 * **相対番号**で選ぶ。ところが実際に何本入っているかは中継ごとに違い、
 * 無い番号を指すと**復調器は先頭の TS を返す** (断ってはくれない)。
 *
 * その結果、実機では 35 枠のうち **9 枠が既に知っている TS の写し**だった
 * (`BS01_3` = `BS01_0`、`BS05_2` と `BS05_3` = `BS05_0` …)。
 *
 * **中身は1つも減りません。** 実機で見つかった BS の 26 TS は、放送自身が
 * 名乗っている 26 TS と一致していました (docs/data.md「相対番号の穴」)。
 */
export function twinOf(found: Iterable<AgentChannel>, entry: AgentChannel): string | null {
    // TSID が分からないものは判断できない。地上波は1周波数1TSなので、そもそも起きない
    if (entry.transportStreamId <= 0) return null;
    for (const other of found) {
        if (other.type === entry.type && other.transportStreamId === entry.transportStreamId) {
            return other.channel;
        }
    }
    return null;
}

/**
 * 写しを落とした一覧。**先に来たほうを残す** (スキャンと同じ決まり)。
 *
 * スキャンでも落としているが、**控えを書いたのが古いスキャンだと写しが残る。**
 * 実機の `channels.json` がまさにそれで、BS 35 枠のうち 9 枠が写しのまま残り、
 * 番組表集めが**同じ TS を二度開き続けて**いた。開く側でも落としておけば、
 * 控えが何であれ二度は開かない。
 */
export function withoutTwins(channels: AgentChannel[]): AgentChannel[] {
    const kept: AgentChannel[] = [];
    for (const channel of channels) {
        if (twinOf(kept, channel) === null) kept.push(channel);
    }
    return kept;
}
