import { json } from "@sveltejs/kit";
import { count } from "drizzle-orm";

import { config } from "#lib/server/config.js";
import { orm } from "#lib/server/db.js";
import { runningEncodes } from "#lib/server/encoder.js";
import { activeRecordingIds } from "#lib/server/recorder.js";
import { services } from "#lib/server/schema.js";
import { updateAvailable } from "#lib/server/update.js";

/**
 * Kubernetes の livenessProbe・install.sh と E2E の起動待ち・イメージの確認 (`.github/image-smoke.sh`) が呼ぶ。DB まで触って初めて ok を返す。
 *
 * 録画とエンコードの本数も返す。入れ替えていいかどうかを外から見たいことがあるため
 * (待つこと自体はアプリ側でやっている。runtime.ts の drain)。Windows の通知領域と Mac のメニューバーのアプリ (`tray/`) は、
 * これを見て更新の前に確かめる。
 * バージョンも返す (`DENPA_VERSION`。リリースのイメージと、Mac・Windows のインストーラが書く起動スクリプトが渡す。手元と develop は `dev`)。何が動いているかを外から確かめるため
 */
export function GET() {
  const row = orm().select({ n: count() }).from(services).get();
  return json({
    ok: true,
    version: config.version,
    // 新しいバージョンが出ていれば、そのタグと場所 (update.ts)。無ければ null
    update: updateAvailable(),
    services: row?.n ?? 0,
    recording: activeRecordingIds().length,
    encoding: runningEncodes(),
  });
}
