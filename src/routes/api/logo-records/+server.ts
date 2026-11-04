import { logoRecordCsv, logoRecordList } from "#lib/server/logo-record.js";

/**
 * **ロゴを取りに行った記録を CSV で返す** (開発者向け。docs/logo.md「ロゴの取得を記録する」)。古い順で、残っているぶん全部。
 * 記録は設定の「その他」の「ロゴの取得を記録する」がオンの間だけ貯まる (`logo-record.ts`)
 */
export function GET() {
  return new Response(logoRecordCsv(logoRecordList()), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="denpa-logo-records.csv"',
      "Cache-Control": "no-store",
    },
  });
}
