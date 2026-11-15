/**
 * データ放送のエンジンの読み込みと、映像の上に出す通知 (`DataBroadcast` の `note`)。
 * エンジン (`#lib/bml/engine.js`) は押されてから読み込むので、読み込めなかったとき (回線が切れた・サーバを更新して
 * ファイルの名前が変わった) に「データ取得中…」を出したままにしない
 */

/** エンジンを読み込めなかったときの通知。閉じて開き直すと読み込み直す (`DataBroadcast` の `opened`・`close`) */
export const DATA_LOAD_FAILED =
  "データ放送を読み込めませんでした。閉じて開き直すと、もう一度読み込みます";

/**
 * エンジンを読み込む。**読み込めなければ null** を返し、理由をコンソールに出す。呼ぶ側は「データ取得中…」を下ろして
 * `DATA_LOAD_FAILED` を出す
 */
export async function loadEngine<T>(
  load: () => Promise<T>,
  warn: (message: string) => void = console.warn,
): Promise<T | null> {
  try {
    return await load();
  } catch (failure) {
    warn(`[bml] データ放送のエンジンを読み込めませんでした (${failure})`);
    return null;
  }
}

/** 映像の上に出す通知を決めるもの */
export interface DataNoteState {
  /** 開いているか。開いていなければ何も出さない (受信しているだけのとき) */
  on: boolean;
  /** Hybridcast のアプリを開いていれば、その読み込みの通知 (`HybridcastFrame` の `note`)。開いていなければ null */
  app: string | null;
  /** エンジンを読み込めなかったか (`loadEngine`) */
  failed: boolean;
  /** エンジンを読み込んでいるか */
  loading: boolean;
  /** 電波から取っている最中か (エンジンの `onReceiving`) */
  receiving: boolean;
}

/** 映像の上に出す通知。テレビと同じ「データ取得中…」と、読み込めなかったときの `DATA_LOAD_FAILED` */
export function dataNote(state: DataNoteState): string {
  if (!state.on) return "";
  if (state.app !== null) return state.app;
  if (state.failed) return DATA_LOAD_FAILED;
  return state.loading || state.receiving ? "データ取得中…" : "";
}
