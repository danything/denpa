/**
 * WebSocket のエンドポイント。**入口 (`server.js`) の `Bun.serve` に間借りする。**
 *
 * ライブ視聴は映像・音声・字幕・データ放送を 1 本の接続に多重化する作りなので
 * ([stream.md](../../../docs/stream.md#websocket-プロトコル))、`Request` → `Response` では足りない。
 *
 * フレームの組み立て (RFC6455) も ping/pong も送信の詰まりも **bun が受け持つ**。
 * こちらが書くのは、多重化のヘッダを付けることと、誰に配るかだけ。
 *
 * ## なぜ入口が別にあるのか
 *
 * 公式の adapter-bun は `Bun.serve` に `websocket` を渡す手段を持たない (`server.js` の冒頭)。
 * そこで `server.js` が adapter の `Bun.serve` に `websocket` を足し、ハンドシェイクだけ SvelteKit の手前で受ける。
 * 入口はアプリのバンドルの外にあるので直に import できない。`globalThis` 越しに渡す。
 */

import type { ServerWebSocket, WebSocketHandler } from "bun";

/** 入口が見る名前。`server.js` と揃えること */
const LIVE = "__denpaLive";

/** 溜まってよい量。超えたら捨ててよいもの (`droppable`) を捨てる。何を捨ててよいかは live.ts の `hand` */
const BACKLOG_LIMIT = 4 * 1024 * 1024;

/** 接続 1 本ぶんの持ち物。`server.upgrade()` に渡して `ws.data` になる */
interface SocketData {
  url: URL;
  connection: Connection | null;
}

/** 開いている 1 本。**送るのは binary、受けるのは小さな指示だけ** */
export class Connection {
  /** ブラウザからの指示。JSON でデコードできなかったものは渡さない */
  onmessage: ((message: Record<string, unknown>) => void) | null = null;
  onclose: (() => void) | null = null;

  /** 開いてから、溜まりすぎて捨てた塊 (`droppable`) の数。画面への `pace` の通知に載せる (`live.ts` の `attend`) */
  dropped = 0;

  constructor(private readonly ws: ServerWebSocket<SocketData>) {}

  /** 送れずに溜まっている量 (バイト) */
  get backlog(): number {
    return this.ws.getBufferedAmount();
  }

  /**
   * 1 つ送る。**多重化のヘッダを自分で付ける** (stream.md#websocket-プロトコル)。
   *
   *     [1 byte: 種別][8 bytes: PTS (90kHz, BE)][中身...]
   *
   * 時刻は受け側の物差し (エンコードの経路は mp4 の 0 起点、放送そのままの経路は放送の PTS)。運ぶのは
   * 字幕だけで、映像・データ放送・制御は 0 を渡す。字幕を映像と同じ物差しに乗せるため。
   *
   * @param droppable 詰まっているときに捨ててよいか。映像の中身 (fMP4 / そのままの TS) だけ true
   */
  send(
    kind: number,
    pts: bigint,
    payload: Uint8Array,
    droppable = false,
  ): void {
    if (droppable && this.ws.getBufferedAmount() > BACKLOG_LIMIT) {
      this.dropped++;
      return;
    }
    const out = new Uint8Array(9 + payload.length);
    out[0] = kind;
    new DataView(out.buffer).setBigUint64(1, pts);
    out.set(payload, 9);
    this.ws.sendBinary(out);
  }

  /**
   * 溜まりが捨て始める量 (`BACKLOG_LIMIT`) を超えているか。捨てられないもの (追っかけの元の TS) は、
   * これを見て読むほうを止める (live.ts の `openChase`)
   */
  get congested(): boolean {
    return this.ws.getBufferedAmount() > BACKLOG_LIMIT;
  }

  /** bun から渡されたものをデコードする。**JSON 以外は黙って捨てる** */
  receive(message: string | Buffer): void {
    if (typeof message !== "string") return;
    try {
      const parsed: unknown = JSON.parse(message);
      if (typeof parsed === "object" && parsed !== null) {
        this.onmessage?.(parsed as Record<string, unknown>);
      }
    } catch {
      // 読めない指示は捨てる。切るほどのことではない
    }
  }

  finish(): void {
    this.onclose?.();
    this.onclose = null;
  }
}

interface Route {
  /**
   * ハンドシェイクしてよいか。**ハンドシェイクより前に呼ばれる。**
   *
   * ここで断れば普通の HTTP として返せるので、理由を伝えられる。
   * ハンドシェイクしたあとに切ると、ブラウザには「繋がらない」としか映らない。
   */
  accept(url: URL): boolean;
  open(connection: Connection): void;
}

const routes = new Map<string, Route>();

/** このパスに来た接続を受け持つ。ライブ視聴が `/api/live/socket` で登録する */
export function serve(pathname: string, route: Route): void {
  routes.set(pathname, route);
}

/**
 * 入口へ渡すもの。**遅延で引く。**
 *
 * `Bun.serve` は起動時にこれを 1 度だけ受け取るが、アプリが読み込まれるのは
 * そのあとになりうる。**入口側は毎回 `globalThis` を引き直す**ので、
 * ここに置くのは 1 回で足りる。
 */
interface LiveEntry {
  /** そもそも受け持つパスか。**断り方を変えるために `accept` と分けてある** */
  handles(url: URL): boolean;
  /** ハンドシェイクしてよいか。ここでチケットを使い切る */
  accept(url: URL): boolean;
  websocket: WebSocketHandler<SocketData>;
}

const entry: LiveEntry = {
  handles(url) {
    return routes.has(url.pathname);
  },
  accept(url) {
    return routes.get(url.pathname)?.accept(url) === true;
  },
  websocket: {
    open(ws) {
      const route = routes.get(ws.data.url.pathname);
      if (route === undefined) {
        ws.close();
        return;
      }
      const connection = new Connection(ws);
      ws.data.connection = connection;
      route.open(connection);
    },
    message(ws, message) {
      ws.data.connection?.receive(message);
    },
    close(ws) {
      ws.data.connection?.finish();
    },
  },
};

(globalThis as Record<string, unknown>)[LIVE] = entry;
