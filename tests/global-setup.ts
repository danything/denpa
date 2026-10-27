import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { TEST_ROOT } from "./stack";

/**
 * **ブラウザに配るデコーダ (WASM) が `wasm/decoder.c` と合っているかを先に見る。**
 *
 * デコーダはソースと一緒には組まれず、イメージの `mpeg2wasm` 段で組んだものを `MPEG2_DIR` から配る
 * (CI はその段を組み直して渡すので、いつも合っている)。手元で古いイメージのまま E2E を回すと、
 * worker が呼ぶ関数がデコーダに無く、使ったところで worker が落ちる — 間に合わないときだけ呼ぶ
 * `dec_skip` は混んだときにしか呼ばれないので、MPEG-2 のテストが**ときどき**落ちるように見えていた。
 * `decoder.c` が書き出す関数がローダー (`decoder.mjs`) に全部あるかを見て、無ければ始める前に止める。
 * デコーダが無いとき (MPEG-2 の経路を使わない回し方) は見ない
 */
function checkDecoder(): void {
  const loader = join(
    process.env["MPEG2_DIR"] ?? "/opt/denpa/mpeg2",
    "decoder.mjs",
  );
  if (!existsSync(loader)) return;
  const text = readFileSync(loader, "utf8");
  const exported = [
    ...readFileSync("wasm/decoder.c", "utf8").matchAll(
      /EMSCRIPTEN_KEEPALIVE\s[^(]*?(\w+)\s*\(/g,
    ),
  ].map((match) => match[1]!);
  // 書き方が変わって1つも拾えなくなったら、見ていないのと同じ。黙って通さない
  if (exported.length === 0) {
    throw new Error(
      "wasm/decoder.c から書き出す関数を読めません (tests/global-setup.ts)",
    );
  }
  const missing = exported.filter(
    (name) => !new RegExp(`\\b_${name}\\b`).test(text),
  );
  if (missing.length > 0) {
    throw new Error(
      `${loader} は wasm/decoder.c より古いデコーダです (${missing.join(", ")} がありません)。` +
        "イメージを組み直してください (docker compose build e2e)",
    );
  }
}

/**
 * 前回の実行で残ったDB・録画ファイルを消してから、アプリを1度だけ組む。
 *
 * DBが残っていると前回の予約や録画が見えてしまい、件数の期待値が壊れる。
 *
 * アプリはワーカーの数だけ同時に立てる。開発サーバをその数だけ動かすと
 * 起動も動きも重くなるので、組んだものを共有して**それぞれ別のポートで**回す。
 * ついでに、本番と同じ adapter-bun の出力を試すことになる。
 */
export default function globalSetup() {
  checkDecoder();
  rmSync(TEST_ROOT, { recursive: true, force: true });

  const build = spawnSync("bun", ["run", "build"], { stdio: "inherit" });
  if (build.status !== 0) throw new Error("ビルドに失敗しました");
}
