/**
 * Hybridcast のアプリの頭に差し込むもの。**アプリの文書の中で動く** (`prepareApp` が
 * `(${shim})(init)` の形で HTML に入れる)。
 *
 * アプリは sandbox の iframe (使い捨てのオリジン) にいて、外へは直に繋げない (CSP の
 * `connect-src 'none'`)。ここが代わりに:
 *
 * - `fetch` と `XMLHttpRequest` を親 (denpa の画面) へ渡す。親が中継 (`/api/bml/proxy`・`/api/bml/post`) で取る
 * - 受信機の記憶 (`localStorage`) をアプリの配信元ごとの置き場として用意する (親が覚える)
 * - 受信機 API (放送の映像の object・`navigator.receiverDevice`) を、用意できる範囲で用意する。
 *   無いものは「使えない」(null) を返し、何を呼ばれたかを親に知らせる (本物の放送で、どの API が
 *   要るかを見るため)
 * - キー (色ボタン・戻る) を受信機のキーに直す
 * - **受信機を名乗る** (UA の `Hybridcast/`)。データ放送の受信機の機能 (`navigator.bmlCompat` など) は
 *   `compat.ts` が置く (`bml/` の部品を使うので、別に束ねて後ろに差し込む。ここは渡すものを置くだけ)
 *
 * **この関数は文字にして差し込む** (`Function.prototype.toString`)。外の名前を使わない・クラスの
 * フィールド宣言やオブジェクトの `...` を使わない (束ねるときに外の補助関数へ置き換わりうる) こと。
 */

import type { CompatInit } from "./compat";

/** アプリに見せる、いまの局と番組と字幕 (親が変わるたびに送り直す) */
export interface HcState {
  program: {
    originalNetworkId: number | null;
    transportStreamId: number | null;
    serviceId: number | null;
    eventId: number | null;
    eventName: string | null;
    startTimeUnixMillis: number | null;
    durationSeconds: number | null;
  } | null;
  /** 局の名前 (局の一覧から。分からなければ空) */
  serviceName: string;
  /** 字幕を出しているか */
  captions: boolean;
}

export interface ShimInit {
  /** アプリの元の URL (相対の名前はここから解決する) */
  url: string;
  organisationId: number;
  applicationId: number;
  /** 受信機の記憶 (このアプリのぶん) */
  storage: Record<string, string>;
  state: HcState;
  /**
   * **アプリを denpa 越しに読ませる中継** (`server/hc-relay.ts`)。http のアプリは https の画面から読めず (Mixed Content)、
   * https のアプリも中の script の `location.*` を置き換えないと iframe ごと外へ移ろうとして止められる (`location.ts`)。
   * `root` は中継の頭 (絶対 URL。末尾は /)、`origin` はアプリの配信元 (http(s)://host)。`<base>` と HTML の中の
   * 配信元の URL は `prepareApp` が中継へ書き換え、後から作られる要素の URL はここで書き換える
   */
  relay: { root: string; origin: string };
  /** データ放送の Greg と NVRAM (`compat.ts` へ渡す) */
  compat: CompatInit;
}

export function shim(init: ShimInit): void {
  // oxlint-disable-next-line typescript/no-explicit-any -- アプリの文書の中で動く (型の無い世界)
  const w = window as any;
  const post = (message: Record<string, unknown>): void => {
    message["hc"] = 1;
    w.parent.postMessage(message, "*");
  };
  const told = new Set<string>();
  /** 使えない API を呼ばれた。**同じものは 1 回だけ**知らせる */
  const unsupported = (name: string): null => {
    if (!told.has(name)) {
      told.add(name);
      post({ type: "log", message: `${name} は使えません` });
    }
    return null;
  };
  let state = init.state;

  /*
   * ---- アプリの元の場所 (`location.ts`)。配った script の `location.hostname` などはここを読み書きする ----
   * 読むとアプリの元の URL の値。移る (`href` に入れる・`assign`・`replace`・`reload`) と、iframe ごと移らずに
   * 親に新しいアプリとして開き直してもらう (`toOrigin` は下の中継のところ。呼ばれるのは差し込みが動き終えたあと)
   */
  const appUrl = new URL(init.url);
  const go = (to: unknown): void => {
    const url = toOrigin(new URL(String(to), document.baseURI).href);
    if (/^https?:\/\//i.test(url)) post({ type: "navigate", url });
  };
  const where: Record<string, unknown> = {
    assign: go,
    replace: go,
    reload: () => go(appUrl.href),
    toString: () => appUrl.href,
  };
  for (const key of [
    "hostname",
    "host",
    "origin",
    "protocol",
    "port",
    "pathname",
    "search",
  ] as const)
    Object.defineProperty(where, key, {
      enumerable: true,
      get: () => appUrl[key],
    });
  Object.defineProperty(where, "href", {
    enumerable: true,
    get: () => appUrl.href,
    set: go,
  });
  w.__hcLocation = where;

  // ---- アプリの中継 (`ShimInit.relay`) ----
  const relayRoot = init.relay.root;
  const relayFrom = `${init.relay.origin}/`;
  /**
   * denpa の頭 (https://denpa/)。**`/` から始まる住所はここへ解決される** — `<base>` を中継にしても、
   * NHK のアプリの `/common/…` は中継の外 (denpa の頭) を指す。配信元の頭として扱う
   */
  const denpaTop = `${new URL(relayRoot).origin}/`;
  /** 配信元の URL を中継へ (読み込み用)。`/` から始まって denpa の頭に解決されたものも。ほかはそのまま */
  const toRelay = (url: string): string => {
    if (url.startsWith(relayFrom))
      return relayRoot + url.slice(relayFrom.length);
    if (url.startsWith(denpaTop) && !url.startsWith(relayRoot))
      return relayRoot + url.slice(denpaTop.length);
    return url;
  };
  /** 中継の URL (と denpa の頭に解決された URL) を配信元へ戻す (通信は親が中継で取るので、元の行き先を渡す) */
  const toOrigin = (url: string): string => {
    if (url.startsWith(relayRoot))
      return relayFrom + url.slice(relayRoot.length);
    if (url.startsWith(denpaTop)) return relayFrom + url.slice(denpaTop.length);
    return url;
  };
  // 後から作る script・画像・CSS の URL。属性でもプロパティでも入るので両方を見る
  /*
   * **読み込む要素だけ。** iframe・a の行き先まで中継にすると、中継の返り (sandbox の CSP) の中で script が
   * 動かなくなる。iframe は CSP の frame-src で止めてあり、a で移った先はアプリの外
   */
  const loads = [
    "SCRIPT",
    "IMG",
    "LINK",
    "SOURCE",
    "VIDEO",
    "AUDIO",
    "OBJECT",
    "EMBED",
    "INPUT",
    "TRACK",
  ];
  const watched = ["src", "href", "data", "poster"];
  /**
   * style の中の `url(…)` も中継へ (NHK は `style="background:url(/hc-data/…)"` と書く。`/` から始まる住所は
   * denpa の頭に解決されて 404 になる)
   */
  const styleUrls = (css: string): string =>
    css.replace(
      /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
      (whole: string, quote: string, url: string) => {
        try {
          return `url(${quote}${toRelay(new URL(url, document.baseURI).href)}${quote})`;
        } catch {
          return whole;
        }
      },
    );
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (
    this: Element,
    name: string,
    value: string,
  ) {
    if (String(name).toLowerCase() === "style")
      return setAttribute.call(this, name, styleUrls(String(value)));
    const rewrite =
      loads.includes(this.tagName.toUpperCase()) &&
      watched.includes(String(name).toLowerCase());
    if (!rewrite) return setAttribute.call(this, name, value);
    // `/common/…` のような住所は、解決してから中継へ (そのままでは denpa の頭を指す)
    let resolved = String(value);
    // 空は解決しない (<base> の URL になってしまう)
    if (resolved === "") return setAttribute.call(this, name, value);
    try {
      resolved = new URL(resolved, document.baseURI).href;
    } catch {
      // 読めない住所はそのまま
    }
    return setAttribute.call(this, name, toRelay(resolved));
  };
  for (const [Kind, name] of [
    [w.HTMLScriptElement, "src"],
    [w.HTMLImageElement, "src"],
    [w.HTMLLinkElement, "href"],
    [w.HTMLMediaElement, "src"],
    [w.HTMLSourceElement, "src"],
  ] as [{ prototype: object }, string][]) {
    const own = Object.getOwnPropertyDescriptor(Kind.prototype, name);
    if (own === undefined || own.set === undefined || own.get === undefined)
      continue;
    const { get, set } = own;
    Object.defineProperty(Kind.prototype, name, {
      configurable: true,
      enumerable: own.enumerable === true,
      get(this: object) {
        return toOrigin(String(get.call(this)));
      },
      set(this: object, value: unknown) {
        set.call(this, toRelay(new URL(String(value), document.baseURI).href));
      },
    });
  }

  // ---- 通信 (親へ渡す) ----
  let nextId = 1;
  const waiting = new Map<number, (reply: Record<string, unknown>) => void>();
  const relay = (
    url: string,
    method: string,
    contentType: string | null,
    body: ArrayBuffer | null,
  ) =>
    new Promise<{ status: number; contentType: string; body: ArrayBuffer }>(
      (resolve, reject) => {
        const id = nextId++;
        waiting.set(id, (reply) => {
          if (reply["error"] === true) reject(new TypeError("Failed to fetch"));
          else
            resolve(
              reply as unknown as {
                status: number;
                contentType: string;
                body: ArrayBuffer;
              },
            );
        });
        post({ type: "fetch", id, url, method, contentType, body });
      },
    );
  const NativeResponse = w.Response as typeof Response;
  w.fetch = async (
    input: unknown,
    options?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof w.Request ? (input as Request) : null;
    const url = toOrigin(
      new URL(request !== null ? request.url : String(input), document.baseURI)
        .href,
    );
    const method = String(
      options?.method ?? request?.method ?? "GET",
    ).toUpperCase();
    const headers = new Headers(options?.headers ?? request?.headers);
    let body: ArrayBuffer | null = null;
    const raw =
      options?.body ??
      (request !== null && method !== "GET" && method !== "HEAD"
        ? await request.arrayBuffer()
        : null);
    if (raw !== null && raw !== undefined) {
      // 文字・フォーム・Blob などを、ブラウザ自身に bytes と content-type へ直させる
      const made = new NativeResponse(raw as BodyInit);
      const type = made.headers.get("content-type");
      if (!headers.has("content-type") && type !== null)
        headers.set("content-type", type);
      body = await made.arrayBuffer();
    }
    const got = await relay(url, method, headers.get("content-type"), body);
    if (got.status < 200 || got.status > 599)
      throw new TypeError("Failed to fetch");
    const empty =
      got.status === 204 ||
      got.status === 205 ||
      got.status === 304 ||
      method === "HEAD";
    const response = new NativeResponse(empty ? null : got.body, {
      status: got.status,
      headers: { "content-type": got.contentType },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };

  /** XMLHttpRequest。中身は上の fetch (親へ渡す)。同期の呼び出しはできない (非同期で返す) */
  function Xhr(this: Record<string, unknown>): void {
    this["readyState"] = 0;
    this["status"] = 0;
    this["statusText"] = "";
    this["response"] = null;
    this["responseText"] = "";
    this["responseXML"] = null;
    this["responseType"] = "";
    this["responseURL"] = "";
    this["timeout"] = 0;
    this["withCredentials"] = false;
    this["upload"] = new EventTarget();
    this["_target"] = new EventTarget();
    this["_headers"] = {};
    this["_type"] = "";
    this["_sent"] = 0;
  }
  const proto = Xhr.prototype as Record<string, unknown>;
  const fire = (xhr: Record<string, unknown>, type: string): void => {
    const event = new ProgressEvent(type);
    const handler = xhr[`on${type}`];
    if (typeof handler === "function") handler.call(xhr, event);
    (xhr["_target"] as EventTarget).dispatchEvent(event);
  };
  const state4 = (xhr: Record<string, unknown>, ready: number): void => {
    xhr["readyState"] = ready;
    fire(xhr, "readystatechange");
  };
  /** 終わった (`type` は load・error・abort・timeout) */
  const finish = (xhr: Record<string, unknown>, type: string): void => {
    state4(xhr, 4);
    fire(xhr, type);
    fire(xhr, "loadend");
  };
  proto["addEventListener"] = function (
    this: Record<string, unknown>,
    type: string,
    listener: EventListener,
    options?: unknown,
  ) {
    (this["_target"] as EventTarget).addEventListener(
      type,
      listener,
      options as AddEventListenerOptions,
    );
  };
  proto["removeEventListener"] = function (
    this: Record<string, unknown>,
    type: string,
    listener: EventListener,
  ) {
    (this["_target"] as EventTarget).removeEventListener(type, listener);
  };
  proto["open"] = function (
    this: Record<string, unknown>,
    method: string,
    url: string,
    async?: boolean,
  ) {
    if (async === false) unsupported("同期の XMLHttpRequest");
    this["_method"] = String(method).toUpperCase();
    this["_url"] = new URL(String(url), document.baseURI).href;
    this["_headers"] = {};
    this["_sent"] = (this["_sent"] as number) + 1;
    state4(this, 1);
  };
  proto["setRequestHeader"] = function (
    this: Record<string, unknown>,
    name: string,
    value: string,
  ) {
    (this["_headers"] as Record<string, string>)[String(name).toLowerCase()] =
      String(value);
  };
  proto["overrideMimeType"] = () => {};
  proto["getResponseHeader"] = function (
    this: Record<string, unknown>,
    name: string,
  ) {
    return String(name).toLowerCase() === "content-type" && this["_type"] !== ""
      ? this["_type"]
      : null;
  };
  proto["getAllResponseHeaders"] = function (this: Record<string, unknown>) {
    return this["_type"] !== "" ? `content-type: ${this["_type"]}\r\n` : "";
  };
  proto["abort"] = function (this: Record<string, unknown>) {
    // 返りが来ても捨てる (世代を進める)
    this["_sent"] = (this["_sent"] as number) + 1;
    if (this["readyState"] !== 0 && this["readyState"] !== 4)
      finish(this, "abort");
    this["readyState"] = 0;
  };
  proto["send"] = function (this: Record<string, unknown>, body?: unknown) {
    send(this, body);
  };
  const send = (xhr: Record<string, unknown>, body: unknown): void => {
    const mine = xhr["_sent"];
    const headers = xhr["_headers"] as Record<string, string>;
    const method = xhr["_method"] as string;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if ((xhr["timeout"] as number) > 0) {
      timer = setTimeout(() => {
        if (xhr["_sent"] !== mine) return;
        xhr["_sent"] = (mine as number) + 1;
        finish(xhr, "timeout");
      }, xhr["timeout"] as number);
    }
    fire(xhr, "loadstart");
    const failed = (): void => {
      if (timer !== null) clearTimeout(timer);
      if (xhr["_sent"] !== mine) return;
      xhr["status"] = 0;
      finish(xhr, "error");
    };
    w.fetch(xhr["_url"], {
      method,
      headers,
      body:
        method === "GET" || method === "HEAD" || body === undefined
          ? null
          : body,
    }).then(async (response: Response) => {
      const data = await response.arrayBuffer();
      if (timer !== null) clearTimeout(timer);
      if (xhr["_sent"] !== mine) return;
      const type = response.headers.get("content-type") ?? "";
      const charset = /charset=([^;]+)/i.exec(type)?.[1]?.trim() ?? "utf-8";
      let text = "";
      try {
        text = new TextDecoder(charset).decode(data);
      } catch {
        text = new TextDecoder().decode(data);
      }
      xhr["status"] = response.status;
      xhr["statusText"] = response.statusText;
      xhr["responseURL"] = xhr["_url"];
      xhr["_type"] = type;
      state4(xhr, 2);
      state4(xhr, 3);
      const kind = xhr["responseType"];
      if (kind === "arraybuffer") xhr["response"] = data;
      else if (kind === "blob") xhr["response"] = new Blob([data], { type });
      else if (kind === "json") {
        try {
          xhr["response"] = JSON.parse(text);
        } catch {
          xhr["response"] = null;
        }
      } else if (kind === "document") {
        xhr["response"] = new DOMParser().parseFromString(
          text,
          /xml/i.test(type) ? "application/xml" : "text/html",
        );
        xhr["responseXML"] = xhr["response"];
      } else {
        xhr["responseText"] = text;
        xhr["response"] = text;
        if (/xml/i.test(type))
          xhr["responseXML"] = new DOMParser().parseFromString(
            text,
            "application/xml",
          );
      }
      finish(xhr, "load");
    }, failed);
  };
  for (const [name, value] of [
    ["UNSENT", 0],
    ["OPENED", 1],
    ["HEADERS_RECEIVED", 2],
    ["LOADING", 3],
    ["DONE", 4],
  ] as const) {
    (Xhr as unknown as Record<string, number>)[name] = value;
    proto[name] = value;
  }
  w.XMLHttpRequest = Xhr;
  // 直に繋ぐもの (WebSocket・EventSource・sendBeacon) は使えない (CSP でも止まる)
  // `new` で呼ばれるので、アロー関数ではなく function で (アローは `new` すると TypeError)
  for (const name of ["WebSocket", "EventSource"])
    w[name] = function () {
      unsupported(name);
      throw new DOMException(`${name} は使えません`, "SecurityError");
    };
  w.navigator.sendBeacon = () => {
    unsupported("sendBeacon");
    return false;
  };

  // ---- 受信機の記憶 (配信元ごと。親が覚える) ----
  const makeStorage = (
    items: Map<string, string>,
    save: () => void,
  ): Storage => {
    const api: Record<string, unknown> = {
      key: (i: number) => [...items.keys()][i] ?? null,
      getItem: (k: string) => items.get(String(k)) ?? null,
      setItem: (k: string, v: unknown) => {
        items.set(String(k), String(v));
        save();
      },
      removeItem: (k: string) => {
        items.delete(String(k));
        save();
      },
      clear: () => {
        items.clear();
        save();
      },
    };
    return new Proxy(api, {
      get: (target, key) =>
        key === "length"
          ? items.size
          : typeof key === "string" && !(key in target)
            ? (items.get(key) ?? undefined)
            : target[key as string],
      set: (_, key, value) => {
        items.set(String(key), String(value));
        save();
        return true;
      },
      deleteProperty: (_, key) => {
        items.delete(String(key));
        save();
        return true;
      },
      has: (target, key) => key in target || items.has(String(key)),
      ownKeys: () => [...items.keys()],
      getOwnPropertyDescriptor: (_, key) =>
        items.has(String(key))
          ? {
              value: items.get(String(key)),
              enumerable: true,
              configurable: true,
              writable: true,
            }
          : undefined,
    }) as unknown as Storage;
  };
  const kept = new Map(Object.entries(init.storage));
  const local = makeStorage(kept, () =>
    post({ type: "store", items: Object.fromEntries(kept) }),
  );
  const session = makeStorage(new Map(), () => {});
  try {
    for (const [name, value] of [
      ["localStorage", local],
      ["sessionStorage", session],
    ] as const)
      Object.defineProperty(w, name, { value, configurable: true });
  } catch {
    unsupported("localStorage");
  }
  // cookie は持たない (端末を見分ける値を局へ出さない)。触っても転ばないように空を返す
  try {
    Object.defineProperty(document, "cookie", {
      get: () => "",
      set: () => {},
      configurable: true,
    });
  } catch {
    // 置けなくても、使えないことに変わりはない
  }

  // ---- 受信機を名乗る ----
  /*
   * **UA に `Hybridcast/` を足す** (アプリの中から見えるものだけ。中継は局へ UA を送らない)。NHK のアプリは
   * これが無いと PC 向けの案内のページへ移る。メーカー・機種などは空 (受信機を見分けるものは持たない)
   */
  try {
    const ua = `${navigator.userAgent} Hybridcast/1.0 (;;;;;)`;
    Object.defineProperty(w.navigator, "userAgent", {
      get: () => ua,
      configurable: true,
    });
  } catch {
    // 置けなければ名乗らないまま
  }
  // `compat.ts` が読んで消す
  w.__hcCompat = init.compat;

  // ---- 放送の映像 (object type="video/broadcast") ----
  const channel = (): Record<string, unknown> | null => {
    const p = state.program;
    if (p === null || p.serviceId === null) return null;
    const onid = p.originalNetworkId ?? 0;
    // BS は 4、CS は 6・7。ほかは地上波
    const idType = onid === 4 || onid === 6 || onid === 7 ? 11 : 12;
    return {
      channelType: 0,
      idType,
      onid,
      tsid: p.transportStreamId,
      sid: p.serviceId,
      name: state.serviceName,
    };
  };
  const programme = (): Record<string, unknown>[] => {
    const p = state.program;
    if (p === null) return [];
    return [
      {
        name: p.eventName ?? "",
        programmeID: p.eventId === null ? "" : String(p.eventId),
        startTime:
          p.startTimeUnixMillis === null
            ? null
            : Math.floor(p.startTimeUnixMillis / 1000),
        duration: p.durationSeconds,
      },
    ];
  };
  // IPTV フォーラムの形式 (video/x-iptvf-broadcast) も同じもの。NHK のアプリはこちらで書く
  const isBroadcast = (element: HTMLObjectElement): boolean =>
    /^video\/(x-iptvf-)?broadcast$/i.test(element.type);
  const stopped = new WeakSet<HTMLObjectElement>();
  /** 全面に出せと言われたか (setFullScreen) と、最後に知らせた置き場 */
  let full = false;
  let last = "";
  const objectProto = w.HTMLObjectElement.prototype as Record<string, unknown>;
  const define = (
    name: string,
    get: (element: HTMLObjectElement) => unknown,
  ): void => {
    Object.defineProperty(objectProto, name, {
      configurable: true,
      get(this: HTMLObjectElement) {
        return isBroadcast(this) ? get(this) : undefined;
      },
    });
  };
  define("currentChannel", () => channel());
  define("programmes", () => programme());
  define("playState", (element) => (stopped.has(element) ? 3 : 2));
  const method = (
    name: string,
    impl: (element: HTMLObjectElement, args: unknown[]) => unknown,
  ): void => {
    objectProto[name] = function (this: HTMLObjectElement, ...args: unknown[]) {
      if (!isBroadcast(this)) return unsupported(`object.${name}`);
      return impl(this, args);
    };
  };
  method("bindToCurrentChannel", (element) => {
    stopped.delete(element);
    watch();
    return channel();
  });
  for (const name of ["stop", "release"])
    method(name, (element) => {
      stopped.add(element);
      watch();
    });
  method("setFullScreen", (element, args) => {
    full = args[0] === true;
    stopped.delete(element);
    watch();
  });
  method("getChannelConfig", () => ({
    channelList: [channel()].filter((c) => c !== null),
  }));
  method("setChannel", (_, args) => {
    const to = args[0] as Record<string, unknown> | null;
    if (to === null || typeof to !== "object" || typeof to["sid"] !== "number")
      return unsupported("setChannel (局の指定が読めない)");
    post({
      type: "tune",
      onid: to["onid"],
      tsid: to["tsid"] ?? null,
      sid: to["sid"],
    });
    return undefined;
  });
  for (const name of [
    "prevChannel",
    "nextChannel",
    "recordNow",
    "stopRecording",
    "getComponents",
    "selectComponent",
  ])
    method(name, () => unsupported(`object.${name}`));

  /**
   * object が見えているか。**隠した object には出さない** — NHK の番組表は画面いっぱいの object を
   * `visibility: hidden` で置いたままにする。映像はアプリの上に重ねるので、出すと番組表を覆う
   */
  const seen = (o: HTMLObjectElement): boolean =>
    typeof o.checkVisibility === "function"
      ? o.checkVisibility({ visibilityProperty: true })
      : getComputedStyle(o).visibility !== "hidden";
  /** 映像をどこに出すか。object が無ければ全面、止めてある・隠してあれば出さない */
  const watch = (): void => {
    const objects = [...document.querySelectorAll("object")].filter(
      isBroadcast,
    );
    let place: unknown = "full";
    if (objects.length > 0) {
      const shown = objects.find((o) => !stopped.has(o) && seen(o));
      if (shown === undefined) place = "hidden";
      else if (!full) {
        const r = shown.getBoundingClientRect();
        place =
          r.width > 0 && r.height > 0
            ? { left: r.left, top: r.top, width: r.width, height: r.height }
            : "hidden";
      }
    }
    const mark = JSON.stringify(place);
    if (mark === last) return;
    last = mark;
    post({ type: "video", place });
  };
  // 動かす・大きさを変えるのはアプリのスクリプトなので、毎フレーム見る (変わったときだけ知らせる)
  const loop = (): void => {
    watch();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // ---- 受信機 API ----
  /** 番組が変わったら呼ぶもの (`streamEvent.addEventIDUpdateListener`) */
  const eventListeners = new Set<() => void>();
  /** いまの番組 (`getCurrentEventInformation`。ARIB の名前で。次の番組は持たない) */
  const eventInformation = (): Record<string, unknown> | undefined => {
    const p = state.program;
    if (p === null) return undefined;
    return {
      original_network_id: p.originalNetworkId,
      transport_stream_id: p.transportStreamId,
      service_id: p.serviceId,
      event_id: p.eventId,
      start_time:
        p.startTimeUnixMillis === null ? null : new Date(p.startTimeUnixMillis),
      duration: p.durationSeconds,
      name: p.eventName ?? "",
      desc: "",
      f_event_id: null,
      f_start_time: null,
      f_duration: null,
      f_name: "",
      f_desc: "",
    };
  };
  /*
   * 放送の中のイベント (`streamEvent`)。**イベントメッセージは届けない** (denpa は Hybridcast へ流さない) —
   * 聞くのは受け付けるだけ。番組が変わったことは知らせる。登録されたら一度すぐ呼ぶ (いまの番組はもう分かっている)
   */
  const streamEvent: Record<string, unknown> = {
    sourceIs: (source: unknown) => source === "onair",
    addEventIDUpdateListener: (listener: unknown) => {
      if (typeof listener !== "function") return;
      eventListeners.add(listener as () => void);
      setTimeout(() => {
        if (eventListeners.has(listener as () => void))
          (listener as () => void)();
      }, 0);
    },
    removeEventIDUpdateListener: (listener: unknown) =>
      eventListeners.delete(listener as () => void),
    addGeneralEventMessageListener: () => {},
    removeGeneralEventMessageListener: () => {},
  };
  const receiver: Record<string, unknown> = {
    getAITInfo: () => ({
      url: init.url,
      organisationId: init.organisationId,
      applicationId: init.applicationId,
    }),
    getCurrentChannel: () => channel(),
    getCurrentProgram: () => programme()[0] ?? null,
    getProgramInfo: () => programme()[0] ?? null,
    getCurrentEventInformation: (callback: unknown) => {
      const info = eventInformation();
      if (typeof callback === "function") setTimeout(() => callback(info), 0);
      return info;
    },
    streamEvent,
    tune: (onid: number, tsid: number | null, sid: number) =>
      post({ type: "tune", onid, tsid, sid }),
    getCCStatus: () => (state.captions ? 1 : 0),
    setCCStatus: (on: unknown) =>
      post({ type: "captions", on: on === true || on === 1 }),
    destroyApplication: () => post({ type: "close" }),
    exitApplication: () => post({ type: "close" }),
    // 受信機を名乗るもの・見分けるものは持たない
    getReceiverId: () => unsupported("getReceiverId"),
    getDeviceId: () => unsupported("getDeviceId"),
    getCertificate: () => unsupported("getCertificate"),
  };
  const device = new Proxy(receiver, {
    get: (target, key) => {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      // 知らない名前は「使えない」(null を返す関数)。何を呼ばれたかは知らせる
      return () => unsupported(`navigator.receiverDevice.${key}`);
    },
  });
  try {
    Object.defineProperty(w.navigator, "receiverDevice", {
      value: device,
      configurable: true,
    });
  } catch {
    // 置けなければ無いまま
  }

  // ---- キー ----
  const VK: Record<string, number> = {
    VK_LEFT: 37,
    VK_UP: 38,
    VK_RIGHT: 39,
    VK_DOWN: 40,
    VK_ENTER: 13,
    VK_BACK: 461,
    VK_RED: 403,
    VK_GREEN: 404,
    VK_YELLOW: 405,
    VK_BLUE: 406,
    // d は差し込みが受けてアプリを閉じるので、アプリには届かない。名前だけ置く (どのキーとも重ならない番号)
    VK_DBUTTON: -1,
  };
  for (let i = 0; i <= 9; i++) VK[`VK_${i}`] = 48 + i;
  if (w.KeyEvent === undefined) w.KeyEvent = VK;
  // **素の名前でも読む** (NHK のアプリは `case VK_LEFT:` と書く。無いと switch の途中で転び、キーが効かない)
  for (const name of Object.keys(VK)) if (!(name in w)) w[name] = VK[name];
  const COLOR: Record<string, number> = { r: 403, g: 404, y: 405, b: 406 };
  /** 受信機のキーとして打つ */
  const press = (key: string, code: number, down: boolean): void => {
    const event = new KeyboardEvent(down ? "keydown" : "keyup", {
      key,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "keyCode", { get: () => code });
    Object.defineProperty(event, "which", { get: () => code });
    (
      document.activeElement ??
      document.body ??
      document.documentElement
    ).dispatchEvent(event);
  };
  const typing = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  for (const type of ["keydown", "keyup"]) {
    w.addEventListener(
      type,
      (event: KeyboardEvent) => {
        if (
          !event.isTrusted ||
          typing(event.target) ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        )
          return;
        const key =
          event.key.length === 1 ? event.key.toLowerCase() : event.key;
        // 戻る (Backspace・x) と d はアプリを閉じてデータ放送へ戻る
        if (key === "Backspace" || key === "x" || key === "d") {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (type === "keydown") post({ type: "close" });
          return;
        }
        const color = COLOR[key];
        if (color !== undefined) {
          event.preventDefault();
          event.stopImmediatePropagation();
          press(key, color, type === "keydown");
        }
      },
      true,
    );
  }

  // ---- 親から ----
  w.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== w.parent) return;
    const data = event.data as Record<string, unknown> | null;
    if (data === null || typeof data !== "object" || data["hc"] !== 1) return;
    if (data["type"] === "response") {
      const id = data["id"] as number;
      const done = waiting.get(id);
      waiting.delete(id);
      done?.(data);
    } else if (data["type"] === "state") {
      const before = state.program?.eventId ?? null;
      state = data["state"] as HcState;
      // 1 つずつ別に呼ぶ (アプリのリスナーが投げても、ほかのリスナーとここの続きは止めない)
      if ((state.program?.eventId ?? null) !== before)
        for (const listener of eventListeners) setTimeout(listener, 0);
    } else if (data["type"] === "key") {
      press(
        data["key"] as string,
        data["code"] as number,
        data["down"] === true,
      );
    }
  });
}
