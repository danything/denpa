/**
 * Hybridcast のアプリを denpa の中で開く (画面の側の決まり)
 * ([docs/stream.md](../../../docs/stream.md#hybridcast))。
 *
 * ```
 * 画面 ─ 中継でアプリの HTML を取る (/api/bml/proxy)
 *      ─ 先頭に <base href="アプリの中継の URL"> と差し込み (shim.ts) を入れる (prepareApp)
 *      ─ sandbox="allow-scripts" の iframe (/api/bml/hybridcast。使い捨てのオリジン) へ postMessage で渡す
 * iframe ─ document.write で開く。配信元の画像・script・CSS は <base> から中継 (/api/bml/hc/…) を通して取る
 *        ─ fetch・XHR・受信機の記憶・受信機 API は postMessage で画面へ
 * ```
 *
 * iframe の中身は denpa のオリジンを持たないので、denpa の cookie・localStorage・API のレスポンスには
 * 触れない。srcdoc や blob: にしないのは、それだと denpa の画面の CSP を受け継ぎ、放送局の
 * script が動かないため (緩めると denpa の画面の CSP の意味がなくなる)。
 */

import type { ESEventUpdatedMessage } from "@danything/arib/bml-protocol";

import { decodeEuc } from "../bml/euc";
import { rewriteLocation } from "./location";
import { shim, type ShimInit } from "./shim";

export type { HcState, ShimInit } from "./shim";

/** アプリの画面の大きさ (CSS px)。テレビのブラウザと同じ 1920x1080 で組ませ、枠に合わせて伸ばす */
export const VIEWPORT = { width: 1920, height: 1080 } as const;

/**
 * **アプリの iframe から映像の場所を切り抜く `clip-path`** (`/embed/data` でだけ使う。
 * [docs/api.md](../../../docs/api.md#hybridcast-のアプリと映像))。テレビは映像を WebView の下に映すので、
 * アプリが画面全体に地の色を塗ると映像が隠れる。`rect` は iframe に対する割合 (0〜1。左上が 0)。
 * 外の枠と映像の矩形を evenodd で重ね、矩形の中だけを抜く
 */
export function videoHole(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): string {
  const at = (n: number): string => `${Math.min(1, Math.max(0, n)) * 100}%`;
  const left = at(rect.left);
  const top = at(rect.top);
  const right = at(rect.left + rect.width);
  const bottom = at(rect.top + rect.height);
  return `polygon(evenodd, 0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ${left} ${top}, ${left} ${bottom}, ${right} ${bottom}, ${right} ${top}, ${left} ${top})`;
}

/**
 * 受信機の記憶の置き場 (アプリの配信元のオリジンごと。denpa のほかの記憶とは混ぜない)。テレビのブラウザの
 * localStorage と同じくオリジンで分ける。AIT が名乗る organisation_id・application_id で分けると、
 * 別の配信元のアプリが同じ番号を名乗って、ほかのアプリの記憶を読める。http(s) の URL でないものは
 * (オリジンが "null" になって混ざらないよう) URL のまま。AIT は http(s) の URL しか出さないので、ふだんは来ない
 */
export function storageKey(url: string): string {
  let origin = url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:")
      origin = parsed.origin;
  } catch {
    // URL として読めない
  }
  return `denpa_hybridcast_${origin}`;
}

/** 受信機の記憶の上限 (配信元 1 つ。JSON の文字数)。超える書き込みは覚えない */
export const STORAGE_LIMIT = 256 * 1024;

/** 中継のレスポンスを文字にする。charset は content-type、無ければ先頭の meta、それも無ければ UTF-8 */
export function decodeHtml(body: Uint8Array, contentType: string): string {
  const head = new TextDecoder("latin1").decode(body.subarray(0, 1024));
  const charset =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder().decode(body);
  }
}

/** HTML の属性に入れる */
const attribute = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * 差し込みを入れた HTML。`<base>` はアプリの URL (アプリ自身の `<base>` があれば、それをアプリの URL
 * から解決したもの) を中継の URL にしたもので、**どの名前より先に**置く。差し込みはアプリの script より先に動く
 *
 * @param compat 差し込みの後ろに入れる、束ねた `compat.ts` (`import compat from '#lib/hybridcast/compat.ts?inject'`)
 */
export function prepareApp(
  html: string,
  init: ShimInit,
  compat: string,
): string {
  let base = init.url;
  const own = /<base\s[^>]*href\s*=\s*["']?([^"'\s>]+)/i.exec(html);
  if (own !== null) {
    try {
      base = new URL(own[1]!, init.url).href;
    } catch {
      // 読めない <base> は使わない
    }
  }
  /*
   * **アプリは中継を通す** (`ShimInit.relay`)。`<base>` と、HTML に直に書かれた配信元の URL を中継へ。
   * script が後から作る要素の URL は差し込みが書き換え、通信 (fetch・XHR) は差し込みが元の行き先へ戻して親へ渡す
   */
  const from = `${init.relay.origin}/`;
  if (base.startsWith(from)) base = init.relay.root + base.slice(from.length);
  html = html.split(from).join(init.relay.root);
  /*
   * `/` から始まる URL は <base> を中継にしても denpa の先頭へ解決される (NHK の `/common/…`)。中継のルートへ。
   * **読み込む要素のタグの中だけ**。a の行き先には触らない (script の中の文字列に読み込む要素のタグがあれば、それは書き換わる)
   */
  const root = init.relay.root;
  html = html.replace(
    /<(?:script|img|link|source|video|audio|object|embed|input|track)\b[^>]*>/gi,
    (tag) =>
      tag.replace(
        /(\s(?:src|href|data|poster)\s*=\s*["']?)\/(?!\/)/gi,
        (_, head: string) => head + root,
      ),
  );
  // 中の script がアプリの元の場所を読むように (`location.ts`)。差し込みが `__hcLocation` を置く
  html = rewriteLocation(html);
  // </script> で差し込みが切れないように (JSON の中の `<` は `\u003c` に)
  const data = JSON.stringify(init).replace(/</g, "\\u003c");
  const inject = `<base href="${attribute(base)}"><script>(${shim.toString()})(${data});</script><script>${compat}</script>`;
  for (const pattern of [
    /<head(\s[^>]*)?>/i,
    /<html(\s[^>]*)?>/i,
    /<!doctype[^>]*>/i,
  ]) {
    const found = pattern.exec(html);
    if (found !== null) {
      const at = found.index + found[0].length;
      return html.slice(0, at) + inject + html.slice(at);
    }
  }
  return inject + html;
}

/** iframe から画面へ (`hc: 1` が付く) */
export type FrameMessage =
  | { type: "ready" }
  | {
      type: "fetch";
      id: number;
      url: string;
      method: string;
      contentType: string | null;
      body: ArrayBuffer | null;
    }
  | { type: "store"; items: Record<string, string> }
  | {
      type: "video";
      place:
        | "full"
        | "hidden"
        | { left: number; top: number; width: number; height: number };
    }
  | { type: "tune"; onid: number; tsid: number | null; sid: number }
  | { type: "captions"; on: boolean }
  | { type: "close" }
  | { type: "log"; message: string }
  /** アプリが Greg を書いた・NVRAM に書いた (`compat.ts`)。データ放送のほうへ戻す */
  | { type: "greg"; index: number; value: string }
  | { type: "nvram"; key: string; value: string }
  /** アプリが別のページへ移ろうとした (`shim.ts` の `__hcLocation`)。そこを新しいアプリとして開き直す */
  | { type: "navigate"; url: string };

/** 受け取ったものを確かめる (型の分からないものは捨てる) */
export function frameMessage(data: unknown): FrameMessage | null {
  if (data === null || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m["hc"] !== 1 || typeof m["type"] !== "string") return null;
  switch (m["type"]) {
    case "ready":
    case "close":
      return { type: m["type"] };
    case "fetch":
      return typeof m["id"] === "number" &&
        typeof m["url"] === "string" &&
        typeof m["method"] === "string"
        ? {
            type: "fetch",
            id: m["id"],
            url: m["url"],
            method: m["method"],
            contentType:
              typeof m["contentType"] === "string" ? m["contentType"] : null,
            body: m["body"] instanceof ArrayBuffer ? m["body"] : null,
          }
        : null;
    case "store": {
      const items = m["items"];
      if (items === null || typeof items !== "object") return null;
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(items))
        if (typeof v === "string") clean[k] = v;
      return { type: "store", items: clean };
    }
    case "video": {
      const place = m["place"];
      if (place === "full" || place === "hidden")
        return { type: "video", place };
      if (place === null || typeof place !== "object") return null;
      const p = place as Record<string, unknown>;
      const n = (key: string): number =>
        typeof p[key] === "number" && Number.isFinite(p[key]) ? p[key] : 0;
      return {
        type: "video",
        place: {
          left: n("left"),
          top: n("top"),
          width: n("width"),
          height: n("height"),
        },
      };
    }
    case "tune":
      return typeof m["onid"] === "number" && typeof m["sid"] === "number"
        ? {
            type: "tune",
            onid: m["onid"],
            tsid: typeof m["tsid"] === "number" ? m["tsid"] : null,
            sid: m["sid"],
          }
        : null;
    case "captions":
      return { type: "captions", on: m["on"] === true };
    case "log":
      return typeof m["message"] === "string"
        ? { type: "log", message: m["message"].slice(0, 500) }
        : null;
    case "greg":
      return typeof m["index"] === "number" &&
        Number.isInteger(m["index"]) &&
        m["index"] >= 0 &&
        m["index"] < 64 &&
        typeof m["value"] === "string"
        ? { type: "greg", index: m["index"], value: m["value"] }
        : null;
    case "nvram":
      return typeof m["key"] === "string" && typeof m["value"] === "string"
        ? { type: "nvram", key: m["key"], value: m["value"] }
        : null;
    case "navigate":
      return typeof m["url"] === "string" && /^https?:\/\//i.test(m["url"])
        ? { type: "navigate", url: m["url"] }
        : null;
  }
  return null;
}

/**
 * リモコン (AribKeyCode) を受信機のキー (KeyboardEvent の key と keyCode) に。
 * 対応の無いキーは null (アプリに渡さない)。戻る (19) と d (20) は、呼ぶ側 (`HybridcastFrame.svelte`) が先に受けてアプリを閉じる
 */
export function receiverKey(
  code: number,
): { key: string; code: number } | null {
  if (code >= 5 && code <= 14)
    return { key: String(code - 5), code: 48 + code - 5 };
  const keys: Record<number, [string, number]> = {
    1: ["ArrowUp", 38],
    2: ["ArrowDown", 40],
    3: ["ArrowLeft", 37],
    4: ["ArrowRight", 39],
    18: ["Enter", 13],
    21: ["b", 406],
    22: ["r", 403],
    23: ["g", 404],
    24: ["y", 405],
  };
  const found = keys[code];
  return found === undefined ? null : { key: found[0], code: found[1] };
}

/**
 * **アプリへ渡すイベントメッセージ** (汎用イベントメッセージ記述子。ARIB STD-B24 第三編)。
 * 差し込みが `streamEvent.addGeneralEventMessageListener` のリスナーへ渡す (`shim.ts`)
 */
export interface HcEventMessage {
  /** 送られてきた ES (`/` と部品タグの 16 進 2 桁。データ放送の `es_ref` と同じ書き方) */
  esRef: string;
  componentTag: number;
  messageGroupId: number;
  /** event_msg_id の上位 8 ビット */
  messageId: number;
  /** event_msg_id の下位 8 ビット */
  messageVersion: number;
  privateDataByte: number[];
  /** private_data_byte を EUC-JP として読んだもの (データ放送の `EventMessageFired` の privateData と同じ) */
  privateData: string;
}

/**
 * **ストリーム記述子 (`esEventUpdated`) から、アプリへ渡すイベントメッセージを選ぶ。** アプリを開くたびに作る。
 *
 * - 渡すのはすぐ起きるもの (time_mode 0) だけ。時刻指定 (NPT) のものは、NPT が達するとサーバがすぐ起きるものに直して送る
 *   (`@danything/arib` の `dueEvents`)
 * - 放送は同じメッセージを繰り返し送るので、部品・グループ・ID・バージョンが同じものは 1 回だけ渡す
 *   (データ放送の `EventMessageFired` と同じ数え方。`bml/engine.ts` の `esEvents`)
 * - message_group_id 0 を今の文書の data_event_id と比べる決まりは、データ放送の文書のものなので見ない
 */
export class EventMessagePicker {
  private readonly seen = new Map<string, number>();

  pick(message: ESEventUpdatedMessage): HcEventMessage[] {
    const picked: HcEventMessage[] = [];
    for (const event of message.events) {
      if (event.type !== "immediateEvent") continue;
      const messageId = event.eventMessageId >> 8;
      const messageVersion = event.eventMessageId & 0xff;
      const key = `${message.componentId}:${event.eventMessageGroupId}:${messageId}`;
      if (this.seen.get(key) === messageVersion) continue;
      this.seen.set(key, messageVersion);
      picked.push({
        esRef: `/${message.componentId.toString(16).padStart(2, "0")}`,
        componentTag: message.componentId,
        messageGroupId: event.eventMessageGroupId,
        messageId,
        messageVersion,
        privateDataByte: [...event.privateDataByte],
        privateData: decodeEuc(Uint8Array.from(event.privateDataByte)),
      });
    }
    return picked;
  }
}
