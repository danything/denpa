import { agentFetch } from "./agent-client";
import { config } from "./config";
import { chunks } from "./stream";

/**
 * エージェントが起きたことを知らせるエンドポイント (`GET /denpa/events`。SSE)。
 *
 * これがあれば、チューナーの様子も局の入れ替わりも定期的に問い合わせなくてよい。
 * 定期実行は**通知が途切れたときの保険**として残してある
 * (下で繋ぎ直すが、黙って止まる可能性は消せない)。
 *
 * 流れてくるイベント
 *
 * | イベント | denpa の使い道 |
 * | --- | --- |
 * | `tuners` | 設定の「チューナー」を更新し、開いた選局をロゴの取得が共有する |
 * | `channels` | スキャンで局が入れ替わった。取り込み直す |
 * | `card` | カードが契約の更新 (EMM) を受け入れた。10 秒置いて契約を確かめ直す (runtime.ts) |
 *
 * スキャンの進み具合は流れてこない (走らせているのは denpa 自身。`scan.ts`)。
 */

interface AgentEvent {
  name: string;
}

/** つなぎ直しの待ち。すぐ繋ぎ直すと、相手が落ちている間に呼び続けることになる */
const RETRY_MIN = 1000;
const RETRY_MAX = 60_000;

/**
 * SSE の 1 ブロックを解釈する。読むのは `event:` だけ。エージェントの `data:` はいつも `{}` で
 * (agent の `Events.cs`)、どのイベントも名前だけで足りる
 */
export function parseBlock(block: string): AgentEvent | null {
  let name = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
  }
  return name === "" ? null : { name };
}

/**
 * 流れてきたバイト列をブロックに割る。
 * SSE の区切りは空行なので、途中で切れた分は次のチャンクまで持ち越す。
 */
export async function* blocks(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of chunks(stream)) {
    buffer += decoder.decode(chunk, { stream: true });
    let at = buffer.indexOf("\n\n");
    while (at !== -1) {
      yield buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      at = buffer.indexOf("\n\n");
    }
  }
}

/**
 * 繋ぎっぱなしにして、届いたものを渡す。切れたら間を置いて繋ぎ直す。
 * 戻り値を呼ぶと止まる。
 *
 * `onReachable` は**繋がる/繋がらないが切り替わったときだけ**呼ぶ。一瞬の切れで
 * 鳴らさないよう、繋がらない状態が `agentDownGrace` 続いて初めて `false`。起動時に
 * すんなり繋がったときは何も呼ばない (「復帰」ではないため)。`false` を出した
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
        const res = await agentFetch("/denpa/events", {
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        });
        if (!res.ok || res.body === null)
          throw new Error(`/denpa/events -> ${res.status}`);

        // 繋がった時点で待ち時間を戻す。長く繋がっていたのに 1 度切れただけで
        // 1 分待つ、ということにならないように
        retry = RETRY_MIN;
        downSince = null;
        // 落ちていると知らせたあとに繋がったときだけ「復帰」を鳴らす
        if (reachable === false) onReachable?.(true);
        reachable = true;
        console.log("[agent] 通知の購読を開始しました");

        for await (const block of blocks(res.body)) {
          const event = parseBlock(block);
          if (event !== null) onEvent(event);
        }
        if (!stopped) console.warn("[agent] 通知が途切れました。繋ぎ直します");
      } catch (error) {
        if (stopped) return;
        console.warn(
          `[agent] 通知に繋げません (${Math.round(retry / 1000)} 秒後に再試行): ${error}`,
        );
      }
      // 繋がらない状態が猶予を超えて続いたら、一度だけ「落ちている」を鳴らす
      if (downSince === null) downSince = Date.now();
      if (
        reachable !== false &&
        Date.now() - downSince >= config.agentDownGrace
      ) {
        reachable = false;
        onReachable?.(false);
      }
      if (stopped) return;
      await Bun.sleep(retry);
      retry = Math.min(retry * 2, RETRY_MAX);
    }
  };

  void loop();

  return () => {
    stopped = true;
    controller.abort();
  };
}
