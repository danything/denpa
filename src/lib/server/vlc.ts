import { normalizeVlcHost } from '$lib/vlc-host';
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

/** `名前=ホスト:ポート` のカンマ区切りを読む。ホストの整え方は `$lib/vlc-host` と共通 */
export function parseTargets(text: string): VlcTarget[] {
    const out: VlcTarget[] = [];
    for (const part of text.split(',')) {
        const trimmed = part.trim();
        if (trimmed === '') continue;
        const eq = trimmed.indexOf('=');
        const name = eq === -1 ? trimmed : trimmed.slice(0, eq).trim();
        const host = normalizeVlcHost(eq === -1 ? trimmed : trimmed.slice(eq + 1));
        // ホスト名が無い崩れは黙って飛ばす
        if (host === '') continue;
        out.push({ name: name === '' ? host : name, host });
    }
    return out;
}

export function targets(): VlcTarget[] {
    return parseTargets(settings().vlcTargets);
}

/**
 * 一覧を設定の文字列に戻す。読み直すのは `parseTargets` — 往復して同じに
 * なることが書式の定義そのもの (`vlc.test.ts`)。名前がホストと同じ (=付けて
 * いない) ものは名前を書かない。**`,` と `=` は区切りなので中身には使えない** —
 * 名前からは saveVlc が抜き、ホストは normalizeVlcHost が混ざったものを弾く
 */
export function serializeTargets(list: VlcTarget[]): string {
    return list
        .map((t) => (t.name === t.host || t.name.trim() === '' ? t.host : `${t.name}=${t.host}`))
        .join(', ');
}
