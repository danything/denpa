import { config } from './config';

/**
 * エージェントが起きたことを教えてくれる口 (`GET /denpa/events`, SSE)。
 *
 * これが使えると、チューナーの様子もスキャンの進み具合も「覗きに行く」必要がない。
 * 定期実行は**知らせが途切れたときの保険**として残してある
 * (つなぎ直しは下でやっているが、黙って止まる可能性は消せない)。
 *
 * 流れてくるもの:
 *
 * | イベント | denpa の使い道 |
 * | --- | --- |
 * | `tuners` | チューナー画面を更新する |
 * | `scan` | スキャンの進み具合を画面へ流す |
 * | `channels` | スキャンで局が入れ替わった。取り込み直す |
 */

export interface AgentEvent {
    name: string;
    data: Record<string, unknown>;
}

/** つなぎ直しの待ち。すぐ繋ぎ直すと、相手が落ちている間に叩き続けることになる */
const RETRY_MIN = 1000;
const RETRY_MAX = 60_000;

/** SSE の1ブロックを解釈する。`event:` と `data:` だけ見れば足りる */
export function parseBlock(block: string): AgentEvent | null {
    let name = '';
    let data = '';
    for (const line of block.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (name === '') return null;
    try {
        return { name, data: data === '' ? {} : (JSON.parse(data) as Record<string, unknown>) };
    } catch {
        return { name, data: {} };
    }
}

/**
 * 流れてきたバイト列をブロックに割る。
 * SSE の区切りは空行なので、途中で切れた分は次のチャンクまで持ち越す。
 */
export async function* blocks(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = '';
    // @ts-expect-error bun/node のストリームは非同期反復できる
    for await (const chunk of stream) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let at = buffer.indexOf('\n\n');
        while (at !== -1) {
            yield buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            at = buffer.indexOf('\n\n');
        }
    }
}

/**
 * 繋ぎっぱなしにして、届いたものを渡す。切れたら間を置いて繋ぎ直す。
 * 戻り値を呼ぶと止まる。
 *
 * `onReachable` は**繋がる/繋がらないが切り替わったときだけ**呼ぶ。一瞬の切れで
 * 鳴らさないよう、繋がらない状態が `agentDownGrace` 続いて初めて `false`。起動時に
 * すんなり繋がったときは何も呼ばない (「復帰」ではないため) — `false` を出した
 * あとに繋がったときだけ `true`。エージェントが黙って落ちても、録画が失敗するまで
 * 気付けなかったのを埋める (webhook は `runtime.ts` が繋ぐ)
 */
export function listen(
    onEvent: (event: AgentEvent) => void,
    onReachable?: (up: boolean) => void,
): () => void {
    let stopped = false;
    const controller = new AbortController();
    let retry = RETRY_MIN;
    /** いま繋がっていると報告済みか。null は起動直後 (まだどちらも報告していない) */
    let reachable: boolean | null = null;
    /** 繋がらなくなった時刻。猶予を測る起点。繋がっている間は null */
    let downSince: number | null = null;

    const loop = async () => {
        while (!stopped) {
            try {
                const res = await fetch(`${config.agentUrl}/denpa/events`, {
                    signal: controller.signal,
                    headers: { Accept: 'text/event-stream' },
                });
                if (!res.ok || res.body === null) throw new Error(`/denpa/events -> ${res.status}`);

                // 繋がった時点で待ち時間を戻す。長く繋がっていたのに1度切れただけで
                // 1分待つ、ということにならないように
                retry = RETRY_MIN;
                downSince = null;
                // 落ちていると知らせたあとに繋がったときだけ「復帰」を鳴らす
                if (reachable === false) onReachable?.(true);
                reachable = true;
                console.log('[agent] 知らせの購読を開始しました');

                for await (const block of blocks(res.body)) {
                    const event = parseBlock(block);
                    if (event !== null) onEvent(event);
                }
                if (!stopped) console.warn('[agent] 知らせが途切れました。繋ぎ直します');
            } catch (error) {
                if (stopped) return;
                console.warn(
                    `[agent] 知らせに繋げません (${Math.round(retry / 1000)}秒後に再試行): ${error}`,
                );
            }
            // 繋がらない状態が猶予を超えて続いたら、一度だけ「落ちている」を鳴らす
            if (downSince === null) downSince = Date.now();
            if (reachable !== false && Date.now() - downSince >= config.agentDownGrace) {
                reachable = false;
                onReachable?.(false);
            }
            if (stopped) return;
            await new Promise((resolve) => setTimeout(resolve, retry));
            retry = Math.min(retry * 2, RETRY_MAX);
        }
    };

    void loop();

    return () => {
        stopped = true;
        controller.abort();
    };
}
