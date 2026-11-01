import { describe, expect, test } from "bun:test";

import { DEFAULT_CLUT } from "./clut";
import { parseStylesheet } from "./css";
import { BmlDocument } from "./document";
import { PUA_ADDITIONAL } from "./euc";
import { Renderer, type RenderHost } from "./render";
import { parseXml } from "./xml";

/** Renderer が使うだけの小さな DOM (テストに本物のブラウザは無い) */
class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  style = { cssText: "" };
  data = "";
  src = "";
  onload: unknown = null;
  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tag: string,
  ) {}
  appendChild(child: FakeNode): FakeNode {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.appendChild(node);
  }
  replaceChildren(): void {
    this.children = [];
  }
  remove(): void {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  set textContent(text: string) {
    const node = new FakeNode(this.ownerDocument, "#text");
    node.data = text;
    this.children = [node];
  }
}

class FakeDocument {
  createElement(tag: string): FakeNode {
    return new FakeNode(this, tag);
  }
  createTextNode(text: string): FakeNode {
    const node = new FakeNode(this, "#text");
    node.data = text;
    return node;
  }
}

// Renderer は container が ShadowRoot かを見る
(globalThis as { ShadowRoot?: unknown }).ShadowRoot ??= class {};

function spans(node: FakeNode): FakeNode[] {
  return [
    ...(node.tag === "span" ? [node] : []),
    ...node.children.flatMap(spans),
  ];
}

describe("外字", () => {
  test("loadDRCS が描いた後に終わっても、外字の画像を描き直す", () => {
    const glyph = String.fromCharCode(PUA_ADDITIONAL + 2 * 94);
    const xml = parseXml(`<bml><body><p>A${glyph}</p></body></bml>`);
    if (xml === null) throw new Error("読めない");
    const doc = new BmlDocument(xml);
    doc.applyRules(parseStylesheet(""));
    let mask: string | null = null;
    const host: RenderHost = {
      fonts: { round: "r", boldRound: "b", square: "s" },
      clut: () => DEFAULT_CLUT,
      resolution: () => ({ width: 960, height: 540 }),
      image: () => null,
      drcs: () => mask,
      finished: () => {},
    };
    const container = new FakeDocument().createElement("div");
    const renderer = new Renderer(
      container as unknown as HTMLElement,
      doc,
      host,
      () => {},
    );
    renderer.draw();
    const masked = (): boolean =>
      spans(container).some((s) => s.style.cssText.includes("mask-image"));
    expect(masked()).toBe(false);
    // 外字が届いた (エンジンは文書を touch して描き直させる)
    mask = "blob:drcs";
    doc.touch();
    renderer.draw();
    expect(masked()).toBe(true);
  });
});
