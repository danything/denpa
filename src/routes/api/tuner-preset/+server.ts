import { json } from "@sveltejs/kit";

import { config } from "#lib/server/config.js";

/**
 * チューナー (DT295 エージェント) の画質プリセットを読み書きする。
 *
 * ブラウザからエージェントを直接叩かないのは、認証と CORS を1か所に閉じ込めるため。
 * 選んだ内容はエージェント側のプロファイルを書き換えるだけで、
 * **次の選局から**効く (いま見ている絵は変わらない)。
 */
const PRESET = /^[a-z0-9]{1,16}$/;

export async function GET() {
  try {
    const res = await fetch(`${config.agentUrl}/presets`, {
      redirect: "manual",
    });
    const html = await res.text();
    const active = /適用中: <b>([^<]*)<\/b>/.exec(html)?.[1] ?? null;
    return json({ active });
  } catch {
    return json({ active: null });
  }
}

export async function POST({ request }: { request: Request }) {
  const body = (await request.json().catch(() => ({}))) as {
    preset?: unknown;
  };
  const preset = typeof body.preset === "string" ? body.preset : "";
  if (!PRESET.test(preset)) {
    return json({ message: "preset が不正です" }, { status: 400 });
  }
  try {
    const res = await fetch(
      `${config.agentUrl}/presets/select?name=${encodeURIComponent(preset)}`,
      { redirect: "manual" },
    );
    if (res.status >= 400) {
      return json({ message: "切り替えに失敗しました" }, { status: 502 });
    }
    return json({ active: preset });
  } catch {
    return json({ message: "チューナーに繋がりません" }, { status: 502 });
  }
}
