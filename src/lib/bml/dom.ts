/**
 * スクリプトから見える文書 (BML の DOM。STD-B24 第二編 付属2 の DOM のうち放送が使うもの)。
 *
 * `document`・要素・文字 (`firstChild.data`)・`normalStyle`/`focusStyle`/`activeStyle`・
 * `currentEvent`。どれも中身 ([document.ts](document.ts)) を書き換えるだけで、描くのは
 * [render.ts](render.ts)。`typeof` は "hostobject"。
 */

import type { BmlDocument, BmlElement, BmlNode, BmlText } from "./document";
import { SIDES, type State } from "./style";
import {
  JSFunction,
  JSObject,
  type Lookup,
  type NativeImpl,
  toBoolean,
  toStr,
  type Value,
} from "./values";
import type { Realm } from "./vm";

/** DOM が呼ぶ、エンジンの側の API */
export interface DomHost {
  readonly realm: Realm;
  readonly document: BmlDocument;
  focused(): BmlElement | null;
  focus(element: BmlElement): void;
  blur(element: BmlElement): void;
  /** 今のイベント (`document.currentEvent`) */
  event(): Value;
  invisible(): boolean;
  setInvisible(invisible: boolean): void;
  /** beitem の subscribe が変わった */
  subscribed(element: BmlElement): void;
  /** object の streamStatus を書いた (音・MNG) */
  stream(element: BmlElement, status: string): void;
}

interface Accessor {
  get: () => Value;
  set?: (value: Value) => void;
}

/** 外のオブジェクト。名前ごとに読み書きの関数を持つ */
export class HostObject extends JSObject {
  readonly accessors = new Map<string, Accessor>();

  constructor(proto: JSObject | null) {
    super(proto, "hostobject");
  }

  override getOwn(key: string): Lookup {
    const accessor = this.accessors.get(key);
    if (accessor !== undefined) return accessor.get();
    return super.getOwn(key);
  }

  override put(key: string, value: Value): void {
    const accessor = this.accessors.get(key);
    if (accessor === undefined) super.put(key, value);
    else accessor.set?.(value);
  }

  override delete(key: string): boolean {
    if (this.accessors.has(key)) return false;
    return super.delete(key);
  }

  override ownKeys(): string[] {
    return [];
  }

  define(name: string, get: () => Value, set?: (value: Value) => void): void {
    this.accessors.set(name, set === undefined ? { get } : { get, set });
  }

  method(realm: Realm, name: string, impl: NativeImpl): void {
    super.put(
      name,
      new JSFunction(realm.functionProto, name, { kind: "native", impl }, null),
    );
  }
}

/** 字の数値の属性 (無ければ既定) */
function numberAttr(
  element: BmlElement,
  name: string,
  fallback: number,
): number {
  const n = Number.parseInt(element.attr(name) ?? "", 10);
  return Number.isNaN(n) ? fallback : n;
}

/** CSS の特性名と、`normalStyle` の名前の対応 (書けるものは true) */
const STYLE_PROPERTIES: Record<string, [string, boolean]> = {
  left: ["left", true],
  top: ["top", true],
  width: ["width", true],
  height: ["height", true],
  visibility: ["visibility", true],
  fontFamily: ["font-family", true],
  fontSize: ["font-size", true],
  fontWeight: ["font-weight", true],
  lineHeight: ["line-height", false],
  textAlign: ["text-align", false],
  letterSpacing: ["letter-spacing", false],
  colorIndex: ["color-index", true],
  backgroundColorIndex: ["background-color-index", true],
  borderTopColorIndex: ["border-top-color-index", true],
  borderRightColorIndex: ["border-right-color-index", true],
  borderBottomColorIndex: ["border-bottom-color-index", true],
  borderLeftColorIndex: ["border-left-color-index", true],
  grayscaleColorIndex: ["grayscale-color-index", true],
  borderWidth: ["border-width", false],
  borderStyle: ["border-style", false],
  paddingTop: ["padding-top", false],
  paddingRight: ["padding-right", false],
  paddingBottom: ["padding-bottom", false],
  paddingLeft: ["padding-left", false],
  navIndex: ["nav-index", false],
  navUp: ["nav-up", false],
  navDown: ["nav-down", false],
  navLeft: ["nav-left", false],
  navRight: ["nav-right", false],
  usedKeyList: ["used-key-list", true],
  clut: ["clut", false],
  resolution: ["resolution", false],
  displayAspectRatio: ["display-aspect-ratio", false],
};

type Side = (typeof SIDES)[number];

/** 特性の今の値を、スクリプトに返す形式で */
function styleValue(
  element: BmlElement,
  property: string,
  state: State,
): string {
  const s = element.styleIn(state);
  switch (property) {
    case "left":
    case "top":
    case "width":
    case "height":
      return `${s[property]}px`;
    case "border-width":
      return `${s.borderWidth}px`;
    case "letter-spacing":
      return `${s.letterSpacing}px`;
    case "font-size":
      return `${s.fontSize}px`;
    case "line-height":
      return s.lineHeight === null ? "normal" : `${s.lineHeight}px`;
    case "visibility":
      return s.visible ? "visible" : "hidden";
    case "color-index":
      return String(s.colorIndex);
    case "background-color-index":
      return String(s.backgroundColorIndex);
    case "grayscale-color-index":
      return s.grayscale.join(" ");
    case "font-family":
      return s.fontFamily;
    case "font-weight":
      return s.fontWeight;
    case "text-align":
      return s.textAlign;
    case "border-style":
      return s.borderStyle;
    case "used-key-list":
      return s.usedKeyList.join(" ");
    case "clut":
      return s.clut ?? "";
    case "resolution":
      return s.resolution ?? "";
    case "display-aspect-ratio":
      return s.displayAspectRatio ?? "";
  }
  const side = /^border-(top|right|bottom|left)-color-index$/.exec(property);
  if (side !== null)
    return String(s.borderColorIndex[SIDES.indexOf(side[1] as Side)]);
  const padding = /^padding-(top|right|bottom|left)$/.exec(property);
  if (padding !== null)
    return `${s.padding[SIDES.indexOf(padding[1] as Side)]}px`;
  const nav = /^nav-(index|up|down|left|right)$/.exec(property);
  if (nav !== null) {
    const key =
      `nav${nav[1]![0]!.toUpperCase()}${nav[1]!.slice(1)}` as "navIndex";
    const value = s[key];
    return value === null ? "" : String(value);
  }
  return "";
}

/** 書かれた値を確かめて、そのまま持つ形式に (px は数で書いてもよい) */
function normalizeStyle(property: string, value: Value): string {
  const text = toStr(value).trim();
  if (
    ["left", "top", "width", "height", "font-size"].includes(property) &&
    /^-?\d+$/.test(text)
  )
    return `${text}px`;
  return text;
}

export class Dom {
  private readonly wrappers = new WeakMap<BmlNode, HostObject>();
  private readonly realm: Realm;
  readonly document: HostObject;

  constructor(private readonly host: DomHost) {
    this.realm = host.realm;
    const document = new HostObject(this.realm.objectProto);
    document.define("documentElement", () => this.wrap(host.document.root));
    document.define("currentFocus", () => this.wrap(host.focused()));
    document.define("currentEvent", () => host.event());
    document.define("implementation", () => null);
    document.method(this.realm, "getElementById", (_, args) =>
      this.wrap(host.document.getElementById(toStr(args[0]))),
    );
    this.document = document;
  }

  wrap(node: BmlNode | null): Value {
    if (node === null) return null;
    let wrapper = this.wrappers.get(node);
    if (wrapper === undefined) {
      wrapper = node.kind === "text" ? this.text(node) : this.element(node);
      this.wrappers.set(node, wrapper);
    }
    return wrapper;
  }

  private node(object: HostObject, node: BmlNode): void {
    const siblings = (): BmlNode[] => node.parent?.children ?? [];
    object.define("parentNode", () => this.wrap(node.parent));
    object.define("nextSibling", () =>
      this.wrap(siblings()[siblings().indexOf(node) + 1] ?? null),
    );
    object.define("previousSibling", () =>
      this.wrap(siblings()[siblings().indexOf(node) - 1] ?? null),
    );
    if (node.kind === "element") {
      object.define("firstChild", () => this.wrap(node.children[0] ?? null));
      object.define("lastChild", () => this.wrap(node.children.at(-1) ?? null));
    } else {
      object.define("firstChild", () => null);
      object.define("lastChild", () => null);
    }
  }

  private text(text: BmlText): HostObject {
    const object = new HostObject(this.realm.objectProto);
    this.node(object, text);
    object.define(
      "data",
      () => text.data,
      (value) => {
        text.data = toStr(value);
        this.host.document.touch();
      },
    );
    object.define("length", () => text.data.length);
    object.define("nodeName", () => (text.cdata ? "#cdata-section" : "#text"));
    return object;
  }

  private style(element: BmlElement, state: State): HostObject {
    const object = new HostObject(this.realm.objectProto);
    for (const [name, [property, writable]] of Object.entries(
      STYLE_PROPERTIES,
    )) {
      object.define(
        name,
        // 効いている値を返す (書いた値が !important や不正な値で効いていなければ、効いているほう)
        () => styleValue(element, property, state),
        writable
          ? (value) => {
              element.inline[state].set(
                property,
                normalizeStyle(property, value),
              );
              element.document.touch();
            }
          : undefined,
      );
    }
    return object;
  }

  private element(element: BmlElement): HostObject {
    const object = new HostObject(this.realm.objectProto);
    const host = this.host;
    this.node(object, element);
    object.define("tagName", () => element.tag);
    object.define("nodeName", () => element.tag);
    object.define("id", () => element.id);
    object.define("className", () => element.attr("class") ?? "");
    const styles = new Map<State, HostObject>();
    const style = (state: State): HostObject => {
      let s = styles.get(state);
      if (s === undefined) {
        s = this.style(element, state);
        styles.set(state, s);
      }
      return s;
    };
    object.define("normalStyle", () => style("normal"));
    const focusable = ["div", "p", "span", "a", "object", "input"].includes(
      element.tag,
    );
    if (focusable) {
      object.define("focusStyle", () => style("focus"));
      object.define("activeStyle", () => style("active"));
      object.define("accessKey", () => element.attr("accesskey") ?? "");
      object.method(this.realm, "focus", () => {
        host.focus(element);
        return undefined;
      });
      object.method(this.realm, "blur", () => {
        host.blur(element);
        return undefined;
      });
    }
    const attribute = (
      name: string,
      attr: string,
      kind: "string" | "number" = "string",
      fallback = 0,
    ): void => {
      object.define(
        name,
        () =>
          kind === "number"
            ? numberAttr(element, attr, fallback)
            : (element.attr(attr) ?? ""),
        (value) => element.setAttr(attr, toStr(value)),
      );
    };
    switch (element.tag) {
      case "body":
        object.define(
          "invisible",
          () => host.invisible(),
          (value) => host.setInvisible(toBoolean(value)),
        );
        break;
      case "a":
        attribute("href", "href");
        break;
      case "object":
        attribute("data", "data");
        object.define("type", () => element.attr("type") ?? "");
        object.define(
          "remain",
          () => element.attr("remain") === "remain",
          (value) =>
            element.setAttr("remain", toBoolean(value) ? "remain" : null),
        );
        object.define(
          "streamStatus",
          () =>
            element.attr("streamstatus") ??
            (isStoppable(element) ? "stop" : "play"),
          (value) => host.stream(element, toStr(value)),
        );
        attribute("streamPosition", "streamposition", "number");
        attribute("streamLooping", "streamlooping", "number", 1);
        object.method(this.realm, "setMainAudioStream", () => false);
        object.method(this.realm, "getMainAudioStream", () => "/10");
        break;
      case "beitem":
        object.define("type", () => element.attr("type") ?? "");
        attribute("esRef", "es_ref");
        attribute("messageId", "message_id", "number", 255);
        attribute("messageVersion", "message_version", "number", 255);
        object.define("messageGroupId", () =>
          numberAttr(element, "message_group_id", 0),
        );
        attribute("moduleRef", "module_ref");
        attribute("languageTag", "language_tag", "number");
        object.define("timeMode", () => element.attr("time_mode") ?? "");
        attribute("timeValue", "time_value");
        attribute("objectId", "object_id");
        attribute("segmentId", "segment_id");
        attribute("peripheralRef", "peripheral_ref");
        object.define(
          "subscribe",
          () => element.attr("subscribe") === "subscribe",
          (value) => {
            const on = toBoolean(value);
            const was = element.attr("subscribe") === "subscribe";
            element.setAttr("subscribe", on ? "subscribe" : null);
            if (on && !was) element.memo = {};
            if (on) host.subscribed(element);
          },
        );
        break;
      case "meta":
        object.define("name", () => element.attr("name") ?? "");
        object.define("content", () => element.attr("content") ?? "");
        break;
      case "title":
        object.define("text", () => element.text);
        break;
    }
    return object;
  }

  /** イベント (`currentEvent`) を作る */
  event(fields: Record<string, Value>): HostObject {
    const object = new HostObject(this.realm.objectProto);
    const defaults: Record<string, Value> = {
      type: undefined,
      target: null,
      status: 0,
      privateData: "",
      esRef: "",
      messageId: 0,
      messageVersion: 0,
      messageGroupId: 0,
      moduleRef: "",
      languageTag: 0,
      registerId: 0,
      serviceId: 0,
      eventId: 0,
      peripheralRef: "",
      object: null,
      segmentId: null,
    };
    for (const [name, value] of Object.entries({ ...defaults, ...fields }))
      object.define(name, () => value);
    return object;
  }
}

/** 止まった状態から始まる object (付属2 4.8.5.2 注2) */
function isStoppable(element: BmlElement): boolean {
  const type = (element.attr("type") ?? "").toLowerCase();
  return [
    "audio/x-arib-mpeg2-aac",
    "audio/x-arib-aiff",
    "image/gif",
    "image/x-arib-mng",
  ].includes(type);
}
