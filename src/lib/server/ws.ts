/**
 * WebSocket の受け口。**入口 (`server.js`) の `Bun.serve` に間借りする。**
 *
 * ライブ視聴は映像・音声・字幕・データ放送を1本の接続に多重化する作りなので
 * ([stream.md](../../../docs/stream.md) §5.3)、`Request` → `Response` では足りない。
 *
 * 枠の組み立て (RFC6455) も ping/pong も詰まり具合の面倒も **bun が見る**。
 * こちらが書くのは、多重化の頭を付けることと、誰に配るかだけ。
 *
 * ## なぜ入口が別に居るのか
 *
 * bun の `node:http` (adapter-node が乗っている) は WebSocket の握手ができず、
 * `svelte-adapter-bun` も今の kit には挿し込めない (試したことは `server.js` の冒頭)。
 * そこで `server.js` の `Bun.serve` が WebSocket だけ受け、残りは adapter-node へ流す。
 * 入口はアプリの束の外に居るので直に import できない。`globalThis` 越しに渡す。
 */

import type { ServerWebSocket, WebSocketHandler } from 'bun';

/** 入口が見る名前。`server.js` と揃えること */
const LIVE = '__denpaLive';

/** 溜まってよい量。超えたら捨ててよいもの (`droppable`) を捨てる。何を捨ててよいかは live.ts の `hand` */
const BACKLOG_LIMIT = 4 * 1024 * 1024;

/** 接続1本ぶんの持ち物。`server.upgrade()` に渡して `ws.data` になる */
interface SocketData {
    url: URL;
    connection: Connection | null;
}

/** 開いている1本。**送るのは binary、受けるのは小さな指示だけ** */
export class Connection {
    /** ブラウザからの指示。JSON で解けなかったものは渡さない */
    onmessage: ((message: Record<string, unknown>) => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(private readonly ws: ServerWebSocket<SocketData>) {}

    /**
     * 1つ送る。**多重化の頭を自分で付ける** (stream.md §5.3)。
     *
     *     [1 byte: 種別][8 bytes: PTS (90kHz, BE)][中身...]
     *
     * 時刻は受け側の物差し (焼く道は mp4 の 0 起点、生の道は放送の PTS)。運ぶのは
     * 字幕だけで、映像・データ放送・制御は 0 を渡す — 字幕を絵と同じ物差しに乗せるため。
     *
     * @param droppable 詰まっているときに捨ててよいか。映像の中身 (fMP4 / 生の TS) だけ true
     */
    send(kind: number, pts: bigint, payload: Uint8Array, droppable = false): void {
        if (droppable && this.ws.getBufferedAmount() > BACKLOG_LIMIT) return;
        const out = new Uint8Array(9 + payload.length);
        out[0] = kind;
        new DataView(out.buffer).setBigUint64(1, pts);
        out.set(payload, 9);
        this.ws.sendBinary(out);
    }

    /** bun から渡されたものを解く。**JSON 以外は黙って捨てる** */
    receive(message: string | Buffer): void {
        if (typeof message !== 'string') return;
        try {
            const parsed: unknown = JSON.parse(message);
            if (typeof parsed === 'object' && parsed !== null) {
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
     * 握手してよいか。**握手より前に呼ばれる。**
     *
     * ここで断れば普通の HTTP として返せるので、理由を伝えられる。
     * 握手したあとに切ると、ブラウザには「繋がらない」としか映らない。
     */
    accept(url: URL): boolean;
    open(connection: Connection): void;
}

const routes = new Map<string, Route>();

/** この道に来た接続を受け持つ。ライブ視聴が `/api/live/socket` で登録する */
export function serve(pathname: string, route: Route): void {
    routes.set(pathname, route);
}

/**
 * 入口へ渡すもの。**遅延で引く。**
 *
 * `Bun.serve` は起動時にこれを1度だけ受け取るが、アプリが読み込まれるのは
 * そのあとになりうる。**入口側は毎回 `globalThis` を引き直す**ので、
 * ここに置くのは1回で足りる。
 */
interface LiveEntry {
    /** そもそも受け持つ道か。**断り方を変えるために `accept` と分けてある** */
    handles(url: URL): boolean;
    /** 握手してよいか。ここで札を使い切る */
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
