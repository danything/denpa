import { settings } from './settings';

/**
 * テレビの VLC (リモートアクセス) の居場所。
 *
 * **叩くのはサーバではなく、画面を開いている端末。** VLC の `/play` はただの
 * GET なので、端末のブラウザが `http://<テレビ>:8080/play?id=0&path=<URL>` を
 * **トップレベルで開けば**そのまま再生が始まる (`+page.svelte` の `playOnTv`)。
 * fetch では混在コンテンツ・自己署名・CORS・Cookie の4つに塞がれるが、
 * ページ遷移にはどれも掛からず、SameSite=Lax の合鍵 Cookie も付く。
 *
 * サーバから叩く形 (denpa がペアリングして Cookie を控える) も作ったが落とした —
 * 家のサーバからは**出先のテレビに届かない**し、端末から直に開くなら
 * ペアリングも VLC 自身のログイン画面 (テレビに出る6桁コード) がそのまま使える。
 * ここに残っているのは「設定に書いてあるテレビの一覧」だけ。
 */

export interface VlcTarget {
    name: string;
    host: string;
}

/** `名前=ホスト:ポート` のカンマ区切りを読む。ポート略なら VLC の既定 8080 */
export function parseTargets(text: string): VlcTarget[] {
    const out: VlcTarget[] = [];
    for (const part of text.split(',')) {
        const trimmed = part.trim();
        if (trimmed === '') continue;
        const eq = trimmed.indexOf('=');
        const name = eq === -1 ? trimmed : trimmed.slice(0, eq).trim();
        const host = (eq === -1 ? trimmed : trimmed.slice(eq + 1).trim()).replace(/^https?:\/\//, '');
        // ホスト名が空 (':8080' だけ等) の崩れは黙って飛ばす
        if (host.split(':')[0] === '') continue;
        out.push({ name: name === '' ? host : name, host: host.includes(':') ? host : `${host}:8080` });
    }
    return out;
}

export function targets(): VlcTarget[] {
    return parseTargets(settings().vlcTargets);
}
