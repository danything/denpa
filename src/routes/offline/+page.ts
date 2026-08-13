/**
 * 端末に保存した録画の一覧。中身は全部 IndexedDB にあるので、
 * サーバに聞くことが何も無い — SSR を切ってただの殻にする。
 * サービスワーカーがこの HTML を控えておき、オフラインの入口にする
 * (`service-worker.ts` の navigate フォールバック)。
 */
export const ssr = false;
