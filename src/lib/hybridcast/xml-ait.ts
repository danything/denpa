import type { HybridcastLink } from "#lib/live.js";

/**
 * **XML の AIT を読む。** 電波に AIT を載せない局 (NHK) は、データ放送が XML の AIT の URL を渡してくる
 * (`browser.ts` の `startAITControlledApp`)。形は ETSI TS 102 809 の XML AIT (ARIB STD-B24 第四編 6 章が引く):
 *
 * ```
 * ServiceDiscovery / ApplicationDiscovery / ApplicationList / Application
 *   appName                          … 名前
 *   applicationIdentifier / orgId・appId
 *   applicationDescriptor / controlCode   … AUTOSTART・PRESENT など
 *   applicationTransport / URLBase   … URL の頭
 *   applicationLocation              … その先の経路
 * ```
 *
 * **名前空間の接頭辞は見ない** (`mhp:` のことも、無いこともある)。DOMParser はサーバとテストに無いので、要素の名前で拾う。
 * 開けるのは AUTOSTART と PRESENT だけで、URL の頭が http(s) でないものは出さない (電波の AIT と同じ。`server/live.ts` の `findHybridcast`)
 */
export function parseXmlAit(text: string): HybridcastLink[] {
  const apps: HybridcastLink[] = [];
  for (const block of elements(text, "Application")) {
    const control = (first(block, "controlCode") ?? "PRESENT").toUpperCase();
    if (control !== "AUTOSTART" && control !== "PRESENT") continue;
    const base = first(block, "URLBase");
    if (base === null || !/^https?:\/\//i.test(base)) continue;
    const identifier = first(block, "applicationIdentifier") ?? "";
    apps.push({
      name: first(block, "appName") ?? "",
      url: base + (first(block, "applicationLocation") ?? ""),
      organisationId: number(first(identifier, "orgId")),
      applicationId: number(first(identifier, "appId")),
      autostart: control === "AUTOSTART",
    });
  }
  return apps;
}

/** `name` という要素 (接頭辞は問わない) の中身を順に */
function* elements(text: string, name: string): Generator<string> {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`,
    "g",
  );
  for (const match of text.matchAll(pattern)) yield match[1] ?? "";
}

/** 最初の `name` 要素の中身 (文字参照を戻し、前後の空白を落とす)。無ければ null */
function first(text: string, name: string): string | null {
  for (const inner of elements(text, name)) return decodeXml(inner).trim();
  return null;
}

function number(text: string | null): number {
  if (text === null) return 0;
  const value = /^0x/i.test(text) ? Number.parseInt(text, 16) : Number(text);
  return Number.isFinite(value) ? value : 0;
}

/** XML の文字参照。CDATA は中身をそのまま */
function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      codePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, dec: string) => codePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 文字参照の番号を文字に。**範囲の外は捨てる** — 1つの壊れた参照で AIT ごと読めなくしない */
function codePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff
    ? String.fromCodePoint(n)
    : "";
}
