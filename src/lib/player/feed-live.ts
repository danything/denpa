/**
 * **ライブと追っかけの出どころ (Feed)。** WebSocket 1 本で、映像・字幕・データ放送・通知 (`tuned`・`pace`・`timeline` など) を
 * 時刻をそろえて受ける ([stream.md](../../../docs/stream.md#websocket-プロトコル))。
 *
 * ここが受け持つのは、チケットを取って繋ぐこと・指示を送ること・届いた塊を種別で読み分けること・受け取りの速さを測ること。
 * 届いたものをどう使うか (MSE に足す・canvas に流す・字幕を待たせる・段を決める) は再生の核 (`player/core.svelte.ts`) が決める。
 * 段を替えるときに裏で次の段を用意する接続 (`stageStep`) も、同じ繋ぎ方 (`connect`) を使う
 */

import { resolve } from "$app/paths";
import type { ResponseMessage } from "@danything/arib/bml-protocol";
import {
  CAPTION_TEXT_VERSION,
  type CaptionPage,
} from "@danything/arib/caption-text";

import { Throughput } from "#lib/live-adapt.js";
import {
  CHANNEL,
  type Command,
  type Notice,
  SOCKET_PATH,
  TICKET_LIFETIME,
} from "#lib/live.js";

/** 届いた 1 つの塊を、種別で読み分けたもの (`readFrame`) */
export type LiveFrame =
  /** 元の TS (MPEG-2)。先頭の 9 バイト (種別と時刻) を付けたまま、写さずに worker へ移す */
  | { kind: "rawTs"; data: ArrayBuffer }
  /** エンコードしたものの init・媒体 (fMP4)。`data` は先頭の 9 バイトを付けたもの (互換モードは RawEngine へそのまま移す) */
  | { kind: "init" | "media"; body: Uint8Array; data: ArrayBuffer }
  | { kind: "notice"; notice: Notice }
  /** データ放送 (`ResponseMessage`) */
  | { kind: "data"; message: ResponseMessage }
  /** 字幕の 1 枚。`stamp` は映像と同じ物差しの時刻 (90 kHz) */
  | { kind: "caption"; stamp: number; page: CaptionPage }
  /** 読めないもの (壊れた字幕・ほかのバージョンの字幕・知らない種別) */
  | { kind: "skip" };

/** 届いた塊を読み分ける。先頭の 1 バイトが種別、次の 8 バイトが時刻、残りが中身 */
export function readFrame(data: ArrayBuffer): LiveFrame {
  const kind = new DataView(data).getUint8(0);
  const body = new Uint8Array(data, 9);
  if (kind === CHANNEL.rawTs) return { kind: "rawTs", data };
  if (kind === CHANNEL.videoInit) return { kind: "init", body, data };
  if (kind === CHANNEL.videoMedia) return { kind: "media", body, data };
  if (kind === CHANNEL.control)
    return {
      kind: "notice",
      notice: JSON.parse(new TextDecoder().decode(body)) as Notice,
    };
  if (kind === CHANNEL.data)
    return {
      kind: "data",
      message: JSON.parse(new TextDecoder().decode(body)) as ResponseMessage,
    };
  if (kind === CHANNEL.captionText) {
    const stamp = Number(new DataView(data).getBigUint64(1));
    let page: CaptionPage;
    try {
      page = JSON.parse(new TextDecoder().decode(body)) as CaptionPage;
    } catch {
      return { kind: "skip" }; // 壊れた 1 枚。次が来る
    }
    // ほかのバージョンは描かない (置き場所の読み方が違うかもしれない)
    if (page.v !== CAPTION_TEXT_VERSION) return { kind: "skip" };
    return { kind: "caption", stamp, page };
  }
  return { kind: "skip" };
}

/** 繋いだ接続に届いたこと (`LiveFeed.connect`)。どれも、その接続がいまの接続かを呼ぶ側が確かめる */
export interface LiveSocketEvents {
  open?(): void;
  error?(): void;
  close?(): void;
  frame(frame: LiveFrame, data: ArrayBuffer): void;
}

/**
 * ライブと追っかけの接続。**いま使っている WebSocket は 1 本** (`socket`)。1 本に何度でも指示を送れる (`server/live.ts` の `attend`)
 */
export class LiveFeed {
  /** いまの接続。繋いでいなければ null */
  socket: WebSocket | null = null;
  /** 受け取りの速さ (`AdaptSample.throughput`)。届いたものを中身を問わず数える。リクエストし直すたびに測り直す */
  readonly throughput = new Throughput();
  /** ページと一緒に受け取ったチケットと、受け取った時刻 (`performance.now()`)。使ったら・古くなったら null */
  private pageTicket: { token: string; at: number } | null;

  constructor(ticket?: string | null) {
    this.pageTicket =
      typeof ticket === "string"
        ? { token: ticket, at: performance.now() }
        : null;
  }

  /** 繋がっているか (指示を送れるか) */
  get open(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /** 指示を送る。**送れたか**を返す (繋がっていない・繋ぎ直している間は送らずに false) */
  send(command: Command): boolean {
    if (!this.open) return false;
    this.socket?.send(JSON.stringify(command));
    return true;
  }

  /**
   * ページと一緒に受け取ったチケットを 1 回だけ渡す。**繋ぐのに使えるのは最初の 1 回だけ** (`tickets.ts` で 1 回使ったら消える)。
   * 受け取ってから寿命の半分 (`TICKET_LIFETIME`) を過ぎていたら渡さない (運転中の注意を待った・裏のタブで開いた)。
   * 渡せなければ null で、`/api/live/ticket` から取る
   */
  takePageTicket(): string | null {
    const given = this.pageTicket;
    this.pageTicket = null;
    if (given === null || performance.now() - given.at > TICKET_LIFETIME / 2)
      return null;
    return given.token;
  }

  /**
   * `/api/live/ticket` からチケットを取る。取れなければ null。ブラウザは WebSocket の握手に `Authorization` を
   * 付けてくれないので、認証を通れることをチケットで示す (`tickets.ts`)
   */
  async fetchTicket(): Promise<string | null> {
    try {
      const res = await fetch(resolve("api/live/ticket"), { method: "POST" });
      if (!res.ok) return null;
      return ((await res.json()) as { ticket: string }).ticket;
    } catch {
      return null;
    }
  }

  /**
   * チケットを付けて WebSocket を開き、届いたものを読み分けて渡す。いまの接続 (`socket`) にはしない
   * (呼ぶ側が決める。裏で用意する接続は入れ替えるまでいまの接続ではない)。`measure` なら受け取りの速さに数える
   */
  connect(
    ticket: string,
    events: LiveSocketEvents,
    measure: boolean,
  ): WebSocket {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    // このエンドポイントは SvelteKit のルートではない (server.js が受ける) ので、型の付いた `resolve` に
    // パスごとは渡せない。接頭辞 (`resolve('')` = 接頭辞 + `/`) だけを使う
    const ws = new WebSocket(
      `${scheme}://${location.host}${resolve("")}${SOCKET_PATH.slice(1)}?ticket=${ticket}`,
    );
    ws.binaryType = "arraybuffer";
    this.listen(ws, events, measure);
    return ws;
  }

  /** 開いた接続の受け口を付け直す (裏で用意した接続をいまの接続にしたとき)。`open` は付けない */
  listen(ws: WebSocket, events: LiveSocketEvents, measure: boolean): void {
    if (events.open !== undefined) ws.onopen = () => events.open?.();
    ws.onerror = () => events.error?.();
    ws.onclose = () => events.close?.();
    ws.onmessage = (event) => {
      const data = event.data as ArrayBuffer;
      // 段を下げる先を決めるのに、受け取りの速さを測る (`adapt`)。中身を問わず数える
      if (measure) this.throughput.push(Date.now(), data.byteLength);
      events.frame(readFrame(data), data);
    };
  }

  /** 接続の受け口を外して閉じる。閉じたあとに届くもの・`close` は受けない */
  static drop(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
  }

  /** いまの接続を閉じる。`close` は受ける (繋ぎ直すかを決める側が `socket` を見る) */
  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
