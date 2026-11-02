import { redirect } from "@sveltejs/kit";

import { startLink } from "#lib/server/niconico.js";
import { publicBase, relative } from "#lib/server/paths.js";

import { refusal, setFlow } from "../flow.server";

/**
 * **ニコニコとの連携を始める** (設定の「連携」の「実況」にある「ニコニコと連携」のリンク)。
 * 鍵の組を作って hub の入口へ送るだけ。結果は `../return` に戻ってくる。
 *
 * フォームの送信にしないのは、CSP の `form-action 'self'` が送ったあとの外への移動も止めるため
 * (`/login` と同じく、画面の移動で hub へ送る)
 */
export async function GET(event) {
  const { url, cookies, request } = event;
  const back = (message: string) =>
    redirect(
      303,
      `${relative(url, "/settings/integrations")}?niconico_error=${encodeURIComponent(message)}#jikkyo`,
    );
  const refused = refusal(event);
  if (refused !== null) back(refused);
  // よそのサイトから踏ませて連携の途中 (サーバのメモリに持つ。上限あり) を積ませない。
  // 設定の画面のリンクからは same-origin で来る。ヘッダーを付けない古いブラウザは通す
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin")
    back("設定の「連携」の画面から押してください");
  // hub が返すのは `<オリジン>/settings/…` だけ。前段のパスの下 (Home Assistant の Ingress など) では戻ってこられない
  if (publicBase(url, request.headers) !== url.origin)
    back(
      "前段のパスの下で開いているため連携できません。denpa のアドレス (http://192.168.1.20:3000 など) を直に開いてから押してください",
    );
  const { flow, url: authorize } = await startLink(url.origin);
  setFlow(cookies, url, flow);
  // 行き先は denpa-hub (よその origin)。宛先は利用者の入力ではなく、設定の hub の場所から組み立てたもの
  redirect(302, authorize, { external: true });
}
