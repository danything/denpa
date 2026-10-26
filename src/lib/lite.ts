/**
 * **ソフトウェアで描いている端末を見分けて、`<html data-lite>` を付ける** (docs/design.md の「動き」)。
 *
 * GPU が無い・ハードウェアアクセラレーションを切った端末では、合成まで CPU がやるので、
 * 動き続けるもの (録画中の点・バーの光・骨組みの光) を回すだけで CPU を使い続ける。`data-lite` の間は
 * `app.css` の最後で、動きを減らす設定と同じ止まった姿にする。アンビエントの光とテーブルトップの反射も 1 枚写して止め
 * (`glow-loop.svelte.ts`)、明暗の切り替えは移さずにすぐ替える (`theme.svelte.ts`)。
 *
 * 見分けは開いたときに 1 回だけ。小さな WebGL の箱を作って描き手の名前を読み、すぐ捨てる。
 * 名前を読めるのは Chrome・Edge だけで、Firefox は丸めた名前、Safari は「Apple GPU」しか出さない。
 * 見分けられないときは付けない (回り続ける側に倒す)
 */

/** ソフトウェアの描き手の名前。新しい名前が分かったら足す */
const SOFTWARE = [
  "swiftshader",
  "llvmpipe",
  "softpipe",
  "microsoft basic render driver",
];

/** WebGL の描き手の名前がソフトウェアのものか。null は WebGL を作れなかった (ソフトウェアとみなす) */
export function isSoftwareRenderer(name: string | null): boolean {
  if (name === null) return true;
  const lower = name.toLowerCase();
  return SOFTWARE.some((soft) => lower.includes(soft));
}

/** 描き手の名前を読む。WebGL を作れなければ null */
function rendererName(): string | null {
  const gl = document.createElement("canvas").getContext("webgl");
  if (gl === null) return null;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = String(
    gl.getParameter(info === null ? gl.RENDERER : info.UNMASKED_RENDERER_WEBGL),
  );
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return name;
}

/** 見分けて `<html>` に印を付ける。土台のレイアウトの `onMount` から 1 回だけ呼ぶ */
export function markLite(): void {
  let name: string | null;
  try {
    name = rendererName();
  } catch {
    // 箱を作るところで投げる端末は、見分けられない側 (回り続ける) に倒す
    return;
  }
  if (isSoftwareRenderer(name)) document.documentElement.dataset["lite"] = "";
}
