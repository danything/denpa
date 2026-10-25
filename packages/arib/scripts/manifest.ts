/**
 * npm に出す package.json を作る (`.github/workflows/arib-publish.yml` が `npm publish` の前に回す)。
 *
 * リポジトリの中では `exports` が TypeScript のまま (`src/*.ts`) を指していて、denpa もテストも
 * ビルドせずに読む。npm に出すものは `tsc -p tsconfig.build.json` で組んだ `dist/` を指すように書き換える
 */
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<
  string,
  unknown
>;
manifest["exports"] = {
  "./*": { types: "./dist/*.d.ts", default: "./dist/*.js" },
};
manifest["files"] = ["dist"];
delete manifest["scripts"];
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
