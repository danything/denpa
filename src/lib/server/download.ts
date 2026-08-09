import { enabled as authEnabled } from './auth';
import { settings } from './settings';

/**
 * 録画を落とすときに要るもの。**録画一覧と番組表で同じものを渡す。**
 *
 * どちらの画面からも録れたものを落とせるので、渡すものが食い違うと
 * 「一覧からは落とせるのに番組表からは落ちてこない」になります。
 *
 * **観るほうは何も要りません。** ブラウザで再生するようになったので
 * (`routes/watch/[id]`)、宛先を端末ごとに決める必要が無くなりました
 * (以前は Windows/Mac/iOS/Android で渡す口が違っていました)。
 */
export interface DownloadContext {
    origin: string;
    credentials?: { user: string; password: string };
}

/**
 * `origin` をサーバで作れるのは `PROTOCOL_HEADER` を渡しているためです
 * (`k3s/deployment.yaml`)。素の adapter-node は https と決め打ちます。
 *
 * **資格情報は URL に埋めます。** ブラウザはページの認証をダウンロードに
 * 引き継がないので、そうするしかありません (`$lib/download.ts`)。
 */
export function downloadContext(url: URL): DownloadContext {
    return {
        origin: url.origin,
        credentials: authEnabled()
            ? { user: settings().basicAuthUser, password: settings().basicAuthPassword }
            : undefined,
    };
}
