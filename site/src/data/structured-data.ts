/*
 * 検索向けの構造化データ (JSON-LD)。依存は足さず、schema.org の形の JSON をそのまま書く。
 * トップ (src/pages/index.astro) は SoftwareApplication、文書のページ (src/routeData.ts) は BreadcrumbList
 */
import { ogImage, repoUrl, siteUrl } from "./pages.ts";

/** <head> に入れる <script type="application/ld+json">。`</script>` で閉じないよう `<` は逃がす */
export function jsonLd(data: Record<string, unknown>) {
  return {
    tag: "script" as const,
    attrs: { type: "application/ld+json" },
    content: JSON.stringify({
      "@context": "https://schema.org",
      ...data,
    }).replaceAll("<", "\\u003c"),
  };
}

/**
 * 最新のリリースのバージョン (v を外したもの)。ビルドのときに GitHub から 1 回だけ取る。
 * 取れなければ (オフライン・API の回数制限) undefined で、構造化データからバージョンを省く
 */
let latest: Promise<string | undefined> | undefined;
export function latestVersion(): Promise<string | undefined> {
  latest ??= (async () => {
    const api = repoUrl.replace(
      "https://github.com/",
      "https://api.github.com/repos/",
    );
    try {
      const token = process.env["GITHUB_TOKEN"];
      const res = await fetch(`${api}/releases/latest`, {
        headers: {
          accept: "application/vnd.github+json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tag = ((await res.json()) as { tag_name?: unknown }).tag_name;
      if (typeof tag !== "string" || !tag)
        throw new Error("tag_name がありません");
      return tag.replace(/^v/, "");
    } catch (e) {
      console.warn(
        `structured-data: 最新のリリースのバージョンを取れないので、バージョンは省きます (${e})`,
      );
      return undefined;
    }
  })();
  return latest;
}

export async function softwareApplication(description: string) {
  const version = await latestVersion();
  return jsonLd({
    "@type": "SoftwareApplication",
    name: "denpa",
    description,
    url: siteUrl,
    image: ogImage.url,
    applicationCategory: "MultimediaApplication",
    operatingSystem: "Linux, macOS, Windows",
    offers: { "@type": "Offer", price: "0", priceCurrency: "JPY" },
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
    ...(version ? { softwareVersion: version } : {}),
    downloadUrl: `${repoUrl}/releases/latest`,
    sameAs: [repoUrl],
  });
}

/** サイドバーの項目 (Starlight の route data の sidebar) のうち、ここで見るところだけ */
interface SidebarEntry {
  type: "link" | "group";
  label: string;
  href?: string;
  isCurrent?: boolean;
  entries?: SidebarEntry[];
}

/**
 * 文書のページのパンくず: トップ → 組 (サイドバーの組の最初のページ) → そのページ。
 * 組の最初のページそのものなら、組は挟まない。サイドバーに無いページ (トップ・404) は undefined。
 * ビルドした後はファイルの置き場が変わるので、docs を読み直さずにサイドバーから組み立てる
 */
export function breadcrumb(sidebar: SidebarEntry[], title: string) {
  const url = (href: string) => new URL(href, siteUrl).href;
  for (const group of sidebar) {
    const links = (group.entries ?? []).filter(
      (e) => e.type === "link" && e.href,
    );
    const current = links.find((e) => e.isCurrent);
    if (group.type !== "group" || !current) continue;
    const items = [{ name: "denpa", item: siteUrl }];
    const first = links[0]!;
    if (first !== current)
      items.push({ name: group.label, item: url(first.href!) });
    items.push({ name: title, item: url(current.href!) });
    return jsonLd({
      "@type": "BreadcrumbList",
      itemListElement: items.map((it, i) => ({
        "@type": "ListItem",
        position: i + 1,
        ...it,
      })),
    });
  }
  return undefined;
}
