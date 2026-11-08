import type { HybridcastLink } from "#lib/live.js";
import { decodeEntities } from "../bml/xml";

/**
 * **XML の AIT を読む。** 電波に AIT を載せない局 (NHK) は、データ放送が XML の AIT の URL を渡してくる
 * (`browser.ts` の `startAITControlledApp`)。形式は ETSI TS 102 809 の XML AIT (ARIB STD-B24 第四編 6 章が引く):
 *
 * ```
 * ServiceDiscovery / ApplicationDiscovery / ApplicationList / Application
 *   appName                          … 名前
 *   applicationIdentifier / orgId・appId
 *   applicationDescriptor / controlCode   … AUTOSTART・PRESENT など
 *   applicationTransport / URLBase   … URL の先頭
 *   applicationLocation              … その先の経路
 * ```
 *
 * **名前空間の接頭辞は見ない** (`mhp:` のことも、無いこともある)。DOMParser は単体テスト (bun) に無いので、要素の名前で読む。
 * 開けるのは AUTOSTART と PRESENT だけで、 URL の先頭が http(s) でないものは出さない (電波の AIT と同じ。`@danything/arib/ait` の `parseAit`)
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

/**
 * XML の文字参照を 1 回だけ開く (開き方は文書と同じ `bml/xml.ts` の `decodeEntities`。`&#38;lt;` は `&lt;` のまま)。
 * CDATA は中身をそのまま。範囲の外の参照は字のまま残し、1 つの壊れた参照で AIT ごと読めなくしない
 */
function decodeXml(text: string): string {
  return text
    .split(/<!\[CDATA\[([\s\S]*?)\]\]>/)
    .map((part, i) => (i % 2 === 1 ? part : decodeEntities(part)))
    .join("");
}
